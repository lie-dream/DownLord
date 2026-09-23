/**
 * §7.3 / §7.4 红线补测:**运行时态绝不落库**(R-7.3-f)与 **`gid` 只活在内存**(R-7.4-b)的行为侧。
 *
 * 盘点结论:既有 `tasks/integration.test.ts` 的 **I-09** 只钉住了 `headers` 一个字段
 * (「走完带 headers 的接管流程 → 列集合不含 headers」);`gid` / `limitKBps` / `seeding` /
 * BT 富进度(`uploadSpeed` / `uploadLength` / `numSeeders` / `connections`)这几个同为运行时态的字段
 * **一条行为断言都没有** —— 只有 `grep -rn "gid" src/main/db/` 这种源码判据在管,
 * 而源码判据只能证明「**这一次**没人动 db 层」。
 *
 * 本文件补的是 DAO 那一层的行为闸门:**把带全套运行时态的 Task 交给 `insertTask`,读回来时它们
 * 必须一个都不在**,且 `tasks` 表列集合逐字不变。
 *
 * ⚠️ **「加列即红」的确切边界**(沿用 I-09 注释里 2026-08-04 的三次反向探针实测,不是推断):
 *   · 改 `schema.ts::TASKS_TABLE_SQL` 加一列 → **本文件不红**,而这是**正确**的:v3 迁移用
 *     字面自包含的 SQL 重建 tasks,schema.ts 的新列会被那次重建丢掉,根本没进最终表;
 *   · 新增一条 `ALTER TABLE tasks ADD COLUMN gid TEXT` 的迁移 → **本文件变红**。那才是真实失效模式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import type { Task } from '../../shared/ipc'
import { canLoadSqlite } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'
import type { TaskDaoDatabase } from './taskDao'

const SQLITE_OK = canLoadSqlite()

/** `tasks` 表的**全部**持久化列,逐字写死。多一列 / 少一列 / 改名都要红。 */
const PERSISTED_COLUMNS = [
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

/** 运行时态字段名 —— 它们**都不该**出现在列集合 / 读回的行里 */
const RUNTIME_ONLY_FIELDS = [
  'gid',
  'limitKBps',
  'headers',
  'seeding',
  'uploadSpeed',
  'uploadLength',
  'numSeeders',
  'connections',
  'speed'
]

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'rt-1',
    kind: 'http',
    source: 'https://x/a.bin',
    status: 'downloading',
    filename: 'a.bin',
    savePath: 'D:\\Downloads\\a.bin',
    category: 'other',
    totalBytes: 4096,
    downloadedBytes: 1024,
    speed: 512,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1000,
    startedAt: 1000,
    completedAt: null,
    ...overrides
  }
}

