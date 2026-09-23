/**
 * popup 遥控器通道客户端单测(v0.4 Task 4 · spec §5.4 · plan 4.3)。
 *
 * 三个纯函数各守一件最容易「看起来对」的事:
 * - `buildGetConfigRequest` / `buildSetPauseRequest` —— 信封形状与 token 的去处;
 * - `classifyConfigResponse` —— **什么算拿到了一份合法快照**,以及**多余键一个都进不来**。
 *
 * 两支编排守两条约定:未配对不发请求(L5)、**全程零 storage 写入**(L1 的正向应用)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter, PostJsonInput, PostJsonResult } from '../adapter/browserAdapter'
import type { TakeoverConfigView } from '../contract'
import { PAIRING_KEY } from './handshakeClient'
import { CHANNEL_PATH, PROTOCOL_VERSION, TOKEN_HEADER } from './protocol'
import {
  buildGetConfigRequest,
  buildSetPauseRequest,
  classifyConfigResponse,
  fetchTakeoverConfig,
  setTakeoverPause
} from './takeoverConfigClient'

const TOKEN = '0123456789abcdef'.repeat(4)
const PAIRING = { token: TOKEN, port: 52330 }

/** 服务端合法应答的原文 */
function okText(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, payload })
}

interface FakeAdapter {
  adapter: BrowserAdapter
  calls: { posts: PostJsonInput[]; writes: string[] }
}

function makeAdapter(options: {
  paired?: boolean
  respond?: () => Promise<PostJsonResult>
}): FakeAdapter {
  const calls = { posts: [] as PostJsonInput[], writes: [] as string[] }
  const store = new Map<string, unknown>()
  if (options.paired !== false) store.set(PAIRING_KEY, PAIRING)

  const adapter: BrowserAdapter = {
    storage: {
      get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(store.get(key) as T | undefined)
      },
      set(key: string): Promise<void> {
        calls.writes.push(key)
        return Promise.resolve()
      },
      remove(key: string): Promise<void> {
        calls.writes.push(key)
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
        calls.posts.push(input)
        return (
          options.respond ??
          ((): Promise<PostJsonResult> =>
            Promise.resolve({
              status: 200,
              text: okText({ enabled: true, pausedUntil: null, paused: false })
            }))
        )()
      }
    },
    downloads: {
      onCreated: (): void => {},
      cancel: (): Promise<void> => Promise.resolve(),
      eraseCanceled: (): Promise<void> => Promise.resolve()
    },
    // v0.4 Task 5 的三块 —— 与接管遥控器无关,调到即视为出错
    session: {
      get: (): Promise<undefined> => Promise.reject(new Error('本文件不该读嗅探桶')),
      set: (): Promise<void> => Promise.reject(new Error('本文件不该写嗅探桶')),
      remove: (): Promise<void> => Promise.reject(new Error('本文件不该删嗅探桶')),
      keys: (): Promise<string[]> => Promise.reject(new Error('本文件不该枚举会话存储'))
    },
    webRequest: { onHeadersReceived: (): void => {} },
    tabs: {
      queryActiveId: (): Promise<number | undefined> =>
        Promise.reject(new Error('本文件不该读标签页')),
      queryActiveUrl: (): Promise<string | undefined> =>
        Promise.reject(new Error('本文件不该读标签页地址')),
      reloadBypassingCache: (): Promise<void> => Promise.reject(new Error('本文件不该刷新标签页')),
      onRemoved: (): void => {}
    },
    cookies: {
      getAll: (): Promise<never> => Promise.reject(new Error('本文件不该读 cookie'))
    }
  }

  return { adapter, calls }
}

// ── buildGetConfigRequest ─────────────────────────────────────────────

test('buildGetConfigRequest: 只打回环 + 单端点,端口来自配对', () => {
  const request = buildGetConfigRequest({ token: TOKEN, port: 52341 })

  assert.equal(request.url, `http://127.0.0.1:52341${CHANNEL_PATH}`)
  // 不用 localhost:它可能解析到 ::1,而服务只绑了 127.0.0.1
  assert.equal(request.url.includes('localhost'), false)
})

