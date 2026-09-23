/**
 * ProxyService — 主进程代理业务单元(Task 7 · spec §6)。
 *
 * 主进程「大脑」一部分:**主动**读系统代理(aria2 / yt-dlp 不会自动读 Windows 系统代理,
 * 必须由主进程读出再以参数注入引擎),并把当前解析态经同步 `getResolved()` 供引擎注入回调即时取用——
 * 用户切档对**后续新任务**即时生效(引擎不缓存到构造期),运行中任务保持原代理。
 *
 * 职责(Phase 2 起,Phase 3 补全):
 * 1. `init()` 启动读 `proxy.json`(经 `readProxyConfig`,缺失 / 损坏回退默认并修复)→ 缓存 `config`。
 * 2. `mode==='system'` 时经 `SystemProxyReader` 读系统代理 → `parseResolveProxy` → 缓存 `systemDetected`;
 *    读失败按「系统未设代理」**诚实回退**(effectiveUrl=null),不崩。
 * 3. 暴露同步 `getResolved(): ProxyResolved`(基于缓存 config + systemDetected,经 `resolveEffectiveProxy`)。
 * 4. `setConfig`(校验→写盘→system 重读→探测→广播)/ `getStatus`(含一次探测;`direct` / effectiveUrl null 不探)(Phase 3)。
 *
 * 依赖全可注入(`systemProxyReader` / `store` / `probe` / `onStatusChanged` / `configPath`),核心解析 / 组装 / 状态合成
 * 是纯函数,单测注入 fake 不碰真实 FS / Electron session / 网络。
 */
import {
  DEFAULT_PROXY_CONFIG,
  type ProxyConfig,
  type ProxyResolved,
  type ProxyStatus
} from '../../shared/ipc'
import { parseResolveProxy, type SystemProxyReader } from './systemProxy'
import { resolveEffectiveProxy, validateManualUrl } from './proxyArgs'
import { readProxyConfig, writeProxyConfig, type ProxyStoreFs } from './proxyStore'
import { buildProxyStatus, type ProxyProbe } from './proxyStatus'
import { parseHostPort } from './proxyProbe'

export interface ProxyServiceDeps {
  /** 系统代理读接口(真实实现以 session.resolveProxy 接入,见 systemProxyReader.ts;测试注入 fake) */
  systemProxyReader: SystemProxyReader
  /** proxy.json 落盘 fs(真实传 nodeProxyStoreFs;测试注入内存 fake) */
  store: ProxyStoreFs
  /** proxy.json 绝对路径(`<userData>/config/proxy.json`) */
  configPath: string
  /**
   * 代理端口连通探测(注入式,Phase 3)。真实传 `proxyProbe.ts:probe`,测试注入 fake。
   * 只对 effectiveUrl 的 host:port 做一次 TCP 连接(spec §5.2);未注入则退化为「不探测」(仅 Phase 2 旧测试路径,不触 getStatus)。
   */
  probe?: (host: string, port: number) => Promise<boolean>
  /**
   * 代理状态变更广播回调(注入式,Phase 3)。`setConfig` 后调用;
   * Step 5 接 `webContents.send('proxy:statusChanged', status)`(本步只留注入缝,不接 IPC / preload)。
   */
  onStatusChanged?: (status: ProxyStatus) => void
}

