/**
 * L2 · 跨重启的状态与数据 —— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L2 层)。
 *
 * L2 管的是「进程重启这条缝」两侧的对账:哪些东西必须**原样活过重启**(八态、字节进度、落点),
 * 哪些东西必须**重启即消失**(gid / limitKBps / headers / seeding 这些运行时态,§7.3-f / §7.4-b),
 * 以及哪些东西**从一开始就不该落库**(parked 冲突,§6.2)。
 *
 * 与 L1 的分工(别混):
 * - L1 的 `runtimeStateRedline.integration.test.ts` 从 **DAO 形状**这一侧钉死「写不进去」;
 * - 本文件从 **TaskManager 行为**这一侧钉死「重启后确实没了」。
 *   两侧缺一都留得下一个假绿灯 —— DAO 挡住了写,不等于内存态在重启后不会被别的路径重新变出来。
 *
 * 形态:`*.integration.test.ts` + 真 `node:sqlite` + FakeEngine(spec §2.4ⓐ);
 * `canLoadSqlite` 从 `tests/helpers/` import,**不复制第 12 份**(I-14)。
 * 「重启」= 关掉第一个 DB 句柄、对**同一个库文件**重新 `initDatabase` 并起第二个 TaskManager ——
 * 这是本项目里进程重启在测试内唯一忠实的形态(共用同一个 db 对象只测得到「换了个 manager」)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'

import type {
  AddUriInput,
  DownloadProgress,
  DuplicateConflict,
  ResolveResult,
  Task,
  TaskProgress,
  TaskStatus
} from '../../shared/ipc'
import type { TaskEngine } from './taskManager'
import type { TaskDaoDatabase } from '../db/taskDao'

import { canLoadSqlite, rawSqliteCtor } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'

const SQLITE_OK = canLoadSqlite()

if (!SQLITE_OK) {
  const msg = `[tasks/restartRecovery] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

// ==================== 夹具 ====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly removeCalls: string[] = []
  readonly stopSeedingCalls: string[] = []
  /** 置为真 → addUri 抛错(测 recoverSubmit 的 catch 支路) */
  failAddUri: string | null = null
  private counter = 0
  private frameCb: ((progress: DownloadProgress) => void) | null = null
  /** 引擎 id 前缀:重启后换前缀,便于断言「重启后拿到的是新 gid」 */
  constructor(private readonly prefix = 'eng') {}

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    if (this.failAddUri !== null) {
      throw new Error(this.failAddUri)
    }
    return `${this.prefix}_${++this.counter}`
  }
  async pause(): Promise<void> {
    // 本文件不校验暂停语义(L2 只看跨重启的态),空实现即满足 TaskEngine 契约
  }
  async resume(): Promise<void> {
    // 同 pause
  }
  async remove(id: string): Promise<void> {
    this.removeCalls.push(id)
  }
  async stopSeeding(id: string): Promise<void> {
    this.stopSeedingCalls.push(id)
  }
  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.frameCb = callback
    return () => {
      this.frameCb = null
    }
  }
  /** 手工推一帧引擎进度(驱动 seeding runtime 等派生态) */
  emit(progress: DownloadProgress): void {
    this.frameCb?.(progress)
  }
}

/**
 * 永不 settle 的视频解析器:让 `resolving` / `awaiting_selection` 在断言时**停在原地**。
 * 用真解析器会让状态在断言前继续流转,测出来的就不是「恢复计划把它放进了哪个桶」。
 *
 * ⚠️ **刻意不在 abort 时 reject**:reject 会让 `onResolveError` 在用例结束后才落库,
 * 撞上已关闭的 DB 句柄 → `database is not open` 的 unhandledRejection。那是夹具噪音,
 * 会把真失败埋掉(实测踩过一次)。永远 pending 则用例一结束就再无任何异步活动。
 */
class HangingVideoResolver {
  readonly calls: string[] = []
  async resolve(url: string): Promise<ResolveResult> {
    this.calls.push(url)
    return new Promise<ResolveResult>(() => {})
  }
}

