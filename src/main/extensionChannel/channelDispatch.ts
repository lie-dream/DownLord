/**
 * 信封校验 + 版本协商 + `type` 分发(纯函数,不碰 IO;v0.4 Task 3 立 · Task 4 扩为 type 表分发)。
 *
 * **不尽力兼容**(spec §2.4):现在只有一个协议版本,兼容分支是凭想象;
 * 且静默降级正是**黑洞**类故障的温床(CONTEXT.md「黑洞」)。形状不对就一律 `409`。
 *
 * ⚠️ 走到这里的请求**都已通过三闸鉴权**(`channelAuth.ts`)—— 故回 `appProtocolVersion`
 * 不是泄漏,而是「如实告知哪边旧」的必要材料(spec §2.2)。
 */
import {
  EXTENSION_PROTOCOL_VERSION,
  type CookieOffer,
  type CookieOfferAck,
  type DownloadIntent,
  type DownloadIntentAck,
  type ExtensionChannelResponse,
  type ExtensionHello,
  type ExtensionHelloAck,
  type SniffAddSelected,
  type TakeoverConfigView,
  type TakeoverSetPause,
  type VideoIntent
} from '../../shared/extensionProtocol'

export interface ChannelHandlers {
  /**
   * 握手 handler。**只读、零副作用**(不建任务、不写盘、不碰 DB)——
   * Task 3「只传意图,不传决策」的全部内容就是这一条(ARCHITECTURE §7.2)。
   */
  handshake: (payload: ExtensionHello) => ExtensionHelloAck
  /**
   * 下载意图 handler(v0.4 Task 4)。
   *
   * ⚠️ **只受理、不建任务**:跑完终裁 + 攒缓冲后**立即返回**,弹窗与建任务在应答之后异步进行。
   * 「能接上」的判据是**受理**而非**已建任务** —— 人类确认要多久不可知,而浏览器一直在写盘。
   */
  downloadIntent: (payload: DownloadIntent) => DownloadIntentAck
  /** 只读快照(popup 显示用;扩展不得据此跳过上报) */
  takeoverGetConfig: () => TakeoverConfigView
  /** 写暂停真源;返回写后的快照,免得 popup 再问一次 */
  takeoverSetPause: (payload: TakeoverSetPause) => TakeoverConfigView
  /**
   * 嗅探转交 handler(v0.4 Task 5)。
   *
   * ⚠️ **应答复用 `DownloadIntentAck`**(只有 `taken`)—— 不新增应答类型,免得有人在扩展侧
   * 按 reason 分叉,把决策泄回扩展侧。与 `downloadIntent` 同样是**只受理、不建任务**。
   */
  sniffAddSelected: (payload: SniffAddSelected) => DownloadIntentAck
  /**
   * 甲路径 handler(v0.4 Task 6):popup 的「用 DownLord 下载此页视频」。
   *
   * ⚠️ **应答复用 `DownloadIntentAck`** —— 与 `sniffAddSelected` 同一理由(不新增应答类型),
   * 只是这条路径的应答**可能带 `needCookieFor`**(第四档 + 已受理时)。
   */
  videoIntent: (payload: VideoIntent) => DownloadIntentAck
  /**
   * 暂借登录态的**唯一入口**(v0.4 Task 6)。
   *
   * 🔴 应答 `{accepted}` **零回显** —— 通道上不存在任何「读出 cookie」的形状,
   * 这是 spec §7.3 全部安全论证的支点,不是可以为调试便利让步的细节。
   */
  cookieOffer: (payload: CookieOffer) => CookieOfferAck
}

export interface DispatchResult {
  status: 200 | 409
  body: ExtensionChannelResponse
}

/** 版本 / 形状不匹配的统一应答(**服务端只可能回 unauthorized 与 protocol_mismatch 两种失败码**) */
export function protocolMismatch(): DispatchResult {
  return {
    status: 409,
    body: {
      ok: false,
      reason: 'protocol_mismatch',
      appProtocolVersion: EXTENSION_PROTOCOL_VERSION
    }
  }
}

/** 握手 payload 形状校验(缺 `extensionVersion` / 非字符串 → 按信封不合法处理) */
function isHello(v: unknown): v is ExtensionHello {
  if (!v || typeof v !== 'object') return false
  return typeof (v as Record<string, unknown>).extensionVersion === 'string'
}

/**
 * intent payload 形状校验(与 `isHello` 同形)。
 *
 * 五个必填字段逐个验类型;`byExtensionId` 可选,给了就必须是字符串。
 * **不验 URL 合法性** —— 那是主进程终裁的活(`normalizeIntent`),这里只管形状。
 */
function isDownloadIntent(v: unknown): v is DownloadIntent {
  if (!v || typeof v !== 'object') return false
  const raw = v as Record<string, unknown>
  if (typeof raw.url !== 'string') return false
  if (typeof raw.referrer !== 'string') return false
  if (typeof raw.danger !== 'string') return false
  if (typeof raw.totalBytes !== 'number') return false
  if (typeof raw.userAgent !== 'string') return false
  return raw.byExtensionId === undefined || typeof raw.byExtensionId === 'string'
}

