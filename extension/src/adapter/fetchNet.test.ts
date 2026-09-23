/**
 * fetchNet 单测(v0.4 Task 3 · spec §6.3)。
 *
 * Node 环境有真 `fetch`,但这里**注入 fake** —— 测的是「透传与超时」这层适配,不是网络。
 * 真机能不能打通由 P1 真机取证与 `artifact.test.ts` 的 R4 各守一头。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFetchNet, type FetchLike, type FetchResponseLike } from './fetchNet'

interface Recorded {
  url: string
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
}

function makeFakeFetch(response: { status: number; text: string }): {
  fetchImpl: FetchLike
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl: FetchLike = (url, init): Promise<FetchResponseLike> => {
    calls.push({ url, init })
    return Promise.resolve({
      status: response.status,
      text: (): Promise<string> => Promise.resolve(response.text)
    })
  }
  return { fetchImpl, calls }
}

test('postJson: method / headers / body 原样交给 fetch,url 不被加工', async () => {
  const fake = makeFakeFetch({ status: 200, text: '{"ok":true}' })

  await createFetchNet(fake.fetchImpl).postJson({
    url: 'http://127.0.0.1:52330/channel',
    headers: { 'Content-Type': 'application/json', 'X-DownLord-Token': 'abc' },
    body: '{"type":"handshake"}',
    timeoutMs: 3000
  })

  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:52330/channel')
  assert.equal(fake.calls[0]?.init.method, 'POST')
  assert.deepEqual(fake.calls[0]?.init.headers, {
    'Content-Type': 'application/json',
    'X-DownLord-Token': 'abc'
  })
  assert.equal(fake.calls[0]?.init.body, '{"type":"handshake"}')
})

test('postJson: { status, text } 原样透传 —— **不在这里判成败**', async () => {
  for (const status of [200, 401, 409, 500]) {
    const fake = makeFakeFetch({ status, text: `body-${status}` })

    const result = await createFetchNet(fake.fetchImpl).postJson({
      url: 'http://127.0.0.1:52330/channel',
      headers: {},
      body: '{}',
      timeoutMs: 3000
    })

    // 4xx / 5xx 一律**不抛错**:归类是纯函数 classifyHandshakeResponse 的活
    assert.deepEqual(result, { status, text: `body-${status}` })
  }
})

test('postJson: 带一个会按 timeoutMs 中止的 AbortSignal(不是 setTimeout —— 约定 L3)', async () => {
  const fake = makeFakeFetch({ status: 200, text: '{}' })

  await createFetchNet(fake.fetchImpl).postJson({
    url: 'http://127.0.0.1:52330/channel',
    headers: {},
    body: '{}',
    timeoutMs: 5
  })

  const signal = fake.calls[0]?.init.signal
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false, '刚发出时还没中止')

  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(signal.aborted, true, '超过 timeoutMs 后应自行中止')
})

test('postJson: fetch 抛错原样往上抛(由 handshakeClient 归为 unreachable)', async () => {
  const net = createFetchNet(
    (): Promise<FetchResponseLike> => Promise.reject(new Error('ECONNREFUSED'))
  )

  await assert.rejects(
    () => net.postJson({ url: 'http://127.0.0.1:52330/channel', headers: {}, body: '{}', timeoutMs: 3000 }),
    /ECONNREFUSED/
  )
})