interface Harness {
  manager: InstanceType<(typeof import('./taskManager'))['TaskManager']>
  engine: FakeEngine
  resolver: HangingVideoResolver
  db: { close(): void }
  conflicts: DuplicateConflict[]
  frames: TaskProgress[]
  /** 直接读库(绕开内存),断言「落库的是什么」 */
  row: (id: string) => Task | null
  rowCount: () => number
  stop: () => Promise<void>
}

/** 起(或重起)一个 TaskManager;`dir` 相同 = 同一个库文件 = 一次重启 */
async function startManager(
  dir: string,
  opts: {
    maxConcurrent?: number
    enginePrefix?: string
    seed?: (dbPath: string) => Task[]
    existingFiles?: string[]
  } = {}
): Promise<Harness> {
  const dbPath = path.join(dir, 'downlord.db')
  const { TaskManager } = await import('./taskManager')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { insertTask, getTask, listTasks } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  seedDefaultCategories(db)
  for (const t of opts.seed?.(dbPath) ?? []) {
    insertTask(db as unknown as TaskDaoDatabase, t)
  }

  const existing = new Set(opts.existingFiles ?? [])
  const engine = new FakeEngine(opts.enginePrefix ?? 'eng')
  const resolver = new HangingVideoResolver()
  const manager = new TaskManager(
    {
      engine,
      videoResolver: resolver,
      initDatabase: () => db,
      getVideoPrefs: () => ({ defaultHeight: null, defaultAudioOnly: false }),
      ensureDir: () => {},
      existsSync: (p) => existing.has(p),
      readDir: (d) => [...existing].filter((p) => path.dirname(p) === d).map((p) => path.basename(p)),
      trashItem: async (p) => {
        existing.delete(p)
      }
    },
    { dbPath, defaultDir: dir, maxConcurrent: opts.maxConcurrent ?? 3 }
  )

  const conflicts: DuplicateConflict[] = []
  const frames: TaskProgress[] = []
  manager.onDuplicate((c) => conflicts.push(c))
  manager.onProgress((p) => frames.push(p))

  await manager.start()

  return {
    manager,
    engine,
    resolver,
    db,
    conflicts,
    frames,
    row: (id) => getTask(db as unknown as TaskDaoDatabase, id),
    rowCount: () => listTasks(db as unknown as TaskDaoDatabase).length,
    stop: async () => {
      await manager.stop()
      try {
        db.close()
      } catch {
        // 句柄可能已被别处关掉;关不上不是被测红线的事
      }
    }
  }
}

let seq = 0
function seeded(status: TaskStatus, over: Partial<Task> = {}): Task {
  const id = over.id ?? `t_${status}_${++seq}`
  const dir = over.savePath ? path.dirname(over.savePath) : 'D:/dl'
  return {
    id,
    kind: 'http',
    source: `https://example.com/${id}.bin`,
    status,
    filename: `${id}.bin`,
    savePath: path.join(dir, `${id}.bin`),
    category: null,
    totalBytes: 1000,
    downloadedBytes: status === 'completed' ? 1000 : 400,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: status === 'error' ? 'boom' : null,
    createdAt: 1,
    startedAt: null,
    completedAt: status === 'completed' ? 2 : null,
    ...over
  }
}

/**
 * 把 tasks 表整张拼成一个字符串(不经 DAO 反序列化),用来断言「某个值根本没进过库」。
 * 走 SQL 的 `group_concat` 一次取回:`RawSqlite` 的最小面只声明了 `get` / `run`,没有 `all`。
 */
function rawDump(dbPath: string): string {
  const Ctor = rawSqliteCtor()
  const raw = new Ctor(dbPath)
  try {
    const one = raw
      .prepare(
        "SELECT group_concat(id || '|' || status || '|' || filename || '|' || savePath || '|' || " +
          "coalesce(videoMeta,'') || '|' || coalesce(torrentMeta,'') || '|' || coalesce(error,'')) AS blob FROM tasks"
      )
      .get() as { blob: string | null }
    return one.blob ?? ''
  } finally {
    raw.close()
  }
}

