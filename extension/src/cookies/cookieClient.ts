/**
 * `cookie.offer` 的通道客户端 —— **副作用层**(v0.4 Task 6 Phase 3 · spec §3.2 / §3.5)。
 *
 * 形态照 `sniff/sniffClient.ts`:**判定全在纯函数里**(`buildCookieOfferRequest` /
 * `isCookieAcceptedResponse`,可在 Node 里逐条断言),副作用只有文件末尾那一支 `sendCookieOffer`。
 *
 * ★ **方向只有一条:扩展 → DownLord**。应答是 `{accepted:boolean}`、**零回显** ——
 *   通道上**不存在任何「读出 cookie」的形状**。spec §7.3 全部安全论证都压在这个支点上
 *   (打这个端口的攻击者**拿不到** cookie,他能做的只有塞进来),故**永远不要**为了调试方便
 *   让应答带回任何 cookie 的投影。
 *
 * ★ **给予,不是索取**:本文件只在 DownLord 点过名(`needCookieFor`)且 `pickCookieUrls`
 *   采纳了该域之后才被调用。没选第四档 → 应答里连那个键都没有 → 这里一次都不会被调到。
 *
 * ⚠️ **本文件不 log**(`cookies/` 全目录的隐私红线):这里流过的是域名与 cookie 值本身,
 *    而扩展的 console **任何装了它的人都能在 DevTools 里翻**。
 */
import type { BrowserAdapter, PostJsonInput } from '../adapter/browserAdapter'
import type { Pairing } from '../channel/handshake'
import { readPairing } from '../channel/handshakeClient'
import { CHANNEL_PATH, MAX_BODY_BYTES, PROTOCOL_VERSION, TOKEN_HEADER } from '../channel/protocol'
import type {
  CookieOffer,
  CookieOfferAck,
  ExtensionChannelRequest,
  ExtensionChannelResponse,
  OfferedCookie
} from '../contract'

/**
 * 单次提供的超时。
 *
 * ⚠️ **与 `SNIFF_ADD_TIMEOUT_MS` 同值,但刻意不共用那个常量** —— 沿用项目既有规矩:
 * 取值相同不等于取舍相同,合并成一个常量就意味着**改一个必然动另一个**。
 * 这里的取舍是「用户已经点过按钮、正等着」:慢一点无所谓,判错更糟
 * (把「其实送到了」判成失败,popup 那半句「已附登录态」就该不出现却出现,或反之)。
 */
export const COOKIE_OFFER_TIMEOUT_MS = 3_000

/**
 * 一次提供的结果 —— **三态,不是布尔**。
 *
 * `too_large` 必须与 `failed` 分开:两者给用户的实话不同(「登录态过大,未能提供」vs
 * 「没能交给 DownLord」),而**用户能做的事也不同**。合成一个值就等于让 UI 说一句含糊的话。
 */
export type CookieOfferOutcome = 'accepted' | 'too_large' | 'failed'

/**
 * 构造一次 `cookie.offer` 请求;**超出体积上限则返回 `null` = 不发**。
 *
 * 🔴 **不裁剪到放得下**(spec §3.5):静默丢几条 cookie 会得到「**有 cookie 却仍被拒**」这个
 *    最难诊断的形态 —— 用户看到「已附登录态」,yt-dlp 却照样报需要登录,而按日志红线
 *    日志里既没有域名也没有值可查。宁可整份不发并**如实告知**。
 * 🔴 **也不许把上限改大**:`MAX_BODY_BYTES` 是 Task 3 的安全参数(服务端据此 `413` / 断连),
 *    本 Task 一个字节不动。
 *
 * ⚠️ 量的是**序列化后的 UTF-8 字节数**,不是字符串长度 —— cookie 值里的非 ASCII 字符
 *    一个能占 2~4 字节,按 `length` 量会在真正超限时判成没超(服务端那侧是按字节算的)。
 */
export function buildCookieOfferRequest(
  pairing: Pairing,
  domain: string,
  cookies: OfferedCookie[]
): PostJsonInput | null {
  const payload: CookieOffer = { domain, cookies }
  const envelope: ExtensionChannelRequest<CookieOffer> = {
    type: 'cookie.offer',
    protocolVersion: PROTOCOL_VERSION,
    payload
  }
  const body = JSON.stringify(envelope)
  if (utf8ByteLength(body) > MAX_BODY_BYTES) return null

  return {
    // 只打回环。**不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
    url: `http://127.0.0.1:${pairing.port}${CHANNEL_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: pairing.token
    },
    body,
    timeoutMs: COOKIE_OFFER_TIMEOUT_MS
  }
}

/** 序列化后的 UTF-8 字节数(与服务端按字节计的上限对齐) */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 成功应答的分支类型 —— 由契约派生,契约改形状这里立刻红(与 `sniffClient.ts` 同手法) */
type OkAck = Extract<ExtensionChannelResponse<CookieOfferAck>, { ok: true }>

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

function isAcceptedBody(value: unknown): value is OkAck {
  const body = asRecord(value)
  if (!body || body.ok !== true) return false
  if (body.protocolVersion !== PROTOCOL_VERSION) return false

  // `=== true` 而非真值判断:`accepted: 'true'`(字符串)必须判 false
  return asRecord(body.payload)?.accepted === true
}

/**
 * 「DownLord 到底收下了没有」的**唯一真值判定**(与 `isSniffTakenResponse` 逐条同构)。
 *
 * ★ **其余一切 → false**:非 JSON / 缺字段 / 401 / 409 / 413 / 500 / 空体 / `accepted` 不是布尔
 *   —— **任何看不懂的应答一律降级为「没送出去」,绝不假装成功**。
 *   假装成功在这条路径上格外糟:popup 会显示「已附 xxx 的登录态」,而 DownLord 手里什么都没有,
 *   用户于是把随后的「需要登录」当成站点问题去查(spec §7.1 的诚实红线)。
 */
export function isCookieAcceptedResponse(status: number, text: string): boolean {
  if (status !== 200) return false
  return isAcceptedBody(parseJson(text))
}

/**
 * 提供一个域的 cookie。
 *
 * @returns `'accepted'` = DownLord **明确收下**;`'too_large'` = 超上限**没发**;
 *   其余一切(未配对 / 连不上 / 超时 / 应答看不懂)一律 `'failed'`。
 *   **不判「为什么失败」的更细分类** —— 那会让人在这里写 `if (reason === …)` 分叉,
 *   而原委由 popup 上既有的握手结果行如实说。
 */
export async function sendCookieOffer(
  adapter: BrowserAdapter,
  domain: string,
  cookies: OfferedCookie[]
): Promise<CookieOfferOutcome> {
  const pairing = await readPairing(adapter)
  if (!pairing) return 'failed' // 未配对(约定 L5),此时连请求都不发

  const input = buildCookieOfferRequest(pairing, domain, cookies)
  if (input === null) return 'too_large' // 🔴 不发、不裁剪

  try {
    const response = await adapter.net.postJson(input)
    return isCookieAcceptedResponse(response.status, response.text) ? 'accepted' : 'failed'
  } catch {
    return 'failed' // 超时 / ECONNREFUSED / 中止
  }
}
