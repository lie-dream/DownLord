/**
 * 检测重复下载 集成测试 — v0.2 Task 3 Phase 4(spec §10.2 D1–D8)。
 *
 * 真实 node:sqlite 历史(启动 seed 默认 6 类)+ FakeEngine + 注入磁盘(existsSync / readDir / trashItem),
 * 端到端验证三创建路径查重 → parked → emit `task:duplicate` → resolveDuplicate 四决策落地:
 *   D1 直链重复(覆盖 / 跳过 / 重命名)· D2 视频同清晰度 · D3 视频不同清晰度(不 emit,零回归)·
 *   D4 视频自动选分支(不静默 0B)· D5 批量(全部跳过 / 全部覆盖)· D6 磁盘无记录(diskOnly)·
 *   D7 §7.3(覆盖走回收站非 unlink、旧记录保留、跳过零 DB 写)· D8 0B 兜底(真 VideoEngine + 真临时文件)。
 *
 * 数据安全红线:查重只读历史(detectConflict 不写 tasks)、覆盖经 trashItem 可恢复(注入 spy 断言非永久删)、
 * 重命名双留、不改 schema。仿 category.integration.test.ts:动态 import 触达 node:sqlite 的模块,不可用时优雅跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type {
  AddUriInput,
  BatchPick,
  DownloadProgress,
  DuplicateConflict,
  FormatChoice,
  ResolvedPlaylist,
  ResolvedVideo,
  ResolveResult,
  Task,
  VideoMeta
} from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'

// ==================== 原生模块能力探测(同步、不静态加载)====================

const requireForProbe = createRequire(import.meta.url)

function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (path: string) => { close(): void }
    }
    const probe = new DatabaseSync(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
}

const SQLITE_OK = canLoadSqlite()

if (!SQLITE_OK) {
  const msg = `[duplicate.integration] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

// ==================== 解析样本 ====================

const SINGLE_VIDEO: ResolvedVideo = {
  kind: 'video',
  id: 'clip',
  title: 'Clip',
  durationSec: 100,
  thumbnail: null,
  extractor: 'youtube',
  webpageUrl: 'https://youtu.be/clip',
  formats: [
    {
      formatId: '137',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'avc1',
      acodec: 'none',
      filesize: 1000,
      tbr: null,
      formatNote: '1080p'
    },
    {
      formatId: '18',
      ext: 'mp4',
      height: 360,
      fps: 30,
      vcodec: 'avc1',
      acodec: 'mp4a.40.2',
      filesize: 200,
      tbr: null,
      formatNote: '360p'
    }
  ],
  subtitles: []
}

/** 3 条目播放列表(D5:2 重复 + 1 新) */
const PLAYLIST3: ResolvedPlaylist = {
  kind: 'playlist',
  title: 'List',
  entries: [
    { id: 'e0', title: 'Ep0', url: 'https://youtu.be/e0', durationSec: 60 },
    { id: 'e1', title: 'Ep1', url: 'https://youtu.be/e1', durationSec: 61 },
    { id: 'e2', title: 'Ep2', url: 'https://youtu.be/e2', durationSec: 62 }
  ]
}

// ==================== 精简 FakeEngine ====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly removeCalls: string[] = []
  private counter = 0

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    return `eng_${++this.counter}`
  }
  async pause(): Promise<void> {
    // 查重夹具不校验暂停 / 恢复语义:空实现即满足 TaskEngine 契约
  }
  async resume(): Promise<void> {
    // 同 pause:查重路径不触发,留空
  }
  async remove(id: string): Promise<void> {
    this.removeCalls.push(id)
  }
  onProgress(_cb: (progress: DownloadProgress) => void): () => void {
    return () => {}
  }
}

class FakeVideoResolver {
  result: ResolveResult = SINGLE_VIDEO
  async resolve(_url: string): Promise<ResolveResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return this.result
  }
}

// ==================== 公共辅助 ====================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-dup-'))
}

