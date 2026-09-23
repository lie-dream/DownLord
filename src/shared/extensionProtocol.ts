/**
 * 扩展 ↔ DownLord 本地通道的协议契约 — **单一真源**(v0.4 Task 2 定版本与握手形状 · Task 3 补齐全量,spec §2.2)。
 *
 * 扩展侧唯一合法的跨目录取值通路是 `extension/src/contract.ts` 的 `import type`,
 * 编译后整条擦除 → 耦合只停在类型层、零运行时(「契约单向穿透」,见 CONTEXT.md)。
 *
 * Task 2 曾在此写「通道地址 / token / 鉴权 / 请求响应类型全归 Task 3」—— **Task 3 已落**:
 * 连接参数(端口 / 路径 / token 头)、阈值、信封、原因码、响应形状均在本文件收口。
 *
 * ⚠️ **本文件只放类型与常量,不放任何函数** —— 它被扩展侧 `import type`,
 * 一旦出现函数就会有人去值导入它,主仓代码会被 bundle 进扩展(A9 断言当场变红)。
 */

// ── 版本 ──────────────────────────────────────────────────────────────────

/**
 * 扩展 ↔ DownLord 本地通道的协议版本。改这个数字,扩展侧的字面量赋值会立刻 typecheck 红。
 *
 * ⚠️ **分发表(`ExtensionMessageType`)增删任何一行 → 必 bump**(v0.4 Task 5 Step 0 立,
 * CONTEXT.md「本地通道」):既然版本不等一律 `409` 拒绝、不尽力兼容,那「新增 type 却不 bump」
 * 本身就是在做尽力兼容 —— 失配会表现为「别的功能都好使、新功能点了没反应」,最难诊断的形态。
 *
 * 版本沿革:`1` = Task 3 / 4(握手 + 接管四支);`2` = Task 5(加 `sniff.addSelected`);
 * `3` = Task 6(加 `video.intent`、`cookie.offer` 由占位转正、应答加 `needCookieFor`)。
 * ⚠️ **一次 bump 覆盖那三处改动** —— 版本号数的是「协议形状变过几次」,不是「改了几个字段」。
 */
export const EXTENSION_PROTOCOL_VERSION = 3

/** 上一行常量的字面量类型 —— 扩展侧靠它把版本钉死 */
export type ExtensionProtocolVersion = typeof EXTENSION_PROTOCOL_VERSION

// ── 连接参数(各配一个字面量类型,供扩展侧把手抄值钉死在编译期,spec §2.5)────────

/** 本地通道默认端口(用户可改;扩展侧默认值靠字面量类型钉死) */
export const EXTENSION_CHANNEL_DEFAULT_PORT = 52330
/** 上一行常量的字面量类型 */
export type ExtensionChannelDefaultPort = typeof EXTENSION_CHANNEL_DEFAULT_PORT

/** 通道唯一端点路径(单端点 `POST /channel`,spec §2.1) */
export const EXTENSION_CHANNEL_PATH = '/channel'
/** 上一行常量的字面量类型 */
export type ExtensionChannelPath = typeof EXTENSION_CHANNEL_PATH

/**
 * token 请求头名(wire 形态)。**走请求头不走 query** —— query 会进各类 URL 记录(日志红线 §3.5)。
 * Node 把入站头名归一为小写,故服务端读 `req.headers['x-downlord-token']`。
 */
export const EXTENSION_CHANNEL_TOKEN_HEADER = 'X-DownLord-Token'
/** 上一行常量的字面量类型 */
export type ExtensionChannelTokenHeader = typeof EXTENSION_CHANNEL_TOKEN_HEADER

// ── 阈值(两侧都要知道:服务端据此拒,扩展端据此不发)─────────────────────────

/**
 * 请求体上限 64 KB:超限服务端 `413` / 流式累计超限直接断连(spec §3.4)。
 *
 * ⚠️ **必须写成裸字面量,不许写回 `64 * 1024`** —— 算式会被 widen 成 `number`,
 * 下一行的 `typeof` 就拿不到字面量、扩展侧那个手抄值当场失去编译期锚
 * (2026-08-17 探针实测:那时 `const probe: typeof EXTENSION_CHANNEL_MAX_BODY_BYTES = 1` 编译通过)。
 */
export const EXTENSION_CHANNEL_MAX_BODY_BYTES = 65536
/** 上一行常量的字面量类型 —— 扩展侧 `MAX_BODY_BYTES` 靠它钉死(v0.4 Task 6 Phase 5 补) */
export type ExtensionChannelMaxBodyBytes = typeof EXTENSION_CHANNEL_MAX_BODY_BYTES

