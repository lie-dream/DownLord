/**
 * 「用户点了某一条资源的下载」的通道客户端 —— **副作用层**(v0.4 Task 5 Phase 2 · spec §4.1)。
 *
 * 形态仿 `downloads/takeoverClient.ts` + `channel/takeoverConfigClient.ts`:
 * **判定全在纯函数里**(`buildSniffRequest` / `isSniffTakenResponse`,可在 Node 里逐条断言),
 * 副作用只有文件末尾那一支 `sendSniffSelected`。
 *
 * ★ **本文件是「未被用户选中的资源从不离开浏览器」这句话的唯一出口**:它一次只发**一条**,
 *   且只在用户点了那一条时被调用。**`sniff.report` 不存在** —— 那是状态上行、不是意图上行,
 *   且 MV3 的 sw 一销毁推送就断。这句话因此恒为真,可以直接写进 UI。
 *
 * ★ **不上报 `kind`**(走 yt-dlp 还是 aria2 是**决策**,归主进程 `classifySniffed`)、
 *   **不上报 `tabId`**(主进程不需要知道用户在哪个标签页;不传即不可能被记录)。
 *   两者都由 `SniffAddSelected` 的**形状**强制 —— 这里连写都写不出来。
 *
 * ⚠️ 本文件**不 log**(`sniff/` 全目录的隐私红线,见 `sniffRules.ts` 文件头)。
 *
 * ★ **v0.4 Task 6 追加一件**:受理应答里若带 `needCookieFor`,顺带走一次 `cookies/cookieFlow.ts`
 *   (丙路径)。**只多这一件** —— 请求载荷、返回值、既有降级判定全部一字不改。
 */
import type { BrowserAdapter, PostJsonInput } from '../adapter/browserAdapter'
import type { Pairing } from '../channel/handshake'
import { readPairing } from '../channel/handshakeClient'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from '../channel/protocol'
import type {
  DownloadIntentAck,
  ExtensionChannelRequest,
  ExtensionChannelResponse,
  SniffAddSelected
} from '../contract'
import { offerCookiesFor } from '../cookies/cookieFlow'

/**
 * 单次转交的超时。
 *
 * ⚠️ **刻意不共用 `TAKEOVER_TIMEOUT_MS = 1000`** —— 沿用它自己立下的规矩:取值不同是因为
 * **取舍不同**。接管那条路 1 秒就判失败,是因为**浏览器一直在写盘**、拖着不决断会变成双份下载;
 * 这条路没有那个压力:用户在 popup 里点了按钮**正盯着这一行**,慢一点无所谓,判错更糟
 * (把「其实送到了」判成失败,用户会再点一次 → 两个任务)。故给 3 秒。
 */
export const SNIFF_ADD_TIMEOUT_MS = 3_000

/** 转交一条资源需要的全部原料 —— 与 `SniffRow` 的四个载荷字段同形,`userAgent` 由适配层补 */
export interface SniffSelection {
  url: string
  contentType: string
  /** 页面来源,**origin 级**(采集时记下的 `initiator`) */
  initiator: string
  /** `-1` = 未知 */
  totalBytes: number
}

/**
 * 构造一次转交请求。返回值直接就是 `BrowserNet.postJson` 的入参形状 ——
 * **不另造孪生类型**(与 `buildIntentRequest` / `buildHandshakeRequest` 同规矩)。
 *
 * ★ **`referrer` 取的是采集时的 `initiator`,不另注册 `onBeforeSendHeaders` 抓完整 `Referer`**:
 *   少一个监听器、少一份请求头数据流;防盗链绝大多数只校验 origin;而 `initiator` 本来就是
 *   origin 级 —— ARCHITECTURE §7.6「不记 referrer 完整值」因此**不靠自觉,靠取值形态**。
 */
export function buildSniffRequest(
  pairing: Pairing,
  payload: SniffAddSelected
): PostJsonInput {
  const envelope: ExtensionChannelRequest<SniffAddSelected> = {
    type: 'sniff.addSelected',
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
    timeoutMs: SNIFF_ADD_TIMEOUT_MS
  }
}

