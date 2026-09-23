/**
 * §7.3 红线补测:**迁移在单一事务内,异常整体 ROLLBACK、库停在旧版、数据无损**(R-7.3-c)。
 *
 * 盘点结论:`migration.integration.test.ts` 的三条(v2 / v3 / v4)测的都是**迁移成功**那条路 ——
 * 版本推进、逐行零变化、索引建成。「迁移**失败**时会不会把库留在半拉状态」在本文件之前
 * **一条断言都没有**;`engines/nodeSqlite.ts` 的 `ROLLBACK` 那一支实测也是零覆盖。
 * 而 v3 那种「重建 tasks 表」的迁移一旦半途失败又不回滚,丢的是**不可重建的真实下载历史**。
 *
 * 怎么造失败:往导出的 `migrations` 数组临时追加一条 **v5**,它先做一次**看得见的结构改动**
 * (`ALTER TABLE tasks ADD COLUMN …`)再抛错。断言三件:
 *   ① `runMigrations` 把异常**重抛**给上层(不静默吞);
 *   ② `schema_version` 停在 4(库仍是旧版);
 *   ③ 那次 `ALTER TABLE` **不在**最终表里,且历史行逐字段零变化 —— 这一条才是「单一事务」的真凭据。
 *      只断言版本号没推进是不够的:哪怕 DDL 已经落地、只是没写 `schema_version`,②也照样绿。
 *
 * ⚠️ 追加的 v5 在 `finally` 里 `splice` 掉。node:test **一个测试文件一个进程**,故这次改动不会
 * 漏给别的测试文件;同文件内仍靠 finally 复原,免得后面的用例读到脏数组。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { canLoadSqlite, rawSqliteCtor } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'
import type { AppDatabase } from './connection'

const SQLITE_OK = canLoadSqlite()

const INSERT_TASK = `INSERT INTO tasks (
  id, kind, source, status, filename, savePath, category, totalBytes, downloadedBytes,
  videoMeta, error, createdAt, startedAt, completedAt, torrentMeta
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

/** 真实历史样本(源数据,不可重建)—— 迁移炸掉后必须逐字段还在 */
const HISTORY_ROWS = [
  ['h-http', 'http', 'https://x/a.zip', 'completed', 'a.zip', 'D:\\Old\\a.zip', 'archive', 123, 123, null, null, 1000, 1000, 2000, null],
  ['h-video', 'video', 'https://y/watch?v=1', 'error', 'v.mp4', 'D:\\Old\\v.mp4', 'video', 0, 0, '{"title":"V"}', 'boom', 1500, null, null, null]
] as const

function columnsOf(db: AppDatabase): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)
}

function snapshotRows(db: AppDatabase): Record<string, unknown>[] {
  return (db.prepare('SELECT * FROM tasks ORDER BY id').all() as object[]).map((r) => ({ ...r }))
}

test(
  'R-7.3-c 迁移抛错 → 整体 ROLLBACK:版本停在旧版 + 半途的 DDL 不落地 + 历史行逐字段零变化',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'rollback')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { migrations, runMigrations, LATEST_MIGRATION_VERSION } = await import('./migration')

    const db = initDatabase(dbPath)
    const addedIndex = migrations.length
    try {
      for (const row of HISTORY_ROWS) {
        db.prepare(INSERT_TASK).run(...row)
      }
      const versionBefore = (
        db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      ).v
      const columnsBefore = columnsOf(db)
      const rowsBefore = snapshotRows(db)
      assert.equal(versionBefore, LATEST_MIGRATION_VERSION, '前置:库已在最新版')
      assert.ok(!columnsBefore.includes('bogus_gid'), '前置:tasks 表没有 bogus_gid 列')

      // 注入一条「先改结构、再炸」的迁移。先 ALTER 后抛,是为了让 ③ 有东西可查:
      // 若事务边界没圈住 DDL,这一列就会留在表里。
      migrations.push({
        version: LATEST_MIGRATION_VERSION + 1,
        up: (m) => {
          m.exec('ALTER TABLE tasks ADD COLUMN bogus_gid TEXT')
          m.prepare("UPDATE tasks SET bogus_gid = 'leaked'").run()
          throw new Error('INJECTED_MIGRATION_FAILURE')
        }
      })

      // ① 异常必须重抛给上层(静默吞掉 = 上层以为迁移成功了)
      assert.throws(
        () => runMigrations(db),
        /INJECTED_MIGRATION_FAILURE/,
        '迁移异常必须重抛,不得吞掉'
      )

      // ② 库停在旧版
      const versionAfter = (
        db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      ).v
      assert.equal(versionAfter, versionBefore, `库停在 v${versionBefore}(失败的 v5 没被记账)`)

      // ③ 单一事务的真凭据:半途的 DDL / DML 一并回滚
      const columnsAfter = columnsOf(db)
      assert.deepEqual(columnsAfter, columnsBefore, 'ALTER TABLE 已随事务回滚(表结构逐列不变)')
      assert.deepEqual(snapshotRows(db), rowsBefore, '真实历史行逐字段字节级零变化')
    } finally {
      migrations.splice(addedIndex) // 复原导出数组,免得同文件后续用例读到脏数据
      db.close()
    }
  }
)