// ==================== L2-1 · 八态跨重启:各归其桶 ====================

test(
  'L2-1 八态从库读回后各归其桶:两条重提交 / 两条重解析 / 超并发降 queued / paused 保持 / completed·error 只作历史',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-states')
    const tasks = [
      seeded('downloading', { id: 'a_dl', createdAt: 10 }),
      seeded('queued', { id: 'b_q', createdAt: 20 }),
      seeded('processing', { id: 'c_proc', kind: 'video', createdAt: 30 }),
      seeded('paused', { id: 'd_paused', createdAt: 40 }),
      seeded('resolving', { id: 'e_resolving', kind: 'video', createdAt: 50 }),
      seeded('awaiting_selection', { id: 'f_await', kind: 'video', createdAt: 60 }),
      seeded('completed', { id: 'g_done', createdAt: 70 }),
      seeded('error', { id: 'h_err', createdAt: 80 })
    ]
    const h = await startManager(dir, { maxConcurrent: 2, seed: () => tasks })
    t.after(() => h.stop())

    // ① 重提交桶:createdAt 最早的两条 submittable(a_dl / b_q),processing 的 c_proc 被 maxConcurrent 截掉
    assert.deepEqual(
      h.engine.addUriCalls.map((c) => c.url),
      ['https://example.com/a_dl.bin', 'https://example.com/b_q.bin'],
      'toSubmit 应按 createdAt 取前 maxConcurrent 条,且只含 submittable 态'
    )
    // ② 重提交后归一化为 downloading,并**落库**(不是只改内存)
    for (const id of ['a_dl', 'b_q']) {
      assert.equal(h.manager.getTask(id)?.status, 'downloading', `${id} 内存态`)
      assert.equal(h.row(id)?.status, 'downloading', `${id} 落库态`)
    }
    // ③ 超并发的 processing 降回 queued,内存与库一致
    assert.equal(h.manager.getTask('c_proc')?.status, 'queued')
    assert.equal(h.row('c_proc')?.status, 'queued')
    // ④ paused 原样保持(不被恢复流程唤醒 —— 这正是「保持暂停」那半句)
    assert.equal(h.manager.getTask('d_paused')?.status, 'paused')
    assert.equal(h.row('d_paused')?.status, 'paused')
    // ⑤ 两条视频下载前态都进重解析桶;awaiting_selection 先归位 resolving 并落库
    assert.deepEqual(h.resolver.calls.slice().sort(), [
      'https://example.com/e_resolving.bin',
      'https://example.com/f_await.bin'
    ])
    assert.equal(h.row('f_await')?.status, 'resolving', 'awaiting_selection 恢复期归位 resolving 且落库')
    assert.equal(h.row('e_resolving')?.status, 'resolving')
    // ⑥ 终态只作历史:不重提交、不重解析、状态一字不动
    assert.equal(h.row('g_done')?.status, 'completed')
    assert.equal(h.row('h_err')?.status, 'error')
    assert.equal(h.engine.addUriCalls.length, 2, '终态不得被重提交')
    assert.equal(h.resolver.calls.length, 2, '终态不得被重解析')
    // ⑦ 八条一条不少地回到内存(completed / error 也在列表里供历史展示)
    assert.equal(h.manager.listTasks().length, 8)
  }
)

// ==================== L2-2 · 字节进度活过重启,速度不活 ====================

test(
  'L2-2 downloadedBytes / totalBytes 原样活过重启,speed 重启即归零(派生态不落库)',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-bytes')
    const h1 = await startManager(dir, {
      seed: () => [seeded('paused', { id: 'p1', downloadedBytes: 4096, totalBytes: 8192, speed: 999 })]
    })
    await h1.stop()

    const h2 = await startManager(dir, { enginePrefix: 'eng2' })
    t.after(() => h2.stop())
    const after = h2.manager.getTask('p1')
    assert.equal(after?.downloadedBytes, 4096, '字节进度必须活过重启(§7.4 断点续传的业务侧元信息)')
    assert.equal(after?.totalBytes, 8192)
    assert.equal(after?.speed, 0, 'speed 是派生瞬时量,重启后必须是 0 而不是上次的值')
  }
)

