/**
 * 嗅探开关单测(v0.4 Task 5 Phase 1 · spec §2.1 / §2.5)。
 *
 * 守三件事:**默认关**、**关闭时把桶清干净**(「关闭 = 完全不监听」要在可观察行为上成立)、
 * **变更订阅只对自己那个键反应**(别的键一变就去读一次是白开销)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter } from '../adapter/browserAdapter'
import { SNIFF_KEY_PREFIX } from './sniffStore'
import {
  readSniffEnabled,
  setSniffEnabled,
  SNIFF_ENABLED_KEY,
  watchSniffEnabled
} from './sniffSwitch'

interface Fake {
  adapter: BrowserAdapter
  local: Map<string, unknown>
  session: Map<string, unknown>
  fireChanged: (keys: string[]) => void
}

interface FakeArea {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

function makeFake(seed: { local?: [string, unknown][]; session?: [string, unknown][] } = {}): Fake {
  const local = new Map<string, unknown>(seed.local ?? [])
  const session = new Map<string, unknown>(seed.session ?? [])
  const changedListeners: ((keys: string[]) => void)[] = []

  const area = (store: Map<string, unknown>): FakeArea => ({
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(store.get(key) as T | undefined)
    },
    set(key: string, value: unknown): Promise<void> {
      store.set(key, value)
      return Promise.resolve()
    },
    remove(key: string): Promise<void> {
      store.delete(key)
      return Promise.resolve()
    }
  })

  const unused = (): never => {
    throw new Error('本文件不该用到这个端口')
  }
  const adapter = {
    storage: {
      ...area(local),
      onChanged(listener: (keys: string[]) => void): void {
        changedListeners.push(listener)
      }
    },
    session: {
      ...area(session),
      keys(): Promise<string[]> {
        return Promise.resolve([...session.keys()])
      }
    },
    runtime: {
      getVersion: unused,
      getId: unused,
      onInstalled: unused,
      onStartup: unused,
      onMessage: unused,
      sendMessage: unused,
      getUserAgent: unused
    },
    net: { postJson: unused },
    downloads: { onCreated: unused, cancel: unused, eraseCanceled: unused },
    webRequest: { onHeadersReceived: unused },
    tabs: { queryActiveId: unused, reloadBypassingCache: unused, onRemoved: unused }
  } as unknown as BrowserAdapter

  return {
    adapter,
    local,
    session,
    fireChanged: (keys: string[]): void => {
      for (const listener of changedListeners) listener(keys)
    }
  }
}

test('默认关 —— 从未写过时读出来是 false', async () => {
  assert.equal(await readSniffEnabled(makeFake().adapter), false)
})

test('默认关 —— 读到任何非 true 的值也算关(不靠初始化,靠判据)', async () => {
  for (const stored of [undefined, null, 0, '', 'true', 1]) {
    const fake = makeFake({ local: [[SNIFF_ENABLED_KEY, stored]] })
    assert.equal(await readSniffEnabled(fake.adapter), false, `存 ${String(stored)} 时应判关`)
  }
})

test('开 → 读回 true,且不碰任何桶', async () => {
  const fake = makeFake({ session: [[`${SNIFF_KEY_PREFIX}3`, { items: [] }]] })

  await setSniffEnabled(fake.adapter, true)

  assert.equal(await readSniffEnabled(fake.adapter), true)
  assert.equal(fake.session.size, 1, '开启不该动已有的桶')
})

test('★ 关 → 清空全部 sniff:* 桶(「关闭 = 完全不监听」在可观察行为上成立)', async () => {
  const fake = makeFake({
    local: [[SNIFF_ENABLED_KEY, true]],
    session: [
      [`${SNIFF_KEY_PREFIX}1`, { items: [1] }],
      [`${SNIFF_KEY_PREFIX}2`, { items: [2] }],
      ['downlord:somethingElse', { keep: true }]
    ]
  })

  await setSniffEnabled(fake.adapter, false)

  assert.equal(await readSniffEnabled(fake.adapter), false)
  assert.equal(fake.session.has(`${SNIFF_KEY_PREFIX}1`), false)
  assert.equal(fake.session.has(`${SNIFF_KEY_PREFIX}2`), false)
  assert.deepEqual(fake.session.get('downlord:somethingElse'), { keep: true }, '别的键不该被误伤')
})

test('watchSniffEnabled: 只对自己那个键的变更反应', async () => {
  const fake = makeFake({ local: [[SNIFF_ENABLED_KEY, true]] })
  const seen: boolean[] = []
  watchSniffEnabled(fake.adapter, (enabled) => seen.push(enabled))

  fake.fireChanged(['downlord:pairing'])
  await Promise.resolve()
  assert.deepEqual(seen, [], '别的键变了不该触发读取')

  fake.fireChanged([SNIFF_ENABLED_KEY])
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, [true])
})

test('watchSniffEnabled: 读失败按「关」处理(宁可漏嗅,不可在用户没开时监听)', async () => {
  const fake = makeFake()
  const broken = {
    ...fake.adapter,
    storage: {
      ...fake.adapter.storage,
      get: (): Promise<never> => Promise.reject(new Error('storage 挂了'))
    }
  } as BrowserAdapter

  const seen: boolean[] = []
  watchSniffEnabled(broken, (enabled) => seen.push(enabled))
  fake.fireChanged([SNIFF_ENABLED_KEY])
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(seen, [false])
})
