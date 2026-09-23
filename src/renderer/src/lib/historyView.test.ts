import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_HISTORY_FILTER,
  buildHistoryQuery,
  categoryDisplayName,
  dayEndMs,
  dayStartMs,
  hasActiveFilter,
  statusToTaskStatuses,
  validateCustomRange,
  type HistoryFilterState
} from './historyView'
import type { CategoryConfig } from '../../../shared/ipc'

const filter = (over: Partial<HistoryFilterState> = {}): HistoryFilterState => ({
  ...EMPTY_HISTORY_FILTER,
  ...over
})

// ---- statusToTaskStatuses ----
test('statusToTaskStatuses: 全部 → undefined(不加 status 条件)', () => {
  assert.equal(statusToTaskStatuses('all'), undefined)
})
test('statusToTaskStatuses: 已完成 / 失败 → 单态集合', () => {
  assert.deepEqual(statusToTaskStatuses('completed'), ['completed'])
  assert.deepEqual(statusToTaskStatuses('failed'), ['error'])
})
test('statusToTaskStatuses: 进行中 → 6 个非终态(不含 completed / error)', () => {
  const active = statusToTaskStatuses('active')
  assert.deepEqual(active, [
    'queued',
    'downloading',
    'paused',
    'resolving',
    'awaiting_selection',
    'processing'
  ])
  assert.equal(active?.includes('completed' as never), false)
  assert.equal(active?.includes('error' as never), false)
})

// ---- dayStartMs / dayEndMs ----
test('dayStartMs / dayEndMs: 同日跨度为当天全天(端到端 86399999ms,本地构造一致)', () => {
  const s = dayStartMs('2026-07-01')
  const e = dayEndMs('2026-07-01')
  assert.ok(s !== undefined && e !== undefined)
  assert.equal(e - s, 86_399_999)
  assert.equal(s, new Date(2026, 6, 1, 0, 0, 0, 0).getTime())
  assert.equal(e, new Date(2026, 6, 1, 23, 59, 59, 999).getTime())
})
test('dayStartMs: 空 / 非法 → undefined', () => {
  assert.equal(dayStartMs(''), undefined)
  assert.equal(dayStartMs('abc'), undefined)
  assert.equal(dayStartMs('2026-07'), undefined)
  assert.equal(dayEndMs('2026-13-40x'), undefined)
})
test('dayStartMs / dayEndMs: 不存在的日期判非法 → undefined(防 JS Date 溢出进位,如 6.31→7.1)', () => {
  assert.equal(dayStartMs('2026-06-31'), undefined, '6 月无 31 日')
  assert.equal(dayStartMs('2026-02-30'), undefined, '2 月无 30 日')
  assert.equal(dayEndMs('2026-13-01'), undefined, '无 13 月')
  assert.equal(dayStartMs('2026-04-31'), undefined, '4 月无 31 日')
  // 合法边界:闰年 2.29 有效、平年 2.29 无效、月末正常
  assert.ok(dayStartMs('2024-02-29') !== undefined, '2024 闰年 2.29 有效')
  assert.equal(dayStartMs('2026-02-29'), undefined, '2026 平年无 2.29')
  assert.ok(dayStartMs('2026-02-28') !== undefined, '平年 2.28 有效')
  assert.ok(dayEndMs('2026-12-31') !== undefined, '12.31 有效')
})

// ---- hasActiveFilter ----
test('hasActiveFilter: 默认态 → false', () => {
  assert.equal(hasActiveFilter(EMPTY_HISTORY_FILTER), false)
})
test('hasActiveFilter: 任一非默认 → true(text 空白视为无)', () => {
  assert.equal(hasActiveFilter(filter({ text: '   ' })), false, '纯空白不算筛选')
  assert.equal(hasActiveFilter(filter({ text: 'a' })), true)
  assert.equal(hasActiveFilter(filter({ status: 'completed' })), true)
  assert.equal(hasActiveFilter(filter({ category: 'video' })), true)
  assert.equal(hasActiveFilter(filter({ time: 'today' })), true)
})

