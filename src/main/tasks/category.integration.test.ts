/**
 * 分类自动保存路由 集成测试 — Task 6 Phase 3(spec §3.4 / §5 / §7.2)。
 *
 * 真实 node:sqlite + 启动幂等 seed 默认 6 类 + 精简 FakeEngine(确定性,无需 aria2c / yt-dlp),
 * 端到端验证 TaskManager 三创建路径(直链 / 视频单条 / 批量)统一经 routeForFilename:
 *   - 扩展名 → category 判定(.zip→archive、未知→other、视频按最终输出容器 mp4→video / 仅音频 mp3→audio);
 *   - savePath 路由到对应类别目录(Archives / Videos / Music …),other / 未命中 → defaultDir 兜底;
 *   - 用户显式选目录优先(savePath 用指定目录,但 category 仍按 filename 判定);
 *   - 提交引擎前 ensureDir(目录自动创建);失败 → 任务 error + 可读提示(§5.3,不崩)。
 *
 * 与既有 integration.test.ts(Section A 直链 / Section C 视频)互补:本文件聚焦「分类落盘」断言,
 * 故 seed 真实默认类别(那两段未 seed → 全部落 other/defaultDir,验证零回归)。
 *
 * 同 integration.test.ts:不静态 import 触达 node:sqlite 的模块(动态 import),node:sqlite
 * 不可用时优雅跳过(本地纯 node 直跑);CI 经 electron-as-node 恒可用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type {
  AddUriInput,
  BatchPick,
  DownloadProgress,
  FormatChoice,
  ResolvedPlaylist,
  ResolvedVideo,
  ResolveResult,
  Task
} from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'
import type { CategoryDaoDatabase } from '../db/categoryDao'

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
  const msg =
    `[category.integration] node:sqlite 不可用(${process.version});` +
    ' 须经 electron-as-node 运行(npm test)。'
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

// ==================== 解析样本 ====================

/** 单视频(标题无特殊字符 → filename 可预测 Clip.mp4 / Clip.mp3);含纯视频 137 + muxed 18 两格式 */
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

/** 2 条目播放列表(批量展开 → 子任务各自分类路由) */
const PLAYLIST: ResolvedPlaylist = {
  kind: 'playlist',
  title: 'List',
  entries: [
    { id: 'e0', title: 'Ep0', url: 'https://youtu.be/e0', durationSec: 60 },
    { id: 'e1', title: 'Ep1', url: 'https://youtu.be/e1', durationSec: 61 }
  ]
}

// ==================== 精简 FakeEngine(只为驱动 addUri / 不真下载)====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly removeCalls: string[] = []

  private counter = 0
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private readonly active = new Map<string, { input: AddUriInput; done: boolean }>()

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    const id = `eng_${++this.counter}`
    this.active.set(id, { input, done: false })
    return id
  }

  async pause(): Promise<void> {
    /* fake 引擎:本套用例只验证分类路由,不涉及暂停语义 */
  }

  async resume(): Promise<void> {
    /* fake 引擎:同 pause,刻意空实现 */
  }

  async remove(id: string): Promise<void> {
    this.removeCalls.push(id)
    this.active.delete(id)
  }

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }
}

/** 可控 mock VideoResolver(吐 mock -J 结果;异步以模拟真实 yt-dlp 子进程,使 addTask 先返回 resolving) */
class FakeVideoResolver {
  readonly resolveCalls: string[] = []
  result: ResolveResult = SINGLE_VIDEO

  async resolve(url: string): Promise<ResolveResult> {
    this.resolveCalls.push(url)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return this.result
  }
}

// ==================== 公共辅助 ====================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-cat-'))
}

