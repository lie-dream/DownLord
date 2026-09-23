import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterTasksByCategory } from './categoryFilter'
import { filterTasksByNav } from './taskFilter'
import type { Task } from '../../../shared/ipc'

const mk = (id: string, status: Task['status'], category: string | null): Task => ({
  id,
  kind: 'http',
  source: 'http://x/' + id,
  status,
  filename: id,
  savePath: 'C:/' + id,
  category,
  totalBytes: 100,
  downloadedBytes: 0,
  speed: 0,
  videoMeta: null,
  torrentMeta: null,
  error: status === 'error' ? '失败' : null,
  createdAt: 1,
  startedAt: null,
  completedAt: null
})

// 覆盖 状态 × 类别 两维:active(downloading/queued)/ completed,video / audio / null
const tasks = [
  mk('a', 'downloading', 'video'),
  mk('b', 'downloading', 'audio'),
  mk('c', 'completed', 'video'),
  mk('d', 'completed', 'audio'),
  mk('e', 'downloading', null),
  mk('f', 'queued', 'video')
]

test('all → 原样返回(含 category=null)', () => {
  assert.deepEqual(
    filterTasksByCategory(tasks, 'all').map((t) => t.id),
    ['a', 'b', 'c', 'd', 'e', 'f']
  )
})

test('具体类别 → 仅保留 task.category === key', () => {
  assert.deepEqual(
    filterTasksByCategory(tasks, 'video').map((t) => t.id),
    ['a', 'c', 'f']
  )
  assert.deepEqual(
    filterTasksByCategory(tasks, 'audio').map((t) => t.id),
    ['b', 'd']
  )
})

test('category === null 在具体类别下不显示(选 all 才显示)', () => {
  // 'e' 为 category=null:任一具体类别均不含;all 才含
  assert.equal(
    filterTasksByCategory(tasks, 'video').some((t) => t.id === 'e'),
    false
  )
  assert.equal(filterTasksByCategory(tasks, 'archive').length, 0)
  assert.equal(
    filterTasksByCategory(tasks, 'all').some((t) => t.id === 'e'),
    true
  )
})

test('状态 × 类别正交:下载中 ∩ 视频', () => {
  // active = downloading/queued/paused/...;再叠加 video → a(downloading) + f(queued)
  const r = filterTasksByCategory(filterTasksByNav(tasks, 'active'), 'video')
  assert.deepEqual(
    r.map((t) => t.id),
    ['a', 'f']
  )
})

test('状态 × 类别正交:已完成 ∩ 音频', () => {
  const r = filterTasksByCategory(filterTasksByNav(tasks, 'completed'), 'audio')
  assert.deepEqual(
    r.map((t) => t.id),
    ['d']
  )
})