function cleanup(dir: string, ...closables: Array<{ close(): void } | null | undefined>): void {
  for (const db of closables) {
    try {
      db?.close()
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await tick()
}

function batchPicks(indexes: number[], choice: FormatChoice): BatchPick[] {
  return indexes.map((entryIndex) => ({ entryIndex, choice }))
}

interface Dirs {
  dir: string
  archivesDir: string
  videosDir: string
}

/** 完整 completed 任务记录(seed 历史用) */
function completed(over: Partial<Task> & Pick<Task, 'id' | 'source' | 'kind' | 'savePath'>): Task {
  return {
    status: 'completed',
    filename: path.basename(over.savePath),
    category: null,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    ...over
  }
}

function videoMetaOf(qualityLabel: string): VideoMeta {
  return {
    title: 'x',
    selectedFormat: 'best',
    postProcess: 'merge',
    playlistIndex: -1,
    qualityLabel
  }
}

interface DupHarness extends Dirs {
  manager: InstanceType<(typeof import('./taskManager'))['TaskManager']>
  engine: FakeEngine
  videoResolver: FakeVideoResolver
  /** 注入磁盘:存在文件的绝对路径集(可控) */
  existingFiles: Set<string>
  /** trashItem 调用记录(断言覆盖走回收站、非 fs.unlink 永久删,§7.3) */
  trashCalls: string[]
  /** 捕获 emit 的 task:duplicate 冲突 */
  conflicts: DuplicateConflict[]
  db: { close(): void }
  read: (id: string) => Task | null
  /** DB 中任务总数(断言零 DB 写 / 新记录数) */
  count: () => number
}

/**
 * 起「真 SQLite + seed 默认 6 类 + FakeEngine + 注入磁盘」夹具。
 * seed / diskFiles 用目录回调(先算 dir → 派生 Archives/Videos → 构造完成历史)。
 * 完成历史在 start() 前落库 → start() 载入内存 this.tasks 供 detectConflict 只读扫描(§3.1)。
 */
async function startDupHarness(
  opts: {
    result?: ResolveResult
    defaultHeight?: number | null
    seed?: (dirs: Dirs) => Task[]
    diskFiles?: (dirs: Dirs) => string[]
  } = {}
): Promise<DupHarness> {
  const dir = makeTempDir()
  const dirs: Dirs = {
    dir,
    archivesDir: path.join(dir, 'Archives'),
    videosDir: path.join(dir, 'Videos')
  }
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { insertTask, getTask, listTasks } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  seedDefaultCategories(db)

  const existingFiles = new Set<string>(opts.diskFiles?.(dirs) ?? [])
  for (const t of opts.seed?.(dirs) ?? []) {
    insertTask(db as unknown as TaskDaoDatabase, t)
    existingFiles.add(t.savePath) // completed 记录对应的磁盘文件(命中 completed 需 fileExists)
  }

  const trashCalls: string[] = []
  const engine = new FakeEngine()
  const videoResolver = new FakeVideoResolver()
  if (opts.result !== undefined) videoResolver.result = opts.result

  const manager = new TaskManager(
    {
      engine,
      videoResolver,
      initDatabase: () => db,
      getVideoPrefs: () => ({ defaultHeight: opts.defaultHeight ?? null, defaultAudioOnly: false }),
      ensureDir: () => {}, // 查重磁盘态由 existingFiles 控制,不碰真实 fs
      existsSync: (p) => existingFiles.has(p),
      readDir: (d) =>
        [...existingFiles].filter((p) => path.dirname(p) === d).map((p) => path.basename(p)),
      trashItem: async (p) => {
        trashCalls.push(p)
        existingFiles.delete(p) // 移入回收站 → 目标名空出(覆盖后正常重下)
      }
    },
    { dbPath, defaultDir: dir, maxConcurrent: 3 }
  )
  await manager.start()

  const conflicts: DuplicateConflict[] = []
  manager.onDuplicate((c) => conflicts.push(c))

  return {
    ...dirs,
    manager,
    engine,
    videoResolver,
    existingFiles,
    trashCalls,
    conflicts,
    db,
    read: (id) => getTask(db as unknown as TaskDaoDatabase, id),
    count: () => listTasks(db as unknown as TaskDaoDatabase).length
  }
}

// ==================== D1 直链重复(§10.2)====================

test(
  'D1a 直链重复 · 覆盖:旧文件入回收站(trashItem 非 unlink)+ 新任务建 + 下载;旧完成记录移除(仅移记录,§4.1)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-zip',
          source: 'https://x/movie.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'movie.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const oldPath = path.join(h.archivesDir, 'movie.zip')
      // 再提交同 URL 同目录 → http 冲突 emit、不插库
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/movie.zip',
        filename: 'movie.zip'
      })
      assert.equal(h.conflicts.length, 1, 'emit 一个 task:duplicate')
      assert.equal(h.conflicts[0].kind, 'http')
      assert.equal(h.conflicts[0].conflictId, id)
      assert.equal(h.conflicts[0].items[0].existing, 'completed', '命中态 completed')
      assert.equal(h.conflicts[0].items[0].existingPath, oldPath)
      assert.equal(h.count(), 1, '冲突未插库(仅 seed 的 1 条)')

      await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
      await drain()

      assert.deepEqual(
        h.trashCalls,
        [oldPath],
        '覆盖 → 旧文件走回收站(trashItem),非 fs.unlink 永久删'
      )
      assert.ok(
        h.engine.addUriCalls.some((c) => c.filename === 'movie.zip'),
        '新任务提交引擎下载'
      )
      // 被覆盖的旧完成记录移除(仅移记录、文件已入回收站可恢复;消除同路径重复,§4.1,2026-07-12 手测反馈)
      assert.equal(h.read('old-zip'), null, '覆盖 → 旧完成记录从库移除(仅移记录)')
      assert.equal(h.read(id)?.filename, 'movie.zip', '新任务建于同路径')
      assert.equal(h.count(), 1, '移除旧完成记录 + 新建 = 列表仅一条(消除同路径僵尸重复)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D1b 直链重复 · 跳过:不建任务、不动旧记录 / 文件、零 trash',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-zip',
          source: 'https://x/movie.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'movie.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/movie.zip',
        filename: 'movie.zip'
      })
      await h.manager.resolveDuplicate({ conflictId: id, decision: 'skip' })
      await drain()

      assert.deepEqual(h.trashCalls, [], '跳过零 trash')
      assert.equal(h.engine.addUriCalls.length, 0, '跳过不下载')
      assert.equal(h.count(), 1, '跳过不建任务(仍仅 seed 1 条,零 DB 写)')
      assert.ok(h.existingFiles.has(path.join(h.archivesDir, 'movie.zip')), '旧文件保留')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D1c 直链重复 · 重命名:name (1).ext 新记录、旧记录 / 文件保留(双留,§4.1)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-zip',
          source: 'https://x/movie.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'movie.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/movie.zip',
        filename: 'movie.zip'
      })
      await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
      await drain()

      assert.deepEqual(h.trashCalls, [], '重命名零 trash(双留)')
      const renamed = h.read(id)
      assert.equal(renamed?.filename, 'movie (1).zip', '自动序号 (1)')
      assert.equal(renamed?.savePath, path.join(h.archivesDir, 'movie (1).zip'), '新名新路径')
      assert.ok(
        h.engine.addUriCalls.some((c) => c.filename === 'movie (1).zip'),
        '新名提交下载'
      )
      // 旧记录 / 文件保留
      assert.equal(h.read('old-zip')?.savePath, path.join(h.archivesDir, 'movie.zip'), '旧记录保留')
      assert.ok(h.existingFiles.has(path.join(h.archivesDir, 'movie.zip')), '旧文件保留')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D2 视频同清晰度重复 ====================

