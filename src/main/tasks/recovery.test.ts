import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Task } from '../../shared/ipc'
import { buildRecoveryPlan } from './recovery'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'http',
    source: 'https://example.test/file.bin',
    status: 'queued',
    filename: 'file.bin',
    savePath: 'D:\\Downloads\\file.bin',
    category: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1000,
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

test('buildRecoveryPlan submits downloading and queued tasks first while respecting maxConcurrent', () => {
  const tasks: Task[] = [
    makeTask({ id: 'downloading-3', status: 'downloading', createdAt: 3 }),
    makeTask({ id: 'paused-4', status: 'paused', createdAt: 4 }),
    makeTask({ id: 'queued-8', status: 'queued', createdAt: 8 }),
    makeTask({ id: 'downloading-1', status: 'downloading', createdAt: 1 }),
    makeTask({ id: 'queued-6', status: 'queued', createdAt: 6 }),
    makeTask({ id: 'paused-5', status: 'paused', createdAt: 5 }),
    makeTask({ id: 'queued-7', status: 'queued', createdAt: 7 }),
    makeTask({ id: 'downloading-2', status: 'downloading', createdAt: 2 }),
    makeTask({ id: 'queued-9', status: 'queued', createdAt: 9 }),
    makeTask({ id: 'queued-10', status: 'queued', createdAt: 10 })
  ]

  const plan = buildRecoveryPlan(tasks, 4)

  assert.deepEqual(
    plan.toSubmit.map((task) => task.id),
    ['downloading-1', 'downloading-2', 'downloading-3', 'queued-6']
  )
  assert.deepEqual(
    plan.toQueue.map((task) => task.id).sort(),
    ['paused-4', 'paused-5', 'queued-7', 'queued-8', 'queued-9', 'queued-10'].sort()
  )
})

test('buildRecoveryPlan ignores completed and error tasks during restart planning', () => {
  const tasks: Task[] = [
    makeTask({ id: 'completed', status: 'completed', createdAt: 1 }),
    makeTask({ id: 'error', status: 'error', createdAt: 2 }),
    makeTask({ id: 'queued', status: 'queued', createdAt: 3 })
  ]

  assert.deepEqual(
    buildRecoveryPlan(tasks, 2).toSubmit.map((task) => task.id),
    ['queued']
  )
  assert.deepEqual(buildRecoveryPlan(tasks, 2).toQueue, [])
  assert.deepEqual(buildRecoveryPlan(tasks, 2).toResolve, [], 'http 任务无 re-resolve')
})

test('buildRecoveryPlan routes video pre-download states (resolving / awaiting_selection) to toResolve (spec §4.4.5)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'resolving', kind: 'video', status: 'resolving', createdAt: 1 }),
    makeTask({ id: 'awaiting', kind: 'video', status: 'awaiting_selection', createdAt: 2 }),
    makeTask({ id: 'queued-http', status: 'queued', createdAt: 3 })
  ]

  const plan = buildRecoveryPlan(tasks, 3)

  assert.deepEqual(
    plan.toResolve.map((t) => t.id).sort(),
    ['awaiting', 'resolving'],
    'resolving / awaiting_selection → 重解析(formats 瞬时已丢)'
  )
  // 解析态不进 toSubmit / toQueue(不占下载槽,§4.6)
  assert.equal(
    plan.toSubmit.some((t) => t.id === 'resolving' || t.id === 'awaiting'),
    false
  )
  assert.equal(
    plan.toQueue.some((t) => t.id === 'resolving' || t.id === 'awaiting'),
    false
  )
  assert.deepEqual(
    plan.toSubmit.map((t) => t.id),
    ['queued-http'],
    'http queued 仍重提交'
  )
})

test('buildRecoveryPlan re-submits video downloading / processing (降回下载重提交,spec §4.4.5)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'dl-video', kind: 'video', status: 'downloading', createdAt: 1 }),
    makeTask({ id: 'proc-video', kind: 'video', status: 'processing', createdAt: 2 }),
    makeTask({ id: 'paused-video', kind: 'video', status: 'paused', createdAt: 3 })
  ]

  const plan = buildRecoveryPlan(tasks, 3)

  assert.deepEqual(
    plan.toSubmit.map((t) => t.id).sort(),
    ['dl-video', 'proc-video'],
    'downloading / processing(video)→ 重提交(yt-dlp .part 续传 / 重跑后处理)'
  )
  assert.deepEqual(
    plan.toQueue.map((t) => t.id),
    ['paused-video'],
    'paused 保持暂停语义'
  )
  assert.deepEqual(plan.toResolve, [], '已选定的视频任务不重解析')
})

test('buildRecoveryPlan respects maxConcurrent across submittable states (incl. processing)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'd1', kind: 'video', status: 'downloading', createdAt: 1 }),
    makeTask({ id: 'd2', status: 'downloading', createdAt: 2 }),
    makeTask({ id: 'p3', kind: 'video', status: 'processing', createdAt: 3 }),
    makeTask({ id: 'q4', status: 'queued', createdAt: 4 })
  ]

  const plan = buildRecoveryPlan(tasks, 2)

  // 按 createdAt 取前 2 个 submittable;其余 submittable 落 toQueue
  assert.deepEqual(
    plan.toSubmit.map((t) => t.id),
    ['d1', 'd2']
  )
  assert.deepEqual(plan.toQueue.map((t) => t.id).sort(), ['p3', 'q4'])
})

