/**
 * 扩展连接三态推导(纯函数,时钟注入;v0.4 Task 3 · spec §5.3 · plan 1.6)。
 *
 * 第三态叫「**待活动**」不叫「断开」(CONTEXT.md 术语):握手是**事件驱动**的
 * (sw 冷启动 / 打开 popup / 有真实业务请求),**没有定期心跳** —— 故「久无握手」既可能是
 * 扩展挂了、也可能只是用户一天没下载。**分不清就不假装分得清**,「断开」是我们无权作出的断言。
 */
import type { ExtensionLinkState } from '../../shared/ipc'

/** 「已连接」窗口:最近一次成功握手在 5 分钟内即认为连着 */
export const LINK_CONNECTED_WINDOW_MS = 5 * 60_000

export interface DeriveLinkStateInput {
  /**
   * 最近一次**成功且已鉴权**的通道请求时间(内部实现名,对外 IPC / UI 叫 `lastHandshakeAt`)。
   * `null` = 本次启动以来一次都没收到过 —— **只活在内存**,重启回落 `null`。
   */
  lastActiveAt: number | null
  now: number
  /** 窗口长度(缺省 5 分钟;测试可注入短窗口) */
  windowMs?: number
}

/**
 * 推导扩展三态:
 * - `lastActiveAt === null` → `unpaired`(**只声称我们真知道的那件事**:本次启动以来没收到握手,
 *   而不是「扩展未安装 / 未配对成功」—— DownLord 根本不知道用户有没有把配对码粘进扩展)
 * - `now - lastActiveAt <= windowMs` → `connected`(**含时钟回拨即 `now < lastActiveAt` 的情形**,不抛)
 * - 否则 → `idle_pending`(「待活动」)
 */
export function deriveLinkState({
  lastActiveAt,
  now,
  windowMs = LINK_CONNECTED_WINDOW_MS
}: DeriveLinkStateInput): ExtensionLinkState {
  if (lastActiveAt === null) return 'unpaired'
  // 时钟回拨(系统对时 / 用户改时间)时差值为负 —— 判「已连接」而非抛错:
  // 刚刚才握过手,没有任何理由把它说成「久无活动」。
  const elapsed = now - lastActiveAt
  if (elapsed <= windowMs) return 'connected'
  return 'idle_pending'
}
