/**
 * ExtensionChannelService — 本地通道的编排层(v0.4 Task 3 · spec §5 / §6 · plan 1.8)。
 *
 * 职责:读写配置(含 token 保障)→ 起停 HTTP 服务 → 持有连接态 → 合成两行状态 → 广播。
 * 判定逻辑全在纯函数(`channelAuth` / `channelDispatch` / `linkState` / `portValidation`),
 * 网络副作用全在 `channelServer`,本文件只做装配与状态合成。
 *
 * **服务侧一个 `electron` import 都没有** —— 与 `ProxyService` 同一纪律
 * (那也是靠 `onStatusChanged` 注入才做到的)。
 *
 * ⚠️ **连接态是运行时态**:`lastActiveAt` **只在内存**,`extensionChannel.json` 里
 * 只有 `enabled` / `port` / `token` 三个键。重启回落「未配对」是设计而非缺陷(CONTEXT.md「运行时态」)。
 */
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import {
  DEFAULT_EXTENSION_CHANNEL_CONFIG,
  type ChannelServiceState,
  type ExtensionChannelConfig,
  type ExtensionChannelConfigPatch,
  type ExtensionChannelStatus,
  type ExtensionSideloadInfo
} from '../../shared/ipc'
import type {
  CookieOffer,
  CookieOfferAck,
  DownloadIntent,
  DownloadIntentAck,
  ExtensionHello,
  ExtensionHelloAck,
  OfferedCookie,
  SniffAddSelected,
  TakeoverConfigView,
  TakeoverSetPause,
  VideoIntent
} from '../../shared/extensionProtocol'
import type { BorrowedCookieStore } from '../video/borrowedCookieStore'
import { readChannelConfig, writeChannelConfig } from './channelConfig'
import {
  createChannelServer,
  type ChannelHttpFactory,
  type ChannelLogger,
  type ChannelServer
} from './channelServer'
import { deriveLinkState } from './linkState'
import { validateChannelPort } from './portValidation'
import { getSideloadInfo, type SideloadDeps } from './sideloadInfo'

/**
 * 日志用的 host 提取 —— **只取 host,连 path 都不要**(查询串常带签名与会话 token)。
 * URL 非法时回固定占位,绝不把原串兜底进日志。
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown'
  } catch {
    return 'invalid-url'
  }
}

/** 日志用的大小格式化;浏览器给 `-1` / `0` 表示未知,如实写 `unknown` 而非 `0MB` */
function formatSize(totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 'unknown'
  return `${(totalBytes / 1024 / 1024).toFixed(1)}MB`
}

// ── cookie.offer 的校验与日志(v0.4 Task 6 · spec §6.1)──────────────────────

/** `cookie.offer` 被拒的原因码。**只有原因码会进日志,域名与 cookie 值永远不会** */
type CookieOfferReject = 'invalid_domain' | 'no_valid_cookies' | 'not_wired'

/**
 * offer 的处理结论 —— ★ **这就是 logger 唯一能拿到的东西**。
 *
 * 🔴 **签名上就装不下 payload**:没有 `domain`、没有 `cookies`、没有任何 `string` 字段能捎带
 * 域名或 cookie 值(`reason` 是**闭合的字面量并集**,不是自由文本)。红线 R4「日志零 cookie 值 +
 * 零域名」因此是**类型层面的**保证,不是靠写日志的人自觉(D9「靠取值形态,不靠自觉」)。
 *
 * **为什么连域名都不许记**:持有层是**会话级、重启即消失**的(CONTEXT.md「暂借登录态」),
 * 而「用户在 X 站有登录态」一旦写进日志文件就**持久化到磁盘、跨会话留存** —— 等于从后门
 * 违反了「会话级」这个安全承诺。**日志会比它记录的东西活得更久。**
 */
type CookieOfferOutcome =
  | { accepted: true; seq: number; cookies: number; skipped: number }
  | { accepted: false; reason: CookieOfferReject }

/** 由结论渲染日志行(纯函数,**入参里没有任何用户数据**) */
function cookieOfferLogLine(outcome: CookieOfferOutcome): string {
  if (!outcome.accepted) {
    return `[extensionChannel][cookie] cookie.offer 拒绝(原因码 ${outcome.reason})`
  }
  const dropped = outcome.skipped > 0 ? `,丢弃 ${outcome.skipped} 条` : ''
  return `[extensionChannel][cookie] cookie.offer 受理 ×${outcome.seq}(${outcome.cookies} 条${dropped})`
}

