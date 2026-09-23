import { test } from 'node:test'
import assert from 'node:assert/strict'

import { authorizeRequest, isAuthFailure, type AuthInput } from './channelAuth'
import { EXTENSION_CHANNEL_MAX_BODY_BYTES } from '../../shared/extensionProtocol'

/**
 * 三闸判定单测(v0.4 Task 3 · spec §7.1 A-1…A-12)。
 *
 * ⚠️ **闸③ 走「缺 Origin 判拒」分支**:P2 真机取证为**阳性**(浏览器确实把
 * `Origin: chrome-extension://<id>` 带到服务端),故 A-5 的期望是**拒**(原设计判据)。
 * 若 P2 为阴性,本条须改为「放行」并在 review 写明安全模型退化为双闸 —— 本次不适用。
 */

const TOKEN = 'a'.repeat(64)

function input(overrides: Partial<AuthInput> = {}): AuthInput {
  return {
    method: 'POST',
    path: '/channel',
    headers: {
      'x-downlord-token': TOKEN,
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    },
    contentLength: 128,
    ...overrides
  }
}

test('A-1: 正确 token + chrome-extension Origin + POST /channel → 放行', () => {
  const decision = authorizeRequest(input(), { token: TOKEN })
  assert.deepStrictEqual(decision, { ok: true })
})

test('A-2: 缺 X-DownLord-Token 头 → 401 unauthorized(内部码 token_missing)', () => {
  const decision = authorizeRequest(
    input({ headers: { origin: 'chrome-extension://x' } }),
    { token: TOKEN }
  )
  assert.deepStrictEqual(decision, {
    ok: false,
    status: 401,
    reason: 'unauthorized',
    logCode: 'token_missing'
  })
})

test('A-3: token 错(等长 / 不等长各一)→ 401', () => {
  const sameLength = authorizeRequest(
    input({ headers: { 'x-downlord-token': 'b'.repeat(64), origin: 'chrome-extension://x' } }),
    { token: TOKEN }
  )
  assert.equal(sameLength.ok, false)
  assert.equal(sameLength.ok === false && sameLength.status, 401)
  assert.equal(sameLength.ok === false && sameLength.logCode, 'token_mismatch')

  const shorter = authorizeRequest(
    input({ headers: { 'x-downlord-token': 'ab', origin: 'chrome-extension://x' } }),
    { token: TOKEN }
  )
  assert.equal(shorter.ok, false)
  assert.equal(shorter.ok === false && shorter.status, 401)
})

test('A-4: token 带首尾空白 / 大写 hex → 拒(不 trim、不忽略大小写)', () => {
  const padded = authorizeRequest(
    input({ headers: { 'x-downlord-token': ` ${TOKEN} `, origin: 'chrome-extension://x' } }),
    { token: TOKEN }
  )
  assert.equal(padded.ok, false, '首尾空白必须被拒 —— 宽容只会扩大匹配面')

  const upper = authorizeRequest(
    input({ headers: { 'x-downlord-token': TOKEN.toUpperCase(), origin: 'chrome-extension://x' } }),
    { token: TOKEN }
  )
  assert.equal(upper.ok, false, '大写 hex 必须被拒 —— 生成端唯一形态是小写')
})

test('A-5: 缺 Origin → 拒(P2 阳性 → 闸③ 走原判据「缺 Origin 也拒」)', () => {
  const decision = authorizeRequest(
    input({ headers: { 'x-downlord-token': TOKEN } }),
    { token: TOKEN }
  )
  assert.deepStrictEqual(decision, {
    ok: false,
    status: 401,
    reason: 'unauthorized',
    logCode: 'origin_missing'
  })
})

test('A-6: Origin: https://evil.com → 拒', () => {
  const decision = authorizeRequest(
    input({ headers: { 'x-downlord-token': TOKEN, origin: 'https://evil.com' } }),
    { token: TOKEN }
  )
  assert.equal(decision.ok, false)
  assert.equal(decision.ok === false && decision.logCode, 'origin_bad')
})

test('A-7: Origin: chrome-extension://任意ID → 放行(只校前缀,不做 ID 白名单)', () => {
  for (const id of ['abc', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '1']) {
    const decision = authorizeRequest(
      input({ headers: { 'x-downlord-token': TOKEN, origin: `chrome-extension://${id}` } }),
      { token: TOKEN }
    )
    assert.deepStrictEqual(decision, { ok: true }, `chrome-extension://${id} 应放行`)
  }
})

test('A-8: Origin: moz-extension://uuid → 拒(v0.4 只保 Chromium;v0.5 加前缀)', () => {
  const decision = authorizeRequest(
    input({
      headers: { 'x-downlord-token': TOKEN, origin: 'moz-extension://3f2b1c00-0000-0000' }
    }),
    { token: TOKEN }
  )
  assert.equal(decision.ok, false)
  assert.equal(decision.ok === false && decision.logCode, 'origin_bad')
})

