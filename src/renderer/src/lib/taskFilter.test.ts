import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterTasksByNav, countByNav } from './taskFilter'
import type { Task } from '../../../shared/ipc'

const mk = (id: string, status: Task['status']): Task => ({
  id,
  kind: 'http',
  source: 'http://x/' + id,
  status,
  filename: id,
  savePath: 'C:/' + id,
  category: null,
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
const tasks = [
  mk('a', 'downloading'),
  mk('b', 'queued'),
  mk('c', 'paused'),
  mk('d', 'completed'),
  mk('e', 'error')
]

test('active 含 downloading/queued/paused', () => {
  assert.deepEqual(
    filterTasksByNav(tasks, 'active').map((t) => t.id),
    ['a', 'b', 'c']
  )
})
test('completed / failed / all', () => {
  assert.deepEqual(
    filterTasksByNav(tasks, 'completed').map((t) => t.id),
    ['d']
  )
  assert.deepEqual(
    filterTasksByNav(tasks, 'failed').map((t) => t.id),
    ['e']
  )
  assert.equal(filterTasksByNav(tasks, 'all').length, 5)
})
test('countByNav', () => {
  assert.deepEqual(countByNav(tasks), { all: 5, active: 3, completed: 1, failed: 1, torrent: 0 })
})

// v0.3 Task 3 — BT 入口:filterTasksByNav('torrent') 过滤 kind==='torrent',与状态正交(不受 status 影响)
const mkT = (id: string, status: Task['status']): Task => ({ ...mk(id, status), kind: 'torrent' })
test("nav 'torrent' 过滤 kind==='torrent'(跨状态)", () => {
  const list = [
    mk('a', 'downloading'),
    mkT('t1', 'downloading'),
    mkT('t2', 'completed'),
    mk('b', 'completed')
  ]
  assert.deepEqual(
    filterTasksByNav(list, 'torrent').map((t) => t.id),
    ['t1', 't2']
  )
})
test('countByNav.torrent 计数 torrent 任务', () => {
  const list = [mk('a', 'downloading'), mkT('t1', 'downloading'), mkT('t2', 'error')]
  assert.equal(countByNav(list).torrent, 2)
})
test('BT 落状态维:torrent nav 结果不因 http/video 混入而变(正交前提)', () => {
  // torrent nav 只看 kind,与类别 / 视频态无关;categoryFilter 由 App 层再叠加(此处仅证 nav 维纯粹)
  const list = [
    mkT('t1', 'downloading'),
    { ...mk('v', 'downloading'), kind: 'video' as const },
    mkT('t2', 'paused')
  ]
  assert.deepEqual(
    filterTasksByNav(list, 'torrent').map((t) => t.id),
    ['t1', 't2']
  )
})
