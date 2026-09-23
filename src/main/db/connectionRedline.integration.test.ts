/**
 * §7.3 红线补测:损坏处置 / 启动自检 / 迁移前备份的**失败面**(v1.0 Task 1 Phase 2 · L1)。
 *
 * 与既有 `connection.test.ts`(损坏 → 备份含 -wal/-shm → 重建可用)和 `tasks/integration.test.ts`
 * 的 A6 是**互补**关系,不重复:那两条测的是「损坏被发现后的成功路径」,本文件补的是三块从没被
 * 断言过的地方 ——
 *
 *   ⓐ **`quick_check` 判损坏那一支**:既有两条造的损坏都是「垃圾字节盖掉文件头」,实测走的是
 *      `quickCheck()` **抛出** `file is not a database`(errcode 26)那半;`quick_check`
 *      **返回非 'ok' 诊断串**那半**从未被走过**。本文件造的是**合法 SQLite 文件 + 页内损坏** ——
 *      打得开、读得动,只有 `PRAGMA quick_check` 说它坏。不这么造,「启动 quick_check 自检」
 *      这条红线就只有一半有用例。
 *   ⓑ **备份字节一致**:既有只断言「备份文件存在」。存在但内容是空的 / 是新库的,同样绿。
 *   ⓒ **备份 / 删除失败时绝不静默丢弃**:红线原文是「备份旧库再新建,**绝不静默丢弃**」——
 *      成功路径证不了「绝不」。只有让备份失败,才看得出它是**抛出中止、旧库原地不动**,
 *      还是「备份没成也照删」。
 *
 * ⚠️ **故障注入的边界**:ⓒ 用 `t.mock.method(require('fs'), …)` 让 `copyFileSync` / `unlinkSync`
 * 抛错。只有 **Node 内建模块**能这么注入 —— 产品侧模块经 tsx/esbuild 转 CJS 后导出是只读 getter,
 * 实测 `mock.method` 报 `The argument 'methodName' must be a method`。这条实测结论直接决定了
 * `backupBeforeMigration` 里 **checkpoint 失败退回 sidecar 备份**那条支路无法被自动化覆盖
 * (见交付说明的逐文件豁免)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'

import { canLoadSqlite, rawSqliteCtor } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'

const SQLITE_OK = canLoadSqlite()

/** 取 CJS 的 fs 导出对象(可变)—— `import * as fs` 拿到的是冻结命名空间,`mock.method` 会报 Cannot redefine */
const requireCjs = createRequire(import.meta.url)
const fsCjs = requireCjs('fs') as typeof import('fs')

/** 备份文件名形态:`<db>.backup.<ts>`(损坏被动备份)/ `<db>.backup.pre-migration.<ts>`(迁移前主动备份) */
function backupsIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes('.backup.'))
}

/**
 * 造一个「**打得开、但 `quick_check` 不 ok**」的库:先建真库写够页数,再把**第 3 页**整页写成垃圾
 * (文件头第 1 页原样保留 → 仍是合法 SQLite 文件)。`journal_mode=DELETE` 是为了不留 `-wal`,
 * 让后面的「备份字节 = 损坏前字节」比较只涉及单个文件。
 *
 * 返回损坏后的文件字节快照 —— 备份内容要和它逐字节相等。
 */
function makeCorruptButOpenableDb(dbPath: string): Buffer {
  const DatabaseSync = rawSqliteCtor()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec('CREATE TABLE history (id INTEGER PRIMARY KEY, payload TEXT)')
  // 单事务写入:逐条 autocommit 会每行 fsync 一次(实测 ~5s/次),整批包进事务后是毫秒级
  db.exec('BEGIN')
  const insert = db.prepare('INSERT INTO history (payload) VALUES (?)')
  for (let i = 0; i < 400; i++) {
    insert.run(`row-${i}-${'x'.repeat(200)}`)
  }
  db.exec('COMMIT')
  db.close()

  const PAGE = 4096
  const fd = openSync(dbPath, 'r+')
  try {
    writeSync(fd, Buffer.alloc(PAGE, 0x5a), 0, PAGE, PAGE * 2) // 第 3 页整页垃圾
  } finally {
    closeSync(fd)
  }

  return readFileSync(dbPath)
}

// ⚠️ 本条必须留在文件**第一条**:`connection.ts` 的 `dbInstance` 是模块级单例,下面任何一条
// 跑过 `initDatabase` 之后它就不再是 null,这条断言便永远测不到未初始化那一支。
test('getDatabase() 未初始化即调用 → 抛错(不返回未建表的连接)', async () => {
  const { getDatabase } = await import('./connection')
  assert.throws(() => getDatabase(), /数据库尚未初始化/, '未初始化时必须抛出,而不是返回 null / 空连接')
})

