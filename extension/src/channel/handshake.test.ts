/**
 * 握手纯函数单测(v0.4 Task 3 · spec §2.4 / §6.3)。
 *
 * 四原因码的映射是本 Task 最容易「看起来对」的一处 —— 逐条钉死,含**协议之外**的状态码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHandshakeRequest, classifyHandshakeResponse } from './handshake'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from './protocol'

const TOKEN = '0123456789abcdef'.repeat(4)

test('buildHandshakeRequest: 只打回环 + 单端点,端口来自配对', () => {
  const request = buildHandshakeRequest({ token: TOKEN, port: 52341 }, '0.3.0')

  assert.equal(request.url, `http://127.0.0.1:52341${CHANNEL_PATH}`)
  // 不用 localhost:它可能解析到 ::1,而服务只绑了 127.0.0.1
  assert.equal(request.url.includes('localhost'), false)
})

test('buildHandshakeRequest: token 走请求头,**绝不进 URL**(日志红线 §3.5)', () => {
  const request = buildHandshakeRequest({ token: TOKEN, port: 52330 }, '0.3.0')

  assert.equal(request.headers[TOKEN_HEADER], TOKEN)
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.url.includes(TOKEN), false, 'URL 会进各类记录,token 一个字都不许出现在里面')
})

test('buildHandshakeRequest: 信封形状 —— protocolVersion 在顶层、payload 只报扩展版本', () => {
  const request = buildHandshakeRequest({ token: TOKEN, port: 52330 }, '0.4.1')

  assert.deepEqual(JSON.parse(request.body), {
    type: 'handshake',
    protocolVersion: PROTOCOL_VERSION,
    payload: { extensionVersion: '0.4.1' }
  })
  assert.ok(request.timeoutMs > 0)
})

test('buildHandshakeRequest: payload 零业务信息(只有 extensionVersion 一个字段)', () => {
  const body = JSON.parse(buildHandshakeRequest({ token: TOKEN, port: 52330 }, '0.3.0').body) as {
    payload: Record<string, unknown>
  }

  assert.deepEqual(Object.keys(body.payload), ['extensionVersion'])
})

// ── classify:四原因码 ──────────────────────────────────────────────────────

function ok(appVersion: string): string {
  return JSON.stringify({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    payload: { appVersion }
  })
}

test("classify: 200 + ok:true + 版本相符 → 'ok',并带回应用版本", () => {
  assert.deepEqual(classifyHandshakeResponse(200, ok('0.3.0')), {
    reason: 'ok',
    appVersion: '0.3.0'
  })
})

test("classify: 401 / 403 / 429 → 'unauthorized'(先于 JSON 解析判)", () => {
  for (const status of [401, 403, 429]) {
    assert.deepEqual(
      classifyHandshakeResponse(status, '{"ok":false,"reason":"unauthorized"}'),
      { reason: 'unauthorized' },
      `status ${status}`
    )
    // 端口上若是别的程序,它回什么体都不改变「这个 token 没被接受」
    assert.deepEqual(classifyHandshakeResponse(status, '<html>nginx</html>'), {
      reason: 'unauthorized'
    })
  }
})

test("classify: 409 → 'protocol_mismatch' 且带回对端版本(如实告知哪边旧)", () => {
  // ⚠️ 对端版本必须**与本侧不同**才有意义:相同时下一条用例断言它被刻意抹掉
  //   (说「两边都是 vN,请升级较旧的一边」是句假话)。故这里写一个恒大于本侧的值。
  assert.deepEqual(
    classifyHandshakeResponse(409, JSON.stringify({ ok: false, reason: 'protocol_mismatch', appProtocolVersion: PROTOCOL_VERSION + 1 })),
    { reason: 'protocol_mismatch', appProtocolVersion: PROTOCOL_VERSION + 1 }
  )
})

test("classify: 响应不是预期形状 → 'protocol_mismatch' 且**拿不到**对端版本", () => {
  const cases: [number, string][] = [
    [200, 'not json at all'],
    [200, ''],
    [200, '{"ok":true}'], // 缺 payload
    [200, JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, payload: {} })], // 缺 appVersion
    [200, JSON.stringify({ ok: false, reason: 'unauthorized' })],
    [404, '{}'], // 状态码在协议之外(端口上是别的程序)
    [500, 'Internal Server Error'],
    [413, '']
  ]

  for (const [status, text] of cases) {
    assert.deepEqual(
      classifyHandshakeResponse(status, text),
      { reason: 'protocol_mismatch' },
      `status ${status} / ${text.slice(0, 24)}`
    )
  }
})

test('classify: 200 但信封版本与本侧不同 → 版本不一致(并带回那个版本)', () => {
  const body = JSON.stringify({ ok: true, protocolVersion: 99, payload: { appVersion: '9.9.9' } })

  assert.deepEqual(classifyHandshakeResponse(200, body), {
    reason: 'protocol_mismatch',
    appProtocolVersion: 99
  })
})

test('classify: ★ 对端自报版本与本侧相同却形状不对 → 不谎称「版本不一致」', () => {
  // 说「DownLord 侧 v1、扩展侧 v1,请升级较旧的一边」是句假话,会把用户支到错误的修法上
  const body = JSON.stringify({ ok: false, reason: 'protocol_mismatch', appProtocolVersion: PROTOCOL_VERSION })

  assert.deepEqual(classifyHandshakeResponse(409, body), { reason: 'protocol_mismatch' })
})
