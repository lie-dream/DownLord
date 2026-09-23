/**
 * `toOfferedCookies` 单测(**N12**,v0.4 Task 6 Phase 3 · spec §3.2)。
 *
 * 守两条最容易被「顺手清理一下」改掉的事:
 * **① `domain` 的前导点原样保留**(协议里刻意没有 `hostOnly`,那个点就是它);
 * **② 不做内容过滤** —— httpOnly 与 session cookie 全都要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserCookie } from '../adapter/browserAdapter'
import { toOfferedCookies } from './cookieCollect'

function cookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'SESSDATA',
    value: 'abc%2Cdef',
    domain: '.example.com',
    path: '/',
    expirationDate: 1_800_000_000.512,
    secure: true,
    httpOnly: true,
    ...overrides
  }
}

test('N12 字段搬运:七字段逐字进 wire 形态,expires 取整(浏览器给的是小数秒)', () => {
  assert.deepStrictEqual(toOfferedCookies([cookie()]), [
    {
      name: 'SESSDATA',
      value: 'abc%2Cdef',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expires: 1_800_000_000
    }
  ])
})

test('N12 ★ 前导点原样保留 —— 协议里没有 hostOnly,那个点就是它', () => {
  const [dotted] = toOfferedCookies([cookie({ domain: '.example.com' })])
  const [bare] = toOfferedCookies([cookie({ domain: 'example.com' })])

  assert.equal(dotted?.domain, '.example.com', '归一掉这个点,主进程侧的 includeSubdomains 列会全算错')
  assert.equal(bare?.domain, 'example.com', 'host-only 的那条同样原样')
})

test('N12 ★ 不做内容过滤:httpOnly 与 session cookie 全都要', () => {
  const offered = toOfferedCookies([
    cookie({ name: 'a', httpOnly: true }),
    cookie({ name: 'b', httpOnly: false }),
    // session cookie:浏览器不给 expirationDate
    cookie({ name: 'c', expirationDate: undefined })
  ])

  assert.deepStrictEqual(
    offered.map((one) => one.name),
    ['a', 'b', 'c'],
    '登录 cookie 几乎恒为 httpOnly,不取等于白取;会话 cookie 同理'
  )
  assert.equal(offered[2] && 'expires' in offered[2], false, 'session cookie **省略** expires 这个键')
})

test('N12 secure / httpOnly 是布尔原样,不折成字符串(RP-3 那类改动在主进程侧,这里先不许出错)', () => {
  const [one] = toOfferedCookies([cookie({ secure: false, httpOnly: false })])
  assert.equal(one?.secure, false)
  assert.equal(one?.httpOnly, false)
})

test('N12 非正 / 非有限的到期时刻 → 当 session cookie(而不是写一个 1970 年的已过期时间戳)', () => {
  for (const expirationDate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const [one] = toOfferedCookies([cookie({ expirationDate })])
    assert.equal(one && 'expires' in one, false, `expirationDate=${String(expirationDate)} 该当 session`)
  }
})

test('N12 宽进严取:形状不合的条目整条跳过,不补默认值、也不带崩其余条目', () => {
  const bad = [
    cookie({ name: '' }),
    cookie({ domain: '' }),
    cookie({ path: '' }),
    { ...cookie(), value: undefined } as unknown as BrowserCookie,
    { ...cookie(), secure: 'true' } as unknown as BrowserCookie,
    { ...cookie(), httpOnly: 1 } as unknown as BrowserCookie
  ]
  assert.deepStrictEqual(toOfferedCookies(bad), [], '一条都不许蒙混过关')

  const mixed = toOfferedCookies([cookie({ name: '' }), cookie({ name: 'ok' })])
  assert.deepStrictEqual(
    mixed.map((one) => one.name),
    ['ok'],
    '坏的那条跳过,好的照搬'
  )
})

test('N12 空值是合法的(站点用空值清 cookie),不许被当作坏数据丢掉', () => {
  const [one] = toOfferedCookies([cookie({ value: '' })])
  assert.equal(one?.value, '')
})

test('N12 空输入 → 空输出(「这个域没有 cookie」是一个事实,不是错误)', () => {
  assert.deepStrictEqual(toOfferedCookies([]), [])
})
