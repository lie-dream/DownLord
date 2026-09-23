/**
 * 下载限速 + aria2c 加速 集成测试 — v0.2 Task 2 Phase 4(spec §7.2 L1–L4)。
 *
 * 真实 node:sqlite + 真实 settings.json 落盘(nodeSettingsStoreFs)+ FakeEngine,端到端验证:
 *   L1 全局限速持久化 + onChange 联动:setSettings({maxOverallLimitKBps}) → 落 settings.json 读回,
 *      据实复现 index.ts onChange 闭包调 downloadEngine.setGlobalLimit(fake no-op 不崩);
 *   L2 加速开关持久化:setSettings({useAria2cForVideo:false}) → 落盘 + 读回;getVideoAccel().enabled 随之变
 *      (注入 stub existsSync=true,仿 index.ts §6.5 装配);
 *   L3 单任务限速往返:manager.setTaskLimit(taskId,kbps) → engine.setTaskLimit(engineId,kbps)(FakeEngine 断言收到);
 *   L4 零回归:未设限速 / 未挂 aria2c(DEFAULT_APP_SETTINGS)→ 直链 buildAria2Args / 视频 buildYtDlpDownloadArgs
 *      逐字节等价 v0.1(无 --max-download-limit / --downloader / --limit-rate;v1.0 Task 8 · #100 起全局限速
 *      改为 `--max-download-limit` 每任务默认上限,判据字符串同步改为新键,否则恒不命中 = 空洞)。
 *
 * 仿 settings.integration.test.ts:不静态 import 触达 node:sqlite 的模块(动态 import);node:sqlite 不可用时优雅跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SettingsService } from '../settings/settingsService'
import { nodeSettingsStoreFs } from '../settings/nodeSettingsStoreFs'
import { DEFAULT_APP_SETTINGS } from '../../shared/ipc'
import type { AddUriInput, AppSettings, DownloadProgress } from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import { buildAria2Args } from '../engine/aria2Args'
import { buildYtDlpDownloadArgs } from '../video/ytdlpArgs'

// ==================== 原生模块能力探测 ====================

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

if (!SQLITE_OK && process.env.CI) {
  throw new Error(
    `[downloadLimitAccel.integration] node:sqlite 不可用(${process.version});CI 要求真跑。`
  )
}

// ==================== FakeEngine(记 setGlobalLimit / setTaskLimit / addUri)====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly globalLimitCalls: number[] = []
  readonly taskLimitCalls: Array<[string, number | null]> = []

  private counter = 0

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    return `eng_${++this.counter}`
  }

  async pause(): Promise<void> {
    /* no-op:本集成只验限速往返,暂停/恢复/删除非被测面(空体刻意) */
  }
  async resume(): Promise<void> {
    /* no-op:同上 */
  }
  async remove(): Promise<void> {
    /* no-op:同上 */
  }
  onProgress(_cb: (progress: DownloadProgress) => void): () => void {
    return () => {}
  }

  // Step 2 引擎接线:composite.setGlobalLimit(全局) / setTaskLimit(按 id 路由);此处 fake 仅记录调用
  async setGlobalLimit(kbps: number): Promise<void> {
    this.globalLimitCalls.push(kbps)
  }
  async setTaskLimit(engineId: string, kbps: number | null): Promise<void> {
    this.taskLimitCalls.push([engineId, kbps])
  }
}

// ==================== 辅助 ====================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-limit-'))
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

const configPathOf = (dir: string): string => path.join(dir, 'config', 'settings.json')

// ==================== L1 全局限速持久化 + onChange 联动 ====================

test('L1 全局限速 setSettings → settings.json 落盘读回 + onChange 调 downloadEngine.setGlobalLimit(fake 不崩)', async () => {
  const dir = makeTempDir()
  const configPath = configPathOf(dir)
  try {
    // 据实复现 index.ts §6.5 onChange 闭包:downloadEngine 是模块级实例,onChange 直接调 setGlobalLimit(非任务粒度)
    const downloadEngine = new FakeEngine()
    const settingsService = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: (s) => {
        void downloadEngine.setGlobalLimit(s.maxOverallLimitKBps)
      }
    })
    await settingsService.init()

    const returned = await settingsService.set({ maxOverallLimitKBps: 500 })
    assert.equal(returned.maxOverallLimitKBps, 500, 'set 回最新全量(clamp 后)')
    await drain()

    // onChange 联动:downloadEngine.setGlobalLimit(500) 被调(fake no-op 不崩)
    assert.deepEqual(downloadEngine.globalLimitCalls, [500], 'onChange → setGlobalLimit(500)')

    // 真实落盘 + 读回
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AppSettings
    assert.equal(persisted.maxOverallLimitKBps, 500, 'maxOverallLimitKBps 真实落盘 settings.json')

    // 改回 0(解除限速)→ 联动 setGlobalLimit(0)
    await settingsService.set({ maxOverallLimitKBps: 0 })
    await drain()
    assert.deepEqual(downloadEngine.globalLimitCalls, [500, 0], '改回 0 → setGlobalLimit(0)(解除)')
  } finally {
    cleanup(dir)
  }
})

// ==================== L2 加速开关持久化 + getVideoAccel 联动 ====================

