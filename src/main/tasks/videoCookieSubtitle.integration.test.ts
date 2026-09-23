/**
 * v0.2 Task 1 收口 集成测试 — Cookie 登录 + 字幕下载(spec §7.2 / plan Phase 5)。
 *
 * 在 Phase 1–4 的纯函数 / 引擎注入 / UI 单测之上补三段端到端往返,仿 settings.integration.test.ts /
 * category.integration.test.ts:真实 node:sqlite + 真实 settings.json 落盘(nodeSettingsStoreFs)+ FakeEngine +
 * FakeVideoResolver(吐 mock subtitles)。据实复现 index.ts 的 `getCookie` 注入闭包
 * (`() => settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG`),端到端验证:
 *
 *   CS1 Cookie 设置往返:settingsService.set(video.cookie) → settings.json 真实落盘 → getCookie() 读到新值;
 *       持久化只存来源选择(source/browser/file 路径),**不存 cookie 内容本身**(§2.6 合规);
 *       toYtdlpCookieArgs(getCookie()) 映射为正确 yt-dlp 参数(解析 + 下载注入端到端)。
 *   CS2 字幕持久化往返:video 任务 → selectFormat(带 subtitles)→ videoMeta.subtitle 落库 → 重启恢复
 *       (新 TaskManager 同库 recoverSubmit)→ rebuildVideoSubmit 重建 VideoSubmit.subtitles 一致 →
 *       buildYtDlpDownloadArgs 重启前后**逐字节一致**(§4.2 / §7.2)。
 *   CS3 零回归基线:直链 http + Cookie=none + 无字幕 → 不带 video 分支、cookie / subtitle args 为空,
 *       与 v0.1 逐字节等价(§2.1 / §3.2 零回归)。
 *
 * 同 settings.integration.test.ts:不静态 import 触达 node:sqlite 的模块(connection/taskManager/dao 动态 import);
 * node:sqlite 不可用时优雅跳过(本地纯 node 直跑),CI 经 electron-as-node 恒可用、真跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SettingsService } from '../settings/settingsService'
import { nodeSettingsStoreFs } from '../settings/nodeSettingsStoreFs'
import { DEFAULT_COOKIE_CONFIG, DEFAULT_SUBTITLE_CHOICE } from '../../shared/ipc'
import type {
  AddUriInput,
  AppSettings,
  CookieConfig,
  DownloadProgress,
  ResolvedVideo,
  ResolveResult,
  SubtitleChoice,
  Task,
  VideoSubmit
} from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'

import { toYtdlpCookieArgs } from '../video/ytdlpCookie'
import { buildYtDlpDownloadArgs } from '../video/ytdlpArgs'

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
    `[videoCookieSubtitle.integration] node:sqlite 不可用(${process.version});` +
    ' 须经 electron-as-node 运行(npm test)。'
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

// ==================== 解析样本(含字幕)====================

/** 单视频含 subtitles(zh-Hans 人工 / en 人工 / zh-Hans 自动),供 FormatDialog 字幕区 + 往返验证 */
const SINGLE_VIDEO_WITH_SUBS: ResolvedVideo = {
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
  subtitles: [
    { lang: 'zh-Hans', name: 'Chinese', auto: false },
    { lang: 'en', name: 'English', auto: false },
    { lang: 'zh-Hans', name: 'Chinese (auto)', auto: true }
  ]
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
    /* fake 引擎:本套用例只验证 cookie / 字幕参数往返,不涉及暂停语义 */
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

/** 可控 mock VideoResolver(吐 mock -J 结果;异步模拟真实 yt-dlp 子进程,使 addTask 先返回 resolving) */
class FakeVideoResolver {
  readonly resolveCalls: string[] = []
  result: ResolveResult = SINGLE_VIDEO_WITH_SUBS

  async resolve(url: string): Promise<ResolveResult> {
    this.resolveCalls.push(url)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    return this.result
  }
}

// ==================== 公共辅助 ====================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-task1-'))
}

