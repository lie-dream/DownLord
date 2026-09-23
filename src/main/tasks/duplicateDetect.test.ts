import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Task, VideoMeta } from '../../shared/ipc'
import { detectConflict, nextAvailableStem, sameStem } from './duplicateDetect'

// ==================== 测试夹具 ====================

/** 构造 Task(只填查重相关字段,其余给合法缺省;videoMeta 可选覆盖) */
function makeTask(over: Partial<Task> & Pick<Task, 'source' | 'savePath' | 'status'>): Task {
  return {
    id: over.id ?? 'id',
    kind: over.kind ?? 'http',
    source: over.source,
    status: over.status,
    filename: over.filename ?? 'file',
    savePath: over.savePath,
    category: over.category ?? null,
    totalBytes: over.totalBytes ?? 0,
    downloadedBytes: over.downloadedBytes ?? 0,
    speed: over.speed ?? 0,
    videoMeta: over.videoMeta ?? null,
    torrentMeta: over.torrentMeta ?? null,
    error: over.error ?? null,
    createdAt: over.createdAt ?? 0,
    startedAt: over.startedAt ?? null,
    completedAt: over.completedAt ?? null
  }
}

function videoMeta(qualityLabel?: string): VideoMeta {
  return { title: 't', selectedFormat: 'f', postProcess: '', playlistIndex: 0, qualityLabel }
}

const noFile = (): boolean => false
const noDir = (): string[] => []

// ==================== sameStem(spec §3.2)====================

test('sameStem: 去最后扩展名的 basename === stemB → true', () => {
  assert.equal(sameStem('D:\\Downloads\\a [1080p].mp4', 'a [1080p]'), true)
})

test('sameStem: 不同 stem → false', () => {
  assert.equal(sameStem('D:\\Downloads\\b [1080p].mp4', 'a [1080p]'), false)
})

test('sameStem: ext 不同(.mkv vs .mp4)同 stem → true(忽略 ext 差异)', () => {
  assert.equal(sameStem('/home/u/a [1080p].mkv', 'a [1080p]'), true)
})

test('sameStem: 裸文件名(basename 即自身)亦可比对', () => {
  assert.equal(sameStem('a [720p].part', 'a [720p]'), true)
})

// ==================== detectConflict(spec §3.2 / §3.3)====================

const SRC = 'https://site/watch?v=abc'
const DIR = 'D:\\Downloads'

test('detectConflict: 直链同 dir+stem 命中(磁盘精确 stem+ext → diskOnly)', () => {
  const hit = detectConflict({
    kind: 'http',
    source: SRC,
    dir: DIR,
    stem: 'clip',
    ext: '.zip',
    historyTasks: [],
    fileExists: (p) => p === 'D:\\Downloads\\clip.zip',
    listDir: noDir
  })
  assert.equal(hit?.existing, 'diskOnly')
  assert.equal(hit?.existingPath, 'D:\\Downloads\\clip.zip')
  assert.equal(hit?.qualityLabel, null) // http 恒 null
  assert.equal(hit?.filename, 'clip.zip')
  assert.equal(hit?.existingDir, DIR)
})

test('detectConflict: 视频同源同清晰度(= 同 stem)命中(completed 历史)', () => {
  const hist = makeTask({
    kind: 'video',
    source: SRC,
    status: 'completed',
    savePath: 'D:\\Downloads\\标题 [1080p].mkv', // after_move 真实 ext 与预测 mp4 不同
    videoMeta: videoMeta('1080P')
  })
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [hist],
    fileExists: (p) => p === 'D:\\Downloads\\标题 [1080p].mkv',
    listDir: noDir
  })
  assert.equal(hit?.existing, 'completed')
  assert.equal(hit?.existingPath, 'D:\\Downloads\\标题 [1080p].mkv')
  assert.equal(hit?.qualityLabel, '1080P') // 取自命中视频任务,不重新推导
})

test('detectConflict: 不同目录 → 不命中(用户显式另存)', () => {
  const hist = makeTask({
    kind: 'video',
    source: SRC,
    status: 'completed',
    savePath: 'E:\\Other\\标题 [1080p].mp4',
    videoMeta: videoMeta('1080P')
  })
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [hist],
    fileExists: () => true, // 即使文件在,dir 不同也不该命中
    listDir: noDir
  })
  assert.equal(hit, null)
})

test('detectConflict: 不同清晰度(stem 不同)→ 不命中', () => {
  const hist = makeTask({
    kind: 'video',
    source: SRC,
    status: 'completed',
    savePath: 'D:\\Downloads\\标题 [720p].mp4',
    videoMeta: videoMeta('720P')
  })
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [hist],
    fileExists: () => true,
    listDir: (d) => (d === DIR ? ['标题 [720p].mp4'] : [])
  })
  assert.equal(hit, null)
})