test(
  'R-7.3-e 启动 quick_check 自检:合法 SQLite 文件 + 页内损坏(打得开)→ 自检判损坏 → 备份 + 重建',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'quickcheck')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    makeCorruptButOpenableDb(dbPath)

    // 前置事实(本条的全部意义所在):这个文件**打得开**,只有 quick_check 说它坏。
    // 若这里 open 就抛,本条测的就还是「打不开」那条老路径,与既有两条重复。
    const DatabaseSync = rawSqliteCtor()
    const probe = new DatabaseSync(dbPath)
    const verdict = (probe.prepare('PRAGMA quick_check').get() as { quick_check?: string })
      .quick_check
    probe.close()
    assert.notEqual(verdict, 'ok', `前置:损坏库能打开但 quick_check 不 ok(实得 ${String(verdict)})`)

    const db = initDatabase(dbPath)
    try {
      assert.equal(backupsIn(dir).length, 1, `quick_check 判损坏即备份旧库,实际:${backupsIn(dir).join(',')}`)
      assert.equal(db.quickCheck(), 'ok', '重建后的新库自检通过')
      const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      assert.equal(ver.v, 4, '重建后的新库已迁移到最新版本')
    } finally {
      db.close()
    }
  }
)

test(
  'R-7.3-a 备份是原库的逐字节副本,且新库另起一份(不是把新库当备份)',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'backup-bytes')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const corruptedBytes = makeCorruptButOpenableDb(dbPath)

    const db = initDatabase(dbPath)
    try {
      const backups = backupsIn(dir)
      assert.equal(backups.length, 1, `恰好一份备份,实际:${backups.join(',')}`)

      // ① 备份 = 损坏前那份的**字节**。只断言「文件存在」是不够的:存在但内容为空 / 是新库,同样绿。
      const backupBytes = readFileSync(join(dir, backups[0]))
      assert.ok(
        backupBytes.equals(corruptedBytes),
        `备份内容与被替换的原库逐字节一致(备份 ${backupBytes.length}B vs 原库 ${corruptedBytes.length}B)`
      )

      // ② 新库确实是另起的一份,可用
      const newBytes = readFileSync(dbPath)
      assert.ok(!newBytes.equals(corruptedBytes), '新库不是原库的原样保留(确已重建)')
      db.prepare(
        `INSERT INTO tasks (id, kind, source, status, filename, savePath, category,
         totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt, torrentMeta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('after-rebuild', 'http', 'https://x/a.bin', 'completed', 'a.bin', join(dir, 'a.bin'), 'other', 1, 1, null, null, 1, 1, 2, null)
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get('after-rebuild') as {
        id: string
      }
      assert.equal(row.id, 'after-rebuild', '新库真实可写可读')
    } finally {
      db.close()
    }
  }
)

test(
  'R-7.3-a 备份失败即中止:copyFileSync 抛错 → initDatabase 抛出、损坏库原地不动、不留半份备份',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'backup-fail')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const corruptedBytes = makeCorruptButOpenableDb(dbPath)

    t.mock.method(fsCjs, 'copyFileSync', () => {
      throw new Error('INJECTED_COPY_FAILURE')
    })

    assert.throws(
      () => initDatabase(dbPath),
      /INJECTED_COPY_FAILURE/,
      '备份失败必须抛出让上层感知,不得吞掉继续重建'
    )

    // 红线原文是「绝不静默丢弃」——成功路径证不了「绝不」,只有这里能:备份没成,旧库就必须一个字节没动。
    assert.ok(existsSync(dbPath), '备份失败时旧库仍在原地(没有先删后备)')
    assert.ok(readFileSync(dbPath).equals(corruptedBytes), '旧库字节未被改写')
    assert.deepEqual(backupsIn(dir), [], '未产生任何备份文件(失败即中止,不留半成品)')
  }
)

test(
  'R-7.3-a 删除失败即中止:备份已就位后 unlinkSync 抛错 → 抛出、且备份仍在(历史不丢)',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'unlink-fail')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const corruptedBytes = makeCorruptButOpenableDb(dbPath)

    t.mock.method(fsCjs, 'unlinkSync', () => {
      throw new Error('INJECTED_UNLINK_FAILURE')
    })

    assert.throws(
      () => initDatabase(dbPath),
      /INJECTED_UNLINK_FAILURE/,
      '移除损坏库失败必须抛出中止重建'
    )

    const backups = backupsIn(dir)
    assert.equal(backups.length, 1, `删除失败前备份已完成,实际:${backups.join(',')}`)
    assert.ok(
      readFileSync(join(dir, backups[0])).equals(corruptedBytes),
      '备份仍是原库的逐字节副本(删除失败不影响已留下的那份历史)'
    )
  }
)

test(
  'R-7.3-b 迁移前备份失败即中止迁移:存量库结构 / 版本号一字未动',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'premigration-fail')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    // 1) 先建一个健康库并写入「真实历史」,再把 schema_version 退回 3 → 制造「存量库待迁移 v4」
    const seed = initDatabase(dbPath)
    seed.prepare(
      `INSERT INTO tasks (id, kind, source, status, filename, savePath, category,
       totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt, torrentMeta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('legacy-1', 'http', 'https://x/a.zip', 'completed', 'a.zip', join(dir, 'a.zip'), 'archive', 123, 123, null, null, 1000, 1000, 2000, null)
    seed.prepare('DELETE FROM schema_version WHERE version >= 4').run()
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    seed.close()

    const DatabaseSync = rawSqliteCtor()
    const before = new DatabaseSync(dbPath)
    const verBefore = (before.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number
    }).v
    const rowBefore = { ...(before.prepare('SELECT * FROM tasks WHERE id = ?').get('legacy-1') as object) }
    before.close()
    assert.equal(verBefore, 3, '前置:库停在 v3(有待应用的 v4)')

    // 2) 注入备份失败 → 迁移必须中止在改结构**之前**
    t.mock.method(fsCjs, 'copyFileSync', () => {
      throw new Error('INJECTED_PREMIGRATION_COPY_FAILURE')
    })
    assert.throws(
      () => initDatabase(dbPath),
      /INJECTED_PREMIGRATION_COPY_FAILURE/,
      '迁移前备份失败必须抛出中止,绝不在未备份的情况下改结构'
    )
    t.mock.restoreAll()

    // 3) 库仍停在 v3、历史行逐字段零变化、没有留下半份备份
    const after = new DatabaseSync(dbPath)
    try {
      const verAfter = (after.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number
      }).v
      assert.equal(verAfter, 3, '版本号未推进(迁移确实没跑)')
      const rowAfter = { ...(after.prepare('SELECT * FROM tasks WHERE id = ?').get('legacy-1') as object) }
      assert.deepEqual(rowAfter, rowBefore, '存量历史行逐字段零变化')
    } finally {
      after.close()
    }
    assert.deepEqual(backupsIn(dir), [], '备份失败未留下半份文件')
  }
)