// ============ kind 感知(v0.3 Task 1 · spec §6.2:torrent resolving → re-submit 非 re-resolve)============

test('buildRecoveryPlan routes torrent resolving to toSubmit, NOT toResolve (v0.3 spec §6.2)', () => {
  const tasks: Task[] = [
    makeTask({
      id: 'bt-meta',
      kind: 'torrent',
      source: 'magnet:?xt=urn:btih:abc',
      status: 'resolving',
      createdAt: 1
    }),
    makeTask({ id: 'video-res', kind: 'video', status: 'resolving', createdAt: 2 })
  ]

  const plan = buildRecoveryPlan(tasks, 3)

  assert.deepEqual(
    plan.toSubmit.map((t) => t.id),
    ['bt-meta'],
    'torrent resolving(元数据未完成即退出)→ 重提交引擎续取元数据'
  )
  assert.deepEqual(
    plan.toResolve.map((t) => t.id),
    ['video-res'],
    'video resolving 原样 toResolve(triggerResolve 只服务 video)'
  )
  assert.equal(plan.toQueue.length, 0)
})

test('buildRecoveryPlan re-submits torrent downloading / queued like http;torrent resolving 不占 maxConcurrent 截断(§5.5)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'bt-dl', kind: 'torrent', status: 'downloading', createdAt: 1 }),
    makeTask({ id: 'http-dl', status: 'downloading', createdAt: 2 }),
    makeTask({ id: 'bt-q', kind: 'torrent', status: 'queued', createdAt: 3 }),
    makeTask({ id: 'bt-meta', kind: 'torrent', status: 'resolving', createdAt: 4 })
  ]

  const plan = buildRecoveryPlan(tasks, 2)

  // submittable(downloading/queued)截前 2;torrent resolving(元数据不占槽)恒重提
  assert.deepEqual(plan.toSubmit.map((t) => t.id).sort(), ['bt-dl', 'bt-meta', 'http-dl'].sort())
  assert.deepEqual(
    plan.toQueue.map((t) => t.id),
    ['bt-q'],
    '超并发的 torrent queued 照常排队'
  )
  assert.deepEqual(plan.toResolve, [], 'torrent 不进 toResolve')
})

// ============ v0.3 Task 2:torrent awaiting_selection 恢复分桶(spec §4.4:并入元数据重提桶,不占槽)============

test('buildRecoveryPlan:torrent awaiting_selection → toSubmit(元数据重提桶,不占槽不受 maxConcurrent 截断)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'bt-await', kind: 'torrent', status: 'awaiting_selection', createdAt: 1 }),
    makeTask({ id: 'bt-meta', kind: 'torrent', status: 'resolving', createdAt: 2 }),
    // 满额的 http downloading(占满 maxConcurrent=1)
    makeTask({ id: 'http-dl', status: 'downloading', createdAt: 3 })
  ]

  const plan = buildRecoveryPlan(tasks, 1)

  // awaiting_selection + resolving 两个 torrent 均并入元数据桶(不受 maxConcurrent=1 截断);http-dl 占 1 槽
  assert.deepEqual(
    plan.toSubmit.map((t) => t.id).sort(),
    ['bt-await', 'bt-meta', 'http-dl'].sort(),
    'torrent awaiting_selection / resolving 恒重提,不与 http 争槽'
  )
  assert.equal(
    plan.toResolve.some((t) => t.id === 'bt-await'),
    false,
    'torrent awaiting_selection 不进 toResolve(无 videoResolver)'
  )
  assert.equal(
    plan.toQueue.some((t) => t.id === 'bt-await'),
    false,
    'torrent awaiting_selection 不落 toQueue 兜底'
  )
})

test('buildRecoveryPlan:video awaiting_selection → toResolve;torrent awaiting_selection → toSubmit(kind 分流)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'v-await', kind: 'video', status: 'awaiting_selection', createdAt: 1 }),
    makeTask({ id: 'bt-await', kind: 'torrent', status: 'awaiting_selection', createdAt: 2 })
  ]

  const plan = buildRecoveryPlan(tasks, 3)

  assert.deepEqual(
    plan.toResolve.map((t) => t.id),
    ['v-await'],
    'video 待选 → 重解析(formats 瞬时已丢)'
  )
  assert.deepEqual(
    plan.toSubmit.map((t) => t.id),
    ['bt-await'],
    'torrent 待选 → 重提引擎(start() 先归位 resolving)'
  )
})

test('buildRecoveryPlan:torrent paused 仍 toQueue(保持暂停,同 Task 1)', () => {
  const tasks: Task[] = [
    makeTask({ id: 'bt-paused', kind: 'torrent', status: 'paused', createdAt: 1 })
  ]
  const plan = buildRecoveryPlan(tasks, 3)
  assert.deepEqual(
    plan.toQueue.map((t) => t.id),
    ['bt-paused'],
    'torrent paused → toQueue(恢复后手动继续)'
  )
  assert.deepEqual(plan.toSubmit, [], 'paused 不重提')
})
