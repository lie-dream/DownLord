import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_COOKIE_HOSTS, needCookieForOf, resolveCookieHosts } from './cookieDomains'
import type { CookieSource } from '../../shared/ipc'

/**
 * N3 —— 点名域推导(spec §8.1):
 * 去重 / 无 referrer / 非法 URL / 长度恒 ≤2 / **档位非 extension 恒 `[]`** / `taken === false` 恒 `[]`。
 */

// ==================== resolveCookieHosts ====================

test('N3 resolveCookieHosts 无 referrer → 只出 url 的 host', () => {
  assert.deepEqual(resolveCookieHosts('https://www.bilibili.com/video/BV1'), ['www.bilibili.com'])
})

test('N3 resolveCookieHosts referrer host 不同 → 追加,保序(url 在前)', () => {
  assert.deepEqual(
    resolveCookieHosts('https://cdn.example.net/a.m3u8', 'https://www.bilibili.com/video/BV1'),
    ['cdn.example.net', 'www.bilibili.com']
  )
})

test('N3 resolveCookieHosts referrer host 相同 → 去重,只剩一项', () => {
  assert.deepEqual(
    resolveCookieHosts('https://www.bilibili.com/video/BV1', 'https://www.bilibili.com/'),
    ['www.bilibili.com']
  )
})

test('N3 resolveCookieHosts host 含端口 → 端口是 host 的一部分,不归一掉', () => {
  assert.deepEqual(resolveCookieHosts('http://127.0.0.1:18091/probe/a.mp4'), ['127.0.0.1:18091'])
})

test('N3 resolveCookieHosts 非法 url 跳过、合法 referrer 仍生效', () => {
  assert.deepEqual(resolveCookieHosts('not a url', 'https://www.example.com/p'), [
    'www.example.com'
  ])
})

test('N3 resolveCookieHosts 非法 referrer 跳过、合法 url 仍生效', () => {
  assert.deepEqual(resolveCookieHosts('https://www.example.com/p', 'javascript:void(0)'), [
    'www.example.com'
  ])
})

test('N3 resolveCookieHosts 全非法 → []', () => {
  assert.deepEqual(resolveCookieHosts('not a url', 'also not a url'), [])
  assert.deepEqual(resolveCookieHosts(''), [])
})

test('N3 resolveCookieHosts 长度恒 ≤ 2(R8 不批量的硬边界)', () => {
  assert.equal(MAX_COOKIE_HOSTS, 2)
  const cases: [string, string | undefined][] = [
    ['https://a.example.com/x', undefined],
    ['https://a.example.com/x', 'https://b.example.com/y'],
    ['https://a.example.com/x', 'https://a.example.com/y'],
    ['bad', 'https://b.example.com/y']
  ]
  for (const [url, referrer] of cases) {
    assert.ok(resolveCookieHosts(url, referrer).length <= MAX_COOKIE_HOSTS)
  }
})

// ==================== needCookieForOf —— 档位闸门(R10)====================

const URLS = ['https://www.bilibili.com/video/BV1', 'https://passport.bilibili.com/']

test('N3 needCookieForOf source 非 extension → 恒 [](没选第四档 = 零外泄)', () => {
  // 合法档位:另外三档一个都不许放行
  for (const source of ['none', 'browser', 'file'] as const) {
    assert.deepEqual(needCookieForOf(source, true, URLS), [], `source=${source} 必须恒 []`)
  }

  // ★ 相似串:`source` 自 Phase 2 起是 `CookieSource`,故这几个值在**编译期**就进不来 ——
  //   这里用 `as` 强转把它们塞进去,证明**运行时那道全等判据也还在**(类型能被绕过,值比较不能)。
  for (const bogus of ['', 'Extension', 'extension2', 'extension ']) {
    assert.deepEqual(
      needCookieForOf(bogus as CookieSource, true, URLS),
      [],
      `source=${bogus} 必须恒 [](大小写敏感、无前缀匹配)`
    )
  }
})

test('N3 needCookieForOf taken === false → 恒 []', () => {
  assert.deepEqual(needCookieForOf('extension', false, URLS), [])
})

test('N3 needCookieForOf 第四档 + taken → 推出域(正向对照:上两条的 [] 不是因为函数恒空)', () => {
  assert.deepEqual(needCookieForOf('extension', true, URLS), [
    'www.bilibili.com',
    'passport.bilibili.com'
  ])
})

test('N3 needCookieForOf 去重、跳过 undefined 与非法项、上界 2', () => {
  assert.deepEqual(
    needCookieForOf('extension', true, [
      'https://a.example.com/1',
      undefined,
      'not a url',
      'https://a.example.com/2',
      'https://b.example.com/3',
      'https://c.example.com/4'
    ]),
    ['a.example.com', 'b.example.com']
  )
})

test('N3 needCookieForOf 全非法 / 空清单 → []', () => {
  assert.deepEqual(needCookieForOf('extension', true, []), [])
  assert.deepEqual(needCookieForOf('extension', true, [undefined, 'nope']), [])
})

// —— #75 只改变已借快照的消费匹配,不扩张向扩展点名 ——

test('#75 点名仍为 URL.host 原值,不展开 www 别名', () => {
  assert.deepEqual(resolveCookieHosts('https://example.com/watch'), ['example.com'])
  assert.deepEqual(resolveCookieHosts('https://www.example.com/watch'), ['www.example.com'])
  assert.deepEqual(
    resolveCookieHosts('https://example.com/watch', 'https://www.example.com/referrer'),
    ['example.com', 'www.example.com']
  )
  assert.deepEqual(needCookieForOf('extension', true, ['https://example.com/watch']), [
    'example.com'
  ])
})

test('#75 点名保留非默认端口且不放宽非 extension / 未 taken 闸门', () => {
  const urls = ['https://www.example.com:8443/watch', 'https://example.com:9443/referrer']
  assert.deepEqual(resolveCookieHosts(urls[0], urls[1]), [
    'www.example.com:8443',
    'example.com:9443'
  ])
  for (const source of ['none', 'browser', 'file'] as const) {
    assert.deepEqual(needCookieForOf(source, true, urls), [])
  }
  assert.deepEqual(needCookieForOf('extension', false, urls), [])
  assert.deepEqual(needCookieForOf('extension', true, urls), [
    'www.example.com:8443',
    'example.com:9443'
  ])
})
