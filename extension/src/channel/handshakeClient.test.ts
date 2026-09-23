/**
 * 握手编排单测(v0.4 Task 3 · spec §6.3)。
 *
 * 注入 fake `storage` + fake `net`,断言三件最要紧的事:
 * ① **未配对就什么都不做**(不试探、不用默认 token 打一枪);
 * ② 成功 / 失败都把结果落 storage(L1);
 * ③ `net` 抛错归为 `unreachable`(客户端侧判定)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter, PostJsonInput, PostJsonResult } from '../adapter/browserAdapter'
import { PROTOCOL_VERSION, TOKEN_HEADER } from './protocol'
import {
  LAST_HANDSHAKE_KEY,
  PAIRING_KEY,
  readPairing,
  runHandshake,
  savePairing,
  type LastHandshake
} from './handshakeClient'

const TOKEN = 'abcdef0123456789'.repeat(4)

interface Harness {
  adapter: BrowserAdapter
  store: Map<string, unknown>
  sent: PostJsonInput[]
}

function makeHarness(
  options: {
    response?: PostJsonResult
    failure?: Error
    seed?: [string, unknown][]
  } = {}
): Harness {
  const store = new Map<string, unknown>(options.seed ?? [])
  const sent: PostJsonInput[] = []

  const adapter: BrowserAdapter = {
    storage: {
      get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(store.has(key) ? (store.get(key) as T) : undefined)
      },
      set(key: string, value: unknown): Promise<void> {
        store.set(key, value)
        return Promise.resolve()
      },
      remove(key: string): Promise<void> {
        store.delete(key)
        return Promise.resolve()
      },
      onChanged: (): void => {}
    },
    runtime: {
      getVersion: (): string => '0.3.0',
      getId: (): string => 'test-id',
      onInstalled: (): void => {},
      onStartup: (): void => {},
      onMessage: (): void => {},
      sendMessage: (): Promise<unknown> => Promise.resolve(undefined),
      getUserAgent: (): string => 'UA/1.0'
    },
    net: {
      postJson(input: PostJsonInput): Promise<PostJsonResult> {
        sent.push(input)
        if (options.failure) return Promise.reject(options.failure)
        return Promise.resolve(options.response ?? { status: 200, text: '{}' })
      }
    },
    // 本文件测握手,与接管无关 —— 占位实现,调到即视为出错
    downloads: {
      onCreated: (): void => {},
      cancel: (): Promise<void> => Promise.reject(new Error('本文件不该取消下载')),
      eraseCanceled: (): Promise<void> => Promise.reject(new Error('本文件不该抹下载记录'))
    },
    // v0.4 Task 5 的三块同理 —— 与握手无关,调到即视为出错
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

  return { adapter, store, sent }
}

function okBody(appVersion: string): string {
  return JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, payload: { appVersion } })
}

test('runHandshake: ★ 未配对 → 不发请求、不写 storage、返回 undefined(约定 L5 + 不试探)', async () => {
  const harness = makeHarness()

  assert.equal(await runHandshake(harness.adapter), undefined)
  assert.deepEqual(harness.sent, [], '未配对时一个请求都不许发')
  assert.deepEqual([...harness.store.keys()], [], '未配对时一个字节都不许写')
})

test('runHandshake: 已配对 → 发一次请求,token 在头里、端口来自配对', async () => {
  const harness = makeHarness({
    seed: [[PAIRING_KEY, { token: TOKEN, port: 52341 }]],
    response: { status: 200, text: okBody('0.3.0') }
  })

  const result = await runHandshake(harness.adapter, () => 1_700_000_000_000)

  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0]?.url, 'http://127.0.0.1:52341/channel')
  assert.equal(harness.sent[0]?.headers[TOKEN_HEADER], TOKEN)
  assert.deepEqual(result, { at: 1_700_000_000_000, reason: 'ok', appVersion: '0.3.0' })
})

test('runHandshake: 结果落 storage(L1)—— 下次冷启动 popup 还看得到', async () => {
  const harness = makeHarness({
    seed: [[PAIRING_KEY, { token: TOKEN, port: 52330 }]],
    response: { status: 401, text: '{"ok":false,"reason":"unauthorized"}' }
  })

  await runHandshake(harness.adapter, () => 42)

  assert.deepEqual(harness.store.get(LAST_HANDSHAKE_KEY), { at: 42, reason: 'unauthorized' })
})

test("runHandshake: net 抛错(ECONNREFUSED / 超时 / 中止)→ 'unreachable',且照样落 storage", async () => {
  const harness = makeHarness({
    seed: [[PAIRING_KEY, { token: TOKEN, port: 52330 }]],
    failure: new Error('Failed to fetch')
  })

  const result = await runHandshake(harness.adapter, () => 7)

  assert.deepEqual(result, { at: 7, reason: 'unreachable' })
  assert.deepEqual(harness.store.get(LAST_HANDSHAKE_KEY), { at: 7, reason: 'unreachable' })
})

test('runHandshake: 每次都实时读配对 —— 换了 token 立刻用新的(不缓存在内存里)', async () => {
  const harness = makeHarness({
    seed: [[PAIRING_KEY, { token: TOKEN, port: 52330 }]],
    response: { status: 200, text: okBody('0.3.0') }
  })

  await runHandshake(harness.adapter)
  harness.store.set(PAIRING_KEY, { token: 'f'.repeat(64), port: 52331 })
  await runHandshake(harness.adapter)

  assert.equal(harness.sent[0]?.headers[TOKEN_HEADER], TOKEN)
  assert.equal(harness.sent[1]?.headers[TOKEN_HEADER], 'f'.repeat(64))
  assert.equal(harness.sent[1]?.url, 'http://127.0.0.1:52331/channel')
})

// ── 读写配对 ───────────────────────────────────────────────────────────────

test('readPairing: storage 里躺着脏值(缺字段 / 类型不对)一律当未配对,不崩', async () => {
  const dirty: unknown[] = [
    null,
    'a string',
    {},
    { token: TOKEN },
    { port: 52330 },
    { token: '', port: 52330 },
    { token: TOKEN, port: '52330' },
    { token: TOKEN, port: 52330.5 }
  ]

  for (const value of dirty) {
    const harness = makeHarness({ seed: [[PAIRING_KEY, value]] })
    assert.equal(await readPairing(harness.adapter), undefined, JSON.stringify(value))
    // 未配对 → 同样不发请求
    assert.equal(await runHandshake(harness.adapter), undefined)
    assert.deepEqual(harness.sent, [])
  }
})

test('savePairing: 只写 token / port 两个字段(存什么就会被读回来)', async () => {
  const harness = makeHarness()

  await savePairing(harness.adapter, { token: TOKEN, port: 52330 })

  assert.deepEqual(harness.store.get(PAIRING_KEY), { token: TOKEN, port: 52330 })
  assert.deepEqual(await readPairing(harness.adapter), { token: TOKEN, port: 52330 })
})

test('LastHandshake 的两个 key 是常量,popup 与 sw 读写同一处,不靠字符串手抄', () => {
  assert.equal(PAIRING_KEY, 'downlord:pairing')
  assert.equal(LAST_HANDSHAKE_KEY, 'downlord:lastHandshake')

  const record: LastHandshake = { at: 1, reason: 'ok' }
  assert.equal(record.reason, 'ok')
})