/** token 长度(`crypto.randomBytes(32).toString('hex')` = 64 位小写 hex) */
export const EXTENSION_CHANNEL_TOKEN_HEX_LENGTH = 64

/**
 * 闸③ 允许的 `Origin` 前缀(**只校前缀,不做 ID 白名单**,spec §3.3)。
 * v0.4 只保 Chromium;v0.5 加 Firefox 时把 `moz-extension://` 加进**这一处**即可。
 */
export const EXTENSION_CHANNEL_ORIGIN_PREFIXES = ['chrome-extension://'] as const

// ── 信封 ──────────────────────────────────────────────────────────────────

/**
 * 通道消息类型。按 Task 3 spec §2.3 的增长表追加(只准按表增;要加表外的须在该 Task 的
 * spec 里说明理由并回写那张表)。
 *
 * ⚠️ **本表增删任何一行 → 必 bump `EXTENSION_PROTOCOL_VERSION`**(见那个常量的注释)。
 */
export type ExtensionMessageType =
  | 'handshake' // Task 3
  | 'download.intent' // Task 4
  | 'takeover.getConfig' // Task 4
  | 'takeover.setPause' // Task 4(表外新增:Step 0 第 11 条把暂停真源定在 DownLord → 写方向成为必需)
  | 'sniff.addSelected' // Task 5 ★ 唯一新增(`sniff.report` 已取消:未选中的资源从不离开浏览器)
  | 'video.intent' // Task 6(⚠️ 表外新增,理由已回写 Task 3 spec §2.3:与 download.intent 语义相反,不得复用)
  | 'cookie.offer' // Task 6(由 Task 3 立表时的占位**转正**)

/**
 * 请求信封。**`protocolVersion` 在顶层、不在 payload** —— 版本协商必须对**所有** type 生效。
 */
export interface ExtensionChannelRequest<P = unknown> {
  type: ExtensionMessageType
  protocolVersion: ExtensionProtocolVersion
  payload: P
}

/**
 * 握手 payload:只报「我是谁、我几版」—— 零业务信息(ARCHITECTURE §7.2「只传意图,不传决策」)。
 *
 * ⚠️ Task 2 定的形状是 `{ protocolVersion, extensionVersion }`,Task 3 **收窄为 `{ extensionVersion }`**:
 * 版本已上移到信封顶层。Task 2 spec §1.3 明写「请求响应类型全归 Task 3」,且这是纯类型改动、零运行时。
 */
export interface ExtensionHello {
  /** 扩展自身版本,取自 manifest(构建期由 package.json 注入) */
  extensionVersion: string
}

/** 握手响应 payload:只报应用版本,供扩展在「哪边旧」的文案里如实填 */
export interface ExtensionHelloAck {
  appVersion: string
}

// ── 下载接管(v0.4 Task 4 · Task 4 spec §3.1)────────────────────────────────

/**
 * 一次下载意图。**只有事实,没有决策** —— 是否接管 / 落点 / 文件名 / 分类全归主进程。
 *
 * ⚠️ 刻意没有的三个字段(用协议形状强制,不是靠注释):
 * - **`dir`** —— 落点归主进程(ARCHITECTURE §7.2);与 Task 3 里 `extension:setChannelConfig`
 *   刻意不收 `token` 是同一手法:形状里没有的东西,调用方连塞都塞不进来。
 * - **`filename`** —— `onCreated` 时刻是空串(2026-08-01 Edge 实机实测③);
 *   建议名由主进程从 `url` 末段推断,收了也是空。
 * - **任意 header map** —— 只报 `referrer` / `userAgent` 两个**语义字段**。协议里根本没有
 *   「任意头」这个形状,故 `Cookie:` 无处可塞(这是 headers 白名单的第一层)。
 */
export interface DownloadIntent {
  /** **`url` 不是 `finalUrl`**:后者带签名与过期时间、绑定单一镜像(实测④)。交 aria2 跟随 302 */
  url: string
  /** 页面来源;浏览器没给时为空串。⚠️ 可能带会话 token,日志只记 host */
  referrer: string
  /** 浏览器危险度判定。⚠️ `onCreated` 时刻可能尚未完成 → **尽力而为,不是可靠拦截**(实测⑥) */
  danger: string
  /** 浏览器自报总字节;`-1` / `0` 表示未知。**仅供确认框显示,不参与任何决策** */
  totalBytes: number
  /** sw 读 `navigator.userAgent` 自拼(不在 `DownloadItem` 里) */
  userAgent: string
  /** 由别的扩展发起的下载。**只记事实,本 Task 不据此决策** */
  byExtensionId?: string
}

