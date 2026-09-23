/**
 * historyTime 纯函数单测(v0.2 Task 5 · spec §8.1「纯函数」)。
 *
 * 全部注入固定 `now`;期望值用**独立**方法计算(周一起始用回退循环 vs 生产的 (day+6)%7 算术),
 * 且经本地时区构造 `new Date(y, m, d, ...)`,故时区无关、不硬编码某日星期几。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_HISTORY_LIMIT,
  clampHistoryLimit,
  escapeLike,
  resolveTimeRange,
  statWindowStarts
} from './historyTime'

// —— 独立期望值(与生产实现不同路径,构成真实断言)——
function expDayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function expWeekStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  while (d.getDay() !== 1) {
    d.setDate(d.getDate() - 1) // 逐日回退到周一
  }
  return d.getTime()
}
function expMonthStart(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

// 若干代表性时刻(含周日、月初、跨月边界),本地时区构造
const SAMPLES = [
  new Date(2026, 6, 15, 14, 30, 45, 123).getTime(), // 2026-07-15
  new Date(2026, 6, 12, 0, 0, 0, 0).getTime(), // 周日(若逢周日,周一回退 6 天)
  new Date(2026, 0, 1, 23, 59, 59, 999).getTime(), // 年初/月初当天
  new Date(2026, 2, 3, 8, 0, 0, 0).getTime() // 月初后数日
]

test('resolveTimeRange: today/week/month 下界正确、上界=now(注入固定 now)', () => {
  for (const now of SAMPLES) {
    assert.deepEqual(resolveTimeRange('today', undefined, undefined, now), {
      from: expDayStart(now),
      to: now
    })
    assert.deepEqual(resolveTimeRange('week', undefined, undefined, now), {
      from: expWeekStart(now),
      to: now
    })
    assert.deepEqual(resolveTimeRange('month', undefined, undefined, now), {
      from: expMonthStart(now),
      to: now
    })
    // 起始应 <= now 且时分秒清零
    assert.ok(expWeekStart(now) <= now)
    assert.equal(new Date(expWeekStart(now)).getDay(), 1, '周起始为周一')
    assert.equal(new Date(expWeekStart(now)).getHours(), 0)
  }
})

test('resolveTimeRange: custom 透传 from/to;无 preset → 空区间', () => {
  const now = SAMPLES[0]
  assert.deepEqual(resolveTimeRange('custom', 100, 200, now), { from: 100, to: 200 })
  assert.deepEqual(resolveTimeRange('custom', undefined, undefined, now), {
    from: undefined,
    to: undefined
  })
  assert.deepEqual(resolveTimeRange(undefined, 100, 200, now), {})
})

test('statWindowStarts: today/week(周一)/month(月初)与 resolveTimeRange 同口径', () => {
  for (const now of SAMPLES) {
    const w = statWindowStarts(now)
    assert.equal(w.todayStart, expDayStart(now))
    assert.equal(w.weekStart, expWeekStart(now))
    assert.equal(w.monthStart, expMonthStart(now))
    // 与 resolveTimeRange 同口径(单一来源不漂移)
    assert.equal(w.todayStart, resolveTimeRange('today', undefined, undefined, now).from)
    assert.equal(w.weekStart, resolveTimeRange('week', undefined, undefined, now).from)
    assert.equal(w.monthStart, resolveTimeRange('month', undefined, undefined, now).from)
    // 层级关系:weekStart <= todayStart <= now(monthStart 不必 <= weekStart:
    // 月初那周的周一可落在上月,如 2026-01-01 周四 → weekStart=2025-12-29 < monthStart)
    assert.ok(w.weekStart <= w.todayStart)
    assert.ok(w.todayStart <= now)
  }
})

test('escapeLike: 转义 \\ % _;无特殊字符原样(幂等/稳定)、空串安全', () => {
  assert.equal(escapeLike('abc'), 'abc')
  assert.equal(escapeLike(''), '')
  assert.equal(escapeLike('中文文件名'), '中文文件名')
  assert.equal(escapeLike('50%'), '50\\%')
  assert.equal(escapeLike('a_b'), 'a\\_b')
  assert.equal(escapeLike('a\\b'), 'a\\\\b')
  assert.equal(escapeLike('%_\\'), '\\%\\_\\\\')
  // 稳定:同输入恒同输出
  assert.equal(escapeLike('a%b_c\\d'), escapeLike('a%b_c\\d'))
  // 无特殊字符幂等(再套一层不变)
  assert.equal(escapeLike(escapeLike('plain')), 'plain')
})

test('clampHistoryLimit: undefined/≤0/非有限/超上限 → 500;正常值/小数向下取整', () => {
  assert.equal(DEFAULT_HISTORY_LIMIT, 500)
  assert.equal(clampHistoryLimit(undefined), 500)
  assert.equal(clampHistoryLimit(0), 500)
  assert.equal(clampHistoryLimit(-5), 500)
  assert.equal(clampHistoryLimit(Number.NaN), 500)
  assert.equal(clampHistoryLimit(Number.POSITIVE_INFINITY), 500)
  assert.equal(clampHistoryLimit(9999), 500)
  assert.equal(clampHistoryLimit(500), 500)
  assert.equal(clampHistoryLimit(1), 1)
  assert.equal(clampHistoryLimit(250), 250)
  assert.equal(clampHistoryLimit(10.7), 10)
})