test(
  'D2 视频同源同清晰度:applySelection 命中 → parked awaiting_selection + emit;覆盖 → queued + trash 旧',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: SINGLE_VIDEO,
      seed: ({ videosDir }) => [
        completed({
          id: 'old-vid',
          source: 'https://youtu.be/clip',
          kind: 'video',
          savePath: path.join(videosDir, 'Clip [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('1080P')
        })
      ]
    })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      assert.equal(h.read(id)?.status, 'awaiting_selection', '解析完成待选')

      // 选 1080p(同清晰度)→ 命中冲突 → 保持 awaiting_selection + emit
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })
      assert.equal(
        h.read(id)?.status,
        'awaiting_selection',
        '命中冲突 → 保持 awaiting_selection(不 queue)'
      )
      assert.equal(h.conflicts.length, 1, 'emit 视频冲突')
      assert.equal(h.conflicts[0].kind, 'video')
      assert.equal(h.conflicts[0].items[0].qualityLabel, '1080P', '清晰度取自命中历史任务')
      assert.equal(h.engine.addUriCalls.length, 0, 'parked → 未下载(0B 从源头消解)')

      const oldPath = path.join(h.videosDir, 'Clip [1080p].mp4')
      await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
      await drain()
      assert.deepEqual(h.trashCalls, [oldPath], '覆盖 → 旧视频入回收站')
      assert.equal(h.read(id)?.status, 'downloading', '覆盖后转下载')
      assert.equal(
        h.read('old-vid'),
        null,
        '覆盖 → 旧完成记录移除(仅移记录、文件回收站可恢复,§4.1)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D2 视频重复 · 跳过 → removeTask(不建);打开 → removeTask(渲染层负责打开)',
  { skip: !SQLITE_OK },
  async () => {
    for (const decision of ['skip', 'open'] as const) {
      const h = await startDupHarness({
        result: SINGLE_VIDEO,
        seed: ({ videosDir }) => [
          completed({
            id: 'old-vid',
            source: 'https://youtu.be/clip',
            kind: 'video',
            savePath: path.join(videosDir, 'Clip [1080p].mp4'),
            category: 'video',
            videoMeta: videoMetaOf('1080P')
          })
        ]
      })
      try {
        const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
        await drain()
        await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })
        await h.manager.resolveDuplicate({ conflictId: id, decision })
        await drain()
        assert.equal(h.read(id), null, `${decision} → parked 任务 removeTask(不建)`)
        assert.deepEqual(h.trashCalls, [], `${decision} 零 trash`)
        assert.equal(h.engine.addUriCalls.length, 0, `${decision} 不下载`)
        assert.equal(h.read('old-vid')?.status, 'completed', '旧记录保留(打开 / 跳过零改动)')
      } finally {
        await h.manager.stop()
        cleanup(h.dir, h.db)
      }
    }
  }
)

