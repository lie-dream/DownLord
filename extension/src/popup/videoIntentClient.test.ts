/**
 * `video.intent` 通道客户端单测(v0.4 Task 6 Phase 3 · spec §3.1)。
 *
 * 断言三句:**① 载荷恰好两个键;② 只有明确受理才算受理;③ 受理并点名后才走 cookie 那条路。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type {
  BrowserAdapter,
  BrowserCookie,
  PostJsonInput,
  PostJsonResult
} from '../adapter/browserAdapter'
import { PAIRING_KEY } from '../channel/handshakeClient'
import { TOKEN_HEADER } from '../channel/protocol'
import {
  buildVideoIntentRequest,
  classifyVideoIntentResponse,
  sendVideoIntent
} from './videoIntentClient'

const TOKEN = 'a'.repeat(64)
const PAIRING = { token: TOKEN, port: 52330 }
const PAGE = 'https://www.example.com/watch?v=abc'

function ackText(payload: unknown, protocolVersion = 3): string {
  return JSON.stringify({ ok: true, protocolVersion, payload })
}

function offerAck(): string {
  return JSON.stringify({ ok: true, protocolVersion: 3, payload: { accepted: true } })
}

function makeAdapter(options: {
  paired?: boolean
  userAgent?: string
  respond?: (input: PostJsonInput) => Promise<PostJsonResult>
}): { adapter: BrowserAdapter; posts: PostJsonInput[]; getAllUrls: string[]; writes: string[] } {
  const posts: PostJsonInput[] = []
  const getAllUrls: string[] = []
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
      getUserAgent: (): string => options.userAgent ?? 'UA/1.0'
    },
    net: {
      postJson(input: PostJsonInput): Promise<PostJsonResult> {
        posts.push(input)
        if (options.respond) return options.respond(input)
        return Promise.resolve({ status: 200, text: ackText({ taken: true }) })
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
      // ⚠️ 地址由**装配点**现取后传进来 —— 本文件不该自己去读标签页
      queryActiveId: reject('读标签页'),
      queryActiveUrl: reject('读标签页地址'),
      reloadBypassingCache: reject('刷新标签页'),
      onRemoved: (): void => {}
    },
    cookies: {
      getAll(input: { url: string }): Promise<BrowserCookie[]> {
        getAllUrls.push(input.url)
        return Promise.resolve([
          {
            name: 'SESSDATA',
            value: 'v',
            domain: '.example.com',
            path: '/',
            secure: true,
            httpOnly: true
          }
        ])
      }
    }
  }

  return { adapter, posts, getAllUrls, writes }
}

function bodyOf(input: PostJsonInput): Record<string, unknown> {
  return JSON.parse(input.body) as Record<string, unknown>
}

// ── 请求形状 ──────────────────────────────────────────────────────────────

test('buildVideoIntentRequest: 只打回环 + token 走请求头 + 信封 type / 版本正确', () => {
  const input = buildVideoIntentRequest(PAIRING, { pageUrl: PAGE })
  assert.equal(input.url, 'http://127.0.0.1:52330/channel')
  assert.equal(input.headers[TOKEN_HEADER], TOKEN)

  const body = bodyOf(input)
  assert.equal(body.type, 'video.intent')
  assert.equal(body.protocolVersion, 3)
})

test('★ 载荷恰好两个键 —— 没有 kind / referrer / dir / filename / header map', async () => {
  const { adapter, posts } = makeAdapter({})
  await sendVideoIntent(adapter, PAGE)

  const payload = bodyOf(posts[0] as PostJsonInput).payload as Record<string, unknown>
  assert.deepStrictEqual(Object.keys(payload).sort(), ['pageUrl', 'userAgent'])
  assert.equal(payload.pageUrl, PAGE)
  assert.equal(payload.userAgent, 'UA/1.0')
})

test('UA 拿不到就**不发这个键**(发空串会让主进程拿它覆盖默认 UA,比没有更糟)', async () => {
  const { adapter, posts } = makeAdapter({ userAgent: '' })
  await sendVideoIntent(adapter, PAGE)

  const payload = bodyOf(posts[0] as PostJsonInput).payload as Record<string, unknown>
  assert.deepStrictEqual(Object.keys(payload), ['pageUrl'])
})

// ── 应答判定 ──────────────────────────────────────────────────────────────

test('classifyVideoIntentResponse: 只有 200 + ok + 同版本 + taken===true 才算受理', () => {
  assert.deepStrictEqual(classifyVideoIntentResponse(200, ackText({ taken: true })), {
    taken: true,
    needCookieFor: undefined
  })
  for (const [status, text] of [
    [200, ackText({ taken: false })],
    [200, ackText({ taken: 'true' })],
    [200, ackText({ taken: true }, 2)],
    [200, ''],
    [200, 'not json'],
    [401, ackText({ taken: true })],
    [409, ackText({ taken: true })],
    [500, ackText({ taken: true })]
  ] as const) {
    assert.deepStrictEqual(
      classifyVideoIntentResponse(status, text),
      { taken: false, needCookieFor: undefined },
      `${status} / ${text.slice(0, 16)} 必须判没受理`
    )
  }
})

test('needCookieFor 不是「全是字符串的数组」就当没点名 —— 不半信半疑地照办一半', () => {
  for (const need of [42, 'www.example.com', [1, 2], ['ok', 3], null]) {
    assert.equal(
      classifyVideoIntentResponse(200, ackText({ taken: true, needCookieFor: need })).needCookieFor,
      undefined,
      `needCookieFor=${JSON.stringify(need)} 该当没点名`
    )
  }
  assert.deepStrictEqual(
    classifyVideoIntentResponse(200, ackText({ taken: true, needCookieFor: ['a.example'] }))
      .needCookieFor,
    ['a.example']
  )
})

// ── 编排 ──────────────────────────────────────────────────────────────────

test('★ 没点名 → 只有一个请求,cookie 那条路一步都不走', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({})
  const result = await sendVideoIntent(adapter, PAGE)

  assert.equal(result.taken, true)
  assert.deepStrictEqual(result.cookies, { accepted: [], tooLarge: false, droppedNames: 0 })
  assert.equal(posts.length, 1)
  assert.deepStrictEqual(getAllUrls, [])
})

test('★ 受理并点名了页面域 → 取该页 cookie 并提供,accepted 里是那个域', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({
    respond: (input: PostJsonInput): Promise<PostJsonResult> =>
      Promise.resolve(
        bodyOf(input).type === 'video.intent'
          ? { status: 200, text: ackText({ taken: true, needCookieFor: ['www.example.com'] }) }
          : { status: 200, text: offerAck() }
      )
  })
  const result = await sendVideoIntent(adapter, PAGE)

  assert.deepStrictEqual(getAllUrls, [PAGE], '候选只有 [pageUrl] 这一条')
  assert.deepStrictEqual(result.cookies.accepted, ['www.example.com'])
  assert.deepStrictEqual(
    posts.map((one) => bodyOf(one).type),
    ['video.intent', 'cookie.offer'],
    '先受理再提供,顺序不能倒'
  )
})

test('★ 点名了没上报过的域 → getAll 不被调用,也不发 offer(结构约束,不是策略)', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({
    respond: (): Promise<PostJsonResult> =>
      Promise.resolve({ status: 200, text: ackText({ taken: true, needCookieFor: ['bank.com'] }) })
  })
  const result = await sendVideoIntent(adapter, PAGE)

  assert.deepStrictEqual(getAllUrls, [])
  assert.equal(posts.length, 1)
  assert.deepStrictEqual(result.cookies.accepted, [])
})

test('★ 没受理 → 连 needCookieFor 都不读,cookie 一步不走', async () => {
  const { adapter, getAllUrls } = makeAdapter({
    respond: (): Promise<PostJsonResult> =>
      Promise.resolve({
        status: 200,
        text: ackText({ taken: false, needCookieFor: ['www.example.com'] })
      })
  })
  const result = await sendVideoIntent(adapter, PAGE)

  assert.equal(result.taken, false)
  assert.deepStrictEqual(getAllUrls, [])
})

test('降级:未配对 → 不发请求;超时 / 连不上 → taken:false,不抛给调用方', async () => {
  const unpaired = makeAdapter({ paired: false })
  assert.equal((await sendVideoIntent(unpaired.adapter, PAGE)).taken, false)
  assert.deepStrictEqual(unpaired.posts, [])

  const dead = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))
  })
  assert.equal((await sendVideoIntent(dead.adapter, PAGE)).taken, false)
})

test('★ 一个字都不写 storage(约定 L1)', async () => {
  const { adapter, writes } = makeAdapter({})
  await sendVideoIntent(adapter, PAGE)
  assert.deepStrictEqual(writes, [])
})
