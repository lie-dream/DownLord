/**
 * sw 生命周期状态 — **§5 五条约定的「活证据」**(v0.4 Task 2 · spec §5.3)。
 *
 * 做的事最小但真实:每次 sw 被唤醒把计数 +1 落 `adapter.storage`,popup 读出来显示。
 * - 计数**跨 sw 销毁持续增长** → L1 有效(状态真的落盘了);
 * - 若有人把计数改回模块级变量,计数会在每次唤醒后归零 → **约定被违反时现象立刻可见**,
 *   不必等到 Task 4 才发现。
 *
 * 状态迁移写成纯函数 `nextWakeState`,由 `lifecycle.test.ts` 在 Node 里断言。
 */
import type { BrowserAdapter } from '../adapter/browserAdapter'

/**
 * 唤醒来源。取值只列**真的注册了监听器**的那几种。
 *
 * `'message'` 由 v0.4 Task 3 补上:Task 2 的 `ChromeApiSubset` 刻意不封消息 API(留到上通道时再加),
 * 故当时 popup 打开**不产生任何已注册事件**、计数不 +1 —— 这正是 `docs/TODO.md` **#46** 记的
 * 「M4 判据不可达」。Task 3 封了 `runtime.onMessage`、popup 打开即 `sendMessage`,该判据自此可达。
 */
export type WakeEvent = 'install' | 'update' | 'other' | 'startup' | 'message'

export interface WakeState {
  /** 累计唤醒次数(跨 sw 销毁持续增长) */
  count: number
  /** 最近一次的唤醒来源 */
  lastEvent: WakeEvent
}

/** storage 里的 key。popup 侧读同一个 key,单一来源不漂移。 */
export const WAKE_STATE_KEY = 'downlord:wakeState'

/**
 * 纯函数状态迁移。`prev` 可为 `undefined` = 冷启动(约定 L5:任何一次唤醒都可能读到空)。
 * `prev.count` 若被外部写坏(非有限数 / 负数),按 0 重新起算而非把脏值传播下去。
 */
export function nextWakeState(prev: WakeState | undefined, event: WakeEvent): WakeState {
  const prevCount = prev?.count
  const base =
    typeof prevCount === 'number' && Number.isFinite(prevCount) && prevCount > 0
      ? Math.floor(prevCount)
      : 0
  return { count: base + 1, lastEvent: event }
}

/**
 * 读 storage → 调纯函数 → 写回。**全程 `await`,不 fire-and-forget**(约定 L4)——
 * 写到一半就被回收会丢状态,所以调用方必须能等到这个 Promise。
 */
export async function recordWake(adapter: BrowserAdapter, event: WakeEvent): Promise<WakeState> {
  const prev = await adapter.storage.get<WakeState>(WAKE_STATE_KEY)
  const next = nextWakeState(prev, event)
  await adapter.storage.set(WAKE_STATE_KEY, next)
  return next
}