// ==================== D3 视频不同清晰度(零回归,不 emit)====================

test(
  'D3 视频同源不同清晰度:选 360p vs 已完成 1080p → 不 emit、照常入队(零回归)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: SINGLE_VIDEO,
      seed: ({ videosDir }) => [
        completed({
          id: 'old-1080',
          source: 'https://youtu.be/clip',
          kind: 'video',
          savePath: path.join(videosDir, 'Clip [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('1080P')
        })
      ]
    })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      // 选 360p(格式 18)→ 文件名 Clip [360p].mp4,stem 不同 → 不命中
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '18' })
      await drain()

      assert.equal(h.conflicts.length, 0, '不同清晰度 → 不 emit')
      assert.equal(h.read(id)?.filename, 'Clip [360p].mp4', '360p 文件名不同')
      assert.equal(h.read(id)?.status, 'downloading', '照常入队下载(零回归)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D4 视频自动选分支(不静默 0B)====================

test(
  'D4 默认清晰度自动选命中冲突:resolving → awaiting_selection + emit(不静默 queued 致 0B)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: SINGLE_VIDEO,
      defaultHeight: 1080, // 跳过 FormatDialog → onResolved 自动 applySelection
      seed: ({ videosDir }) => [
        completed({
          id: 'old-1080',
          source: 'https://youtu.be/clip',
          kind: 'video',
          savePath: path.join(videosDir, 'Clip [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('≤1080P')
        })
      ]
    })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()

      // 自动选(heightCap=1080)→ Clip [1080p].mp4 命中 → 不自动 queued,转 awaiting_selection + emit
      assert.equal(
        h.read(id)?.status,
        'awaiting_selection',
        '自动选命中 → awaiting_selection(非 queued)'
      )
      assert.equal(h.conflicts.length, 1, 'emit 视频冲突(自动选分支也弹决策)')
      assert.equal(h.engine.addUriCalls.length, 0, '未静默下载 0B')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D5 批量(2 重复 + 1 新)====================

test(
  'D5 批量:2 重复 + 1 新 → 新的立即入队、重复聚合一个 batch 事件;全部跳过 → 父占位清理',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: PLAYLIST3,
      seed: ({ videosDir }) => [
        completed({
          id: 'old-e0',
          source: 'https://youtu.be/e0',
          kind: 'video',
          savePath: path.join(videosDir, 'Ep0 [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('≤1080P')
        }),
        completed({
          id: 'old-e1',
          source: 'https://youtu.be/e1',
          kind: 'video',
          savePath: path.join(videosDir, 'Ep1 [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('≤1080P')
        })
      ]
    })
    try {
      const parentId = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/list' })
      await drain()
      await h.manager.submitBatch(
        parentId,
        batchPicks([0, 1, 2], { audioOnly: false, heightCap: 1080 })
      )
      await drain()

      // 新的(e2)立即入队;重复(e0/e1)聚合一个 batch 事件;父占位仍在(待决策)
      assert.equal(h.conflicts.length, 1, '重复聚合为一个 batch 事件')
      assert.equal(h.conflicts[0].kind, 'batch')
      assert.equal(h.conflicts[0].items.length, 2, '2 条重复项')
      const newChild = h.manager.listTasks().find((t) => t.filename === 'Ep2 [1080p].mp4')
      assert.ok(newChild, '新条目 e2 立即建 + 入队')
      assert.ok(
        h.manager.listTasks().some((t) => t.id === parentId),
        '父占位待批量决策后再清理'
      )

      // 全部跳过 → 不建 e0/e1、父占位清理
      await h.manager.resolveDuplicate({ conflictId: parentId, decision: 'skip' })
      await drain()
      assert.equal(h.read(parentId), null, '批量决策处理后父占位 removeTask')
      const newChildren = h.manager
        .listTasks()
        .filter((t) => t.filename.startsWith('Ep') && t.status !== 'completed')
      assert.equal(
        newChildren.length,
        1,
        '仅 e2 一条新子任务(e0/e1 跳过未建;seed 的 completed 历史不计)'
      )
      assert.equal(newChildren[0].filename, 'Ep2 [1080p].mp4')
      assert.deepEqual(h.trashCalls, [], '全部跳过零 trash')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D5 批量 · 全部覆盖 + 逐条:trash 两旧 + 建;混合 perItem(第 0 条跳过)只建 e1',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: PLAYLIST3,
      seed: ({ videosDir }) => [
        completed({
          id: 'old-e0',
          source: 'https://youtu.be/e0',
          kind: 'video',
          savePath: path.join(videosDir, 'Ep0 [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('≤1080P')
        }),
        completed({
          id: 'old-e1',
          source: 'https://youtu.be/e1',
          kind: 'video',
          savePath: path.join(videosDir, 'Ep1 [1080p].mp4'),
          category: 'video',
          videoMeta: videoMetaOf('≤1080P')
        })
      ]
    })
    try {
      const parentId = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/list' })
      await drain()
      await h.manager.submitBatch(
        parentId,
        batchPicks([0, 1, 2], { audioOnly: false, heightCap: 1080 })
      )
      await drain()
      const items = h.conflicts[0].items
      const idx0 = items[0].index // Ep0(逐条改 skip;Ep1 继承 overwrite)

      // 应用到全部=overwrite,但第 0 条(Ep0)逐条改为 skip → 仅 trash + 建 Ep1
      await h.manager.resolveDuplicate({
        conflictId: parentId,
        decision: 'overwrite',
        perItem: { [idx0]: 'skip' }
      })
      await drain()

      assert.deepEqual(
        h.trashCalls,
        [path.join(h.videosDir, 'Ep1 [1080p].mp4')],
        '仅 Ep1 覆盖 → trash Ep1;Ep0 跳过不 trash'
      )
      const built = h.manager
        .listTasks()
        .filter((t) => t.filename.startsWith('Ep') && t.status !== 'completed')
      assert.ok(
        built.some((t) => t.filename === 'Ep1 [1080p].mp4'),
        'Ep1 覆盖后建'
      )
      assert.ok(
        built.some((t) => t.filename === 'Ep2 [1080p].mp4'),
        'Ep2 新条目建'
      )
      assert.ok(!built.some((t) => t.filename === 'Ep0 [1080p].mp4'), 'Ep0 逐条跳过 → 未建')
      assert.equal(h.read('old-e0')?.status, 'completed', 'Ep0 旧记录保留')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D6 磁盘无记录(diskOnly)====================

test(
  'D6 磁盘有同名文件但无记录 → diskOnly 命中;覆盖 → trash 磁盘文件 + queued',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      result: SINGLE_VIDEO,
      diskFiles: ({ videosDir }) => [path.join(videosDir, 'Clip [1080p].mp4')] // 磁盘有、无任务记录
    })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })

      assert.equal(h.conflicts.length, 1, 'diskOnly 命中 → emit')
      assert.equal(h.conflicts[0].items[0].existing, 'diskOnly')
      assert.equal(h.conflicts[0].items[0].existingPath, path.join(h.videosDir, 'Clip [1080p].mp4'))

      await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
      await drain()
      assert.deepEqual(
        h.trashCalls,
        [path.join(h.videosDir, 'Clip [1080p].mp4')],
        '覆盖 → 磁盘文件入回收站'
      )
      assert.equal(h.read(id)?.status, 'downloading', '覆盖后下载')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D7 §7.3 数据安全断言(集中复核)====================

