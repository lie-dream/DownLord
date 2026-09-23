/**
 * 临时暂停接管的纯函数单测(U-05;v0.4 Task 4 · spec §7.1 · plan 4.1)。
 *
 * 全是纯函数:不起服务、不碰真实时钟 —— `now` 由用例直接传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTakeoverPaused, pausedUntilFrom, remainingMinutes } from './pauseState'

const NOW = 1_700_000_000_000
const MIN = 60_000

// ── U-05:暂停边界 ──────────────────────────────────────────────────────

test('U-05 pausedUntil 边界:null=false / now+1=true / 恰好 now=false(到期即解除)', () => {
  assert.equal(isTakeoverPaused(null, NOW), false)
  assert.equal(isTakeoverPaused(NOW + 1, NOW), true)
  // ★ 边界本体:恰好到期即解除,不留一个还得再等一毫秒的暂停
  assert.equal(isTakeoverPaused(NOW, NOW), false)
  assert.equal(isTakeoverPaused(NOW - 1, NOW), false)
})

test('U-05 过期不清零:同一个 pausedUntil,now 推进过去即恒 false(现算,零定时器)', () => {
  const until = NOW + 60 * MIN
  assert.equal(isTakeoverPaused(until, NOW), true)
  assert.equal(isTakeoverPaused(until, NOW + 59 * MIN), true)
  assert.equal(isTakeoverPaused(until, NOW + 61 * MIN), false)
})

// ── 时长档换算 ──────────────────────────────────────────────────────────

test('pausedUntilFrom:三档纯时间各自换算成绝对时刻', () => {
  assert.equal(pausedUntilFrom(15, NOW), NOW + 15 * MIN)
  assert.equal(pausedUntilFrom(60, NOW), NOW + 60 * MIN)
  assert.equal(pausedUntilFrom(240, NOW), NOW + 240 * MIN)
})

test('pausedUntilFrom:null = 恢复接管;非有限数 / 非正数同样回落 null(不存一个已过期的时刻)', () => {
  assert.equal(pausedUntilFrom(null, NOW), null)
  assert.equal(pausedUntilFrom(0, NOW), null)
  assert.equal(pausedUntilFrom(-30, NOW), null)
  assert.equal(pausedUntilFrom(Number.NaN, NOW), null)
  assert.equal(pausedUntilFrom(Number.POSITIVE_INFINITY, NOW), null)
})

// ── 剩余时长(显示用)────────────────────────────────────────────────────

test('remainingMinutes:向上取整(剩 30 秒显示 1 分钟,不显示 0);未暂停恒 0', () => {
  assert.equal(remainingMinutes(null, NOW), 0)
  assert.equal(remainingMinutes(NOW - 1, NOW), 0) // 已过期
  assert.equal(remainingMinutes(NOW + 30_000, NOW), 1) // 半分钟 → 1
  assert.equal(remainingMinutes(NOW + 42 * MIN, NOW), 42)
  assert.equal(remainingMinutes(NOW + 42 * MIN + 1, NOW), 43) // 多一毫秒即进位
})
