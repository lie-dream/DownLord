/**
 * TaskManager 单元测试 — mock DownloadEngine + mock DB(spec §8 / plan Phase 4)。
 *
 * 本文件不接真实 better-sqlite3 / aria2c:用内存 mock DB(模拟 DAO 发出的 SQL)+ 可控
 * FakeEngine 驱动进度事件,确定性验证 TaskManager 编排:增删改查 / 状态流转 / 并发出队 /
 * §4 落库边界(瞬时进度仅内存,关键节点落库)/ 重启恢复重提交。
 *
 * 因不实例化原生模块,任意 Node 版本恒绿(真实 SQLite + DownloadEngine 链路见 integration.test.ts)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, dirname, join } from 'path'

import type {
  AddUriInput,
  BatchPick,
  DownloadProgress,
  DuplicateConflict,
  ResolvedPlaylist,
  ResolvedVideo,
  ResolveResult,
  SubtitleChoice,
  Task,
  TaskProgress,
  TaskStatus,
  TorrentInfo,
  VideoPrefs
} from '../../shared/ipc'
import { getTask as daoGetTask, type TaskDaoDatabase } from '../db/taskDao'
import { TaskManager, type TaskEngine } from './taskManager'

// ==================== 内存 mock DB(模拟 DAO 发出的 SQL)====================

type TaskRow = {
  id: string
  kind: Task['kind']
  source: string
  status: TaskStatus
  filename: string
  savePath: string
  category: string | null
  totalBytes: number
  downloadedBytes: number
  videoMeta: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  torrentMeta: string | null
}

const TASK_COLUMNS: Array<keyof TaskRow> = [
  'id',
  'kind',
  'source',
  'status',
  'filename',
  'savePath',
  'category',
  'totalBytes',
  'downloadedBytes',
  'videoMeta',
  'error',
  'createdAt',
  'startedAt',
  'completedAt',
  'torrentMeta'
]

interface MockStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/**
 * 模拟 better-sqlite3 的最小面:覆盖 taskDao 发出的全部 SQL(INSERT / SELECT / UPDATE /
 * DELETE / 带筛选的 list)。结构上同时满足 TaskDaoDatabase 与 TaskManager 注入的 AppDatabase。
 */
class MockDb {
  rows: TaskRow[] = []
  /** 类别行(Task 4:getKnownFileExts 测试 seed;缺省空 → extIndex 为空,既有测试行为不变) */
  categoryRows: unknown[] = []

  prepare(sql: string): MockStatement {
    if (sql.startsWith('INSERT INTO tasks')) {
      return this.statement({
        run: (...params) => {
          const row = Object.fromEntries(
            TASK_COLUMNS.map((column, index) => [column, params[index]])
          ) as TaskRow
          this.rows.push(row)
        }
      })
    }

    if (sql === 'SELECT * FROM tasks WHERE id = ?') {
      return this.statement({
        get: (id) => this.rows.find((row) => row.id === id)
      })
    }

    if (sql.startsWith('UPDATE tasks SET ')) {
      return this.statement({ run: (...params) => this.updateFromSql(sql, params) })
    }

    if (sql === 'DELETE FROM tasks WHERE id = ?') {
      return this.statement({
        run: (id) => {
          this.rows = this.rows.filter((row) => row.id !== id)
        }
      })
    }

    // #29(v0.3 Task 4):查重候选集经 findBySource 取同源行(真实库走 idx_tasks_source)
    if (sql === 'SELECT * FROM tasks WHERE source = ?') {
      return this.statement({
        all: (source) => this.rows.filter((row) => row.source === source)
      })
    }

    if (sql.startsWith('SELECT * FROM tasks')) {
      return this.statement({ all: (...params) => this.listFromSql(sql, params) })
    }

    // Task 6 Phase 2:start() 读类别配置入缓存(缺省空;Task 4 getKnownFileExts 测试经 categoryRows seed)
    if (sql.startsWith('SELECT key, displayName, extensions, savePath FROM categories')) {
      return this.statement({ all: () => this.categoryRows })
    }

    throw new Error(`Unexpected SQL in taskManager test mock: ${sql}`)
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return (...args) => fn(...args)
  }

  private statement(handlers: Partial<MockStatement>): MockStatement {
    return {
      get: (...params) => handlers.get?.(...params),
      run: (...params) => handlers.run?.(...params),
      all: (...params) => handlers.all?.(...params) ?? []
    }
  }

  private updateFromSql(sql: string, params: unknown[]): void {
    const assignments =
      sql
        .match(/^UPDATE tasks SET (.+) WHERE id = \?$/)
        ?.at(1)
        ?.split(', ')
        .map((assignment) => assignment.split(' = ')[0] as keyof TaskRow) ?? []
    const id = params[assignments.length] as string
    const updates = Object.fromEntries(
      assignments.map((column, index) => [column, params[index]])
    ) as Partial<TaskRow>
    const row = this.rows.find((item) => item.id === id)
    if (row) {
      Object.assign(row, updates)
    }
  }

  private listFromSql(sql: string, params: unknown[]): TaskRow[] {
    let rows = [...this.rows]
    let paramIndex = 0

    if (sql.includes('status IN')) {
      const placeholders = sql.match(/status IN \(([^)]*)\)/)?.[1].match(/\?/g)?.length ?? 0
      const statuses = params.slice(paramIndex, paramIndex + placeholders)
      paramIndex += placeholders
      rows = rows.filter((row) => statuses.includes(row.status))
    }

    if (sql.includes('category = ?')) {
      const category = params[paramIndex]
      rows = rows.filter((row) => row.category === category)
    }

    return rows.sort((a, b) => b.createdAt - a.createdAt)
  }
}

// ==================== 可控 FakeEngine ====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly pauseCalls: string[] = []
  readonly resumeCalls: string[] = []
  readonly removeCalls: string[] = []
  readonly setTaskLimitCalls: Array<{ id: string; kbps: number | null }> = []
  readonly applyTorrentSelectionCalls: Array<{ id: string; arg: string | null }> = []
  readonly stopSeedingCalls: string[] = []
  failNextAddUri = false

  private counter = 0
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private readonly active = new Map<string, { input: AddUriInput; done: boolean }>()

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    if (this.failNextAddUri) {
      this.failNextAddUri = false
      throw new Error('addUri 失败')
    }
    const id = `eng_${++this.counter}`
    this.active.set(id, { input, done: false })
    return id
  }

  async pause(id: string): Promise<void> {
    this.pauseCalls.push(id)
  }

  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id)
  }

  async remove(id: string): Promise<void> {
    this.removeCalls.push(id)
    this.active.delete(id)
  }

  async setTaskLimit(id: string, kbps: number | null): Promise<void> {
    this.setTaskLimitCalls.push({ id, kbps })
  }

  async applyTorrentSelection(id: string, selectFileArg: string | null): Promise<void> {
    this.applyTorrentSelectionCalls.push({ id, arg: selectFileArg })
  }

  async stopSeeding(id: string): Promise<void> {
    this.stopSeedingCalls.push(id)
  }

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  // ----- 测试驱动辅助 -----

  /** 取某文件名当前活动的引擎 id(用于按业务键驱动进度,避免依赖内部 id 映射) */
  private engineIdFor(filename: string): string {
    let found: string | undefined
    for (const [id, rec] of this.active) {
      if (!rec.done && rec.input.filename === filename) {
        found = id
      }
    }
    if (!found) {
      throw new Error(`FakeEngine 无活动任务: ${filename}`)
    }
    return found
  }

  private emit(progress: DownloadProgress): void {
    for (const callback of this.callbacks) {
      callback(progress)
    }
  }

  /** 下载中进度(非终态,仅广播,只在内存) */
  emitProgress(filename: string, downloadedBytes: number, totalBytes: number, speed = 0): void {
    this.emit({
      id: this.engineIdFor(filename),
      status: 'downloading',
      totalBytes,
      downloadedBytes,
      speed,
      connections: 1
    })
  }

  /** 完成进度(终态);video 可带真实终路径 savePath(§4.3) */
  complete(filename: string, bytes: number, savePath?: string): void {
    const id = this.engineIdFor(filename)
    this.active.get(id)!.done = true
    this.emit({
      id,
      status: 'completed',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: 1,
      savePath
    })
  }

  /** BT 完成帧(按引擎 id 驱动,仿 emitTorrentInfo;磁力 addUri 不带 filename,engineIdFor 不可用) */
  completeTorrent(engineId: string, bytes: number): void {
    const rec = this.active.get(engineId)
    if (rec) {
      rec.done = true
    }
    this.emit({
      id: engineId,
      status: 'completed',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: 1
    })
  }

  /** 视频后处理阶段进度(phase:'processing',status 仍 downloading,§4.3) */
  processing(filename: string): void {
    this.emit({
      id: this.engineIdFor(filename),
      status: 'downloading',
      phase: 'processing',
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      connections: 0
    })
  }

  /** 失败进度(终态) */
  fail(filename: string, errorCode: string): void {
    const id = this.engineIdFor(filename)
    this.active.get(id)!.done = true
    this.emit({
      id,
      status: 'error',
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      connections: 0,
      errorCode
    })
  }

  // ----- BT 测试驱动(v0.3 Task 1;torrent 任务无 filename,按引擎 id 直接驱动)-----

  /** 元数据阶段普通帧(无 torrentInfo;totalBytes = 元数据大小,验证不落库) */
  emitMetaFrame(engineId: string, metaBytes: number): void {
    this.emit({
      id: engineId,
      status: 'downloading',
      totalBytes: metaBytes,
      downloadedBytes: Math.floor(metaBytes / 2),
      speed: 10,
      connections: 2
    })
  }

  /** 元数据完成帧(带 torrentInfo,spec §5.3) */
  emitTorrentInfo(engineId: string, info: TorrentInfo): void {
    this.emit({
      id: engineId,
      status: 'downloading',
      totalBytes: info.totalBytes,
      downloadedBytes: 0,
      speed: 0,
      connections: 3,
      torrentInfo: info
    })
  }

  /** 按引擎 id 直接发完成帧(torrent 无 filename,绕过 engineIdFor) */
  completeById(engineId: string, bytes: number): void {
    const rec = this.active.get(engineId)
    if (rec) rec.done = true
    this.emit({
      id: engineId,
      status: 'completed',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: 1
    })
  }

  /** BT 做种帧(v0.3 Task 3):100%（status 仍 downloading,做种期 aria2 停 active)+ seeding:true + 上行富进度 */
  emitSeeding(
    engineId: string,
    bytes: number,
    opts: {
      uploadSpeed?: number
      uploadLength?: number
      numSeeders?: number
      connections?: number
    } = {}
  ): void {
    this.emit({
      id: engineId,
      status: 'downloading',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: opts.connections ?? 4,
      seeding: true,
      uploadSpeed: opts.uploadSpeed ?? 5000,
      uploadLength: opts.uploadLength ?? 12345,
      numSeeders: opts.numSeeders ?? 3
    })
  }
}

// ==================== 可控 FakeVideoResolver ====================

const SINGLE_VIDEO: ResolvedVideo = {
  kind: 'video',
  id: 'abc',
  title: 'My: Cool Video?', // 含 Windows 非法字符 : ? → 验证清洗
  durationSec: 100,
  thumbnail: null,
  extractor: 'youtube',
  webpageUrl: 'https://youtu.be/abc',
  formats: [
    {
      formatId: '137',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'avc1',
      acodec: 'none', // 纯视频 → 选它触发 +bestaudio 合并(merge)
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
      acodec: 'mp4a.40.2', // muxed
      filesize: 200,
      tbr: null,
      formatNote: '360p'
    }
  ],
  subtitles: []
}

const PLAYLIST: ResolvedPlaylist = {
  kind: 'playlist',
  title: 'My Playlist',
  entries: [
    { id: 'a', title: 'Ep A', url: 'https://youtu.be/a', durationSec: 60 },
    { id: 'b', title: 'Ep B', url: 'https://youtu.be/b', durationSec: 70 }
  ]
}

class FakeVideoResolver {
  readonly resolveCalls: string[] = []
  /** 默认产物;可经 resultFor 按 url 定制,或置 Error 触发失败 */
  result: ResolveResult | Error = SINGLE_VIDEO
  resultFor?: (url: string) => ResolveResult | Error

  async resolve(url: string): Promise<ResolveResult> {
    this.resolveCalls.push(url)
    // 模拟真实异步解析(yt-dlp 子进程):延后一个宏任务,使 addTask 先返回可观察的 resolving 态
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const r = this.resultFor ? this.resultFor(url) : this.result
    if (r instanceof Error) {
      throw r
    }
    return r
  }
}

// ==================== 测试夹具 ====================

interface Harness {
  manager: TaskManager
  engine: FakeEngine
  db: MockDb
  videoResolver: FakeVideoResolver
  progressEvents: Array<{
    id: string
    status: TaskStatus
    downloadedBytes: number
    totalBytes: number
  }>
}

interface HarnessOptions {
  videoResolver?: FakeVideoResolver
  getVideoPrefs?: () => VideoPrefs
  trashItem?: (path: string) => Promise<void>
  existsSync?: (path: string) => boolean
  delay?: (ms: number) => Promise<void>
  readDir?: (dir: string) => string[]
  /** 注入定制引擎(如 GatedAddUriEngine 模拟 addUri 挂起窗口);缺省用普通 FakeEngine */
  engine?: FakeEngine
  /** seed 类别行(Task 4 getKnownFileExts 测试;行 extensions 为 JSON 字符串,仿 DB 存储) */
  categoryRows?: unknown[]
  /** 托管副本拷贝 mock(v0.3 Task 1;缺省 no-op,不碰真实 fs) */
  copyFileSync?: (src: string, dest: string) => void
  /** 托管副本读取 mock(v0.3 Task 1;缺省返回固定假种子字节) */
  readFileSync?: (path: string) => Buffer
  /** 同步更名 mock(2026-07-25 修订四:<infoHash>.torrent → <种子名>.torrent;缺省 no-op 不碰真实 fs) */
  renameSync?: (oldPath: string, newPath: string) => void
  /** torrent 元数据硬超时毫秒(v0.3 Task 1 · spec §4.3;缺省不传 = 生产默认 10 分钟,测试不触发) */
  torrentMetadataTimeoutMs?: number
  /** 视频解析墙钟总超时毫秒(审计#1 · spec §6;缺省不传 = 生产默认 90s,测试注入小值触发超时) */
  resolveTimeoutMs?: number
}

function createHarness(maxConcurrent = 3, opts: HarnessOptions = {}): Harness {
  const engine = opts.engine ?? new FakeEngine()
  const db = new MockDb()
  db.categoryRows = opts.categoryRows ?? []
  const videoResolver = opts.videoResolver ?? new FakeVideoResolver()
  const manager = new TaskManager(
    {
      engine,
      videoResolver,
      getVideoPrefs: opts.getVideoPrefs,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      // 单元测试不碰真实 fs:no-op ensureDir(Phase 3 分类路由会 mkdir 目标目录;真实落盘见集成测试)
      ensureDir: () => {},
      trashItem: opts.trashItem,
      existsSync: opts.existsSync,
      // 默认 no-op delay:退避重试不真等(避免删除测试变慢);验证重试的用例显式注入
      delay: opts.delay ?? (async () => {}),
      // 默认空 readDir:视频前缀清理不碰真实 fs(避免误删机器真实文件);视频清理用例显式注入
      readDir: opts.readDir ?? (() => []),
      // v0.3 Task 1:托管副本拷贝 / 读取默认 mock(不碰真实 fs);.torrent 用例显式注入断言
      copyFileSync: opts.copyFileSync ?? (() => {}),
      readFileSync: opts.readFileSync ?? (() => Buffer.from('fake-torrent-bytes')),
      renameSync: opts.renameSync ?? (() => {})
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent,
      userDataDir: 'C:\\UserData',
      torrentMetadataTimeoutMs: opts.torrentMetadataTimeoutMs,
      resolveTimeoutMs: opts.resolveTimeoutMs
    }
  )
  const progressEvents: Harness['progressEvents'] = []
  manager.onProgress((p) =>
    progressEvents.push({
      id: p.id,
      status: p.status,
      downloadedBytes: p.downloadedBytes,
      totalBytes: p.totalBytes
    })
  )
  return { manager, engine, db, videoResolver, progressEvents }
}

/** 直接读 DB(经 DAO)断言落库真相,绕过内存覆盖 */
function persisted(db: MockDb, id: string): Task | null {
  return daoGetTask(db as unknown as TaskDaoDatabase, id)
}