test(
  'D7a §7.3 覆盖:被覆盖的旧完成记录移除(仅移记录)+ 旧文件走 trashItem(非 unlink,回收站可恢复)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-zip',
          source: 'https://x/a.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'a.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const oldPath = path.join(h.archivesDir, 'a.zip')
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/a.zip',
        filename: 'a.zip'
      })
      await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
      await drain()
      // 覆盖:旧完成记录移除(仅移记录、文件已入回收站可恢复;非「改写」而是「用户主动覆盖」的一部分,§4.1)
      assert.equal(h.read('old-zip'), null, '覆盖后旧完成记录从库移除(仅移记录)')
      assert.deepEqual(
        h.trashCalls,
        [oldPath],
        '旧文件仅经 trashItem 移回收站(源码无 fs.unlink / rmSync 永久删)'
      )
      assert.equal(h.count(), 1, '移除旧完成记录 + 新建 = 列表仅一条(消除同路径僵尸重复)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D7b §7.3 跳过:零 DB 写、零 trash、旧记录 / 文件保留(不动)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-b',
          source: 'https://x/b.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'b.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const countBefore = h.count() // seed 的 1 条
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/b.zip',
        filename: 'b.zip'
      })
      await h.manager.resolveDuplicate({ conflictId: id, decision: 'skip' })
      await drain()
      assert.equal(h.count(), countBefore, '跳过零 DB 写')
      assert.deepEqual(h.trashCalls, [], '跳过零 trash')
      assert.equal(h.read('old-b')?.status, 'completed', '旧记录保留(跳过不动)')
      assert.ok(h.existingFiles.has(path.join(h.archivesDir, 'b.zip')), '旧文件保留')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D9 #29 子步 B 等价性(候选集改 findBySource · spec §4 / §11.3)====================
