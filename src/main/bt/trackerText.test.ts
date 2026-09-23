import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseTrackerText,
  mergeRemoteTrackers,
  isTrackerListQualified,
  MAX_TRACKERS,
  MIN_TRACKERS,
  BT_TRACKER_THROTTLE_MS,
  BT_TRACKER_RETRY_MS
} from './trackerText'
// 节流判定复用既有实现(spec §4.4 ②:不复制实现,只新增窗口常量)
import { shouldCheckNow } from '../update/updateStateStore'

// 控制字符 / BOM 一律用 fromCharCode 构造:直接写进源码不可见,易被编辑器 / diff 吞掉或改写
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const CRLF = CR + LF
const TAB = String.fromCharCode(9)
const BOM = String.fromCharCode(0xfeff)

// ==================== ④ parseTrackerText(v0.4 Task 1 · spec §4.4 / §7.1)====================

test('parseTrackerText: 开头 BOM 被剥除(真实 ngosang 文件形态)', () => {
  const text = BOM + 'udp://a.example.com:6969/announce'
  assert.deepEqual(parseTrackerText(text), ['udp://a.example.com:6969/announce'])
})

test('parseTrackerText: CRLF 换行(Windows 落盘 / 部分源即此形态)', () => {
  const text = ['udp://a.example.com:6969/announce', 'udp://b.example.com:80/announce'].join(CRLF)
  assert.deepEqual(parseTrackerText(text), [
    'udp://a.example.com:6969/announce',
    'udp://b.example.com:80/announce'
  ])
})

test('parseTrackerText: 单 CR 换行(老 Mac 形态,不能只按 \\n 切)', () => {
  const text = ['udp://a.example.com:6969/announce', 'udp://b.example.com:80/announce'].join(CR)
  assert.deepEqual(parseTrackerText(text), [
    'udp://a.example.com:6969/announce',
    'udp://b.example.com:80/announce'
  ])
})

test('parseTrackerText: CRLF / CR / LF 混用', () => {
  const text =
    'udp://a.example.com:6969/announce' +
    CRLF +
    'udp://b.example.com:80/announce' +
    CR +
    'udp://c.example.com:1337/announce' +
    LF +
    'udp://d.example.com:451/announce'
  assert.deepEqual(parseTrackerText(text), [
    'udp://a.example.com:6969/announce',
    'udp://b.example.com:80/announce',
    'udp://c.example.com:1337/announce',
    'udp://d.example.com:451/announce'
  ])
})

test('parseTrackerText: 空行与全空白行被丢弃(ngosang 文件以空行分隔条目)', () => {
  const text = [
    'udp://a.example.com:6969/announce',
    '',
    '   ',
    TAB + ' ' + TAB,
    '',
    'udp://b.example.com:80/announce',
    ''
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), [
    'udp://a.example.com:6969/announce',
    'udp://b.example.com:80/announce'
  ])
})

test('parseTrackerText: # 注释行被丢弃(含缩进后的注释)', () => {
  const text = [
    '# trackers_best.txt',
    '  # 缩进注释(trim 后仍以 # 开头)',
    'udp://a.example.com:6969/announce',
    '#udp://commented-out.example.com:6969/announce'
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), ['udp://a.example.com:6969/announce'])
})

test('parseTrackerText: 行内前后空白被 trim(不带进生效表)', () => {
  const text = [
    '   udp://a.example.com:6969/announce   ',
    TAB + 'udp://b.example.com:80/announce'
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), [
    'udp://a.example.com:6969/announce',
    'udp://b.example.com:80/announce'
  ])
})

test('parseTrackerText: 五种合法 scheme 全保留(udp / http / https / ws / wss)', () => {
  const text = [
    'udp://a.example.com:6969/announce',
    'http://b.example.com:1337/announce',
    'https://c.example.com:443/announce',
    'ws://d.example.com:80/announce',
    'wss://e.example.com:443/announce'
  ].join(LF)
  assert.equal(parseTrackerText(text).length, 5)
})