/**
 * 让事件循环排空:完成 / 失败事件里的 triggerDequeue 是 fire-and-forget(handleEngineProgress
 * 不 await),其出队后的落库发生在 `await engine.addUri` 之后的微任务里;断言出队结果前需 flush。
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function statusesByFilename(db: MockDb): Record<string, TaskStatus> {
  return Object.fromEntries(db.rows.map((row) => [row.filename, row.status]))
}

// ==================== 测试 ====================

test('addTask 落库 queued 后立即出队为 downloading,只把业务信息下发引擎', async () => {
  const { manager, engine, db } = createHarness()

  await manager.start() // 空库,无恢复

  const id = await manager.addTask({
    kind: 'http',
    source: 'https://example.test/a.bin',
    filename: 'a.bin',
    dir: 'D:\\Downloads'
  })

  assert.ok(id, '应返回任务 id')

  // 引擎只收到业务信息(url / dir / filename),无任何字节进度(§7.4)
  assert.equal(engine.addUriCalls.length, 1)
  assert.deepEqual(engine.addUriCalls[0], {
    url: 'https://example.test/a.bin',
    dir: 'D:\\Downloads',
    filename: 'a.bin'
  })

  const row = persisted(db, id)
  assert.equal(row?.status, 'downloading', '出队后落库为 downloading')
  assert.ok(row?.startedAt, 'startedAt 应在首次开始时落库')
  assert.equal(row?.downloadedBytes, 0)
})

test('§4 落库边界:下载中瞬时字节仅内存 + 广播,DB 只一次性落 totalBytes', async () => {
  const { manager, engine, db, progressEvents } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })

  engine.emitProgress('a.bin', 40, 100, 1234)
  engine.emitProgress('a.bin', 80, 100, 1234)

  // DB:totalBytes 一次性落库;downloadedBytes 不随帧落库(§4 红线)
  const row = persisted(db, id)
  assert.equal(row?.totalBytes, 100, 'totalBytes 首次已知时落库')
  assert.equal(row?.downloadedBytes, 0, '下载中 downloadedBytes 不落库(仅内存)')
  assert.equal(row?.status, 'downloading')

  // 内存 / 广播:携带实时字节
  assert.equal(manager.getTask(id)?.downloadedBytes, 80, '内存持有实时字节')
  const last = progressEvents.at(-1)
  assert.equal(last?.downloadedBytes, 80, '广播携带实时字节')
})

test('totalBytes=0 过渡帧不清已知总大小(2026-07-25 真机修订:总大小不回退「未知」)', async () => {
  const { manager, engine } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.emitProgress('a.bin', 40, 100, 1234)
  engine.emitProgress('a.bin', 50, 0, 0) // 引擎过渡帧:totalLength 瞬时 0(如 BT unpause 后 piece 存储未就绪)

  assert.equal(manager.getTask(id)?.totalBytes, 100, '已知总大小不被 0 帧清掉')
  assert.equal(manager.getTask(id)?.downloadedBytes, 50, '字节进度照常推进')
})

test('完成事件:downloading → completed,落 completedAt 与 downloadedBytes=totalBytes', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.emitProgress('a.bin', 50, 200)
  engine.complete('a.bin', 200)

  const row = persisted(db, id)
  assert.equal(row?.status, 'completed')
  assert.ok(row?.completedAt, 'completedAt 非空')
  assert.equal(row?.downloadedBytes, 200, '完成时 downloadedBytes 落到 totalBytes')
  assert.equal(row?.totalBytes, 200)
})

test('并发控制:5 任务 maxConcurrent=3 → 3 downloading / 2 queued;完成 1 → FIFO 自动出队 1', async () => {
  const { manager, engine, db } = createHarness(3)
  await manager.start()

  const ids: string[] = []
  for (let i = 1; i <= 5; i++) {
    ids.push(
      await manager.addTask({ kind: 'http', source: `https://x/${i}.bin`, filename: `${i}.bin` })
    )
  }

  let statuses = statusesByFilename(db)
  const downloading = Object.values(statuses).filter((s) => s === 'downloading').length
  const queued = Object.values(statuses).filter((s) => s === 'queued').length
  assert.equal(downloading, 3, '应有 3 个 downloading')
  assert.equal(queued, 2, '应有 2 个 queued')
  // 前 3 个(FIFO)在下载
  assert.equal(statuses['1.bin'], 'downloading')
  assert.equal(statuses['2.bin'], 'downloading')
  assert.equal(statuses['3.bin'], 'downloading')
  assert.equal(statuses['4.bin'], 'queued')
  assert.equal(statuses['5.bin'], 'queued')

  // 完成第 1 个 → 释放槽位 → 第 4 个(FIFO)出队
  engine.complete('1.bin', 10)
  await tick() // 等完成事件里 fire-and-forget 的出队落库结束

  statuses = statusesByFilename(db)
  assert.equal(statuses['1.bin'], 'completed')
  assert.equal(statuses['4.bin'], 'downloading', '完成 1 个后下一个 queued 自动出队')
  assert.equal(statuses['5.bin'], 'queued', '仍受并发上限约束')
  assert.equal(engine.addUriCalls.length, 4, '共下发 4 次(1-3 初始 + 4 出队)')
})

test('暂停 / 恢复:pause → DB paused + engine.pause;resume → engine.resume + DB downloading', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const engineId = engine.addUriCalls.length > 0 ? 'eng_1' : ''

  await manager.pauseTask(id)
  assert.equal(persisted(db, id)?.status, 'paused')
  assert.deepEqual(engine.pauseCalls, [engineId], 'engine.pause 收到引擎 id')

  await manager.resumeTask(id)
  assert.equal(persisted(db, id)?.status, 'downloading')
  assert.deepEqual(engine.resumeCalls, [engineId], 'resume 优先走 engine.resume(已有 gid)')
})

test('单任务限速:setTaskLimit → engine.setTaskLimit 收到引擎 id + kbps(经 taskIdToEngineId 转换,不落库)', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  // 已出队 downloading → 映射 eng_1

  const frames: Array<{ id: string; limitKBps?: number }> = []
  manager.onProgress((p) => frames.push({ id: p.id, limitKBps: p.limitKBps }))

  await manager.setTaskLimit(id, 256)
  assert.deepEqual(
    engine.setTaskLimitCalls,
    [{ id: 'eng_1', kbps: 256 }],
    'engine.setTaskLimit 收到引擎内部 id(非 taskId)+ kbps'
  )
  // 内存存值 + 广播回显(2026-07-09:UI 保留当前限速值);不落库(运行时瞬时态,§7.3)
  assert.equal(manager.getTask(id)?.limitKBps, 256, '内存 task.limitKBps 存值(供 popover 回显)')
  assert.ok(
    frames.some((f) => f.id === id && f.limitKBps === 256),
    'setTaskLimit 广播帧带 limitKBps'
  )
  assert.equal(persisted(db, id)?.status, 'downloading', '限速不改任务状态、不落库')
})

test('单任务限速:未提交引擎的任务(无映射)→ 不调 engine.setTaskLimit(静默 no-op)', async () => {
  const { manager, engine } = createHarness()
  await manager.start()

  // 未知 taskId → taskIdToEngineId 无映射 → 不下发引擎
  await manager.setTaskLimit('nonexistent', 256)
  assert.equal(engine.setTaskLimitCalls.length, 0, '无引擎映射 → 静默 no-op(不抛)')
})

test('单任务限速第三态(v0.3 Task 4 · #25):setTaskLimit(id, null) → 清除覆盖(limitKBps=undefined)+ 广播,不落库', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.setTaskLimit(id, 256) // 先设任务级覆盖
  assert.equal(manager.getTask(id)?.limitKBps, 256, '前置:已有任务级覆盖 256')

  const frames: Array<{ id: string; limitKBps?: number }> = []
  manager.onProgress((p) => frames.push({ id: p.id, limitKBps: p.limitKBps }))

  await manager.setTaskLimit(id, null) // 「跟随全局」= 清除任务级覆盖
  assert.equal(
    manager.getTask(id)?.limitKBps,
    undefined,
    'null → 内存 limitKBps 清为 undefined(回落全局,非 0)'
  )
  assert.deepEqual(
    engine.setTaskLimitCalls[1],
    { id: 'eng_1', kbps: null },
    'null 原样透传引擎(语义由后端解释:video 回落全局 / aria2 下发 0)'
  )
  const own = frames.filter((f) => f.id === id)
  assert.ok(own.length >= 1, '清除后仍广播(供 UI 回显第三态)')
  assert.equal(own[own.length - 1].limitKBps, undefined, '广播帧 limitKBps 已清(不再是 256)')
  // 不落库(§7.2 / §7.4):限速全程运行时态,DB 行无限速字段、状态不受影响
  assert.equal(persisted(db, id)?.limitKBps, undefined, 'DB 行不含限速(全程不落库)')
  assert.equal(persisted(db, id)?.status, 'downloading', '限速三态不改任务状态')
})

test('满槽 resume:转 queued 排队;出队时复用引擎任务(resume 不新建,避免丢进度)(修复④)', async () => {
  const { manager, engine, db } = createHarness(2) // maxConcurrent=2
  await manager.start()

  const id1 = await manager.addTask({ kind: 'http', source: 'https://x/1.bin', filename: '1.bin' })
  await manager.addTask({ kind: 'http', source: 'https://x/2.bin', filename: '2.bin' })
  const id3 = await manager.addTask({ kind: 'http', source: 'https://x/3.bin', filename: '3.bin' })
  // id1/id2 downloading(eng_1/eng_2),id3 queued(满槽 2)

  // 暂停 id1 → 释放槽位 → id3 出队;此时 id2/id3 downloading,id1 paused(保留 eng_1 映射)
  await manager.pauseTask(id1)
  await tick()
  assert.equal(persisted(db, id1)?.status, 'paused')
  assert.equal(persisted(db, id3)?.status, 'downloading', 'id1 暂停 → id3 出队')

  // 满槽时继续 id1 → 不抢占,转 queued 排队(而非停在 paused)
  await manager.resumeTask(id1)
  assert.equal(persisted(db, id1)?.status, 'queued', '满槽 resume → queued 排队(修复④)')

  // 完成 id2 → 释放槽位 → 排队的 id1 出队;因 id1 本会话已有引擎任务(曾下载 / 暂停),
  // 出队走 resume 复用进度,而非 addUri 新建(否则引擎从头、丢进度 + 留孤儿任务)
  const addUriBefore = engine.addUriCalls.length
  engine.complete('2.bin', 100)
  await tick()
  assert.equal(persisted(db, id1)?.status, 'downloading', '槽位释放 → 排队的 id1 自动出队')
  assert.equal(
    engine.addUriCalls.length,
    addUriBefore,
    '出队复用 resume,不新建 addUri(避免从头丢进度)'
  )
  assert.ok(engine.resumeCalls.includes('eng_1'), 'resume 复用已有引擎任务 eng_1')
})

test('删除:engine.remove + DB 删除记录', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.removeTask(id)

  assert.deepEqual(engine.removeCalls, ['eng_1'])
  assert.equal(persisted(db, id), null, 'DB 无此记录')
  assert.equal(manager.getTask(id), null, '内存无此记录')
})

test('删除:completed + deleteFile=true → 成品移回收站(trashItem 被调)', async () => {
  const trashed: string[] = []
  // 成品在下载**完成后**才落盘(add 时目标不存在,不误触发 Task 3 查重);下同
  let onDisk = false
  const { manager, engine, db } = createHarness(3, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    existsSync: () => onDisk
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const savePath = manager.getTask(id)!.savePath
  engine.complete('a.bin', 100)
  await tick()
  onDisk = true // 成品已落盘
  assert.equal(persisted(db, id)?.status, 'completed', '任务已完成')

  await manager.removeTask(id, { deleteFile: true })

  assert.deepEqual(trashed, [savePath], '成品 savePath 移入回收站')
  assert.equal(persisted(db, id), null, 'DB 无此记录')
})

test('删除:completed 默认(!deleteFile)仅移记录,保留成品(零回归,不调 trashItem)', async () => {
  const trashed: string[] = []
  let onDisk = false
  const { manager, engine, db } = createHarness(3, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    existsSync: () => onDisk
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.complete('a.bin', 100)
  await tick()
  onDisk = true

  await manager.removeTask(id) // 缺省 deleteFile=false

  assert.deepEqual(trashed, [], 'completed 默认不删文件(成品保留)')
  assert.equal(persisted(db, id), null, 'DB 记录仍被移除')
  assert.equal(manager.getTask(id), null, '内存记录已移除')
})

test('删除:未完成任务清残留(savePath / .part / .aria2 存在者 → 回收站)', async () => {
  const trashed: string[] = []
  let onDisk = false // 残留在下载启动后才出现,创建期不虚构无穷多个 control
  const { manager, engine, db } = createHarness(3, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    // 本体不存在(仅部分),.part / .aria2 存在 → 只清存在者
    existsSync: (p) => onDisk && (p.endsWith('.part') || p.endsWith('.aria2'))
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const savePath = manager.getTask(id)!.savePath // downloading(未完成)
  onDisk = true
  assert.equal(manager.getTask(id)?.status, 'downloading', '任务处于未完成态')

  await manager.removeTask(id)

  assert.deepEqual(engine.removeCalls, ['eng_1'], '引擎侧删除(停进程)')
  assert.deepEqual(
    trashed.sort(),
    [savePath + '.aria2', savePath + '.part'].sort(),
    '仅存在的残留(.part / .aria2)移回收站,不存在的本体跳过'
  )
  assert.equal(persisted(db, id), null, 'DB 记录已移除')
})

test('删除:trashItem 失败(best-effort)仍删记录不抛', async () => {
  let onDisk = false
  const { manager, engine, db } = createHarness(3, {
    trashItem: async () => {
      throw new Error('跨盘不可移入回收站')
    },
    existsSync: () => onDisk
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.complete('a.bin', 100)
  await tick()
  onDisk = true

  await manager.removeTask(id, { deleteFile: true }) // 不抛

  assert.equal(persisted(db, id), null, 'trashItem 失败仍移除 DB 记录')
  assert.equal(manager.getTask(id), null, 'trashItem 失败仍移除内存记录')
  assert.ok(engine, '未抛异常')
})

test('删除:downloading 残留首次撞文件锁(trashItem 抛 EBUSY)→ 退避重试后成功清入回收站(修复:记录已删残留还在)', async () => {
  const trashed: string[] = []
  const attemptsByPath = new Map<string, number>()
  let onDisk = false // 残留在下载**启动后**才出现(add 时目标不存在,不误触发查重)
  const { manager, engine, db } = createHarness(3, {
    existsSync: () => onDisk, // 残留(本体 / .part / .aria2)都存在
    // 模拟 aria2 未释放句柄:每个残留首次 trashItem 抛(Windows 文件锁),重试成功
    trashItem: async (p) => {
      const n = (attemptsByPath.get(p) ?? 0) + 1
      attemptsByPath.set(p, n)
      if (n === 1) throw new Error('EBUSY: resource busy or locked')
      trashed.push(p)
    },
    delay: async () => {} // no-op:退避重试不真等
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const savePath = manager.getTask(id)!.savePath
  onDisk = true // 下载中残留出现
  assert.equal(manager.getTask(id)?.status, 'downloading', '未完成态(下载中)')

  await manager.removeTask(id)

  // 三个残留各自首次撞锁、退避重试后全部成功移入回收站(不再残留磁盘)
  assert.deepEqual(
    trashed.sort(),
    [savePath, savePath + '.aria2', savePath + '.part'].sort(),
    '首次被占用的残留经退避重试后全部成功清入回收站'
  )
  assert.equal(persisted(db, id), null, 'DB 记录已移除')
  assert.ok(engine.removeCalls.includes('eng_1'), 'engine.remove 停进程(不碰续传核心)')
})

test('删除:未完成视频任务清 yt-dlp 分片残留(同目录 <stem>. 前缀匹配 → 回收站,§4)', async () => {
  const trashed: string[] = []
  let stem = '' // removeTask 前置为真实 outputBase(闭包供 readDir mock)
  const { manager, engine, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    existsSync: () => true,
    trashItem: async (p) => {
      trashed.push(p)
    },
    // 同目录残留:yt-dlp 分片(.fXXX.* / .part,与最终 savePath 不同名)+ 前缀边界外的无关文件
    readDir: () => [
      `${stem}.f298.mp4.part`, // 视频轨分片(下载中,正是用户实测残留形态)
      `${stem}.f299.mp4`, // 视频轨分片(已下完)
      `${stem}.f140.m4a`, // 音频轨分片
      `${stem}.mp4.part`, // 合并前半成品
      'unrelated.mp4', // 无关文件(不清)
      `${stem}X.mp4` // 前缀边界外(<stem> 后非 '.',不误删)
    ]
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  const task = manager.getTask(id)!
  assert.equal(task.status, 'downloading', '视频任务未完成态(下载中)')
  assert.equal(task.kind, 'video')
  const dir = dirname(task.savePath)
  stem = basename(task.savePath).replace(/\.[^.]+$/, '') // outputBase(= yt-dlp 中间文件前缀)

  await manager.removeTask(id)

  // 所有 <stem>. 前缀的分片 / part 清入回收站;无关 / 边界外文件不动
  const expected = [
    `${stem}.f298.mp4.part`,
    `${stem}.f299.mp4`,
    `${stem}.f140.m4a`,
    `${stem}.mp4.part`
  ].map((n) => join(dir, n))
  assert.deepEqual(
    trashed.sort(),
    expected.sort(),
    'yt-dlp 分片 / part 全清;unrelated 与 <stem>X 边界外不误删'
  )
  assert.ok(engine.removeCalls.includes('eng_1'), 'engine.remove 停进程(不碰续传核心)')
})

test('错误 + 重试:error 落库 error 字段;retry → queued → 重新下发 → 可再完成', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.fail('a.bin', 'CODE_403')

  let row = persisted(db, id)
  assert.equal(row?.status, 'error')
  assert.equal(row?.error, 'CODE_403', 'error 字段非空并落库')

  await manager.retryTask(id)
  row = persisted(db, id)
  assert.equal(row?.status, 'downloading', 'retry 清 error → queued → 出队 downloading')
  assert.equal(row?.error, null, 'error 字段已清空')
  assert.equal(engine.addUriCalls.length, 2, 'retry 重新下发引擎')

  engine.complete('a.bin', 5)
  assert.equal(persisted(db, id)?.status, 'completed', '重试后可正常完成')
})

test('非法流转防护:pause 一个 queued 任务抛错且不改库', async () => {
  const { manager, db } = createHarness(1)
  await manager.start()

  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' }) // downloading
  const queuedId = await manager.addTask({
    kind: 'http',
    source: 'https://x/b.bin',
    filename: 'b.bin'
  }) // queued(额满)

  assert.equal(persisted(db, queuedId)?.status, 'queued')
  await assert.rejects(() => manager.pauseTask(queuedId), /不可暂停/)
  assert.equal(persisted(db, queuedId)?.status, 'queued', '非法流转不改库')
})

test('addUri 失败 → 预占的 downloading 直接落为 error', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()

  engine.failNextAddUri = true
  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })

  const row = persisted(db, id)
  assert.equal(row?.status, 'error', '下发失败落 error')
  assert.ok(row?.error, 'error 信息非空')
})

test('重启恢复:读库 → downloading/queued 重提交、paused 保持、completed/error 不提交', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()

  // 预置库(模拟上次运行落库的历史)
  const seed = (overrides: Partial<Task>): Task => ({
    id: overrides.id!,
    kind: 'http',
    source: `https://x/${overrides.filename}`,
    status: 'queued',
    filename: overrides.filename!,
    savePath: `D:\\Downloads\\${overrides.filename}`,
    category: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    ...overrides
  })
  // 直接经 DAO 落库,保证序列化一致
  const { insertTask } = await import('../db/taskDao')
  insertTask(
    db as unknown as TaskDaoDatabase,
    seed({ id: 't-dl', filename: 'dl.bin', status: 'downloading', createdAt: 1 })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seed({ id: 't-q', filename: 'q.bin', status: 'queued', createdAt: 2 })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seed({ id: 't-p', filename: 'p.bin', status: 'paused', createdAt: 3 })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seed({ id: 't-c', filename: 'c.bin', status: 'completed', createdAt: 4 })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seed({ id: 't-e', filename: 'e.bin', status: 'error', createdAt: 5 })
  )

  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {} // 单元测试不碰真实 fs(Phase 3 分类路由 mkdir)
    },
    { dbPath: 'mock.db', defaultDir: 'D:\\Downloads', maxConcurrent: 3 }
  )
  await manager.start()

  // downloading + queued(2 个,受 maxConcurrent=3 内)重提交;paused / completed / error 不提交
  const resubmitted = engine.addUriCalls.map((call) => call.filename).sort()
  assert.deepEqual(resubmitted, ['dl.bin', 'q.bin'], '仅未完成的 downloading/queued 重提交续传')

  const statuses = statusesByFilename(db)
  assert.equal(statuses['dl.bin'], 'downloading')
  assert.equal(statuses['q.bin'], 'downloading', 'queued 恢复后出队为 downloading')
  assert.equal(statuses['p.bin'], 'paused', 'paused 保持暂停语义')
  assert.equal(statuses['c.bin'], 'completed', 'completed 仅作历史')
  assert.equal(statuses['e.bin'], 'error', 'error 仅作历史')
})

// ==================== Task 5:视频任务生命周期(spec §4.4)====================

/** 排空多级 fire-and-forget 链(resolve → onResolved → applySelection → dequeue → addUri) */
async function flush(): Promise<void> {
  await tick()
  await tick()
}

