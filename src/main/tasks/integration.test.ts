/**
 * TaskManager × 持久化 集成测试 — spec §8.2 / plan Phase 4(集成七条链路)。
 *
 * 分两段,均按需跳过、绝不在不具备条件时假绿:
 *
 * 【Section A — 真实 SQLite(node:sqlite)+ 可控 FakeEngine(确定性)】
 *   用真实 node:sqlite 跑通 TaskManager↔DB↔状态机↔并发↔重启恢复 的端到端持久化,
 *   下载侧用可控 FakeEngine 驱动进度(无需 aria2c)。覆盖全部 7 条逻辑链路:
 *   add→完成落库 / 暂停·恢复 / 删除 / 重启恢复+重提交(§7.4)/ 并发控制 / 损坏库恢复(§7.3)/ 错误重试。
 *   node:sqlite 只在 Electron 运行时存在;`npm test` 经 electron-as-node 运行 → 恒可用 → 七链路真跑。
 *   CI 下若不可用即 throw(不静默 skip 掩盖,R2);本地误用纯 node 直跑时优雅 skip。
 *
 * 【Section B — 真实 aria2c + 真实 SQLite + 本地 HTTP server(真下载,需真二进制)】
 *   spec/plan 所述「真实 DownloadEngine」口径:真下载 + 真续传 + 文件哈希校验。
 *   resources/bin 为占位二进制时 SKIP;放入真 aria2c.exe 后 `DOWNLORD_REAL_ENGINE=1 npm test` 运行。
 *
 * 设计要点:本文件**不静态 import** 任何触达 node:sqlite 的模块(connection/taskManager 经动态
 * import 在 test 体内加载),故在 node:sqlite 不可用的运行时,文件本身仍能加载、相关用例只是 SKIP。
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
  Task,
  TaskProgress,
  TaskStatus,
  VideoPrefs
} from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import type { ManagedTaskEngine } from '../engine/compositeEngine'
import type { TaskDaoDatabase } from '../db/taskDao'

// ==================== 原生模块能力探测(同步、不静态加载)====================

const requireForProbe = createRequire(import.meta.url)

/** 探测 node:sqlite 是否可用(只在 Electron 运行时存在;经 electron-as-node 恒可用) */
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
    `[integration] node:sqlite 不可用(${process.version});` +
    ' 须经 electron-as-node 运行(npm test)。'
  if (process.env.CI) {
    // CI 门禁:不可用即失败,绝不静默 skip 掩盖(R2 收口)
    throw new Error(`${msg} CI 要求 Section A 真跑,判定为运行时配置错误。`)
  }
  // 本地防呆:开发者误用纯 node 直跑时优雅跳过,不假失败
  console.log(`${msg} 本地优雅跳过 Section A。`)
}

// ==================== 可控 FakeEngine(驱动进度,无需 aria2c)====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly pauseCalls: string[] = []
  readonly resumeCalls: string[] = []
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

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

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

  emitProgress(filename: string, downloadedBytes: number, totalBytes: number): void {
    this.emit({
      id: this.engineIdFor(filename),
      status: 'downloading',
      totalBytes,
      downloadedBytes,
      speed: 0,
      connections: 1
    })
  }

  complete(filename: string, bytes: number): void {
    const id = this.engineIdFor(filename)
    this.active.get(id)!.done = true
    this.emit({
      id,
      status: 'completed',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: 1
    })
  }

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
}

// ==================== 公共辅助 ====================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-tm-'))
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

