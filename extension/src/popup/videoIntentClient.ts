/**
 * `video.intent` 的通道客户端 —— **甲路径的唯一发起点**(v0.4 Task 6 Phase 3 · spec §3.1)。
 *
 * 形态照 `sniff/sniffClient.ts`:**判定全在纯函数里**(`buildVideoIntentRequest` /
 * `classifyVideoIntentResponse`),副作用只有文件末尾那一支 `sendVideoIntent`。
 *
 * ★ **为什么不复用 `download.intent`**(spec §3.1 / D8):那一支是**被动拦截**、恒 `kind:'http'`;
 *   这一支是**用户主动点了 popup 上的按钮**,语义相反。按 CONTEXT.md「接管判定」词条那条教训
 *   (两件事放进同一个形状里**必然**被误解,人与 AI 各误解过一次)**不得复用** ——
 *   代价是协议表多一行、版本 bump 一次,收益是两条路径永远不会被谁「顺手统一」掉。
 *
 * ★ **按钮恒可点,本文件不判断当前页是不是视频页**:要判断就得注入 content script(表外权限)
 *   或写不可靠的 URL 启发式,而 yt-dlp 支持上千站点 —— **我们本来就判断不了**。
 *   点了就把页面地址交给 yt-dlp 试,不是视频页走既有的解析失败路径:**诚实且零新权限**。
 *
 * ⚠️ 本文件**不 log**:`pageUrl` 可能带会话 token(协议注释已点明),而扩展的 console
 *    任何装了它的人都能在 DevTools 里翻。
 */
import type { BrowserAdapter, PostJsonInput } from '../adapter/browserAdapter'
import type { Pairing } from '../channel/handshake'
import { readPairing } from '../channel/handshakeClient'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from '../channel/protocol'
import type {
  DownloadIntentAck,
  ExtensionChannelRequest,
  ExtensionChannelResponse,
  VideoIntent
} from '../contract'
import { offerCookiesFor, type CookieFlowOutcome } from '../cookies/cookieFlow'

/**
 * 单次转交的超时。
 *
 * ⚠️ **与 `SNIFF_ADD_TIMEOUT_MS` 同值、刻意不共用**(项目既有规矩:取值相同 ≠ 取舍相同)。
 * 取舍与嗅探转交那条一致:用户点了按钮**正盯着这一行**,慢一点无所谓,判错更糟 ——
 * 把「其实送到了」判成失败,用户会再点一次,于是两个任务。
 */
export const VIDEO_INTENT_TIMEOUT_MS = 3_000

/** 一次「下载此页视频」的完整结果(含随后的 cookie 提供,供 popup 如实措辞) */
export interface VideoIntentResult {
  /** DownLord **明确受理**;其余一切(未配对 / 连不上 / 超时 / 应答看不懂)一律 `false` */
  taken: boolean
  /** 受理后的 cookie 提供结果。**没受理 / 没点名时是全空的那份** */
  cookies: CookieFlowOutcome
}

/**
 * 构造一次 `video.intent` 请求。
 *
 * ★ **载荷恰好两个键**:`pageUrl` + 可选 `userAgent`。**没有** `kind`(走 yt-dlp 还是 aria2 是
 *   **决策**,归主进程)、**没有** `referrer`(页面地址自己就是来源,再来一个只会让点名域的上界
 *   莫名变成 2)、**没有** `dir` / `filename` / header map(落点与命名归主进程)。
 *   这些「没有」由 `VideoIntent` 的**形状**强制 —— 这里连写都写不出来。
 */