// ==================== L2-3 · parked 冲突不落库,重启即消失 ====================

test(
  'L2-3 parked 冲突任务从不落库;重启后该 id 与 conflictId 双双消失(resolveDuplicate 幂等忽略)',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-parked')
    const donePath = path.join(dir, 'dup.bin')
    const h1 = await startManager(dir, {
      seed: () => [
        seeded('completed', {
          id: 'old',
          source: 'https://example.com/dup.bin',
          filename: 'dup.bin',
          savePath: donePath
        })
      ],
      existingFiles: [donePath]
    })

    const parkedId = await h1.manager.addTask({ kind: 'http', source: 'https://example.com/dup.bin' })

    assert.equal(h1.conflicts.length, 1, '应 emit 一次 http 冲突')
    assert.equal(h1.conflicts[0].conflictId, parkedId)
    assert.equal(h1.row(parkedId), null, 'parked 任务绝不落库(§6.2)')
    assert.equal(h1.manager.getTask(parkedId), null, 'parked 任务也不进内存任务表')
    assert.equal(h1.rowCount(), 1, '库里仍只有那条旧的 completed 记录')
    await h1.stop()

    // —— 重启 ——
    const h2 = await startManager(dir, { enginePrefix: 'eng2', existingFiles: [donePath] })
    t.after(() => h2.stop())
    assert.equal(h2.manager.getTask(parkedId), null, 'parked 任务重启后彻底消失')
    assert.deepEqual(
      h2.manager.listTasks().map((x) => x.id),
      ['old'],
      '重启后只剩落过库的那条'
    )
    // conflictId 随 pendingConflicts 一起蒸发 → 决策必须幂等忽略,而不是凭空建出任务
    await h2.manager.resolveDuplicate({ conflictId: parkedId, decision: 'overwrite' })
    assert.equal(h2.rowCount(), 1, '对失效 conflictId 的决策不得写库')
    assert.equal(h2.engine.addUriCalls.length, 0, '对失效 conflictId 的决策不得提交引擎')
  }
)

// ==================== L2-4 · limitKBps 运行时态重启即消失 ====================

test(
  'L2-4 setTaskLimit 只改内存并广播;库里既无该列也无该值,重启后回落跟随全局',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-limit')
    const dbPath = path.join(dir, 'downlord.db')
    const h1 = await startManager(dir, { seed: () => [seeded('downloading', { id: 'lim1' })] })

    await h1.manager.setTaskLimit('lim1', 512)
    assert.equal(h1.manager.getTask('lim1')?.limitKBps, 512, '内存里应有值(供限速 popover 回显)')
    const broadcast = h1.frames.filter((f) => f.id === 'lim1')
    assert.ok(broadcast.length > 0, '限速变更应广播出去')
    assert.equal(broadcast[broadcast.length - 1].limitKBps, 512)

    const cols = (() => {
      const Ctor = rawSqliteCtor()
      const raw = new Ctor(dbPath)
      try {
        // 逐列名比对:limitKBps 这个列压根不该存在
        const hit = raw.prepare("SELECT count(*) AS n FROM pragma_table_info('tasks') WHERE name='limitKBps'").get() as {
          n: number
        }
        const total = raw.prepare("SELECT count(*) AS n FROM pragma_table_info('tasks')").get() as { n: number }
        return { hit: hit.n, total: total.n }
      } finally {
        raw.close()
      }
    })()
    assert.equal(cols.hit, 0, 'tasks 表不得有 limitKBps 列')
    assert.ok(cols.total > 0, '正向对照:pragma_table_info 确实读得到 tasks 的列(否则上一条恒 0)')
    assert.ok(!rawDump(dbPath).includes('512'), '512 这个值不得以任何形式出现在库里')
    await h1.stop()

    const h2 = await startManager(dir, { enginePrefix: 'eng2' })
    t.after(() => h2.stop())
    assert.equal(h2.manager.getTask('lim1')?.limitKBps, undefined, 'limitKBps 重启即清 = 回落全局')
  }
)

