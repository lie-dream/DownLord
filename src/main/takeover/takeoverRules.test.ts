/**
 * 接管终裁与归一单测(U-01~U-06;v0.4 Task 4 · spec §7.1)。
 *
 * 全是纯函数:不起服务、不建窗口、不碰时钟 —— `now` 由用例直接传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DownloadIntent, SniffAddSelected } from '../../shared/extensionProtocol'
import {
  decideTakeover,
  isExcludedDomain,
  normalizeIntent,
  normalizeSniffIntent,
  type NormalizedIntent
} from './takeoverRules'
import { DEFAULT_TAKEOVER_CONFIG, type TakeoverConfig } from './takeoverConfig'

const NOW = 1_700_000_000_000

function payload(overrides: Partial<DownloadIntent> = {}): DownloadIntent {
  return {
    url: 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe?sign=abc',
    referrer: 'https://uu.163.com/',
    danger: 'safe',
    totalBytes: 192_000_000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...overrides
  }
}

function intent(overrides: Partial<NormalizedIntent> = {}): NormalizedIntent {
  const base = normalizeIntent(payload())
  assert.ok(base)
  return { ...base, ...overrides }
}

function config(overrides: Partial<TakeoverConfig> = {}): TakeoverConfig {
  return { ...DEFAULT_TAKEOVER_CONFIG, ...overrides }
}

// ── U-01:四道**按序**短路 ────────────────────────────────────────────────

test('U-01 enabled:false 最先短路 —— 即便同时暂停 / 命中例外 / danger 非 safe,why 也恒是 disabled', () => {
  const verdict = decideTakeover(
    intent({ danger: 'uncommon', host: 'evil.com' }),
    config({ enabled: false, pausedUntil: NOW + 60_000, excludedDomains: ['evil.com'] }),
    NOW
  )
  assert.deepEqual(verdict, { taken: false, why: 'disabled' })
})

test('U-01 第二道 paused 早于域名例外与 danger', () => {
  const verdict = decideTakeover(
    intent({ danger: 'uncommon', host: 'evil.com' }),
    config({ pausedUntil: NOW + 1, excludedDomains: ['evil.com'] }),
    NOW
  )
  assert.equal(verdict.why, 'paused')
})

test('U-01 第三道 domain_excluded 早于 danger', () => {
  const verdict = decideTakeover(
    intent({ danger: 'uncommon', host: 'evil.com' }),
    config({ excludedDomains: ['evil.com'] }),
    NOW
  )
  assert.equal(verdict.why, 'domain_excluded')
})

// ── U-02:暂停到期 ──────────────────────────────────────────────────────

test('U-02 暂停中不接管;同一 config 换 now 到期后接管', () => {
  const paused = config({ pausedUntil: NOW + 60_000 })
  assert.deepEqual(decideTakeover(intent(), paused, NOW), { taken: false, why: 'paused' })
  assert.deepEqual(decideTakeover(intent(), paused, NOW + 60_001), { taken: true })
})

// ── U-03:域名例外匹配 ───────────────────────────────────────────────────

test('U-03 精确匹配 ✅ / 子域 ✅ / 非后缀 ❌ / 大小写不敏感 / 空表恒 false', () => {
  assert.equal(isExcludedDomain('a.com', ['a.com']), true)
  assert.equal(isExcludedDomain('x.a.com', ['a.com']), true)
  assert.equal(isExcludedDomain('x.y.a.com', ['a.com']), true)
  // ★ 后缀匹配必须带那个点:xa.com 不是 a.com 的子域
  assert.equal(isExcludedDomain('xa.com', ['a.com']), false)
  assert.equal(isExcludedDomain('a.com.cn', ['a.com']), false)
  assert.equal(isExcludedDomain('A.COM', ['a.com']), true)
  assert.equal(isExcludedDomain('x.a.com', ['A.CoM']), true)
  assert.equal(isExcludedDomain('a.com', []), false)
  // 空白条目不当成「匹配一切」
  assert.equal(isExcludedDomain('a.com', ['', '   ']), false)
})

// ── U-04:danger 那道 ────────────────────────────────────────────────────

test('U-04 danger !== safe → 不接管;danger === safe → 接管', () => {
  assert.deepEqual(decideTakeover(intent({ danger: 'uncommon' }), config(), NOW), {
    taken: false,
    why: 'danger'
  })
  assert.deepEqual(decideTakeover(intent({ danger: 'dangerous' }), config(), NOW), {
    taken: false,
    why: 'danger'
  })
  // 空串(浏览器没给)同样不接管 —— 判据是「恰好已经判出 safe」,不是「没说危险就抢」
  assert.equal(decideTakeover(intent({ danger: '' }), config(), NOW).taken, false)
  assert.deepEqual(decideTakeover(intent({ danger: 'safe' }), config(), NOW), { taken: true })
})

// ── U-05:暂停边界 —— 已随 `isTakeoverPaused` 迁往 `pauseState.test.ts`(spec §5.3 定的新家)

// ── U-06:归一 ──────────────────────────────────────────────────────────

test('U-06 非法 URL / 无 host / 非 http(s) scheme → null(判不接管)', () => {
  assert.equal(normalizeIntent(payload({ url: 'not a url' })), null)
  assert.equal(normalizeIntent(payload({ url: '' })), null)
  assert.equal(normalizeIntent(payload({ url: 'file:///C:/x.exe' })), null)
  assert.equal(normalizeIntent(payload({ url: 'blob:https://a.com/uuid' })), null)
  assert.equal(normalizeIntent(payload({ url: 'data:text/plain,hi' })), null)
})

test('U-06 http / https 正常出 host(含端口),且字段被裁剪到判定所需', () => {
  const httpOne = normalizeIntent(payload({ url: 'http://a.com:8080/x.zip?k=v' }))
  assert.equal(httpOne?.host, 'a.com:8080')
  const one = normalizeIntent(payload())
  assert.ok(one)
  assert.deepEqual(Object.keys(one).sort(), [
    'danger',
    'host',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
  // url 原样保留(302 交给 aria2 跟随);host 是解析结论
  assert.equal(one.url, payload().url)
  assert.equal(one.host, 'uu.gdl.netease.com')
})

test('U-06 totalBytes 非有限值一律当未知(0);-1 原样保留(确认框据此不渲染大小)', () => {
  assert.equal(normalizeIntent(payload({ totalBytes: Number.NaN }))?.totalBytes, 0)
  assert.equal(normalizeIntent(payload({ totalBytes: -1 }))?.totalBytes, -1)
  assert.equal(normalizeIntent(payload({ totalBytes: 123 }))?.totalBytes, 123)
})

// ── v0.4 Task 5:嗅探载荷的归一(U-29)────────────────────────────────────────

function sniff(overrides: Partial<SniffAddSelected> = {}): SniffAddSelected {
  return {
    url: 'https://cdn.example.com/hls/index.m3u8?token=abc',
    contentType: 'application/vnd.apple.mpegurl',
    referrer: 'https://page.example.com',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
    totalBytes: -1,
    ...overrides
  }
}

test('U-29 normalizeSniffIntent:正常载荷 → host 解析 + 字段裁剪(六键,不多不少)', () => {
  const one = normalizeSniffIntent(sniff())
  assert.ok(one)
  assert.deepStrictEqual(Object.keys(one).sort(), [
    'danger',
    'host',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
  assert.equal(one.url, sniff().url, 'url 原样保留(不剥 query)')
  assert.equal(one.host, 'cdn.example.com')
  assert.equal(one.referrer, 'https://page.example.com')
  // ★ `danger` 恒为空串 —— 它是 chrome.downloads 的字段,**嗅探路径根本没有它**;
  //   刻意不伪造成 'safe'(那会让「这条是安全的」看起来像有依据,而它没有)
  assert.equal(one.danger, '')
  // -1(未知)原样保留:只供确认框显示,`<= 0` 时不渲染大小胶囊
  assert.equal(one.totalBytes, -1)
})

test('U-29 normalizeSniffIntent:解析不出 host / 非 http(s) 一律 null(主进程独立复核)', () => {
  // 通道对本机任意程序开放,不能把「扩展筛过了」当成前提
  assert.equal(normalizeSniffIntent(sniff({ url: 'not a url' })), null)
  assert.equal(normalizeSniffIntent(sniff({ url: '' })), null)
  assert.equal(normalizeSniffIntent(sniff({ url: 'file:///C:/secret.txt' })), null)
  assert.equal(normalizeSniffIntent(sniff({ url: 'ftp://x.com/a.mp4' })), null)
  assert.equal(normalizeSniffIntent(sniff({ url: 'javascript:alert(1)' })), null)
  assert.equal(normalizeSniffIntent(sniff({ url: 'magnet:?xt=urn:btih:abc' })), null)
  // 反向对照:http / https 两种都放行(否则上面几条恒绿)
  assert.ok(normalizeSniffIntent(sniff({ url: 'http://cdn.x/a.mp4' })))
  assert.ok(normalizeSniffIntent(sniff({ url: 'https://cdn.x/a.mp4' })))
})

test('U-29 normalizeSniffIntent:totalBytes 非有限值当未知(0);字段类型不对时回落空串', () => {
  assert.equal(normalizeSniffIntent(sniff({ totalBytes: Number.NaN }))?.totalBytes, 0)
  assert.equal(normalizeSniffIntent(sniff({ totalBytes: Number.POSITIVE_INFINITY }))?.totalBytes, 0)
  assert.equal(normalizeSniffIntent(sniff({ totalBytes: 88_000_000 }))?.totalBytes, 88_000_000)
  // 形状守卫在 channelDispatch,这里是纵深:即使被绕过也不让非字符串流进确认框
  const weird = normalizeSniffIntent({ ...sniff(), referrer: 7 as never, userAgent: null as never })
  assert.equal(weird?.referrer, '')
  assert.equal(weird?.userAgent, '')
})

test('★ normalizeSniffIntent 不带 contentType 出来 —— 分流是 classifySniffed 的活,不混进归一', () => {
  const one = normalizeSniffIntent(sniff())
  assert.equal('contentType' in (one as object), false)
  assert.equal('kind' in (one as object), false)
})
