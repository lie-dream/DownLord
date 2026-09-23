/**
 * VideoResolver(解析单元,spec §2.1 / §2.4)。
 *
 * 只读解析:组 `buildYtDlpResolveArgs` → 注入式 `ytdlpProcess.run`(可测)→
 * `parseYtDlpInfoJson` 防御式映射;失败经 `mapResolveError` 抛**可读中文**错误,
 * 原始 stderr 只进日志(ARCHITECTURE §6.3)。不下载、不落库、不碰状态机(§2.1)。
 *
 * 依赖(deps)与配置(config)分离,对齐主进程装配 `new VideoResolver({ ytdlpProcess }, { ytdlpPath })`:
 * 单测注入 mock ytdlpProcess,不起真 yt-dlp / 不碰网络。
 */
import { buildYtDlpResolveArgs } from './ytdlpArgs'
import { parseYtDlpInfoJson } from './ytdlpJson'
import { mapResolveError, type ExtensionCookieFacts } from './resolveError'
import { resolveCookieHosts } from './cookieDomains'
import { extensionCookieContextOf } from './cookieLeaseFactory'
import type { CookieLease } from './tempCookieFile'
import type { YtdlpProcess } from './ytdlpProcess'
import type { CookieConfig, ResolveResult, ProxyResolved } from '../../shared/ipc'

export interface VideoResolverDeps {
  ytdlpProcess: YtdlpProcess
  /**
   * 注入式当前代理回调(Task 7 · spec §4.2)。每次 resolve 前**实时调用**取 effectiveUrl 传给
   * `buildYtDlpResolveArgs`(切档即时生效;墙外站元信息拉取也需走代理);
   * 未注入 → 传 undefined → 不追加 `--proxy`(向后兼容)。
   */
  getProxy?: () => ProxyResolved
  /**
   * 注入式当前 Cookie 回调(v0.2 Task 1 · spec §2.2 / §6.2,与 getProxy 完全对称)。每次 resolve
   * 前**实时调用**取 CookieConfig 传给 `buildYtDlpResolveArgs`(切档即时生效;需登录站连解析 `-J` 都被拒,
   * 故解析也注入 cookie);未注入 → 传 undefined → 不追加 cookie 参数(向后兼容)。**cookie 是全局登录态,
   * 实时读、不进任务持久化**(与随 videoMeta 持久化的字幕数据流不同)。
   */
  getCookie?: () => CookieConfig
  /**
   * 第四档「从扩展获取」专用:为**本次 yt-dlp 进程**物化一份一次性 cookies.txt(v0.4 Task 6 · spec §2.3)。
   * 返回 `null` = 手上没有该任务需要的登录态 → 照常解析,只是不带 `--cookies`。
   *
   * **未注入 → `undefined` → 恒不物化 → 与改动前逐字节等价**(与既有 `getProxy` / `getCookie` 同构)。
   * ⚠️ 拿到租约的一方**同时拿到删除责任**:本类在 `resolve` 的 `finally` 里 `release()`(spec §4.4 第 1 条)。
   */
  leaseCookieFile?: (hosts: string[]) => CookieLease | null
  /**
   * 第四档专用:扩展通道**此刻是否连着**(启用 + 本次启动握手过)。
   *
   * ★ 它存在的唯一理由是把「没拿到登录态」分成 `unpaired` / `missing` 两半 —— 两半给用户的
   * 下一步完全不同(去配对 vs 回浏览器登录),合成一条必然指错一半人(spec §6.2)。
   * 未注入 → 保守判 `unpaired`(不知道就不声称连着)。
   */
  isExtensionLinked?: () => boolean
}

export interface VideoResolverConfig {
  /** resolveYtDlpPath 结果(优先可写副本,§1.1) */
  ytdlpPath: string
}

export class VideoResolver {
  constructor(
    private readonly deps: VideoResolverDeps,
    private readonly config: VideoResolverConfig
  ) {}

  /**
   * @param headers - 接管 / 嗅探来源的请求头(v0.4 Task 5 · spec §4.5 第 5 处)。
   *   **解析阶段不能省** —— 防盗链站点在 yt-dlp **拉 m3u8 清单**那一步就会 403,只补下载修不好。
   *   不传 → `buildYtDlpResolveArgs` 第四参 `undefined` → 恒产 `[]` → 与改动前逐字节等价。
   */
  async resolve(
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>
  ): Promise<ResolveResult> {
    // 实时取当前代理(切档即时生效);未注入回调 → undefined → 不追加 --proxy(向后兼容)
    const proxy = this.deps.getProxy ? this.deps.getProxy().effectiveUrl : undefined
    // 实时取当前 cookie(切档即时生效;需登录站连解析都被拒,故解析也注入);未注入 → undefined → 不追加 cookie
    const cookie = this.deps.getCookie ? this.deps.getCookie() : undefined
    // 第四档(v0.4 Task 6 · spec §2.4):**当场从已有数据重算**本次要哪些域 —— 不跟着任务传,
    // 故 `AddTaskInput` / `Task` / SQLite schema / `taskManager.ts` 一个字段都不用加。
    // ⚠️ 档位闸门在此:非第四档 → 恒 `[]` → 恒不调 `leaseCookieFile` → 零外泄(红线 R10)。
    const hosts =
      cookie?.source === 'extension' ? resolveCookieHosts(url, headers?.['Referer']) : []
    const lease = hosts.length > 0 ? (this.deps.leaseCookieFile?.(hosts) ?? null) : null
    const extCookie: ExtensionCookieFacts | undefined =
      cookie?.source === 'extension'
        ? { context: extensionCookieContextOf(lease, this.deps.isExtensionLinked), hosts }
        : undefined

    try {
      const args = buildYtDlpResolveArgs(url, proxy, cookie, headers, lease?.path)
      const result = await this.deps.ytdlpProcess.run(this.config.ytdlpPath, args, { signal })

      // 进程层失败(退出码非 0 / 被超时 kill 的 null)→ 据 stderr / exitCode 映射可读错误
      if (result.exitCode !== 0) {
        throw this.fail(url, result.stderr, result.exitCode, extCookie)
      }

      // 解析层:JSON 解析失败 → 站点改版(exitCode 传 0 触发解析层文案)
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw this.fail(url, result.stderr, 0, extCookie)
      }

      const resolved = parseYtDlpInfoJson(parsed)
      // formats 为空(站点改版常见)→ 同解析层文案
      if (resolved.kind === 'video' && resolved.formats.length === 0) {
        throw this.fail(url, result.stderr, 0, extCookie)
      }

      return resolved
    } finally {
      // 🔴 **用完即删,只能是 `finally`**(spec §4.4 第 1 条):`run` 抛错 / 被 abort 时也必须删。
      // 幂等,删不掉只吞异常不抛 —— 一个删不掉的临时文件不该让用户的解析失败。
      lease?.release()
    }
  }

  /** 原始 stderr 进日志,返回可读中文错误(不糊用户脸上,§6.3) */
  private fail(
    url: string,
    stderr: string,
    exitCode: number | null,
    extCookie?: ExtensionCookieFacts
  ): Error {
    console.error(`[VideoResolver] 解析失败 url=${url} exitCode=${exitCode}\n${stderr}`)
    return new Error(mapResolveError(stderr, exitCode, extCookie))
  }
}
