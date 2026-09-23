import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes, formatSpeed, formatPercent, formatDuration, formatDate } from './format'

test('formatBytes 各量级', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB')
})
test('formatSpeed 带 ↓ 与 /s', () => {
  assert.equal(formatSpeed(0), '0 B/s')
  assert.equal(formatSpeed(1024 * 1024), '1.0 MB/s')
})
test('formatPercent;total=0 → --', () => {
  assert.equal(formatPercent(0, 0), '--')
  assert.equal(formatPercent(50, 200), '25%')
  assert.equal(formatPercent(200, 200), '100%')
})
test('formatDuration mm:ss / h:mm:ss / 非法 → --', () => {
  assert.equal(formatDuration(null), '--')
  assert.equal(formatDuration(-5), '--')
  assert.equal(formatDuration(5), '0:05')
  assert.equal(formatDuration(215), '3:35')
  assert.equal(formatDuration(3661), '1:01:01')
})
test('formatDate YYYY-MM-DD HH:mm / null / 非法 → -- / 补零', () => {
  assert.equal(formatDate(null), '--')
  assert.equal(formatDate(NaN), '--')
  assert.equal(formatDate(Infinity), '--')
  // 用本地时间构造 Date 再取 getTime()，与 formatDate 读本地字段一致，避免时区漂移；覆盖补零(月/日/时/分)
  assert.equal(formatDate(new Date(2026, 0, 3, 4, 5).getTime()), '2026-01-03 04:05')
  assert.equal(formatDate(new Date(2026, 11, 31, 23, 9).getTime()), '2026-12-31 23:09')
})