/** 事件循环排空:完成/失败事件里 fire-and-forget 的出队落库在微任务里完成 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'filename'>): Task {
  return {
    kind: 'http',
    source: `https://example.test/${overrides.filename}`,
    status: 'queued',
    savePath: `D:\\Downloads\\${overrides.filename}`,
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
  }
}

// ==================== Section A:真实 SQLite + FakeEngine ====================

test('A1 add → 下载 → 完成落库(真实 SQLite)', { skip: !SQLITE_OK }, async () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { getDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const engine = new FakeEngine()
  const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

  try {
    await manager.start()
    const db = getDatabase()

    const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
    engine.emitProgress('a.bin', 512, 2048)
    engine.complete('a.bin', 2048)

    const row = getTask(db as unknown as TaskDaoDatabase, id)
    assert.equal(row?.status, 'completed', 'status=completed 落库')
    assert.ok(row?.completedAt, 'completedAt 非空')
    assert.equal(row?.downloadedBytes, 2048)
    assert.equal(row?.totalBytes, 2048, 'downloadedBytes=totalBytes')

    await manager.stop()
    cleanup(dir, db)
  } catch (err) {
    cleanup(dir)
    throw err
  }
})

test('A2 暂停 / 恢复(真实 SQLite)', { skip: !SQLITE_OK }, async () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { getDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const engine = new FakeEngine()
  const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

  try {
    await manager.start()
    const db = getDatabase()
    const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)

    const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })

    await manager.pauseTask(id)
    assert.equal(read(id)?.status, 'paused', 'pause → DB paused')
    assert.equal(engine.pauseCalls.length, 1)

    await manager.resumeTask(id)
    assert.equal(read(id)?.status, 'downloading', 'resume → DB downloading')

    engine.complete('a.bin', 1000)
    assert.equal(read(id)?.status, 'completed', '恢复后可完成')

    await manager.stop()
    cleanup(dir, db)
  } catch (err) {
    cleanup(dir)
    throw err
  }
})

test('A3 删除(真实 SQLite)', { skip: !SQLITE_OK }, async () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { getDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const engine = new FakeEngine()
  const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

  try {
    await manager.start()
    const db = getDatabase()

    const id = await manager.addTask({ kind: 'http', source: 'https://x/a.bin', filename: 'a.bin' })
    assert.ok(getTask(db as unknown as TaskDaoDatabase, id), '删除前 DB 有记录')

    await manager.removeTask(id)
    assert.equal(getTask(db as unknown as TaskDaoDatabase, id), null, 'removeTask → DB 无记录')
    assert.deepEqual(engine.removeCalls, ['eng_1'], '引擎侧也收到删除')

    await manager.stop()
    cleanup(dir, db)
  } catch (err) {
    cleanup(dir)
    throw err
  }
})

test('A4 重启恢复 + 重提交续传(真实 SQLite,跨实例)', { skip: !SQLITE_OK }, async () => {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { getDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  let conn1: { close(): void } | null = null
  let conn2: { close(): void } | null = null
  try {
    // ---- 第一次运行:落库两个未完成任务 ----
    const engine1 = new FakeEngine()
    const realTm1 = new TaskManager(
      { engine: engine1 },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    await realTm1.start()
    conn1 = getDatabase()

    const idA = await realTm1.addTask({
      kind: 'http',
      source: 'https://x/a.bin',
      filename: 'a.bin'
    })
    const idB = await realTm1.addTask({
      kind: 'http',
      source: 'https://x/b.bin',
      filename: 'b.bin'
    })
    // 两个都在 downloading(maxConcurrent=3)
    assert.equal(getTask(conn1 as unknown as TaskDaoDatabase, idA)?.status, 'downloading')
    assert.equal(getTask(conn1 as unknown as TaskDaoDatabase, idB)?.status, 'downloading')

    // ---- 模拟停主进程(不删 .aria2;FakeEngine 无盘文件)----
    await realTm1.stop()
    conn1.close()
    conn1 = null

    // ---- 第二次运行:全新 TaskManager + 全新引擎,读同一库恢复 ----
    const engine2 = new FakeEngine()
    const tm2 = new TaskManager({ engine: engine2 }, { dbPath, defaultDir: dir, maxConcurrent: 3 })
    await tm2.start()
    conn2 = getDatabase()

    // §7.4:重提交只传业务信息(url/dir/filename),不含任何字节进度
    const resubmitted = engine2.addUriCalls.map((c) => c.filename).sort()
    assert.deepEqual(resubmitted, ['a.bin', 'b.bin'], '未完成任务重新提交引擎续传')
    for (const call of engine2.addUriCalls) {
      assert.deepEqual(
        Object.keys(call).sort(),
        ['dir', 'filename', 'url'],
        '重提交载荷只有业务信息'
      )
      assert.ok(call.url && call.filename, 'url/filename 非空')
    }

    // 恢复后任务仍在(历史不丢),状态为 downloading
    assert.equal(
      getTask(conn2 as unknown as TaskDaoDatabase, idA)?.status,
      'downloading',
      '任务 A 恢复'
    )
    assert.equal(
      getTask(conn2 as unknown as TaskDaoDatabase, idB)?.status,
      'downloading',
      '任务 B 恢复'
    )

    // 恢复后能驱动到完成
    engine2.complete('a.bin', 4096)
    assert.equal(
      getTask(conn2 as unknown as TaskDaoDatabase, idA)?.status,
      'completed',
      '续传后可完成'
    )

    await tm2.stop()
  } finally {
    cleanup(dir, conn1, conn2)
  }
})

test(
  'A5 并发控制:5 任务 maxConcurrent=3 → 3 下载 / 2 排队;完成 1 → 出队 1(真实 SQLite)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { getDatabase } = await import('../db/connection')
    const { listTasks } = await import('../db/taskDao')

    const engine = new FakeEngine()
    const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

    try {
      await manager.start()
      const db = getDatabase()
      const statusOf = (): Record<string, TaskStatus> =>
        Object.fromEntries(
          listTasks(db as unknown as TaskDaoDatabase).map((t) => [t.filename, t.status])
        )

      for (let i = 1; i <= 5; i++) {
        await manager.addTask({ kind: 'http', source: `https://x/${i}.bin`, filename: `${i}.bin` })
      }

      let s = statusOf()
      assert.equal(
        Object.values(s).filter((x) => x === 'downloading').length,
        3,
        '3 个 downloading'
      )
      assert.equal(Object.values(s).filter((x) => x === 'queued').length, 2, '2 个 queued')
      assert.equal(s['4.bin'], 'queued')
      assert.equal(s['5.bin'], 'queued')

      engine.complete('1.bin', 10)
      await tick()

      s = statusOf()
      assert.equal(s['1.bin'], 'completed')
      assert.equal(s['4.bin'], 'downloading', 'FIFO:完成 1 个 → 下一个 queued 出队')
      assert.equal(s['5.bin'], 'queued')

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)

test(
  'A6 损坏库恢复:quick_check 失败 → 备份旧库再新建(§7.3,真实 SQLite)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('../db/connection')
    const { insertTask } = await import('../db/taskDao')

    let db2: {
      close(): void
      prepare(sql: string): { get(): unknown }
      quickCheck(): string
    } | null = null
    try {
      // 1) 建正常库 + 落入一条「历史」
      const db1 = initDatabase(dbPath)
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        makeTask({ id: 'h1', filename: 'history.bin', status: 'completed' })
      )
      db1.close()

      // 2) 清掉 WAL 边车文件,再用垃圾覆盖主库 → 制造损坏
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = dbPath + suffix
        if (fs.existsSync(sidecar)) {
          fs.unlinkSync(sidecar)
        }
      }
      fs.writeFileSync(dbPath, Buffer.alloc(4096, 0x7a)) // 非法 SQLite 头

      // 3) 重新初始化 → 应备份损坏库、删除、重建
      db2 = initDatabase(dbPath) as unknown as typeof db2

      const backups = fs.readdirSync(dir).filter((f) => f.startsWith('downlord.db.backup.'))
      assert.ok(backups.length >= 1, `应生成带时间戳的备份文件,实际: ${backups.join(',')}`)

      assert.equal(db2!.quickCheck(), 'ok', '新库自检通过')
      const ver = db2!.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number
      }
      assert.equal(
        ver.v,
        4,
        '新库迁移到当前最高版本 version=4(v3 重建 tasks 表 + torrentMeta 列;v4 加 idx_tasks_source)'
      )

      cleanup(dir, db2)
    } catch (err) {
      cleanup(dir, db2)
      throw err
    }
  }
)

test(
  'A7 错误重试:error 落库 → retry 重新下发 → 可完成(真实 SQLite)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const engine = new FakeEngine()
    const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

    try {
      await manager.start()
      const db = getDatabase()
      const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)

      const id = await manager.addTask({
        kind: 'http',
        source: 'https://x/a.bin',
        filename: 'a.bin'
      })
      engine.fail('a.bin', 'HTTP_403')

      assert.equal(read(id)?.status, 'error', 'status=error 落库')
      assert.equal(read(id)?.error, 'HTTP_403', 'error 字段非空')

      await manager.retryTask(id)
      assert.equal(read(id)?.status, 'downloading', 'retry → queued → 出队 downloading')
      assert.equal(read(id)?.error, null, 'error 字段已清空')
      assert.equal(engine.addUriCalls.length, 2, '重新下发引擎')

      engine.complete('a.bin', 2048)
      assert.equal(read(id)?.status, 'completed', '重试后可完成')

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)

// ==================== I-09:零 schema(v0.4 Task 4 · spec §7.2 / §9.1 的 §7.3 行)====================
//
// 为什么这条必须存在,而 `git diff src/main/db/` 与 `grep -rn "headers" src/main/db/` 不够:
//   那两条只能证明「**这一次**没人动 db 层」,证不了「**日后**有人给 tasks 加列时会被拦住」。
//   接管路径是第一条往 addTask 里塞运行时态字段(headers)的通路,而运行时态与持久态的分界
//   一旦被谁顺手抹掉(比如把 headers 落进 tasks 表「方便重启后续传」),上面两条判据全都照样绿。
//
// ★ **「加列即红」的确切边界(2026-08-04 三次反向探针实测,不是推断)**:
//   · 改 `schema.ts::TASKS_TABLE_SQL` 加一列 → **本条不红**,而这是**正确**的:v3 迁移用
//     **字面自包含**的 SQL 重建 tasks(见 migration.ts 注释「迁移历史一经发布即为定值」),
//     故 schema.ts 的新列会被那次重建丢掉,**根本没进最终表**。
//   · 加一条 v5 迁移 `ALTER TABLE tasks ADD COLUMN headers TEXT` → **本条变红**,报错直接打印
//     实际列集合。这才是真实失效模式。⚠️ 同时还会红 5 条既有的「version=4」断言 —— 但那 5 条
//     红的是「版本号变了」,**换成任何别的列名它们照红、换成 headers 它们也不多说一句**;
//     真正指名 headers 的只有本条。日后若有人为正当理由加 v5,那 5 条会被顺手改成 version=5,
//     **此后拦住 headers 落库的就只剩本条**。
//
// ⚠️ 正向对照是本条的一半:只断言「列里没有 headers」是个**恒真的空判据**——
//   headers 压根没进过流程时它同样绿。故先断言 headers **确实贯通到了引擎**(engine.addUriCalls),
//   证明这一趟真的走了接管形态,再断言它**没有落库**。该对照已实测有效:把 addTask 的
//   `headers: filterDownloadHeaders(input.headers)` 改成 `headers: undefined` → 本条当场变红。
test(
  'I-09 零 schema:走完带 headers 的完整接管流程 → schema_version 同值 + tasks 列集合不含 headers(真实 SQLite)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const engine = new FakeEngine()
    const manager = new TaskManager({ engine }, { dbPath, defaultDir: dir, maxConcurrent: 3 })

    try {
      await manager.start()
      const db = getDatabase() as unknown as {
        close(): void
        prepare(sql: string): { get(): unknown; all(): unknown[] }
      }

      const schemaVersionOf = (): number =>
        (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
      const taskColumns = (): string[] =>
        (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)

      const versionBefore = schemaVersionOf()
      const columnsBefore = taskColumns()

      // 走一趟**接管形态**的完整流程:带 headers 进 addTask → 出队下发引擎 → 完成落库
      const id = await manager.addTask({
        kind: 'http',
        source: 'https://cdn.example.test/pkg.bin',
        filename: 'pkg.bin',
        headers: { Referer: 'https://example.test/page', 'User-Agent': 'UA/1.0' }
      })
      engine.emitProgress('pkg.bin', 512, 2048)
      engine.complete('pkg.bin', 2048)
      await tick()

      // ── 正向对照:headers 真的贯通到了引擎(否则下面的「不含 headers」是空判据)──
      const submitted = engine.addUriCalls.at(-1)
      assert.deepEqual(
        submitted?.headers,
        { Referer: 'https://example.test/page', 'User-Agent': 'UA/1.0' },
        '★ 正向对照:headers 必须真的下发到引擎 —— 否则本用例证明不了任何事'
      )

      // ── I-09 本体:运行时态没有变成持久态 ──
      assert.equal(schemaVersionOf(), versionBefore, 'schema_version 与流程前同值(零迁移)')
      const columnsAfter = taskColumns()
      assert.deepEqual(columnsAfter, columnsBefore, 'tasks 列集合与流程前逐字相同')
      assert.ok(
        !columnsAfter.includes('headers'),
        `★ tasks 表不得有 headers 列(运行时态不落库,ARCHITECTURE §7.3);实际列:${columnsAfter.join(',')}`
      )

      // ── 落库的那一行本身也不许带 headers(DAO 形状保证,不是自觉)──
      const row = getTask(db as unknown as TaskDaoDatabase, id)
      assert.equal(row?.status, 'completed', '任务确实走完了整条链路(不是半途失败导致的假绿)')
      assert.ok(
        !Object.prototype.hasOwnProperty.call(row ?? {}, 'headers'),
        '从库里读回来的任务不得带 headers 键'
      )

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)

// ==================== Section C:视频全链路(真实 SQLite + CompositeDownloadEngine + mock VideoResolver)====================
//
// Phase 6 集成(spec §9.2):在 Section A(直链)之上补视频第二条主线的端到端持久化集成。
// 相对 taskManager.test.ts 单元测试的增量:
//   ① 真实 node:sqlite —— videoMeta(JSON)/ 视频态(resolving / awaiting_selection / processing)/
//      savePath 校正 真序列化往返;
//   ② 真实 CompositeDownloadEngine —— 双执行器路由透明(video→yt-dlp 后端、http→aria2 后端,同一
//      manager 归一),非直接 mock TaskEngine;
//   ③ 跨实例重启恢复视频各态。
// 下载后端用 ManagedFakeBackend(可控驱动 progress→processing→completed + 真实终路径),解析用
// FakeVideoResolver(吐 mock -J 结果),均不起真 yt-dlp / ffmpeg(真二进制手测留 Task 9,§9.4)。

/** 单视频解析样本(标题含 Windows 非法字符 : ? → 验证 §7.7 清洗;含纯视频 / muxed 两格式) */
const SINGLE_VIDEO: ResolvedVideo = {
  kind: 'video',
  id: 'abc',
  title: 'My: Cool Video?',
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

/** 5 条目播放列表样本(供批量展开 + 并发约束) */
const BIG_PLAYLIST: ResolvedPlaylist = {
  kind: 'playlist',
  title: 'Big List',
  entries: [
    { id: 'e0', title: 'Ep 0', url: 'https://youtu.be/e0', durationSec: 60 },
    { id: 'e1', title: 'Ep: 1?', url: 'https://youtu.be/e1', durationSec: 61 },
    { id: 'e2', title: 'Ep 2', url: 'https://youtu.be/e2', durationSec: 62 },
    { id: 'e3', title: 'Ep 3', url: 'https://youtu.be/e3', durationSec: 63 },
    { id: 'e4', title: 'Ep 4', url: 'https://youtu.be/e4', durationSec: 64 }
  ]
}

/**
 * 受管 mock 下载后端(实现 ManagedTaskEngine):充当 CompositeDownloadEngine 的 http 或 video 后端。
 * id 带 prefix 避免两后端冲突;记录 addUri 载荷(断言路由 / video 字段)与 pause/resume/remove;
 * emitProgress / processing / complete / fail 按 filename 驱动进度,归一为与 aria2 一致的 DownloadProgress
 * (video 后端可发 phase:'processing' 与完成终路径 savePath,§4.3)。
 */
class ManagedFakeBackend implements ManagedTaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly pauseCalls: string[] = []
  readonly resumeCalls: string[] = []
  readonly removeCalls: string[] = []
  startCalls = 0
  stopCalls = 0

  private counter = 0
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private readonly active = new Map<string, { input: AddUriInput; done: boolean }>()

  constructor(private readonly prefix: string) {}

  async start(): Promise<void> {
    this.startCalls++
  }

  async stop(): Promise<void> {
    this.stopCalls++
  }

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    const id = `${this.prefix}_${++this.counter}`
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

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  private engineIdFor(filename: string | undefined): string {
    let found: string | undefined
    for (const [id, rec] of this.active) {
      if (!rec.done && rec.input.filename === filename) {
        found = id
      }
    }
    if (!found) {
      throw new Error(`${this.prefix} 后端无活动任务: ${filename}`)
    }
    return found
  }

  private emit(progress: DownloadProgress): void {
    for (const callback of this.callbacks) {
      callback(progress)
    }
  }

  emitProgress(filename: string, downloadedBytes: number, totalBytes: number): void {
    this.emit({
      id: this.engineIdFor(filename),
      status: 'downloading',
      phase: 'downloading',
      totalBytes,
      downloadedBytes,
      speed: 0,
      connections: 0
    })
  }

  /** 视频后处理阶段(phase:'processing',status 仍 downloading,§4.3) */
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

  /** 完成(video 后端可带 yt-dlp 回报的真实终路径 savePath,§4.3) */
  complete(filename: string, bytes: number, savePath?: string): void {
    const id = this.engineIdFor(filename)
    this.active.get(id)!.done = true
    this.emit({
      id,
      status: 'completed',
      totalBytes: bytes,
      downloadedBytes: bytes,
      speed: 0,
      connections: 0,
      savePath
    })
  }

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
}

