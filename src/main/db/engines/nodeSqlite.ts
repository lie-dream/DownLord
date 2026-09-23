/**
 * node:sqlite 适配器(Task 3.5 spec §2.4)—— 默认引擎。
 *
 * 包 Electron 内置 `node:sqlite` 的 `DatabaseSync`,实现引擎无关的 `AppDatabase` 接口。
 * 去 native:不再依赖 better-sqlite3 原生 binding,测试 / App 统一在 Electron 内置 Node 运行时。
 */
import { DatabaseSync } from 'node:sqlite'
import type { AppDatabase, DbStatement } from '../engine'

/**
 * node:sqlite 绑定参数类型 —— 对齐其内部 `SQLInputValue`(该 type 在 `node:sqlite` 模块内未导出,
 * 无法 import,故按其定义本地等价声明)。适配层把引擎无关的 `unknown[]` 收窄到此再传给底层。
 */
type BindParam = null | number | bigint | string | NodeJS.ArrayBufferView

export function createNodeSqliteDatabase(dbPath: string): AppDatabase {
  const db = new DatabaseSync(dbPath)
  let txDepth = 0 // 支持嵌套(savepoint),语义贴近 better-sqlite3.transaction

  return {
    prepare(sql: string): DbStatement {
      const stmt = db.prepare(sql)
      return {
        run: (...params: unknown[]) => stmt.run(...(params as BindParam[])),
        get: (...params: unknown[]) => stmt.get(...(params as BindParam[])),
        all: (...params: unknown[]) => stmt.all(...(params as BindParam[]))
      }
    },
    exec(sql: string): void {
      db.exec(sql)
    },
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) {
      return (...args: TArgs): TResult => {
        const nested = txDepth > 0
        const sp = `dl_sp_${txDepth}`
        db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
        txDepth++
        try {
          const result = fn(...args)
          db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
          return result
        } catch (err) {
          // 顶层 ROLLBACK 回滚整事务;嵌套 ROLLBACK TO 后须 RELEASE 该 savepoint
          db.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
          if (nested) db.exec(`RELEASE ${sp}`)
          throw err // 重抛:让上层(initDatabase / DAO 调用方)感知,绝不静默吞
        } finally {
          txDepth--
        }
      }
    },
    quickCheck(): string {
      // node:sqlite 返回 null-prototype 行 { quick_check: 'ok' };取列值与 better-sqlite3 simple 模式等价
      const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
      return row?.quick_check ?? 'unknown'
    },
    enableWal(): string {
      // 设置并读回 journal_mode(node:sqlite 实测回 'wal');WAL 须在事务外执行
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as
        | { journal_mode?: string }
        | undefined
      return row?.journal_mode ?? 'unknown'
    },
    close(): void {
      db.close()
    }
  }
}