//
// 查重候选集从「全量内存拷贝」改为「`findBySource` 同源命中」后,判定须与原内存扫描**逐条等价**。
// 关键在于「每行取 `this.tasks.get(row.id) ?? row`」:**内存 runtime 态才是权威**(状态流转先改内存、
// 仅关键节点落库,DB 可能滞后)。下面两例把 DB 行**人为改脏**(与内存不一致),断言判定仍随内存走——
// 若实现误用 DB 行,两例都会给出不同的命中态。

test(
  'D9a #29 等价性:downloading 中任务仍判 active(DB 行脏成 error 终态也不改判定;内存 runtime 权威)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness()
    try {
      // 1) 先起一个真正在下载的任务(FakeEngine 接单 → downloading)
      const first = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/live.zip',
        filename: 'live.zip'
      })
      await drain()
      assert.equal(h.read(first)?.status, 'downloading', '前置:首个任务进入 downloading')

      // 2) 把 DB 行改脏为 error(终态:纯函数对 error **不命中**)——模拟「DB 滞后 / 与内存不一致」
      const raw = h.db as unknown as TaskDaoDatabase
      raw.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('error', first)
      assert.equal(h.read(first)?.status, 'error', '前置:DB 行已脏(error),内存仍是 downloading')

      // 3) 同源同名再提交 → 仍命中 active(取内存 downloading;若用 DB 行 error 则根本不 emit)
      const second = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/live.zip',
        filename: 'live.zip'
      })
      assert.equal(h.conflicts.length, 1, 'emit 一个 task:duplicate')
      assert.equal(
        h.conflicts[0].items[0].existing,
        'active',
        'downloading 中 → active(非终态判定与内存扫描等价)'
      )
      assert.equal(h.conflicts[0].items[0].existingPath, null, 'active 命中无 existingPath')

      await h.manager.resolveDuplicate({ conflictId: second, decision: 'skip' })
      await drain()
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D9b #29 等价性:completed 优先(DB 行脏成 queued 仍以内存 completed 判定,不退化为 diskOnly)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ archivesDir }) => [
        completed({
          id: 'old-c',
          source: 'https://x/c.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'c.zip'),
          category: 'archive'
        })
      ]
    })
    try {
      // DB 行改脏为 queued(非终态):若误用 DB 行,磁盘同名文件在 → 会退化命中 diskOnly
      const raw = h.db as unknown as TaskDaoDatabase
      raw.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('queued', 'old-c')

      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/c.zip',
        filename: 'c.zip'
      })
      assert.equal(h.conflicts.length, 1, 'emit 一个 task:duplicate')
      const item = h.conflicts[0].items[0]
      assert.equal(
        item.existing,
        'completed',
        '取内存 completed → 命中 completed(优先级 completed > diskOnly > active)'
      )
      assert.equal(
        item.existingPath,
        path.join(h.archivesDir, 'c.zip'),
        'existingPath = 已完成记录 savePath'
      )

      await h.manager.resolveDuplicate({ conflictId: id, decision: 'skip' })
      await drain()
      assert.deepEqual(h.trashCalls, [], '等价性用例零 trash(查重只读,§7.3)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D9c #29 等价性:同源不同目录 / 不同 stem 仍不误判(候选集收窄不放宽命中面)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startDupHarness({
      seed: ({ dir, archivesDir }) => [
        // 同源、同 stem,但落在**别的目录** → 不命中
        completed({
          id: 'other-dir',
          source: 'https://x/d.zip',
          kind: 'http',
          savePath: path.join(dir, 'd.zip'),
          category: null
        }),
        // 同源、同目录,但**别的 stem** → 不命中
        completed({
          id: 'other-stem',
          source: 'https://x/d.zip',
          kind: 'http',
          savePath: path.join(archivesDir, 'd (1).zip'),
          category: 'archive'
        })
      ]
    })
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/d.zip',
        filename: 'd.zip'
      })
      await drain()
      assert.deepEqual(h.conflicts, [], '同源但目录 / stem 不同 → 不 emit(零误判)')
      assert.equal(h.read(id)?.savePath, path.join(h.archivesDir, 'd.zip'), '照常建任务落 Archives')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== D8 0B 兜底(真 VideoEngine + 真临时文件)====================

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  killed: boolean
  kill(signal?: string): boolean
}

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pid
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