test('addTask(kind:video):落库 resolving + 异步触发解析(不阻塞返回)', async () => {
  const { manager, db, videoResolver } = createHarness()
  await manager.start()

  const id = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/abc',
    dir: 'D:\\Downloads'
  })

  // 立即返回时:状态 resolving(尚未解析完),videoMeta 仍空
  assert.equal(manager.getTask(id)?.status, 'resolving', '视频任务先进 resolving')
  assert.equal(persisted(db, id)?.status, 'resolving', 'resolving 落库')
  assert.equal(persisted(db, id)?.kind, 'video')

  await flush()
  assert.deepEqual(
    videoResolver.resolveCalls,
    ['https://youtu.be/abc'],
    '异步调用 VideoResolver.resolve'
  )
})

test('解析成功(单视频,无默认清晰度):resolving → awaiting_selection + resolvedMap 有 formats + videoMeta.title 落库', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  assert.equal(manager.getTask(id)?.status, 'awaiting_selection', '解析完成 → 待选')
  assert.equal(persisted(db, id)?.status, 'awaiting_selection')
  assert.equal(
    persisted(db, id)?.videoMeta?.title,
    'My: Cool Video?',
    'videoMeta.title 落库(原始标题)'
  )

  const resolved = manager.getResolved(id)
  assert.ok(resolved && resolved.kind === 'video', 'resolvedMap 持有瞬时解析结果')
  if (resolved?.kind === 'video') {
    assert.equal(resolved.formats.length, 2, 'formats 在内存(供格式对话框,不落库)')
  }
})

test('解析成功 + 占位默认清晰度:自动选(heightCap)→ 跳过 awaiting,直接 queued → 下发视频后端', async () => {
  const { manager, engine, videoResolver, progressEvents } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false })
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  // 自动选:从未进入 awaiting_selection
  assert.equal(
    progressEvents.some((e) => e.status === 'awaiting_selection'),
    false,
    '默认清晰度已设 → 跳过格式对话框(不经 awaiting_selection)'
  )
  assert.equal(manager.getTask(id)?.status, 'downloading', '自动选 → queued → 出队 downloading')
  assert.equal(
    manager.getTask(id)?.videoMeta?.qualityLabel,
    '360P',
    '#30 清晰度归一:自动选 heightCap=720、视频有 1080/360 → 归一为实际最高 360P(与手选 360P 同 stem → 查重命中)'
  )
  assert.equal(engine.addUriCalls.length, 1, '下发引擎一次')
  assert.equal(
    engine.addUriCalls[0].video?.formatSelector,
    'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '带 heightCap 策略选择器路由到视频后端'
  )
})

test('解析失败:resolving → error,落可读中文文案', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = new Error('该链接暂不支持解析(站点未适配或非视频页),可尝试作为直链下载')
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://x/notvideo' })
  await flush()

  const row = persisted(db, id)
  assert.equal(row?.status, 'error', '解析失败 → error')
  assert.match(row?.error ?? '', /暂不支持|直链/, '落可读中文文案')
})

// ============ 审计#1:视频解析总超时 + 删除中止(spec §6)============

/**
 * 解析器:记录收到的 signal,永不主动 resolve(挂起);signal.abort → reject 超时
 * (模拟真实链路 ytdlpProcess 被树杀 → exitCode null → mapResolveError 超时文案)。
 */
class HangingResolver {
  readonly signals: AbortSignal[] = []
  readonly resolveCalls: string[] = []
  async resolve(url: string, signal?: AbortSignal): Promise<ResolveResult> {
    this.resolveCalls.push(url)
    if (signal) this.signals.push(signal)
    return new Promise<ResolveResult>((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(new Error('获取视频信息超时,请检查网络后重试'))
      )
      // 永不主动 resolve:模拟慢站 / 代理黑洞挂起,只能靠 abort(超时 / 删除)结束
    })
  }
}

test('审计#1 解析总超时:超时 → abort → resolving 转 error(「超时」文案);signal 被 abort(树杀防 orphan)', async () => {
  const resolver = new HangingResolver()
  const { manager, db } = createHarness(3, {
    videoResolver: resolver as unknown as FakeVideoResolver,
    resolveTimeoutMs: 20 // 注入小超时(生产 90s)
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://slow/site' })
  await tick() // triggerResolve 建 controller + 调 resolve(捕获 signal)
  assert.equal(manager.getTask(id)?.status, 'resolving', '未超时前停在 resolving')
  assert.equal(resolver.signals.length, 1, 'resolve 收到真 signal(接活 AbortSignal 管线)')

  // 等超时触发 abort → resolver reject → onResolveError → error
  await new Promise((r) => setTimeout(r, 40))

  assert.equal(
    manager.getTask(id)?.status,
    'error',
    '超时 → resolving 转 error(不再无限 resolving)'
  )
  assert.match(persisted(db, id)?.error ?? '', /超时/, '落可读「超时」文案')
  assert.equal(resolver.signals[0].aborted, true, 'signal 被 abort(→ ytdlpProcess 树杀防 orphan)')
})

test('审计#1 正常解析(超时前完成)不被误杀:settle 清 timer,不 abort', async () => {
  const { manager, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    resolveTimeoutMs: 5000 // 大超时,正常解析(setTimeout 0)先完成
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  // 正常解析完成 → 自动选 → downloading;若被误 abort 会落 error
  assert.equal(manager.getTask(id)?.status, 'downloading', '正常解析超时前完成,不被误杀')
})

test('审计#1 删除 resolving 任务 → abort 解析(controller.abort,防孤儿 yt-dlp -J);map 清理', async () => {
  const resolver = new HangingResolver()
  const { manager } = createHarness(3, {
    videoResolver: resolver as unknown as FakeVideoResolver
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://slow/site' })
  await tick() // resolve 被调,signal 捕获
  assert.equal(resolver.signals.length, 1)
  assert.equal(resolver.signals[0].aborted, false, '删除前 signal 未 abort')

  await manager.removeTask(id)

  assert.equal(
    resolver.signals[0].aborted,
    true,
    '删除 resolving 任务 → controller.abort()(中止解析防孤儿)'
  )
  assert.equal(manager.getTask(id), null, '任务已删除')
})

test('selectFormat:写 videoMeta.selectedFormat/postProcess + 重算 filename(清洗)+ queued + 出队下发视频后端', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush() // → awaiting_selection

  // 选 1080p(format 137,纯视频)→ +bestaudio 合并
  await manager.selectFormat(id, { audioOnly: false, formatId: '137' })

  const row = persisted(db, id)
  assert.equal(
    row?.videoMeta?.selectedFormat,
    '137+bestaudio/137',
    'video-only formatId → +bestaudio 合并选择器'
  )
  assert.equal(row?.videoMeta?.postProcess, 'merge', '需合并 → postProcess=merge')
  assert.equal(
    row?.videoMeta?.qualityLabel,
    '1080P',
    '手选 format 137(height=1080)→ 精确清晰度标签(§3.1)'
  )
  assert.equal(
    row?.filename,
    'My_ Cool Video_ [1080p].mp4',
    'filename = 标题清洗(§7.7)+ 清晰度标签 [1080p] + 预测 ext(merge→mp4)'
  )
  assert.equal(row?.status, 'downloading', '选定 → queued → 出队 downloading')

  // 出队提交带 video(路由到视频后端)
  assert.equal(engine.addUriCalls.length, 1)
  assert.equal(
    engine.addUriCalls[0].video?.formatSelector,
    '137+bestaudio/137',
    'toAddUriInput 带 video 分支'
  )
  assert.equal(engine.addUriCalls[0].filename, 'My_ Cool Video_ [1080p].mp4')
})

test('selectFormat(仅音频):postProcess=mp3 + filename 预测 mp3', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  await manager.selectFormat(id, { audioOnly: true })

  const row = persisted(db, id)
  assert.equal(row?.videoMeta?.selectedFormat, 'bestaudio/best')
  assert.equal(row?.videoMeta?.postProcess, 'mp3')
  assert.equal(row?.videoMeta?.qualityLabel, '仅音频 MP3', 'audioOnly → 仅音频 MP3 标签(§3.1)')
  assert.equal(row?.filename, 'My_ Cool Video_.mp3', 'audioOnly → ext 预测 mp3')
  assert.equal(engine.addUriCalls[0].video?.audioOnly, true, '视频提交 audioOnly=true')
})

test('#24 fragmented:手选 HLS(m3u8_native)format → videoMeta.fragmented=true + 引擎收 video.fragmented(不挂 aria2c,spec §2)', async () => {
  const { manager, engine, videoResolver } = createHarness()
  videoResolver.result = {
    ...SINGLE_VIDEO,
    formats: [
      {
        formatId: 'hls',
        ext: 'mp4',
        height: 1080,
        fps: 30,
        vcodec: 'avc1',
        acodec: 'mp4a.40.2',
        filesize: 1000,
        tbr: null,
        formatNote: '1080p',
        protocol: 'm3u8_native'
      }
    ]
  }
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://x/hls' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: 'hls' })

  assert.equal(
    manager.getTask(id)?.videoMeta?.fragmented,
    true,
    '选中 HLS m3u8_native → videoMeta.fragmented=true'
  )
  assert.equal(
    engine.addUriCalls[0].video?.fragmented,
    true,
    '重建 VideoSubmit.fragmented 透传引擎(useAccel &&= !fragmented → 不挂 aria2c)'
  )
})

test('#24 progressive(https)format → videoMeta 不含 fragmented(保守挂 aria2c,§7.1 回退不退化)', async () => {
  const { manager, engine, videoResolver } = createHarness()
  videoResolver.result = {
    ...SINGLE_VIDEO,
    formats: [
      {
        formatId: 'prog',
        ext: 'mp4',
        height: 720,
        fps: 30,
        vcodec: 'avc1',
        acodec: 'mp4a.40.2',
        filesize: 1000,
        tbr: null,
        formatNote: '720p',
        protocol: 'https'
      }
    ]
  }
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://x/prog' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: 'prog' })

  assert.equal(
    manager.getTask(id)?.videoMeta?.fragmented,
    undefined,
    'progressive → 不存 fragmented(保守挂 aria2c)'
  )
  assert.equal(
    engine.addUriCalls[0].video?.fragmented,
    undefined,
    '引擎收 fragmented undefined(保守挂 + 回退,零回归)'
  )
})

test('qualityLabel 持久化往返:videoMeta JSON 序列化 / 反序列化保留 qualityLabel(§3.1)', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: '18' }) // 360p muxed

  // 落库为真实 JSON 字符串(MockDb 存 insertTask/updateTask 序列化后的列值)
  const raw = db.rows.find((r) => r.id === id)!.videoMeta as unknown as string
  assert.match(raw, /"qualityLabel":"360P"/, 'DB videoMeta 列含序列化后的 qualityLabel')

  // 经 daoGetTask 反序列化往返后字段仍在
  assert.equal(persisted(db, id)?.videoMeta?.qualityLabel, '360P', '反序列化往返保留 qualityLabel')
})

test('视频进度:phase:processing → processing;completed(from processing)+ 真实 savePath 写库', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: '137' })
  const fn = manager.getTask(id)!.filename // 'My_ Cool Video_.mp4'

  engine.emitProgress(fn, 500, 1000)
  assert.equal(manager.getTask(id)?.status, 'downloading')

  engine.processing(fn)
  assert.equal(manager.getTask(id)?.status, 'processing', 'phase:processing → processing')
  assert.equal(persisted(db, id)?.status, 'processing', 'processing 落库')

  engine.complete(fn, 1000, 'D:\\Downloads\\My_ Cool Video_.mkv') // yt-dlp 真实终路径(ext 不同)
  const row = persisted(db, id)
  assert.equal(row?.status, 'completed', 'processing → completed')
  assert.equal(row?.savePath, 'D:\\Downloads\\My_ Cool Video_.mkv', '真实 savePath 写库')
  assert.equal(row?.filename, 'My_ Cool Video_.mkv', 'filename 同步为真实落盘名')
})

