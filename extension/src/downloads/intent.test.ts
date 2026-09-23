/**
 * 接管纯函数单测(v0.4 Task 4 · spec §7.1 X-01 / X-02 / X-03 / X-04 / X-06)。
 *
 * 全部在 Node 里跑:这几个函数不碰 `chrome` / `fetch` / `storage`,故「什么算已接管」
 * 这件判错就是**黑洞**的事,可以逐条断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { CreatedDownload } from '../adapter/browserAdapter'
import {
  DOWNLOAD_FRESH_WINDOW_MS,
  TAKEOVER_TIMEOUT_MS,
  buildIntent,
  buildIntentRequest,
  isLiveDownload,
  isTakenResponse,
  shouldReportIntent
} from './intent'

const PAIRING = { token: 'a'.repeat(64), port: 52330 }

/** 固定「此刻」与对应的 ISO 串 —— 不读真实时钟,判据全靠注入 */
const NOW_MS = Date.parse('2026-08-02T15:04:05.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

function item(overrides: Partial<CreatedDownload> = {}): CreatedDownload {
  return {
    id: 7,
    url: 'https://dl.example.com/setup.exe?token=secret',
    referrer: 'https://page.example.com/downloads',
    danger: 'safe',
    totalBytes: 191_234_567,
    state: 'in_progress',
    startTime: NOW_ISO,
    ...overrides
  }
}

/** 造一条合法的 ok 应答体 */
function okBody(payload: unknown, protocolVersion: unknown = 3): string {
  return JSON.stringify({ ok: true, protocolVersion, payload })
}

// ── X-01 ────────────────────────────────────────────────────────────────────

test('X-01: shouldReportIntent 排除四个 DownLord 下不了的 scheme,http/https 放行', () => {
  for (const url of [
    'blob:https://x.com/9f4b-…',
    'data:text/plain;base64,SGVsbG8=',
    'file:///D:/tmp/a.zip',
    'chrome-extension://abcdef/page.html'
  ]) {
    assert.equal(shouldReportIntent(url), false, `应排除:${url}`)
  }

  for (const url of [
    'https://dl.example.com/a.zip',
    'http://dl.example.com/a.zip',
    'https://example.com/blob:not-a-scheme'
  ]) {
    assert.equal(shouldReportIntent(url), true, `应上报:${url}`)
  }
})

test('X-01: scheme 判定大小写不敏感', () => {
  assert.equal(shouldReportIntent('BLOB:https://x.com/9f4b'), false)
  assert.equal(shouldReportIntent('Data:text/plain,hi'), false)
  assert.equal(shouldReportIntent('FILE:///D:/a.zip'), false)
  assert.equal(shouldReportIntent('Chrome-Extension://abcdef/p.html'), false)
})

// ── X-03(形状即约束)──────────────────────────────────────────────────────

test('X-03: ★ shouldReportIntent 只接受一个参数 —— 扩展侧拿不到配置,决策不可能发生', () => {
  // 加第二个参数(config / 暂停态 / 规则表)当场变红(反向探针 RP-5)。
  // 这不是风格检查:形状一旦允许配置进来,「扩展侧做决策」就从「不可能」退化成「靠自觉」。
  assert.equal(shouldReportIntent.length, 1)
})

// ── X-06 ────────────────────────────────────────────────────────────────────

test('X-06: buildIntent 采 url 不采 finalUrl / 不采 filename,UA 由调用方给', () => {
  const source = {
    ...item(),
    // 这两个字段**根本不在 CreatedDownload 形状里**,这里刻意混进来验证它们不会被采走
    finalUrl: 'https://mirror-3.example.com/setup.exe?sig=EXPIRES-IN-1-DAY',
    filename: ''
  } as CreatedDownload

  const intent = buildIntent(source, 'UA/1.0')

  assert.equal(intent.url, 'https://dl.example.com/setup.exe?token=secret')
  assert.equal(intent.userAgent, 'UA/1.0')
  assert.deepStrictEqual(Object.keys(intent).sort(), [
    'byExtensionId',
    'danger',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
  assert.ok(!('finalUrl' in intent), 'finalUrl 带签名与过期时间、绑定单一镜像(实测④),绝不上报')
  assert.ok(!('filename' in intent), 'onCreated 时刻是空串(实测③),建议名归主进程推断')
})

test('X-06: byExtensionId 只记事实 —— 有就带上,没有就不出现在 wire 上', () => {
  const withExt = buildIntent(item({ byExtensionId: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' }), 'UA/1.0')
  assert.equal(withExt.byExtensionId, 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk')

  const wire = JSON.parse(JSON.stringify(buildIntent(item(), 'UA/1.0'))) as Record<string, unknown>
  assert.ok(!('byExtensionId' in wire), 'undefined 不进 JSON')
})

// ── X-02 ────────────────────────────────────────────────────────────────────

test('X-02: buildIntentRequest —— 回环 URL / token 头 / 信封 / timeoutMs === 1000', () => {
  const request = buildIntentRequest(PAIRING, buildIntent(item(), 'UA/1.0'))

  // 打 127.0.0.1 而**不是** localhost:后者可能解析到 ::1,而服务只绑了 127.0.0.1
  assert.equal(request.url, 'http://127.0.0.1:52330/channel')
  assert.deepStrictEqual(request.headers, {
    'Content-Type': 'application/json',
    'X-DownLord-Token': PAIRING.token
  })
  assert.equal(request.timeoutMs, 1000)
  assert.equal(request.timeoutMs, TAKEOVER_TIMEOUT_MS)

  const envelope = JSON.parse(request.body) as Record<string, unknown>
  assert.deepStrictEqual(Object.keys(envelope), ['type', 'protocolVersion', 'payload'])
  assert.equal(envelope.type, 'download.intent')
  assert.equal(envelope.protocolVersion, 3)
})

test('X-02: ★ 载荷键集合恰为六项 —— 没有 dir / filename / 任意 header map', () => {
  const body = JSON.parse(
    buildIntentRequest(PAIRING, buildIntent(item({ byExtensionId: 'ext-id' }), 'UA/1.0')).body
  ) as { payload: Record<string, unknown> }

  // 全等而非「不含 dir」:多带任何一个字段都当场变红(反向探针 RP-2 在 buildIntent 里加 dir)。
  // 三样刻意没有的东西各有其理由:dir → 落点归主进程;filename → onCreated 时刻是空串;
  // 任意 header map → 协议里没有这个形状,故 Cookie: 无处可塞(headers 白名单第一层)。
  assert.deepStrictEqual(Object.keys(body.payload).sort(), [
    'byExtensionId',
    'danger',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
})

// ── X-04 ────────────────────────────────────────────────────────────────────

test('X-04: isTakenResponse —— 只有 200 + ok + 版本相符 + taken===true 才算受理', () => {
  assert.equal(isTakenResponse(200, okBody({ taken: true })), true)
})

test('X-04: ★ 其余一切 → false(看不懂的应答一律降级到最安全的一侧)', () => {
  const cases: [string, number, string][] = [
    ['非 JSON', 200, '<html>proxy error</html>'],
    ['空体', 200, ''],
    ['ok:false', 200, JSON.stringify({ ok: false, reason: 'protocol_mismatch' })],
    ['版本不符', 200, okBody({ taken: true }, 1)],
    ['版本缺失', 200, JSON.stringify({ ok: true, payload: { taken: true } })],
    ['taken:false', 200, okBody({ taken: false })],
    ["taken:'true' 字符串", 200, okBody({ taken: 'true' })],
    ['缺 payload', 200, JSON.stringify({ ok: true, protocolVersion: 3 })],
    ['payload 不是对象', 200, okBody('taken')],
    ['401 但体看着像成功', 401, okBody({ taken: true })],
    ['409 但体看着像成功', 409, okBody({ taken: true })],
    ['500', 500, okBody({ taken: true })],
    ['204 空成功', 204, '']
  ]

  for (const [label, status, text] of cases) {
    assert.equal(isTakenResponse(status, text), false, `应判不受理:${label}`)
  }
})

// ── X-07:浏览器启动时重放的下载历史必须挡在上报之前(2026-08-02 真机暴露)──────────

test('X-07: state 非 in_progress(历史记录)一律不上报', () => {
  assert.equal(isLiveDownload(item({ state: 'complete' }), NOW_MS), false)
  assert.equal(isLiveDownload(item({ state: 'interrupted' }), NOW_MS), false)
  assert.equal(isLiveDownload(item({ state: '' }), NOW_MS), false)
  // 正常路径:此刻刚开始的下载
  assert.equal(isLiveDownload(item(), NOW_MS), true)
})

test('X-07: state 是 in_progress 但 startTime 很旧(被恢复的旧下载)→ 不上报', () => {
  const oldItem = item({ startTime: new Date(NOW_MS - 6 * 60 * 60 * 1000).toISOString() })
  assert.equal(isLiveDownload(oldItem, NOW_MS), false)
  // 边界:恰好在窗口内 / 恰好越界
  assert.equal(
    isLiveDownload(item({ startTime: new Date(NOW_MS - DOWNLOAD_FRESH_WINDOW_MS).toISOString() }), NOW_MS),
    true
  )
  assert.equal(
    isLiveDownload(
      item({ startTime: new Date(NOW_MS - DOWNLOAD_FRESH_WINDOW_MS - 1).toISOString() }),
      NOW_MS
    ),
    false
  )
})

test('X-07: startTime 解析不出 → 保守判不上报(不上报最坏是浏览器自己下,误上报最坏是重复下载)', () => {
  assert.equal(isLiveDownload(item({ startTime: '' }), NOW_MS), false)
  assert.equal(isLiveDownload(item({ startTime: 'not a date' }), NOW_MS), false)
})
