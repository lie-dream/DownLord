/**
 * popup 遥控器的通道客户端 —— 纯函数 + 编排同处一文件(v0.4 Task 4 · spec §5.4 · plan 4.3)。
 *
 * 分工照 `handshake.ts` / `handshakeClient.ts` 那一对:**判定全在纯函数里**(于是「什么算拿到了
 * 一份合法快照」可在 Node 里逐条断言),副作用只有文件末尾那三个 `async`。合成**一个**文件是因为
 * 这一组只有三个纯函数、两支编排 —— 拆两份反而多一条 import 边要维护。
 *
 * ★ **本文件不参与任何接管决策,它只是遥控器的线材**。暂停真源在 DownLord 主进程:
 *   `shouldReportIntent(url)` 拿不到这里的任何东西(形状强制,X-03 / RP-5 钉死),
 *   故「知道现在暂停中就不上报」这种事在**编译期**就写不出来。暂停期间扩展**照常上报意图**,
 *   由 DownLord 回 `{taken:false}` —— 在可观察行为上等同「完全不拦截」(CONTEXT.md「临时暂停接管」)。
 *
 * ★ **本文件一个字都不写 storage**:接管状态**不落 popup**(约定 L1 的正向应用 —— 能不落就不落)。
 *   每次打开现问;问不到就说不知道,**绝不显示一个可能过期的旧值**。
 */
import type { BrowserAdapter, PostJsonInput } from '../adapter/browserAdapter'
import type {
  ExtensionChannelRequest,
  TakeoverConfigView,
  TakeoverSetPause
} from '../contract'
import type { Pairing } from './handshake'
import { readPairing } from './handshakeClient'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from './protocol'

/**
 * 遥控请求的超时。
 *
 * ⚠️ **与 `HANDSHAKE_TIMEOUT_MS` 同值,但刻意不共用那个常量** —— 沿用 `TAKEOVER_TIMEOUT_MS`
 * 立下的规矩:取值相同不等于取舍相同,合并成一个常量就意味着**改一个必然动另一个**。
 * 这里的取舍是「用户点开 popup、正盯着这一行」:慢一点无所谓,判错(把连不上说成没暂停)更糟。
 */
export const TAKEOVER_CONFIG_TIMEOUT_MS = 3_000

/** 两支请求共用的信封 → `postJson` 入参。**不另造孪生类型**(与 `buildHandshakeRequest` 同规矩) */
function toPostInput(pairing: Pairing, envelope: ExtensionChannelRequest<unknown>): PostJsonInput {
  return {
    // 只打回环。**不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
    url: `http://127.0.0.1:${pairing.port}${CHANNEL_PATH}`,
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: pairing.token
    },
    body: JSON.stringify(envelope),
    timeoutMs: TAKEOVER_CONFIG_TIMEOUT_MS
  }
}

/**
 * 构造一次「问问现在接管是什么状态」。
 *
 * `takeover.getConfig` **本就没有 payload**(服务端 dispatch 对这一支不校验、给什么都忽略),
 * 信封形状要求这个字段在,故给空对象。**刻意不往里塞任何东西** —— 一旦有人顺手塞进
 * 「扩展这边算的暂停态」,决策就从主进程漏回扩展侧了。
 */
export function buildGetConfigRequest(pairing: Pairing): PostJsonInput {
  const envelope: ExtensionChannelRequest<Record<string, never>> = {
    type: 'takeover.getConfig',
    protocolVersion: PROTOCOL_VERSION,
    payload: {}
  }
  return toPostInput(pairing, envelope)
}

/**
 * 构造一次「暂停 N 分钟」/「恢复接管」。
 *
 * `minutes: null` = **恢复接管**(时长档的第四项)。扩展侧**不换算成绝对时刻** ——
 * 那是主进程用它自己的时钟算的(`pausedUntilFrom`),两边各算一次必然对不齐。
 */
export function buildSetPauseRequest(pairing: Pairing, minutes: number | null): PostJsonInput {
  const envelope: ExtensionChannelRequest<TakeoverSetPause> = {
    type: 'takeover.setPause',
    protocolVersion: PROTOCOL_VERSION,
    payload: { minutes }
  }
  return toPostInput(pairing, envelope)
}

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

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * 把一次真实应答归成「拿到了一份合法快照」或「没拿到」。
 *
 * ⚠️ **刻意不判四原因码**(与 `classifyHandshakeResponse` 的差别)。「为什么没拿到」在 popup 上
 *   已经由握手那一行如实回答了;这里再判一次,只会让两行各说各话。**这条路只回答「有没有」。**
 *
 * ⚠️ **逐字段重建,不整个 `as` 断言**:服务端若哪天多下发了 `excludedDomains`,它**一个字也进不来**
 *   —— 域名例外表永不经通道下发(那是设置页走 IPC 的 `TakeoverSettingsView` 才有的第四键)。
 *   这比「断言键集合恰好三个」更合用:**宽进**(多余键不至于让整份快照作废)、**严取**(只取认识的三个)。
 *   「恰好三键」由 DownLord 侧的 I-06 钉死 —— 那是它该负责的地方,不在这里重复计数。
 */
export function classifyConfigResponse(
  status: number,
  text: string
): TakeoverConfigView | undefined {
  if (status !== 200) return undefined

  const body = asRecord(parseJson(text))
  if (!body || body.ok !== true) return undefined
  if (body.protocolVersion !== PROTOCOL_VERSION) return undefined

  const payload = asRecord(body.payload)
  if (!payload) return undefined
  if (typeof payload.enabled !== 'boolean') return undefined
  if (typeof payload.paused !== 'boolean') return undefined
  if (!isNullableFiniteNumber(payload.pausedUntil)) return undefined

  return { enabled: payload.enabled, pausedUntil: payload.pausedUntil, paused: payload.paused }
}

/**
 * 两支编排共用的那三步:读配对 → 发请求 → 归类。
 *
 * @returns `undefined` = **这次没问到**。三种情形收敛到同一个值,且**都不写 storage**:
 *   ① 未配对(约定 L5,此时连请求都不发)② 连不上 / 超时 ③ 应答不合协议。
 *   popup 据此显示占位符,由既有的握手结果行说明原委 —— 不猜、不编、不留旧值。
 */
async function requestConfig(
  adapter: BrowserAdapter,
  build: (pairing: Pairing) => PostJsonInput
): Promise<TakeoverConfigView | undefined> {
  const pairing = await readPairing(adapter)
  if (!pairing) return undefined

  try {
    const response = await adapter.net.postJson(build(pairing))
    return classifyConfigResponse(response.status, response.text)
  } catch {
    return undefined // 超时 / ECONNREFUSED / 中止
  }
}

/** 问一次当前接管状态(popup 每次打开都现问,不缓存) */
export async function fetchTakeoverConfig(
  adapter: BrowserAdapter
): Promise<TakeoverConfigView | undefined> {
  return requestConfig(adapter, buildGetConfigRequest)
}

/**
 * 设一档暂停 / 恢复接管。
 *
 * 应答**直接就是写后的快照**,故 popup 就地更新即可 —— **不再回读一次**
 * (多一次往返就多一个「读到的是写之前那份」的窗口)。
 */
export async function setTakeoverPause(
  adapter: BrowserAdapter,
  minutes: number | null
): Promise<TakeoverConfigView | undefined> {
  return requestConfig(adapter, (pairing) => buildSetPauseRequest(pairing, minutes))
}
