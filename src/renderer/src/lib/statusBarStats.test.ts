import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusBarStats } from './statusBarStats'
import type { Task } from '../../../shared/ipc'
const mk = (status: Task['status'], speed = 0, over: Partial<Task> = {}): Task => ({
  id: Math.random().toString(),
  kind: 'http',
  source: 'x',
  status,
  filename: 'f',
  savePath: 'p',
  category: null,
  totalBytes: 0,
  downloadedBytes: 0,
  speed,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  ...over
})
test('速度仅累加 downloading;活动/排队计数', () => {
  const s = statusBarStats([
    mk('downloading', 100),
    mk('downloading', 50),
    mk('queued'),
    mk('paused', 999)
  ])
  assert.deepEqual(s, { totalSpeed: 150, activeCount: 2, queuedCount: 1, totalUpload: 0 })
})
// v0.3 Task 3 — totalUpload 聚合 uploadSpeed(做种 / 上传);无上传 → 0
test('totalUpload 累加各任务 uploadSpeed(做种中 completed 也计入)', () => {
  const s = statusBarStats([
    mk('completed', 0, { kind: 'torrent', seeding: true, uploadSpeed: 300 }),
    mk('completed', 0, { kind: 'torrent', seeding: true, uploadSpeed: 200 }),
    mk('downloading', 100) // 无 uploadSpeed → 不计上行
  ])
  assert.equal(s.totalUpload, 500)
  assert.equal(s.totalSpeed, 100)
})
