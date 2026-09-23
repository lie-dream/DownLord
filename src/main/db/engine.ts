/**
 * 持久化引擎的【唯一切换点】—— 引擎无关接口 + 工厂(Task 3.5 spec §2.1 / §2.3)。
 *
 * 设计目标:DAO 只依赖引擎无关接口;引擎选择收敛到本文件;换引擎 = 改 `createDatabase` 一行
 * + 换用常驻的另一个适配器(spec §7.2)。`AppDatabase` 是 `TaskDaoDatabase` / `MigrationDatabase` /
 * `CategoryDaoDatabase` / `SchemaDatabase` 的**结构化超集** → DAO 函数签名与 SQL 一字不改即可消费。
 */
import { createNodeSqliteDatabase } from './engines/nodeSqlite'
// 回退保险:需要时取消下一行注释、改 createDatabase 的 return 为 better-sqlite3 分支即可换回(spec §7.2)。
// import { createBetterSqliteDatabase } from './engines/betterSqlite'

/** prepared statement 的引擎无关面(better-sqlite3 与 node:sqlite 的 Statement 均结构化满足) */
export interface DbStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/**
 * 持久化引擎的引擎无关内部接口。
 * 是 TaskDaoDatabase / MigrationDatabase / CategoryDaoDatabase / SchemaDatabase 的结构化超集
 * → DAO 函数签名与 SQL 一字不改即可消费。
 */
export interface AppDatabase {
  prepare(sql: string): DbStatement
  exec(sql: string): void
  /** 返回「调用即执行」的函数;调用时 BEGIN→fn→COMMIT,异常 ROLLBACK 重抛(spec §3.3)。语义对齐 better-sqlite3.transaction */
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
  /** PRAGMA quick_check 自检,返回 'ok' 或诊断串(封装引擎间形态差异,spec §3.2) */
  quickCheck(): string
  /** PRAGMA journal_mode = WAL,返回实际 journal_mode(预期 'wal',spec §3.2) */
  enableWal(): string
  close(): void
}

/**
 * 【唯一引擎切换点】整个应用经此函数取得 AppDatabase 实例。
 * 换回 better-sqlite3 = 改本函数一行(`return createBetterSqliteDatabase(dbPath)`)+ 一条 `npm i`(spec §7.2)。
 */
export function createDatabase(dbPath: string): AppDatabase {
  return createNodeSqliteDatabase(dbPath)
  // 回退:return createBetterSqliteDatabase(dbPath)
}