function cleanup(dir: string, ...closables: Array<{ close(): void } | null | undefined>): void {
  for (const db of closables) {
    try {
      db?.close()
    } catch {
      // 已关闭 / 关闭失败不影响后续清理
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort:Windows 句柄偶发占用,忽略
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 排空多级 fire-and-forget 链(resolve → onResolved → awaiting_selection) */
async function flushVideo(): Promise<void> {
  await tick()
  await tick()
}

function batchPicks(indexes: number[], choice: FormatChoice): BatchPick[] {
  return indexes.map((entryIndex) => ({ entryIndex, choice }))
}

interface CategoryHarness {
  dir: string
  manager: InstanceType<(typeof import('./taskManager'))['TaskManager']>
  engine: FakeEngine
  videoResolver: FakeVideoResolver
  ensureDirCalls: string[]
  db: { close(): void }
  read: (id: string) => Task | null
}

/**
 * 起一套「真 SQLite + 启动 seed 默认 6 类 + FakeEngine + 可观察 ensureDir」夹具。
 * `defaultDir` = 临时目录;seed 后类别 savePath = <临时目录>/Videos|Music|Archives|…(other → 临时目录本身)。
 * `ensureDir` 记录被调用目录并真实 mkdir(可断言「目录自动创建」);`ensureDirThrows` → 模拟创建失败(§5.3)。
 */
async function startCategoryHarness(
  opts: { result?: ResolveResult; ensureDirThrows?: boolean } = {}
): Promise<CategoryHarness> {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { getTask } = await import('../db/taskDao')

  // 复用 index.ts 装配序:初始化库 → 幂等 seed 默认类别(savePath='' 跟随)→ 注入同一句柄给 TaskManager。
  // 类别目录由 resolveCategoryDir 按 defaultDir(= 临时目录)实时解析 = <临时目录>/Videos|Music|…(other → 临时目录本身)。
  const db = initDatabase(dbPath)
  seedDefaultCategories(db)

  const engine = new FakeEngine()
  const videoResolver = new FakeVideoResolver()
  if (opts.result !== undefined) {
    videoResolver.result = opts.result
  }

  const ensureDirCalls: string[] = []
  const ensureDir = (target: string): void => {
    ensureDirCalls.push(target)
    if (opts.ensureDirThrows) {
      throw new Error('EACCES: permission denied (mock)')
    }
    fs.mkdirSync(target, { recursive: true })
  }

  const manager = new TaskManager(
    { engine, videoResolver, ensureDir, initDatabase: () => db },
    { dbPath, defaultDir: dir, maxConcurrent: 3 }
  )
  await manager.start()

  const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)
  return { dir, manager, engine, videoResolver, ensureDirCalls, db, read }
}

// ==================== 分类落盘断言(spec §7.2)====================

test(
  'D1 直链 .zip → category=archive、savePath 落 <下载>/Archives + 目录自动创建',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/sample.zip',
        filename: 'sample.zip'
      })

      const row = h.read(id)
      const archivesDir = path.join(h.dir, 'Archives')
      assert.equal(row?.category, 'archive', '.zip → category=archive')
      assert.equal(row?.savePath, path.join(archivesDir, 'sample.zip'), 'savePath 落 Archives 目录')
      assert.ok(
        h.ensureDirCalls.includes(archivesDir),
        'ensureDir 以 Archives 目录被调用(提交引擎前)'
      )
      assert.ok(fs.existsSync(archivesDir), 'Archives 目录已自动创建')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D2 直链未知扩展名 .xyz → category=other、savePath 落默认目录(兜底)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/file.xyz',
        filename: 'file.xyz'
      })

      const row = h.read(id)
      assert.equal(row?.category, 'other', '未知扩展名 → category=other')
      assert.equal(
        row?.savePath,
        path.join(h.dir, 'file.xyz'),
        'other → savePath 落默认目录(defaultDir 兜底)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D3 视频选 mp4(预测 ext mp4)→ category=video、savePath 落 <下载>/Videos',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness({ result: SINGLE_VIDEO })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await flushVideo()
      assert.equal(h.read(id)?.status, 'awaiting_selection', '解析完成 → 待选(无默认清晰度)')
      assert.equal(
        h.read(id)?.category,
        null,
        'resolving / awaiting 期 category 仍为 null(无 filename,§3.4)'
      )

      // 选 1080p(纯视频 137 → +bestaudio 合并,预测 ext mp4)
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })

      const row = h.read(id)
      const videosDir = path.join(h.dir, 'Videos')
      assert.equal(
        row?.filename,
        'Clip [1080p].mp4',
        'filename = 标题 + 清晰度标签 [1080p] + 预测 ext(merge → mp4)'
      )
      assert.equal(row?.category, 'video', 'mp4 → category=video(按最终输出容器,§3.4)')
      assert.equal(
        row?.savePath,
        path.join(videosDir, 'Clip [1080p].mp4'),
        'savePath 落 Videos 目录'
      )
      assert.ok(fs.existsSync(videosDir), 'Videos 目录已自动创建')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D4 视频「仅音频 MP3」→ category=audio、savePath 落 <下载>/Music(按最终输出容器,§3.4)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness({ result: SINGLE_VIDEO })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await flushVideo()
      await h.manager.selectFormat(id, { audioOnly: true })

      const row = h.read(id)
      const musicDir = path.join(h.dir, 'Music')
      assert.equal(row?.filename, 'Clip.mp3', 'audioOnly → 预测 ext mp3')
      assert.equal(row?.category, 'audio', '仅音频 mp3 → category=audio(归音频类)')
      assert.equal(row?.savePath, path.join(musicDir, 'Clip.mp3'), 'savePath 落 Music 目录')
      assert.ok(fs.existsSync(musicDir), 'Music 目录已自动创建')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D5 显式指定目录 → savePath 用指定目录,但 category 仍按 filename 判定(§5.1)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    try {
      const customDir = path.join(h.dir, 'custom-target')
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/pack.zip',
        filename: 'pack.zip',
        dir: customDir
      })

      const row = h.read(id)
      assert.equal(
        row?.savePath,
        path.join(customDir, 'pack.zip'),
        '显式目录优先:savePath 用指定目录'
      )
      assert.equal(
        row?.category,
        'archive',
        'category 仍按 filename 判定(筛选语义稳定,不随显式目录变)'
      )
      assert.ok(fs.existsSync(customDir), '指定目录已自动创建')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D6 目录创建失败(EACCES)→ 任务落 error + 按 errno 映射可读提示「无写入权限」+ 下一步,引擎未接触(§5.3,Task 9 §3.2,不崩)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness({ ensureDirThrows: true })
    try {
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/sample.zip',
        filename: 'sample.zip'
      })

      const row = h.read(id)
      assert.equal(row?.status, 'error', 'ensureDir 失败 → 任务 error(可重试)')
      // Task 9:mock 抛 EACCES → 「无写入权限。下一步:…」(errno 可读映射,替代旧裸文案「无法创建保存目录」)
      assert.match(row?.error ?? '', /无写入权限/, 'EACCES → 可读 errno 中文提示')
      assert.match(row?.error ?? '', /下一步/, '附可操作下一步')
      assert.equal(row?.category, 'archive', 'category 仍写判定结果(失败也归档便于筛选)')
      assert.equal(h.engine.addUriCalls.length, 0, '目录失败 → 未提交引擎(不出队)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'D7 批量子任务各自分类路由 → 全部落 <下载>/Videos(各自独立目录,§5.2)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness({ result: PLAYLIST })
    try {
      const parentId = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/list' })
      await flushVideo()
      assert.equal(h.read(parentId)?.status, 'awaiting_selection', 'playlist → 批量待选')

      // 统一清晰度策略(无具体 format)→ 预测 ext mp4 → 子任务归 video
      await h.manager.submitBatch(
        parentId,
        batchPicks([0, 1], { audioOnly: false, heightCap: 1080 })
      )
      await tick()

      const children = h.manager.listTasks().filter((t) => t.kind === 'video')
      const videosDir = path.join(h.dir, 'Videos')
      assert.equal(children.length, 2, '勾选 2 条 → 2 子任务')
      for (const child of children) {
        assert.equal(child.category, 'video', '子任务 mp4 → category=video')
        assert.equal(path.dirname(child.savePath), videosDir, '子任务 savePath 落 Videos 目录')
      }
      assert.ok(fs.existsSync(videosDir), 'Videos 目录已自动创建')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== 配置改动生效 + 已存不回迁(spec §7.2 / §9,Phase 5)====================

test(
  'D8 updateCategory 改 archive 目录 → 缓存刷新后续 .zip 落新目录;已存任务不回迁(§7.2 / §9)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    // = category:update handler 行为(DAO 写 + 刷新 TaskManager 缓存);测试直接驱动这两步
    const { updateCategory } = await import('../db/categoryDao')
    try {
      // 改配置前先建一个 .zip → 落原 Archives(基线,后续验证不回迁)
      const beforeId = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/old.zip',
        filename: 'old.zip'
      })
      const oldArchives = path.join(h.dir, 'Archives')
      assert.equal(
        h.read(beforeId)?.savePath,
        path.join(oldArchives, 'old.zip'),
        '改配置前 .zip 落原 Archives'
      )

      // 经 DAO 改 archive 保存目录 + 刷新 TaskManager 缓存(category:update 链路核心两步)
      const newArchives = path.join(h.dir, 'NewArchives')
      updateCategory(h.db as unknown as CategoryDaoDatabase, 'archive', { savePath: newArchives })
      h.manager.refreshCategories()

      // 后续 .zip 落新目录:仅当缓存刷新生效(refreshCategories 重建 categories / extIndex)才成立
      const afterId = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/new.zip',
        filename: 'new.zip'
      })
      assert.equal(h.read(afterId)?.category, 'archive', '仍按扩展名判定 archive(类别稳定)')
      assert.equal(
        h.read(afterId)?.savePath,
        path.join(newArchives, 'new.zip'),
        '后续 .zip 落新目录(updateCategory + refreshCategories 缓存刷新生效)'
      )
      assert.ok(fs.existsSync(newArchives), '新目录已自动创建')

      // 已存任务不回迁:改目录只影响后续,beforeId 的 savePath 仍指向原 Archives(spec §9 不移动历史)
      assert.equal(
        h.read(beforeId)?.savePath,
        path.join(oldArchives, 'old.zip'),
        '已存任务 savePath 不回迁(改类别目录只影响后续任务)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== extensions 在线编辑 → 路由 + 链接识别实时同步(spec §5.4 / §7.2,Phase 6)====================

test(
  'D9 加 rmvb 到 video → 缓存刷新后续 .rmvb 归 video 目录 + classifyLink 判 http(改一处两处生效)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    // = category:update handler 行为(DAO 写 extensions + 刷新 TaskManager 缓存)
    const { updateCategory, listCategories } = await import('../db/categoryDao')
    const { classifyLink } = await import('../video/linkClassify')
    try {
      // 基线:rmvb 未知 → 归 other、落默认目录;链接 ambiguous(知名扩展名集未含 rmvb)
      const knownBefore = new Set(
        listCategories(h.db as unknown as CategoryDaoDatabase).flatMap((c) => c.extensions)
      )
      assert.equal(
        classifyLink('https://x/movie.rmvb', knownBefore).kind,
        'ambiguous',
        '改前 .rmvb 不在已知扩展名集 → ambiguous'
      )

      // 经 DAO 把 rmvb 加入 video.extensions(规范化在 DAO 内)+ 刷新缓存(category:update 链路核心两步)
      const video = listCategories(h.db as unknown as CategoryDaoDatabase).find(
        (c) => c.key === 'video'
      )
      updateCategory(h.db as unknown as CategoryDaoDatabase, 'video', {
        extensions: [...video!.extensions, 'rmvb']
      })
      h.manager.refreshCategories()

      // 路由:后续 .rmvb 新任务归 video 类、落 Videos 目录(仅当 extIndex 重建生效)
      const id = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/movie.rmvb',
        filename: 'movie.rmvb'
      })
      const videosDir = path.join(h.dir, 'Videos')
      assert.equal(h.read(id)?.category, 'video', '.rmvb → category=video(extensions 改后路由生效)')
      assert.equal(
        h.read(id)?.savePath,
        path.join(videosDir, 'movie.rmvb'),
        'savePath 落 Videos 目录'
      )

      // 链接识别:knownFileExts(渲染层据 category:list 聚合)含 rmvb → classifyLink 判 http
      const knownAfter = new Set(
        listCategories(h.db as unknown as CategoryDaoDatabase).flatMap((c) => c.extensions)
      )
      assert.equal(
        classifyLink('https://x/movie.rmvb', knownAfter).kind,
        'http',
        '改后 .rmvb 进已知扩展名集 → classifyLink 判 http(识别加固同步)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== 自定义类目录 → 重置「跟随」往返(诚实归类闭环 · spec §7.2 / §7.4,Phase 7 收口)====================
//
// 与 D8(跟随 → 改成自定义目录)对偶:本测验「自定义 → 重置 savePath='' → 实时跟随默认目录子目录」。
// 「重置为默认」UI 行为(SettingsPage「重置为默认」按钮)= updateCategory(key,{savePath:''})。空串是
// `!== undefined` 边界:若 DAO 误把 '' 当 falsy 跳过则重置失效,本测端到端锁定「空串真落库 + 路由跟随」。
// 已存任务不回迁(§7.4 续传归属:重置类别目录只影响后续)。

test(
  'D10 自定义 video 目录 → 重置 savePath="" → 后续 .mp4 跟随默认目录 Videos;空串落库 + 已存不回迁(§7.2 / §7.4)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startCategoryHarness()
    // = category:update handler 行为(DAO 写 savePath + 刷新 TaskManager 缓存);测试直接驱动这两步
    const { updateCategory, listCategories } = await import('../db/categoryDao')
    try {
      // 1) 用户自定义「视频」类目录(临时目录内,真实 ensureDir 可建)→ 非空覆盖;.mp4 落自定义目录(基线 + 已存样本)
      const customVideos = path.join(h.dir, 'MyCustomVideos')
      updateCategory(h.db as unknown as CategoryDaoDatabase, 'video', { savePath: customVideos })
      h.manager.refreshCategories()
      const customId = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/a.mp4',
        filename: 'a.mp4'
      })
      assert.equal(
        h.read(customId)?.savePath,
        path.join(customVideos, 'a.mp4'),
        '自定义期 .mp4 落自定义目录(savePath 非空覆盖)'
      )

      // 2) 「重置为默认」= updateCategory(savePath:'')。空串特例:!== undefined → 真落库重置,而非被当 falsy 跳过
      updateCategory(h.db as unknown as CategoryDaoDatabase, 'video', { savePath: '' })
      const videoRow = listCategories(h.db as unknown as CategoryDaoDatabase).find(
        (c) => c.key === 'video'
      )
      assert.equal(
        videoRow?.savePath,
        '',
        'updateCategory(savePath:"") 落库重置为空串(空串 !== undefined 边界,未被跳过)'
      )
      h.manager.refreshCategories()

      // 3) 重置后:后续 .mp4 实时跟随默认目录子目录(resolveCategoryDir 空串 → join(defaultDir, "Videos"))
      const followId = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/b.mp4',
        filename: 'b.mp4'
      })
      assert.equal(
        h.read(followId)?.savePath,
        path.join(h.dir, 'Videos', 'b.mp4'),
        '重置后 .mp4 跟随默认目录 Videos 子目录(实时计算,无烤死绝对路径)'
      )

      // 4) §7.4 续传归属:已存任务 savePath 不回迁(重置只影响后续新任务)
      assert.equal(
        h.read(customId)?.savePath,
        path.join(customVideos, 'a.mp4'),
        '已存任务 savePath 不回迁(重置类别目录只影响后续)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)
