/**
 * `cookie.offer` 通道客户端单测(**N8**,v0.4 Task 6 Phase 3 · spec §3.5)。
 *
 * 断言的核心有三句:
 * **① 超 64KB → 不发(且不裁剪);② 应答零回显;③ 任何看不懂的应答一律降级为「没送出去」。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter, PostJsonInput, PostJsonResult } from '../adapter/browserAdapter'
import { PAIRING_KEY } from '../channel/handshakeClient'
import { MAX_BODY_BYTES, TOKEN_HEADER } from '../channel/protocol'
import type { OfferedCookie } from '../contract'
import {
  buildCookieOfferRequest,
  isCookieAcceptedResponse,
  sendCookieOffer,
  utf8ByteLength
} from './cookieClient'

const TOKEN = 'a'.repeat(64)
const PAIRING = { token: TOKEN, port: 52330 }
const DOMAIN = 'www.example.com'

function cookies(count: number, valueLength = 32): OfferedCookie[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `c${index}`,
    value: 'x'.repeat(valueLength),
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expires: 1_800_000_000
  }))
}

function okText(accepted: boolean, protocolVersion = 3): string {
  return JSON.stringify({ ok: true, protocolVersion, payload: { accepted } })
}

function makeAdapter(options: {
  paired?: boolean
  respond?: () => Promise<PostJsonResult>
}): { adapter: BrowserAdapter; posts: PostJsonInput[]; writes: string[] } {
  const posts: PostJsonInput[] = []
  const writes: string[] = []
  const store = new Map<string, unknown>()
  if (options.paired !== false) store.set(PAIRING_KEY, PAIRING)

  const reject = (what: string) => (): Promise<never> =>
    Promise.reject(new Error(`本文件不该${what}`))

  const adapter: BrowserAdapter = {
    storage: {
      get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(store.get(key) as T | undefined)
      },
      set(key: string): Promise<void> {
        writes.push(key)
        return Promise.resolve()
      },
      remove(key: string): Promise<void> {
        writes.push(key)
        return Promise.resolve()
      },
      onChanged: (): void => {}
    },
    runtime: {
      getVersion: (): string => '0.4.0',
      getId: (): string => 'ext-id',
      onInstalled: (): void => {},
      onStartup: (): void => {},
      onMessage: (): void => {},
      sendMessage: (): Promise<unknown> => Promise.resolve(undefined),
      getUserAgent: (): string => 'UA/1.0'
    },
    net: {
      postJson(input: PostJsonInput): Promise<PostJsonResult> {
        posts.push(input)
        return (
          options.respond ??
          ((): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(true) }))
        )()
      }
    },
    downloads: {
      onCreated: (): void => {},
      cancel: reject('取消浏览器下载'),
      eraseCanceled: reject('抹下载记录')
    },
    session: {
      get: reject('读嗅探桶'),
      set: reject('写嗅探桶'),
      remove: reject('删嗅探桶'),
      keys: reject('枚举会话存储')
    },
    webRequest: { onHeadersReceived: (): void => {} },
    tabs: {
      queryActiveId: reject('读标签页'),
      queryActiveUrl: reject('读标签页地址'),
      reloadBypassingCache: reject('刷新标签页'),
      onRemoved: (): void => {}
    },
    // 本文件测的是**通道那一段**:cookie 已经采好了才进来
    cookies: { getAll: reject('读 cookie') }
  }

  return { adapter, posts, writes }
}

// ── 请求形状 ──────────────────────────────────────────────────────────────

test('buildCookieOfferRequest: 只打回环 + token 走请求头 + 信封 type / 版本正确', () => {
  const input = buildCookieOfferRequest(PAIRING, DOMAIN, cookies(2))
  assert.ok(input)
  assert.equal(input.url, 'http://127.0.0.1:52330/channel')
  assert.equal(input.headers[TOKEN_HEADER], TOKEN)
  assert.equal(input.headers['Content-Type'], 'application/json')

  const body = JSON.parse(input.body) as Record<string, unknown>
  assert.equal(body.type, 'cookie.offer')
  assert.equal(body.protocolVersion, 3)
  assert.deepStrictEqual(Object.keys(body.payload as object).sort(), ['cookies', 'domain'])
})

// ── N8:体积上限 ──────────────────────────────────────────────────────────

test('N8 正常量级(登录站 10~20 条)→ 发,离 64KB 上限很远', () => {
  const input = buildCookieOfferRequest(PAIRING, DOMAIN, cookies(20, 64))
  assert.ok(input, '典型登录态必须发得出去')
  assert.ok(utf8ByteLength(input.body) < MAX_BODY_BYTES / 4, '典型量级该在上限的四分之一以内')
})

test('N8 ★ 超 64KB → 返回 null = 不发,**且不裁剪**(裁剪会得到「有 cookie 却仍被拒」这个最难诊断的形态)', () => {
  const huge = cookies(64, 2_048) // 约 128KB
  assert.equal(buildCookieOfferRequest(PAIRING, DOMAIN, huge), null)
})

test('N8 边界:恰好压线要发,多一字节就不发(与服务端按字节计的上限对齐)', () => {
  // 二分出「再多一个字符就超」的那个长度
  let low = 1
  let high = MAX_BODY_BYTES
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (buildCookieOfferRequest(PAIRING, DOMAIN, [one(mid)]) === null) high = mid - 1
    else low = mid
  }
  assert.ok(buildCookieOfferRequest(PAIRING, DOMAIN, [one(low)]), '压线那一份必须发得出去')
  assert.equal(buildCookieOfferRequest(PAIRING, DOMAIN, [one(low + 1)]), null, '多一字节就不发')
})

test('N8 量的是 UTF-8 字节不是字符串长度 —— 非 ASCII 值一个能占 3 字节', () => {
  // 值全是三字节字符:按 `length` 量会判成没超,按字节量必超
  const value = '啊'.repeat(30_000)
  const body = JSON.stringify(value)
  assert.ok(body.length < MAX_BODY_BYTES, '按字符数量它没超')
  assert.ok(utf8ByteLength(body) > MAX_BODY_BYTES, '按字节量它超了')
  assert.equal(buildCookieOfferRequest(PAIRING, DOMAIN, [one(0, value)]), null)
})

function one(valueLength: number, value?: string): OfferedCookie {
  return {
    name: 'c',
    value: value ?? 'x'.repeat(valueLength),
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true
  }
}

// ── 应答判定 ──────────────────────────────────────────────────────────────

test('isCookieAcceptedResponse: 只有 200 + ok + 同版本 + accepted===true 才算收下', () => {
  assert.equal(isCookieAcceptedResponse(200, okText(true)), true)
  assert.equal(isCookieAcceptedResponse(200, okText(false)), false)
  assert.equal(isCookieAcceptedResponse(200, okText(true, 2)), false, '版本不等一律不认')
  assert.equal(
    isCookieAcceptedResponse(200, JSON.stringify({ ok: true, protocolVersion: 3, payload: { accepted: 'true' } })),
    false,
    '字符串 true 必须判 false'
  )
  assert.equal(isCookieAcceptedResponse(200, ''), false)
  assert.equal(isCookieAcceptedResponse(200, 'not json'), false)
  for (const status of [401, 409, 413, 500]) {
    assert.equal(isCookieAcceptedResponse(status, okText(true)), false, `${status} 不算收下`)
  }
})

// ── 编排三态 ──────────────────────────────────────────────────────────────

test('N8 ★ 超上限时 sendCookieOffer 回 too_large,且**连请求都不发**', async () => {
  const { adapter, posts } = makeAdapter({})
  const outcome = await sendCookieOffer(adapter, DOMAIN, cookies(64, 2_048))

  assert.equal(outcome, 'too_large')
  assert.deepStrictEqual(posts, [], '不发就是一个请求都不发')
})

test('明确收下才回 accepted —— 这是 popup 敢说「已附登录态」的唯一依据', async () => {
  const { adapter, posts } = makeAdapter({})
  assert.equal(await sendCookieOffer(adapter, DOMAIN, cookies(3)), 'accepted')
  assert.equal(posts.length, 1)
})

test('降级①:未配对 → failed,且连请求都不发(约定 L5,不用默认 token 打一枪)', async () => {
  const { adapter, posts } = makeAdapter({ paired: false })
  assert.equal(await sendCookieOffer(adapter, DOMAIN, cookies(3)), 'failed')
  assert.deepStrictEqual(posts, [])
})

test('降级②:超时 / 连不上(postJson 抛) → failed,不抛给调用方', async () => {
  const { adapter } = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))
  })
  assert.equal(await sendCookieOffer(adapter, DOMAIN, cookies(3)), 'failed')
})

test('降级③:拒绝 / 看不懂的应答 → failed(401 / 409 / 500 / 空体 / 非 JSON 全一样)', async () => {
  for (const result of [
    { status: 401, text: '' },
    { status: 409, text: JSON.stringify({ ok: false, reason: 'protocol_mismatch' }) },
    { status: 500, text: 'boom' },
    { status: 200, text: '' },
    { status: 200, text: okText(false) }
  ]) {
    const { adapter } = makeAdapter({ respond: (): Promise<PostJsonResult> => Promise.resolve(result) })
    assert.equal(
      await sendCookieOffer(adapter, DOMAIN, cookies(3)),
      'failed',
      `${result.status} / ${result.text.slice(0, 12)} 必须降级`
    )
  }
})

test('★ 一个字都不写 storage(约定 L1:暂借登录态连域名都不该在扩展侧留痕)', async () => {
  const { adapter, writes } = makeAdapter({})
  await sendCookieOffer(adapter, DOMAIN, cookies(3))
  assert.deepStrictEqual(writes, [])
})