/** 可控 mock VideoResolver(吐 mock -J 结果;置 Error 触发失败映射) */
class FakeVideoResolver {
  readonly resolveCalls: string[] = []
  result: ResolveResult | Error = SINGLE_VIDEO
  resultFor?: (url: string) => ResolveResult | Error

  async resolve(url: string): Promise<ResolveResult> {
    this.resolveCalls.push(url)
    // 模拟真实异步解析(yt-dlp 子进程):延后一个宏任务,使 addTask 先返回可观察的 resolving 态
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const outcome = this.resultFor ? this.resultFor(url) : this.result
    if (outcome instanceof Error) {
      throw outcome
    }
    return outcome
  }
}

/** 排空多级 fire-and-forget 链(resolve → onResolved → applySelection → dequeue → addUri) */
async function flushVideo(): Promise<void> {
  await tick()
  await tick()
}

/** 统一策略 → 每条 pick 同值 choice(批量对话框语义) */
function batchPicks(indexes: number[], choice: FormatChoice): BatchPick[] {
  return indexes.map((entryIndex) => ({ entryIndex, choice }))
}

/** 起一套「真 SQLite + CompositeDownloadEngine(mock 两后端)+ mock VideoResolver」夹具 */
async function startVideoHarness(
  opts: {
    result?: ResolveResult | Error
    getVideoPrefs?: () => VideoPrefs
    maxConcurrent?: number
  } = {}
): Promise<{
  dir: string
  manager: InstanceType<(typeof import('./taskManager'))['TaskManager']>
  http: ManagedFakeBackend
  video: ManagedFakeBackend
  engine: ManagedTaskEngine
  videoResolver: FakeVideoResolver
  db: { close(): void }
  read: (id: string) => Task | null
}> {
  const dir = makeTempDir()
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { CompositeDownloadEngine } = await import('../engine/compositeEngine')
  const { getDatabase } = await import('../db/connection')
  const { getTask } = await import('../db/taskDao')

  const http = new ManagedFakeBackend('http')
  const video = new ManagedFakeBackend('vid')
  const engine = new CompositeDownloadEngine(http, video)
  const videoResolver = new FakeVideoResolver()
  if (opts.result !== undefined) {
    videoResolver.result = opts.result
  }
  const manager = new TaskManager(
    { engine, videoResolver, getVideoPrefs: opts.getVideoPrefs },
    { dbPath, defaultDir: dir, maxConcurrent: opts.maxConcurrent ?? 3 }
  )

  await engine.start()
  await manager.start()

  const db = getDatabase()
  const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)

  return { dir, manager, http, video, engine, videoResolver, db, read }
}