test('buildGetConfigRequest: token 走请求头,**绝不进 URL**(日志红线 §3.5)', () => {
  const request = buildGetConfigRequest(PAIRING)

  assert.equal(request.headers[TOKEN_HEADER], TOKEN)
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.url.includes(TOKEN), false, 'URL 会进各类记录,token 一个字都不许出现')
})

test('buildGetConfigRequest: 信封形状 —— 版本在顶层、payload 是空对象(这一支本就没有载荷)', () => {
  const request = buildGetConfigRequest(PAIRING)

  assert.deepStrictEqual(JSON.parse(request.body), {
    type: 'takeover.getConfig',
    protocolVersion: PROTOCOL_VERSION,
    payload: {}
  })
  assert.ok(request.timeoutMs > 0)
})

// ── buildSetPauseRequest ──────────────────────────────────────────────

test('buildSetPauseRequest: 三档逐个 —— payload 只有 minutes 一个键', () => {
  for (const minutes of [15, 60, 240]) {
    const request = buildSetPauseRequest(PAIRING, minutes)

    assert.deepStrictEqual(JSON.parse(request.body), {
      type: 'takeover.setPause',
      protocolVersion: PROTOCOL_VERSION,
      payload: { minutes }
    })
  }
})

test('buildSetPauseRequest: 「恢复接管」发 minutes:null,**不发绝对时刻**', () => {
  const body = JSON.parse(buildSetPauseRequest(PAIRING, null).body) as {
    payload: Record<string, unknown>
  }

  assert.deepStrictEqual(body.payload, { minutes: null })
  // 到期时刻由主进程用**它自己的时钟**算(`pausedUntilFrom`)。扩展这边算一遍必然对不齐,
  // 更要紧的是那等于把「暂停到什么时候」这个决策搬回扩展侧。
  assert.equal('pausedUntil' in body.payload, false)
})

// ── classifyConfigResponse ────────────────────────────────────────────

test('classifyConfigResponse: 合法应答 → 三键原样取回', () => {
  const view = classifyConfigResponse(
    200,
    okText({ enabled: true, pausedUntil: 1_754_270_000_000, paused: true })
  )

  assert.deepStrictEqual(view, {
    enabled: true,
    pausedUntil: 1_754_270_000_000,
    paused: true
  } satisfies TakeoverConfigView)
})

test('classifyConfigResponse: ★ 服务端多下发的键一个都进不来(域名例外表永不经通道)', () => {
  const view = classifyConfigResponse(
    200,
    okText({
      enabled: true,
      pausedUntil: null,
      paused: false,
      // 这两个都是设置页走 IPC 的 `TakeoverSettingsView` 才有的东西
      excludedDomains: ['secret.example.com'],
      token: 'should-never-arrive'
    })
  )

  // 逐字段重建(而不是整个 `as` 断言)的意义就在这里:**宽进**(多余键不至于让整份快照作废)、
  // **严取**(只取认识的三个)。改成 `return payload as TakeoverConfigView` → 这一条变红。
  assert.deepStrictEqual(view, { enabled: true, pausedUntil: null, paused: false })
})

test('classifyConfigResponse: pausedUntil 允许 null,但不接受非有限数', () => {
  assert.deepStrictEqual(
    classifyConfigResponse(200, okText({ enabled: true, pausedUntil: null, paused: false })),
    {
      enabled: true,
      pausedUntil: null,
      paused: false
    }
  )

  for (const bad of ['NaN', 'null-ish', '1754270000000']) {
    const text = `{"ok":true,"protocolVersion":${PROTOCOL_VERSION},"payload":{"enabled":true,"paused":false,"pausedUntil":"${bad}"}}`
    assert.equal(classifyConfigResponse(200, text), undefined, `字符串不是时刻:${bad}`)
  }
})

