/**
 * **I-C7** —— 暂借登录态三条 IPC 的**返回值形状**(v0.4 Task 6 · spec §6.4 / §7.1 红线 R3)。
 *
 * ★ **这一条补的是收口 review §10.2 发现的缺口**:spec §8.2 列了 I-C7「渲染层零 cookie 类型」,
 *   但它此前**从未落成用例** —— 全仓搜 `I-C7` 只命中一句注释。而与它配套的 A-3 grep 判据
 *   (`grep "OfferedCookie\|BorrowedCookie\|CookieOffer" src/renderer/` 期望零命中)在 HEAD 上
 *   **恒红**:`BorrowedCookie` 是 IPC 类型名 `BorrowedCookieHosts` 的子串,而后者恰恰是
 *   「让渲染层拿不到值」的解药。两条声称在守 R3 的断言,一条都没在守。
 *
 * ⚠️ **为什么落在主进程侧而不是渲染层**:「渲染层拿不到 cookie 值」在**运行时根本不可断言** ——
 *   TS 类型运行时不存在,照 spec 字面写一条「渲染层零 cookie 类型」的用例只会造出假的安全感。
 *   真正能变红的是**这一侧**:主进程往返回值里多塞一个字段,下面的断言当场红。
 *
 * **边界(如实标注,不夸大)**:本文件守的是「返回对象的**键集**恰好是 `{hosts}`」。
 * 「`hosts` 数组里装的是 host 而不是 cookie 值」由 `BorrowedCookieHosts.hosts: string[]`
 * 与持有层 `hosts()` 的实现(N2 有断言)保证,**不由本文件守**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCookieIpcHandlers } from './cookie'
import { createBorrowedCookieStore } from '../video/borrowedCookieStore'
import type { OfferedCookie } from '../../shared/extensionProtocol'

/** 一条**带真值**的 cookie —— 持有层里必须真有东西,否则「没泄漏」可能只是「压根没数据」 */
const SENTINEL: OfferedCookie = {
  name: 'SESSDATA',
  value: 'SENTINEL-COOKIE-VALUE-7b3e',
  domain: '.bilibili.com',
  path: '/',
  expires: 1800000000,
  secure: true,
  httpOnly: true
}

/** 断言一个快照的**键集恰好**是 `['hosts']`(抽成函数,好让正向对照用**同一个**断言) */
function assertOnlyHostsKey(snapshot: object): void {
  assert.deepStrictEqual(
    Object.keys(snapshot),
    ['hosts'],
    `快照除 hosts 外不许有任何键,实得 ${JSON.stringify(Object.keys(snapshot))}`
  )
}

function makeHarness(): ReturnType<typeof createCookieIpcHandlers> {
  const store = createBorrowedCookieStore()
  // 前置:持有层里**真有**一份带值的登录态
  store.offer('www.bilibili.com', [SENTINEL])
  store.offer('passport.bilibili.com', [SENTINEL])
  return createCookieIpcHandlers({ borrowedCookies: store })
}

test('I-C7 ★ getBorrowedHosts 的返回值**键集恰好 {hosts}** —— 渲染层没有装 cookie 值的位置', () => {
  const handlers = makeHarness()
  const snapshot = handlers.getBorrowedHosts()

  assertOnlyHostsKey(snapshot)
  // 正向对照:持有层此刻**确实有**两个域的真数据 —— 否则「只有 hosts」可能只是因为什么都没有
  assert.deepStrictEqual(snapshot.hosts, ['www.bilibili.com', 'passport.bilibili.com'])
  // 整份序列化出去也不含那个值(渲染层拿到的就是这一份)
  assert.equal(JSON.stringify(snapshot).includes(SENTINEL.value), false)
})

test('I-C7 ★ clearBorrowed 的返回值同样**键集恰好 {hosts}**,且真的清空了', () => {
  const handlers = makeHarness()
  const snapshot = handlers.clearBorrowed()

  assertOnlyHostsKey(snapshot)
  assert.deepStrictEqual(snapshot.hosts, [])
  // 清完再读一次:仍是空,且形状不变(不是只把返回值做空、内存还留着)
  const after = handlers.getBorrowedHosts()
  assertOnlyHostsKey(after)
  assert.deepStrictEqual(after.hosts, [])
})

test('I-C7 正向对照 ★ 往快照里多塞一个键 → 上面那个断言**必须**红(否则它是个假绿灯)', () => {
  // 「键集只有 hosts」与「断言写错了所以永远不红」输出一模一样 —— 这一条是区分二者的唯一办法。
  assert.throws(
    () => assertOnlyHostsKey({ hosts: ['a.example'], cookies: [SENTINEL] }),
    /快照除 hosts 外不许有任何键/,
    '★ 键集断言必须对多出来的字段能红'
  )
  assert.throws(
    () => assertOnlyHostsKey({}),
    /快照除 hosts 外不许有任何键/,
    '★ 少了 hosts 同样不合形状'
  )
})
