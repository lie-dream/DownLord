/**
 * 设置页收口 集成测试 — Task 8 Phase 5(spec §8.3 / plan Phase 5)。
 *
 * 在 settingsService.test.ts(注入内存 fake fs 的纯单测)之上补两段真实集成,仿 integration.test.ts /
 * category.integration.test.ts:真实 node:sqlite + 真实 settings.json 落盘(nodeSettingsStoreFs)+ FakeEngine。
 *
 * 【Section E — SettingsService × TaskManager 联动(改后即时生效,spec §3.4 / §3.5)】
 *   据实复现 index.ts 的 `onChange` 联动闭包(`setMaxConcurrent` + `setDefaultDir`;主题 `nativeTheme.themeSource`
 *   属 §5、app runtime 装配,集成层无 Electron app,见 §E 注释),端到端验证:
 *     E1 set maxConcurrent 调大 → 出队补足(downloading 数随上限升);
 *     E2 set maxConcurrent 调小 → 不中断运行中 + 新任务排队(§3.5 语义);
 *     E3 set video.defaultHeight → 下一视频解析自动选格式(跳过 awaiting_selection,getVideoPrefs 读到新值);
 *     E4 set video.defaultAudioOnly → 下一视频自动选「仅音频 MP3」;
 *     E5 set defaultDir → 后续新任务兜底落新目录、已存任务不回迁(§3.5 / §7.4)。
 *
 * 【Section F — category:list 完整下发回归(spec §3.3 / §6.3）】
 *   真实 SQLite + 启动 seed 默认 6 类,验证 `category:list` 投影下发完整字段(key/displayName/extensions/savePath),
 *   且 chips / 类别筛选消费端仍只读 key+displayName(零回归)、设置页 / 链接识别加固可取 extensions/savePath。
 *
 * 同 integration.test.ts:不静态 import 触达 node:sqlite 的模块(connection/taskManager/dao 动态 import);
 * node:sqlite 不可用时优雅跳过(本地纯 node 直跑),CI 经 electron-as-node 恒可用、真跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SettingsService } from './settingsService'
import { nodeSettingsStoreFs } from './nodeSettingsStoreFs'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_COOKIE_CONFIG,
  DEFAULT_SUBTITLE_CHOICE
} from '../../shared/ipc'
import type {
  AddUriInput,
  AppSettings,
  CategoryConfig,
  DownloadProgress,
  ResolvedVideo,
  ResolveResult,
  Task,
  TaskStatus
} from '../../shared/ipc'
import type { TaskEngine } from '../tasks/taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'

// 渲染层消费端纯函数(验证 category:list 完整下发后 chips / 链接加固消费零回归 + 新字段消费;均无 DOM 依赖)
import { categoryLabel, categoryIconClass } from '../../renderer/src/lib/categoryView'
import { filterTasksByCategory } from '../../renderer/src/lib/categoryFilter'
import { describeLink } from '../../renderer/src/lib/linkClassifyView'

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
    `[settings.integration] node:sqlite 不可用(${process.version});` +
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

// ==================== 精简 FakeEngine(只驱动 addUri / 不真下载)====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []

  private counter = 0
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private readonly active = new Map<string, AddUriInput>()

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    const id = `eng_${++this.counter}`
    this.active.set(id, input)
    return id
  }

  async pause(): Promise<void> {
    /* fake 引擎:本套用例只验证设置联动,不涉及暂停语义 */
  }

  async resume(): Promise<void> {
    /* fake 引擎:同 pause,刻意空实现 */
  }

  async remove(id: string): Promise<void> {
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-settings-'))
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

/** 排空多级 fire-and-forget 链(resolve → onResolved → applySelection → triggerDequeue → addUri) */
async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await tick()
  }
}

interface SettingsHarness {
  dir: string
  db: { close(): void }
  settingsService: SettingsService
  manager: InstanceType<(typeof import('../tasks/taskManager'))['TaskManager']>
  engine: FakeEngine
  videoResolver: FakeVideoResolver
  configPath: string
  read: (id: string) => Task | null
  countByStatus: (status: TaskStatus) => number
}

/**
 * 起一套「真 SQLite + 真 settings.json 落盘 + FakeEngine + SettingsService(据实复现 index.ts onChange 联动)」夹具。
 *
 * 装配序仿 index.ts(spec §3.4):settingsService.init() → (initialPatch ? set) → 用 settings 推导
 * defaultDir/maxConcurrent 构造 TaskManager(getVideoPrefs 注入 `() => settingsService.get().video`)→ start。
 * onChange 闭包延迟引用 manager(构造在其后,故 initialPatch 的 set 在 manager=undefined 时 optional-chaining no-op)。
 * ensureDir 注入 no-op:联动测试不关心目录创建(分类落盘真实性由 category.integration 覆盖)。
 */