function makeConfigPath(dir: string): string {
  return path.join(dir, 'config', 'settings.json')
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

interface Harness {
  dir: string
  db: { close(): void }
  settingsService: SettingsService
  manager: InstanceType<(typeof import('./taskManager'))['TaskManager']>
  engine: FakeEngine
  videoResolver: FakeVideoResolver
  configPath: string
  /** 据实复现 index.ts 装配:getCookie = () => settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG */
  getCookie: () => CookieConfig
  read: (id: string) => Task | null
}

/**
 * 起一套「真 SQLite + 真 settings.json 落盘 + FakeEngine + FakeVideoResolver + SettingsService」夹具。
 * 装配序仿 index.ts + settings.integration.test.ts;额外据实注入 getCookie 闭包(cookie 全局、实时读、
 * 解析 + 下载注入,与 proxy 对称,§2.2 / §6.3)。ensureDir 注入 no-op(目录真实性由 category.integration 覆盖)。
 */
async function startHarness(opts: { resolveResult?: ResolveResult } = {}): Promise<Harness> {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const configPath = makeConfigPath(dir)
  const { TaskManager } = await import('./taskManager')
  const { initDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  const engine = new FakeEngine()
  const videoResolver = new FakeVideoResolver()
  if (opts.resolveResult !== undefined) {
    videoResolver.result = opts.resolveResult
  }

  const settingsService = new SettingsService({
    store: nodeSettingsStoreFs,
    configPath,
    systemDownloadsDir: dir,
    onChange: () => {}
  })
  await settingsService.init()
  const s0 = settingsService.get()

  // index.ts 装配(spec §4.5 / §6.3):cookie 每次 resolve / spawn 前实时取;可选字段兜底默认。
  const getCookie = (): CookieConfig => settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG

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
  await manager.start()

  const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)
  return { dir, db, settingsService, manager, engine, videoResolver, configPath, getCookie, read }
}

/** 固定入参构造 buildYtDlpDownloadArgs(比对重启前后 args 逐字节一致;仅 video / cookie 变量) */
function argsFor(video: VideoSubmit, cookie?: CookieConfig): string[] {
  return buildYtDlpDownloadArgs({
    url: 'https://youtu.be/clip',
    dir: 'D:\\Downloads\\Videos',
    outputBase: 'Clip [1080p]',
    ffmpegPath: 'C:\\ffmpeg.exe',
    video,
    cookie
  })
}

// ==================== CS1:Cookie 设置往返(真 settings.json 落盘,§7.2 / §2.6)====================

test('CS1 Cookie 设置往返:set(video.cookie) → settings.json 落盘 → getCookie 读到新值(不存内容,§2.6)', async () => {
  const dir = makeTempDir()
  const configPath = makeConfigPath(dir)
  try {
    const settingsService = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await settingsService.init()
    const getCookie = (): CookieConfig =>
      settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG

    // 初值 = 默认 none(向后兼容,零附加)
    assert.deepEqual(getCookie(), DEFAULT_COOKIE_CONFIG, '初值 = DEFAULT_COOKIE_CONFIG(none)')
    assert.deepEqual(toYtdlpCookieArgs(getCookie()), [], 'none → 零附加 yt-dlp 参数(零回归)')

    // ① 从浏览器(Firefox)→ getCookie 实时读到新值 → 映射 --cookies-from-browser firefox
    const returned = await settingsService.set({
      video: {
        defaultHeight: null,
        defaultAudioOnly: false,
        cookie: { source: 'browser', browser: 'firefox', profile: null, file: null }
      }
    })
    assert.equal(returned.video.cookie?.source, 'browser', 'set 回最新全量(cookie.source=browser)')
    assert.deepEqual(
      getCookie(),
      { source: 'browser', browser: 'firefox', profile: null, file: null },
      'getCookie 实时读到浏览器档'
    )
    assert.deepEqual(
      toYtdlpCookieArgs(getCookie()),
      ['--cookies-from-browser', 'firefox'],
      '映射 --cookies-from-browser firefox(解析 + 下载注入端到端)'
    )

    // 真实落盘验证:settings.json 只存来源选择(source/browser/file 路径),不存 cookie 内容本身(§2.6 合规)
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AppSettings
    assert.equal(persisted.video.cookie?.source, 'browser', 'cookie.source 真实落盘 settings.json')
    assert.equal(persisted.video.cookie?.browser, 'firefox', 'cookie.browser 真实落盘')
    const rawJson = fs.readFileSync(configPath, 'utf-8')
    assert.equal(
      /sessdata|cookie.?value|"value"/i.test(rawJson),
      false,
      'settings.json 不含任何 cookie 内容 / 值(§2.6:只存来源,不存内容)'
    )

    // ② 从文件 → 只存路径 → 映射 --cookies <path>
    const cookieTxt = path.join(dir, 'cookies.txt')
    await settingsService.set({
      video: {
        defaultHeight: null,
        defaultAudioOnly: false,
        cookie: { source: 'file', browser: null, profile: null, file: cookieTxt }
      }
    })
    assert.deepEqual(
      toYtdlpCookieArgs(getCookie()),
      ['--cookies', cookieTxt],
      '文件档映射 --cookies <path>'
    )

    // 跨会话:全新 SettingsService 读同一 settings.json(模拟重启)→ cookie 档保持
    const s2 = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await s2.init()
    assert.equal(s2.get().video.cookie?.source, 'file', 'cookie 档跨会话保持(重启读回)')
    assert.equal(s2.get().video.cookie?.file, cookieTxt, 'cookie 文件路径跨会话保持')
  } finally {
    cleanup(dir)
  }
})

// ==================== CS2:字幕持久化往返(选字幕 → 落库 → 重启 → rebuild 一致,§7.2 / §4.2)====================

test(
  'CS2 字幕持久化往返:选字幕 → videoMeta.subtitle 落库 → 重启恢复 → rebuild args 逐字节一致',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness({ resolveResult: SINGLE_VIDEO_WITH_SUBS })
    const subtitleChoice: SubtitleChoice = {
      langs: ['zh-Hans', 'en'],
      format: 'srt',
      includeAuto: false
    }
    let firstDbPath = ''
    let beforeVideo: VideoSubmit | undefined
    try {
      firstDbPath = path.join(h.dir, 'downlord.db')
      // 视频任务 → 默认偏好(null/false)→ awaiting_selection(弹对话框)
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      assert.equal(h.read(id)?.status, 'awaiting_selection', '无默认清晰度 → 待选')

      // FormatDialog 勾字幕(zh-Hans + en,SRT,不含自动生成)→ selectFormat 携带 subtitles
      await h.manager.selectFormat(id, {
        audioOnly: false,
        formatId: '137',
        subtitles: subtitleChoice
      })
      await drain()

      // ① 字幕选择落库(videoMeta.subtitle,JSON 列,不改 schema)
      const row = h.read(id)
      assert.equal(row?.status, 'downloading', '选定 → 出队 → downloading')
      assert.deepEqual(
        row?.videoMeta?.subtitle,
        subtitleChoice,
        'videoMeta.subtitle 真实落库(JSON 列)'
      )

      // ② 下载提交:rebuildVideoSubmit → VideoSubmit.subtitles 到位 → 引擎收到字幕选择
      const call = h.engine.addUriCalls.find((c) => c.video)
      assert.ok(call?.video, '视频任务带 video 提交参数')
      assert.deepEqual(
        call?.video?.subtitles,
        subtitleChoice,
        'VideoSubmit.subtitles 随 rebuildVideoSubmit 到位'
      )
      beforeVideo = call!.video
    } finally {
      await h.manager.stop()
      // 保留 db 文件不删(重启需读同库);仅关闭句柄
      h.db.close()
    }

    // ③ 重启恢复:全新 TaskManager + 全新 FakeEngine 挂同一 db 文件(downloading → recoverSubmit 重提交)
    const { initDatabase } = await import('../db/connection')
    const { TaskManager } = await import('./taskManager')
    const db2 = initDatabase(firstDbPath)
    const engine2 = new FakeEngine()
    const resolver2 = new FakeVideoResolver()
    const manager2 = new TaskManager(
      {
        engine: engine2,
        videoResolver: resolver2,
        initDatabase: () => db2,
        getVideoPrefs: () => ({ defaultHeight: null, defaultAudioOnly: false }),
        ensureDir: () => {}
      },
      { dbPath: firstDbPath, defaultDir: path.join(h.dir, 'dl'), maxConcurrent: 3 }
    )
    try {
      await manager2.start() // buildRecoveryPlan:downloading → toSubmit → recoverSubmit → addUri
      await drain()

      const recovered = engine2.addUriCalls.find((c) => c.video)
      assert.ok(recovered?.video, '重启恢复重提交视频任务(带 video)')
      assert.deepEqual(
        recovered?.video?.subtitles,
        subtitleChoice,
        '重启后 rebuildVideoSubmit 重建 subtitles 一致(videoMeta JSON 往返)'
      )

      // ④ 端到端:重启前后 buildYtDlpDownloadArgs 逐字节一致 + 含字幕参数段(§7.2 args 一致)
      const afterVideo = recovered!.video!
      const argsBefore = argsFor(beforeVideo!)
      const argsAfter = argsFor(afterVideo)
      assert.deepEqual(argsAfter, argsBefore, '重启前后 yt-dlp 下载 args 逐字节一致')
      assert.ok(
        argsAfter.includes('--write-subs') &&
          argsAfter.includes('--sub-langs') &&
          argsAfter.includes('zh-Hans,en'),
        'args 含字幕段(--write-subs --sub-langs zh-Hans,en)'
      )
      assert.equal(
        argsAfter.includes('--write-auto-subs'),
        false,
        'includeAuto=false → 不含 --write-auto-subs'
      )
    } finally {
      await manager2.stop()
      cleanup(h.dir, db2)
    }
  }
)