test(
  'R-7.3-e WAL:健康库初始化后 journal_mode = wal,且 -wal 伴生文件真实落盘',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'wal')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const db = initDatabase(dbPath)
    try {
      const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
      assert.equal(mode, 'wal', 'initDatabase 之后 journal_mode 实测为 wal(不是只调用了 enableWal)')
      assert.ok(existsSync(`${dbPath}-wal`), '-wal 伴生文件真实存在(WAL 确已生效,非仅返回值好看)')
      assert.deepEqual(backupsIn(dir), [], '健康路径零备份文件')
    } finally {
      db.close()
    }
  }
)

// 兜底:垃圾字节盖掉文件头(**连读都读不成 SQLite** 那条支路)时,备份也必须是逐字节副本。
// ⚠️ 实测订正:这条走的**不是**「`createDatabase` 构造时抛」——`new DatabaseSync()` 对垃圾文件照样
// 返回句柄,是随后的 `quickCheck()` **抛出** `ERR_SQLITE_ERROR: file is not a database`(errcode 26)。
// 与上面「页内损坏」那条的差别因此是:**quickCheck 抛错** vs **quickCheck 返回非 'ok' 字符串** ——
// 两者在 `connection.ts` 里进的是同一个 catch,但只测一边等于默认另一边也对。
test(
  'R-7.3-a 文件头被盖(quickCheck 直接抛错)同样先备份再重建,备份字节一致',
  { skip: !SQLITE_OK },
  async (t) => {
    const dir = await makeTempDir(t, 'unopenable')
    const dbPath = join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    const garbage = Buffer.from('this is definitely not a sqlite database file')
    writeFileSync(dbPath, garbage)

    const db = initDatabase(dbPath)
    try {
      const backups = backupsIn(dir)
      assert.equal(backups.length, 1, `恰好一份备份,实际:${backups.join(',')}`)
      assert.ok(
        readFileSync(join(dir, backups[0])).equals(garbage),
        '备份 = 原文件的逐字节副本'
      )
      assert.equal(db.quickCheck(), 'ok', '重建后的新库可用')
    } finally {
      db.close()
    }
  }
)