test('classifyConfigResponse: 拿不到就是拿不到 —— 逐条 undefined,**不编原因码**', () => {
  const cases: [string, number, string][] = [
    ['401 未授权', 401, '{"ok":false,"reason":"unauthorized"}'],
    ['409 版本不符', 409, '{"ok":false,"reason":"protocol_mismatch"}'],
    ['500', 500, ''],
    ['ok:false', 200, '{"ok":false,"reason":"unauthorized"}'],
    ['非 JSON(端口上是别的程序)', 200, 'hello'],
    ['空体', 200, ''],
    [
      '协议版本不一致',
      200,
      `{"ok":true,"protocolVersion":${PROTOCOL_VERSION + 1},"payload":{"enabled":true,"paused":false,"pausedUntil":null}}`
    ],
    ['payload 缺 paused', 200, okText({ enabled: true, pausedUntil: null })],
    ['payload 缺 enabled', 200, okText({ paused: false, pausedUntil: null })],
    ['enabled 类型不对', 200, okText({ enabled: 'yes', paused: false, pausedUntil: null })],
    ['payload 不是对象', 200, `{"ok":true,"protocolVersion":${PROTOCOL_VERSION},"payload":"x"}`]
  ]

  for (const [label, status, text] of cases) {
    // ⚠️ 这里**刻意不判四原因码**:「为什么没拿到」由 popup 上既有的握手结果行如实回答,
    //    在这条路上再判一次只会让两行各说各话。
    assert.equal(classifyConfigResponse(status, text), undefined, label)
  }
})

// ── 编排 ──────────────────────────────────────────────────────────────

test('fetchTakeoverConfig: 未配对 → 一个请求都不发(约定 L5:不试探、不用默认 token 打一枪)', async () => {
  const fake = makeAdapter({ paired: false })

  const view = await fetchTakeoverConfig(fake.adapter)

  assert.equal(view, undefined)
  assert.deepStrictEqual(fake.calls.posts, [])
})

test('fetchTakeoverConfig: 正常应答 → 拿到快照,且请求就是 buildGetConfigRequest 那一份', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> =>
      Promise.resolve({
        status: 200,
        text: okText({ enabled: false, pausedUntil: null, paused: false })
      })
  })

  const view = await fetchTakeoverConfig(fake.adapter)

  assert.deepStrictEqual(view, { enabled: false, pausedUntil: null, paused: false })
  assert.deepStrictEqual(fake.calls.posts, [buildGetConfigRequest(PAIRING)])
})

test('fetchTakeoverConfig: 连不上(postJson 抛错)→ undefined,**不是**「没暂停」', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))
  })

  // 兜成 `{enabled:true, paused:false}` 会让 popup 在 DownLord 没运行时显示「接管中」——
  // 那是一个**它无从知道**的结论。不知道就说不知道。
  assert.equal(await fetchTakeoverConfig(fake.adapter), undefined)
})

test('setTakeoverPause: 发出去的是三档那一份,回来的就是写后的快照(不再回读)', async () => {
  const written = { enabled: true, pausedUntil: 1_754_270_000_000, paused: true }
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(written) })
  })

  const view = await setTakeoverPause(fake.adapter, 60)

  assert.deepStrictEqual(view, written)
  assert.deepStrictEqual(fake.calls.posts, [buildSetPauseRequest(PAIRING, 60)])
})

test('setTakeoverPause: 未配对 → 不发请求(遥控器还没跟任何一台 DownLord 对上)', async () => {
  const fake = makeAdapter({ paired: false })

  assert.equal(await setTakeoverPause(fake.adapter, null), undefined)
  assert.deepStrictEqual(fake.calls.posts, [])
})

test('★ 两支编排全程零 storage 写入 —— 接管状态不落 popup(约定 L1 的正向应用)', async () => {
  const fake = makeAdapter({})

  await fetchTakeoverConfig(fake.adapter)
  await setTakeoverPause(fake.adapter, 15)
  await setTakeoverPause(fake.adapter, null)

  // 存下来就会被读回来,而本地通道**没有反向推送** —— 存的那一刻它就开始过期了。
  // 每次打开现问、问不到就说不知道,是这条路上唯一诚实的做法(CONTEXT.md「临时暂停接管」)。
  assert.deepStrictEqual(fake.calls.writes, [])
})