export class ProxyService {
  /** 缓存的持久化配置(init / setConfig 后即当前档) */
  private config: ProxyConfig = { ...DEFAULT_PROXY_CONFIG }
  /** mode==='system' 时缓存的系统代理解析结果(读不到 / 非 system → null) */
  private systemDetected: string | null = null
  /** system 档跟随轮询定时器(startSystemWatch 起,stop 清;非 system 档轮询空转直返) */
  private watchTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ProxyServiceDeps) {}

  /** 启动装配:读 proxy.json 缓存 config;system 档读系统代理缓存 systemDetected(失败诚实回退) */
  async init(): Promise<void> {
    this.config = await readProxyConfig(this.deps.configPath, this.deps.store)
    await this.refreshSystemDetected()
  }

  /**
   * 同步取当前解析态(spec §2.4),供引擎注入回调 `() => proxyService.getResolved()` 即时调用。
   * `effectiveUrl` 经 `resolveEffectiveProxy`(direct / system 未读到 → null;引擎侧产出显式空串关闭);
   * `systemDetected` 仅 system 档下发(其它档 null,供状态栏诚实显示,Phase 4 用)。
   */
  getResolved(): ProxyResolved {
    return {
      mode: this.config.mode,
      effectiveUrl: resolveEffectiveProxy(this.config, this.systemDetected),
      systemDetected: this.config.mode === 'system' ? this.systemDetected : null
    }
  }

  /**
   * 同步取当前持久化配置副本(spec §7.1 `proxy:get`),供 IPC handler 回显设置面板当前档 / 手动地址。
   * 返回副本避免调用方改写内部缓存;不读盘(`init` / `setConfig` 已缓存 `config`),与 `getResolved` 同为同步读缓存。
   */
  getProxyConfig(): ProxyConfig {
    return { ...this.config }
  }

  /**
   * 写代理配置(spec §6.4):规整 → 校验 manualUrl → 写盘(非法 manual 不落盘)→ system 重读 → 探测 → 重算状态 → 广播。
   *
   * 内存 `config` **立即更新**(`getResolved` 供引擎注入回调即时读新档,切档对后续新任务即时生效);
   * 非法 manual 地址仅当前会话生效并状态栏告警「手动代理(地址无效)」,**不持久化**(spec §2.3 / §5.1)。
   * @returns set 后即时 `ProxyStatus`(含一次代理端口探测)
   */
  async setConfig(input: ProxyConfig): Promise<ProxyStatus> {
    // 规整:非 manual 档 manualUrl 强制 null(spec §2.2「manualUrl 仅 manual 有意义」)
    const next: ProxyConfig = {
      mode: input.mode,
      manualUrl: input.mode === 'manual' ? (input.manualUrl ?? null) : null
    }
    // manual 档校验:失败则不落盘(spec §2.3),内存态仍更新以即时反映 + 状态栏告警(spec §5.1)
    const manualValid = next.mode !== 'manual' || validateManualUrl(next.manualUrl ?? '') !== null

    this.config = next

    if (manualValid) {
      try {
        await writeProxyConfig(this.deps.configPath, next, this.deps.store)
      } catch (err) {
        console.error('[ProxyService] 写 proxy.json 失败(当前会话仍按新档运行):', err)
      }
    } else {
      console.warn(
        '[ProxyService] 手动代理地址无效,不落盘;状态栏告警「手动代理(地址无效)」(spec §5.1):',
        next.manualUrl
      )
    }

    await this.refreshSystemDetected() // system 档重读系统代理(其它档清空)

    const status = await this.getStatus() // 含一次探测 + buildProxyStatus 重算
    this.deps.onStatusChanged?.(status) // set 后广播(spec §7.1 proxy:statusChanged,Step 5 接 webContents)
    return status
  }

  /**
   * 取当前代理状态(spec §6.5),供 IPC `proxy:getStatus` 读取。
   * 先刷新 systemDetected(2026-07-25 真机修订二:system 档下打开设置页 / 状态栏拉取永远看到
   * **当前**系统代理,而非 init/setConfig 时的快照;非 system 档刷新为空转),
   * 再含**一次**代理端口探测(`direct` / effectiveUrl 为 null 不探测);经 `buildProxyStatus` 合成诚实文案。
   */
  async getStatus(): Promise<ProxyStatus> {
    await this.refreshSystemDetected()
    const resolved = this.getResolved()
    const probeResult = await this.probeStatus(resolved)
    return buildProxyStatus(this.config, resolved, probeResult)
  }

  /**
   * system 档跟随一拍(2026-07-25 真机修订二):重读系统代理,**解析结果有变化**才重算状态并广播
   * `onStatusChanged`(状态栏 / 引擎注入回调即时跟上;无变化静默,不打扰)。非 system 档直返。
   * 供 `startSystemWatch` 轮询与单测直调(测试不碰 timer)。
   */
  async pollSystemOnce(): Promise<void> {
    if (this.config.mode !== 'system') return
    const prev = this.systemDetected
    await this.refreshSystemDetected()
    if (this.systemDetected === prev) return
    console.log(
      `[ProxyService] 系统代理变化:${prev ?? '(未设)'} → ${this.systemDetected ?? '(未设)'}(跟随生效)`
    )
    this.deps.onStatusChanged?.(await this.getStatus())
  }

  /**
   * 启动 system 档跟随轮询(2026-07-25 真机修订二;默认 30s):Windows 无系统代理变化事件,
   * 轮询 `resolveProxy`(纯查配置 / PAC,不发网络请求,开销可忽略)。幂等(重复调先清旧表);
   * `stop()` 清表。切档无需重启轮询——非 system 档时 `pollSystemOnce` 空转直返。
   */
  startSystemWatch(intervalMs = 30_000): void {
    this.stop()
    this.watchTimer = setInterval(() => {
      this.pollSystemOnce().catch((err) =>
        console.error('[ProxyService] 系统代理跟随轮询失败(下拍重试):', err)
      )
    }, intervalMs)
  }

  /** 停止跟随轮询(应用关闭时;未启动为 no-op) */
  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
  }

  /**
   * 合成连通探测结果(spec §5.2):
   * - effectiveUrl 为 null(direct / system 未设 / manual 非法)→ 不探测(null,buildProxyStatus 不看 probe);
   * - 未注入 probe(理论仅 Phase 2 旧测试路径)→ 不探测(null);
   * - 否则只对该 host:port 做一次 TCP 连接 → 'ok' / 'fail'。**只连代理端口本身,不向外网发请求**。
   */
  private async probeStatus(resolved: ProxyResolved): Promise<ProxyProbe> {
    if (resolved.effectiveUrl === null) return null
    if (!this.deps.probe) return null
    const hp = parseHostPort(resolved.effectiveUrl)
    if (!hp) return null
    return (await this.deps.probe(hp.host, hp.port)) ? 'ok' : 'fail'
  }

  /**
   * 读系统代理刷新 systemDetected:仅 system 档读(其它档清空);
   * 读失败按「系统未设代理」诚实回退 null(不崩、不假装可用,spec §0 / 风险表)。
   */
  private async refreshSystemDetected(): Promise<void> {
    if (this.config.mode !== 'system') {
      this.systemDetected = null
      return
    }
    try {
      this.systemDetected = parseResolveProxy(await this.deps.systemProxyReader.read())
    } catch (err) {
      console.error('[ProxyService] 读取系统代理失败,按系统未设代理诚实回退(直连):', err)
      this.systemDetected = null
    }
  }
}
