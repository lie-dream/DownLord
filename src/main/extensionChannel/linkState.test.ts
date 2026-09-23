import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deriveLinkState, LINK_CONNECTED_WINDOW_MS } from './linkState'

/** 扩展三态推导单测(v0.4 Task 3 · spec §5.3 / §7.1) */

test('lastActiveAt 为 null → unpaired(只声称我们真知道的那件事:本次启动没收到握手)', () => {
  assert.equal(deriveLinkState({ lastActiveAt: null, now: 1_000_000 }), 'unpaired')
})

test('窗口内 → connected', () => {
  const now = 1_000_000
  assert.equal(deriveLinkState({ lastActiveAt: now, now }), 'connected')
  assert.equal(deriveLinkState({ lastActiveAt: now - 1, now }), 'connected')
  assert.equal(
    deriveLinkState({ lastActiveAt: now - LINK_CONNECTED_WINDOW_MS, now }),
    'connected',
    '恰好等于窗口边界仍算已连接'
  )
})

test('超窗口 → idle_pending(对外文案「待活动」,**绝不写「断开」**)', () => {
  const now = 1_000_000
  assert.equal(
    deriveLinkState({ lastActiveAt: now - LINK_CONNECTED_WINDOW_MS - 1, now }),
    'idle_pending'
  )
})

test('时钟回拨(now < lastActiveAt)→ connected 且不抛', () => {
  const lastActiveAt = 2_000_000
  assert.doesNotThrow(() => deriveLinkState({ lastActiveAt, now: 1_000 }))
  assert.equal(
    deriveLinkState({ lastActiveAt, now: 1_000 }),
    'connected',
    '刚握过手,没有任何理由把它说成「久无活动」'
  )
})

test('windowMs 可注入(测试用短窗口)', () => {
  assert.equal(deriveLinkState({ lastActiveAt: 0, now: 50, windowMs: 100 }), 'connected')
  assert.equal(deriveLinkState({ lastActiveAt: 0, now: 101, windowMs: 100 }), 'idle_pending')
})
