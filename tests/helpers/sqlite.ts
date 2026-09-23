/**
 * 共享的 `node:sqlite` 能力探测(v1.0 Task 1 Phase 2 · spec §2.4ⓑ)。
 *
 * 背景:仓库里已有 **11 份**逐字相同的局部 `canLoadSqlite()`(spec §0.2 列了全部 11 个文件)。
 * 本 Task 的立场是**不修既有、但不让它继续繁殖**:
 *   · 既有 11 份**一份不动**(改 11 个既有测试文件会撞「补测只增不改」的 I-3);
 *   · 本 Task 新增的测试一律从这里 import,**不再复制第 12 份**;
 *   · 11 份的统一收编记入命中清单交后续 Step —— 本文件就是那次收编的锚点。
 *
 * 函数体逐字照抄自 `src/main/db/migration.integration.test.ts`,保持行为完全一致
 * (收编时才谈得上「替换即等价」)。
 */
import { createRequire } from 'node:module'

const requireForProbe = createRequire(import.meta.url)

/**
 * 探测当前运行时能否加载并打开 `node:sqlite`。
 *
 * `npm test` 经 electron-as-node 运行 → 恒 true;本地裸 `node`(< 22.5 或未开 flag)→ false,
 * 调用方据此 `{ skip: !SQLITE_OK }` 优雅跳过。**同步、不静态 import**:静态 import 在不支持的
 * 运行时会让整个文件加载失败,连跳过都做不到。
 */
export function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (path: string) => { close(): void }
    }
    const probe = new DatabaseSync(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
}

/** node:sqlite 原生句柄的最小面(建「存量库」形态用;仅在 `canLoadSqlite()` 为真时调用) */
export interface RawSqlite {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown }
  close(): void
}

/** 取原生 `DatabaseSync` 构造器(绕过 `engine.ts` 适配层,用于手工造存量 / 损坏库) */
export function rawSqliteCtor(): new (path: string) => RawSqlite {
  const { DatabaseSync } = requireForProbe('node:sqlite') as {
    DatabaseSync: new (path: string) => RawSqlite
  }
  return DatabaseSync
}
