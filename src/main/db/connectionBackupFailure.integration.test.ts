/** T1-036：真实 SQLite 迁移备份失败后关闭句柄，原异常与历史均保留。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canLoadSqlite, rawSqliteCtor } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'

// 内建模块的 CJS 导出可变；不能 mock 冻结的 ESM 命名空间或产品模块。
const fsCjs = createRequire(import.meta.url)('fs') as typeof import('fs')

test('T1-036 备份失败 → 句柄关闭 + 异常仍向上传', { skip: !canLoadSqlite() }, async (t) => {
  const dir = await makeTempDir(t, 'backup-handle')
  const dbPath = join(dir, 'downlord.db')
  const walPath = `${dbPath}-wal`
  const { initDatabase } = await import('./connection')

  const seed = initDatabase(dbPath)
  let historyBefore: unknown
  try {
    seed
      .prepare(
        `INSERT INTO tasks
      (id, kind, source, status, filename, savePath, totalBytes, downloadedBytes, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'legacy-1',
        'http',
        'https://example.test/a.zip',
        'completed',
        'a.zip',
        join(dir, 'a.zip'),
        123,
        123,
        1000
      )
    // 仅夹具退回 v3，制造待迁移存量库；生产 schema / migrations 不变。
    seed.prepare('DELETE FROM schema_version WHERE version >= 4').run()
    historyBefore = {
      ...(seed.prepare('SELECT * FROM tasks WHERE id = ?').get('legacy-1') as object)
    }
    assert.equal(
      (seed.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
      3
    )
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    seed.close()
  }

  const failure = new Error('INJECTED_PREMIGRATION_COPY_FAILURE_T1_036')
  let walPresentAtFailure = false
  t.mock.method(fsCjs, 'copyFileSync', () => {
    walPresentAtFailure = existsSync(walPath)
    throw failure
  })
  try {
    assert.throws(
      () => initDatabase(dbPath),
      (err: unknown) => err === failure,
      '必须向上传递原异常对象，不能吞错或改走无备份迁移'
    )
  } finally {
    t.mock.restoreAll()
  }
  assert.equal(walPresentAtFailure, true, '故障点确有 WAL，避免未曾打开句柄的假绿')

  const DatabaseSync = rawSqliteCtor()
  const after = new DatabaseSync(dbPath)
  try {
    assert.deepEqual(
      { ...(after.prepare('SELECT MAX(version) AS v FROM schema_version').get() as object) },
      { v: 3 },
      '失败后版本未推进'
    )
    assert.deepEqual(
      { ...(after.prepare('SELECT * FROM tasks WHERE id = ?').get('legacy-1') as object) },
      historyBefore,
      '历史逐字段保留'
    )
  } finally {
    after.close()
  }
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes('.backup.')),
    [],
    '不留下半份备份'
  )

  // 这是被测行为，不是 warning-only teardown：旧代码在这里真实抛 EBUSY。
  if (existsSync(walPath)) unlinkSync(walPath)
  assert.equal(existsSync(walPath), false, '失败后的 WAL 可删除或已由关闭清除')
  if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`)
  unlinkSync(dbPath)
  assert.equal(existsSync(dbPath), false, '主库也不再被失败的初始化句柄占用')
})
