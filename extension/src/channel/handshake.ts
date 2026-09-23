/**
 * 握手的**纯函数**部分:构造请求 + 归类响应(v0.4 Task 3 · spec §2.4 / §6.3)。
 *
 * 不碰 `fetch`、不碰 `storage`、不读时钟 —— 副作用全在 `handshakeClient.ts`。
 * 于是「四原因码怎么判」这件最容易出错的事,在 Node 里逐条可断言。
 */
import type { PostJsonInput } from '../adapter/browserAdapter'
import type {
  ExtensionChannelReason,
  ExtensionChannelRequest,
  ExtensionChannelResponse,
  ExtensionHello,
  ExtensionHelloAck
} from '../contract'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from './protocol'

/** 用户粘进来的配对信息。**token 是身份、port 是连接参数**,两者正交(CONTEXT.md「配对」)。 */
export interface Pairing {
  token: string
  port: number
}

/**
 * 单次握手超时。取值小是刻意的:对端就在本机回环上,连得上就是毫秒级;
 * 连不上时用户在等 popup 出结果,拖 30 秒不如早说「连不上」。
 */
export const HANDSHAKE_TIMEOUT_MS = 3_000

export interface HandshakeOutcome {
  reason: ExtensionChannelReason
  /** 仅 `ok` 时有:DownLord 的应用版本,给「已连接(应用 vX)」文案用 */
  appVersion?: string
  /**
   * 仅 `protocol_mismatch` 且对端按协议应答时有。
   *
   * ⚠️ 类型是 `number` **不是** `ExtensionProtocolVersion` —— 这是从 wire 上读回来的**对端**版本,
   * 对端可能正是「另一个版本」;用字面量类型接它等于断言两边永远同版本,那正是本字段要报告的情况。
   */
  appProtocolVersion?: number
}

/**
 * 构造一次握手请求。返回值直接就是 `BrowserNet.postJson` 的入参形状 ——
 * **不另造孪生类型**,免得两边各改一次就漂移。
 */
export function buildHandshakeRequest(pairing: Pairing, extensionVersion: string): PostJsonInput {
  const envelope: ExtensionChannelRequest<ExtensionHello> = {
    type: 'handshake',
    protocolVersion: PROTOCOL_VERSION,
    payload: { extensionVersion }
  }

  return {
    // 只打回环。**不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
    url: `http://127.0.0.1:${pairing.port}${CHANNEL_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: pairing.token
    },
    body: JSON.stringify(envelope),
    timeoutMs: HANDSHAKE_TIMEOUT_MS
  }
}

/** 服务端「鉴权没过」的三个状态码(`429` = 失败窗口限速,同样是「这个 token 不被接受」) */
const UNAUTHORIZED_STATUSES: readonly number[] = [401, 403, 429]

/** 成功响应的分支类型 —— 由契约的 `ExtensionChannelResponse` 派生,契约改形状这里立刻红 */
type OkResponse = Extract<ExtensionChannelResponse<ExtensionHelloAck>, { ok: true }>

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

function isOkResponse(value: unknown): value is OkResponse {
  const body = asRecord(value)
  if (!body || body.ok !== true) return false
  if (body.protocolVersion !== PROTOCOL_VERSION) return false

  const payload = asRecord(body.payload)
  return typeof payload?.appVersion === 'string'
}

/**
 * 读对端版本:`409` 走 `appProtocolVersion`;若对方回了 `200` 但版本对不上,
 * 就从信封的 `protocolVersion` 读 —— 两处都是「对端自报的版本」,能读到就如实报给用户。
 *
 * ⚠️ **与本侧相同的版本一律不返回**:那种情形下「版本不一致」是句假话(真相是响应形状不对),
 * 文案会因此错误地劝用户「升级较旧的一边」。宁可退回「没有按 DownLord 协议应答」那句。
 */
function readAppProtocolVersion(value: unknown): number | undefined {
  const body = asRecord(value)
  if (!body) return undefined

  for (const field of [body.appProtocolVersion, body.protocolVersion]) {
    if (typeof field === 'number' && Number.isFinite(field) && field !== PROTOCOL_VERSION) {
      return field
    }
  }
  return undefined
}

/**
 * 把一次真实应答归到四原因码之一(spec §2.4)。
 *
 * - `401` / `403` / `429` → `unauthorized`(**先于 JSON 解析判**:端口上若是别的程序,
 *   它回什么体都不影响「这个 token 没被接受」这个事实);
 * - `200` 且体 `ok===true` 且版本相符 → `ok`;
 * - `409` → `protocol_mismatch`(带对端版本);
 * - **其余一切**(非 JSON / 缺字段 / 状态码在协议之外)→ `protocol_mismatch`,且拿不到对端版本 ——
 *   文案会据此改口说「端口上的服务没有按 DownLord 协议应答」,这是必要的诚实(端口确实可能被别人占了)。
 *
 * ⚠️ `unreachable` **不在这里判** —— 它是「压根没连上」,根本没有 status 与 text 可言。
 */
export function classifyHandshakeResponse(status: number, text: string): HandshakeOutcome {
  if (UNAUTHORIZED_STATUSES.includes(status)) return { reason: 'unauthorized' }

  const body = parseJson(text)
  if (status === 200 && isOkResponse(body)) {
    return { reason: 'ok', appVersion: body.payload.appVersion }
  }

  const appProtocolVersion = readAppProtocolVersion(body)
  return appProtocolVersion === undefined
    ? { reason: 'protocol_mismatch' }
    : { reason: 'protocol_mismatch', appProtocolVersion }
}
