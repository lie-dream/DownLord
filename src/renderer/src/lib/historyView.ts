/**
 * 历史页筛选纯函数(v0.2 Task 5 · spec §5.2 / §3.1)。
 *
 * 渲染层局部筛选 state → `HistoryQuery` 的纯映射,便于单测。
 * - 时间 preset 口径(今天 / 本周 / 本月)换算集中在主进程 `historyTime.ts`(单一来源,spec §3.1),
 *   此处仅传语义 preset;**不在渲染层算 today/week/month 边界**(避免口径漂移)。
 * - 自定义日期串 → ms 边界(用户显式选的日期,非 preset 口径)在此换算。
 * - 与主列表 `filterTasksByNav` / `filterTasksByCategory` 无关:历史页筛选为页内独立局部态(spec §3.4)。
 */
import type { CategoryConfig, HistoryQuery, TaskStatus } from '../../../shared/ipc'
import type { CategoryFilterKey } from './categoryFilter'
import { categoryLabel } from './categoryView'

/** 状态筛选档(spec §5.2):全部 / 已完成 / 失败 / 进行中 */
export type HistoryStatusKey = 'all' | 'completed' | 'failed' | 'active'
/** 时间筛选档(spec §5.2):全部 / 今天 / 本周 / 本月 / 自定义 */
export type HistoryTimeKey = 'all' | 'today' | 'week' | 'month' | 'custom'

/** 「进行中」= 所有非终态(spec §5.2:queued+downloading+paused+resolving+awaiting_selection+processing) */
const ACTIVE_STATUSES: TaskStatus[] = [
  'queued',
  'downloading',
  'paused',
  'resolving',
  'awaiting_selection',
  'processing'
]

/** 状态档 → `TaskStatus[]`(undefined = 全部状态,不加 status 条件) */
export function statusToTaskStatuses(key: HistoryStatusKey): TaskStatus[] | undefined {
  switch (key) {
    case 'completed':
      return ['completed']
    case 'failed':
      return ['error']
    case 'active':
      return ACTIVE_STATUSES
    default:
      return undefined
  }
}

/** 解析 'YYYY-MM-DD' → [y, m, d];非法(空 / 缺段 / 非数 / 不存在的日期)→ null */
function parseYmd(dateStr: string): [number, number, number] | null {
  const parts = dateStr.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) return null
  const [y, m, d] = parts
  if (!y || !m || !d) return null
  // 回验真实日期:JS Date 对不存在的日期(6.31 / 平年 2.29)会静默进位(→ 7.1 / 3.1),
  // 构造后比对 y/m/d 完全一致才算合法,杜绝边界口径偏差(B5)。
  const probe = new Date(y, m - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null
  return [y, m, d]
}

/** 日期串 → 当日 00:00:00.000 本地 ms(createdAt >= from 下界);空 / 非法 → undefined */
export function dayStartMs(dateStr: string): number | undefined {
  const ymd = parseYmd(dateStr)
  if (!ymd) return undefined
  return new Date(ymd[0], ymd[1] - 1, ymd[2], 0, 0, 0, 0).getTime()
}

/** 日期串 → 当日 23:59:59.999 本地 ms(createdAt <= to 上界,含当天全天);空 / 非法 → undefined */
export function dayEndMs(dateStr: string): number | undefined {
  const ymd = parseYmd(dateStr)
  if (!ymd) return undefined
  return new Date(ymd[0], ymd[1] - 1, ymd[2], 23, 59, 59, 999).getTime()
}

/** 历史页筛选局部态(页内独立,不读写 App 的 nav / categoryFilter) */
export interface HistoryFilterState {
  text: string
  status: HistoryStatusKey
  category: CategoryFilterKey
  time: HistoryTimeKey
  /** 自定义时间下界日期串(仅 time==='custom') */
  from: string
  /** 自定义时间上界日期串(仅 time==='custom') */
  to: string
}

/** 初始 / 清空后的默认筛选态 */
export const EMPTY_HISTORY_FILTER: HistoryFilterState = {
  text: '',
  status: 'all',
  category: 'all',
  time: 'all',
  from: '',
  to: ''
}

/**
 * 是否有任一非默认筛选。空态两子态判定用(spec §5.4):
 * 有筛选 + 无结果 =「无匹配」;无筛选 + 无结果 =「完全无历史」。
 */
export function hasActiveFilter(f: HistoryFilterState): boolean {
  return f.text.trim() !== '' || f.status !== 'all' || f.category !== 'all' || f.time !== 'all'
}

/**
 * 筛选态 → `HistoryQuery`(全部可选,AND 组合;spec §3.1)。
 * text 原样传(主进程 handler 再 trim);status 空档不加;category 具体值才加;
 * time 非「全部」传 preset,custom 追加换算后的 from/to ms。
 */
export function buildHistoryQuery(f: HistoryFilterState): HistoryQuery {
  const q: HistoryQuery = {}
  if (f.text.trim() !== '') q.text = f.text
  const status = statusToTaskStatuses(f.status)
  if (status) q.status = status
  if (f.category !== 'all') q.category = f.category
  if (f.time !== 'all') {
    q.timePreset = f.time
    if (f.time === 'custom') {
      const from = dayStartMs(f.from)
      const to = dayEndMs(f.to)
      if (from !== undefined) q.from = from
      if (to !== undefined) q.to = to
    }
  }
  return q
}

/** 自定义区间校验结果(B5):null=正常 / 'invalid'=某端非法日期 / 'inverted'=起晚于止 */
export type CustomRangeIssue = null | 'invalid' | 'inverted'

/**
 * 自定义区间校验(B5,渲染层内联提示用):
 * - 'invalid':某端**填了但不是存在的日期**(如 6.31 / 平年 2.29,parseYmd 回验判非法)→ 提示重选;
 * - 'inverted':两端均合法但**起始晚于结束**(查询恒空)→ 提示调整;
 * - null:未填 / 只填一端 / 合法且顺序正确。
 * 关键:非法日期给 'invalid' 而非静默,杜绝「6.30 有提示、6.31 反而没提示」的困惑。
 */
export function validateCustomRange(from: string, to: string): CustomRangeIssue {
  const fInvalid = from !== '' && dayStartMs(from) === undefined
  const tInvalid = to !== '' && dayEndMs(to) === undefined
  if (fInvalid || tInvalid) return 'invalid'
  const f = dayStartMs(from)
  const t = dayEndMs(to)
  if (f !== undefined && t !== undefined && f > t) return 'inverted'
  return null
}

/**
 * DB `category` 值 → 显示名:优先 `category:list` 的 displayName(与 chips 同源,Task 8 可改名),
 * 回落静态 `categoryLabel`(6 类),再回落原值(极端异常 key)。
 */
export function categoryDisplayName(cat: string, categories: CategoryConfig[]): string {
  const found = categories.find((c) => c.key === cat)
  if (found) return found.displayName
  const known = ['video', 'audio', 'archive', 'document', 'program', 'other']
  if (known.includes(cat)) return categoryLabel(cat as CategoryFilterKey)
  return cat
}