test('L2 加速开关 setSettings → 落盘读回;getVideoAccel().enabled 随之变(existsSync stub=true)', async () => {
  const dir = makeTempDir()
  const configPath = configPathOf(dir)
  try {
    const settingsService = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await settingsService.init()

    // 据实复现 index.ts §6.5 注入回调:enabled = 开关 && aria2c 存在(此处 existsSync stub 恒 true)
    const aria2cPath = path.join(dir, 'bin', 'aria2c.exe')
    const stubExists = true
    const getVideoAccel = (): { enabled: boolean; aria2cPath: string } => ({
      enabled: settingsService.get().useAria2cForVideo && stubExists,
      aria2cPath
    })

    // 默认开(DEFAULT_APP_SETTINGS.useAria2cForVideo=true)→ enabled=true
    assert.equal(getVideoAccel().enabled, true, '默认开 + aria2c 存在 → enabled=true')

    await settingsService.set({ useAria2cForVideo: false })
    assert.equal(getVideoAccel().enabled, false, '关开关 → enabled=false(实时读)')

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AppSettings
    assert.equal(persisted.useAria2cForVideo, false, 'useAria2cForVideo=false 真实落盘')

    // 再开 → enabled 立即回 true
    await settingsService.set({ useAria2cForVideo: true })
    assert.equal(getVideoAccel().enabled, true, '再开 → enabled=true')
  } finally {
    cleanup(dir)
  }
})

// ==================== L3 单任务限速往返(TaskManager → engine) ====================

test(
  'L3 单任务限速往返:manager.setTaskLimit(taskId,kbps) → engine.setTaskLimit(engineId,kbps)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { initDatabase } = await import('../db/connection')
    const db = initDatabase(dbPath)
    const engine = new FakeEngine()
    const manager = new TaskManager(
      {
        engine,
        videoResolver: {
          resolve: async () => ({
            kind: 'video',
            id: 'x',
            title: 'x',
            durationSec: 0,
            thumbnail: null,
            extractor: 'x',
            webpageUrl: 'x',
            formats: [],
            subtitles: []
          })
        },
        initDatabase: () => db,
        getVideoPrefs: () => ({ defaultHeight: null, defaultAudioOnly: false }),
        ensureDir: () => {}
      },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    try {
      await manager.start()
      const taskId = await manager.addTask({
        kind: 'http',
        source: 'https://x/a.bin',
        filename: 'a.bin'
      })
      await drain()

      // 任务已提交引擎 → 取回 engineId(FakeEngine.addUri 返回 eng_1)
      assert.ok(engine.addUriCalls.length >= 1, '任务已提交引擎')
      const engineId = 'eng_1'

      await manager.setTaskLimit(taskId, 256)
      assert.deepEqual(
        engine.taskLimitCalls,
        [[engineId, 256]],
        '经 taskIdToEngineId 转引擎内部 id + kbps'
      )

      // 未知任务 id → 不调引擎(taskIdToEngineId 无映射)
      await manager.setTaskLimit('nope', 999)
      assert.equal(engine.taskLimitCalls.length, 1, '未知任务不触发引擎')

      // #25 第三态(v0.3 Task 4):null = 清除任务级覆盖 = 跟随全局 —— 原样透传引擎 + 内存清空(不落库)
      await manager.setTaskLimit(taskId, null)
      assert.deepEqual(engine.taskLimitCalls[1], [engineId, null], 'null 原样透传引擎(清除覆盖)')
      assert.equal(manager.getTask(taskId)?.limitKBps, undefined, '内存覆盖已清 → 回落全局')
    } finally {
      await manager.stop()
      cleanup(dir, db)
    }
  }
)

// ==================== L4 零回归(默认设置 → args 逐字节等价 v0.1) ====================

test('T8-A13 L4 零回归:DEFAULT_APP_SETTINGS(不限速/加速缺省)→ 直链 A / 视频 C args 无限速/加速参数', () => {
  // 直链 A:buildAria2Args 带 maxOverallLimitKBps=0(默认)→ 无 --max-download-limit(等价 v0.1;v1.0 Task 8 · #100 改键)
  const aria2WithDefault = buildAria2Args({
    port: 6800,
    secret: 's',
    dir: 'C:/dl',
    mainPid: 1234,
    maxOverallLimitKBps: DEFAULT_APP_SETTINGS.maxOverallLimitKBps
  })
  const aria2NoField = buildAria2Args({ port: 6800, secret: 's', dir: 'C:/dl', mainPid: 1234 })
  assert.deepEqual(aria2WithDefault, aria2NoField, '默认限速 0 与不传字段逐字节等价')
  assert.equal(
    aria2WithDefault.some((a) => a.includes('max-download-limit')),
    false,
    '无 --max-download-limit(零回归;默认 0 不加限速参数)'
  )

  // 视频 C:buildYtDlpDownloadArgs 不传 accel / limitKBps → 无 --downloader / --limit-rate(等价 v0.1)
  const ytArgs = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/x',
    dir: 'C:/dl',
    outputBase: 'clip',
    ffmpegPath: 'C:/bin/ffmpeg.exe',
    video: { formatSelector: 'best', audioOnly: false }
  })
  assert.equal(ytArgs.includes('--downloader'), false, '缺省不挂 aria2c(无 --downloader)')
  assert.equal(ytArgs.includes('--limit-rate'), false, '缺省不限速(无 --limit-rate)')
})