export function buildVideoIntentRequest(pairing: Pairing, payload: VideoIntent): PostJsonInput {
  const envelope: ExtensionChannelRequest<VideoIntent> = {
    type: 'video.intent',
    protocolVersion: PROTOCOL_VERSION,
    payload
  }

  return {
    // 只打回环。**不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
    url: `http://127.0.0.1:${pairing.port}${CHANNEL_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: pairing.token
    },
    body: JSON.stringify(envelope),
    timeoutMs: VIDEO_INTENT_TIMEOUT_MS
  }
}

/** 成功应答的分支类型 —— 由契约派生,契约改形状这里立刻红 */
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

/** 应答里的点名清单;不是「全是字符串的数组」就当**没有点名** —— 不半信半疑地照办一半 */
function readNeedCookieFor(need: unknown): string[] | undefined {
  if (!Array.isArray(need)) return undefined
  return need.every((one): one is string => typeof one === 'string') ? need : undefined
}

/**
 * 「DownLord 到底受理了没有」的真值判定(与 `isSniffTakenResponse` 逐条同构)。
 *
 * ★ **其余一切 → false**(非 JSON / 缺字段 / 401 / 409 / 500 / 空体 / `taken` 不是布尔),
 *   **绝不假装成功** —— 假装成功的代价是用户以为任务在下、其实什么都没发生,
 *   而且他不会再点第二次。
 */
function isTakenBody(value: unknown): value is OkAck {
  const body = asRecord(value)
  if (!body || body.ok !== true) return false
  if (body.protocolVersion !== PROTOCOL_VERSION) return false

  // `=== true` 而非真值判断:`taken: 'true'`(字符串)必须判 false
  return asRecord(body.payload)?.taken === true
}

/**
 * 把一次真实应答归成「受理了 + 点了哪些名」或「没受理」。
 *
 * ★ **`needCookieFor` 只在 `taken === true` 时才读**:没受理就没有后续,更不该去读 cookie。
 *   ——「没选第四档 = 零外泄」在这条路径上的第一道形状:应答里根本不会有那个键。
 */
export function classifyVideoIntentResponse(
  status: number,
  text: string
): { taken: boolean; needCookieFor: string[] | undefined } {
  const none = { taken: false, needCookieFor: undefined }
  if (status !== 200) return none

  const parsed = parseJson(text)
  if (!isTakenBody(parsed)) return none
  return { taken: true, needCookieFor: readNeedCookieFor(parsed.payload.needCookieFor) }
}

const NO_COOKIES: CookieFlowOutcome = { accepted: [], tooLarge: false, droppedNames: 0 }

/**
 * 把当前页面地址交给 DownLord,并在它点名时提供对应域的 cookie。
 *
 * ★ **候选 URL 只有 `[pageUrl]` 这一条**(spec §3.3):它活在本次调用的局部作用域里、
 *   不进任何 storage。于是即便应答被伪造成 `needCookieFor: ["bank.com"]`,
 *   `pickCookieUrls` 手里也没有那个域的候选,`getAll` 根本不会被调用。
 *
 * ⚠️ **cookie 必然先于用户确认到达 DownLord** —— 确认之后 DownLord 无法再向扩展要任何东西
 *    (通道无反向推送)。这是**通道形态的必然,不是实现偷懒**(不变量卡 §5 第 1 条,别当 bug 修)。
 */
export async function sendVideoIntent(
  adapter: BrowserAdapter,
  pageUrl: string
): Promise<VideoIntentResult> {
  const pairing = await readPairing(adapter)
  if (!pairing) return { taken: false, cookies: NO_COOKIES } // 未配对(约定 L5),连请求都不发

  // `userAgent` 拿不到就**不发这个键**(协议注释逐字):发一个空串会让主进程侧
  // 拿它去覆盖默认 UA,那比没有更糟
  const userAgent = adapter.runtime.getUserAgent()
  const payload: VideoIntent = userAgent === '' ? { pageUrl } : { pageUrl, userAgent }

  let ack: { taken: boolean; needCookieFor: string[] | undefined }
  try {
    const response = await adapter.net.postJson(buildVideoIntentRequest(pairing, payload))
    ack = classifyVideoIntentResponse(response.status, response.text)
  } catch {
    return { taken: false, cookies: NO_COOKIES } // 超时 / ECONNREFUSED / 中止
  }

  if (!ack.taken) return { taken: false, cookies: NO_COOKIES }
  return { taken: true, cookies: await offerCookiesFor(adapter, ack.needCookieFor, [pageUrl]) }
}