test(
  'C1 视频单视频闭环(真 SQLite):resolving→awaiting→select→downloading→processing→completed + videoMeta/savePath 真往返',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startVideoHarness({ result: SINGLE_VIDEO })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
      assert.equal(h.read(id)?.status, 'resolving', 'resolving 落库')
      assert.equal(h.read(id)?.kind, 'video')

      await flushVideo()
      assert.equal(h.read(id)?.status, 'awaiting_selection', '解析完成 → awaiting_selection 落库')
      assert.equal(
        h.read(id)?.videoMeta?.title,
        'My: Cool Video?',
        'videoMeta.title 经 SQLite JSON 真往返'
      )

      // 选 1080p(format 137,纯视频)→ +bestaudio 合并
      await h.manager.selectFormat(id, { audioOnly: false, formatId: '137' })
      let row = h.read(id)
      assert.equal(row?.status, 'downloading', 'selectFormat → queued → 出队 downloading')
      assert.equal(
        row?.videoMeta?.selectedFormat,
        '137+bestaudio/137',
        'selectedFormat 落库(video-only → 合并选择器)'
      )
      assert.equal(row?.videoMeta?.postProcess, 'merge')
      assert.equal(
        row?.filename,
        'My_ Cool Video_ [1080p].mp4',
        'filename = 标题清洗(§7.7)+ 清晰度标签 [1080p] + 预测 ext(merge→mp4)'
      )

      // 双执行器路由:视频任务带 video → 落 yt-dlp 后端;aria2 后端零接触(§4.1 透明)
      assert.equal(h.video.addUriCalls.length, 1, '视频任务路由到 video(yt-dlp)后端')
      assert.equal(h.video.addUriCalls[0].video?.formatSelector, '137+bestaudio/137')
      assert.equal(h.http.addUriCalls.length, 0, 'aria2 后端未接触视频任务')

      const fn = h.manager.getTask(id)!.filename
      h.video.emitProgress(fn, 500, 1000)
      assert.equal(h.read(id)?.status, 'downloading', '下载中')

      h.video.processing(fn)
      assert.equal(h.read(id)?.status, 'processing', 'phase:processing → processing 落库')

      // yt-dlp 回报真实终路径(ext 与预测不同:mkv)→ 校正 savePath / filename(§4.3)
      h.video.complete(fn, 1000, 'D:\\Downloads\\My_ Cool Video_.mkv')
      row = h.read(id)
      assert.equal(row?.status, 'completed', 'processing → completed')
      assert.equal(row?.savePath, 'D:\\Downloads\\My_ Cool Video_.mkv', 'yt-dlp 真实 savePath 写库')
      assert.equal(row?.filename, 'My_ Cool Video_.mkv', 'filename 同步真实落盘名')
      assert.ok(row?.completedAt, 'completedAt 落库')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'C2 视频仅音频转 MP3(真 SQLite):postProcess=mp3 + .mp3 落库 + video 后端 audioOnly,processing→completed',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startVideoHarness({ result: SINGLE_VIDEO })
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
      await flushVideo()
      await h.manager.selectFormat(id, { audioOnly: true })

      const row = h.read(id)
      assert.equal(row?.videoMeta?.selectedFormat, 'bestaudio/best')
      assert.equal(row?.videoMeta?.postProcess, 'mp3', 'audioOnly → postProcess=mp3 落库')
      assert.match(row?.filename ?? '', /\.mp3$/, 'audioOnly → 预测 ext mp3')
      assert.equal(
        h.video.addUriCalls[0].video?.audioOnly,
        true,
        'video 提交 audioOnly=true(yt-dlp 内部 ffmpeg 提取)'
      )

      const fn = h.manager.getTask(id)!.filename
      h.video.emitProgress(fn, 300, 320)
      h.video.processing(fn) // [ExtractAudio]
      assert.equal(h.read(id)?.status, 'processing', '音频提取 → processing')
      h.video.complete(fn, 320)
      assert.equal(h.read(id)?.status, 'completed', 'processing → completed(MP3)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'C3 默认清晰度自动选(真 SQLite):跳过 awaiting_selection 直接 downloading(heightCap 策略选择器路由 video 后端)',
  { skip: !SQLITE_OK },
  async () => {
    const events: TaskStatus[] = []
    const h = await startVideoHarness({
      result: SINGLE_VIDEO,
      getVideoPrefs: () => ({ defaultHeight: 720, defaultAudioOnly: false })
    })
    const off = h.manager.onProgress((p) => events.push(p.status))
    try {
      const id = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
      await flushVideo()

      assert.equal(
        events.includes('awaiting_selection'),
        false,
        '默认清晰度已设 → 不经 awaiting_selection(不弹对话框)'
      )
      assert.equal(h.read(id)?.status, 'downloading', '自动选 → queued → downloading')
      assert.equal(
        h.video.addUriCalls[0].video?.formatSelector,
        'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        'heightCap 策略选择器路由 video 后端'
      )
    } finally {
      off()
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'C4 playlist 批量展开(真 SQLite):submitBatch → N 归一子任务真库 + 移除父 + 并发约束 + 全路由 video 后端',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startVideoHarness({ result: BIG_PLAYLIST, maxConcurrent: 3 })
    try {
      const parentId = await h.manager.addTask({
        kind: 'video',
        source: 'https://youtu.be/playlist?list=BIG'
      })
      await flushVideo()
      assert.equal(
        h.read(parentId)?.status,
        'awaiting_selection',
        'playlist → awaiting_selection(批量对话框)'
      )

      await h.manager.submitBatch(
        parentId,
        batchPicks([0, 1, 2, 3, 4], { audioOnly: false, heightCap: 1080 })
      )
      await tick()

      // 父占位被移除(不落为下载任务)
      assert.equal(h.read(parentId), null, '父占位任务展开后 removeTask(DB 删除)')

      const children = h.manager.listTasks().filter((t) => t.kind === 'video')
      assert.equal(children.length, 5, '勾选 5 条 → 5 归一子任务')
      const downloading = children.filter((t) => t.status === 'downloading').length
      const queued = children.filter((t) => t.status === 'queued').length
      assert.equal(downloading, 3, 'maxConcurrent=3 → 3 downloading')
      assert.equal(queued, 2, '余 2 queued(受并发约束)')

      // 子任务 videoMeta 经 SQLite JSON 真往返(策略选择器 / playlistIndex / source)
      const child0 = children.find((t) => t.videoMeta?.playlistIndex === 0)
      assert.ok(child0, '子任务 playlistIndex 落库')
      assert.equal(child0?.source, 'https://youtu.be/e0', '子任务 source=entry.url')
      assert.equal(
        child0?.videoMeta?.selectedFormat,
        'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '统一清晰度策略选择器(不逐条解析)'
      )
      assert.equal(child0?.videoMeta?.postProcess, 'merge')

      // 全部出队子任务路由到 video 后端(aria2 零接触)
      assert.equal(h.video.addUriCalls.length, 3, '3 个出队子任务路由 video 后端')
      assert.equal(h.http.addUriCalls.length, 0, 'aria2 后端零接触批量视频子任务')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'C5 双执行器透明 + 直链零回归(真 SQLite):http→aria2 后端(无 video)、video→yt-dlp 后端(带 video),同一 manager 归一',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startVideoHarness({ result: SINGLE_VIDEO })
    try {
      // 直链:路由 aria2 后端,载荷只有业务信息(无 video,aria2 无感)—— 直链零回归
      const hid = await h.manager.addTask({
        kind: 'http',
        source: 'https://x/a.bin',
        filename: 'a.bin'
      })
      assert.equal(h.read(hid)?.status, 'downloading')
      assert.equal(h.http.addUriCalls.length, 1, 'http 路由到 aria2 后端')
      assert.deepEqual(
        Object.keys(h.http.addUriCalls[0]).sort(),
        ['dir', 'filename', 'url'],
        'http 载荷只有业务信息(无 video 字段,§4.1 aria2 无感)'
      )

      // 视频:路由 yt-dlp 后端,载荷带 video
      const vid = await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/abc' })
      await flushVideo()
      await h.manager.selectFormat(vid, { audioOnly: false, formatId: '18' }) // muxed,无需合并
      assert.equal(h.video.addUriCalls.length, 1, 'video 路由到 yt-dlp 后端')
      assert.ok(h.video.addUriCalls[0].video, 'video 载荷带 video 字段(formatSelector)')

      // 两路在同一 manager + 同一 SQLite 归一:各自完成,互不干扰
      h.http.complete('a.bin', 100)
      assert.equal(h.read(hid)?.status, 'completed', '直链完成(aria2 后端)')
      const vfn = h.manager.getTask(vid)!.filename
      h.video.complete(vfn, 200)
      assert.equal(h.read(vid)?.status, 'completed', '视频完成(yt-dlp 后端)')
    } finally {
      await h.manager.stop()
      cleanup(h.dir, h.db)
    }
  }
)

test(
  'C6 重启恢复视频态(跨实例真 SQLite):resolving/awaiting→重解析;downloading(video)→重提交带 video;paused 保持',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase, getDatabase } = await import('../db/connection')
    const { insertTask, getTask } = await import('../db/taskDao')
    const { TaskManager } = await import('./taskManager')
    const { CompositeDownloadEngine } = await import('../engine/compositeEngine')

    let conn1: { close(): void } | null = null
    let conn2: { close(): void } | null = null
    try {
      // ---- 第一次运行:预置库(模拟上次落库的视频各态)----
      const db1 = initDatabase(dbPath)
      conn1 = db1
      const seedVideo = (overrides: Partial<Task> & Pick<Task, 'id' | 'filename'>): Task =>
        makeTask({ kind: 'video', status: 'resolving', ...overrides })
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        seedVideo({
          id: 'v-resolving',
          filename: 'r.mp4',
          source: 'https://youtu.be/r',
          status: 'resolving',
          createdAt: 1
        })
      )
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        seedVideo({
          id: 'v-awaiting',
          filename: 'w.mp4',
          source: 'https://youtu.be/w',
          status: 'awaiting_selection',
          createdAt: 2,
          videoMeta: { title: 'W', selectedFormat: '', postProcess: 'none', playlistIndex: -1 }
        })
      )
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        seedVideo({
          id: 'v-dl',
          filename: 'dl.mp4',
          source: 'https://youtu.be/d',
          status: 'downloading',
          createdAt: 3,
          videoMeta: {
            title: 'D',
            selectedFormat: '137+bestaudio/137',
            postProcess: 'merge',
            playlistIndex: -1
          }
        })
      )
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        seedVideo({
          id: 'v-paused',
          filename: 'p.mp4',
          source: 'https://youtu.be/p',
          status: 'paused',
          createdAt: 4,
          videoMeta: { title: 'P', selectedFormat: 'best', postProcess: 'none', playlistIndex: -1 }
        })
      )
      db1.close()
      conn1 = null

      // ---- 第二次运行:全新 manager + 全新后端,读同库恢复 ----
      const http = new ManagedFakeBackend('http')
      const video = new ManagedFakeBackend('vid')
      const engine = new CompositeDownloadEngine(http, video)
      const videoResolver = new FakeVideoResolver()
      videoResolver.result = SINGLE_VIDEO
      const tm2 = new TaskManager(
        { engine, videoResolver },
        { dbPath, defaultDir: dir, maxConcurrent: 3 }
      )
      await engine.start()
      await tm2.start()
      await flushVideo()
      conn2 = getDatabase()
      const read = (id: string): Task | null => getTask(conn2 as unknown as TaskDaoDatabase, id)

      // resolving / awaiting_selection → 重解析(formats 瞬时已丢,§4.4.5)
      assert.ok(videoResolver.resolveCalls.includes('https://youtu.be/r'), 'resolving 视频重解析')
      assert.ok(
        videoResolver.resolveCalls.includes('https://youtu.be/w'),
        'awaiting_selection 视频重解析(formats 已丢)'
      )
      assert.equal(
        read('v-resolving')?.status,
        'awaiting_selection',
        '重解析成功 → awaiting_selection'
      )

      // downloading(video)→ 重提交到 yt-dlp 后端,带持久化 selectedFormat(.part 续传,§7.4)
      const dlSubmit = video.addUriCalls.find((c) => c.filename === 'dl.mp4')
      assert.ok(dlSubmit, 'downloading 视频任务重提交到 yt-dlp 后端')
      assert.equal(
        dlSubmit?.video?.formatSelector,
        '137+bestaudio/137',
        '用持久化 selectedFormat 重建 video 提交(不自存字节进度)'
      )

      // paused 保持暂停,不重提交
      assert.equal(read('v-paused')?.status, 'paused', 'paused 视频保持暂停语义')
      assert.equal(
        video.addUriCalls.some((c) => c.filename === 'p.mp4'),
        false,
        'paused 不重提交'
      )

      await tm2.stop()
      cleanup(dir, conn2)
    } catch (err) {
      cleanup(dir, conn1, conn2)
      throw err
    }
  }
)