test('视频进度:无后处理(muxed)→ downloading 直接 completed(状态机两路均合法)', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: '18' }) // muxed,无需合并
  const fn = manager.getTask(id)!.filename

  engine.emitProgress(fn, 100, 200)
  engine.complete(fn, 200) // 无 phase:processing,直接完成
  assert.equal(persisted(db, id)?.status, 'completed', 'downloading 直接 → completed')
})

test('retryTask:视频已选格式 → queued 重下;未选(解析失败)→ resolving 重解析', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  await manager.start()

  // 情形 A:解析失败的视频任务 → retry 回 resolving 重解析
  videoResolver.result = new Error('解析失败,站点可能已改版(可尝试更新 yt-dlp)')
  const idA = await manager.addTask({ kind: 'video', source: 'https://x/a' })
  await flush()
  assert.equal(persisted(db, idA)?.status, 'error')

  videoResolver.result = SINGLE_VIDEO // 重解析这次成功
  await manager.retryTask(idA)
  assert.equal(manager.getTask(idA)?.status, 'resolving', '未选格式的视频重试 → resolving(重解析)')
  await flush()
  assert.equal(
    manager.getTask(idA)?.status,
    'awaiting_selection',
    '重解析成功 → awaiting_selection'
  )

  // 情形 B:已选格式后下载失败 → retry 回 queued 重下(用持久化 selectedFormat)
  videoResolver.result = SINGLE_VIDEO
  const idB = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(idB, { audioOnly: false, formatId: '18' })
  const fnB = manager.getTask(idB)!.filename
  engine.fail(fnB, 'CODE_X')
  assert.equal(persisted(db, idB)?.status, 'error')

  await manager.retryTask(idB)
  await flush()
  assert.equal(manager.getTask(idB)?.status, 'downloading', '已选格式的视频重试 → queued → 重下')
})

test('重启恢复(视频态):resolving/awaiting → 重解析;downloading(video)→ 重提交;paused 保持', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const videoResolver = new FakeVideoResolver()
  videoResolver.result = SINGLE_VIDEO

  const seedVideo = (overrides: Partial<Task>): Task => ({
    id: overrides.id!,
    kind: 'video',
    source: `https://youtu.be/${overrides.id}`,
    status: 'resolving',
    filename: overrides.filename ?? `${overrides.id}.mp4`,
    savePath: `D:\\Downloads\\${overrides.filename ?? `${overrides.id}.mp4`}`,
    category: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    ...overrides
  })

  const { insertTask } = await import('../db/taskDao')
  insertTask(
    db as unknown as TaskDaoDatabase,
    seedVideo({ id: 'v-resolving', status: 'resolving', createdAt: 1 })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seedVideo({
      id: 'v-awaiting',
      status: 'awaiting_selection',
      createdAt: 2,
      videoMeta: { title: 'T', selectedFormat: '', postProcess: 'none', playlistIndex: -1 }
    })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seedVideo({
      id: 'v-dl',
      filename: 'dl.mp4',
      status: 'downloading',
      createdAt: 3,
      videoMeta: {
        title: 'DL',
        selectedFormat: '137+bestaudio/137',
        postProcess: 'merge',
        playlistIndex: -1
      }
    })
  )
  insertTask(
    db as unknown as TaskDaoDatabase,
    seedVideo({
      id: 'v-paused',
      filename: 'paused.mp4',
      status: 'paused',
      createdAt: 4,
      videoMeta: { title: 'P', selectedFormat: 'best', postProcess: 'none', playlistIndex: -1 }
    })
  )

  const manager = new TaskManager(
    {
      engine,
      videoResolver,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {} // 单元测试不碰真实 fs(Phase 3 分类路由 mkdir)
    },
    { dbPath: 'mock.db', defaultDir: 'D:\\Downloads', maxConcurrent: 3 }
  )
  await manager.start()
  await flush()

  // resolving / awaiting → 重解析(re-resolve)
  assert.ok(videoResolver.resolveCalls.includes('https://youtu.be/v-resolving'), 'resolving 重解析')
  assert.ok(
    videoResolver.resolveCalls.includes('https://youtu.be/v-awaiting'),
    'awaiting 重解析(formats 已丢)'
  )

  // downloading(video)→ 重提交,带持久化的 video 提交参数(.part 续传)
  const dlSubmit = engine.addUriCalls.find((c) => c.filename === 'dl.mp4')
  assert.ok(dlSubmit, 'downloading 视频任务重提交')
  assert.equal(
    dlSubmit?.video?.formatSelector,
    '137+bestaudio/137',
    '用持久化 selectedFormat 重建 video 提交'
  )

  // paused 保持暂停,不重提交
  assert.equal(persisted(db, 'v-paused')?.status, 'paused', 'paused 视频保持暂停')
  assert.equal(
    engine.addUriCalls.some((c) => c.filename === 'paused.mp4'),
    false,
    'paused 不重提交'
  )
})

test('解析成功(playlist):resolving → awaiting_selection + resolvedMap 为 playlist(批量对话框,§7)', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = PLAYLIST
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/playlist?list=PL' })
  await flush()

  assert.equal(manager.getTask(id)?.status, 'awaiting_selection', 'playlist → 待选(批量)')
  assert.equal(persisted(db, id)?.videoMeta?.title, 'My Playlist', 'playlist 标题落库')
  const resolved = manager.getResolved(id)
  assert.equal(resolved?.kind, 'playlist', 'resolvedMap 持有 playlist entries(供批量对话框)')
})

test('http 任务零回归:addTask(http) 不触发解析、提交载荷无 video 字段', async () => {
  const { manager, engine, videoResolver } = createHarness()
  await manager.start()

  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })

  assert.deepEqual(videoResolver.resolveCalls, [], 'http 不调用 VideoResolver')
  assert.equal(engine.addUriCalls.length, 1)
  assert.deepEqual(
    Object.keys(engine.addUriCalls[0]).sort(),
    ['dir', 'filename', 'url'],
    'http 提交载荷只有业务信息(无 video,aria2 无感)'
  )
})

// ==================== 播放列表批量展开(submitBatch,§7.3)====================

/** 5 条目播放列表(供并发约束验证) */
const BIG_PLAYLIST: ResolvedPlaylist = {
  kind: 'playlist',
  title: 'Big List',
  entries: [
    { id: 'e0', title: 'Ep 0', url: 'https://youtu.be/e0', durationSec: 60 },
    { id: 'e1', title: 'Ep: 1?', url: 'https://youtu.be/e1', durationSec: 61 }, // 含非法字符验证清洗
    { id: 'e2', title: 'Ep 2', url: 'https://youtu.be/e2', durationSec: 62 },
    { id: 'e3', title: 'Ep 3', url: 'https://youtu.be/e3', durationSec: 63 },
    { id: 'e4', title: 'Ep 4', url: 'https://youtu.be/e4', durationSec: 64 }
  ]
}

/** 统一策略 → 每条 pick 同值 choice(批量对话框语义) */
function batchPicks(indexes: number[], choice: BatchPick['choice']): BatchPick[] {
  return indexes.map((entryIndex) => ({ entryIndex, choice }))
}

test('submitBatch:展开为 N 个归一 kind:video 子任务(source/videoMeta/策略选择器)+ 移除父占位', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = PLAYLIST // 2 条目(Ep A / Ep B)
  await manager.start()

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=PL'
  })
  await flush() // → awaiting_selection(playlist)

  await manager.submitBatch(parentId, batchPicks([0, 1], { audioOnly: false, heightCap: 720 }))
  await tick()

  // 父占位被移除(不落为下载任务)
  assert.equal(manager.getTask(parentId), null, '父占位任务展开后被 removeTask')
  assert.equal(persisted(db, parentId), null, '父任务从 DB 删除')

  // 两个归一子任务:kind video + source=entry.url + 策略选择器 + playlistIndex/title
  const children = db.rows.filter((r) => r.kind === 'video')
  assert.equal(children.length, 2, '勾选 2 条 → 2 个子任务')
  const epA = children.find((r) => r.source === 'https://youtu.be/a')
  const epB = children.find((r) => r.source === 'https://youtu.be/b')
  assert.ok(epA && epB, '两子任务 source 指向各自 entry.url')
  const metaA = JSON.parse(epA!.videoMeta!)
  assert.equal(metaA.title, 'Ep A', '子任务 videoMeta.title=entry.title')
  assert.equal(metaA.playlistIndex, 0, 'playlistIndex=entryIndex')
  assert.equal(
    metaA.selectedFormat,
    'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '统一清晰度策略 → 通用 heightCap 选择器(不逐条解析)'
  )
  assert.equal(metaA.postProcess, 'merge')
  assert.equal(metaA.qualityLabel, '≤720P', '批量(heightCap=720,无逐条 format)→ ≤720P 标签(§3.1)')
})

test('submitBatch:子任务进队受并发上限约束(5 勾选 / maxConcurrent=3 → 3 downloading + 2 queued)', async () => {
  const { manager, db, videoResolver } = createHarness(3)
  videoResolver.result = BIG_PLAYLIST
  await manager.start()

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=BIG'
  })
  await flush()

  await manager.submitBatch(
    parentId,
    batchPicks([0, 1, 2, 3, 4], { audioOnly: false, heightCap: 1080 })
  )
  await tick()

  const children = db.rows.filter((r) => r.kind === 'video')
  const downloading = children.filter((r) => r.status === 'downloading').length
  const queued = children.filter((r) => r.status === 'queued').length
  assert.equal(children.length, 5, '5 勾选 → 5 子任务')
  assert.equal(downloading, 3, 'maxConcurrent=3 → 3 downloading')
  assert.equal(queued, 2, '余 2 queued')
})

test('submitBatch:非法 entryIndex 单条隔离,不影响其他子任务创建', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = PLAYLIST // 仅 2 条目(index 0/1)
  await manager.start()

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=PL'
  })
  await flush()

  // index 99 越界 → 跳过;0 / 1 正常建
  await manager.submitBatch(parentId, batchPicks([0, 99, 1], { audioOnly: false, heightCap: 720 }))
  await tick()

  const children = db.rows.filter((r) => r.kind === 'video')
  assert.equal(children.length, 2, '越界条目跳过,其余正常创建(单条隔离)')
})

test('submitBatch(仅音频策略):子任务 postProcess=mp3 + 选择器 bestaudio', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = PLAYLIST
  await manager.start()

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=PL'
  })
  await flush()

  await manager.submitBatch(parentId, batchPicks([0], { audioOnly: true }))
  await tick()

  const child = db.rows.find((r) => r.kind === 'video')!
  const meta = JSON.parse(child.videoMeta!)
  assert.equal(meta.selectedFormat, 'bestaudio/best')
  assert.equal(meta.postProcess, 'mp3')
  assert.match(child.filename, /\.mp3$/, '仅音频 → 预测 ext mp3')
})

test('submitBatch:父非 playlist / 不存在 → 防御返回,不创建子任务', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO // 单视频,非 playlist
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush() // awaiting_selection(单视频)

  await manager.submitBatch(id, batchPicks([0], { audioOnly: false, heightCap: 720 }))
  await manager.submitBatch('nonexistent', batchPicks([0], { audioOnly: false, heightCap: 720 }))
  await tick()

  // 单视频父任务仍在(未被误删),无额外子任务
  assert.equal(
    manager.getTask(id)?.status,
    'awaiting_selection',
    '单视频父任务不受 submitBatch 影响'
  )
  assert.equal(db.rows.filter((r) => r.kind === 'video').length, 1, '仅原单视频任务,无批量子任务')
})

// ==================== 字幕承载(v0.2 Task 1 · spec §3.4 / §4.2:随 videoMeta 持久化 / 出队重建)====================

const SUBS: SubtitleChoice = { langs: ['zh-Hans', 'en'], format: 'srt', includeAuto: true }

test('selectFormat(带字幕):choice.subtitles → videoMeta.subtitle 落库 → rebuildVideoSubmit → engine 提交 video.subtitles', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush() // → awaiting_selection

  await manager.selectFormat(id, { audioOnly: false, formatId: '137', subtitles: SUBS })

  // 字幕选择随 videoMeta 持久化(任务级)
  assert.deepEqual(persisted(db, id)?.videoMeta?.subtitle, SUBS, 'videoMeta.subtitle 落库')
  // 出队重建 VideoSubmit → toAddUriInput.video.subtitles(链路打通:choice→videoMeta→rebuild→引擎)
  assert.deepEqual(
    engine.addUriCalls[0].video?.subtitles,
    SUBS,
    'rebuildVideoSubmit 透传字幕到引擎提交(供 buildYtDlpDownloadArgs 追加)'
  )
})

test('selectFormat(无字幕):videoMeta.subtitle undefined + 引擎提交无 subtitles(零回归)', async () => {
  const { manager, db, engine, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: '137' })

  assert.equal(
    persisted(db, id)?.videoMeta?.subtitle,
    undefined,
    '无字幕选择 → 不写 videoMeta.subtitle'
  )
  assert.equal(
    engine.addUriCalls[0].video?.subtitles,
    undefined,
    'VideoSubmit.subtitles undefined(args 零附加)'
  )
})

test('字幕持久化往返:videoMeta.subtitle JSON 序列化 / 反序列化保留(§4.2)', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  await manager.selectFormat(id, { audioOnly: false, formatId: '18', subtitles: SUBS })

  // 落库为真实 JSON 字符串(MockDb 存序列化后的列值)
  const raw = db.rows.find((r) => r.id === id)!.videoMeta as unknown as string
  assert.match(raw, /"subtitle":/, 'DB videoMeta 列含序列化后的 subtitle')
  assert.deepEqual(persisted(db, id)?.videoMeta?.subtitle, SUBS, '反序列化往返保留 subtitle')
})

test('autoSelectChoice 并入默认字幕偏好:设默认清晰度自动选(跳过对话框)也带默认字幕(§3.4)', async () => {
  const { manager, db, engine, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false, subtitle: SUBS })
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush() // 自动选跳过对话框 → queued → downloading

  assert.deepEqual(persisted(db, id)?.videoMeta?.subtitle, SUBS, '自动选并入默认字幕偏好')
  assert.deepEqual(engine.addUriCalls[0].video?.subtitles, SUBS, '自动选下发引擎带默认字幕')
})

test('autoSelectChoice(仅音频默认):不带字幕(§5.1 音频提取不配字幕)', async () => {
  const { manager, db, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: null, defaultAudioOnly: true, subtitle: SUBS })
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  assert.equal(
    persisted(db, id)?.videoMeta?.subtitle,
    undefined,
    '仅音频自动选 → 不写字幕(与 FormatDialog audioOnly 隐藏字幕区一致)'
  )
})

test('submitBatch(带字幕):pick.choice.subtitles → 每子任务 videoMeta.subtitle(批量字幕来源,§3.4)', async () => {
  const { manager, db, videoResolver } = createHarness()
  videoResolver.result = PLAYLIST
  await manager.start()

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=PL'
  })
  await flush()

  await manager.submitBatch(
    parentId,
    batchPicks([0, 1], { audioOnly: false, heightCap: 720, subtitles: SUBS })
  )
  await tick()

  const children = db.rows.filter((r) => r.kind === 'video')
  assert.equal(children.length, 2)
  for (const child of children) {
    assert.deepEqual(
      JSON.parse(child.videoMeta!).subtitle,
      SUBS,
      '每子任务 videoMeta.subtitle 承载批量字幕'
    )
  }
})

test('重启恢复(视频态带字幕):rebuildVideoSubmit 从持久化 videoMeta.subtitle 重建引擎提交字幕', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const videoResolver = new FakeVideoResolver()

  const { insertTask } = await import('../db/taskDao')
  insertTask(db as unknown as TaskDaoDatabase, {
    id: 'v-sub',
    kind: 'video',
    source: 'https://youtu.be/v-sub',
    status: 'downloading',
    filename: 'sub.mp4',
    savePath: 'D:\\Downloads\\sub.mp4',
    category: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: {
      title: 'S',
      selectedFormat: '137+bestaudio/137',
      postProcess: 'merge',
      playlistIndex: -1,
      subtitle: SUBS
    },
    torrentMeta: null,
    error: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null
  })

  const manager = new TaskManager(
    {
      engine,
      videoResolver,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    { dbPath: 'mock.db', defaultDir: 'D:\\Downloads', maxConcurrent: 3 }
  )
  await manager.start()
  await flush()

  const submit = engine.addUriCalls.find((c) => c.filename === 'sub.mp4')
  assert.ok(submit, 'downloading 视频任务重提交')
  assert.deepEqual(submit?.video?.subtitles, SUBS, '恢复重提交从 videoMeta.subtitle 重建字幕(§4.2)')
})

// ==================== Task 8:运行时调整并发 / 默认目录(spec §3.4 / §3.5)====================

