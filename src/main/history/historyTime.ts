/**
 * 历史检索 / 统计的时间口径 + 查询辅助纯函数(v0.2 Task 5 · spec §3.1 / §3.2 / §4.3)。
 *
 * 时间口径**单一来源**:搜索(`resolveTimeRange`)与统计(`statWindowStarts`)共用同口径
 * —— 本地时区、今日 00:00:00.000 / 本周一 00:00:00.000 / 本月 1 日 00:00:00.000,避免漂移。
 * 全部注入 `now`(不在函数内取 `Date.now`)便于单测(ARCHITECTURE §7.2 业务在主进程)。
 */
import type { HistoryTimePreset } from '../../shared/ipc'

/** 历史结果默认 / 最大上限(spec §3.1 / §5.5:防极端量一次性全渲染) */
export const DEFAULT_HISTORY_LIMIT = 500

/** 当日 00:00:00.000 起始时间戳(本地时区) */
function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 本周一 00:00:00.000 起始(本地时区;getDay 周日=0 → (day+6)%7 得距周一天数) */
function startOfWeek(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const diff = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - diff)
  return d.getTime()
}

/** 本月 1 日 00:00:00.000 起始(本地时区) */
function startOfMonth(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

/**
 * 时间预设 → 具体 `{ from?, to? }`(createdAt 区间,含端点)。
 * today / week / month:下界为对应窗口起始,上界恒为 `now`;
 * custom:透传 from/to(两个原生日期输入换算);无 preset:空区间(不过滤时间)。
 */
export function resolveTimeRange(
  preset: HistoryTimePreset | undefined,
  from: number | undefined,
  to: number | undefined,
  now: number
): { from?: number; to?: number } {
  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: now }
    case 'week':
      return { from: startOfWeek(now), to: now }
    case 'month':
      return { from: startOfMonth(now), to: now }
    case 'custom':
      return { from, to }
    default:
      return {}
  }
}

/**
 * 统计三窗口起始(与 `resolveTimeRange` 同口径同文件,避免漂移;spec §4.3)。
 * handler 传 `Date.now()`,单测注入固定 `now`。
 */
export function statWindowStarts(now: number): {
  todayStart: number
  weekStart: number
  monthStart: number
} {
  return {
    todayStart: startOfDay(now),
    weekStart: startOfWeek(now),
    monthStart: startOfMonth(now)
  }
}

/**
 * 转义 LIKE 通配符(`\` `%` `_`),配合 SQL `ESCAPE '\'`:用户搜「50%」「a_b」按字面匹配,
 * 不被当通配符(spec §3.2)。反斜杠自身也一并转义(单次遍历,不会二次放大)。
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 归一历史结果上限到 `[1, DEFAULT_HISTORY_LIMIT]`(spec §3.1 / §5.5):
 * undefined / 非有限 / ≤0 / 超上限 → 兜底 500;小数向下取整。
 */
export function clampHistoryLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_HISTORY_LIMIT
  }
  return Math.min(Math.floor(n), DEFAULT_HISTORY_LIMIT)
}