test('parseTrackerText: 非法 scheme 被丢弃(ftp:// 与裸域名)', () => {
  const text = [
    'ftp://a.example.com:21/announce',
    'tracker.example.com:6969/announce',
    'magnet:?xt=urn:btih:abc',
    'udp://ok.example.com:6969/announce'
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), ['udp://ok.example.com:6969/announce'])
})

test('parseTrackerText: 无 host 被丢弃(不抛异常)', () => {
  const text = [
    'udp://', // 非特殊 scheme:new URL 不抛但 host 为空
    'udp:///announce',
    'http://', // 特殊 scheme:new URL 直接抛 → catch 丢
    'https://',
    'udp://ok.example.com:6969/announce'
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), ['udp://ok.example.com:6969/announce'])
})

test('parseTrackerText: 含逗号的条目被丢弃(S2:防一条注入成两条 / 破坏 --bt-tracker= 结构)', () => {
  const text = [
    'udp://evil.example.com:6969/announce,udp://injected.example.com:80/announce',
    'udp://also,comma.example.com:6969/announce',
    'udp://ok.example.com:6969/announce'
  ].join(LF)
  const parsed = parseTrackerText(text)
  assert.deepEqual(parsed, ['udp://ok.example.com:6969/announce'])
  assert.ok(
    parsed.every((t) => !t.includes(',')),
    '生效表任何条目都不含逗号(join(",") 后仍是 N 条)'
  )
})

test('parseTrackerText: 源内重复去重(大小写不同视为同一条,保留首现原文)', () => {
  const text = [
    'udp://Tracker.Example.com:6969/announce',
    'udp://tracker.example.com:6969/announce',
    '  udp://TRACKER.EXAMPLE.COM:6969/announce  ',
    'udp://other.example.com:80/announce'
  ].join(LF)
  assert.deepEqual(parseTrackerText(text), [
    'udp://Tracker.Example.com:6969/announce',
    'udp://other.example.com:80/announce'
  ])
})

test('parseTrackerText: 全部非法 → 空数组(不抛,交给合格性校验判失败)', () => {
  const text = ['# 只有注释', '', '   ', 'ftp://a.example.com/announce', 'not a url'].join(CRLF)
  assert.deepEqual(parseTrackerText(text), [])
})

test('parseTrackerText: 空字符串 / 纯 BOM → 空数组', () => {
  assert.deepEqual(parseTrackerText(''), [])
  assert.deepEqual(parseTrackerText(BOM), [])
  assert.deepEqual(parseTrackerText(LF + LF + CRLF), [])
})

// ==================== ① mergeRemoteTrackers(spec §4.4 / §7.1)====================

test('mergeRemoteTrackers: 双源合并,best 在 best_ip 之前(域名版优先,IP 版兜底)', () => {
  const best = ['udp://tracker.example.com:6969/announce', 'udp://open.example.com:1337/announce']
  const bestIp = ['udp://93.158.213.92:6969/announce']
  assert.deepEqual(mergeRemoteTrackers([best, bestIp]), [...best, ...bestIp])
})

test('mergeRemoteTrackers: 跨源重复去重(大小写不同视为同一条,保留首现原文)', () => {
  const best = ['udp://Tracker.Example.com:6969/announce']
  const bestIp = ['  udp://tracker.example.com:6969/announce  ', 'udp://1.2.3.4:80/announce']
  assert.deepEqual(mergeRemoteTrackers([best, bestIp]), [
    'udp://Tracker.Example.com:6969/announce',
    'udp://1.2.3.4:80/announce'
  ])
})

