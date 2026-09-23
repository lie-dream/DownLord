/**
 * better-sqlite3 回退适配器(Task 3.5 spec §2.5)—— 常驻保险,默认不被 import。
 *
 * 默认引擎为 node:sqlite(`engine.ts`),本文件默认不在构建 / 运行的 import 链上 → 运行时不会
 * `require('better-sqlite3')`、rollup 构建图也不含它。typecheck(tsc 全量扫描)会扫到本文件,
 * 由常驻的 ambient `better-sqlite3.d.ts` 满足类型 —— **即便未安装 better-sqlite3 包也不报错**。
 * 这是「移除运行时依赖但保留一文件回退」自洽的关键(spec §5.1)。
 */
import Database from 'better-sqlite3'
import type { AppDatabase } from '../engine'

export function createBetterSqliteDatabase(dbPath: string): AppDatabase {
  const db = new Database(dbPath)
  return {
    prepare: (sql) => db.prepare(sql), // 结构化满足 DbStatement(run/get/all)
    exec: (sql) => {
      db.exec(sql)
    },
    // 转发原生 helper(自带 savepoint 嵌套);泛型方法形态对齐 AppDatabase.transaction 签名
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
      return db.transaction(fn)
    },
    quickCheck: () => db.pragma('quick_check', { simple: true }) as string,
    enableWal: () => db.pragma('journal_mode = WAL', { simple: true }) as string,
    close: () => {
      db.close()
    }
  }
}