// ==================== CS3:零回归基线(http + cookie=none + 无字幕,§2.1 / §3.2)====================

test(
  'CS3 零回归基线:直链 http + Cookie=none + 无字幕 → 无 video 分支、cookie / subtitle args 为空',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness()
    try {
      // 默认设置:cookie=none / subtitle 空
      assert.deepEqual(h.getCookie(), DEFAULT_COOKIE_CONFIG, '默认 cookie=none')
      assert.deepEqual(
        h.settingsService.get().video.subtitle,
        DEFAULT_SUBTITLE_CHOICE,
        '默认字幕偏好为空 langs'
      )

      // 直链 http:不带 video 分支(唯一分流点),cookie=none → toYtdlpCookieArgs=[]
      await h.manager.addTask({ kind: 'http', source: 'https://x/file.bin', filename: 'file.bin' })
      await drain()
      const call = h.engine.addUriCalls.find((c) => c.url === 'https://x/file.bin')
      assert.ok(call, 'http 任务提交引擎')
      assert.equal(call?.video, undefined, 'http 任务不带 video 分支(路由 aria2,零回归)')
      assert.deepEqual(toYtdlpCookieArgs(h.getCookie()), [], 'cookie=none → 零附加 yt-dlp 参数')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'CS3b 视频任务不选字幕 → rebuildVideoSubmit.subtitles undefined → 下载 args 无字幕段(逐字节零回归)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness({ resolveResult: SINGLE_VIDEO_WITH_SUBS })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/clip' })
      await drain()
      // 不带 subtitles 的选择(用户未开字幕区)
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })
      await drain()

      const row = h.read(id)
      assert.equal(
        row?.videoMeta?.subtitle,
        undefined,
        '未选字幕 → videoMeta.subtitle undefined(不写)'
      )

      const call = h.engine.addUriCalls.find((c) => c.video)
      assert.equal(call?.video?.subtitles, undefined, 'VideoSubmit.subtitles undefined')

      // 下载 args:无字幕段;与「显式空字幕选择」等价(langs 空 → toYtdlpSubtitleArgs=[])
      const args = argsFor(call!.video!)
      assert.equal(
        args.includes('--write-subs'),
        false,
        '无字幕选择 → args 不含 --write-subs(零回归)'
      )
      assert.equal(args.includes('--sub-langs'), false, 'args 不含 --sub-langs')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)
