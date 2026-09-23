import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskView } from './taskView'
import type { Task, TaskStatus } from '../../../shared/ipc'
const mk = (status: TaskStatus): Task => ({
  id: 's',
  kind: 'http',
  source: 'x',
  status,
  filename: 'f',
  savePath: 'p',
  category: null,
  totalBytes: 200,
  downloadedBytes: 100,
  speed: 10,
  videoMeta: null,
  torrentMeta: null,
  error: status === 'error' ? '连接超时' : null,
  createdAt: 1,
  startedAt: null,
  completedAt: null
})
test('downloading', () => {
  const v = taskView(mk('downloading'))
  assert.equal(v.progress, 'determinate')
  assert.deepEqual(v.actions, ['limit', 'pause', 'cancel'])
  assert.equal(v.meta.kind, 'percent')
  assert.equal(v.speedTone, 'brand')
})
test('paused', () => {
  const v = taskView(mk('paused'))
  assert.equal(v.progress, 'paused')
  assert.deepEqual(v.actions, ['limit', 'resume', 'cancel'])
})
test('queued', () => {
  const v = taskView(mk('queued'))
  assert.equal(v.progress, 'none')
  assert.equal(v.meta.pillKind, 'wait')
  assert.deepEqual(v.actions, ['cancel'])
})
test('completed', () => {
  const v = taskView(mk('completed'))
  assert.equal(v.sub.kind, 'ok')
  assert.deepEqual(v.actions, ['openFile', 'showInFolder', 'more'])
})
test('error 展示 task.error', () => {
  const v = taskView(mk('error'))
  assert.equal(v.iconCategory, 'error')
  assert.equal(v.sub.text.includes('连接超时'), true)
  assert.deepEqual(v.actions, ['retry', 'cancel'])
})
test('视频态视觉到位', () => {
  assert.equal(taskView(mk('resolving')).progress, 'indeterminate')
  // Task 9.6 §3 — 中间态补删除入口(cancel)
  assert.deepEqual(taskView(mk('awaiting_selection')).actions, ['selectFormat', 'cancel'])
  assert.deepEqual(taskView(mk('processing')).actions, ['cancel'])
  assert.equal(taskView(mk('processing')).progress, 'processing')
})
// Task 8.5 §3.3 — 清晰度行显示(渲染纯读 videoMeta.qualityLabel,不计算)
const mkVideo = (status: TaskStatus, qualityLabel?: string): Task => ({
  ...mk(status),
  kind: 'video',
  videoMeta: { title: 't', selectedFormat: 'f', postProcess: '', playlistIndex: 0, qualityLabel }
})
test('video 任务返回 quality = videoMeta.qualityLabel(下载中 / 已完成各态)', () => {
  assert.equal(taskView(mkVideo('downloading', '1080P')).quality, '1080P')
  assert.equal(taskView(mkVideo('completed', '仅音频 MP3')).quality, '仅音频 MP3')
  assert.equal(taskView(mkVideo('completed', '最高')).quality, '最高')
})
test('直链(kind http)不返回 quality', () => {
  assert.equal(taskView(mk('downloading')).quality, undefined)
  assert.equal(taskView(mk('completed')).quality, undefined)
})
test('video 无 qualityLabel(待选占位)quality 为 undefined', () => {
  assert.equal(taskView(mkVideo('awaiting_selection')).quality, undefined)
})
// v0.3 Task 2 — torrent 待选文件与 video 待选清晰度区分(文案 + 文件图标),actions 复用 selectFormat
const mkTorrent = (status: TaskStatus): Task => ({ ...mk(status), kind: 'torrent' })
test('torrent awaiting_selection:文件图标 + 「已获取种子信息,待选择文件」+ selectFormat/cancel', () => {
  const v = taskView(mkTorrent('awaiting_selection'))
  assert.equal(v.iconCategory, 'file')
  assert.equal(v.sub.kind, 'warn')
  assert.equal(v.sub.text, '已获取种子信息,待选择文件')
  assert.deepEqual(v.actions, ['selectFormat', 'cancel'])
})
test('video awaiting_selection 零回归:视频图标 + 「已解析,待选择清晰度」', () => {
  const v = taskView(mkVideo('awaiting_selection'))
  assert.equal(v.iconCategory, 'video')
  assert.equal(v.sub.text, '已解析,待选择清晰度')
})
// Task 2 §5.3 — 单任务限速入口:仅 downloading / paused 前部有 'limit',其它态无
test('限速入口仅 downloading / paused(前部);其它态不含 limit', () => {
  assert.equal(taskView(mk('downloading')).actions[0], 'limit', 'downloading 前部为 limit')
  assert.equal(taskView(mk('paused')).actions[0], 'limit', 'paused 前部为 limit')
  for (const s of [
    'queued',
    'completed',
    'error',
    'resolving',
    'awaiting_selection',
    'processing'
  ] as const) {
    assert.equal(taskView(mk(s)).actions.includes('limit'), false, `${s} 不应含限速入口`)
  }
})