// ==================== L2-5 · headers 运行时态重启即消失 ====================

test(
  'L2-5 接管 headers 提交引擎时带上,但不落库;重启重提交时回落无头',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-headers')
    const dbPath = path.join(dir, 'downlord.db')
    const h1 = await startManager(dir)
    const id = await h1.manager.addTask({
      kind: 'http',
      source: 'https://cdn.example.com/v.mp4',
      headers: { Referer: 'https://page.example.com/', 'User-Agent': 'DL/1.0' }
    })
    assert.equal(h1.engine.addUriCalls.length, 1)
    assert.deepEqual(
      h1.engine.addUriCalls[0].headers,
      { Referer: 'https://page.example.com/', 'User-Agent': 'DL/1.0' },
      '首次提交应带上白名单内的两个头'
    )
    assert.ok(!rawDump(dbPath).includes('page.example.com'), 'Referer 不得落库')
    await h1.stop()

    // —— 重启:同一条任务被 recoverSubmit 重提,headers 已随内存一起没了 ——
    const h2 = await startManager(dir, { enginePrefix: 'eng2' })
    t.after(() => h2.stop())
    assert.equal(h2.manager.getTask(id)?.headers, undefined, 'headers 重启即清')
    assert.equal(h2.engine.addUriCalls.length, 1, '重启后该任务应被重提交一次')
    assert.equal(
      Object.prototype.hasOwnProperty.call(h2.engine.addUriCalls[0], 'headers'),
      false,
      '重提交的入参**连 headers 键都不该有**(写成 headers: undefined 会让下游 deepStrictEqual 当场不等)'
    )
  }
)

// ==================== L2-6 · gid 只活在内存 ====================

test(
  'L2-6 引擎 gid 不落库:重启后重新分配一个新 gid,旧 gid 在库里查无此物',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-gid')
    const dbPath = path.join(dir, 'downlord.db')
    const h1 = await startManager(dir, { enginePrefix: 'gidA' })
    const id = await h1.manager.addTask({ kind: 'http', source: 'https://example.com/x.bin' })
    assert.equal(h1.engine.addUriCalls.length, 1)
    // 旧 gid 由 FakeEngine 生成:gidA_1
    assert.ok(!rawDump(dbPath).includes('gidA_1'), '引擎 gid 不得落库(§7.4-b)')
    await h1.stop()

    const h2 = await startManager(dir, { enginePrefix: 'gidB' })
    t.after(() => h2.stop())
    // 重启后靠「从库读回未完成任务重新提交」续传,而不是靠持久化的 gid(§7.4-c)
    assert.equal(h2.engine.addUriCalls.length, 1, '重启后应重新提交一次(新 gid 由引擎重新分配)')
    assert.equal(h2.engine.addUriCalls[0].url, 'https://example.com/x.bin')
    assert.equal(h2.manager.getTask(id)?.status, 'downloading')
    assert.ok(!rawDump(dbPath).includes('gidB_1'), '新 gid 同样不得落库')
  }
)

// ==================== L2-7 · seeding runtime 重启即消失 ====================