async function startSettingsHarness(
  opts: { initialPatch?: Partial<AppSettings>; resolveResult?: ResolveResult } = {}
): Promise<SettingsHarness> {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const configPath = path.join(dir, 'config', 'settings.json')
  const { TaskManager } = await import('../tasks/taskManager')
  const { initDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  const engine = new FakeEngine()
  const videoResolver = new FakeVideoResolver()
  if (opts.resolveResult !== undefined) {
    videoResolver.result = opts.resolveResult
  }

  // 据实复现 index.ts onChange 联动闭包(index.ts:169):并发即时出队补足 + 默认目录兜底(后续新任务)。
  // 主题联动(nativeTheme.themeSource = s.themeMode)属 §5 + app runtime,集成层无 Electron app/BrowserWindow,
  // 故省略;主题持久化往返由 settingsService 单测 + settings.json 真实落盘断言覆盖。
  const managerRef: { current?: InstanceType<typeof TaskManager> } = {}
  const settingsService = new SettingsService({
    store: nodeSettingsStoreFs,
    configPath,
    systemDownloadsDir: dir,
    onChange: (s) => {
      managerRef.current?.setMaxConcurrent(s.maxConcurrent)
      managerRef.current?.setDefaultDir(s.defaultDir || dir)
    }
  })
  await settingsService.init()
  if (opts.initialPatch) {
    await settingsService.set(opts.initialPatch) // manager 未构造 → onChange no-op;仅落盘 + 内存
  }
  const s0 = settingsService.get()

  const manager = new TaskManager(
    {
      engine,
      videoResolver,
      initDatabase: () => db,
      getVideoPrefs: () => settingsService.get().video,
      ensureDir: () => {}
    },
    { dbPath, defaultDir: s0.defaultDir, maxConcurrent: s0.maxConcurrent }
  )
  managerRef.current = manager
  await manager.start()

  const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)
  const countByStatus = (status: TaskStatus): number =>
    manager.listTasks().filter((t) => t.status === status).length

  return {
    dir,
    db,
    settingsService,
    manager,
    engine,
    videoResolver,
    configPath,
    read,
    countByStatus
  }
}

// ==================== Section E:SettingsService × TaskManager 联动 ====================