test('mergeRemoteTrackers: 超过 100 条截断到 MAX_TRACKERS', () => {
  const many = Array.from({ length: 80 }, (_, i) => `udp://a${i}.example.com:6969/announce`)
  const more = Array.from({ length: 80 }, (_, i) => `udp://b${i}.example.com:6969/announce`)
  const merged = mergeRemoteTrackers([many, more])
  assert.equal(merged.length, MAX_TRACKERS, '截断到 100 条')
  assert.equal(merged[0], 'udp://a0.example.com:6969/announce', '截断保留靠前(高优先)的条目')
  assert.equal(merged[99], 'udp://b19.example.com:6969/announce')
})

test('mergeRemoteTrackers: limit 可覆盖(含 0 / 负数不返回条目)', () => {
  const list = ['udp://a.example.com:6969/announce', 'udp://b.example.com:80/announce']
  assert.deepEqual(mergeRemoteTrackers([list], 1), ['udp://a.example.com:6969/announce'])
  assert.deepEqual(mergeRemoteTrackers([list], 0), [])
  assert.deepEqual(mergeRemoteTrackers([list], -1), [])
})

test('mergeRemoteTrackers: 单源为空 / 两源都空 / 无源 → 不崩', () => {
  const list = ['udp://a.example.com:6969/announce']
  assert.deepEqual(mergeRemoteTrackers([[], list]), list, '首源为空时次源照常并入')
  assert.deepEqual(mergeRemoteTrackers([list, []]), list)
  assert.deepEqual(mergeRemoteTrackers([[], []]), [])
  assert.deepEqual(mergeRemoteTrackers([]), [])
})

// ==================== ③ isTrackerListQualified(spec §4.4 / §7.1)====================

test('isTrackerListQualified: 9 条 → false / 10 条 → true / 11 条 → true / 空 → false', () => {
  const make = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `udp://a${i}.example.com:6969/announce`)
  assert.equal(isTrackerListQualified(make(9)), false, '不足 10 条视同本次失败')
  assert.equal(isTrackerListQualified(make(10)), true)
  assert.equal(isTrackerListQualified(make(11)), true)
  assert.equal(isTrackerListQualified([]), false)
  assert.equal(MIN_TRACKERS, 10, '合格下限即 MIN_TRACKERS')
})

test('isTrackerListQualified: min 可覆盖', () => {
  assert.equal(isTrackerListQualified(['a', 'b'], 2), true)
  assert.equal(isTrackerListQualified(['a', 'b'], 3), false)
})

// ==================== ② shouldCheckNow 复用(两个新窗口的边界)====================

test('shouldCheckNow + BT_TRACKER_THROTTLE_MS:12h 成功节流窗口边界', () => {
  const base = 1_700_000_000_000
  assert.equal(BT_TRACKER_THROTTLE_MS, 12 * 60 * 60 * 1000)
  assert.equal(
    shouldCheckNow(base, base + BT_TRACKER_THROTTLE_MS - 60_000, BT_TRACKER_THROTTLE_MS),
    false,
    '距上次成功 11h59m → 不拉取'
  )
  assert.equal(
    shouldCheckNow(base, base + BT_TRACKER_THROTTLE_MS, BT_TRACKER_THROTTLE_MS),
    true,
    '距上次成功 =12h → 拉取'
  )
  assert.equal(
    shouldCheckNow(0, base, BT_TRACKER_THROTTLE_MS),
    true,
    'updatedAt=0(从未拉取)→ 始终拉取'
  )
})

test('shouldCheckNow + BT_TRACKER_RETRY_MS:30min 失败退避窗口边界(S3)', () => {
  const base = 1_700_000_000_000
  assert.equal(BT_TRACKER_RETRY_MS, 30 * 60 * 1000)
  assert.equal(
    shouldCheckNow(base, base + BT_TRACKER_RETRY_MS - 1, BT_TRACKER_RETRY_MS),
    false,
    '失败后 30min 内不重试(避免每次添加 BT 任务都重来)'
  )
  assert.equal(
    shouldCheckNow(base, base + BT_TRACKER_RETRY_MS, BT_TRACKER_RETRY_MS),
    true,
    '=30min → 可重试'
  )
})
