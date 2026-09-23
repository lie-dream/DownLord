/**
 * 临时暂停接管的判定纯函数(v0.4 Task 4 · spec §5.3 · plan 4.1)。
 *
 * **零定时器、零副作用、零 electron**:暂停只落一个**绝对到期时刻**(`pausedUntil`,epoch ms),
 * 要不要暂停在**每次 intent 到达时现算一次**——与 `deriveLinkState` 同范式。
 *
 * ⚠️ **为什么落绝对时刻而不是「剩余分钟」**(spec §5.1):剩余分钟需要有人不断递减 → 要定时器 →
 * 要处理系统休眠与用户改系统时间;绝对时刻只需现算,这些问题一个都不存在。
 *
 * ⚠️ **过期不清零**:`pausedUntil` 到期后**不主动写盘清成 `null`** —— 那要么起定时器、要么每次读都
 * 写盘。`isTakeoverPaused` 现算即可;下次用户设新档时自然覆盖。
 */

/** 一分钟的毫秒数(时长档只有分钟粒度,不引入 ms 级入参) */
const MS_PER_MINUTE = 60_000

/**
 * 此刻是否在暂停期内。
 *
 * **边界:恰好到期即解除**(`pausedUntil === now` → `false`)—— 与「剩余时长归零」的直觉一致,
 * 不留一个还得再等一毫秒的暂停(U-05)。
 */
export function isTakeoverPaused(pausedUntil: number | null, now: number): boolean {
  if (pausedUntil === null) return false
  return pausedUntil > now
}

/**
 * 把时长档换算成落盘用的绝对到期时刻。
 *
 * - `minutes === null` → `null`(**恢复接管**,时长档里的第四项)。
 * - 非有限数 / `<= 0` → 同样回落 `null`:那是「立即到期」,与恢复接管**在可观察行为上完全一致**,
 *   与其存一个已经过期的时刻不如直接存 `null`(否则设置页会显示「已暂停 · 剩余 0 分钟」这种自相矛盾态)。
 *
 * ⚠️ 只认分钟,**没有「直到关闭浏览器」这一档** —— DownLord 无从得知浏览器何时关闭
 * (通道无反向推送、sw 空闲即销毁,「久无握手」既可能是浏览器关了也可能是用户一天没下载)。
 * 分不清就不假装分得清(CONTEXT.md「待活动」)。
 */
export function pausedUntilFrom(minutes: number | null, now: number): number | null {
  if (minutes === null) return null
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return now + minutes * MS_PER_MINUTE
}

/**
 * 距到期还剩几分钟(**向上取整**,供设置页 / popup 显示「剩余 42 分钟」)。
 *
 * 向上取整而非四舍五入:剩 30 秒时显示「剩余 1 分钟」比「剩余 0 分钟」诚实 ——
 * 后者会让用户以为已经恢复了,而此刻接管确实还没恢复。未暂停 → `0`。
 */
export function remainingMinutes(pausedUntil: number | null, now: number): number {
  if (!isTakeoverPaused(pausedUntil, now)) return 0
  return Math.ceil(((pausedUntil as number) - now) / MS_PER_MINUTE)
}
