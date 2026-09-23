/**
 * sw 生命周期单测(v0.4 Task 2 · spec §8.1)。
 *
 * 断言的是 §5.2 五条约定里可自动化的那部分:
 * - L5:`prev` 为 `undefined`(冷启动)不崩,从 1 起算;
 * - L1:`recordWake` 真的把状态写进 `adapter.storage`(而不是留在内存里)——
 *   用两个**独立的 adapter 实例共享同一份 store** 模拟「sw 被销毁后又被唤醒」,计数须继续增长。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter } from '../adapter/browserAdapter'
import { WAKE_STATE_KEY, nextWakeState, recordWake, type WakeState } from './lifecycle'

/** 只实现被用到的部分;`store` 由调用方传入,以便跨「实例」共享 = 模拟持久化 */
function makeAdapter(store: Map<string, unknown>): BrowserAdapter {
  return {
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
    // 本文件不发请求 —— 握手的编排由 `channel/handshakeClient.test.ts` 断言
    net: {
      postJson: (): Promise<{ status: number; text: string }> =>
        Promise.reject(new Error('stub net:本文件不该发请求'))
    },
    // 本文件测唤醒记账,与接管无关 —— 占位实现
    downloads: {
      onCreated: (): void => {},
      cancel: (): Promise<void> => Promise.reject(new Error('本文件不该取消下载')),
      eraseCanceled: (): Promise<void> => Promise.reject(new Error('本文件不该抹下载记录'))
    },
    // v0.4 Task 5 的三块同理 —— 与唤醒记账无关
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
}

test('nextWakeState: 冷启动(prev=undefined)从 1 起算,不崩(L5)', () => {
  assert.deepEqual(nextWakeState(undefined, 'install'), { count: 1, lastEvent: 'install' })
})

test('nextWakeState: 逐次 +1,lastEvent 取最新', () => {
  let state = nextWakeState(undefined, 'install')
  state = nextWakeState(state, 'startup')
  state = nextWakeState(state, 'update')

  assert.deepEqual(state, { count: 3, lastEvent: 'update' })
})

test("nextWakeState: 'message'(v0.4 Task 3 新增)与其它取值同权 —— 迁移逻辑不变,只是值域扩大", () => {
  // popup 打开会经 sendMessage 走到这里;#46 的 M4 判据(计数 +1 且 lastEvent 为 message)靠它成立
  assert.deepEqual(nextWakeState(undefined, 'message'), { count: 1, lastEvent: 'message' })
  assert.deepEqual(nextWakeState({ count: 4, lastEvent: 'startup' }, 'message'), {
    count: 5,
    lastEvent: 'message'
  })
  // 反过来也成立:message 之后再来别的事件,照常接着数
  assert.deepEqual(nextWakeState({ count: 5, lastEvent: 'message' }, 'startup'), {
    count: 6,
    lastEvent: 'startup'
  })
})

test('nextWakeState: 纯函数 —— 不改 prev,同输入恒同输出', () => {
  const prev: WakeState = { count: 7, lastEvent: 'startup' }
  const a = nextWakeState(prev, 'other')
  const b = nextWakeState(prev, 'other')

  assert.deepEqual(prev, { count: 7, lastEvent: 'startup' }, 'prev 未被就地修改')
  assert.deepEqual(a, b)
  assert.notEqual(a, b, '返回的是新对象而非同一引用')
})

test('nextWakeState: 脏 count(负数 / NaN / 小数 / 缺字段)按 0 重新起算,不传播脏值', () => {
  const dirty: WakeState[] = [
    { count: -5, lastEvent: 'install' },
    { count: Number.NaN, lastEvent: 'install' },
    { count: Number.POSITIVE_INFINITY, lastEvent: 'install' },
    { count: 0, lastEvent: 'install' }
  ]
  for (const prev of dirty) {
    assert.equal(nextWakeState(prev, 'startup').count, 1, `脏值 ${String(prev.count)} 应从 1 起算`)
  }
  assert.equal(nextWakeState({ count: 4.9, lastEvent: 'install' }, 'startup').count, 5)
  // storage 里躺着形状不对的旧值(比如手改过 / 早期版本写的)也不许崩
  assert.equal(nextWakeState({} as WakeState, 'startup').count, 1)
})

test('recordWake: 状态落 storage —— 跨「sw 实例」计数继续增长(L1)', async () => {
  const store = new Map<string, unknown>()

  // 第一次唤醒:全新的 sw 实例,storage 为空
  const first = await recordWake(makeAdapter(store), 'install')
  assert.deepEqual(first, { count: 1, lastEvent: 'install' })

  // sw 被销毁 → 内存全没了 → 换一个全新 adapter 实例,只有 store 还在(= 真落盘了)
  const second = await recordWake(makeAdapter(store), 'startup')
  assert.deepEqual(second, { count: 2, lastEvent: 'startup' })

  const third = await recordWake(makeAdapter(store), 'other')
  assert.deepEqual(third, { count: 3, lastEvent: 'other' })

  assert.deepEqual(store.get(WAKE_STATE_KEY), { count: 3, lastEvent: 'other' })
})

test('recordWake: 写回用的 key 与 popup 侧读的是同一个常量', async () => {
  const store = new Map<string, unknown>()
  await recordWake(makeAdapter(store), 'install')

  assert.deepEqual([...store.keys()], [WAKE_STATE_KEY])
})