// ==================== Section D:BT 文件选择(真实 SQLite,v0.3 Task 2 · spec §9.3)====================
//
// 在真实 node:sqlite 上验证 torrentMeta.files[].selected 的 JSON 持久化真往返 +
// awaiting_selection → 选择 → --select-file → downloading → completed 全链路;出队/恢复 select-file 一致。
// D1 用真实 FakeEngine(手动帧驱动元数据/暂停/续下);D2 用本地 mock 观察恢复重提的 torrent 载荷。

test(
  'D1 BT 多文件选择闭环(真 SQLite):magnet → awaiting_selection → applyTorrentSelection([1,3]) → 引擎收 "1,3" → completed + files[].selected JSON 真往返',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { FakeEngine: RealFakeEngine } = await import('../engine/fakeEngine')
    const { getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const ticks: Array<() => void> = []
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
    const manager = new TaskManager(
      { engine },
      { dbPath, defaultDir: dir, maxConcurrent: 3, userDataDir: dir }
    )
    try {
      await manager.start()
      const db = getDatabase()
      const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)

      const id = await manager.addTask({ kind: 'torrent', source: 'magnet:?xt=urn:btih:multi' })
      ticks[0]() // 元数据帧 1
      ticks[0]() // 元数据帧 2
      ticks[0]() // torrentInfo(多文件)→ awaiting_selection(引擎侧 btPaused,模拟 pause-metadata)
      assert.equal(read(id)?.status, 'awaiting_selection', '多文件 → awaiting_selection 落库')
      assert.equal(read(id)?.torrentMeta?.files.length, 3, '3 文件 torrentMeta 经 SQLite 落库')
      assert.equal(
        read(id)?.torrentMeta?.files.every((f) => f.selected),
        true,
        '初始全选'
      )

      await manager.applyTorrentSelection(id, [1, 3])
      assert.deepEqual(
        engine.applyTorrentSelectionCalls,
        [{ id: 'fake_1', arg: '1,3' }],
        '引擎经 changeOption 收 --select-file="1,3"(暂停态下发)'
      )
      assert.equal(
        read(id)?.status,
        'downloading',
        '选定 → queued → 出队 downloading(resume=unpause)'
      )

      for (let i = 0; i < 6 && read(id)?.status !== 'completed'; i++) {
        ticks[0]()
      }
      const row = read(id)
      assert.equal(row?.status, 'completed', 'resume 后整包推进 → completed')
      assert.deepEqual(
        row?.torrentMeta?.files.map((f) => f.selected),
        [true, false, true],
        'files[].selected 经真实 SQLite JSON 序列化/反序列化往返持久化([T,F,T])'
      )

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)

test(
  'D2 BT 出队/恢复 select-file 一致(真 SQLite):已定型部分选 torrent → 跨实例恢复 → 引擎收同一 --select-file(全选省略)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { initDatabase, getDatabase } = await import('../db/connection')
    const { insertTask, getTask } = await import('../db/taskDao')

    let conn1: { close(): void } | null = null
    let conn2: { close(): void } | null = null
    try {
      // 预置两个已定型 torrent:part = 部分选(→ select-file);full = 全选(→ 省略 select-file,整包零回归)
      const db1 = initDatabase(dbPath)
      conn1 = db1
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        makeTask({
          id: 'bt-part',
          kind: 'torrent',
          source: 'magnet:?xt=urn:btih:part',
          status: 'queued',
          filename: 'Part',
          savePath: path.join(dir, 'Torrents', 'Part'),
          startedAt: 100,
          torrentMeta: {
            name: 'Part',
            infoHash: null,
            files: [
              { path: 'Part/a', length: 10, selected: true },
              { path: 'Part/b', length: 10, selected: false },
              { path: 'Part/c', length: 10, selected: true }
            ]
          }
        })
      )
      insertTask(
        db1 as unknown as TaskDaoDatabase,
        makeTask({
          id: 'bt-full',
          kind: 'torrent',
          source: 'magnet:?xt=urn:btih:full',
          status: 'downloading',
          filename: 'Full',
          savePath: path.join(dir, 'Torrents', 'Full'),
          startedAt: 100,
          torrentMeta: {
            name: 'Full',
            infoHash: null,
            files: [
              { path: 'Full/a', length: 10, selected: true },
              { path: 'Full/b', length: 10, selected: true }
            ]
          }
        })
      )
      db1.close()
      conn1 = null

      // 跨实例恢复:本地 mock 引擎观察 recoverSubmit 的 torrent 载荷
      const engine = new FakeEngine()
      const tm2 = new TaskManager(
        { engine },
        { dbPath, defaultDir: dir, maxConcurrent: 3, userDataDir: dir }
      )
      await tm2.start()
      conn2 = getDatabase()

      const partSubmit = engine.addUriCalls.find((c) => c.url === 'magnet:?xt=urn:btih:part')
      const fullSubmit = engine.addUriCalls.find((c) => c.url === 'magnet:?xt=urn:btih:full')
      assert.equal(
        partSubmit?.torrent?.selectFile,
        '1,3',
        '部分选恢复:重建 --select-file="1,3"(同一 selectFileArg)'
      )
      assert.equal(partSubmit?.torrent?.awaitSelection, undefined, '已定型 → 不再 awaitSelection')
      assert.equal(
        fullSubmit?.torrent?.selectFile,
        undefined,
        '全选恢复:省略 select-file(整包逐字节零回归,§10 红线)'
      )

      // 真往返:torrentMeta.files[].selected 经 SQLite 恢复后不变
      assert.deepEqual(
        getTask(conn2 as unknown as TaskDaoDatabase, 'bt-part')?.torrentMeta?.files.map(
          (f) => f.selected
        ),
        [true, false, true],
        'files[].selected 跨实例真往返'
      )

      await tm2.stop()
      cleanup(dir, conn2)
    } catch (err) {
      cleanup(dir, conn1, conn2)
      throw err
    }
  }
)