/**
 * `domain` 必须是**合法裸 host**(spec §6.1)。
 *
 * ⚠️ **实装用 `hostname` 而不是 spec §6.1 字面写的 `host`**(2026-08-14 实测据实修正):
 * `new URL('http://a.example:8080').host === 'a.example:8080'` —— `host` **含端口**,故按 spec
 * 的字面判据,带端口的畸形值会被**放行**。`hostname` 不含端口,一条判据挡住四类:
 * `a.example/path` / `a.example:8080` / `u:p@a.example` / `https://a.example` 的 `hostname`
 * 都 ≠ 原串。**不是收紧,是把 spec 想挡的那四类真的挡住。**
 */
function isBareHost(domain: string): boolean {
  if (domain === '') return false
  try {
    return new URL(`http://${domain}`).hostname === domain
  } catch {
    return false
  }
}

/**
 * 逐项校验 cookie 形状,**不合格的丢掉、其余照收**(spec §6.1)。
 *
 * 为什么不整条拒:一条字段缺失的 cookie 不该让另外 11 条正常 cookie 一起作废 ——
 * 那会得到「明明登录着却报需要登录」这种最难诊断的形态。
 *
 * ⚠️ **不校验内容、不做任何归一** —— 尤其 `domain` 的**前导点**必须原样留着(它编码 hostOnly)。
 */
function sanitizeOfferedCookies(raw: unknown[]): { cookies: OfferedCookie[]; skipped: number } {
  const cookies: OfferedCookie[] = []
  let skipped = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const c = item as Record<string, unknown>
    if (
      typeof c.name !== 'string' ||
      typeof c.value !== 'string' ||
      typeof c.domain !== 'string' ||
      typeof c.path !== 'string' ||
      typeof c.secure !== 'boolean' ||
      typeof c.httpOnly !== 'boolean' ||
      (c.expires !== undefined && typeof c.expires !== 'number')
    ) {
      skipped += 1
      continue
    }
    cookies.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      ...(c.expires === undefined ? {} : { expires: c.expires }),
      secure: c.secure,
      httpOnly: c.httpOnly
    })
  }
  return { cookies, skipped }
}

export interface ExtensionChannelServiceDeps {
  /** `node:http` 的 createServer 薄封装(真实传 `nodeHttpFactory`;集成测试注入同一份起真服务) */
  httpFactory: ChannelHttpFactory
  /** 落盘 fs(真实传 `nodeChannelStoreFs`;单测注入内存 fake) */
  store: JsonConfigStoreFs
  /** `<userData>/config/extensionChannel.json` */
  configPath: string
  /** token 生成器(真实注入 `() => generateSecret(crypto)`;测试注入定值) */
  generateToken: () => string
  /** 时钟(真实 `() => Date.now()`;测试注入可推进的假时钟) */
  now: () => number
  /** 应用版本(握手响应的 `appVersion`;真实注入 `app.getVersion()`) */
  appVersion: string
  /** 状态广播(真实注入 `broadcastExtensionChannelStatus`;单测注入收集器) */
  onStatusChanged?: (status: ExtensionChannelStatus) => void
  /** 日志出口(**绝不记 token / Origin 值 / body 原文**,spec §3.5) */
  logger: ChannelLogger
  /** 扩展目录事实(#42) */
  sideload: SideloadDeps
  /**
   * 接管编排(v0.4 Task 4)。**缺省 = 不接管、配置恒为默认快照** —— 引擎 / TaskManager 起不来时
   * `TakeoverService` 根本不装配,此处自然回落到「浏览器照常下载」,那正是诚实的降级。
   * 真实注入是一个**惰性转发**(装配顺序:通道先起、接管随 TaskManager 后起)。
   */
  takeover?: TakeoverIntentHandler
  /**
   * 暂借登录态的持有层(v0.4 Task 6)。**纯内存、会话级**,主进程装配时注入同一个实例
   * (`VideoResolver` / `VideoEngine` / 设置页 IPC 读的都是它)。
   *
   * 缺省 = 未装配 → `cookie.offer` 一律 `{accepted:false}`(原因码 `not_wired`),**不假装收下**。
   */
  borrowedCookies?: BorrowedCookieStore
  /**
   * 持有层变更广播(真实注入 `broadcastBorrowedCookiesChanged`)。
   *
   * ⚠️ **载荷只有 host 列表** —— 与 `cookie:borrowedChanged` 的 IPC 形状一致:
   * 渲染层从头到尾没有任何通路能拿到 cookie 值(红线 R3,靠接口形状而非纪律)。
   */
  onBorrowedCookiesChanged?: (hosts: string[]) => void
}