test(
  'E1 set maxConcurrent 调大 → 出队补足(downloading 数随上限升,§3.4 / §3.5)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startSettingsHarness({ initialPatch: { maxConcurrent: 2 } })
    try {
      for (let i = 1; i <= 4; i++) {
        await h.manager.addTask({
          kind: 'http',
          source: `https://x/${i}.bin`,
          filename: `${i}.bin`
        })
      }
      assert.equal(h.countByStatus('downloading'), 2, '上限 2 → 2 downloading')
      assert.equal(h.countByStatus('queued'), 2, '余 2 queued')

      // 经 settings:set 调大 → onChange → setMaxConcurrent(4) → 立即出队补足(fire-and-forget,drain 排空)
      const returned = await h.settingsService.set({ maxConcurrent: 4 })
      assert.equal(returned.maxConcurrent, 4, 'set 回最新全量(clamp 后真实值)')
      await drain()

      assert.equal(h.countByStatus('downloading'), 4, '调大上限 → 排队任务出队补足至 4 downloading')
      assert.equal(h.countByStatus('queued'), 0, '无排队剩余')

      // 真实落盘验证(settings.json 原子写)
      const persisted = JSON.parse(fs.readFileSync(h.configPath, 'utf-8')) as AppSettings
      assert.equal(persisted.maxConcurrent, 4, 'maxConcurrent 真实落盘 settings.json')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'E2 set maxConcurrent 调小 → 不中断运行中 + 新任务排队(§3.5 语义)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startSettingsHarness({ initialPatch: { maxConcurrent: 4 } })
    try {
      for (let i = 1; i <= 3; i++) {
        await h.manager.addTask({
          kind: 'http',
          source: `https://x/${i}.bin`,
          filename: `${i}.bin`
        })
      }
      assert.equal(h.countByStatus('downloading'), 3, '上限 4 → 3 downloading')

      await h.settingsService.set({ maxConcurrent: 1 }) // 调小至 1
      await drain()

      // 调小不杀运行中:3 个仍 downloading(超额任务自然完成后才按新上限,不强行中断)
      assert.equal(h.countByStatus('downloading'), 3, '调小上限不中断运行中任务(§3.5)')

      // 新任务在满槽(3 > 1)下进入排队
      await h.manager.addTask({ kind: 'http', source: 'https://x/4.bin', filename: '4.bin' })
      assert.equal(h.countByStatus('queued'), 1, '新任务排队(按新上限 1,无空位)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'E3 set video.defaultHeight → 下一视频解析自动选格式(跳过 awaiting,getVideoPrefs 读到新值,§3.4)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startSettingsHarness({ resolveResult: SINGLE_VIDEO })
    try {
      // 默认 video 偏好 { null, false } → 弹格式对话框(awaiting_selection)
      const v1 = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      assert.equal(h.read(v1)?.status, 'awaiting_selection', '无默认清晰度 → 待选(弹对话框)')

      // 经 settings:set 改默认清晰度 720P → getVideoPrefs 实时读到新值
      await h.settingsService.set({ video: { defaultHeight: 720, defaultAudioOnly: false } })

      const v2 = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      assert.equal(
        h.read(v2)?.status,
        'downloading',
        '已设默认清晰度 → 自动选 → 直接 downloading(不弹对话框)'
      )

      const videoCall = h.engine.addUriCalls.find((c) => c.video)
      assert.ok(videoCall, '自动选后提交引擎(带 video 提交参数)')
      assert.equal(
        videoCall?.video?.formatSelector,
        'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        'heightCap 策略选择器(getVideoPrefs 读到 settings.video.defaultHeight=720)'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'E4 set video.defaultAudioOnly → 下一视频自动选「仅音频 MP3」(§3.4)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startSettingsHarness({ resolveResult: SINGLE_VIDEO })
    try {
      await h.settingsService.set({ video: { defaultHeight: null, defaultAudioOnly: true } })

      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()

      const row = h.read(id)
      assert.equal(row?.status, 'downloading', '默认提取音频 → 自动选 → downloading')
      assert.match(row?.filename ?? '', /\.mp3$/, 'audioOnly → 预测 ext mp3')
      assert.equal(row?.videoMeta?.postProcess, 'mp3', 'postProcess=mp3 落库')
      const videoCall = h.engine.addUriCalls.find((c) => c.video)
      assert.equal(
        videoCall?.video?.audioOnly,
        true,
        '提交 audioOnly=true(yt-dlp 内部 ffmpeg 提取)'
      )
      assert.equal(videoCall?.video?.formatSelector, 'bestaudio/best', '仅音频选择器')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'E5 set defaultDir → 后续新任务兜底落新目录;已存任务不回迁(§3.5 / §7.4)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startSettingsHarness()
    try {
      // 改目录前先建一个 .xyz(未知扩展 → other → 落原 defaultDir,基线)
      const before = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/old.xyz',
        filename: 'old.xyz'
      })
      assert.equal(
        h.read(before)?.savePath,
        path.join(h.dir, 'old.xyz'),
        '改目录前 .xyz 落原默认目录'
      )

      const newDir = path.join(h.dir, 'NewDownloads')
      await h.settingsService.set({ defaultDir: newDir }) // onChange → setDefaultDir(newDir)
      await drain()

      const after = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/new.xyz',
        filename: 'new.xyz'
      })
      assert.equal(
        h.read(after)?.savePath,
        path.join(newDir, 'new.xyz'),
        '后续新任务兜底落新默认目录(setDefaultDir 联动生效)'
      )

      // 已存任务 savePath 不回迁(§7.4 续传归属:改默认目录只影响后续)
      assert.equal(
        h.read(before)?.savePath,
        path.join(h.dir, 'old.xyz'),
        '已存任务 savePath 不回迁'
      )
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

// ==================== Section F:category:list 完整下发回归 ====================

/** 起一套「真 SQLite + 启动 seed 默认 6 类(savePath='' 跟随)」库句柄(category:list 数据源) */
async function seedCategoryDb(
  dir: string
): Promise<{ db: { close(): void }; list: CategoryConfig[] }> {
  const dbPath = path.join(dir, 'downlord.db')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories, listCategories } = await import('../db/categoryDao')
  // 直用 category:list handler 的真实投影纯函数(projectCategoryList,Step 3 落地):复用 resolveCategoryDir
  // 解析真实目录(savePath='' → 跟随默认目录子目录;非空 → 自定义)+ isCustom,与路由同源同值(spec §1.7)。
  const { projectCategoryList } = await import('../ipc/category')
  const db = initDatabase(dbPath)
  seedDefaultCategories(db)
  const list = projectCategoryList(listCategories(db), dir)
  return { db, list }
}

function makeCategorizedTask(id: string, category: string | null): Task {
  return {
    id,
    kind: 'http',
    source: `https://x/${id}`,
    status: 'completed',
    filename: id,
    savePath: `D:\\Downloads\\${id}`,
    category,
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
}

test(
  'F1 category:list 投影下发完整字段(key/displayName/extensions/savePath,6 类)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const { db, list } = await seedCategoryDb(dir)
    try {
      assert.equal(list.length, 6, 'seed 默认 6 类')
      for (const c of list) {
        assert.ok(c.key && c.displayName, 'key / displayName 非空(chips 用)')
        assert.ok(Array.isArray(c.extensions), 'extensions 完整下发(设置页 / 链接加固用)')
        assert.ok(
          typeof c.savePath === 'string' && c.savePath.length > 0,
          'savePath 完整下发(设置页用)'
        )
      }

      const video = list.find((c) => c.key === 'video')!
      assert.ok(
        video.extensions.includes('mkv') && video.extensions.includes('mp4'),
        'video 类 extensions 完整(含 mp4/mkv)'
      )
      assert.equal(video.savePath, path.join(dir, 'Videos'), 'video savePath = <下载>/Videos')

      const other = list.find((c) => c.key === 'other')!
      assert.deepEqual(other.extensions, [], 'other extensions 为空数组(判定兜底,完整下发)')
      assert.equal(other.savePath, dir, 'other savePath = 默认下载目录')
    } finally {
      cleanup(dir, db)
    }
  }
)

test(
  'F2 chips / 类别筛选消费端只读 key+displayName(新增字段零回归)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const { db, list } = await seedCategoryDb(dir)
    try {
      // chips 文案优先取 category:list displayName(可改名);displayName 完整下发
      const videoConf = list.find((c) => c.key === 'video')!
      assert.equal(videoConf.displayName, '视频', 'chips 取 category:list displayName')

      // categoryView 静态映射只用 key(忽略 extensions/savePath 新增字段 → 零回归)
      assert.equal(categoryLabel('video'), '视频', 'categoryLabel 只按 key')
      assert.equal(categoryLabel('all'), '全部', 'all 静态文案')
      assert.equal(
        categoryIconClass('video'),
        'video',
        'categoryIconClass 只按 key(与 TaskRow 同源)'
      )
      assert.equal(categoryIconClass('archive'), 'file', 'archive/document/program 复用文件图标')

      // filterTasksByCategory 只按 task.category(与类别新增字段正交)
      const tasks = [
        makeCategorizedTask('a', 'video'),
        makeCategorizedTask('b', 'audio'),
        makeCategorizedTask('c', null)
      ]
      assert.deepEqual(
        filterTasksByCategory(tasks, 'video').map((t) => t.id),
        ['a'],
        '具体类别按 category 筛'
      )
      assert.deepEqual(
        filterTasksByCategory(tasks, 'all').map((t) => t.id),
        ['a', 'b', 'c'],
        'all 原样返回'
      )
      assert.deepEqual(
        filterTasksByCategory(tasks, 'audio').map((t) => t.id),
        ['b'],
        'category=null 在具体类别下不显示'
      )
    } finally {
      cleanup(dir, db)
    }
  }
)

test(
  'F3 设置页 / 链接识别加固消费 extensions/savePath(端到端 category:list 完整下发,§6.3)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const { db, list } = await seedCategoryDb(dir)
    try {
      // 设置页「分类与保存位置」:过滤 other,取每类 savePath + extensions 描述
      const settingsRows = list.filter((c) => c.key !== 'other')
      assert.equal(settingsRows.length, 5, '设置页列 5 个具体类别(过滤 other)')
      for (const c of settingsRows) {
        assert.ok(c.savePath.length > 0, '设置页可取 savePath(显示 / 编辑目录)')
        assert.ok(c.extensions.length > 0, '设置页可取 extensions(描述文案)')
      }

      // 链接识别加固:AddTaskDialog 聚合全类别 extensions → describeLink 判 http(spec §6.3 实时数据流)
      const knownExts = new Set(list.flatMap((c) => c.extensions))
      assert.equal(
        describeLink('https://example.com/a/file.docx', knownExts).suggestedKind,
        'http',
        '.docx(document 类)→ http'
      )
      assert.equal(
        describeLink('https://example.com/movie.mkv', knownExts).suggestedKind,
        'http',
        '.mkv(video 类)→ http'
      )
      assert.equal(
        describeLink('https://example.com/song.flac', knownExts).suggestedKind,
        'http',
        '.flac(audio 类)→ http'
      )
      assert.equal(
        describeLink('https://example.com/app.deb', knownExts).suggestedKind,
        'http',
        '.deb(program 类)→ http'
      )
      assert.equal(
        describeLink('https://example.com/data.xyz', knownExts).suggestedKind,
        'video',
        '.xyz 未知扩展 → 默认 video(保持 PRD §5)'
      )
      assert.equal(
        describeLink('https://youtube.com/watch?v=abc', knownExts).kind,
        'video',
        '视频站点优先于扩展名'
      )

      // 不传 knownFileExts(向后兼容):.docx 退化 ambiguous→video(仅内置 DIRECT_FILE_EXTS)
      assert.equal(
        describeLink('https://example.com/a/file.docx').suggestedKind,
        'video',
        '不传 knownFileExts → 退化(向后兼容,零回归)'
      )
    } finally {
      cleanup(dir, db)
    }
  }
)

// ==================== Section G:持久化跨会话 + 真实损坏回退(真 settings.json 落盘,§3.5 / §7.3）====================
//
// settingsService.test.ts 用注入内存 fake fs;本段用真实 nodeSettingsStoreFs 落盘 + 跨实例 init,
// 端到端验证「重启保持」(Done #4 持久化跨会话)与真实 FS 下的损坏回退修复(§7.3)。不依赖 node:sqlite。

function makeConfigPath(dir: string): string {
  return path.join(dir, 'config', 'settings.json')
}

test('G1 配置持久化跨会话:set → 新 SettingsService init 读回(真实 settings.json 落盘,Done #4)', async () => {
  const dir = makeTempDir()
  const configPath = makeConfigPath(dir)
  try {
    // 第一次会话:写入非默认配置(真实落盘)
    const s1 = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await s1.init()
    await s1.set({
      themeMode: 'dark',
      maxConcurrent: 6,
      defaultDir: 'E:\\Media',
      video: { defaultHeight: 1080, defaultAudioOnly: true }
    })

    // 第二次会话:全新 SettingsService 读同一 settings.json(模拟应用重启)
    const s2 = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await s2.init()
    const restored = s2.get()

    assert.equal(restored.themeMode, 'dark', '主题档跨会话保持(Done #4)')
    assert.equal(restored.maxConcurrent, 6, '并发跨会话保持')
    assert.equal(restored.defaultDir, 'E:\\Media', '默认目录跨会话保持')
    assert.deepEqual(
      restored.video,
      {
        defaultHeight: 1080,
        defaultAudioOnly: true,
        // cookie / subtitle(v0.2 Task 1):跨会话经 mergeSettings 补全默认,往返一致
        cookie: DEFAULT_COOKIE_CONFIG,
        subtitle: DEFAULT_SUBTITLE_CHOICE
      },
      '视频偏好跨会话保持'
    )
  } finally {
    cleanup(dir)
  }
})

test('G2 settings.json 真实损坏 → init 回退默认 + 重写修复为合法 JSON(§7.3,不静默丢弃可重建)', async () => {
  const dir = makeTempDir()
  const configPath = makeConfigPath(dir)
  try {
    // 真实写入损坏 JSON(先建 config 父目录)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '{ corrupted json ]', 'utf-8')

    const service = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await service.init() // 不崩

    const s = service.get()
    assert.equal(
      s.maxConcurrent,
      DEFAULT_APP_SETTINGS.maxConcurrent,
      '损坏 → 回退默认 maxConcurrent'
    )
    assert.equal(s.themeMode, DEFAULT_APP_SETTINGS.themeMode, '回退默认 themeMode')
    assert.deepEqual(s.video, DEFAULT_APP_SETTINGS.video, '回退默认 video')
    assert.equal(s.defaultDir, dir, '空 defaultDir 解析为系统下载目录')

    // settings.json 已被重写修复为合法 JSON(§7.3「不静默丢弃」精神:此为可重建标量配置,非源数据)
    const repaired = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    assert.equal(typeof repaired, 'object', 'settings.json 已修复为合法 JSON(可再次解析)')
    assert.equal(repaired.maxConcurrent, DEFAULT_APP_SETTINGS.maxConcurrent, '修复后落盘默认值')
  } finally {
    cleanup(dir)
  }
})

// ==================== Section H:改默认目录 → 分类目录实时跟随(真 SQLite,取代 C2)====================
//
// Task 8.5 Phase 1 移除 C2 智能同步回调:分类目录改语义为
// 「savePath='' = 跟随默认目录子目录 / 非空 = 自定义覆盖」,resolveCategoryDir 按当前 defaultDir 实时解析。
// 改默认目录后,未自定义类别下一次路由即跟随新目录,无需任何「同步」步骤(spec §1.3 / §1.4)。
// 自定义类别(savePath 非空)保留;已存任务不回迁(§7.4)。

test(
  'H1 改默认目录 → 未自定义类别新任务实时跟随新目录子目录;自定义类别保留;已存不回迁(真 SQLite)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const configPath = makeConfigPath(dir)
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('../db/connection')
    const { seedDefaultCategories, updateCategory } = await import('../db/categoryDao')
    const { TaskManager } = await import('../tasks/taskManager')
    const { getTask } = await import('../db/taskDao')
    const db = initDatabase(dbPath)
    try {
      seedDefaultCategories(db) // 全部 savePath='' 跟随
      updateCategory(db, 'video', { savePath: 'E:\\MyMovies' }) // 用户自定义「视频」类(非空 → 覆盖)

      const engine = new FakeEngine()
      const videoResolver = new FakeVideoResolver()
      const managerRef: { current?: InstanceType<typeof TaskManager> } = {}
      const settingsService = new SettingsService({
        store: nodeSettingsStoreFs,
        configPath,
        systemDownloadsDir: dir,
        onChange: (s) => {
          managerRef.current?.setMaxConcurrent(s.maxConcurrent)
          managerRef.current?.setDefaultDir(s.defaultDir || dir)
        }
      })
      await settingsService.init() // defaultDir 解析为 dir
      const s0 = settingsService.get()
      const manager = new TaskManager(
        {
          engine,
          videoResolver,
          initDatabase: () => db,
          getVideoPrefs: () => settingsService.get().video,
          ensureDir: () => {} // 不真实建目录(E:\MyMovies / 新目录在测试机不存在)
        },
        { dbPath, defaultDir: s0.defaultDir, maxConcurrent: s0.maxConcurrent }
      )
      managerRef.current = manager
      await manager.start() // 读入 categories 缓存(audio savePath='' / video='E:\MyMovies')
      const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)

      // 改目录前:.mp3(audio,未自定义)落原 <dir>/Music(基线,后续验证不回迁)
      const before = await manager.addTask({
        kind: 'http',
        source: 'https://x/a.mp3',
        filename: 'a.mp3'
      })
      assert.equal(
        read(before)?.savePath,
        path.join(dir, 'Music', 'a.mp3'),
        'audio 未自定义 → 原默认目录子目录'
      )

      // 改默认目录 → onChange → setDefaultDir(newRoot);无「同步」步骤
      const newRoot = path.join(dir, 'NewRoot')
      await settingsService.set({ defaultDir: newRoot })
      await drain()

      // 未自定义类别(audio)新任务实时跟随新目录子目录(resolveCategoryDir 实时按 defaultDir 解析)
      const afterAudio = await manager.addTask({
        kind: 'http',
        source: 'https://x/b.mp3',
        filename: 'b.mp3'
      })
      assert.equal(
        read(afterAudio)?.savePath,
        path.join(newRoot, 'Music', 'b.mp3'),
        'audio 未自定义 → 实时跟随新目录(无同步)'
      )

      // 自定义类别(video)保留绝对路径,不跟随默认目录
      const afterVideo = await manager.addTask({
        kind: 'http',
        source: 'https://x/c.mp4',
        filename: 'c.mp4'
      })
      assert.equal(
        read(afterVideo)?.savePath,
        path.join('E:\\MyMovies', 'c.mp4'),
        'video 自定义 → 保留 E:\\MyMovies,不跟随'
      )

      // 已存任务不回迁(§7.4 续传归属:改默认目录只影响后续)
      assert.equal(
        read(before)?.savePath,
        path.join(dir, 'Music', 'a.mp3'),
        '已存任务 savePath 不回迁'
      )

      await manager.stop()
    } finally {
      cleanup(dir, db)
    }
  }
)