// ==================== Section B:真实 aria2c + 真实 SQLite + 本地 HTTP server ====================
//
// 需 resources/bin/aria2c.exe 为真实二进制。本机为占位二进制 →
// isRealAria2c 返回 false 直接早退;同时 DOWNLORD_REAL_ENGINE 未置 1 时整体跳过,双重保险。
// 启用方式:放入真 aria2c.exe → `DOWNLORD_REAL_ENGINE=1 npm test`(不必再改源码)。

const SKIP_INTEGRATION = process.env.DOWNLORD_REAL_ENGINE !== '1'

function isRealAria2c(aria2cPath: string): boolean {
  if (!fs.existsSync(aria2cPath)) {
    return false
  }
  // 真实 aria2c.exe 至少几百 KB;占位文本只有十几字节
  return fs.statSync(aria2cPath).size > 1000
}

interface TestServerHandle {
  url: string
  fileSize: number
  sha256: string
  close: () => Promise<void>
}

// 让下载态覆盖轮询/中断窗口，close 后清定时器；内容和 Range 语义保持。
function sendTestBody(res: import('http').ServerResponse, body: Buffer): void {
  let offset = 0
  const timer = setInterval(() => {
    if (res.writableNeedDrain) return
    const next = Math.min(offset + 32 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    if (offset === body.length) {
      clearInterval(timer)
      res.end()
    }
  }, 100)
  res.once('close', () => clearInterval(timer))
}

async function createRangeServer(): Promise<TestServerHandle> {
  const http = await import('http')
  const crypto = await import('crypto')
  const content = Buffer.alloc(8 * 1024 * 1024)
  for (let i = 0; i < content.length; i++) {
    content[i] = i % 251
  }
  const sha256 = crypto.createHash('sha256').update(content).digest('hex')

  const server = http.createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-')
      const start = parseInt(s, 10)
      const end = e ? parseInt(e, 10) : content.length - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${content.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream'
      })
      sendTestBody(res, content.subarray(start, end + 1))
    } else {
      res.writeHead(200, {
        'Content-Length': content.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      })
      sendTestBody(res, content)
    }
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const port = (server.address() as { port: number }).port

  return {
    url: `http://127.0.0.1:${port}/test-file.bin`,
    fileSize: content.length,
    sha256,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

function waitForTaskStatus(
  manager: { onProgress(cb: (p: { id: string; status: TaskStatus }) => void): () => void },
  trigger: () => Promise<string>,
  status: TaskStatus,
  timeoutMs = 60000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let taskId: string | undefined
    const seen = new Set<string>()
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`等待任务 ${taskId} 状态 ${status} 超时`))
    }, timeoutMs)
    const finish = (id: string): void => {
      clearTimeout(timeout)
      unsubscribe()
      resolve(id)
    }
    const unsubscribe = manager.onProgress((progress) => {
      if (progress.status !== status) return
      seen.add(progress.id)
      if (progress.id === taskId) finish(progress.id)
    })
    // 先订阅再触发；addTask/start 返回 id 之前的同步/早到帧也按准确 id 匹配。
    void Promise.resolve()
      .then(trigger)
      .then(
        (id) => {
          taskId = id
          if (seen.has(id)) finish(id)
        },
        (err: unknown) => {
          clearTimeout(timeout)
          unsubscribe()
          reject(err)
        }
      )
  })
}

