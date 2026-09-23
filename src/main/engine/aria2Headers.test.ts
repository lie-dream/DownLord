/**
 * 接管 headers → aria2 选项的单测(U-13;v0.4 Task 4 · spec §7.1 / §6.2 第③层)。
 *
 * **反向探针**:把 `if (!headers) return {}` 改成返回非空(如 `{ referer: '' }`)→ 首条必须变红。
 * 这条断言是「缺省逐字节等价」的下游支点:options 里多一个键,aria2 收到的任务级选项就变了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAria2HeaderOptions } from './aria2Headers'

const REFERER = 'https://uu.163.com/session'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'

test('U-13 缺省恒产 {}:undefined / 空对象 → 展开后逐字节等价(零回归)', () => {
  assert.deepStrictEqual(toAria2HeaderOptions(undefined), {})
  assert.deepStrictEqual(toAria2HeaderOptions({}), {})
  // 展开进真实 options 的形态 —— 与改动前那三行逐字节相同
  const before = { dir: 'D:\\Downloads', out: 'a.bin' }
  assert.deepStrictEqual({ ...before, ...toAria2HeaderOptions(undefined) }, before)
})

test('U-13 只放行两键,映射到 aria2 专用选项名(不是 header)', () => {
  assert.deepStrictEqual(toAria2HeaderOptions({ Referer: REFERER }), { referer: REFERER })
  assert.deepStrictEqual(toAria2HeaderOptions({ 'User-Agent': UA }), { 'user-agent': UA })
  assert.deepStrictEqual(toAria2HeaderOptions({ Referer: REFERER, 'User-Agent': UA }), {
    referer: REFERER,
    'user-agent': UA
  })
})

test('U-13 Cookie / Authorization 被丢弃(第三层:aria2 侧没有任意头的通路)', () => {
  const out = toAria2HeaderOptions({
    Referer: REFERER,
    Cookie: 'SESSIONID=deadbeef',
    Authorization: 'Bearer secret'
  })

  // 键集合全等:多出任何一个键(尤其 `header`)当场红
  assert.deepStrictEqual(out, { referer: REFERER })
  assert.deepStrictEqual(Object.keys(out), ['referer'])
})

test('U-13 空串值不产生空选项(与 filterDownloadHeaders 的口径一致)', () => {
  assert.deepStrictEqual(toAria2HeaderOptions({ Referer: '', 'User-Agent': UA }), {
    'user-agent': UA
  })
})
