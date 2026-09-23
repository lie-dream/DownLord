/**
 * `offerCookiesFor` 编排单测(v0.4 Task 6 Phase 3 · spec §3.2)。
 *
 * 这里测的是**四步接得对不对**,以及最要紧的一句:
 * **没点名 / 点了没上报过的名 → `getAll` 一次都不会被调用**(红线 R10 与 spec §3.3 的形状)。
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
import { offerCookiesFor } from './cookieFlow'

const PAIRING = { token: 'a'.repeat(64), port: 52330 }
const PAGE = 'https://www.example.com/watch?v=abc'

function cookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'SESSDATA',
    value: 'v',
    domain: '.example.com',
    path: '/',
    expirationDate: 1_800_000_000,
    secure: true,
    httpOnly: true,
    ...overrides
  }
}

function okText(accepted: boolean): string {
  return JSON.stringify({ ok: true, protocolVersion: 3, payload: { accepted } })
}

function makeAdapter(options: {
  cookiesOf?: (url: string) => BrowserCookie[]
  getAllThrows?: boolean
  respond?: () => Promise<PostJsonResult>
}): {
  adapter: BrowserAdapter
  posts: PostJsonInput[]
  getAllUrls: string[]
} {
  const posts: PostJsonInput[] = []
  const getAllUrls: string[] = []
  const store = new Map<string, unknown>([[PAIRING_KEY, PAIRING]])
  const reject = (what: string) => (): Promise<never> =>
    Promise.reject(new Error(`本文件不该${what}`))

  const adapter: BrowserAdapter = {
    storage: {
      get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(store.get(key) as T | undefined)
      },
      set: (): Promise<void> => Promise.reject(new Error('本文件不该写 storage')),
      remove: (): Promise<void> => Promise.reject(new Error('本文件不该删 storage')),
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
    cookies: {
      getAll(input: { url: string }): Promise<BrowserCookie[]> {
        getAllUrls.push(input.url)
        if (options.getAllThrows === true) return Promise.reject(new Error('浏览器拒读'))
        return Promise.resolve(options.cookiesOf?.(input.url) ?? [cookie()])
      }
    }
  }

  return { adapter, posts, getAllUrls }
}

test('★ 没点名(应答里连 needCookieFor 这个键都没有)→ getAll 一次都不调、一个请求都不发', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({})
  const outcome = await offerCookiesFor(adapter, undefined, [PAGE])

  assert.deepStrictEqual(outcome, { accepted: [], tooLarge: false, droppedNames: 0 })
  assert.deepStrictEqual(getAllUrls, [], '「没选第四档 = 零外泄」在这条路径上的形状')
  assert.deepStrictEqual(posts, [])
})

test('空点名数组同样什么都不做', async () => {
  const { adapter, getAllUrls } = makeAdapter({})
  assert.deepStrictEqual(await offerCookiesFor(adapter, [], [PAGE]), {
    accepted: [],
    tooLarge: false,
    droppedNames: 0
  })
  assert.deepStrictEqual(getAllUrls, [])
})

test('★ 点名未上报的域 → getAll 根本不会被调用(伪造的 needCookieFor 在这里断掉)', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({})
  const outcome = await offerCookiesFor(adapter, ['bank.com'], [PAGE])

  assert.deepStrictEqual(getAllUrls, [], '这一句就是 spec §7.3 那半段论证')
  assert.deepStrictEqual(posts, [])
  assert.deepStrictEqual(outcome, { accepted: [], tooLarge: false, droppedNames: 1 })
})

test('命中:按候选 URL 取 cookie,按精确 host 提供,accepted 里是那个域', async () => {
  const { adapter, posts, getAllUrls } = makeAdapter({})
  const outcome = await offerCookiesFor(adapter, ['www.example.com'], [PAGE])

  assert.deepStrictEqual(getAllUrls, [PAGE], 'getAll 收到的是**候选 URL 原样**,不是拼出来的域')
  assert.equal(posts.length, 1)
  const body = JSON.parse(posts[0]?.body ?? '{}') as { type: string; payload: { domain: string } }
  assert.equal(body.type, 'cookie.offer')
  assert.equal(body.payload.domain, 'www.example.com', 'domain 必与点名项全等')
  assert.deepStrictEqual(outcome, {
    accepted: ['www.example.com'],
    tooLarge: false,
    droppedNames: 0
  })
})

test('丙路径两域:各取各的、逐个串行,accepted 顺序跟点名走', async () => {
  const url = 'https://cdn.example/seg.m3u8'
  const referrer = 'https://page.example'
  const { adapter, getAllUrls } = makeAdapter({})
  const outcome = await offerCookiesFor(adapter, ['page.example', 'cdn.example'], [url, referrer])

  assert.deepStrictEqual(getAllUrls, [referrer, url])
  assert.deepStrictEqual(outcome.accepted, ['page.example', 'cdn.example'])
})

test('★ 该域没有 cookie 时**照样发一份空的** —— 「已问过、无登录态」是 DownLord 该知道的事实', async () => {
  const { adapter, posts } = makeAdapter({ cookiesOf: (): BrowserCookie[] => [] })
  const outcome = await offerCookiesFor(adapter, ['www.example.com'], [PAGE])

  assert.equal(posts.length, 1)
  const body = JSON.parse(posts[0]?.body ?? '{}') as { payload: { cookies: unknown[] } }
  assert.deepStrictEqual(body.payload.cookies, [])
  assert.deepStrictEqual(outcome.accepted, ['www.example.com'])
})

test('getAll 抛(浏览器拒读)→ 静默降级,不抛给调用方,也不发请求', async () => {
  const { adapter, posts } = makeAdapter({ getAllThrows: true })
  const outcome = await offerCookiesFor(adapter, ['www.example.com'], [PAGE])

  assert.deepStrictEqual(outcome, { accepted: [], tooLarge: false, droppedNames: 0 })
  assert.deepStrictEqual(posts, [])
})

test('超 64KB → tooLarge,accepted 为空,且一个请求都不发(不裁剪)', async () => {
  const huge = Array.from({ length: 64 }, (_unused, index) =>
    cookie({ name: `c${index}`, value: 'x'.repeat(2_048) })
  )
  const { adapter, posts } = makeAdapter({ cookiesOf: (): BrowserCookie[] => huge })
  const outcome = await offerCookiesFor(adapter, ['www.example.com'], [PAGE])

  assert.deepStrictEqual(outcome, { accepted: [], tooLarge: true, droppedNames: 0 })
  assert.deepStrictEqual(posts, [])
})

test('通道拒收 → accepted 为空(绝不假装成功:那半句「已附登录态」就不该出现)', async () => {
  const { adapter } = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(false) })
  })
  const outcome = await offerCookiesFor(adapter, ['www.example.com'], [PAGE])
  assert.deepStrictEqual(outcome.accepted, [])
})

test('混合:点两个名只有一个上报过 → 采纳那一个,另一个只记进 droppedNames(不回报)', async () => {
  const { adapter, getAllUrls } = makeAdapter({})
  const outcome = await offerCookiesFor(adapter, ['bank.com', 'www.example.com'], [PAGE])

  assert.deepStrictEqual(getAllUrls, [PAGE])
  assert.deepStrictEqual(outcome, {
    accepted: ['www.example.com'],
    tooLarge: false,
    droppedNames: 1
  })
})