test(
  'B1 真实下载:add → aria2c 下载 → 完成落库 + 文件校验 [需真 aria2c + Node22]',
  { skip: SKIP_INTEGRATION || !SQLITE_OK },
  async (t) => {
    const projectRoot = path.resolve(__dirname, '../../..')
    const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')
    if (!isRealAria2c(aria2cPath)) {
      console.log('⚠️  跳过 B1:resources/bin/aria2c.exe 非真实二进制')
      return
    }

    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    let server: TestServerHandle | undefined = undefined
    const { spawn } = await import('child_process')
    const net = await import('net')
    const crypto = await import('crypto')
    const { DownloadEngine } = await import('../engine/downloadEngine')
    const { TaskManager } = await import('./taskManager')
    const { initDatabase, getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const engine = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: dir, pollInterval: 500 }
    )
    let db: ReturnType<typeof getDatabase> | undefined
    const manager = new TaskManager(
      {
        engine,
        initDatabase: (file) => {
          const connection = initDatabase(file)
          // 获取成功即登记:start 后续读库失败也要由本用例关闭。
          db = connection
          return connection
        }
      },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    t.after(async () => {
      try {
        await manager.stop()
      } finally {
        try {
          await engine.stop()
        } finally {
          try {
            await server?.close()
          } finally {
            cleanup(dir, db)
          }
        }
      }
    })
    server = await createRangeServer()

    await engine.start()
    await manager.start()
    db = getDatabase()

    const id = await waitForTaskStatus(
      manager,
      () => manager.addTask({ kind: 'http', source: server.url, filename: 'b1.bin' }),
      'completed'
    )

    const row = getTask(db as unknown as TaskDaoDatabase, id)
    assert.equal(row?.status, 'completed')
    assert.ok(row?.completedAt)

    const file = path.join(dir, 'b1.bin')
    assert.ok(fs.existsSync(file), '文件落盘')
    assert.equal(fs.statSync(file).size, server.fileSize, '大小一致')
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(sha, server.sha256, '哈希一致')
  }
)

