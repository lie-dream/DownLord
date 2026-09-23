/**
 * 下载接管的**纯函数**部分:粗筛 → 采集 → 构造请求 → 判定应答(v0.4 Task 4 · spec §2.2 / §2.3 / §2.4)。
 *
 * 不碰 `fetch`、不碰 `storage`、不读时钟 —— 副作用全在 `takeoverClient.ts`。
 * 于是「什么算已接管」这件最要命的事(判错就是**黑洞**),在 Node 里逐条可断言。
 */
import type { CreatedDownload, PostJsonInput } from '../adapter/browserAdapter'
import type { Pairing } from '../channel/handshake'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from '../channel/protocol'
import type {
  DownloadIntent,
  DownloadIntentAck,
  ExtensionChannelRequest,
  ExtensionChannelResponse
} from '../contract'

/**
 * 单次 intent 的超时。
 *
 * ⚠️ **与 `HANDSHAKE_TIMEOUT_MS = 3_000` 并列存在,刻意不合并** —— 两者性质不同:
 * - **握手**是用户主动点了「连接」、**正盯着结果**:慢一点无所谓,判错更糟,故给 3 秒;
 * - **intent** 是用户点了下载、**正等着下载开始**:本地回环正常 <10ms,1000ms 已是 100 倍余量;
 *   超过即判定 DownLord 不在可服务状态,交回浏览器自己下(比让用户干等强)。
 *
 * 合并成一个常量,就等于把这两个截然不同的取舍绑在一起 —— 改一个必然误伤另一个。
 */
export const TAKEOVER_TIMEOUT_MS = 1_000

/** DownLord **没有任何配置能下得了**的四个 scheme */
const UNSUPPORTED_SCHEMES = ['blob:', 'data:', 'file:', 'chrome-extension:'] as const

/**
 * 「刚开始」的时间窗:`onCreated` 与本机 `Date.now()` 之间正常只差几毫秒,60 秒是 4 个数量级的余量。
 * 它挡的是**浏览器启动时重放的历史记录**(startTime 常是几小时 / 几天前),不是慢速网络。
 */
export const DOWNLOAD_FRESH_WINDOW_MS = 60_000

/**
 * 这个下载**值不值得上报**。
 *
 * ⚠️ 这**不是决策**,是「不适用」:`blob:` URL 只在创建它的页面上下文里有效,
 * 跨进程交给 aria2 毫无意义;`data:` 没有可请求的远端;`file:` / `chrome-extension:`
 * 是本地资源。四者**没有任何配置能让 DownLord 下得了**,故与「要不要接管」无关。
 *
 * ★ **形状即约束**:本函数**只接受 url 一个参数**,拿不到任何配置 / 暂停态 / 规则表 ——
 *   于是「扩展侧做决策」在**编译期**就不可能发生(ARCHITECTURE §7.2)。
 *   测试 X-03 断言 `shouldReportIntent.length === 1`,加第二个参数当场变红(RP-5)。
 *
 * 粗筛掉的**不上报、也不 `cancel()`** —— 浏览器照常下,零介入。
 */