test('setMaxConcurrent 调大 → 立即出队补足(排队任务拉起至新上限)', async () => {
  const { manager, db } = createHarness(2) // maxConcurrent=2
  await manager.start()

  // 4 个 http 任务:前 2 downloading,后 2 queued(满槽 2)
  for (let i = 1; i <= 4; i++) {
    await manager.addTask({ kind: 'http', source: `https://x/${i}.bin`, filename: `${i}.bin` })
  }
  let statuses = statusesByFilename(db)
  assert.equal(
    Object.values(statuses).filter((s) => s === 'downloading').length,
    2,
    '初始 2 downloading'
  )
  assert.equal(Object.values(statuses).filter((s) => s === 'queued').length, 2, '初始 2 queued')

  // 调大并发 2 → 4:立即出队补足,排队的 2 个拉起(fire-and-forget,tick 等其落库)
  manager.setMaxConcurrent(4)
  await tick()

  statuses = statusesByFilename(db)
  assert.equal(
    Object.values(statuses).filter((s) => s === 'downloading').length,
    4,
    '调大后 4 downloading(出队补足)'
  )
  assert.equal(Object.values(statuses).filter((s) => s === 'queued').length, 0, '排队任务全部出队')
})

test('setMaxConcurrent 调小:不中断运行中任务(超额者保持 downloading,§3.5)', async () => {
  const { manager, db } = createHarness(3)
  await manager.start()

  for (let i = 1; i <= 3; i++) {
    await manager.addTask({ kind: 'http', source: `https://x/${i}.bin`, filename: `${i}.bin` })
  }
  assert.equal(
    Object.values(statusesByFilename(db)).filter((s) => s === 'downloading').length,
    3,
    '初始 3 downloading'
  )

  // 调小 3 → 1:运行中的 3 个不被杀,保持 downloading(超额自然完成后才按新上限出队)
  manager.setMaxConcurrent(1)
  await tick()

  assert.equal(
    Object.values(statusesByFilename(db)).filter((s) => s === 'downloading').length,
    3,
    '调小不中断运行中任务'
  )
})

test('setDefaultDir:后续新任务用新默认目录兜底,已存任务不回迁(§7.4)', async () => {
  const { manager, engine, db } = createHarness() // harness defaultDir = D:\Downloads
  await manager.start()

  // 任务 A:旧默认目录兜底路由(无显式 dir、空类别 → other → defaultDir)
  const idA = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const callA = engine.addUriCalls.find((c) => c.filename === 'a.bin')!
  assert.equal(callA.dir, 'D:\\Downloads', 'A 路由到旧默认目录')

  // 运行时改默认目录
  manager.setDefaultDir('E:\\NewDownloads')

  // 任务 B:新默认目录兜底
  await manager.addTask({ kind: 'http', source: 'https://x/b.bin', filename: 'b.bin' })
  const callB = engine.addUriCalls.find((c) => c.filename === 'b.bin')!
  assert.equal(callB.dir, 'E:\\NewDownloads', '后续新任务 B 用新默认目录')

  // 已存任务 A 不回迁:savePath 仍在旧目录(§7.4 续传归属)
  assert.equal(persisted(db, idA)?.savePath, 'D:\\Downloads\\a.bin', 'A 不回迁到新目录')
})

test('速度口径:pause 后 broadcast 与 listTasks 的 speed 归 0(不残留暂停前速度,2026-07-09)', async () => {
  const { manager, engine } = createHarness()
  await manager.start()

  const id = await manager.addTask({
    kind: 'http',
    source: 'https://x/spd.bin',
    filename: 'spd.bin'
  })
  engine.emitProgress('spd.bin', 40, 100, 934000) // 下载中,速度 934KB/s

  const broadcasts: number[] = []
  manager.onProgress((p) => {
    if (p.id === id) broadcasts.push(p.speed)
  })

  await manager.pauseTask(id)
  assert.equal(
    broadcasts.at(-1),
    0,
    'pause 的 broadcast 帧 speed=0(修「已暂停仍显示速度=像在偷跑」)'
  )
  const row = manager.listTasks().find((t) => t.id === id)
  assert.equal(row?.status, 'paused')
  assert.equal(row?.speed, 0, 'listTasks 合并内存后 paused 任务 speed=0')
})

// ==================== 2026-07-11 审计修复:行为固化 ====================

/** addUri 可挂起的引擎:模拟「await engine.addUri 往返窗口」,窗口内可插入用户操作(pause/remove) */
class GatedAddUriEngine extends FakeEngine {
  private release: (() => void) | null = null
  /** 置 true 后,下一次 addUri 在注册任务前挂起,直到 releaseHeldAddUri() */
  holdNextAddUri = false

  releaseHeldAddUri(): void {
    this.release?.()
    this.release = null
  }

  override async addUri(input: AddUriInput): Promise<string> {
    if (this.holdNextAddUri) {
      this.holdNextAddUri = false
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    return super.addUri(input)
  }
}

test('删除:从未启动的任务(startedAt=null)零磁盘清理,不误动用户同名文件', async () => {
  const trashed: string[] = []
  let readDirCalled = false
  let onDisk = false // 同名文件在**任务提交后**才被视为存在(add 时不误触发查重;removal 早退不查磁盘)
  const { manager, engine } = createHarness(1, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    existsSync: () => onDisk, // 即便同名文件"存在"(用户自己的文件)也不该被碰
    readDir: () => {
      readDirCalled = true
      return ['watch.txt', 'watch.part'] // 模拟用户目录里恰有 URL 占位名前缀的无关文件
    }
  })
  await manager.start()

  // 场景 1:http 满槽排队(queued,从未提交引擎)→ 删除不碰磁盘
  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' }) // 占满 1 槽
  const id2 = await manager.addTask({ kind: 'http', source: 'https://x/b.bin', filename: 'b.bin' })
  onDisk = true // 提交后:即便用户目录里有同名文件,未启动任务的删除也不该触碰
  assert.equal(manager.getTask(id2)?.status, 'queued', '第二个任务排队(startedAt=null)')
  await manager.removeTask(id2)
  assert.deepEqual(trashed, [], 'queued 未启动:不移任何文件入回收站')
  assert.equal(engine.removeCalls.length, 0, '无引擎任务可删')

  // 场景 2:视频 resolving 期取消 —— filename 还是 URL 占位(`watch`),
  // 修复前按 `watch.` 前缀扫描会把用户的 watch.txt 移入回收站
  const vid = await manager.addTask({ kind: 'video', source: 'https://youtube.com/watch?v=x' })
  assert.equal(manager.getTask(vid)?.status, 'resolving', '视频解析中')
  await manager.removeTask(vid)
  assert.equal(readDirCalled, false, 'resolving 未启动:不做前缀扫描')
  assert.deepEqual(trashed, [], '用户的 watch.txt / watch.part 安然无恙')
  await tick() // 排空后台解析的微任务(任务已删,结果被状态守卫丢弃)
})

test('startReserved:addUri 窗口内 pauseTask → 保持 paused + 引擎补 pause 对齐(修复:暂停被吞+并发超额)', async () => {
  const gated = new GatedAddUriEngine()
  gated.holdNextAddUri = true
  const { manager, db } = createHarness(3, { engine: gated })
  await manager.start()

  const addPromise = manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await tick() // 走到 addUri 挂起点(任务已入库、内存预占 downloading,尚无引擎映射)
  const id = manager.listTasks()[0].id
  assert.equal(manager.getTask(id)?.status, 'downloading', '预占态')

  await manager.pauseTask(id) // 窗口内暂停:彼时无映射,engine.pause 无从下发
  assert.equal(manager.getTask(id)?.status, 'paused')

  gated.releaseHeldAddUri() // addUri 返回,startReserved 复查
  await addPromise
  await tick()

  assert.equal(manager.getTask(id)?.status, 'paused', '不被写回 downloading(修复前暂停被吞)')
  assert.equal(persisted(db, id)?.status, 'paused', 'DB 同样保持 paused')
  assert.deepEqual(gated.pauseCalls, ['eng_1'], '引擎侧补 pause 对齐(映射已建)')

  await manager.resumeTask(id)
  assert.deepEqual(gated.resumeCalls, ['eng_1'], '后续恢复复用既有引擎任务(不重建)')
})

test('startReserved:addUri 窗口内 removeTask → 补删引擎孤儿任务,记录不复活(修复:孤儿下载持续写盘)', async () => {
  const gated = new GatedAddUriEngine()
  gated.holdNextAddUri = true
  const trashed: string[] = []
  const { manager, db } = createHarness(3, {
    engine: gated,
    trashItem: async (p) => {
      trashed.push(p)
    },
    existsSync: () => false // 引擎刚建任务、尚未写盘:补偿清残留全为不存在 → 只验证引擎补删
  })
  await manager.start()

  const addPromise = manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await tick()
  const id = manager.listTasks()[0].id

  await manager.removeTask(id) // 窗口内删除:彼时无映射,removeTask 无从通知引擎
  assert.equal(manager.getTask(id), null)
  assert.equal(gated.removeCalls.length, 0, '删除时刻引擎侧尚无可删对象')

  gated.releaseHeldAddUri()
  await addPromise
  await tick()

  assert.deepEqual(gated.removeCalls, ['eng_1'], 'addUri 返回后发现任务已删 → 补删引擎孤儿')
  assert.equal(manager.getTask(id), null, '任务不复活')
  assert.equal(persisted(db, id), null, 'DB 不复活')
})

// ==================== v0.2 Task 3:三创建路径查重接入 + parked/decision(spec §4.1 / §6.2)====================

test('查重(http):同源同目录目标已在磁盘 → 不插库 + emit task:duplicate(conflictId=返回 id)', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, db } = createHarness(3, {
    existsSync: (p) => p === 'D:\\Downloads\\a.bin' // 目标文件已在磁盘(diskOnly)
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({
    kind: 'http',
    source: 'https://x/a.bin',
    filename: 'a.bin',
    dir: 'D:\\Downloads'
  })

  assert.equal(conflicts.length, 1, '命中冲突 → emit 一个事件')
  assert.equal(conflicts[0].kind, 'http')
  assert.equal(conflicts[0].conflictId, id, 'conflictId = 返回的任务 id')
  assert.equal(conflicts[0].items[0].existing, 'diskOnly', '仅磁盘命中 → diskOnly')
  assert.equal(conflicts[0].items[0].existingPath, 'D:\\Downloads\\a.bin')
  assert.equal(persisted(db, id), null, '冲突时不插库(§6.2)')
  assert.equal(manager.getTask(id), null, '内存也无该任务(待决策后才出现)')
  assert.equal(engine.addUriCalls.length, 0, '未下发引擎')
})

test('查重(http)overwrite:trash 旧文件(走回收站)+ 建任务 + 出队 downloading', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const onDisk = new Set(['D:\\Downloads\\a.bin'])
  const { manager, engine, db } = createHarness(3, {
    existsSync: (p) => onDisk.has(p),
    trashItem: async (p) => {
      trashed.push(p)
      onDisk.delete(p)
    }
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
  await tick()

  assert.deepEqual(trashed, ['D:\\Downloads\\a.bin'], 'overwrite 旧文件入回收站(非永久删)')
  assert.equal(persisted(db, id)?.status, 'downloading', '覆盖后建任务 + 出队')
  assert.equal(engine.addUriCalls.length, 1, '下发引擎一次')
})

test('查重(http)skip:丢弃 pending,无新记录、不下发引擎', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, db } = createHarness(3, {
    existsSync: (p) => p === 'D:\\Downloads\\a.bin'
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.resolveDuplicate({ conflictId: id, decision: 'skip' })
  await tick()

  assert.equal(persisted(db, id), null, 'skip 无新记录')
  assert.equal(manager.getTask(id), null)
  assert.equal(engine.addUriCalls.length, 0, 'skip 不下发引擎')
})

test('查重(http)rename:序号 (1) 新记录、旧文件不动(双留,§4.1)', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, db } = createHarness(3, {
    // 仅原名占用;a (1).bin 空闲
    existsSync: (p) => p === 'D:\\Downloads\\a.bin',
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
  await tick()

  const row = persisted(db, id)
  assert.equal(row?.filename, 'a (1).bin', 'rename → 序号插 stem 末尾、ext 前')
  assert.equal(row?.savePath, 'D:\\Downloads\\a (1).bin')
  assert.equal(row?.status, 'downloading', '重命名后建任务 + 出队')
  assert.deepEqual(trashed, [], 'rename 不动旧文件(双留)')
})

test('查重(http)open:不建 + 无新记录(打开由渲染层执行 existingPath)', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, db } = createHarness(3, {
    existsSync: (p) => p === 'D:\\Downloads\\a.bin'
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  const existingPath = conflicts[0].items[0].existingPath
  await manager.resolveDuplicate({ conflictId: id, decision: 'open' })
  await tick()

  assert.equal(persisted(db, id), null, 'open 无新记录(主进程只清 pending)')
  assert.equal(engine.addUriCalls.length, 0)
  assert.equal(existingPath, 'D:\\Downloads\\a.bin', 'existingPath 供渲染层打开')
})

test('查重(http)completed 记录命中:existing=completed + existingPath=真实 savePath', async () => {
  const conflicts: DuplicateConflict[] = []
  let onDisk = false
  const { manager, engine } = createHarness(3, {
    existsSync: () => onDisk
  })
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  // 先建并完成一条直链(完成后成品落盘、历史留 completed 记录)
  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  engine.complete('a.bin', 100)
  await tick()
  onDisk = true // 成品已落盘

  // 同源同目录同名再提交 → 命中 history completed(优先于 diskOnly)
  const id2 = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  assert.equal(conflicts.length, 1)
  assert.equal(
    conflicts[0].items[0].existing,
    'completed',
    'history completed + 文件在 → completed'
  )
  assert.equal(conflicts[0].items[0].existingPath, 'D:\\Downloads\\a.bin')
  assert.equal(conflicts[0].conflictId, id2)
})

test('查重(video 用户选):同 stem 磁盘已存 → 保持 awaiting_selection + emit(不静默 queued)', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, videoResolver } = createHarness(3, {
    readDir: () => ['My_ Cool Video_ [1080p].mkv'] // 同 stem(忽略 ext)
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush() // → awaiting_selection(无默认清晰度)

  await manager.selectFormat(id, { audioOnly: false, formatId: '137' }) // 1080p
  await tick()

  assert.equal(
    manager.getTask(id)?.status,
    'awaiting_selection',
    '命中冲突 → 保持 awaiting_selection(不 queued)'
  )
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'video')
  assert.equal(conflicts[0].items[0].existing, 'diskOnly')
  assert.equal(engine.addUriCalls.length, 0, '未下发引擎(不产生 0B)')
})

test('查重(video 自动选分支):命中 → resolving→awaiting_selection + emit(不静默 queued 致 0B,§6.2)', async () => {
  const conflicts: DuplicateConflict[] = []
  const progressStatuses: TaskStatus[] = []
  const { manager, engine, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    readDir: () => ['My_ Cool Video_ [360p].mkv']
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))
  manager.onProgress((p) => progressStatuses.push(p.status))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  assert.equal(
    manager.getTask(id)?.status,
    'awaiting_selection',
    '自动选命中冲突 → 停 awaiting_selection(不静默 queued 致 0B)'
  )
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'video')
  assert.equal(engine.addUriCalls.length, 0, '未下发引擎')
  assert.equal(
    progressStatuses.includes('queued'),
    false,
    '自动选冲突路径不经 queued(区别于零回归的自动入队)'
  )
})

test('查重(video)overwrite:trash 磁盘旧文件 + 转 queued 出队', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    readDir: () => ['My_ Cool Video_ [360p].mkv'],
    existsSync: () => true, // trashIfExists 前判存在
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()
  const existingPath = conflicts[0].items[0].existingPath!

  await manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
  await tick()

  assert.deepEqual(trashed, [existingPath], 'overwrite 磁盘旧文件入回收站')
  assert.equal(manager.getTask(id)?.status, 'downloading', '覆盖后 queued → 出队 downloading')
  assert.equal(engine.addUriCalls.length, 1)
})

test('查重(video)rename:新 stem (1)(序号插 [清晰度] 后 ext 前);旧文件不动', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, db, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    readDir: () => ['My_ Cool Video_ [360p].mkv'], // 仅原 stem 占用(#30 归一:heightCap=720、视频最高 360 → [360p])
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  await manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
  await tick()

  const row = persisted(db, id)
  assert.equal(
    row?.filename,
    'My_ Cool Video_ [360p] (1).mp4',
    'rename 序号插 [清晰度] 后、ext 前(#30 归一 heightCap=720→[360p])'
  )
  assert.equal(row?.status, 'downloading', '重命名后 queued → 出队')
  assert.deepEqual(trashed, [], 'rename 不动旧文件(双留)')
})

