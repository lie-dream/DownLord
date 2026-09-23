/**
 * §7.3 的「**可一文件回退 `better-sqlite3`**」保险:让那份适配器**真的被加载并跑一遍**。
 *
 * 背景(Phase 1 实测):`src/main/db/engines/betterSqlite.ts` 长期是**零覆盖** —— 默认引擎是
 * `node:sqlite`,它不在任何 import 链上,而 `better-sqlite3` 这个包本机根本没装。
 *
 * 🔴 **零覆盖 ≠ 死代码**:它是 ARCHITECTURE §7.3 白纸黑字的回退保险,真到要用的那天,
 * 「转发写错了」会在最坏的时刻(主引擎出事、正在回退)才暴露。把它挪进覆盖率「排除项」
 * 更是把「不可测」伪装成「已覆盖」。故这里用**模块解析劫持 + 测试替身**把它跑起来:
 * 不装原生包、不碰产品代码,只验适配器把 `AppDatabase` 的六个面正确转发到 better-sqlite3 的 API。
 *
 * ⚠️ 断言重点是 `pragma(..., { simple: true })`:不带 `simple` 时 better-sqlite3 回的是**行数组**,
 * `quickCheck()` / `enableWal()` 的返回类型立刻从 `string` 变成对象数组 —— 而 `connection.ts` 拿它
 * 跟 `'ok'` 比。这正是「回退当天才会发现」的那类错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'path'

import { lastStub } from '../../../../tests/helpers/betterSqliteStub'

const requireCjs = createRequire(import.meta.url)
const STUB_PATH = resolve(__dirname, '../../../../tests/helpers/betterSqliteStub.ts')

interface ResolverHost {
  _resolveFilename(request: string, ...rest: unknown[]): string
}

test('§7.3 回退适配器:betterSqlite.ts 把 AppDatabase 的六个面正确转发到 better-sqlite3', async () => {
  // 劫持模块解析:`better-sqlite3` → 本地替身。产品代码一个字不动。
  const moduleApi = requireCjs('module') as unknown as ResolverHost
  const original = moduleApi._resolveFilename
  moduleApi._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === 'better-sqlite3') {
      return STUB_PATH
    }
    return original.call(this, request, ...rest)
  }

  try {
    const { createBetterSqliteDatabase } = await import('./betterSqlite')
    const dbPath = join('C:', 'nowhere', 'downlord.db')
    const db = createBetterSqliteDatabase(dbPath)
    const state = lastStub.current
    assert.ok(state, '替身确实被实例化(说明劫持生效,而不是悄悄用了别的东西)')
    assert.equal(state.path, dbPath, '构造时把 dbPath 原样传给 better-sqlite3')

    // ① quickCheck / enableWal 必须走 simple 模式,否则拿到的是行数组而非字符串
    assert.equal(db.quickCheck(), 'ok', 'quickCheck() 回标量字符串')
    assert.equal(db.enableWal(), 'wal', 'enableWal() 回标量字符串')
    assert.deepEqual(
      state.pragmas,
      [
        { sql: 'quick_check', options: { simple: true } },
        { sql: 'journal_mode = WAL', options: { simple: true } }
      ],
      '两个 PRAGMA 都带 { simple: true }(不带就会回行数组,connection.ts 拿它比 "ok" 必失败)'
    )

    // ② exec / prepare 直通
    db.exec('CREATE TABLE t (id TEXT)')
    assert.deepEqual(state.execs, ['CREATE TABLE t (id TEXT)'], 'exec 原样转发')
    const stmt = db.prepare('SELECT 1') as unknown as { sql: string }
    assert.equal(stmt.sql, 'SELECT 1', 'prepare 返回的是底层 statement(结构化满足 DbStatement)')

    // ③ transaction 是「调用即执行」的包装(语义对齐 AppDatabase.transaction)
    let ran = 0
    const wrapped = db.transaction((n: number) => {
      ran += n
      return n * 2
    })
    assert.equal(state.transactionWraps, 1, 'transaction() 只做包装,不立刻执行')
    assert.equal(ran, 0, '包装阶段未执行函数体')
    assert.equal(wrapped(21), 42, '调用包装函数才执行并回传返回值')
    assert.equal(ran, 21, '入参原样透传')

    // ④ close 转发
    assert.equal(state.closed, false, '尚未关闭')
    db.close()
    assert.equal(state.closed, true, 'close() 转发到底层')
  } finally {
    moduleApi._resolveFilename = original
  }
})
