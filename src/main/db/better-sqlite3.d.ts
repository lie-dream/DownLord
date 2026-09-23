/**
 * better-sqlite3 最小环境类型声明。
 *
 * 项目未安装 `@types/better-sqlite3`(避免引入与 native 模块版本耦合的重型类型);
 * 此处只声明 connection.ts 实际使用到的构造器 / 实例方法,保持类型安全。
 * DAO / migration 各自以结构化接口(`TaskDaoDatabase` / `MigrationDatabase` …)约束,
 * 本声明产出的实例可被结构化地传入这些接口。
 */
declare module 'better-sqlite3' {
  namespace BetterSqlite3 {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement {
      run(...params: unknown[]): RunResult
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
      iterate(...params: unknown[]): IterableIterator<unknown>
    }

    interface Database {
      prepare(sql: string): Statement
      exec(sql: string): Database
      pragma(source: string, options?: { simple?: boolean }): unknown
      transaction<TArgs extends unknown[], TResult>(
        fn: (...args: TArgs) => TResult
      ): (...args: TArgs) => TResult
      close(): Database
      readonly open: boolean
      readonly name: string
    }

    interface Options {
      readonly?: boolean
      fileMustExist?: boolean
      timeout?: number
      verbose?: (...args: unknown[]) => void
    }
  }

  interface BetterSqlite3Constructor {
    new (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database
    (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database
  }

  const BetterSqlite3: BetterSqlite3Constructor
  export = BetterSqlite3
}
