/**
 * 接管路径的查重串接集成测试(I-03;v0.4 Task 4 · spec §6.1 / §6.3 / §3.7 · plan 3.3)。
 *
 * 起**真 SQLite TaskManager**(既有 `addTask` 全链路,零旁路)+ 注入 fake 引擎 / fake 磁盘 +
 * fake 接管小窗口 + fake 主窗口集,端到端验证:
 *   ① 命中查重 → `addTask` 返回 id 但**未插库**(扣留在内存,CONTEXT.md「扣留」)
 *   ② 冲突**定向**送到接管小窗口(`takeover:duplicate`)
 *   ③ ★ **主窗口一份都没收到** `task:duplicate` —— 这是 §6.3 广播定向真的生效的机器凭证
 *   ④ 点 `rename` → 插库,且文件名带 ` (1)`(既有 `nextAvailableStem`,一个字没改)
 *   ⑤ 查重态下关窗 → 未决冲突被**显式** `skip`(黑洞第三变体的正面处理,§3.7)
 *
 * 接线顺序**刻意与 `index.ts` 一致**:先 `registerTaskIpc` 那条广播订阅,再 `takeoverService.start()`
 * 的定向订阅 —— 广播那份跑在前面,故「定向能不能拦住它」在本测试里是真的被考了一遍。
 *
 * 仿 `duplicate.integration.test.ts`:动态 import 触达 node:sqlite 的模块,不可用时优雅跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type {
  AddUriInput,
  DownloadProgress,
  DuplicateConflict,
  Task,
  TakeoverBatch
} from '../../shared/ipc'
import { IpcChannel } from '../../shared/ipc'
import { broadcastDuplicate, type DuplicateBroadcastWindow } from '../ipc/task'
import type { TaskEngine } from '../tasks/taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'
import { TakeoverService, type TakeoverWindowHandle } from './takeoverService'
import { cloneDefaultTakeoverConfig } from './takeoverConfig'

// ==================== 原生模块能力探测(同步、不静态加载)====================

const requireForProbe = createRequire(import.meta.url)

function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (p: string) => { close(): void }
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
  const msg = `[takeoverDuplicate.integration] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

const T0 = 1_700_000_000_000
const SOURCE = 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe?sign=abc'
const REFERRER = 'https://uu.163.com/session'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'
const FILENAME = 'UU-6.15.1.exe'

// ==================== 精简 fake ====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  private counter = 0

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    return `eng_${++this.counter}`
  }
  async pause(): Promise<void> {
    // 接管查重夹具不校验暂停 / 恢复 / 删除语义:空实现即满足 TaskEngine 契约
  }
  async resume(): Promise<void> {
    // 同 pause
  }
  async remove(): Promise<void> {
    // 同 pause
  }
  onProgress(_cb: (progress: DownloadProgress) => void): () => void {
    return () => {}
  }
}

interface FakeTakeoverWindow extends TakeoverWindowHandle {
  sent: { channel: string; payload: unknown }[]
  fireClosed(): void
}

function makeTakeoverWindow(): FakeTakeoverWindow {
  const closedCallbacks: (() => void)[] = []
  let destroyed = false
  const win: FakeTakeoverWindow = {
    sent: [],
    send: (channel, payload) => void win.sent.push({ channel, payload }),
    showOnce: () => {},
    setContentHeight: () => {},
    close: () => {
      destroyed = true
      for (const cb of closedCallbacks) cb()
    },
    isDestroyed: () => destroyed,
    webContentsId: () => (destroyed ? null : 101),
    onClosed: (cb) => void closedCallbacks.push(cb),
    fireClosed: () => {
      destroyed = true
      for (const cb of closedCallbacks) cb()
    }
  }
  return win
}

interface FakeMainWindow extends DuplicateBroadcastWindow {
  received: DuplicateConflict[]
}

function makeMainWindow(): FakeMainWindow {
  const received: DuplicateConflict[] = []
  return {
    received,
    isDestroyed: () => false,
    webContents: { send: (_channel, conflict) => void received.push(conflict) }
  }
}

// ==================== 夹具 ====================

interface Harness {
  takeover: TakeoverService
  manager: InstanceType<(typeof import('../tasks/taskManager'))['TaskManager']>
  engine: FakeEngine
  windows: FakeTakeoverWindow[]
  mainWindows: FakeMainWindow[]
  dir: string
  saveDir: string
  existingFiles: Set<string>
  read: (id: string) => Task | null
  count: () => number
  flushTimers(): void
  advance(ms: number): void
  cleanup(): void
}

/** 起「真 SQLite + FakeEngine + 注入磁盘 + fake 窗口」的接管查重夹具 */
async function startHarness(options: { seedCompleted?: boolean } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-tkdup-'))
  // ★ 显式落点(≠ defaultDir)→ `explicitDirOf` 判显式 → savePath 完全确定,
  //   查重的「同目录」判据因此可复现(不依赖类别表的默认子目录)
  const saveDir = path.join(dir, 'Picked')
  fs.mkdirSync(saveDir, { recursive: true })
  const dbPath = path.join(dir, 'downlord.db')

  const { TaskManager } = await import('../tasks/taskManager')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { insertTask, getTask, listTasks } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  seedDefaultCategories(db)

  const existingFiles = new Set<string>()
  if (options.seedCompleted) {
    const savePath = path.join(saveDir, FILENAME)
    insertTask(db as unknown as TaskDaoDatabase, {
      id: 'seeded',
      kind: 'http',
      source: SOURCE,
      status: 'completed',
      filename: FILENAME,
      savePath,
      category: 'programs',
      totalBytes: 1000,
      downloadedBytes: 1000,
      speed: 0,
      videoMeta: null,
      torrentMeta: null,
      error: null,
      createdAt: 1,
      startedAt: 1,
      completedAt: 2
    })
    existingFiles.add(savePath)
  }

  const engine = new FakeEngine()
  const manager = new TaskManager(
    {
      engine,
      videoResolver: { resolve: async () => ({ kind: 'video' }) } as never,
      initDatabase: () => db,
      ensureDir: () => {},
      existsSync: (p) => existingFiles.has(p),
      readDir: (d) =>
        [...existingFiles].filter((p) => path.dirname(p) === d).map((p) => path.basename(p)),
      trashItem: async (p) => void existingFiles.delete(p)
    },
    { dbPath, defaultDir: dir, maxConcurrent: 3 }
  )
  await manager.start()

  // ── 接线顺序与 index.ts 一致:广播订阅在前,定向订阅在后 ──────────────────
  const mainWindows = [makeMainWindow(), makeMainWindow()]
  let takeoverRef: TakeoverService | null = null
  manager.onDuplicate((conflict) => {
    broadcastDuplicate(
      conflict,
      { isOwnedByTakeover: (id) => takeoverRef?.owns(id) ?? false },
      mainWindows
    )
  })

  let now = T0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const windows: FakeTakeoverWindow[] = []
  const takeover = new TakeoverService({
    now: () => now,
    // 查重路径与接管配置无关:给一份默认值 store,写入丢弃(不落真实文件系统)
    configStore: { read: async () => cloneDefaultTakeoverConfig(), write: async () => {} },
    onConfigChanged: () => {},
    scheduleTick: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    createWindow: () => {
      const win = makeTakeoverWindow()
      windows.push(win)
      return win
    },
    isAppReady: () => true,
    hasMainWindow: () => true,
    addTask: (input) => manager.addTask(input),
    onTaskCreated: () => {},
    onDuplicate: (cb) => manager.onDuplicate(cb),
    resolveDuplicate: (res) => manager.resolveDuplicate(res),
    suggestFilename: () => FILENAME,
    getResolvedTheme: () => 'dark',
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  })
  takeoverRef = takeover
  takeover.start()

  return {
    takeover,
    manager,
    engine,
    windows,
    mainWindows,
    dir,
    saveDir,
    existingFiles,
    read: (id) => getTask(db as unknown as TaskDaoDatabase, id),
    count: () => listTasks(db as unknown as TaskDaoDatabase).length,
    advance: (ms) => void (now += ms),
    flushTimers: () => {
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.at > now) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    cleanup: () => {
      takeover.stop()
      try {
        db.close()
      } catch {
        /* 忽略 */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 走一遍「意图 → 500ms 聚合 → 呈现」,回当前批 */
function present(h: Harness): TakeoverBatch {
  h.takeover.handleIntent({
    url: SOURCE,
    referrer: REFERRER,
    danger: 'safe',
    totalBytes: 1000,
    userAgent: UA
  })
  h.flushTimers() // 预热建窗
  h.takeover.onRendererReady()
  h.advance(500)
  h.flushTimers()
  return h.windows[0].sent[0].payload as TakeoverBatch
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

// ─────────────────────────────────────────────────────────────────────────────

test(
  'I-03 查重命中:未插库 + 冲突定向到小窗口 + ★ 主窗口零收到 + rename 后插库带 (1)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness({ seedCompleted: true })
    try {
      const before = h.count()
      const batch = present(h)

      h.takeover.onSubmit({
        items: [{ id: batch.items[0].id, filename: FILENAME }],
        dir: h.saveDir // 显式落点 = seeded 记录所在目录 → 同源 + 同目录 + 同 stem
      })
      await flush()

      // ① 扣留:不插库、不提交引擎
      assert.equal(h.count(), before, '★ 命中查重 → 不插库(任务扣在内存里等决策)')
      assert.equal(h.engine.addUriCalls.length, 0, '未提交引擎')

      // ② 定向:接管小窗口收到 takeover:duplicate
      const duplicates = h.windows[0].sent.filter((s) => s.channel === IpcChannel.TakeoverDuplicate)
      assert.equal(duplicates.length, 1, '接管小窗口收到冲突')
      const conflict = duplicates[0].payload as DuplicateConflict
      assert.equal(conflict.kind, 'http')
      assert.equal(conflict.items[0].filename, FILENAME)
      assert.equal(conflict.items[0].existing, 'completed')

      // ③ ★ 主窗口一份都没收到 —— §6.3 广播定向的机器凭证
      for (const [i, win] of h.mainWindows.entries()) {
        assert.equal(
          win.received.length,
          0,
          `★ 第 ${i + 1} 个主窗口不得收到 task:duplicate(否则弹陈旧僵尸框,违反「主窗口全程不动」)`
        )
      }

      // ④ 点「重命名」→ 插库且文件名带 (1)(既有 nextAvailableStem,一个字没改)
      await h.manager.resolveDuplicate({ conflictId: conflict.conflictId, decision: 'rename' })
      await flush()
      assert.equal(h.count(), before + 1, '决策落地后才插库')
      const created = h.read(conflict.conflictId)
      assert.equal(created?.filename, 'UU-6.15.1 (1).exe')
      assert.equal(created?.savePath, path.join(h.saveDir, 'UU-6.15.1 (1).exe'))
      // ★ headers 是运行时内存态:落库那条记录里没有它(DAO 列清单不带)
      assert.equal(
        (created as unknown as Record<string, unknown>).headers,
        undefined,
        '★ headers 不落库(重启即清,spec §6.2 有界遗留)'
      )
      // 但内存里的任务带着 headers → 出队提交引擎时 referer 真的下发
      assert.deepStrictEqual(h.engine.addUriCalls[0].headers, { Referer: REFERRER, 'User-Agent': UA })
    } finally {
      h.cleanup()
    }
  }
)

test(
  'I-03 无冲突时照旧:插库 + 提交引擎带 headers + 主窗口仍零收到(没有冲突可收)',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness()
    try {
      const batch = present(h)
      h.takeover.onSubmit({
        items: [{ id: batch.items[0].id, filename: FILENAME }],
        dir: h.saveDir
      })
      await flush()

      assert.equal(h.count(), 1, '无冲突 → 直接插库')
      assert.equal(h.engine.addUriCalls.length, 1)
      assert.deepStrictEqual(h.engine.addUriCalls[0].headers, {
        Referer: REFERRER,
        'User-Agent': UA
      })
      assert.equal(h.mainWindows[0].received.length, 0)
      assert.equal(h.windows[0].isDestroyed(), true, '无未决冲突 → 处理完即关窗')
    } finally {
      h.cleanup()
    }
  }
)

test(
  '★ 查重态下直接关窗 → 未决冲突显式 skip(不静默蒸发 = 不是黑洞),任务不入库',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness({ seedCompleted: true })
    try {
      const before = h.count()
      const batch = present(h)
      h.takeover.onSubmit({
        items: [{ id: batch.items[0].id, filename: FILENAME }],
        dir: h.saveDir
      })
      await flush()
      assert.equal(h.count(), before, '决策前不插库')

      // 用户直接关窗(不点四决策)
      h.windows[0].fireClosed()
      await flush()

      assert.equal(h.count(), before, 'skip = 直接丢弃,不插库 —— 这正是关窗的语义')
      assert.equal(h.engine.addUriCalls.length, 0)

      // ★ 已被显式决策 → 冲突从 pendingConflicts 里消失;再来一次 resolve 只会命中「未知 conflictId」
      const conflictId = (
        h.windows[0].sent.find((s) => s.channel === IpcChannel.TakeoverDuplicate)!
          .payload as DuplicateConflict
      ).conflictId
      assert.equal(
        h.takeover.owns(conflictId),
        false,
        'R6:关窗即清 ownedConflictIds(否则该 id 永远拦着主窗口的查重框)'
      )
    } finally {
      h.cleanup()
    }
  }
)

test(
  'R6 三处清理点之一:决策点完(takeover:settled)→ ownedConflictIds 清空并推进',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness({ seedCompleted: true })
    try {
      const batch = present(h)
      h.takeover.onSubmit({
        items: [{ id: batch.items[0].id, filename: FILENAME }],
        dir: h.saveDir
      })
      await flush()

      const conflictId = (
        h.windows[0].sent.find((s) => s.channel === IpcChannel.TakeoverDuplicate)!
          .payload as DuplicateConflict
      ).conflictId
      assert.equal(h.takeover.owns(conflictId), true, '决策前:归接管路径独占')
      assert.equal(h.windows[0].isDestroyed(), false, '★ 点完四决策才关窗(Step 0 第 6 条)')

      await h.manager.resolveDuplicate({ conflictId, decision: 'skip' })
      h.takeover.onDuplicatesSettled()
      await flush()

      assert.equal(h.takeover.owns(conflictId), false, '★ 决策落地即清,不泄漏(R6)')
      assert.equal(h.windows[0].isDestroyed(), true, '缓冲空 → 关窗')
    } finally {
      h.cleanup()
    }
  }
)