/** setPause payload 形状校验:`minutes` 必须是数字或 `null`(`null` = 立即恢复接管) */
function isTakeoverSetPause(v: unknown): v is TakeoverSetPause {
  if (!v || typeof v !== 'object') return false
  const minutes = (v as Record<string, unknown>).minutes
  return minutes === null || typeof minutes === 'number'
}

/**
 * `sniff.addSelected` payload 形状校验(与 `isDownloadIntent` 同形,v0.4 Task 5)。
 *
 * 五个字段全必填、逐个验类型。**不验 URL 合法性、不验 contentType 语义** ——
 * 那是主进程的活(`normalizeSniffIntent` / `classifySniffed`),这里只管形状。
 */
function isSniffAddSelected(v: unknown): v is SniffAddSelected {
  if (!v || typeof v !== 'object') return false
  const raw = v as Record<string, unknown>
  if (typeof raw.url !== 'string') return false
  if (typeof raw.contentType !== 'string') return false
  if (typeof raw.referrer !== 'string') return false
  if (typeof raw.userAgent !== 'string') return false
  return typeof raw.totalBytes === 'number'
}

/**
 * `video.intent` payload 形状校验(v0.4 Task 6)。
 *
 * `pageUrl` 必填字符串;`userAgent` 可选,给了就必须是字符串。
 * **不验 URL 合法性** —— 那是 `normalizeVideoIntent` 的活(与 `isDownloadIntent` 同一分工)。
 */
function isVideoIntent(v: unknown): v is VideoIntent {
  if (!v || typeof v !== 'object') return false
  const raw = v as Record<string, unknown>
  if (typeof raw.pageUrl !== 'string') return false
  return raw.userAgent === undefined || typeof raw.userAgent === 'string'
}

/**
 * `cookie.offer` payload 形状校验(v0.4 Task 6)。
 *
 * ⚠️ **这里只验「是不是这个形状」,不验语义、不看逐条 cookie** —— 与既有五支同一分工:
 * 「`domain` 是不是合法裸 host」「哪几条 cookie 字段不全」归 `ExtensionChannelService.onCookieOffer`,
 * 因为那一层要的是**丢掉不合格的那条、留下其余**,而分发层只有「整条拒 / 整条放行」两种出口。
 *
 * 🔴 **绝不在此处 log 任何东西** —— 分发层拿得到完整 payload,一旦有人在这里加一行调试日志,
 * cookie 值就进了磁盘(红线 R4)。日志只在 service 那层发生,且那层的 logger 拿不到 payload。
 */
function isCookieOffer(v: unknown): v is CookieOffer {
  if (!v || typeof v !== 'object') return false
  const raw = v as Record<string, unknown>
  if (typeof raw.domain !== 'string') return false
  return Array.isArray(raw.cookies)
}

/** 成功应答的统一装配(信封版本恒取本侧真源,不回显对方给的值) */
function ok<P>(payload: P): DispatchResult {
  return {
    status: 200,
    body: { ok: true, protocolVersion: EXTENSION_PROTOCOL_VERSION, payload }
  }
}

/**
 * 分发一条已鉴权的通道消息。
 *
 * `raw` 是**已 JSON.parse 的值**;调用方 parse 失败时传 `null` 即可 —— 它会自然落进
 * 「不是对象」分支,与「信封缺字段」走同一条应答路径(单一真源,不另开分支)。
 *
 * ⚠️ **顺序不可换**:信封 → 版本 → `type` → payload 形状。
 * 鉴权更在这一切之前(`channelAuth.ts`)—— 换了就等于向未鉴权的调用方泄漏协议版本。
 */
export function dispatchChannelMessage(raw: unknown, handlers: ChannelHandlers): DispatchResult {
  if (!raw || typeof raw !== 'object') return protocolMismatch()

  const envelope = raw as Record<string, unknown>
  const type = envelope.type
  if (typeof type !== 'string') return protocolMismatch()
  if (typeof envelope.protocolVersion !== 'number') return protocolMismatch()
  if (envelope.protocolVersion !== EXTENSION_PROTOCOL_VERSION) return protocolMismatch()

  // 只认增长表里**已实现**的 type;表外的一律落 default → `protocolMismatch()`,不静默降级。
  switch (type) {
    case 'handshake':
      if (!isHello(envelope.payload)) return protocolMismatch()
      return ok(handlers.handshake(envelope.payload))

    case 'download.intent':
      if (!isDownloadIntent(envelope.payload)) return protocolMismatch()
      return ok(handlers.downloadIntent(envelope.payload))

    // 只读快照,**本就没有 payload** —— 故无形状可守,给什么都忽略
    case 'takeover.getConfig':
      return ok(handlers.takeoverGetConfig())

    case 'takeover.setPause':
      if (!isTakeoverSetPause(envelope.payload)) return protocolMismatch()
      return ok(handlers.takeoverSetPause(envelope.payload))

    case 'sniff.addSelected':
      if (!isSniffAddSelected(envelope.payload)) return protocolMismatch()
      return ok(handlers.sniffAddSelected(envelope.payload))

    case 'video.intent':
      if (!isVideoIntent(envelope.payload)) return protocolMismatch()
      return ok(handlers.videoIntent(envelope.payload))

    case 'cookie.offer':
      if (!isCookieOffer(envelope.payload)) return protocolMismatch()
      return ok(handlers.cookieOffer(envelope.payload))

    default:
      return protocolMismatch()
  }
}