test(
  'D8 0B 兜底:yt-dlp「has already been downloaded」跳过行 → 完成 totalBytes=真实 statSize(非 0)+ savePath=真实路径',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const { VideoEngine } = await import('../video/videoEngine')
    try {
      // 真实临时文件(2048 字节)模拟「同名完整文件已在磁盘」→ yt-dlp 跳过下载
      const realFile = path.join(dir, 'My Video.mp4')
      fs.writeFileSync(realFile, Buffer.alloc(2048))

      const children: FakeChild[] = []
      let pid = 2000
      const spawn = (() => {
        const child = makeFakeChild(++pid)
        children.push(child)
        return child
      }) as unknown as typeof import('child_process').spawn

      const engine = new VideoEngine(
        { spawn, treeKill: () => {} }, // statSize 用默认真实 fs.statSync(端到端)
        { ytdlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', aria2cPath: 'aria2c', defaultDir: dir }
      )
      const events: DownloadProgress[] = []
      engine.onProgress((p) => events.push(p))

      await engine.addUri({
        url: 'https://youtu.be/x',
        dir,
        filename: 'My Video.mp4',
        video: { formatSelector: 'best', audioOnly: false }
      })
      const child = children[0]
      child.stdout.write(`[download] ${realFile} has already been downloaded\n`)
      await tick()
      child.emit('close', 0, null)
      await tick()

      const done = events.find((e) => e.status === 'completed')
      assert.ok(done, 'exit 0 → completed')
      assert.equal(done!.savePath, realFile, '跳过行抽出真实路径 → savePath(非错位预测值)')
      assert.equal(done!.totalBytes, 2048, '从最终文件 statSize 校正真实大小(非假 0B)')
      assert.equal(done!.downloadedBytes, 2048)
    } finally {
      cleanup(dir)
    }
  }
)