test(
  'R-7.3-f / R-7.4-b:带全套运行时态的 Task 落库 → 读回一个都不在,列集合逐字不变',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'runtime-state')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { insertTask, getTask, updateTask } = await import('./taskDao')

    const db = initDatabase(dbPath)
    try {
      const dao = db as unknown as TaskDaoDatabase

      // 前置正向对照:列集合就是那 15 列(先证明「读列集合」这件事本身在工作)
      const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
      assert.deepEqual(columns, PERSISTED_COLUMNS, 'tasks 列集合逐字等于 15 列持久化列')

      // 造一条**同时带齐** gid / limitKBps / headers / seeding / BT 富进度的任务。
      // gid 不在 shared Task 类型上(它只活在 DownloadEngine 内部),故显式 as 掺进去 ——
      // 这正是「有人顺手把 gid 塞进落库对象」的模拟。
      const runtimeLaden = {
        ...makeTask(),
        gid: '2089b05ecca3d829',
        limitKBps: 512,
        headers: { Referer: 'https://x/page', 'User-Agent': 'DownLord/1.0' },
        seeding: true,
        uploadSpeed: 111,
        uploadLength: 222,
        numSeeders: 3,
        connections: 8
      } as unknown as Task

      const inserted = insertTask(dao, runtimeLaden)

      // ① 读回的行里没有任何运行时态字段
      for (const field of RUNTIME_ONLY_FIELDS) {
        if (field === 'speed') continue // speed 在投影里恒 0,单独断言
        assert.ok(
          !(field in (inserted as unknown as Record<string, unknown>)),
          `读回的任务不含运行时态字段 ${field}`
        )
      }
      assert.equal(inserted.speed, 0, 'speed 投影恒 0(不落库、不回读写入值)')
      assert.equal(getTask(dao, 'rt-1')?.speed, 0, 'getTask 同样恒 0')

      // ② 落库过一趟之后,列集合仍是那 15 列(没人被这些字段撑出新列)
      const columnsAfter = (
        db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      assert.deepEqual(columnsAfter, PERSISTED_COLUMNS, '写入运行时态后列集合零变化')

      // ③ updateTask 也拦得住:显式拿运行时态字段去更新,SQL 里不许出现它们
      updateTask(dao, 'rt-1', {
        limitKBps: 999,
        headers: { Referer: 'https://evil' },
        seeding: false,
        downloadedBytes: 2048
      } as Parameters<typeof updateTask>[2])
      const afterUpdate = getTask(dao, 'rt-1')
      assert.equal(afterUpdate?.downloadedBytes, 2048, '正向对照:白名单内的列确实被更新了')
      for (const field of ['limitKBps', 'headers', 'seeding']) {
        assert.ok(
          !(field in (afterUpdate as unknown as Record<string, unknown>)),
          `updateTask 未把运行时态字段 ${field} 写进库`
        )
      }
      assert.deepEqual(
        (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name),
        PERSISTED_COLUMNS,
        'updateTask 之后列集合仍零变化'
      )

      // ④ §7.4:重启后从库读回的任务**没有 gid** —— 续传只能靠重新提交引擎拿新 gid
      const reread = getTask(dao, 'rt-1') as unknown as Record<string, unknown>
      assert.ok(!('gid' in reread), '重启后从库读回的任务不含 gid(不靠 gid 持久化)')
      assert.equal(reread.source, 'https://x/a.bin', '正向对照:业务信息(source)确实读得回来')
    } finally {
      db.close()
    }
  }
)

test(
  'R-7.3-a 行级 JSON 损坏不放大为全量失败:videoMeta / torrentMeta 退化 null,其余字段照常读回',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'row-corruption')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { getTask, listTasks } = await import('./taskDao')

    const db = initDatabase(dbPath)
    try {
      // quick_check 只校验 B-tree 结构,不校验应用层 JSON:一行坏 videoMeta 若直接抛,
      // listTasks 会整体失败 → 任务列表永远拉不到,等于把「一行坏」放大成「历史全灭」。
      db.prepare(
        `INSERT INTO tasks (id, kind, source, status, filename, savePath, category,
         totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt, torrentMeta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('broken', 'video', 'https://y/1', 'completed', 'v.mp4', 'D:\\v.mp4', 'video', 1, 1, '{not json', null, 1, 1, 2, '{also not json')

      const task = getTask(db as unknown as TaskDaoDatabase, 'broken')
      assert.equal(task?.videoMeta, null, '坏 videoMeta 退化为 null(不抛)')
      assert.equal(task?.torrentMeta, null, '坏 torrentMeta 退化为 null(不抛)')
      assert.equal(task?.filename, 'v.mp4', '同一行的其余字段照常读回(损坏不放大)')
      assert.equal(listTasks(db as unknown as TaskDaoDatabase).length, 1, 'listTasks 不因该行而整体失败')
    } finally {
      db.close()
    }
  }
)

test('insertTask 写入后读不回 → 抛错(不静默返回一个假任务)', async () => {
  const { insertTask } = await import('./taskDao')

  // 纯桩:transaction 照跑、prepare 收下 SQL 但什么都不存 → 模拟「写了但读不回」
  const blackhole: TaskDaoDatabase = {
    prepare: () => ({
      all: () => [],
      get: () => undefined,
      run: () => undefined
    }),
    transaction:
      <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) =>
      (...args: TArgs): TResult =>
        fn(...args)
  }

  assert.throws(
    () => insertTask(blackhole, makeTask()),
    /could not be read back/,
    '读不回必须抛出,不得返回入参冒充「已落库」'
  )
})