test('查重(video)skip:removeTask(无新记录、零磁盘改动)', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    readDir: () => ['My_ Cool Video_ [360p].mkv'],
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  await manager.resolveDuplicate({ conflictId: id, decision: 'skip' })
  await tick()

  assert.equal(manager.getTask(id), null, 'skip → removeTask(任务移除)')
  assert.deepEqual(trashed, [], 'skip 零磁盘改动(awaiting/startedAt=null 早退)')
})

test('查重(video)不同清晰度不误判:同源不同 stem → 照常入队(零回归)', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, engine, videoResolver } = createHarness(3, {
    getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false }),
    readDir: () => ['My_ Cool Video_ [1080p].mkv'] // 1080p 磁盘;本次自动选 720p(stem 不同)
  })
  videoResolver.result = SINGLE_VIDEO
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const id = await manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
  await flush()

  assert.equal(conflicts.length, 0, '不同清晰度(stem 不同)不命中')
  assert.equal(manager.getTask(id)?.status, 'downloading', '照常入队(零回归)')
  assert.equal(engine.addUriCalls.length, 1)
})

test('查重(batch):2 重复 + 1 新 → 新的立即建、重复聚合一个 batch 事件、父占位待 resolve 后移除', async () => {
  const conflicts: DuplicateConflict[] = []
  const { manager, db, videoResolver } = createHarness(5, {
    // Ep 0 / Ep 1 目标 stem 已在磁盘;Ep 2 不在
    readDir: () => ['Ep 0 [720p].mkv', 'Ep_ 1_ [720p].mkv']
  })
  videoResolver.result = BIG_PLAYLIST
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=BIG'
  })
  await flush()

  await manager.submitBatch(parentId, batchPicks([0, 1, 2], { audioOnly: false, heightCap: 720 }))
  await tick()

  assert.equal(conflicts.length, 1, '重复项聚合为一个 batch 事件')
  assert.equal(conflicts[0].kind, 'batch')
  assert.equal(conflicts[0].items.length, 2, '2 重复项')
  assert.deepEqual(
    conflicts[0].items.map((it) => it.index).sort(),
    [0, 1],
    '逐条 index 递增(供 perItem 定位)'
  )
  const built = db.rows.filter(
    (r) => r.kind === 'video' && r.source.startsWith('https://youtu.be/e')
  )
  assert.equal(built.length, 1, '仅非冲突子任务(Ep 2)立即建')
  assert.equal(built[0].source, 'https://youtu.be/e2')
  assert.ok(manager.getTask(parentId), '父占位待 resolve 保留(未提前移除)')

  await manager.resolveDuplicate({ conflictId: parentId, decision: 'skip' })
  await tick()
  assert.equal(
    db.rows.filter((r) => r.kind === 'video' && r.source !== 'https://youtu.be/e2').length,
    0,
    '全部跳过 → 无新记录'
  )
  assert.equal(manager.getTask(parentId), null, '父占位在批量决策全部处理后移除')
})

test('查重(batch)全部覆盖:每重复项 trash + 建;父移除', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, db, videoResolver } = createHarness(5, {
    readDir: () => ['Ep 0 [720p].mkv', 'Ep_ 1_ [720p].mkv'],
    existsSync: () => true,
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  videoResolver.result = BIG_PLAYLIST
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=BIG'
  })
  await flush()
  await manager.submitBatch(parentId, batchPicks([0, 1, 2], { audioOnly: false, heightCap: 720 }))
  await tick()

  await manager.resolveDuplicate({ conflictId: parentId, decision: 'overwrite' })
  await tick()

  assert.equal(trashed.length, 2, '两重复项各 trash 旧文件(回收站)')
  assert.equal(
    db.rows.filter((r) => r.kind === 'video').length,
    3,
    '3 子任务全部建(覆盖的 2 + 立即建的 1)'
  )
  assert.equal(manager.getTask(parentId), null, '父占位移除')
})

test('查重(batch)逐条混合(perItem):index 0 覆盖 / index 1 跳过', async () => {
  const trashed: string[] = []
  const conflicts: DuplicateConflict[] = []
  const { manager, db, videoResolver } = createHarness(5, {
    readDir: () => ['Ep 0 [720p].mkv', 'Ep_ 1_ [720p].mkv'],
    existsSync: () => true,
    trashItem: async (p) => {
      trashed.push(p)
    }
  })
  videoResolver.result = BIG_PLAYLIST
  await manager.start()
  manager.onDuplicate((c) => conflicts.push(c))

  const parentId = await manager.addTask({
    kind: 'video',
    source: 'https://youtu.be/playlist?list=BIG'
  })
  await flush()
  await manager.submitBatch(parentId, batchPicks([0, 1, 2], { audioOnly: false, heightCap: 720 }))
  await tick()

  // 整体默认跳过,index 0 逐条覆盖
  await manager.resolveDuplicate({
    conflictId: parentId,
    decision: 'skip',
    perItem: { 0: 'overwrite' }
  })
  await tick()

  assert.equal(trashed.length, 1, '仅 index 0 覆盖 → trash 一次')
  const sources = db.rows
    .filter((r) => r.kind === 'video')
    .map((r) => r.source)
    .sort()
  assert.deepEqual(
    sources,
    ['https://youtu.be/e0', 'https://youtu.be/e2'].sort(),
    'Ep 0(覆盖建)+ Ep 2(立即建);Ep 1(跳过)无记录'
  )
  assert.equal(manager.getTask(parentId), null, '父占位移除')
})

test('resolveDuplicate:未知 conflictId → 忽略(幂等,不抛)', async () => {
  const { manager } = createHarness()
  await manager.start()
  await manager.resolveDuplicate({ conflictId: 'nonexistent', decision: 'overwrite' }) // 不抛
  assert.ok(manager, '未知 conflictId 静默忽略')
})

// ==================== v0.2 Task 4:剪贴板监控只读 getter(纯读快照)====================

test('getKnownFileExts:返回 extIndex 键快照,不泄漏内部引用', async () => {
  const { manager } = createHarness(3, {
    categoryRows: [
      { key: 'video', displayName: '视频', extensions: '["mp4","mkv"]', savePath: '' },
      { key: 'audio', displayName: '音频', extensions: '["mp3"]', savePath: '' }
    ]
  })
  await manager.start()

  const exts = manager.getKnownFileExts()
  assert.deepEqual([...exts].sort(), ['mkv', 'mp3', 'mp4'], '并集 = 各类 extensions')

  // 快照独立:改返回值不污染内部,后续调用不受影响(纯读、不暴露内部 Map)
  ;(exts as Set<string>).add('zzz')
  assert.equal(manager.getKnownFileExts().has('zzz'), false, '返回新 Set,内部 extIndex 未被污染')
})

test('getTrackedSourceUrls:返回内存任务的 source 集合(快照)', async () => {
  const { manager } = createHarness()
  await manager.start()

  assert.deepEqual([...manager.getTrackedSourceUrls()], [], '空库 → 空集')

  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  await manager.addTask({ kind: 'http', source: 'https://x/b.bin', filename: 'b.bin' })

  assert.deepEqual(
    [...manager.getTrackedSourceUrls()].sort(),
    ['https://x/a.bin', 'https://x/b.bin'],
    '映射每个内存任务的 source'
  )
})

// ==================== v0.2 Task 6:hasActiveYtDlp 占用判定(热更新替换时机,§2.4 / §7.1)====================

test('hasActiveYtDlp:video 解析中 → true;http 直链 / 空列表 → false(占用则降级 pending,不 kill 进程)', async () => {
  const { manager, videoResolver } = createHarness()
  videoResolver.result = SINGLE_VIDEO
  await manager.start()

  // 空列表 → 无占用(可原子替换)
  assert.equal(manager.hasActiveYtDlp(), false, '空列表 → 无占用')

  // http 直链下载中 → 不占用 yt-dlp(kind 维度:只 video 任务用 yt-dlp exe)
  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  assert.equal(
    manager.hasActiveYtDlp(),
    false,
    'http 直链下载中不占用 yt-dlp(kind≠video,替换不该误降级 pending)'
  )

  // video 解析中 → 占用(status 维度:resolving 属活动;addTask 返回后 resolver 异步未完成 → 停在 resolving)
  const vid = await manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
  assert.equal(manager.getTask(vid)?.status, 'resolving', 'addTask 后 video 处于 resolving')
  assert.equal(
    manager.hasActiveYtDlp(),
    true,
    'video 解析中 → 占用 yt-dlp(热更新降级 pending 依据,§7.1 不 kill)'
  )
})

// ==================== v0.3 Task 1:torrent 创建路径 / torrentInfo 状态推进 / 恢复 / 清理 ====================

const MAGNET_DN = 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=My%20Show'

test('addTask(kind:torrent, magnet):建 resolving + 占位 dn + Torrents 落点 + other + 立即提交引擎 + 设 startedAt,不查重', async () => {
  const duplicates: DuplicateConflict[] = []
  // existsSync 恒 true:若 torrent 误接 duplicateDetect,磁盘命中必弹冲突 → 用它反证「不查重」
  const { manager, engine, db } = createHarness(3, { existsSync: () => true })
  manager.onDuplicate((c) => duplicates.push(c))
  await manager.start()

  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })

  const row = persisted(db, id)
  assert.equal(row?.kind, 'torrent')
  assert.equal(row?.status, 'resolving', '元数据阶段复用 resolving(不新增 status)')
  assert.equal(row?.filename, 'My Show', '占位 filename = magnet dn 参数')
  assert.equal(
    row?.savePath,
    join('D:\\Downloads', 'Torrents', 'My Show'),
    'BT 兜底子目录 <defaultDir>/Torrents'
  )
  assert.equal(row?.category, 'other', '归 other 类,不新增第 7 类')
  assert.ok(row?.startedAt, '提交引擎即设 startedAt(删任务清残留门控,§6.3)')
  assert.equal(row?.torrentMeta, null, '元数据未完成,torrentMeta 尚空')

  // 立即提交引擎取元数据(区别于 video resolving 不提交引擎);首次提交带 awaitSelection(元数据后暂停待选,Task 2)
  assert.equal(engine.addUriCalls.length, 1)
  assert.deepEqual(engine.addUriCalls[0], {
    url: MAGNET_DN,
    dir: join('D:\\Downloads', 'Torrents'),
    torrent: { source: 'magnet', awaitSelection: true }
  })
  assert.equal(
    engine.addUriCalls[0].video,
    undefined,
    '无 video → CompositeEngine 天然路由 aria2 后端'
  )
  assert.equal(duplicates.length, 0, 'torrent 不接 duplicateDetect(磁盘命中也不弹)')
})

test('addTask(kind:torrent, .torrent 文件):先拷托管副本(<userData>/torrents/<id>.torrent)再 addTorrent 提交', async () => {
  const copyCalls: Array<{ src: string; dest: string }> = []
  const { manager, engine, db } = createHarness(3, {
    copyFileSync: (src, dest) => copyCalls.push({ src, dest }),
    readFileSync: () => Buffer.from('ABC'),
    existsSync: (p) => p.endsWith('.torrent') // 托管副本视为已就位
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'torrent', source: 'C:\\seeds\\ubuntu.torrent' })

  assert.equal(copyCalls.length, 1, '.torrent 添加即拷托管副本')
  assert.equal(copyCalls[0].src, 'C:\\seeds\\ubuntu.torrent')
  assert.equal(
    copyCalls[0].dest,
    join('C:\\UserData', 'torrents', `${id}.torrent`),
    '路径由 id 派生'
  )

  assert.equal(engine.addUriCalls.length, 1)
  assert.deepEqual(
    engine.addUriCalls[0].torrent,
    { source: 'file', content: Buffer.from('ABC').toString('base64'), awaitSelection: true },
    '读托管副本 → base64 → 引擎走 addTorrent(首次提交带 awaitSelection,Task 2)'
  )
  assert.equal(engine.addUriCalls[0].url, '')

  const row = persisted(db, id)
  assert.equal(row?.status, 'resolving')
  assert.equal(row?.filename, 'ubuntu', '占位 filename = 种子文件名(去 .torrent)')
})

test('addTask(kind:torrent, .torrent 文件):托管副本拷贝失败 → 诚实落 error,不提交引擎', async () => {
  const { manager, engine, db } = createHarness(3, {
    copyFileSync: () => {
      throw new Error('EACCES: 权限不足')
    }
  })
  await manager.start()

  const id = await manager.addTask({ kind: 'torrent', source: 'C:\\seeds\\x.torrent' })

  const row = persisted(db, id)
  assert.equal(row?.status, 'error')
  assert.match(row?.error ?? '', /EACCES/)
  assert.equal(engine.addUriCalls.length, 0, '副本没保住就不提交(不假装可续)')
})

test('torrentInfo 状态推进(多文件):resolving 普通帧仅广播(totalBytes 不落库);torrentInfo(多文件)→ 定名/落 torrentMeta(全选)→ awaiting_selection,不重发引擎命令', async () => {
  const { manager, engine, db, progressEvents } = createHarness()
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })

  // 元数据阶段普通帧:帧 totalBytes(9000)是元数据大小,不得落库、状态不得流转
  engine.emitMetaFrame('eng_1', 9000)
  assert.equal(manager.getTask(id)?.status, 'resolving', 'resolving 期普通帧不误流转')
  assert.equal(persisted(db, id)?.totalBytes, 0, '元数据大小不落库(真实 totalBytes 待 torrentInfo)')
  assert.ok(
    progressEvents.some((e) => e.id === id && e.status === 'resolving'),
    '普通帧仍广播(UI 显「获取元数据中」)'
  )

  // 元数据完成:torrentInfo 帧(多文件 → 停待选)
  const info: TorrentInfo = {
    name: 'My Torrent',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    totalBytes: 12345,
    files: [
      { path: 'My Torrent/a.mkv', length: 12000, selected: true },
      { path: 'My Torrent/b.txt', length: 345, selected: true }
    ]
  }
  engine.emitTorrentInfo('eng_1', info)

  const row = persisted(db, id)
  assert.equal(
    row?.status,
    'awaiting_selection',
    '多文件 → resolving→awaiting_selection(复用现成边,不加新边)'
  )
  assert.equal(row?.filename, 'My Torrent', 'filename = sanitize(info.name)')
  assert.equal(
    row?.savePath,
    join('D:\\Downloads', 'Torrents', 'My Torrent'),
    'savePath 指向种子根'
  )
  assert.equal(row?.totalBytes, 12345, '真实 totalBytes 一次性落库(元数据 totalBytes)')
  assert.deepEqual(
    row?.torrentMeta,
    { name: 'My Torrent', infoHash: info.infoHash, files: info.files },
    'torrentMeta 落库往返(files 初始全选 selected=true)'
  )

  // 待选态:不重发任何引擎命令(既不 addUri 也不 resume,等用户选)
  assert.equal(engine.addUriCalls.length, 1, 'torrentInfo 后无第二次 addUri')
  assert.equal(engine.resumeCalls.length, 0, 'awaiting_selection 态未出队,无 resume/unpause')
})

test('torrentInfo 状态推进(单文件豁免):单文件 → resolving→queued→出队 downloading(经 resume/unpause,不重发 addUri)', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })

  const info: TorrentInfo = {
    name: 'Single Torrent',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    totalBytes: 999,
    files: [{ path: 'Single Torrent/movie.mkv', length: 999, selected: true }]
  }
  engine.emitTorrentInfo('eng_1', info)
  await tick() // 单文件豁免:onTorrentInfo 的 triggerDequeue 是 fire-and-forget,出队 resume 在微任务

  const row = persisted(db, id)
  assert.equal(row?.status, 'downloading', '单文件豁免:queued → 出队 downloading')
  assert.equal(row?.filename, 'Single Torrent')
  assert.equal(row?.totalBytes, 999, '真实 totalBytes 一次性落库')
  // 不重发 addUri(aria2 已在会话内);经 resume(unpause)出队 —— 区别于多文件的待选
  assert.equal(engine.addUriCalls.length, 1, '单文件豁免后无第二次 addUri')
  assert.deepEqual(engine.resumeCalls, ['eng_1'], '经 resume(unpause)出队下载(§2.4 如实过并发闸门)')

  // 完成:realGid 终态归属同一任务
  engine.completeById('eng_1', 999)
  assert.equal(persisted(db, id)?.status, 'completed')
})

// ============ BT 做种生命周期(v0.3 Task 3 · spec §3 / §4)============

/** 建单文件 magnet torrent 并驱动到 downloading(engineId = eng_1),返回 taskId */
async function toDownloadingTorrent(manager: TaskManager, engine: FakeEngine): Promise<string> {
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  engine.emitTorrentInfo('eng_1', {
    name: 'Seed Torrent',
    infoHash: 'seed0123456789abcdef0123456789abcdef0123',
    totalBytes: 100,
    files: [{ path: 'Seed Torrent/movie.mkv', length: 100, selected: true }]
  })
  await tick() // 单文件豁免 → queued → 出队 downloading
  return id
}

