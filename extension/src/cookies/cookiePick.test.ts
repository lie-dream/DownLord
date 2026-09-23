/**
 * `pickCookieUrls` 单测(**N4**,v0.4 Task 6 Phase 3 · spec §3.3)。
 *
 * ★ 这里测的**不是便利函数,是安全边界**:反向探针 RP-4 就是把 `pickCookieUrls` 改成
 *   直接返回全部候选 —— 若本文件的用例挡不住那一改,spec §7.3 那半段威胁论证就是空的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickCookieUrls } from './cookiePick'

const PAGE = 'https://www.example.com/watch?v=abc'

test('N4 命中:点名的 host 与候选同 host → 采纳那条候选(甲路径:候选恰好 [pageUrl])', () => {
  assert.deepStrictEqual(pickCookieUrls(['www.example.com'], [PAGE]), [PAGE])
})

test('N4 ★ 点名未上报的域 → 空 —— 即使应答被伪造成 ["bank.com"],扩展手里也没有那个域的候选', () => {
  assert.deepStrictEqual(pickCookieUrls(['bank.com'], [PAGE]), [])
  // 掺在真实点名里一起来,同样只采纳上报过的那一个
  assert.deepStrictEqual(pickCookieUrls(['bank.com', 'www.example.com'], [PAGE]), [PAGE])
})

test('N4 不做后缀 / 父域匹配 —— 与主进程侧同一把尺子(没有 PSL 就分不清 a.github.io 与 b.github.io)', () => {
  assert.deepStrictEqual(pickCookieUrls(['example.com'], [PAGE]), [], '父域不许命中子域候选')
  assert.deepStrictEqual(
    pickCookieUrls(['a.www.example.com'], [PAGE]),
    [],
    '子域不许命中父域候选'
  )
  assert.deepStrictEqual(
    pickCookieUrls(['ww.example.com'], [PAGE]),
    [],
    '后缀相似同样不算命中'
  )
})

test('N4 大小写 host 两侧都归一(DNS 本就大小写不敏感;这不是放宽域匹配)', () => {
  const upper = 'https://WWW.Example.COM/watch'
  assert.deepStrictEqual(pickCookieUrls(['www.example.com'], [upper]), [upper])
  assert.deepStrictEqual(pickCookieUrls(['WWW.EXAMPLE.COM'], [PAGE]), [PAGE])
  assert.deepStrictEqual(pickCookieUrls(['  www.example.com  '], [PAGE]), [PAGE], '两端空白也归一')
})

test('N4 非法 candidate 跳过 —— 一个坏字符串不许带崩整条路径', () => {
  const good = 'https://cdn.example/av.m3u8'
  assert.deepStrictEqual(pickCookieUrls(['cdn.example'], ['不是 URL', good]), [good])
  assert.deepStrictEqual(pickCookieUrls(['cdn.example'], ['', 'http://']), [])
})

test('N4 非 http(s) 候选不参与匹配(受限页地址本就读不到,谈不上「会被发往该 URL 的 cookie」)', () => {
  assert.deepStrictEqual(pickCookieUrls(['settings'], ['edge://settings']), [])
  assert.deepStrictEqual(pickCookieUrls([''], ['about:blank']), [])
})

test('N4 丙路径:[url, referrer] 同 host 时只回一条,且取前者(那才是真正要下的地址)', () => {
  const url = 'https://cdn.example/seg.m3u8'
  const referrer = 'https://cdn.example'
  assert.deepStrictEqual(pickCookieUrls(['cdn.example'], [url, referrer]), [url])
})

test('N4 丙路径:两个 host 各命中一条,顺序跟点名走(上界 2 由主进程侧守)', () => {
  const url = 'https://cdn.example/seg.m3u8'
  const referrer = 'https://page.example'
  assert.deepStrictEqual(pickCookieUrls(['page.example', 'cdn.example'], [url, referrer]), [
    referrer,
    url
  ])
})

test('N4 点名重复同一个 host → 只回一条(不重复读同一域)', () => {
  assert.deepStrictEqual(pickCookieUrls(['www.example.com', 'www.example.com'], [PAGE]), [PAGE])
})

test('N4 端口参与匹配 —— 与主进程侧 `new URL(url).host` 同一把尺子', () => {
  const withPort = 'https://media.example:8443/v.mp4'
  assert.deepStrictEqual(pickCookieUrls(['media.example:8443'], [withPort]), [withPort])
  assert.deepStrictEqual(pickCookieUrls(['media.example'], [withPort]), [], '去掉端口就不是同一个 host')
})

test('N4 空点名 / 空候选 / 空串名字 → 空(不崩)', () => {
  assert.deepStrictEqual(pickCookieUrls([], [PAGE]), [])
  assert.deepStrictEqual(pickCookieUrls(['www.example.com'], []), [])
  assert.deepStrictEqual(pickCookieUrls(['', '   '], [PAGE]), [])
})
