/**
 * `better-sqlite3` 的**测试替身**(v1.0 Task 1 Phase 2)。
 *
 * 为什么需要它:`src/main/db/engines/betterSqlite.ts` 是 ARCHITECTURE §7.3 明写的「**可一文件回退**」
 * 保险 —— 默认引擎是 `node:sqlite`,这个文件平时不在任何 import 链上,而 `better-sqlite3` 这个 npm 包
 * **本就没装**(类型由常驻的 `better-sqlite3.d.ts` 满足)。结果它长期是**零覆盖**。
 *
 * 🔴 零覆盖 ≠ 死代码,更 ≠ 可以悄悄挪进「排除项」—— 那等于把「不可测」伪装成「已覆盖」。
 * 本替身让那份适配器能在**不装原生包**的前提下被真实加载并断言其转发行为(尤其是
 * `pragma(..., { simple: true })` 这个 better-sqlite3 专属的取值形态 —— 写错了回退当天才会发现)。
 *
 * 只实现 `betterSqlite.ts` 用到的那几个面,并把调用逐笔记下来供断言。
 */
export interface PragmaCall {
  sql: string
  options?: { simple?: boolean }
}

export interface StubState {
  path: string
  execs: string[]
  prepared: string[]
  pragmas: PragmaCall[]
  closed: boolean
  transactionWraps: number
}

/** 最近一次 `new Database(path)` 的记录 —— 测试从这里取证 */
export const lastStub: { current: StubState | null } = { current: null }

/** 各 PRAGMA 的返回值(simple 模式下 better-sqlite3 直接回标量) */
const PRAGMA_RESULTS: Record<string, string> = {
  quick_check: 'ok',
  'journal_mode = WAL': 'wal'
}

export default class BetterSqliteStub {
  private readonly state: StubState

  constructor(path: string) {
    this.state = {
      path,
      execs: [],
      prepared: [],
      pragmas: [],
      closed: false,
      transactionWraps: 0
    }
    lastStub.current = this.state
  }

  prepare(sql: string): { sql: string; run: () => void; get: () => undefined; all: () => never[] } {
    this.state.prepared.push(sql)
    return { sql, run: () => {}, get: () => undefined, all: () => [] }
  }

  exec(sql: string): void {
    this.state.execs.push(sql)
  }

  /** better-sqlite3 的 `transaction()` 返回「调用即执行」的包装函数 */
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    this.state.transactionWraps++
    return (...args: TArgs): TResult => fn(...args)
  }

  pragma(sql: string, options?: { simple?: boolean }): unknown {
    this.state.pragmas.push({ sql, options })
    // simple:true → 标量;否则回行数组(betterSqlite.ts 必须用 simple 才拿得到字符串)
    const value = PRAGMA_RESULTS[sql] ?? 'unknown'
    return options?.simple ? value : [{ [sql]: value }]
  }

  close(): void {
    this.state.closed = true
  }
}