test('做种开档:torrent 下载满(seeding 帧)→ completed + seedingRuntime + 广播 seeding:true / 富进度(不落库)', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const frames: TaskProgress[] = []
  manager.onProgress((p) => frames.push(p))
  const id = await toDownloadingTorrent(manager, engine)

  engine.emitSeeding('eng_1', 100)

  assert.equal(
    manager.getTask(id)?.status,
    'completed',
    '100% 字节 → completed(做种开档 aria2 停 active,按字节判)'
  )
  assert.equal(
    persisted(db, id)?.status,
    'completed',
    '持久化仍 completed(做种走 runtime,不新增 status / 不改 schema)'
  )
  const last = frames.at(-1)
  assert.equal(last?.seeding, true, '广播 seeding:true(做种中 runtime)')
  assert.ok((last?.uploadSpeed ?? 0) > 0, '透传上行速度 uploadSpeed')
  assert.equal(last?.uploadLength, 12345, '透传累计上传 uploadLength')
  assert.equal(last?.numSeeders, 3, '透传 numSeeders')
  assert.equal(last?.connections, 4, '透传 connections')
})

test('护栏:已 completed 的 torrent 续帧只更新 seeding runtime + 广播,绝不再 transition;自然停 → seeding:false', async () => {
  const { manager, engine } = createHarness()
  await manager.start()
  const frames: TaskProgress[] = []
  manager.onProgress((p) => frames.push(p))
  const id = await toDownloadingTorrent(manager, engine)

  engine.emitSeeding('eng_1', 100) // → completed + 做种中
  assert.equal(manager.getTask(id)?.status, 'completed')
  assert.equal(frames.at(-1)?.seeding, true)

  engine.emitSeeding('eng_1', 100) // completed 续做种帧:不流转
  assert.equal(
    manager.getTask(id)?.status,
    'completed',
    'completed 续帧不流转(防 completed→paused 非法边)'
  )
  assert.equal(frames.at(-1)?.seeding, true)

  engine.completeById('eng_1', 100) // 自然停(达 seed 条件 → complete,seeding 派生 false)
  assert.equal(manager.getTask(id)?.status, 'completed', '仍 completed(护栏:不再 transition)')
  assert.equal(frames.at(-1)?.seeding, false, '自然停 → seeding runtime 清 → 广播 seeding:false')
})

test('stopSeeding:仅「已 completed + 做种中」torrent 生效;下载中 / 已停 / 非 torrent 幂等拒绝(不误伤续传)', async () => {
  const { manager, engine } = createHarness()
  await manager.start()
  const frames: TaskProgress[] = []
  manager.onProgress((p) => frames.push(p))
  const id = await toDownloadingTorrent(manager, engine)

  // 下载中 torrent(未做种):拒绝,绝不 forcePause(不误伤续传)
  await manager.stopSeeding(id)
  assert.equal(engine.stopSeedingCalls.length, 0, '下载中 torrent → 拒绝(不作用于下载中)')

  engine.emitSeeding('eng_1', 100) // → completed + 做种中
  assert.equal(manager.getTask(id)?.status, 'completed')

  // 做种中:生效 → 引擎 stopSeeding(forcePause)+ 广播 seeding:false
  await manager.stopSeeding(id)
  assert.deepEqual(
    engine.stopSeedingCalls,
    ['eng_1'],
    '做种中 → 引擎 stopSeeding(forcePause 停上传)'
  )
  assert.equal(frames.at(-1)?.seeding, false, '停做种 → 广播 seeding:false')
  assert.equal(manager.getTask(id)?.status, 'completed', '停做种不改状态(仍 completed)')

  // 已停:幂等拒绝(不重复 forcePause)
  await manager.stopSeeding(id)
  assert.equal(engine.stopSeedingCalls.length, 1, '已停做种 → 幂等拒绝')

  // 非 torrent:拒绝
  const httpId = await manager.addTask({
    kind: 'http',
    source: 'https://x/a.bin',
    filename: 'a.bin'
  })
  await manager.stopSeeding(httpId)
  assert.equal(engine.stopSeedingCalls.length, 1, '非 torrent → 拒绝')
})

test('broadcast 富进度透传:http 帧带 connections、不含 BT 字段;torrent 下载帧带 connections + seeding:false', async () => {
  const { manager, engine } = createHarness()
  await manager.start()
  const frames: TaskProgress[] = []
  manager.onProgress((p) => frames.push(p))

  // torrent 先建(eng_1),下载中普通帧:透传 connections + seeding:false(未做种)
  await toDownloadingTorrent(manager, engine)
  frames.length = 0
  engine.emitMetaFrame('eng_1', 100) // downloaded=50<100 → 下载中普通帧(connections:2)
  const btFrame = frames.at(-1)
  assert.equal(btFrame?.connections, 2, 'torrent 下载帧透传 connections')
  assert.equal(btFrame?.seeding, false, 'torrent 下载中未做种 → seeding:false')

  // http:connections 对所有任务透传;numSeeders/seeding 不含(仅 torrent)
  await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
  frames.length = 0
  engine.emitProgress('a.bin', 50, 100, 1234) // connections:1
  const httpFrame = frames.at(-1)
  assert.equal(httpFrame?.connections, 1, 'http 帧透传 connections(所有任务)')
  assert.equal(httpFrame?.seeding, undefined, 'http 帧不含 seeding(仅 torrent)')
  assert.equal(httpFrame?.numSeeders, undefined, 'http 帧不含 numSeeders(仅 torrent)')
})

test('torrentInfo 幂等:已离开 resolving 后再来 torrentInfo 帧(崩溃重提场景)→ 忽略,不再流转', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  // 单文件豁免 → queued → 出队 downloading(triggerDequeue fire-and-forget,await tick 排空)
  const info: TorrentInfo = {
    name: 'T',
    infoHash: null,
    totalBytes: 100,
    files: [{ path: 'T/a.bin', length: 100, selected: true }]
  }
  engine.emitTorrentInfo('eng_1', info)
  await tick()
  assert.equal(persisted(db, id)?.status, 'downloading')

  // 第二帧 torrentInfo(如崩溃重提后引擎再发):任务已 downloading → 走普通帧,仅广播
  engine.emitTorrentInfo('eng_1', { ...info, name: 'T2' })
  assert.equal(persisted(db, id)?.filename, 'T', '不再改名 / 不再流转(幂等)')
  assert.equal(persisted(db, id)?.status, 'downloading')
})

// ============ v0.3 Task 2:applyTorrentSelection 定型 / 出队 / 幂等 + rebuildTorrentSubmit 一致性 ============

/** 建 magnet torrent 并驱动到 awaiting_selection(多文件),返回 taskId(引擎 id = engIdN) */
async function toAwaitingTorrent(
  manager: TaskManager,
  engine: FakeEngine,
  engineId: string,
  files: Array<{ path: string; length: number; selected: boolean }>
): Promise<string> {
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  engine.emitTorrentInfo(engineId, {
    name: 'Multi',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    totalBytes: files.reduce((n, f) => n + f.length, 0),
    files
  })
  return id
}

test('applyTorrentSelection(部分选):定型 files[].selected + engine 收 "1,3" + →queued 出队 downloading(不重发 addUri)', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const id = await toAwaitingTorrent(manager, engine, 'eng_1', [
    { path: 'Multi/a.mkv', length: 40, selected: true },
    { path: 'Multi/b.mkv', length: 30, selected: true },
    { path: 'Multi/c.nfo', length: 30, selected: true }
  ])
  assert.equal(manager.getTask(id)?.status, 'awaiting_selection')

  await manager.applyTorrentSelection(id, [1, 3])

  assert.deepEqual(
    engine.applyTorrentSelectionCalls,
    [{ id: 'eng_1', arg: '1,3' }],
    'engine 暂停态收 --select-file="1,3"(1-based 压缩)'
  )
  const row = persisted(db, id)
  assert.equal(row?.status, 'downloading', '选定 → queued → 出队 downloading')
  assert.deepEqual(
    row?.torrentMeta?.files.map((f) => f.selected),
    [true, false, true],
    '定型 files[].selected 落 torrentMeta(单一真源,不改 schema)'
  )
  assert.equal(engine.addUriCalls.length, 1, '不重发 addUri(会话内 gid 存活)')
  assert.deepEqual(engine.resumeCalls, ['eng_1'], '出队经 resume(unpause)只下选中')
})

test('applyTorrentSelection(全选):engine 收 arg=null(引擎据此跳过 changeOption)+ →downloading', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const id = await toAwaitingTorrent(manager, engine, 'eng_1', [
    { path: 'Multi/a.mkv', length: 50, selected: true },
    { path: 'Multi/b.mkv', length: 50, selected: true }
  ])

  await manager.applyTorrentSelection(id, [1, 2]) // 全选

  assert.deepEqual(
    engine.applyTorrentSelectionCalls,
    [{ id: 'eng_1', arg: null }],
    '全选 → arg=null(引擎跳过 changeOption,整包零回归)'
  )
  assert.equal(persisted(db, id)?.status, 'downloading')
  assert.deepEqual(
    persisted(db, id)?.torrentMeta?.files.map((f) => f.selected),
    [true, true],
    '全选定型(仍全 selected)'
  )
})

test('applyTorrentSelection 幂等忽略:非 torrent / 无 torrentMeta(resolving)/ 空选 / 非 awaiting(downloading)', async () => {
  const { manager, engine } = createHarness()
  await manager.start()

  // (a) 非 torrent:http 任务 → 忽略
  const httpId = await manager.addTask({
    kind: 'http',
    source: 'https://x/a.bin',
    filename: 'a.bin'
  })
  await manager.applyTorrentSelection(httpId, [1])
  assert.equal(engine.applyTorrentSelectionCalls.length, 0, '非 torrent → 忽略')

  // (b) 无 torrentMeta:torrent 仍 resolving(元数据未到)→ 忽略
  const btId = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  assert.equal(manager.getTask(btId)?.status, 'resolving')
  await manager.applyTorrentSelection(btId, [1])
  assert.equal(engine.applyTorrentSelectionCalls.length, 0, 'resolving(无 torrentMeta)→ 忽略')
  assert.equal(manager.getTask(btId)?.status, 'resolving', '状态不变')

  // (c) awaiting 但空选 → 忽略(保持待选,防呆)
  engine.emitTorrentInfo('eng_2', {
    name: 'M',
    infoHash: null,
    totalBytes: 100,
    files: [
      { path: 'M/a', length: 50, selected: true },
      { path: 'M/b', length: 50, selected: true }
    ]
  })
  assert.equal(manager.getTask(btId)?.status, 'awaiting_selection')
  await manager.applyTorrentSelection(btId, [])
  assert.equal(
    manager.getTask(btId)?.status,
    'awaiting_selection',
    '空选 → 忽略,保持 awaiting_selection'
  )
  assert.equal(engine.applyTorrentSelectionCalls.length, 0)

  // (d) 非 awaiting(downloading):选定后再选 → 忽略(下载中不改选,§4.5)
  await manager.applyTorrentSelection(btId, [1])
  assert.equal(manager.getTask(btId)?.status, 'downloading')
  const callsAfter = engine.applyTorrentSelectionCalls.length
  await manager.applyTorrentSelection(btId, [2])
  assert.equal(
    engine.applyTorrentSelectionCalls.length,
    callsAfter,
    'downloading 态再选 → 忽略(不重复下发)'
  )
})

test('rebuildTorrentSubmit 一致性:会话选定与恢复重建产出同一 --select-file(§4.3)', async () => {
  const { manager, engine, db } = createHarness()
  await manager.start()
  const id = await toAwaitingTorrent(manager, engine, 'eng_1', [
    { path: 'Multi/a', length: 30, selected: true },
    { path: 'Multi/b', length: 30, selected: true },
    { path: 'Multi/c', length: 40, selected: true }
  ])
  await manager.applyTorrentSelection(id, [1, 3])
  assert.deepEqual(
    engine.applyTorrentSelectionCalls,
    [{ id: 'eng_1', arg: '1,3' }],
    '会话选定:engine 收 1,3'
  )
  assert.equal(persisted(db, id)?.status, 'downloading')

  // 恢复:新 TaskManager 读同一 db(torrentMeta files [T,F,T] 已持久化)→ recoverSubmit 重建 select-file
  const engine2 = new FakeEngine()
  const manager2 = new TaskManager(
    {
      engine: engine2,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager2.start()
  const reSubmit = engine2.addUriCalls.find((c) => c.torrent)
  assert.equal(
    reSubmit?.torrent?.selectFile,
    '1,3',
    '恢复重建 --select-file 与会话选定同一(同一 selectFileArg)'
  )
  assert.equal(reSubmit?.torrent?.awaitSelection, undefined, '已定型 → 不再 awaitSelection')
})

test('rebuildTorrentSubmit:待选态(awaiting_selection)恢复 → awaitSelection=true(再取元数据 → 待选)', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const { insertTask } = await import('../db/taskDao')
  // 预置一个 awaiting_selection 的 magnet torrent(带 torrentMeta,但恢复时归位 resolving 再 await)
  insertTask(db as unknown as TaskDaoDatabase, {
    id: 'bt-await',
    kind: 'torrent',
    source: MAGNET_DN,
    status: 'awaiting_selection',
    filename: 'My Show',
    savePath: join('D:\\Downloads', 'Torrents', 'My Show'),
    category: 'other',
    totalBytes: 100,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: {
      name: 'My Show',
      infoHash: null,
      files: [
        { path: 'My Show/a', length: 50, selected: true },
        { path: 'My Show/b', length: 50, selected: true }
      ]
    },
    error: null,
    createdAt: 1,
    startedAt: 100,
    completedAt: null
  })

  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  // 归位 resolving 后重提,带 awaitSelection(元数据后暂停待选)
  assert.equal(
    manager.getTask('bt-await')?.status,
    'resolving',
    'awaiting_selection 恢复先归位 resolving'
  )
  assert.equal(engine.addUriCalls.length, 1, '重提引擎取元数据')
  assert.equal(
    engine.addUriCalls[0].torrent?.awaitSelection,
    true,
    '待选恢复 → awaitSelection=true'
  )
  assert.equal(engine.addUriCalls[0].torrent?.selectFile, undefined, '待选前不带 selectFile')
})

test('元数据硬超时:超时仍 resolving → 撤引擎任务 + 转 error 诚实文案;重试回 resolving 重提、torrentInfo 仍可定名(spec §4.3)', async () => {
  const { manager, engine, db } = createHarness(3, { torrentMetadataTimeoutMs: 15 })
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  assert.equal(manager.getTask(id)?.status, 'resolving')

  // 超时窗口内无 torrentInfo → error(真实定时器,15ms 小值)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const row = persisted(db, id)
  assert.equal(row?.status, 'error', '超时诚实转 error,不永久卡「获取元数据中」')
  assert.ok(row?.error?.includes('元数据超时'), `文案应说明超时原因,实际:${row?.error}`)
  assert.ok(engine.removeCalls.includes('eng_1'), '超时撤销引擎侧元数据任务')

  // 重试:回 resolving 重提引擎(非 queued→downloading,否则 torrentInfo 被幂等忽略)
  await manager.retryTask(id)
  assert.equal(
    manager.getTask(id)?.status,
    'resolving',
    '无 torrentMeta 的 torrent 重试回 resolving'
  )
  assert.equal(engine.addUriCalls.length, 2, '重试重提引擎取元数据')

  // 新一轮 torrentInfo 到达 → 正常定名流转(超时定时器被 torrentInfo 解除)。单文件豁免出队 fire-and-forget → tick
  engine.emitTorrentInfo('eng_2', {
    name: 'Retry Torrent',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    totalBytes: 5000,
    files: [{ path: 'Retry Torrent/a.bin', length: 5000, selected: true }]
  })
  await tick()
  assert.equal(persisted(db, id)?.status, 'downloading')
  assert.equal(persisted(db, id)?.filename, 'Retry Torrent')

  // 已流转后旧超时不再触发
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(persisted(db, id)?.status, 'downloading', 'torrentInfo 后超时解除,不误杀下载中任务')
  await manager.stop()
})

test('元数据硬超时:torrentInfo 及时到达 → 定时器解除,不触发;删除任务亦清定时器(spec §4.3)', async () => {
  const { manager, engine, db } = createHarness(3, { torrentMetadataTimeoutMs: 25 })
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  engine.emitTorrentInfo('eng_1', {
    name: 'Fast Torrent',
    infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    totalBytes: 100,
    files: [{ path: 'Fast Torrent/a.bin', length: 100, selected: true }]
  })
  await tick() // 单文件豁免出队 fire-and-forget
  assert.equal(persisted(db, id)?.status, 'downloading')

  // 删除第二个 resolving 任务 → 定时器随任务清理,超时后不复活 / 不报错
  const id2 = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  await manager.removeTask(id2)

  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(persisted(db, id)?.status, 'downloading', '元数据及时到达 → 超时不触发')
  assert.equal(persisted(db, id2), null, '已删任务不因迟到定时器复活')
  await manager.stop()
})

test('重启恢复(torrent):magnet resolving → 重提引擎续取元数据且保持 resolving;downloading → 归一化重提交(§6.2)', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const seedTorrent = (overrides: Partial<Task>): Task => ({
    id: overrides.id!,
    kind: 'torrent',
    source: MAGNET_DN,
    status: 'resolving',
    filename: 'My Show',
    savePath: join('D:\\Downloads', 'Torrents', 'My Show'),
    category: 'other',
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 0,
    startedAt: 100,
    completedAt: null,
    ...overrides
  })
  const { insertTask } = await import('../db/taskDao')
  insertTask(db as unknown as TaskDaoDatabase, seedTorrent({ id: 'bt-meta', createdAt: 1 }))
  insertTask(
    db as unknown as TaskDaoDatabase,
    seedTorrent({ id: 'bt-dl', status: 'downloading', filename: 'Done Name', createdAt: 2 })
  )

  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  assert.equal(engine.addUriCalls.length, 2, 'resolving(元数据)与 downloading 均重提交')
  assert.ok(
    engine.addUriCalls.every((c) => c.torrent?.source === 'magnet' && c.url === MAGNET_DN),
    '按 source re-addUri(不持久化 gid,§7.4)'
  )
  assert.equal(
    manager.getTask('bt-meta')?.status,
    'resolving',
    '元数据未完成 → 恢复后保持 resolving(followedBy 再次转移)'
  )
  assert.equal(
    manager.getTask('bt-dl')?.status,
    'downloading',
    '下载中 → 归一化 downloading(aria2 .aria2 续传)'
  )
})