/** 成功应答的分支类型 —— 由契约派生,契约改形状这里立刻红(与 `intent.ts` 同手法) */
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
 * 「DownLord 到底受理了没有」的**唯一真值判定**(与 `isTakenResponse` 逐条同构)。
 *
 * ★ **其余一切 → false**:非 JSON / 缺字段 / 401 / 409 / 500 / 空体 / `taken` 不是布尔 ——
 *   **任何看不懂的应答一律降级为「没送出去」**,由 UI 如实回落(按钮恢复可点 + 一行实话)。
 *   **绝不假装成功**:假装成功的代价是用户以为任务在下、其实什么都没发生,
 *   而且他不会再点第二次 —— 那正是最难被发现的一类故障。
 */
export function isSniffTakenResponse(status: number, text: string): boolean {
  if (status !== 200) return false
  return isTakenBody(parseJson(text))
}

/**
 * ★ v0.4 Task 6:应答里的点名清单(`needCookieFor`)—— **丙路径接通 cookie 的唯一读取点**。
 *
 * 与 `isSniffTakenResponse` 分开两支而不是让它多返回一个值:那一支是**既有的真值判定**,
 * 被 UI 的「已发送」直接依赖,签名一改就有一串调用点跟着改。这一支只在受理之后才被问到。
 *
 * 不是「全是字符串的数组」就当**没有点名** —— 不半信半疑地照办一半。
 */
function readNeedCookieFor(status: number, text: string): string[] | undefined {
  if (status !== 200) return undefined
  const parsed = parseJson(text)
  if (!isTakenBody(parsed)) return undefined

  const need = parsed.payload.needCookieFor
  if (!Array.isArray(need)) return undefined
  return need.every((one): one is string => typeof one === 'string') ? need : undefined
}

/**
 * 转交一条资源。
 *
 * @returns `true` = DownLord **明确受理**;其余一切(未配对 / 连不上 / 超时 / 应答看不懂)
 *   一律 `false`,三类收敛到同一个值 —— 扩展侧**不判「为什么没送出去」**
 *   (那会让人在这里写 `if (reason === …)` 分叉,等于把决策泄回扩展侧;
 *   原委由 popup 上既有的握手结果行如实说)。
 *
 * ★ **v0.4 Task 6:受理后若应答点了名,顺带提供那些域的 cookie**(丙路径)。
 *   候选 URL 是 `[url, referrer]` —— **这一次请求自己带过去的那两个**,
 *   活在本函数的局部作用域里、不进任何 storage(spec §3.3 那道结构约束的前提)。
 *   ⚠️ **返回值不变、仍是布尔**:cookie 送没送到**不影响「这条资源交出去了没有」** ——
 *   把两件事合进一个返回值,会让「已发送」这个用户可见结论跟着一件附加能力一起失败。
 */
export async function sendSniffSelected(
  adapter: BrowserAdapter,
  selection: SniffSelection
): Promise<boolean> {
  const pairing = await readPairing(adapter)
  if (!pairing) return false // 未配对(约定 L5),此时连请求都不发

  const payload: SniffAddSelected = {
    url: selection.url,
    contentType: selection.contentType,
    referrer: selection.initiator,
    userAgent: adapter.runtime.getUserAgent(),
    totalBytes: selection.totalBytes
  }

  let response
  try {
    response = await adapter.net.postJson(buildSniffRequest(pairing, payload))
  } catch {
    return false // 超时 / ECONNREFUSED / 中止
  }

  if (!isSniffTakenResponse(response.status, response.text)) return false

  // 没点名(没选第四档 / 那两个域都不需要)→ `offerCookiesFor` 直接返回空,`getAll` 一次都不调
  await offerCookiesFor(adapter, readNeedCookieFor(response.status, response.text), [
    selection.url,
    selection.initiator
  ])
  return true
}