/**
 * intent 应答。**只有一个必填字段** —— 不带 reason。
 *
 * ★ 「暂停中 / 规则不接管 / DownLord 未运行 / 通道不通」在扩展侧必须是**同一条代码路径**。
 *   多一个 reason 字段就会有人去写 `if (reason === 'paused')`,那等于把决策泄回扩展侧。
 *   暂停状态 popup 从 `takeover.getConfig` 查即可,不必在每次 intent 应答里重复。
 */
export interface DownloadIntentAck {
  /** `true` = DownLord 已受理并从此全权负责,扩展**才可以** `cancel()` 原生下载 */
  taken: boolean
  /**
   * ★ 点名:这次任务想要哪些**精确 host** 的 cookie(v0.4 Task 6 · spec §2.4)。
   *
   * - **空则不写该键** —— 缺省 = 不要 cookie = **零外泄默认**(红线 R10)。用户没选第四档、
   *   或没受理,这个键就根本不存在,扩展侧连「要不要读 cookie」这个分支都不会进。
   * - **最多 2 项**(页面域 + referrer 域,`MAX_COOKIE_HOSTS`):不批量(红线 R8)。
   * - ⚠️ **`download.intent`(接管直链)的应答永不写这个键** —— 「直链带 cookie 本版不做」
   *   是靠**写入点只有两处**保证的(`handleVideoIntent` / `handleSniffSelected`),I-C6 有断言。
   * - 扩展收到后**不无条件照办**:`pickCookieUrls` 只认它本次请求自己携带过的 URL
   *   (spec §3.3)—— 即使应答被伪造成 `["bank.com"]`,扩展手里也没有那个域的候选 URL。
   */
  needCookieFor?: string[]
}

/** popup 显示用的只读快照。⚠️ **扩展不得据此跳过上报** —— 见 `shouldReportIntent` 的形状约束 */
export interface TakeoverConfigView {
  enabled: boolean
  /** 暂停到期的绝对时刻(epoch ms);`null` = 未暂停。popup 据此显示剩余时长 */
  pausedUntil: number | null
  /** 服务端算好的「此刻是否暂停中」—— 免得两侧各判一次时钟 */
  paused: boolean
}

/** 遥控器:设暂停时长。`minutes: null` = 立即恢复接管 */
export interface TakeoverSetPause {
  minutes: number | null
}

// ── 网页资源嗅探(v0.4 Task 5 · Task 5 spec §4.1)────────────────────────────

/**
 * 用户在 popup 里点了某一条资源的「下载」。**只有事实,没有决策**。
 *
 * ⚠️ 刻意没有的四个字段(用**协议形状**强制,不是靠注释;与 `DownloadIntent` 同一手法):
 * - **`kind`** —— 走 `video` 还是 `http` 是**决策**,归主进程 `classifySniffed`;扩展只报事实。
 * - **`dir`** / **`filename`** —— 落点与文件名归主进程(ARCHITECTURE §7.2)。
 * - **任意 header map** —— 只报 `referrer` / `userAgent` 两个**语义字段**,故 `Cookie:`
 *   在协议层就**没有容身之处**(这是 headers 白名单的第①层)。
 * - **`tabId`** —— 主进程不需要知道用户在哪个标签页;**不传即不可能被记录**(隐私最小化)。
 *
 * ⚠️ 应答**复用 `DownloadIntentAck`**(只有 `taken`,不带 reason)。**不新增应答类型** ——
 * 多一个 reason 就会有人在扩展侧写 `if (reason === …)` 分叉,那等于把决策泄回扩展侧。
 */
export interface SniffAddSelected {
  url: string
  /** 响应头 `Content-Type`(**已去 charset、已小写**);浏览器没给时为空串 */
  contentType: string
  /** 页面来源,**取 `webRequest` details 的 `initiator`(origin 级)**;没有时为空串 */
  referrer: string
  userAgent: string
  /** `Content-Length`;`-1` = 未知。**仅供确认框显示,不参与任何决策**(与 `DownloadIntent.totalBytes` 同构) */
  totalBytes: number
}

