/**
 * 嗅探转交客户端单测(v0.4 Task 5 Phase 2 · spec §4.1)。
 *
 * 注入 fake adapter:不起服务、不碰真 `chrome`。断言的核心有两句 ——
 * **① 协议载荷里刻意没有的字段一个都不许出现;② 任何看不懂的应答一律降级为「没送出去」。**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter, PostJsonInput, PostJsonResult } from '../adapter/browserAdapter'
import { PAIRING_KEY } from '../channel/handshakeClient'
import { TOKEN_HEADER } from '../channel/protocol'
import { buildSniffRequest, isSniffTakenResponse, sendSniffSelected } from './sniffClient'

const TOKEN = 'a'.repeat(64)
const PAIRING = { token: TOKEN, port: 52330 }

const SELECTION = {
  url: 'https://cdn.example/av1-sample.m3u8?4582',
  contentType: 'application/x-mpegurl',
  initiator: 'https://page.example',
  totalBytes: -1
}

function okText(taken: boolean, protocolVersion = 3): string {
  return JSON.stringify({ ok: true, protocolVersion, payload: { taken } })
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
    cookies: { getAll: reject('读 cookie') }
  }

  return { adapter, posts, writes }
}

function bodyOf(input: PostJsonInput): Record<string, unknown> {
  return JSON.parse(input.body) as Record<string, unknown>
}

// ── 请求形状 ──────────────────────────────────────────────────────────────

test('buildSniffRequest: 只打回环 + token 走请求头 + 信封 type / 版本正确', () => {
  const input = buildSniffRequest(PAIRING, {
    url: SELECTION.url,
    contentType: SELECTION.contentType,
    referrer: SELECTION.initiator,
    userAgent: 'UA/1.0',
    totalBytes: -1
  })

  // **不是** localhost —— 后者可能解析到 ::1 而服务只绑了 127.0.0.1
  assert.equal(input.url, 'http://127.0.0.1:52330/channel')
  assert.equal(input.headers[TOKEN_HEADER], TOKEN)
  const body = bodyOf(input)
  assert.equal(body.type, 'sniff.addSelected')
  assert.equal(body.protocolVersion, 3)
})

test('★ 载荷恰好五个字段 —— **没有 kind / dir / filename / header map / tabId**', async () => {
  const fake = makeAdapter({})
  await sendSniffSelected(fake.adapter, SELECTION)

  const payload = bodyOf(fake.posts[0]).payload as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), [
    'contentType',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
  // kind 是**决策**(归主进程 classifySniffed);tabId 不传即不可能被记录
  for (const forbidden of ['kind', 'dir', 'filename', 'headers', 'tabId']) {
    assert.equal(forbidden in payload, false, `载荷里不该有 ${forbidden}`)
  }
})

test('referrer 取采集时的 initiator(origin 级),UA 经适配层注入', async () => {
  const fake = makeAdapter({})
  await sendSniffSelected(fake.adapter, SELECTION)

  const payload = bodyOf(fake.posts[0]).payload as Record<string, unknown>
  assert.equal(payload.referrer, 'https://page.example')
  // origin 级本身就是「不记 referrer 完整值」的保证 —— 没有路径、没有 query
  assert.equal(/https:\/\/[^/]+$/.test(String(payload.referrer)), true)
  assert.equal(payload.userAgent, 'UA/1.0')
})

test('大小未知 → totalBytes 原样传 -1(仅供确认框显示,不参与任何决策)', async () => {
  const fake = makeAdapter({})
  await sendSniffSelected(fake.adapter, SELECTION)

  assert.equal((bodyOf(fake.posts[0]).payload as Record<string, unknown>).totalBytes, -1)
})

test('★ 一次只发一条,且**一个字都不写 storage**(约定 L1)', async () => {
  const fake = makeAdapter({})
  await sendSniffSelected(fake.adapter, SELECTION)

  assert.equal(fake.posts.length, 1)
  assert.deepEqual(fake.writes, [])
})

// ── 应答判定 ──────────────────────────────────────────────────────────────

test('isSniffTakenResponse: 只有 200 + ok + 同版本 + taken===true 才算受理', () => {
  assert.equal(isSniffTakenResponse(200, okText(true)), true)
  assert.equal(isSniffTakenResponse(200, okText(false)), false)
  // `taken: 'true'`(字符串)必须判 false
  assert.equal(
    isSniffTakenResponse(200, JSON.stringify({ ok: true, protocolVersion: 3, payload: { taken: 'true' } })),
    false
  )
  // ⚠️ 这个 `4` 是**刻意与当期版本不同**的值,不是「下一个版本」——
  //    Task 6 把协议 bump 到 3 之后,原来写的 `3` 会变成「同版本」而让本断言恒红。
  assert.equal(isSniffTakenResponse(200, okText(true, 4)), false, '版本不等一律不认')
  assert.equal(isSniffTakenResponse(409, okText(true)), false)
  assert.equal(isSniffTakenResponse(200, '这不是 JSON'), false)
  assert.equal(isSniffTakenResponse(200, ''), false)
})

// ── 三条降级路径:一律「没送出去」,绝不假装成功 ─────────────────────────────

test('降级①:未配对 → false,且**连请求都不发**(约定 L5,不试探、不用默认 token 打一枪)', async () => {
  const fake = makeAdapter({ paired: false })

  assert.equal(await sendSniffSelected(fake.adapter, SELECTION), false)
  assert.deepEqual(fake.posts, [])
})

test('降级②:超时 / 连不上(postJson 抛) → false,不抛给调用方', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))
  })

  assert.equal(await sendSniffSelected(fake.adapter, SELECTION), false)
})

test('降级③:拒绝 / 看不懂的应答 → false(401 / 409 / 500 / 空体 / 非 JSON 全一样)', async () => {
  for (const reply of [
    { status: 401, text: JSON.stringify({ ok: false, reason: 'unauthorized' }) },
    { status: 409, text: JSON.stringify({ ok: false, reason: 'protocol_mismatch' }) },
    { status: 500, text: '' },
    { status: 200, text: '<html>别的程序占了这个端口</html>' },
    { status: 200, text: okText(false) }
  ]) {
    const fake = makeAdapter({ respond: (): Promise<PostJsonResult> => Promise.resolve(reply) })
    assert.equal(
      await sendSniffSelected(fake.adapter, SELECTION),
      false,
      `status=${reply.status} 不该被当成受理`
    )
  }
})

test('★ 明确受理才回 true —— 这是 UI 敢说「已发送」的唯一依据', async () => {
  const fake = makeAdapter({})

  assert.equal(await sendSniffSelected(fake.adapter, SELECTION), true)
})
