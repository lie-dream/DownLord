/**
 * 接管 headers 白名单单测(U-17;v0.4 Task 4 · spec §7.1 / §6.2 第②层)。
 *
 * **反向探针 RP-1**:给 `TAKEOVER_HEADER_ALLOWLIST` 加一项 `'Cookie'` → 本文件必须变红。
 * 「越界键被丢弃」这类断言若写成「结果里没有 Cookie」而白名单又恰好放行了它,输出与真绿灯
 * 一模一样 —— 故这里对**白名单本身**也下一条全等断言(键集合恰好两个)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAKEOVER_HEADER_ALLOWLIST, filterDownloadHeaders } from './downloadHeaders'

const REFERER = 'https://uu.163.com/session?sid=abc'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'

test('U-17 白名单恰好两项,且是规范大小写', () => {
  // 全等而非 includes:悄悄多放行一个键当场红(RP-1 的落点)
  assert.deepStrictEqual([...TAKEOVER_HEADER_ALLOWLIST], ['Referer', 'User-Agent'])
})

test('U-17 键名大小写不敏感匹配,输出恒用规范大小写', () => {
  assert.deepStrictEqual(filterDownloadHeaders({ referer: REFERER }), { Referer: REFERER })
  assert.deepStrictEqual(filterDownloadHeaders({ REFERER: REFERER }), { Referer: REFERER })
  assert.deepStrictEqual(filterDownloadHeaders({ 'user-agent': UA }), { 'User-Agent': UA })
  assert.deepStrictEqual(filterDownloadHeaders({ 'USER-AGENT': UA }), { 'User-Agent': UA })
  assert.deepStrictEqual(filterDownloadHeaders({ Referer: REFERER, 'User-Agent': UA }), {
    Referer: REFERER,
    'User-Agent': UA
  })
})

test('U-17 越界键静默丢弃:Cookie / Authorization 一个都不许出来', () => {
  const out = filterDownloadHeaders({
    Referer: REFERER,
    Cookie: 'SESSIONID=deadbeef',
    cookie: 'SESSIONID=deadbeef',
    Authorization: 'Bearer secret',
    'X-Custom': 'whatever'
  })

  // 键集合全等 —— ★ 这条才是「只放行两键」的机器形式(逐个 assert.equal(out.Cookie, undefined)
  //    在白名单被改宽时仍会绿:因为那时 out.Cookie 有值,但断言写的是「没有 Cookie 键」才会红)
  assert.deepStrictEqual(out, { Referer: REFERER })
})

test('U-17 全部越界 → 返回 undefined(而非 {}):缺省等价的前提', () => {
  assert.equal(filterDownloadHeaders({ Cookie: 'x', Authorization: 'y' }), undefined)
  assert.equal(filterDownloadHeaders({}), undefined)
  assert.equal(filterDownloadHeaders(undefined), undefined)
})

test('U-17 空串值不放行(空 Referer 与不下发 referer 是同一件事,不造空头)', () => {
  assert.equal(filterDownloadHeaders({ Referer: '' }), undefined)
  assert.deepStrictEqual(filterDownloadHeaders({ Referer: '', 'User-Agent': UA }), {
    'User-Agent': UA
  })
})

test('U-17 非字符串值不放行(渲染层 / 通道来的东西不做类型假设)', () => {
  const dirty = { Referer: 123, 'User-Agent': UA } as unknown as Record<string, string>
  assert.deepStrictEqual(filterDownloadHeaders(dirty), { 'User-Agent': UA })
})
