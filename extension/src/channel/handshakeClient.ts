/**
 * 握手编排(注入 `BrowserAdapter`,v0.4 Task 3 · spec §5.4 / §6.3)。
 *
 * 判定全在 `handshake.ts` 的纯函数里,本文件只做三件带副作用的事:读配对 → 发请求 → 写结果。
 *
 * **两条约定在这里最容易破,逐条钉住**:
 * - **L5**:`storage.get` 随时可能是空(刚装上 / 用户清过数据),故 `readPairing` 返回 `T | undefined`,
 *   而**未配对就什么都不做** —— 不试探、不用默认 token 打一枪(spec §5.4)。
 * - **L1**:配对与最近结果一律落 `adapter.storage`,不留模块级变量 —— sw 一销毁内存就没了。
 */
import type { BrowserAdapter } from '../adapter/browserAdapter'
import {
  buildHandshakeRequest,
  classifyHandshakeResponse,
  type HandshakeOutcome,
  type Pairing
} from './handshake'

/** 用户粘的配对信息,**长期有效**(故用 `storage.local` 而非 `session` —— 后者一关浏览器就没) */
export const PAIRING_KEY = 'downlord:pairing'

/** 最近一次握手结果。**只是给 popup 看的事实**,不参与任何判定 */
export const LAST_HANDSHAKE_KEY = 'downlord:lastHandshake'

export interface LastHandshake extends HandshakeOutcome {
  /** 握手发生的时刻(epoch ms) */
  at: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** storage 里躺着的值可能是任何东西(手改过 / 旧版本写的),读回来必须验形状 */
function isPairing(value: unknown): value is Pairing {
  const raw = asRecord(value)
  if (!raw) return false
  return (
    typeof raw.token === 'string' &&
    raw.token.length > 0 &&
    typeof raw.port === 'number' &&
    Number.isInteger(raw.port)
  )
}

function isLastHandshake(value: unknown): value is LastHandshake {
  const raw = asRecord(value)
  if (!raw) return false
  return typeof raw.at === 'number' && typeof raw.reason === 'string'
}

export async function readPairing(adapter: BrowserAdapter): Promise<Pairing | undefined> {
  const raw = await adapter.storage.get<unknown>(PAIRING_KEY)
  return isPairing(raw) ? raw : undefined
}

/** 写配对。只存 `token` / `port` 两个字段,别的一律不带进来(存什么就会被读回来) */
export async function savePairing(adapter: BrowserAdapter, pairing: Pairing): Promise<void> {
  await adapter.storage.set(PAIRING_KEY, { token: pairing.token, port: pairing.port })
}

export async function readLastHandshake(
  adapter: BrowserAdapter
): Promise<LastHandshake | undefined> {
  const raw = await adapter.storage.get<unknown>(LAST_HANDSHAKE_KEY)
  return isLastHandshake(raw) ? raw : undefined
}

/**
 * 跑一次握手。
 *
 * @returns 未配对时返回 `undefined` —— **且不发任何请求、不写任何 storage**。
 *
 * `net.postJson` 抛错(`ECONNREFUSED` / 超时 / 中止)→ `unreachable`:
 * 「压根没连上」是客户端侧判定,服务端无从应答(spec §2.4)。
 */
export async function runHandshake(
  adapter: BrowserAdapter,
  now: () => number = () => Date.now()
): Promise<LastHandshake | undefined> {
  const pairing = await readPairing(adapter)
  if (!pairing) return undefined

  let outcome: HandshakeOutcome
  try {
    const response = await adapter.net.postJson(
      buildHandshakeRequest(pairing, adapter.runtime.getVersion())
    )
    outcome = classifyHandshakeResponse(response.status, response.text)
  } catch {
    outcome = { reason: 'unreachable' }
  }

  const record: LastHandshake = { at: now(), ...outcome }
  await adapter.storage.set(LAST_HANDSHAKE_KEY, record)
  return record
}