// ---- buildHistoryQuery ----
test('buildHistoryQuery: 全默认 → 空对象(返回全部历史)', () => {
  assert.deepEqual(buildHistoryQuery(EMPTY_HISTORY_FILTER), {})
})
test('buildHistoryQuery: text 原样传(空白仍视为无 → 不加)', () => {
  assert.deepEqual(buildHistoryQuery(filter({ text: '风景' })), { text: '风景' })
  assert.deepEqual(buildHistoryQuery(filter({ text: '   ' })), {})
})
test('buildHistoryQuery: status / category 映射', () => {
  assert.deepEqual(buildHistoryQuery(filter({ status: 'failed' })), { status: ['error'] })
  assert.deepEqual(buildHistoryQuery(filter({ category: 'audio' })), { category: 'audio' })
})
test('buildHistoryQuery: time preset(非 custom)只传 preset,不带 from/to', () => {
  assert.deepEqual(buildHistoryQuery(filter({ time: 'week' })), { timePreset: 'week' })
})
test('buildHistoryQuery: custom 追加换算后的 from/to ms(含端点)', () => {
  const q = buildHistoryQuery(filter({ time: 'custom', from: '2026-07-01', to: '2026-07-10' }))
  assert.equal(q.timePreset, 'custom')
  assert.equal(q.from, dayStartMs('2026-07-01'))
  assert.equal(q.to, dayEndMs('2026-07-10'))
})
test('buildHistoryQuery: custom 但日期未填 → 只有 preset,无 from/to(主进程按 now 兜底上界)', () => {
  const q = buildHistoryQuery(filter({ time: 'custom' }))
  assert.deepEqual(q, { timePreset: 'custom' })
})
test('buildHistoryQuery: 组合 AND(text+status+category+time custom)', () => {
  const q = buildHistoryQuery(
    filter({
      text: 'bili',
      status: 'completed',
      category: 'video',
      time: 'custom',
      from: '2026-01-01',
      to: '2026-12-31'
    })
  )
  assert.deepEqual(q, {
    text: 'bili',
    status: ['completed'],
    category: 'video',
    timePreset: 'custom',
    from: dayStartMs('2026-01-01'),
    to: dayEndMs('2026-12-31')
  })
})

// ---- categoryDisplayName ----
const CATS: CategoryConfig[] = [
  { key: 'video', displayName: '影片', extensions: ['mp4'], savePath: 'D:/V', isCustom: false },
  { key: 'audio', displayName: '音频', extensions: ['mp3'], savePath: 'D:/A', isCustom: false }
]
test('categoryDisplayName: 优先 category:list displayName(可改名)', () => {
  assert.equal(categoryDisplayName('video', CATS), '影片')
})
test('categoryDisplayName: 缺 config 时回落静态 6 类文案', () => {
  assert.equal(categoryDisplayName('archive', []), '压缩包')
  assert.equal(categoryDisplayName('other', []), '其他')
})
test('categoryDisplayName: 异常 key 回落原值', () => {
  assert.equal(categoryDisplayName('weird', CATS), 'weird')
})

// ---- validateCustomRange(自定义区间校验:非法日 / 倒置,B5)----
test('validateCustomRange: 起 > 止 → inverted', () => {
  assert.equal(validateCustomRange('2026-07-10', '2026-07-01'), 'inverted')
})
test('validateCustomRange: 起 ≤ 止 / 未填全 → null', () => {
  assert.equal(validateCustomRange('2026-07-01', '2026-07-10'), null)
  assert.equal(validateCustomRange('2026-07-05', '2026-07-05'), null, '同日')
  assert.equal(validateCustomRange('', '2026-07-01'), null, '只填一端')
  assert.equal(validateCustomRange('', ''), null)
})
test('validateCustomRange: 某端非法日期 → invalid(优先于倒置,不再静默;修用户反馈)', () => {
  assert.equal(validateCustomRange('2026-06-31', '2026-07-01'), 'invalid', '起始非法')
  assert.equal(validateCustomRange('2026-07-01', '2026-02-30'), 'invalid', '结束非法')
  assert.equal(
    validateCustomRange('2026-06-31', '2026-06-12'),
    'invalid',
    '非法优先于倒置(6.31→6.12 场景:给 invalid 而非无提示)'
  )
})