/**
 * 通道只认这三个方法 —— 不持有整个 `TakeoverService`,也就不可能在通道层写接管逻辑。
 *
 * ⚠️ **暂停真源在 `TakeoverService`,不在这里**(Step 0 第 11 条 / CONTEXT.md「临时暂停接管」):
 *    本通道只是把 popup 的读 / 写**转发**过去,自己一个字节的状态都不存。
 */
export interface TakeoverIntentHandler {
  handleIntent(intent: DownloadIntent): DownloadIntentAck
  /**
   * 嗅探转交(v0.4 Task 5)。**与 `handleIntent` 同一编排、同一「受理即回」语义**,
   * 只是**刻意跳过 `decideTakeover` 四道**(理由见 `TakeoverService.handleSniffSelected`)。
   */
  handleSniffSelected(payload: SniffAddSelected): DownloadIntentAck
  /**
   * 甲路径(v0.4 Task 6):popup 的「用 DownLord 下载此页视频」。
   *
   * 与 `handleSniffSelected` **同一编排、同一「受理即回」语义**,差别只有两处:
   * `kind` 恒 `'video'`(不过 `classifySniffed` 四层 —— 页面 URL 本来也分不出类型)。
   */
  handleVideoIntent(payload: VideoIntent): DownloadIntentAck
  /** 只读快照(**三键**;popup 显示用。域名例外表刻意不在其中 —— 那是本机配置,不下发给扩展) */
  getConfigView(): TakeoverConfigView
  /** 写暂停真源。**返回值刻意不用** —— 通道随后自己调 `getConfigView()` 取三键快照,免得多一条泄漏路径 */
  setPause(payload: TakeoverSetPause): void
}

export class ExtensionChannelService {
  private config: ExtensionChannelConfig = { ...DEFAULT_EXTENSION_CHANNEL_CONFIG }
  private server: ChannelServer | null = null
  private serviceState: ChannelServiceState = 'stopped'
  private lastError: string | null = null
  /** 最近一次成功且已鉴权的通道请求时间。★ **只在内存,绝不落盘** */
  private lastActiveAt: number | null = null
  /** 本次运行收到的 intent 条数。**运行时态**,只用于日志里的计数,不落盘、不进状态 */
  private intentCount = 0
  /** 本次运行受理的 `cookie.offer` 条数。**同上,且它是日志里唯一与 offer 相关的可辨识信息** */
  private cookieOfferCount = 0

  constructor(private readonly deps: ExtensionChannelServiceDeps) {}

  /**
   * 启动装配:读 `extensionChannel.json`;token 缺失 / 非法当场生成并写回。
   * **不以「用户已启用」为生成条件** —— 否则设置页打开时配对码是空的(spec §3.2)。
   */
  async init(): Promise<void> {
    this.config = await readChannelConfig(
      this.deps.configPath,
      this.deps.store,
      this.deps.generateToken
    )
  }