// v0.3 Task 3 — torrent 下载中富进度:peers 副信息 + 0 速可观测(spec §6.2)
const mkTorrentDl = (over: Partial<Task>): Task => ({
  ...mk('downloading'),
  kind: 'torrent',
  downloadedBytes: 100,
  totalBytes: 200,
  speed: 10,
  ...over
})
test('torrent downloading(有速度):副信息「已下 / 总 · N 节点」,速度仍 ↓ 下行(brand)', () => {
  const v = taskView(mkTorrentDl({ connections: 5 }))
  assert.equal(v.sub.text, '100 B / 200 B · 5 节点')
  assert.equal(v.speedTone, 'brand')
  assert.deepEqual(v.actions, ['limit', 'pause', 'cancel'])
})
test('torrent downloading(0 速 · 已连 N 节点):显「N 节点 · 等待数据…」', () => {
  assert.equal(taskView(mkTorrentDl({ speed: 0, connections: 3 })).sub.text, '3 节点 · 等待数据…')
})
test('torrent downloading(0 速 · 无节点):显「正在寻找节点…」', () => {
  assert.equal(taskView(mkTorrentDl({ speed: 0, connections: 0 })).sub.text, '正在寻找节点…')
  // connections 未透传(undefined)按 0 处理
  assert.equal(taskView(mkTorrentDl({ speed: 0 })).sub.text, '正在寻找节点…')
})
test('http downloading 零回归:不带 peers 后缀', () => {
  assert.equal(taskView(mk('downloading')).sub.text, '100 B / 200 B')
})

// v0.3 Task 3 — torrent 做种中变体(completed && seeding):做种中 pill + ↑ 上行 + 分享率 + stopSeed
const mkSeeding = (over: Partial<Task> = {}): Task => ({
  ...mk('completed'),
  kind: 'torrent',
  seeding: true,
  downloadedBytes: 1000,
  totalBytes: 1000,
  uploadLength: 1200,
  uploadSpeed: 500,
  connections: 3,
  ...over
})
test('torrent seeding:做种中 pill(seed)+ ↑ 上行(upload)+ 分享率 · N 节点(connections)+ stopSeed 前部', () => {
  const v = taskView(mkSeeding())
  assert.equal(v.meta.kind, 'pill')
  assert.equal(v.meta.pillText, '做种中')
  assert.equal(v.meta.pillKind, 'seed')
  assert.equal(v.speedTone, 'upload')
  assert.equal(v.sub.text, '分享率 1.20 · 3 节点')
  assert.deepEqual(v.actions, ['stopSeed', 'openFile', 'showInFolder', 'more'])
})
test('torrent seeding 分享率:completedLength=0 → 0.00;connections 缺失 → 0 节点', () => {
  const v = taskView(mkSeeding({ downloadedBytes: 0, totalBytes: 0, connections: undefined }))
  assert.equal(v.sub.text, '分享率 0.00 · 0 节点')
})
test('torrent completed 非 seeding:零回归(已完成,openFile/showInFolder/more)', () => {
  const v = taskView(mkSeeding({ seeding: false }))
  assert.equal(v.sub.kind, 'ok')
  assert.equal(v.sub.text.includes('已完成'), true)
  assert.deepEqual(v.actions, ['openFile', 'showInFolder', 'more'])
})
test('http completed 零回归:seeding 字段无关(不误入做种分支)', () => {
  const v = taskView(mk('completed'))
  assert.equal(v.sub.kind, 'ok')
  assert.deepEqual(v.actions, ['openFile', 'showInFolder', 'more'])
})