export function shouldReportIntent(url: string): boolean {
  const lower = url.toLowerCase()
  return !UNSUPPORTED_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

/**
 * 「这条 `onCreated` 是不是**用户此刻真的点了下载**」。
 *
 * ★ **2026-08-02 真机暴露的严重缺陷的修复**:重启 Edge → DownLord 一次性弹出大量确认框。
 *   成因是 Chromium 系浏览器**启动时会把下载历史加载进 DownloadManager,并为每条记录重放
 *   `onCreated`** —— 对我们而言,那等于「用户一瞬间点了几十次下载」。不挡住的话:
 *   几十个确认框 + 用户随手确认就是几十个重复下载。
 *
 * 两道判据都只看**这条记录自身的数据**,不看任何配置 —— 与 `shouldReportIntent` 一样属于
 * 「不适用」而非「决策」(ARCHITECTURE §7.2 的决策仍全在主进程)。
 *
 * ⚠️ **判不出来时一律不上报**(`startTime` 解析不出 → `false`):不上报的最坏结果是
 * 「浏览器自己下」(零介入,不黑洞);误上报的最坏结果是「重复下载 + 弹窗风暴」。
 * 两边不对称,故往安全那侧倒。
 */
export function isLiveDownload(item: CreatedDownload, nowMs: number): boolean {
  // 历史记录重放时 state 是 complete / interrupted —— 这一条挡住绝大多数
  if (item.state !== 'in_progress') return false
  // 第二道:浏览器若把某条未完成下载恢复成 in_progress,它的 startTime 仍是过去的时间。
  // 用绝对值容忍时钟微小抖动(同一台机器,startTime 与 Date.now() 同源)。
  const startedAt = Date.parse(item.startTime)
  if (!Number.isFinite(startedAt)) return false
  return Math.abs(nowMs - startedAt) <= DOWNLOAD_FRESH_WINDOW_MS
}

/**
 * 从一条 `CreatedDownload` 采出上报载荷。
 *
 * - 采 **`item.url` 不是 `finalUrl`**:后者带签名与过期时间、绑定单一镜像
 *   (2026-08-01 实测④,SourceForge 样本约 1 天有效期)。交 aria2 自己跟随 302。
 * - **不采 `filename`**:`onCreated` 时刻是空串(实测③);建议名由主进程从 `url` 末段推断。
 * - **不带 `dir` / 任意 header map**:协议形状里根本没有,故这里连写都写不出来(X-02 + RP-2)。
 */
export function buildIntent(item: CreatedDownload, userAgent: string): DownloadIntent {
  return {
    url: item.url,
    referrer: item.referrer,
    danger: item.danger,
    totalBytes: item.totalBytes,
    userAgent,
    byExtensionId: item.byExtensionId
  }
}

/**
 * 构造一次 intent 请求。返回值直接就是 `BrowserNet.postJson` 的入参形状 ——
 * **不另造孪生类型**,免得两边各改一次就漂移(与 `buildHandshakeRequest` 同规矩)。
 */
export function buildIntentRequest(pairing: Pairing, intent: DownloadIntent): PostJsonInput {
  const envelope: ExtensionChannelRequest<DownloadIntent> = {
    type: 'download.intent',
    protocolVersion: PROTOCOL_VERSION,
    payload: intent
  }

  return {
    // 只打回环。**不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
    url: `http://127.0.0.1:${pairing.port}${CHANNEL_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: pairing.token
    },
    body: JSON.stringify(envelope),
    timeoutMs: TAKEOVER_TIMEOUT_MS
  }
}

/** 成功应答的分支类型 —— 由契约的 `ExtensionChannelResponse` 派生,契约改形状这里立刻红 */
type OkAck = Extract<ExtensionChannelResponse<DownloadIntentAck>, { ok: true }>

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function isTakenBody(value: unknown): value is OkAck {
  const body = asRecord(value)
  if (!body || body.ok !== true) return false
  if (body.protocolVersion !== PROTOCOL_VERSION) return false

  // `=== true` 而非真值判断:`taken: 'true'`(字符串)必须判 false
  return asRecord(body.payload)?.taken === true
}

/**
 * 「DownLord 到底受理了没有」的**唯一真值判定**。
 *
 * 判定为 true 的条件全部成立才算:
 * `status === 200` 且 JSON 解析成功 且 `ok === true` 且 `protocolVersion` 与本侧相符
 * 且 `payload.taken === true`。
 *
 * ★ **其余一切 → false**:非 JSON / 缺字段 / 401 / 409 / 500 / 空体 / `taken` 不是布尔 ——
 *   任何**看不懂的应答都默认不取消**。静默降级正是**黑洞**类故障的温床,
 *   这里让它降级到**最安全的一侧**:浏览器继续下,没有任何一方失责。
 */
export function isTakenResponse(status: number, text: string): boolean {
  if (status !== 200) return false
  return isTakenBody(parseJson(text))
}