test('detectConflict: 仅音频 mp3 vs 视频 mp4(stem 不同)→ 不命中', () => {
  const hist = makeTask({
    kind: 'video',
    source: SRC,
    status: 'completed',
    savePath: 'D:\\Downloads\\标题.mp3', // 音频不带 [清晰度]
    videoMeta: videoMeta() // qualityLabel 缺省
  })
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [hist],
    fileExists: () => true,
    listDir: (d) => (d === DIR ? ['标题.mp3'] : [])
  })
  assert.equal(hit, null)
})

test('detectConflict: 命中态分类 completed / active / diskOnly 正确', () => {
  // completed:历史 completed 且文件在
  const completedHit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [
      makeTask({
        kind: 'video',
        source: SRC,
        status: 'completed',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      })
    ],
    fileExists: () => true,
    listDir: noDir
  })
  assert.equal(completedHit?.existing, 'completed')
  assert.equal(completedHit?.existingPath, 'D:\\Downloads\\标题 [1080p].mp4')

  // active:历史非终态(downloading),磁盘无 → active、existingPath null
  const activeHit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [
      makeTask({
        kind: 'video',
        source: SRC,
        status: 'downloading',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      })
    ],
    fileExists: noFile,
    listDir: noDir
  })
  assert.equal(activeHit?.existing, 'active')
  assert.equal(activeHit?.existingPath, null)

  // diskOnly:无任务记录,仅磁盘有非残留同名文件
  const diskHit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [],
    fileExists: noFile,
    listDir: (d) => (d === DIR ? ['标题 [1080p].mkv'] : [])
  })
  assert.equal(diskHit?.existing, 'diskOnly')
  assert.equal(diskHit?.existingPath, 'D:\\Downloads\\标题 [1080p].mkv')
})

test('detectConflict: 优先级 completed > active(同任务同目标,completed 胜)', () => {
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [
      makeTask({
        kind: 'video',
        source: SRC,
        status: 'downloading',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      }),
      makeTask({
        kind: 'video',
        source: SRC,
        status: 'completed',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      })
    ],
    fileExists: () => true,
    listDir: noDir
  })
  assert.equal(hit?.existing, 'completed')
})

test('detectConflict: 视频磁盘 <stem>.part 残留不误判为命中', () => {
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [],
    fileExists: noFile,
    // 目录内只有残留:.part / .aria2 / .ytdl / .part-Frag → 全排除
    listDir: (d) =>
      d === DIR
        ? [
            '标题 [1080p].part',
            '标题 [1080p].aria2',
            '标题 [1080p].ytdl',
            '标题 [1080p].part-Frag0'
          ]
        : []
  })
  assert.equal(hit, null)
})

test('detectConflict: completed 记录但文件缺失 → 不命中(非 completed)', () => {
  const hit = detectConflict({
    kind: 'video',
    source: SRC,
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [
      makeTask({
        kind: 'video',
        source: SRC,
        status: 'completed',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      })
    ],
    fileExists: noFile, // 文件已被删
    listDir: noDir
  })
  assert.equal(hit, null)
})

test('detectConflict: 不同源(URL 不等价)→ 不命中(不做语义 URL 等价,§2.2)', () => {
  const hit = detectConflict({
    kind: 'video',
    source: 'https://youtu.be/abc',
    dir: DIR,
    stem: '标题 [1080p]',
    ext: '.mp4',
    historyTasks: [
      makeTask({
        kind: 'video',
        source: 'https://youtube.com/watch?v=abc',
        status: 'completed',
        savePath: 'D:\\Downloads\\标题 [1080p].mp4',
        videoMeta: videoMeta('1080P')
      })
    ],
    fileExists: () => true,
    listDir: noDir
  })
  assert.equal(hit, null)
})

// ==================== nextAvailableStem(spec §4.3)====================

test('nextAvailableStem: 无冲突原样返回', () => {
  assert.equal(
    nextAvailableStem('clip', '.zip', () => false),
    'clip'
  )
})

test('nextAvailableStem: (1)/(2) 递增到不冲突', () => {
  const taken = new Set(['clip', 'clip (1)', 'clip (2)'])
  assert.equal(
    nextAvailableStem('clip', '.zip', (s) => taken.has(s)),
    'clip (3)'
  )
})

test('nextAvailableStem: 视频序号插 [清晰度] 之后 / ext 之前(不含 ext)', () => {
  const taken = new Set(['标题 [1080p]'])
  assert.equal(
    nextAvailableStem('标题 [1080p]', '.mp4', (s) => taken.has(s)),
    '标题 [1080p] (1)'
  )
})

test('nextAvailableStem: 直链首个冲突 → name (1)(ext 由调用方拼)', () => {
  const taken = new Set(['name'])
  assert.equal(
    nextAvailableStem('name', '.ext', (s) => taken.has(s)),
    'name (1)'
  )
})
