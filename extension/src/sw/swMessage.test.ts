/**
 * L4 · popup ↔ sw 内部消息的形状守卫 —— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L4 层)。
 *
 * `swMessage.ts` 此前**零覆盖**(Phase 1 初判把它列为「待判」)。判定结果:**真缺口,不是豁免** ——
 * 两个导出都是纯类型守卫,不碰 `chrome.*`,拿普通对象就能测。
 *
 * 为什么这两个守卫值得测:`isSwSyncReply` 里那条「`buildId` 一并验」的设计
 * (源文件注释里写着的那条 ⚠️)是 v0.4 Task 5 用来把**旧 sw** 识别出来的唯一手段。
 * 旧 sw 回不出 `buildId`,守卫若只看 `handled`,`reply.buildId` 就成了「类型上写着 string、
 * 运行时是 undefined」的洞,popup 会把「沉默」当成「一致」—— 而这正是它要报的那件事。
 * 这条只有反面用例(缺 buildId 的应答)才守得住,顺路用例一条都测不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SW_SYNC_KIND, isSwSyncRequest, isSwSyncReply } from './swMessage'

test('L4-sw-1 SW_SYNC_KIND 是 downlord:sync(两端硬编码比对的那个字面量)', () => {
  assert.equal(SW_SYNC_KIND, 'downlord:sync')
})

test('L4-sw-2 isSwSyncRequest:只认 kind 恰为 downlord:sync 的对象', () => {
  assert.equal(isSwSyncRequest({ kind: 'downlord:sync' }), true)
  assert.equal(isSwSyncRequest({ kind: 'downlord:sync', extra: 1 }), true, '多余字段不影响识别')

  assert.equal(isSwSyncRequest({ kind: 'downlord:other' }), false)
  assert.equal(isSwSyncRequest({ kind: 'DOWNLORD:SYNC' }), false, '大小写不同即不是它')
  assert.equal(isSwSyncRequest({}), false)
  assert.equal(isSwSyncRequest({ kind: undefined }), false)
})

test('L4-sw-3 isSwSyncRequest:非对象一律 false(null / 数字 / 串 / 数组 / 函数)', () => {
  assert.equal(isSwSyncRequest(null), false, 'null 的 typeof 也是 object —— 这条专防那个坑')
  assert.equal(isSwSyncRequest(undefined), false)
  assert.equal(isSwSyncRequest(0), false)
  assert.equal(isSwSyncRequest('downlord:sync'), false, '光是那个串本身不算一条消息')
  assert.equal(isSwSyncRequest([]), false)
  assert.equal(isSwSyncRequest(() => {}), false)
})

test('L4-sw-4 isSwSyncReply:handled + buildId 两者齐备才认', () => {
  assert.equal(isSwSyncReply({ handled: true, buildId: 'b1' }), true)
  assert.equal(isSwSyncReply({ handled: false, buildId: '' }), true, '空串也是合法 buildId(形状对就行)')
  assert.equal(
    isSwSyncReply({ handled: true, buildId: 'b1', wake: { count: 3 }, handshake: { ok: true } }),
    true,
    '可选字段带上照样认'
  )
})

test('L4-sw-5 ★ 旧 sw 的应答(有 handled、没 buildId)必须判不认 —— 沉默不许被当成一致', () => {
  assert.equal(
    isSwSyncReply({ handled: true }),
    false,
    '守卫只看 handled 时,这条会过闸,然后 reply.buildId 在下游变成 undefined 的洞'
  )
  assert.equal(isSwSyncReply({ buildId: 'b1' }), false, '反过来缺 handled 同样不认')
  assert.equal(isSwSyncReply({ handled: 'true', buildId: 'b1' }), false, 'handled 必须是布尔,不收字符串')
  assert.equal(isSwSyncReply({ handled: true, buildId: 123 }), false, 'buildId 必须是字符串')
  assert.equal(isSwSyncReply({ handled: true, buildId: null }), false)
})

test('L4-sw-6 isSwSyncReply:非对象一律 false', () => {
  assert.equal(isSwSyncReply(null), false)
  assert.equal(isSwSyncReply(undefined), false)
  assert.equal(isSwSyncReply('ok'), false)
  assert.equal(isSwSyncReply(1), false)
})

test('L4-sw-7 两个守卫互不串味:请求不是应答,应答不是请求', () => {
  assert.equal(isSwSyncReply({ kind: SW_SYNC_KIND }), false)
  assert.equal(isSwSyncRequest({ handled: true, buildId: 'b1' }), false)
})