test('重启恢复(torrent .torrent):托管副本缺失 → 诚实落 error「副本缺失」,不静默(§6.2 / I3)', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const { insertTask } = await import('../db/taskDao')
  insertTask(db as unknown as TaskDaoDatabase, {
    id: 'bt-file',
    kind: 'torrent',
    source: 'C:\\seeds\\gone.torrent',
    status: 'downloading',
    filename: 'gone',
    savePath: join('D:\\Downloads', 'Torrents', 'gone'),
    category: 'other',
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1,
    startedAt: 100,
    completedAt: null
  })

  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {},
      existsSync: () => false // 托管副本已被清 / 丢失
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  assert.equal(engine.addUriCalls.length, 0, '读不到副本 → 不提交引擎')
  const task = manager.getTask('bt-file')
  assert.equal(task?.status, 'error')
  assert.match(task?.error ?? '', /副本缺失/, '诚实提示重新添加')
})

test('重启恢复(torrent .torrent):托管副本在 → base64 re-addTorrent 续传(I3)', async () => {
  const engine = new FakeEngine()
  const db = new MockDb()
  const { insertTask } = await import('../db/taskDao')
  insertTask(db as unknown as TaskDaoDatabase, {
    id: 'bt-file2',
    kind: 'torrent',
    source: 'C:\\seeds\\here.torrent',
    status: 'queued',
    filename: 'here',
    savePath: join('D:\\Downloads', 'Torrents', 'here'),
    category: 'other',
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    // 已定型(元数据完成)+ 全选:rebuildTorrentSubmit → selectFileArg=null → 省略 select-file(整包零回归)
    torrentMeta: {
      name: 'here',
      infoHash: null,
      files: [{ path: 'here/a.bin', length: 10, selected: true }]
    },
    error: null,
    createdAt: 1,
    startedAt: 100,
    completedAt: null
  })

  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {},
      existsSync: (p) => p === join('C:\\UserData', 'torrents', 'bt-file2.torrent'),
      readFileSync: () => Buffer.from('SEED')
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  assert.equal(engine.addUriCalls.length, 1)
  assert.deepEqual(
    engine.addUriCalls[0].torrent,
    { source: 'file', content: Buffer.from('SEED').toString('base64') },
    '定型全选恢复:re-addTorrent 省略 select-file(整包零回归);路径由 id 派生,免额外存'
  )
  assert.equal(manager.getTask('bt-file2')?.status, 'downloading')
})

test('删除(torrent 未完成):种子根 + .aria2 残留入回收站 + best-effort 移除托管副本', async () => {
  const trashed: string[] = []
  const { manager, engine, db } = createHarness(3, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    existsSync: () => true
  })
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  engine.emitTorrentInfo('eng_1', {
    name: 'My Torrent',
    infoHash: null,
    totalBytes: 100,
    files: []
  })

  await manager.removeTask(id)

  assert.equal(persisted(db, id), null, '记录已删')
  const savePath = join('D:\\Downloads', 'Torrents', 'My Torrent')
  assert.ok(trashed.includes(savePath), '种子根(文件 / 文件夹树)入回收站')
  assert.ok(trashed.includes(savePath + '.aria2'), 'aria2 控制文件一并清(用户主动放弃续传)')
  assert.ok(trashed.includes(savePath + '.torrent'), '伴生 .torrent 随残留清(迅雷式,修订四)')
  assert.ok(
    trashed.includes(join('C:\\UserData', 'torrents', `${id}.torrent`)),
    '托管副本(内部工件)best-effort 移除'
  )
})

test('BT 完成收尾(修订四):.aria2 即清 + <infoHash>.torrent 更名 <种子名>.torrent(迅雷式伴生)', async () => {
  const trashed: string[] = []
  const renames: Array<[string, string]> = []
  const torrentsDir = join('D:\\Downloads', 'Torrents')
  const savePath = join(torrentsDir, 'My Torrent')
  const { manager, engine } = createHarness(3, {
    trashItem: async (p) => {
      trashed.push(p)
    },
    // .aria2 / <infoHash>.torrent 在盘;目标 <种子名>.torrent 不在(可更名)
    existsSync: (p) => p !== savePath + '.torrent',
    renameSync: (from, to) => {
      renames.push([from, to])
    }
  })
  await manager.start()
  const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
  engine.emitTorrentInfo('eng_1', {
    name: 'My Torrent',
    infoHash: 'hash01',
    totalBytes: 100,
    files: []
  })
  await flush() // 单文件豁免:queued → 出队 resume → downloading
  engine.completeTorrent('eng_1', 100) // 磁力 addUri 不带 filename,按引擎 id 驱动完成
  await flush() // finalize 是 fire-and-forget,排空

  assert.equal(manager.getTask(id)?.status, 'completed')
  assert.ok(
    trashed.includes(savePath + '.aria2'),
    '完成即清 .aria2(BT 完成后 aria2 不自删,真机实证)'
  )
  assert.deepEqual(
    renames,
    [[join(torrentsDir, 'hash01.torrent'), savePath + '.torrent']],
    '<infoHash>.torrent 更名 <种子名>.torrent(内容在元数据在)'
  )
})

test('删除(torrent completed):默认仅清内部工件(内容 + 伴生 .torrent 保留);deleteFile → 内容 + 伴生全回收(迅雷式)', async () => {
  const torrentsDir = join('D:\\Downloads', 'Torrents')
  const savePath = join(torrentsDir, 'My Torrent')
  const makeCompleted = async (
    trashed: string[]
  ): Promise<{ manager: TaskManager; id: string; db: MockDb }> => {
    const { manager, engine, db } = createHarness(3, {
      trashItem: async (p) => {
        trashed.push(p)
      },
      existsSync: () => true
    })
    await manager.start()
    const id = await manager.addTask({ kind: 'torrent', source: MAGNET_DN })
    engine.emitTorrentInfo('eng_1', {
      name: 'My Torrent',
      infoHash: 'hash01',
      totalBytes: 100,
      files: []
    })
    await flush()
    engine.completeTorrent('eng_1', 100)
    await flush()
    trashed.length = 0 // 清掉完成收尾产生的记录,聚焦删除阶段
    return { manager, id, db }
  }

  {
    // 默认(!deleteFile):内容与伴生 .torrent 保留(跟随内容),仅内部工件清
    const trashed: string[] = []
    const { manager, id, db } = await makeCompleted(trashed)
    await manager.removeTask(id)
    assert.equal(persisted(db, id), null, '记录已删')
    assert.ok(!trashed.includes(savePath), '成品保留(零回归)')
    assert.ok(!trashed.includes(savePath + '.torrent'), '伴生 .torrent 跟随内容保留(迅雷式)')
    assert.ok(trashed.includes(savePath + '.aria2'), '.aria2 内部工件兜底清(不看 deleteFile)')
  }
  {
    // deleteFile:内容 + 伴生(新旧两个名字)全回收
    const trashed: string[] = []
    const { manager, id } = await makeCompleted(trashed)
    await manager.removeTask(id, { deleteFile: true })
    assert.ok(trashed.includes(savePath), '成品移回收站')
    assert.ok(trashed.includes(savePath + '.torrent'), '伴生 <种子名>.torrent 随内容清')
    assert.ok(
      trashed.includes(join(torrentsDir, 'hash01.torrent')),
      '未及更名的 <infoHash>.torrent 兜底清'
    )
  }
})

test('Fake BT 端到端(多文件选择,I2):magnet → resolving → awaiting_selection → applyTorrentSelection([1,3]) → 引擎收 "1,3" → downloading → completed', async () => {
  const ticks: Array<() => void> = []
  const { FakeEngine: RealFakeEngine } = await import('../engine/fakeEngine')
  const engine = new RealFakeEngine({
    setInterval: (fn: () => void) => {
      ticks.push(fn)
      return ticks.length as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    totalBytes: 30,
    stepBytes: 10,
    intervalMs: 100
  })
  const db = new MockDb()
  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  const id = await manager.addTask({ kind: 'torrent', source: 'magnet:?xt=urn:btih:e2e' })
  assert.equal(manager.getTask(id)?.status, 'resolving')

  ticks[0]() // 元数据帧 1
  ticks[0]() // 元数据帧 2
  assert.equal(manager.getTask(id)?.status, 'resolving', '元数据帧不流转')

  ticks[0]() // torrentInfo 帧(多文件 → 停待选;Fake 元数据后暂停 btPaused,模拟 pause-metadata)
  assert.equal(manager.getTask(id)?.status, 'awaiting_selection', '多文件 → awaiting_selection')
  const files0 = manager.getTask(id)?.torrentMeta?.files
  assert.equal(files0?.length, 3, '多文件(3)torrentMeta 落 UI')
  assert.ok(
    files0?.every((f) => f.selected),
    '初始全选(默认整包)'
  )

  // 用户选第 1、3 个文件(1-based)
  await manager.applyTorrentSelection(id, [1, 3])
  assert.deepEqual(
    engine.applyTorrentSelectionCalls,
    [{ id: 'fake_1', arg: '1,3' }],
    '引擎经 changeOption 收到 --select-file="1,3"(暂停态下发)'
  )
  assert.equal(
    manager.getTask(id)?.status,
    'downloading',
    '选定 → queued → 出队 downloading(resume=unpause)'
  )

  for (let i = 0; i < 6 && manager.getTask(id)?.status !== 'completed'; i++) {
    ticks[0]() // 整包推进 → completed(resume 已解除 btPaused)
  }
  const row = persisted(db, id)
  assert.equal(row?.status, 'completed')
  assert.equal(
    row?.savePath,
    join('D:\\Downloads', 'Torrents', 'Fake Torrent'),
    'savePath 指 Torrents/<name>'
  )
  assert.equal(row?.totalBytes, 30)
  assert.deepEqual(
    row?.torrentMeta?.files.map((f) => f.selected),
    [true, false, true],
    'torrentMeta.files[].selected 持久化定型([T,F,T])'
  )
})

test('Fake BT 端到端(单文件豁免):magnet(single)→ resolving → torrentInfo(单文件)→ 直接 downloading(不待选)→ completed', async () => {
  const ticks: Array<() => void> = []
  const { FakeEngine: RealFakeEngine } = await import('../engine/fakeEngine')
  const engine = new RealFakeEngine({
    setInterval: (fn: () => void) => {
      ticks.push(fn)
      return ticks.length as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    totalBytes: 20,
    stepBytes: 10,
    intervalMs: 100
  })
  const db = new MockDb()
  const manager = new TaskManager(
    {
      engine,
      initDatabase: () =>
        db as unknown as ReturnType<(typeof import('../db/connection'))['initDatabase']>,
      ensureDir: () => {}
    },
    {
      dbPath: 'mock.db',
      defaultDir: 'D:\\Downloads',
      maxConcurrent: 3,
      userDataDir: 'C:\\UserData'
    }
  )
  await manager.start()

  // url 含 'single' → Fake 发单文件 torrentInfo(触发整包豁免路径)
  const id = await manager.addTask({ kind: 'torrent', source: 'magnet:?xt=urn:btih:single01' })
  ticks[0]() // 元数据帧 1
  ticks[0]() // 元数据帧 2
  ticks[0]() // torrentInfo 帧(单文件)
  await tick() // 单文件豁免:onTorrentInfo 的 triggerDequeue fire-and-forget → resume(unpause)在微任务

  assert.equal(
    manager.getTask(id)?.status,
    'downloading',
    '单文件豁免:无 awaiting_selection,直接出队 downloading'
  )
  assert.equal(manager.getTask(id)?.filename, 'Fake Single')
  assert.equal(
    engine.applyTorrentSelectionCalls.length,
    0,
    '单文件不经 applyTorrentSelection(整包)'
  )

  for (let i = 0; i < 6 && manager.getTask(id)?.status !== 'completed'; i++) {
    ticks[0]()
  }
  const row = persisted(db, id)
  assert.equal(row?.status, 'completed')
  assert.equal(row?.totalBytes, 20)
  assert.deepEqual(
    row?.torrentMeta?.files,
    [{ path: 'Fake Single/movie.mkv', length: 20, selected: true }],
    '单文件整包(全选)'
  )
})

// ==================== v0.4 Task 4 Phase 3:headers 缺省逐字段等价(U-14 / I-05)====================
//
// ★ **本节两条测试先于实现落地**(plan 3.1「顺序不可颠倒」):它们断言的是 **headers 引入之前**的
//   `toAddUriInput` / `addTask → engine.addUri` 输出。先跑绿 = 钉死基准,再改实现、确保仍绿 ——
//   这是「缺省逐字段等价」唯一可信的证明方式(只在改完之后写,证明不了任何东西)。
//
// 两条都用 `deepStrictEqual`(不是 `deepEqual`):它比较**自有可枚举键的集合**,故
// `{ …, headers: undefined }` 与 `{ … }` **不相等** —— 这正是反向探针 RP-3(去掉
// `if (task.headers)` 条件 → 无条件赋值)必须变红的机制。

/** 手写的「改动前期望对象」——逐字段列全,不用 spread、不引用被测代码算出来的值 */
const ADD_URI_BEFORE_HEADERS: AddUriInput = {
  url: 'https://example.test/a.bin',
  dir: 'D:\\Downloads',
  filename: 'a.bin'
}

test('U-14 toAddUriInput 缺省(task.headers === undefined)→ 与改动前逐字段等价', async () => {
  const { manager } = createHarness()
  await manager.start()

  // 直取私有方法:它是 `addTask` 与「出队 / 恢复重提交」共用的唯一提交组装点,
  // 从外部只能观察到叠加了并发调度之后的结果,而这条断言要的是**组装本身**。
  const toAddUriInput = (
    manager as unknown as { toAddUriInput(task: Task): AddUriInput }
  ).toAddUriInput.bind(manager)

  const task: Task = {
    id: 't1',
    kind: 'http',
    source: 'https://example.test/a.bin',
    status: 'queued',
    filename: 'a.bin',
    savePath: 'D:\\Downloads\\a.bin',
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
  }

  assert.deepStrictEqual(
    toAddUriInput(task),
    ADD_URI_BEFORE_HEADERS,
    '缺省不得多出任何键(含值为 undefined 的键)'
  )
})

test('I-05 不传 headers 走完整 addTask → engine.addUri 收到的与改动前逐字段相同', async () => {
  const { manager, engine } = createHarness()
  await manager.start()

  await manager.addTask({
    kind: 'http',
    source: 'https://example.test/a.bin',
    filename: 'a.bin',
    dir: 'D:\\Downloads'
  })

  assert.equal(engine.addUriCalls.length, 1)
  assert.deepStrictEqual(
    engine.addUriCalls[0],
    ADD_URI_BEFORE_HEADERS,
    '★ 接管路径以外的任何调用方,提交给引擎的载荷必须与 Task 3 交付态逐字段相同(零回归)'
  )
})