  /** 起服务。`enabled === false` 时是 **no-op**(默认关:不装扩展的用户不该白开一个监听端口) */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      await this.stop()
      this.serviceState = 'stopped'
      this.lastError = null
      return
    }

    const server = createChannelServer({
      httpFactory: this.deps.httpFactory,
      getToken: () => this.config.token,
      now: this.deps.now,
      logger: this.deps.logger,
      handlers: {
        handshake: (payload) => this.onHandshake(payload),
        downloadIntent: (payload) => this.onDownloadIntent(payload),
        takeoverGetConfig: () => this.takeoverSnapshot(),
        takeoverSetPause: (payload) => this.onTakeoverSetPause(payload),
        sniffAddSelected: (payload) => this.onSniffAddSelected(payload),
        videoIntent: (payload) => this.onVideoIntent(payload),
        cookieOffer: (payload) => this.onCookieOffer(payload)
      }
    })
    const result = await server.start(this.config.port)
    this.serviceState = result.state
    this.lastError = result.lastError
    // 起不来就不持有:stop() 无需再关一个从未监听的 server
    this.server = result.state === 'listening' ? server : null
  }

  /** 停服务(未启动为 no-op)。退出流程与「改端口 / 关开关」共用这一条路径 */
  async stop(): Promise<void> {
    const current = this.server
    this.server = null
    if (current) await current.stop()
    this.serviceState = 'stopped'
  }

  /**
   * 写配置(开关 / 改端口)→ 起停 / 重绑 → 广播 → 回即时状态。
   *
   * **端口非法则整体不落盘**(仿 `ProxyService` 对非法 manual 地址的处理):
   * 非法端口无法监听,内存更新没有意义 —— 保持原样并把真实原因码放进 `lastError`
   * (`invalid_port:<code>`),让 UI 显示无效态。**`token` 不可经此写入**(spec §3.2)。
   */
  async setConfig(patch: ExtensionChannelConfigPatch): Promise<ExtensionChannelStatus> {
    const portCheck = validateChannelPort(patch.port)
    if (!portCheck.ok) {
      this.lastError = `invalid_port:${portCheck.code}`
      this.deps.logger.warn(
        `[extensionChannel] 端口非法(${portCheck.code}),配置未改动`
      )
      const status = this.getStatus()
      this.deps.onStatusChanged?.(status)
      return status
    }

    this.config = { ...this.config, enabled: patch.enabled, port: portCheck.port }
    await this.persist()
    // 开 / 关 / 改端口统一走「先停再起」:start() 内部对 enabled=false 是 no-op
    await this.stop()
    await this.start()

    const status = this.getStatus()
    this.deps.onStatusChanged?.(status)
    return status
  }

  /**
   * 重新生成配对码:新 token 落盘 → **清空 `lastActiveAt`** → 广播。
   * 状态立刻回落「未配对」,旧配对当场失效(UI 须提示需重新配对,spec §3.2 / §4.4)。
   *
   * **不重启服务**:token 是每请求实时读的,新值即刻生效,端口不必抖动。
   */
  async regenerateToken(): Promise<ExtensionChannelConfig> {
    this.config = { ...this.config, token: this.deps.generateToken() }
    await this.persist()
    this.lastActiveAt = null
    this.deps.onStatusChanged?.(this.getStatus())
    return this.getConfig()
  }

  /** 取配置副本(含 token —— 设置页要显示配对码;渲染层只读,写入走专用通道) */
  getConfig(): ExtensionChannelConfig {
    return { ...this.config }
  }

  /** 合成两行状态(服务态 + 扩展三态);连接态每次现算,不缓存 */
  getStatus(): ExtensionChannelStatus {
    return {
      enabled: this.config.enabled,
      service: this.serviceState,
      port: this.config.port,
      lastError: this.lastError,
      link: deriveLinkState({ lastActiveAt: this.lastActiveAt, now: this.deps.now() }),
      lastHandshakeAt: this.lastActiveAt
    }
  }

  /** 取扩展目录事实(#42;**运行时实探**,dev / 打包两态不同) */
  getSideloadInfo(): ExtensionSideloadInfo {
    return getSideloadInfo(this.deps.sideload)
  }

  /**
   * 握手 handler:**只读、零副作用**(不建任务、不写盘、不碰 DB)——
   * 本 Task「只传意图,不传决策」的全部内容(ARCHITECTURE §7.2)。
   *
   * 副作用只有一件:刷新内存里的 `lastActiveAt` 并广播状态。
   * 日志**只记扩展版本**(非敏感,且诚实呈现需要它),绝不记 token / Origin / body 原文。
   */
  private onHandshake(payload: ExtensionHello): ExtensionHelloAck {
    this.lastActiveAt = this.deps.now()
    this.deps.logger.info(`[extensionChannel] 握手成功(扩展 v${payload.extensionVersion})`)
    this.deps.onStatusChanged?.(this.getStatus())
    return { appVersion: this.deps.appVersion }
  }

  /**
   * 下载意图 handler(v0.4 Task 4 **Phase 2:接真 `TakeoverService`**)。
   *
   * ★ **只受理、不建任务**:`handleIntent` 是**同步**的 —— 跑完终裁 + `canPresent()` 就返回,
   * 弹窗 / 建任务 / 查重全在应答之后异步进行。这条同步签名本身就是「受理即回」的机器保证:
   * 想改成「等任务建成再回」得先把签名改成 `Promise`,那一步足够刺眼。
   *
   * 未装配 `takeover`(引擎 / TaskManager 起不来)→ 恒 `{taken:false}`,与「DownLord 未运行」
   * 同一条降级路径:扩展**永远不会 `cancel()`**,浏览器全程正常下载,不黑洞。
   *
   * ★ **日志红线(从第一天就守)**:只记 `host` + 决策 + 计数。
   * **绝不记**完整 URL(查询串常带签名与会话)、`referrer` 完整值(它同样可能带会话 token)、
   * UA 全串、token。`danger` 与大小是非敏感的判定材料,如实记以便排障。
   */
  private onDownloadIntent(payload: DownloadIntent): DownloadIntentAck {
    this.markActive()
    this.intentCount += 1
    const ack = this.deps.takeover?.handleIntent(payload) ?? { taken: false }
    this.deps.logger.info(
      `[extensionChannel][takeover] intent #${this.intentCount} host=${hostOf(payload.url)}` +
        ` danger=${payload.danger || 'unknown'} size=${formatSize(payload.totalBytes)}` +
        ` → ${ack.taken ? '受理' : '不接管'}`
    )
    return ack
  }

  /**
   * 嗅探转交(v0.4 Task 5)。与 `onDownloadIntent` 同形:**只转发,不判**。
   *
   * 日志红线与接管路径一致 —— **只记 host + 结论**,不记完整 URL、不记 referrer / UA。
   * ⚠️ `contentType` 是**响应头的类型字段**、不含用户数据,记它对排障(「为什么这条没被受理」)
   *    很关键;`url` / `referrer` 依旧一个字符都不进日志。
   */
  private onSniffAddSelected(payload: SniffAddSelected): DownloadIntentAck {
    this.markActive()
    const ack = this.deps.takeover?.handleSniffSelected(payload) ?? { taken: false }
    this.deps.logger.info(
      `[extensionChannel][sniff] addSelected host=${hostOf(payload.url)}` +
        ` type=${payload.contentType || 'unknown'} size=${formatSize(payload.totalBytes)}` +
        ` → ${ack.taken ? '受理' : '不受理'}`
    )
    return ack
  }

  /**
   * 甲路径:popup 的「用 DownLord 下载此页视频」(v0.4 Task 6)。
   * 与 `onSniffAddSelected` 同形:**只转发,不判**。
   *
   * 🔴 **这条路径的日志一个域名都不记**(红线 R4),与接管 / 嗅探两条既有路径**刻意不同**:
   * 那两条在没选第四档时也照跑,host 记的是「用户点了下载」;而 `video.intent` **是为第四档
   * 而生的** —— 它的 host 就是马上要去借登录态的那个域,写进日志等于把「用户在 X 站有登录态」
   * 持久化到磁盘,而持有层本身是会话级的(**日志会比它记录的东西活得更久**)。
   * 故这里只记「受理与否 + 点了几个域」,`pageUrl` 与域名一个字符都不进日志。
   */
  private onVideoIntent(payload: VideoIntent): DownloadIntentAck {
    this.markActive()
    const ack = this.deps.takeover?.handleVideoIntent(payload) ?? { taken: false }
    this.deps.logger.info(
      `[extensionChannel][video] intent → ${ack.taken ? '受理' : '不受理'}` +
        `${ack.needCookieFor === undefined ? '' : `(已点名 ${ack.needCookieFor.length} 个域)`}`
    )
    return ack
  }

  /**
   * 暂借登录态入口(v0.4 Task 6 · spec §6.1)—— 全通道**唯一**携带 cookie 值的请求。
   *
   * 四步:裸 host 校验 → 逐项形状校验(不合格的丢掉)→ 交持有层(整份覆盖)→ 广播 host 列表。
   *
   * ⚠️ **刻意不做「只接受最近点过名的域」的服务端白名单**:要做就得引入时间窗口,而本设计
   * 恰恰依赖 offer 在**不可预知长度的人类时间**里到达(用户在确认框前想多久都行)——
   * 窗口设短了制造不可见失效,设长了等于没做。**影响面如实**:一个已持有 token 的本机程序
   * 可以往持有层塞任意域的伪造 cookie;后果是用户下载该域时 yt-dlp 带一份伪造 cookie,而
   * **攻击者拿不到任何回传**(响应落在用户自己磁盘上)—— 见 spec §7.3 ①。
   *
   * 🔴 **本方法内不得出现任何把 `payload` 交给 logger 的写法**:`cookieOfferLogLine` 的入参
   * 类型里根本没有能装域名 / cookie 值的位置,想违反红线得先改那个类型(足够刺眼)。
   */
  private onCookieOffer(payload: CookieOffer): CookieOfferAck {
    this.markActive()
    return this.finishCookieOffer(this.acceptCookieOffer(payload))
  }

  /** 受理逻辑(**返回结论,不返回数据**);日志与广播由 `finishCookieOffer` 统一收尾 */
  private acceptCookieOffer(payload: CookieOffer): CookieOfferOutcome {
    const store = this.deps.borrowedCookies
    // 未装配持有层 → 不假装收下(与「takeover 未装配」同一条诚实降级)
    if (!store) return { accepted: false, reason: 'not_wired' }
    if (!isBareHost(payload.domain)) return { accepted: false, reason: 'invalid_domain' }

    const { cookies, skipped } = sanitizeOfferedCookies(payload.cookies)
    // 一条都不剩 → **不写入持有层**:写了会让设置页显示「当前暂借:X」而实际什么都取不到,
    // 那是谎报。宁可回 accepted:false,由 §6.2 的 `missing` 上下文如实报错。
    if (cookies.length === 0) return { accepted: false, reason: 'no_valid_cookies' }

    // 同域再借 = **整份覆盖,不合并**(cookie 是集合快照,合并会让退登后的旧 session 阴魂不散)
    store.offer(payload.domain, cookies)
    this.cookieOfferCount += 1
    return { accepted: true, seq: this.cookieOfferCount, cookies: cookies.length, skipped }
  }

  /** 收尾:一条日志(零域名零值)+ 一次广播(只有 host 列表)+ 零回显的应答 */
  private finishCookieOffer(outcome: CookieOfferOutcome): CookieOfferAck {
    this.deps.logger.info(cookieOfferLogLine(outcome))
    if (outcome.accepted) {
      this.deps.onBorrowedCookiesChanged?.(this.deps.borrowedCookies?.hosts() ?? [])
    }
    // 🔴 零回显:应答里除了 accepted 什么都没有(spec §7.3 的支点)
    return { accepted: outcome.accepted }
  }

  /**
   * 暂停遥控器:**转发到 `TakeoverService`(唯一真源),本通道一个字节都不存**。
   *
   * 未装配 `takeover`(引擎 / TaskManager 起不来)→ **不假装写成功**:只记一条日志并回默认快照,
   * popup 看到的就是真实情况(此时接管本来也不会发生)。
   *
   * 应答直接回**写后的快照** → popup 就地更新,不再回读一次(spec §5.4)。
   */
  private onTakeoverSetPause(payload: TakeoverSetPause): TakeoverConfigView {
    this.markActive()
    const wired = this.deps.takeover !== undefined
    this.deps.takeover?.setPause(payload)
    this.deps.logger.info(
      `[extensionChannel][takeover] setPause(${payload.minutes === null ? '恢复' : `${payload.minutes} 分钟`})` +
        (wired ? ' → 已写入真源' : ' → 忽略(接管未装配)')
    )
    return this.takeoverSnapshot()
  }

  /**
   * 接管配置快照(**三键**)。未装配接管 → 回默认值(诚实:此时接管确实不会发生)。
   *
   * ⚠️ 这里**只可能**流出 `enabled` / `pausedUntil` / `paused` —— 域名例外表不经通道下发,
   *    由 `TakeoverIntentHandler.getConfigView()` 的返回类型在形状上钉死。
   */
  private takeoverSnapshot(): TakeoverConfigView {
    this.markActive()
    return this.deps.takeover?.getConfigView() ?? { enabled: true, pausedUntil: null, paused: false }
  }

  /**
   * 刷新连接态并广播。
   *
   * ⚠️ `download.intent` 是**第一个真实业务 type** —— Task 3 spec §5.4 表格第三行
   * 「有真实业务请求时」自本 Task 起**由占位变为真实触发点**。副作用:用户只要在下载,
   * 连接状态就恒为「已连接」,「待活动」出现频率显著下降 —— 这是预期改善,不是回归。
   */
  private markActive(): void {
    this.lastActiveAt = this.deps.now()
    this.deps.onStatusChanged?.(this.getStatus())
  }

  /** 落盘(失败不崩:当前会话仍按内存配置运行,与 `ProxyService` 同口径) */
  private async persist(): Promise<void> {
    try {
      await writeChannelConfig(this.deps.configPath, this.config, this.deps.store)
    } catch (err) {
      this.deps.logger.error(
        `[extensionChannel] 写 extensionChannel.json 失败(当前会话仍按新配置运行):${String(err)}`
      )
    }
  }
}