test('A-9: Origin: https://x/#chrome-extension:// → 拒(startsWith 而非 includes)', () => {
  const decision = authorizeRequest(
    input({
      headers: { 'x-downlord-token': TOKEN, origin: 'https://evil.com/#chrome-extension://' }
    }),
    { token: TOKEN }
  )
  assert.equal(decision.ok, false, 'includes 会被这个串骗过 —— 必须用 startsWith')
  assert.equal(decision.ok === false && decision.logCode, 'origin_bad')
})

test('A-10: OPTIONS /channel → 405(内部码 preflight;响应零 CORS 头由 channelServer + I4 守)', () => {
  const decision = authorizeRequest(input({ method: 'OPTIONS' }), { token: TOKEN })
  assert.deepStrictEqual(decision, {
    ok: false,
    status: 405,
    reason: 'unauthorized',
    logCode: 'preflight'
  })
})

test('A-10b: 预检判定**先于 token** —— 不带 token 的 OPTIONS 同样只回 405', () => {
  const decision = authorizeRequest(input({ method: 'OPTIONS', headers: {} }), { token: TOKEN })
  assert.equal(decision.ok === false && decision.logCode, 'preflight')
})

test('A-11: GET /channel → 405;POST /other → 404', () => {
  const wrongMethod = authorizeRequest(input({ method: 'GET' }), { token: TOKEN })
  assert.equal(wrongMethod.ok === false && wrongMethod.status, 405)
  assert.equal(wrongMethod.ok === false && wrongMethod.logCode, 'method')

  const wrongPath = authorizeRequest(input({ path: '/other' }), { token: TOKEN })
  assert.equal(wrongPath.ok === false && wrongPath.status, 404)
  assert.equal(wrongPath.ok === false && wrongPath.logCode, 'path')
})

test('A-11b: 路径判定先于一切 —— 错路径连 token 都不必看', () => {
  const decision = authorizeRequest(input({ path: '/', headers: {} }), { token: TOKEN })
  assert.equal(decision.ok === false && decision.logCode, 'path')
})

test('A-12: content-length 超 64KB → 413,且判定在读 body 之前(纯函数只看声明值)', () => {
  const decision = authorizeRequest(
    input({ contentLength: EXTENSION_CHANNEL_MAX_BODY_BYTES + 1 }),
    { token: TOKEN }
  )
  assert.deepStrictEqual(decision, {
    ok: false,
    status: 413,
    reason: 'unauthorized',
    logCode: 'too_large'
  })

  const atLimit = authorizeRequest(input({ contentLength: EXTENSION_CHANNEL_MAX_BODY_BYTES }), {
    token: TOKEN
  })
  assert.deepStrictEqual(atLimit, { ok: true }, '恰好等于上限应放行(边界)')
})

test('★ 鉴权先于版本检查:三闸不看 body,故未鉴权者拿不到任何协议信息', () => {
  // 纯函数签名里根本没有 body / protocolVersion 参数 —— 顺序由类型层面钉死。
  const decision = authorizeRequest(input({ headers: {} }), { token: TOKEN })
  assert.equal(decision.ok, false)
  assert.equal(
    'appProtocolVersion' in decision,
    false,
    '鉴权失败的应答里不得出现任何协议版本字段'
  )
})

test('★ 限速只作用于失败请求:token 正确时 isTripped 根本没被调用', () => {
  let queried = 0
  const decision = authorizeRequest(input(), {
    token: TOKEN,
    isTripped: () => {
      queried += 1
      return true
    }
  })
  assert.deepStrictEqual(decision, { ok: true }, '窗口已触发也不许拦正确 token 的请求')
  assert.equal(queried, 0, 'isTripped 只在 token 校验失败后才被查')
})

test('★ 窗口触发时,token 失败改回 429(而非 401)', () => {
  const decision = authorizeRequest(
    input({ headers: { 'x-downlord-token': 'wrong', origin: 'chrome-extension://x' } }),
    { token: TOKEN, isTripped: () => true }
  )
  assert.equal(decision.ok === false && decision.status, 429)
  assert.equal(decision.ok === false && decision.logCode, 'rate_limited')
})

test('isAuthFailure:只有安全闸的失败计入聚合计数(形状检查与体积超限不算)', () => {
  assert.equal(isAuthFailure('token_missing'), true)
  assert.equal(isAuthFailure('token_mismatch'), true)
  assert.equal(isAuthFailure('origin_missing'), true)
  assert.equal(isAuthFailure('origin_bad'), true)
  assert.equal(isAuthFailure('rate_limited'), true)
  assert.equal(isAuthFailure('preflight'), false)
  assert.equal(isAuthFailure('method'), false)
  assert.equal(isAuthFailure('path'), false)
  assert.equal(isAuthFailure('too_large'), false)
})