// ── 暂借登录态(v0.4 Task 6 · Task 6 spec §3.1)──────────────────────────────

/**
 * 甲路径:用户在 popup 点了「用 DownLord 下载此页视频」。
 *
 * ⚠️ **不复用 `download.intent`**(D8):那一条是**被动拦截**(浏览器已经在下、恒 `kind:'http'`),
 * 这一条是**主动发起**(浏览器根本没在下、恒 `kind:'video'`)。语义相反,按 CONTEXT.md
 * 「接管判定」那条教训(两件事放在同一处**必然**被误解),协议层就分开。
 *
 * ⚠️ 刻意没有的字段(与 `DownloadIntent` / `SniffAddSelected` 同一手法:**用形状强制**):
 * - **`kind`** —— 恒 `'video'` 是主进程的结论,不由扩展报;
 * - **`referrer`** —— 页面 URL 自己就是来源,再来一个只会让「点名域」的上界莫名变成 2;
 * - **`dir`** / **`filename`** / **任意 header map** —— 落点、命名归主进程,`Cookie:` 无处可塞。
 */
export interface VideoIntent {
  /** 当前标签页地址。⚠️ 可能带会话 token —— **日志只记 host** */
  pageUrl: string
  /** popup 读 `navigator.userAgent` 自拼;拿不到就不发这个键 */
  userAgent?: string
}

/**
 * 扩展**给予**(不是 DownLord 索取)—— 全通道**唯一**携带 cookie 值的结构。
 *
 * 方向只有这一条:扩展 → DownLord。通道上**不存在任何「读出 cookie」的形状**,
 * 这是 spec §7.3 全部安全论证的支点(打这个端口的攻击者拿不到 cookie,只能塞进来)。
 */
export interface CookieOffer {
  /** 与 `needCookieFor` 里某一项**全等**的精确 host(裸 host:无 scheme / 无 path / 无端口) */
  domain: string
  cookies: OfferedCookie[]
}

/**
 * 一条 cookie 的 wire 形态。
 *
 * ⚠️ **刻意没有 `hostOnly` 字段** —— 浏览器用 `domain` 的**前导点**编码它
 * (`.example.com` = 域 cookie,`example.com` = host-only)。那个点**就是**这个标志位,
 * 故 **扩展侧不许归一掉那个点**(`cookieCollect` 原样搬运),否则 Netscape 文件第 2 列
 * 会写错,表现为 yt-dlp 静默不带 cookie —— 而按日志红线,日志里既没有域名也没有值可查。
 */
export interface OfferedCookie {
  name: string
  value: string
  /** 原样搬运,**前导点不得归一** */
  domain: string
  path: string
  /** unix 秒;**省略 = session cookie**(Netscape 第 5 列写 `0`,探针 B2 已验) */
  expires?: number
  secure: boolean
  httpOnly: boolean
}

/**
 * offer 应答:**只有 `accepted`,零回显**。
 *
 * 🔴 **不许为「方便调试」加任何回显字段**(收了几条、哪些 name、哪个域的第几条……)——
 * 一旦应答里能读出 cookie 的任何投影,§7.3「通道上不存在读出 cookie 的形状」这个支点就没了,
 * 而整套威胁模型是**建立在那个支点上**的,不是建立在三闸有多严上。
 */
export interface CookieOfferAck {
  accepted: boolean
}

// ── 原因码(四类,spec §2.4)────────────────────────────────────────────────

/** 扩展侧对一次握手结果的四类归纳(客户端与服务端判定的并集) */
export type ExtensionChannelReason = 'ok' | 'unreachable' | 'unauthorized' | 'protocol_mismatch'

/**
 * ⚠️ 服务端**只可能**回这两种失败码。
 * `unreachable` 是**客户端侧**判定(压根没连上,服务端无从应答);`ok` 不是失败码。
 */
export type ExtensionChannelServerFailure = 'unauthorized' | 'protocol_mismatch'

/**
 * 响应信封。失败体**只有原因码、无细节** —— 不告诉对方是哪一闸拦的(spec §2.2);
 * `appProtocolVersion` 只在版本不匹配(此时**鉴权已通过**)时附带,是「如实告知哪边旧」的必要材料。
 */
export type ExtensionChannelResponse<P = unknown> =
  | { ok: true; protocolVersion: ExtensionProtocolVersion; payload: P }
  | {
      ok: false
      reason: ExtensionChannelServerFailure
      appProtocolVersion?: ExtensionProtocolVersion
    }
