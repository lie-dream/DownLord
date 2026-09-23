import { test } from 'node:test'
import assert from 'node:assert/strict'
import { progressMerge } from './progressMerge'
import type { Task, TaskProgress } from '../../../shared/ipc'
const t = (id: string): Task => ({
  id,
  kind: 'http',
  source: 'x',
  status: 'downloading',
  filename: id,
  savePath: 'p',
  category: null,
  totalBytes: 0,
  downloadedBytes: 0,
  speed: 0,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null
})
test('合并覆盖既有任务进度/状态;未知 id 忽略', () => {
  const tasks = [t('a'), t('b')]
  const ps: TaskProgress[] = [
    { id: 'a', status: 'downloading', downloadedBytes: 50, totalBytes: 100, speed: 10 },
    { id: 'zzz', status: 'completed', downloadedBytes: 1, totalBytes: 1, speed: 0 }
  ]
  const out = progressMerge(tasks, ps)
  assert.equal(out.find((x) => x.id === 'a')!.downloadedBytes, 50)
  assert.equal(out.find((x) => x.id === 'a')!.totalBytes, 100)
  assert.equal(out.length, 2) // 未知 id 不新增
  assert.equal(out.find((x) => x.id === 'b')!.downloadedBytes, 0) // 未涉及不变
})
test('error 帧写入 error 文案', () => {
  const out = progressMerge(
    [t('a')],
    [{ id: 'a', status: 'error', downloadedBytes: 0, totalBytes: 0, speed: 0, error: '超时' }]
  )
  assert.equal(out[0].status, 'error')
  assert.equal(out[0].error, '超时')
})
test('limitKBps 随帧透传(限速 popover 回显);帧未带 → 保留旧值', () => {
  const withLimit = progressMerge(
    [t('a')],
    [
      {
        id: 'a',
        status: 'downloading',
        downloadedBytes: 1,
        totalBytes: 2,
        speed: 1,
        limitKBps: 2048
      }
    ]
  )
  assert.equal(withLimit[0].limitKBps, 2048, '帧带 limitKBps → 写入')
  const kept = progressMerge(withLimit, [
    { id: 'a', status: 'downloading', downloadedBytes: 2, totalBytes: 2, speed: 1 }
  ])
  assert.equal(kept[0].limitKBps, 2048, '帧未带 → 保留旧值')
})
// v0.3 Task 4 #25 — 「跟随全局」= 清除任务级覆盖:主进程 broadcast 恒带 limitKBps 键(值 undefined),
// 用 `??` 会被旧值吞掉 → radio 回显不生效;必须按「键是否存在」判定。
test('limitKBps:undefined 帧(清除覆盖=跟随全局)写入 undefined,不被旧值吞', () => {
  const withLimit = progressMerge(
    [t('a')],
    [
      {
        id: 'a',
        status: 'downloading',
        downloadedBytes: 1,
        totalBytes: 2,
        speed: 1,
        limitKBps: 2048
      }
    ]
  )
  assert.equal(withLimit[0].limitKBps, 2048)
  const cleared = progressMerge(withLimit, [
    {
      id: 'a',
      status: 'downloading',
      downloadedBytes: 2,
      totalBytes: 2,
      speed: 1,
      limitKBps: undefined
    }
  ])
  assert.equal(cleared[0].limitKBps, undefined, '帧带 limitKBps:undefined → 清除(跟随全局)')
})
// v0.3 Task 3 — BT 富进度合并进内存 task(不落库):seeding/uploadSpeed/uploadLength/numSeeders/connections
test('富进度随帧合并(做种);connections=0 保留(非 nullish)', () => {
  const seeding = progressMerge(
    [t('a')],
    [
      {
        id: 'a',
        status: 'completed',
        downloadedBytes: 100,
        totalBytes: 100,
        speed: 0,
        seeding: true,
        uploadSpeed: 500,
        uploadLength: 120,
        numSeeders: 3,
        connections: 4
      }
    ]
  )
  const x = seeding[0]
  assert.equal(x.seeding, true)
  assert.equal(x.uploadSpeed, 500)
  assert.equal(x.uploadLength, 120)
  assert.equal(x.numSeeders, 3)
  assert.equal(x.connections, 4)
  // connections=0 帧应写 0(0 非 nullish,0 速可观测靠它),不被旧值吞
  const zero = progressMerge(seeding, [
    {
      id: 'a',
      status: 'downloading',
      downloadedBytes: 100,
      totalBytes: 100,
      speed: 0,
      connections: 0
    }
  ])
  assert.equal(zero[0].connections, 0, 'connections=0 写入(可观测)')
})
test('停止做种帧 seeding:false 写入(false 非 nullish,不被旧 true 吞)', () => {
  const on = progressMerge(
    [t('a')],
    [
      {
        id: 'a',
        status: 'completed',
        downloadedBytes: 100,
        totalBytes: 100,
        speed: 0,
        seeding: true,
        uploadSpeed: 500
      }
    ]
  )
  assert.equal(on[0].seeding, true)
  const off = progressMerge(on, [
    {
      id: 'a',
      status: 'completed',
      downloadedBytes: 100,
      totalBytes: 100,
      speed: 0,
      seeding: false
    }
  ])
  assert.equal(off[0].seeding, false, 'seeding:false 覆盖旧 true')
})

// M-011:主进程掌握实际输出路径,渲染只合并,不自行推断/分类。
test('M-011 filename/savePath/category 随进度合并,缺省保留且 null 类别可清空', () => {
  const frame: TaskProgress = {
    id: 'a', status: 'downloading', downloadedBytes: 0, totalBytes: 0, speed: 0,
    filename: 'actual.pdf', savePath: '/downloads/actual.pdf', category: 'document'
  }
  const updated = progressMerge([t('a')], [frame])
  assert.equal(updated[0].filename, 'actual.pdf')
  assert.equal(updated[0].savePath, '/downloads/actual.pdf')
  assert.equal(updated[0].category, 'document')
  const unchanged = progressMerge(updated, [
    { id: 'a', status: 'downloading', downloadedBytes: 1, totalBytes: 2, speed: 1 }
  ])
  assert.equal(unchanged[0].filename, 'actual.pdf')
  assert.equal(unchanged[0].savePath, '/downloads/actual.pdf')
  assert.equal(unchanged[0].category, 'document')
  const cleared = progressMerge(unchanged, [{ ...frame, category: null }])
  assert.equal(cleared[0].category, null)
})