test(
  'B2 真实续传:下载中重启 → 恢复重提交 → 续传完成 + 哈希一致 [需真 aria2c + Node22]',
  { skip: SKIP_INTEGRATION || !SQLITE_OK },
  async (t) => {
    const projectRoot = path.resolve(__dirname, '../../..')
    const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')
    if (!isRealAria2c(aria2cPath)) {
      console.log('⚠️  跳过 B2:resources/bin/aria2c.exe 非真实二进制')
      return
    }

    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    let server: TestServerHandle | undefined = undefined
    const { spawn } = await import('child_process')
    const net = await import('net')
    const crypto = await import('crypto')
    const { DownloadEngine } = await import('../engine/downloadEngine')
    const { TaskManager } = await import('./taskManager')
    const { initDatabase, getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    let conn1: { close(): void } | null = null
    let conn2: { close(): void } | null = null
    const engine1 = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: dir, pollInterval: 300 }
    )
    const tm1 = new TaskManager(
      {
        engine: engine1,
        initDatabase: (file) => {
          const connection = initDatabase(file)
          conn1 = connection
          return connection
        }
      },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    const engine2 = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: dir, pollInterval: 300 }
    )
    const tm2 = new TaskManager(
      {
        engine: engine2,
        initDatabase: (file) => {
          const connection = initDatabase(file)
          conn2 = connection
          return connection
        }
      },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    t.after(async () => {
      try {
        try {
          await tm1.stop()
        } finally {
          await tm2.stop()
        }
      } finally {
        try {
          await engine1.stop()
        } finally {
          try {
            await engine2.stop()
          } finally {
            try {
              await server?.close()
            } finally {
              cleanup(dir, conn1, conn2)
            }
          }
        }
      }
    })
    server = await createRangeServer()
    // 第一次运行:开始下载后立即「停主进程」(保留 .aria2)
    await engine1.start()
    await tm1.start()
    conn1 = getDatabase()
    const id = await waitForTaskStatus(
      tm1,
      () => tm1.addTask({ kind: 'http', source: server.url, filename: 'b2.bin' }),
      'downloading'
    )

    await new Promise((r) => setTimeout(r, 800)) // 下载一部分
    await tm1.stop()
    await engine1.stop()
    conn1.close()
    conn1 = null

    // 第二次运行:恢复 → aria2 凭 .aria2 续传到完成
    await engine2.start()
    await waitForTaskStatus(
      tm2,
      async () => {
        await tm2.start()
        conn2 = getDatabase()
        return id
      },
      'completed',
      90000
    )

    const row = getTask(conn2 as unknown as TaskDaoDatabase, id)
    assert.equal(row?.status, 'completed')
    const file = path.join(dir, 'b2.bin')
    assert.equal(fs.statSync(file).size, server.fileSize, '续传后大小一致')
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(sha, server.sha256, '续传后哈希一致')
  }
)

// ==================== Section E:BT 做种(真实 SQLite,v0.3 Task 3 · spec §3 / §4)====================
//
// 用真实 FakeEngine(手动帧驱动)验证做种后端全链路:下载完 →(开档)seeding 帧 → 自然停 → completed;
//(关档)下载完直接 completed 无 seeding 帧;TaskProgress 携 connections + torrent 携 seeding / 上行富进度。

test(
  'E1 BT 做种开档端到端(真 SQLite):单文件 magnet → 下载完 → seeding(TaskProgress seeding:true + 上行 + connections)→ 自然停 completed',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { FakeEngine: RealFakeEngine } = await import('../engine/fakeEngine')
    const { getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const ticks: Array<() => void> = []
    const engine = new RealFakeEngine({
      setInterval: (fn: () => void) => {
        ticks.push(fn)
        return ticks.length as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
      totalBytes: 30,
      stepBytes: 10,
      intervalMs: 100,
      getSeedConfig: () => ({ enabled: true, ratio: 1, timeMin: 60 }) // 开档
    })
    const manager = new TaskManager(
      { engine },
      { dbPath, defaultDir: dir, maxConcurrent: 3, userDataDir: dir }
    )
    try {
      await manager.start()
      const db = getDatabase()
      const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)
      const frames: TaskProgress[] = []
      manager.onProgress((p) => frames.push(p))

      const id = await manager.addTask({
        kind: 'torrent',
        source: 'magnet:?xt=urn:btih:seedsingle'
      })
      ticks[0]() // 元数据帧 1
      ticks[0]() // 元数据帧 2
      ticks[0]() // torrentInfo(单文件)→ queued → triggerDequeue(fire-and-forget)
      await tick() // flush 出队 → resume(unpause) → downloading
      assert.equal(read(id)?.status, 'downloading', '单文件豁免 → downloading')

      // 下载满 → 做种帧 → 自然停(固定驱动;做种态 status 已 completed 但引擎续发 seeding 帧)
      for (let i = 0; i < 15; i++) ticks[0]()

      assert.equal(read(id)?.status, 'completed', '下载满 → completed(持久化终态,做种走 runtime)')
      const seedFrame = frames.find((f) => f.seeding === true)
      assert.ok(seedFrame, '做种中 TaskProgress seeding:true')
      assert.ok((seedFrame?.uploadSpeed ?? 0) > 0, 'seeding 帧携上行速度 uploadSpeed')
      assert.equal(seedFrame?.numSeeders, 3, 'seeding 帧携 numSeeders')
      assert.equal(seedFrame?.connections, 8, 'connections 透传(所有任务)')
      assert.equal(
        frames.at(-1)?.seeding,
        false,
        '自然停 → seeding runtime 清 → 广播 seeding:false'
      )

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)

test(
  'E2 BT 做种关档端到端(真 SQLite):单文件 magnet → 下载完直接 completed,无 seeding 帧(零回归)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { FakeEngine: RealFakeEngine } = await import('../engine/fakeEngine')
    const { getDatabase } = await import('../db/connection')
    const { getTask } = await import('../db/taskDao')

    const ticks: Array<() => void> = []
    const engine = new RealFakeEngine({
      setInterval: (fn: () => void) => {
        ticks.push(fn)
        return ticks.length as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
      totalBytes: 30,
      stepBytes: 10,
      intervalMs: 100
      // 未注入 getSeedConfig → 关档(默认下载完即停)
    })
    const manager = new TaskManager(
      { engine },
      { dbPath, defaultDir: dir, maxConcurrent: 3, userDataDir: dir }
    )
    try {
      await manager.start()
      const db = getDatabase()
      const read = (id: string): Task | null => getTask(db as unknown as TaskDaoDatabase, id)
      const frames: TaskProgress[] = []
      manager.onProgress((p) => frames.push(p))

      const id = await manager.addTask({
        kind: 'torrent',
        source: 'magnet:?xt=urn:btih:seedsingle'
      })
      ticks[0]()
      ticks[0]()
      ticks[0]()
      await tick()
      for (let i = 0; i < 8 && read(id)?.status !== 'completed'; i++) ticks[0]()

      assert.equal(read(id)?.status, 'completed', '关档下载满即 completed')
      assert.equal(
        frames.some((f) => f.seeding === true),
        false,
        '关档无 seeding:true 帧(零回归)'
      )

      await manager.stop()
      cleanup(dir, db)
    } catch (err) {
      cleanup(dir)
      throw err
    }
  }
)