test(
  'R-7.3-c 回滚后库仍可用:重跑 runMigrations 幂等(无 pending 直接返回),后续读写正常',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'rollback-usable')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { runMigrations, LATEST_MIGRATION_VERSION } = await import('./migration')

    const db = initDatabase(dbPath)
    try {
      // 已是最新版 → 无 pending → 直接返回(既不重复建表,也不重复写 schema_version)
      const appliedBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }
      ).c
      runMigrations(db)
      runMigrations(db)
      const appliedAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }
      ).c
      assert.equal(appliedAfter, appliedBefore, '重复调用不新增 schema_version 记录')
      assert.equal(appliedAfter, LATEST_MIGRATION_VERSION, `schema_version 恰好 ${LATEST_MIGRATION_VERSION} 条`)

      db.prepare(INSERT_TASK).run(...HISTORY_ROWS[0])
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get('h-http') as { id: string }
      assert.equal(row.id, 'h-http', '库正常可写可读')
    } finally {
      db.close()
    }
  }
)

test(
  'R-7.3-c 嵌套事务里抛错同样整体回滚(savepoint 路径,engines/nodeSqlite.ts)',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'savepoint')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const db = initDatabase(dbPath)
    try {
      db.prepare(INSERT_TASK).run(...HISTORY_ROWS[0])
      const rowsBefore = snapshotRows(db)

      // 外层事务 → 内层事务(SAVEPOINT)抛错 → 内层 ROLLBACK TO + RELEASE,外层继续,由外层再抛
      const inner = db.transaction(() => {
        db.prepare('DELETE FROM tasks WHERE id = ?').run('h-http')
        throw new Error('INJECTED_NESTED_FAILURE')
      })
      const outer = db.transaction(() => {
        db.prepare(INSERT_TASK).run(...HISTORY_ROWS[1])
        inner()
      })

      assert.throws(() => outer(), /INJECTED_NESTED_FAILURE/, '嵌套事务的异常同样重抛')
      assert.deepEqual(snapshotRows(db), rowsBefore, '内外两层的改动全部回滚,历史行零变化')

      // 回滚后事务栈没坏:还能正常开新事务
      const ok = db.transaction(() => {
        db.prepare(INSERT_TASK).run(...HISTORY_ROWS[1])
      })
      ok()
      assert.equal(snapshotRows(db).length, 2, '回滚后新事务照常提交(事务深度已复位)')
    } finally {
      db.close()
    }
  }
)

// 原生 SQLite 侧的正向对照:证明上面那条「回滚」不是因为 DDL 压根没执行过。
// 若 `ALTER TABLE` 在这个引擎上根本不生效,①②③ 会集体变成恒真的空判据。
test(
  '正向对照:同一条 ALTER TABLE 不放进事务时确实会改到表结构',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'ddl-control')
    const dbPath = join(dir, 'control.db')
    const DatabaseSync = rawSqliteCtor()
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
      db.exec('ALTER TABLE tasks ADD COLUMN bogus_gid TEXT')
      const names = (
        db.prepare('SELECT name FROM pragma_table_info(?)') as unknown as {
          all(p: string): Array<{ name: string }>
        }
      ).all('tasks')
      assert.ok(
        names.some((c) => c.name === 'bogus_gid'),
        'ALTER TABLE 在本引擎上确实会加列(故上一条的「列没加上」是回滚的功劳)'
      )
    } finally {
      db.close()
    }
  }
)
