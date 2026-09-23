import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createFailureWindow,
  FAILURE_MAX_FAILURES,
  FAILURE_WINDOW_MS
} from './failureWindow'
import { authorizeRequest, type AuthInput } from './channelAuth'

/** 失败窗口限速单测(v0.4 Task 3 · spec §3.4 / §7.1) */

test('窗口内累计:第 20 次失败后触发(第 21 个失败请求会拿到 429)', () => {
  const w = createFailureWindow()
  for (let i = 0; i < FAILURE_MAX_FAILURES - 1; i += 1) {
    w.record(1_000 + i)
    assert.equal(w.isTripped(1_000 + i), false, `第 ${i + 1} 次失败后不应触发`)
  }
  w.record(1_100)
  assert.equal(w.isTripped(1_100), true, `累计 ${FAILURE_MAX_FAILURES} 次即触发`)
})

test('窗口滑过 → 重置', () => {
  const w = createFailureWindow()
  for (let i = 0; i < FAILURE_MAX_FAILURES; i += 1) w.record(1_000)
  assert.equal(w.isTripped(1_000), true)
  assert.equal(w.isTripped(1_000 + FAILURE_WINDOW_MS), false, '整窗滑过后旧记录全部淘汰')
  assert.equal(w.size(1_000 + FAILURE_WINDOW_MS), 0)
})

test('滑动而非固定分桶:窗口边缘的记录逐个淘汰', () => {
  const w = createFailureWindow({ windowMs: 100, maxFailures: 3 })
  w.record(0)
  w.record(50)
  w.record(90)
  assert.equal(w.isTripped(90), true)
  // t=101 时 t=0 那条滑出 → 只剩 2 条 → 不再触发
  assert.equal(w.isTripped(101), false)
  assert.equal(w.size(101), 2)
})

test('reset():停服务时清空,不跨启停累计', () => {
  const w = createFailureWindow({ windowMs: 100, maxFailures: 2 })
  w.record(0)
  w.record(1)
  assert.equal(w.isTripped(1), true)
  w.reset()
  assert.equal(w.isTripped(1), false)
})

test('时钟回拨不永久卡住:now 变小时旧记录仍按差值判定', () => {
  const w = createFailureWindow({ windowMs: 100, maxFailures: 1 })
  w.record(10_000)
  assert.equal(w.isTripped(10_000), true)
  // 系统对时回拨到更早的时刻:差值为负 → 记录保留(不抛、不崩)
  assert.doesNotThrow(() => w.isTripped(5_000))
})

test('★ 触发期间正确 token 仍放行(§3.4 的核心取舍,必须有断言)', () => {
  const TOKEN = 'c'.repeat(64)
  const w = createFailureWindow({ windowMs: 60_000, maxFailures: 3 })
  const now = 1_000

  const bad: AuthInput = {
    method: 'POST',
    path: '/channel',
    headers: { 'x-downlord-token': 'wrong', origin: 'chrome-extension://x' },
    contentLength: 10
  }
  const good: AuthInput = {
    ...bad,
    headers: { 'x-downlord-token': TOKEN, origin: 'chrome-extension://x' }
  }
  const config = { token: TOKEN, isTripped: (): boolean => w.isTripped(now) }

  // 刷失败直到触发
  for (let i = 0; i < 3; i += 1) {
    const d = authorizeRequest(bad, config)
    assert.equal(d.ok, false)
    w.record(now)
  }
  assert.equal(w.isTripped(now), true, '窗口应已触发')

  // ★ 本机任意程序靠刷失败**挡不住**合法扩展 —— 否则就是我们自制的拒绝服务
  assert.deepStrictEqual(authorizeRequest(good, config), { ok: true })
  // 而失败请求此时降级为 429
  const limited = authorizeRequest(bad, config)
  assert.equal(limited.ok === false && limited.status, 429)
})