test(
  'L2-7 做种 runtime 是内存位:重启前 stopSeeding 命中引擎,重启后同一条 completed torrent 幂等拒绝',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-seed')
    const dbPath = path.join(dir, 'downlord.db')
    // 种成 downloading:恢复期会被重提引擎 → 建立 taskId ↔ engineId 映射,引擎帧才递得进来
    // (引擎帧的 `id` 是 **engineId**,不是 taskId —— 直接拿 taskId 发帧会被静默忽略,实测踩过)
    const h1 = await startManager(dir, {
      enginePrefix: 'seedA',
      seed: () => [
        seeded('downloading', {
          id: 'bt1',
          kind: 'torrent',
          source: 'magnet:?xt=urn:btih:abc',
          torrentMeta: { name: 'bt1', infoHash: 'abc', files: [] }
        })
      ]
    })
    assert.equal(h1.engine.addUriCalls.length, 1, '前置:downloading 的 torrent 应被恢复重提')

    // 下满 + seeding 位 → 固化 completed(持久化终态)+ 置做种 runtime
    h1.engine.emit({
      id: 'seedA_1',
      status: 'downloading',
      totalBytes: 1000,
      downloadedBytes: 1000,
      speed: 0,
      connections: 1,
      seeding: true
    })

    const seedFrames = h1.frames.filter((f) => f.id === 'bt1')
    assert.ok(seedFrames.length > 0, '做种帧应被广播')
    assert.equal(seedFrames[seedFrames.length - 1].seeding, true, 'seeding runtime 位应为真')
    assert.equal(h1.row('bt1')?.status, 'completed', '做种不得改变持久化终态')
    assert.ok(!rawDump(dbPath).includes('seeding'), 'seeding 不得以任何形式落库')

    // 正向对照:runtime 位在时,stopSeeding 确实下发到引擎
    await h1.manager.stopSeeding('bt1')
    assert.deepEqual(h1.engine.stopSeedingCalls, ['seedA_1'], '做种中 stopSeeding 应命中引擎')
    const afterStop = h1.frames.filter((f) => f.id === 'bt1')
    assert.equal(afterStop[afterStop.length - 1].seeding, false, '停做种后广播 seeding=false')
    await h1.stop()

    // —— 重启:completed 不重提、runtime 位是空的 ——
    const h2 = await startManager(dir, { enginePrefix: 'seedB' })
    t.after(() => h2.stop())
    assert.equal(h2.manager.getTask('bt1')?.status, 'completed', '持久化终态活过重启')
    await h2.manager.stopSeeding('bt1')
    assert.deepEqual(
      h2.engine.stopSeedingCalls,
      [],
      'seeding runtime 重启即消失 → stopSeeding 幂等拒绝,绝不下发引擎'
    )
  }
)

// ==================== L2-8 · 恢复期重提交失败 → 落 error(catch 支路) ====================

test(
  'L2-8 恢复期重提交引擎抛错 → 该任务落 error 并把原因写进库,不是静默停在 downloading',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'l2-recover-fail')
    const h1 = await startManager(dir, {
      seed: () => [seeded('downloading', { id: 'boom1' })]
    })
    await h1.stop()

    const dbPath = path.join(dir, 'downlord.db')
    const { TaskManager } = await import('./taskManager')
    const { initDatabase } = await import('../db/connection')
    const db = initDatabase(dbPath)
    const engine = new FakeEngine('engFail')
    engine.failAddUri = 'aria2 连接被拒绝'
    const manager = new TaskManager(
      {
        engine,
        videoResolver: new HangingVideoResolver(),
        initDatabase: () => db,
        getVideoPrefs: () => ({ defaultHeight: null, defaultAudioOnly: false }),
        ensureDir: () => {},
        existsSync: () => false,
        readDir: () => [],
        trashItem: async () => {}
      },
      { dbPath, defaultDir: dir, maxConcurrent: 3 }
    )
    await manager.start()
    t.after(async () => {
      await manager.stop()
      try {
        db.close()
      } catch {
        // 见上
      }
    })

    const { getTask } = await import('../db/taskDao')
    const row = getTask(db as unknown as TaskDaoDatabase, 'boom1')
    assert.equal(manager.getTask('boom1')?.status, 'error', '重提交失败必须落 error,不许停在 downloading')
    assert.equal(row?.status, 'error', 'error 态必须落库(重启后仍看得见)')
    assert.ok(
      row?.error?.includes('aria2 连接被拒绝'),
      `失败原因必须写进库供用户看见,实得:${String(row?.error)}`
    )
  }
)
