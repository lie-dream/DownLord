/**
 * 零覆盖清单订正:`extension/src/buildId.ts` 是**真缺口,不是豁免**。
 *
 * Phase 1 的初判把它归进 A 类「进程入口 / chrome 运行时装配 → 倾向真豁免」。实际读源码后:
 * 它既不是入口也不碰 `chrome.*`,只有一个导出常量 + 一次 `typeof` 守卫。**可测,故不该豁免。**
 * (spec §1.4 那条纪律的第三种形态:把「可测但没测」写成豁免,与把「不可测」写成排除同源。)
 *
 * 值得钉住的正是那个 `typeof`:esbuild 的 `define` 只在**构建时**注入
 * `__DOWNLORD_BUILD_ID__`,直接跑 TS(单测 / dev)时该标识符**根本没声明**。
 * 写成 `__DOWNLORD_BUILD_ID__ ?? 'dev'` 会当场 `ReferenceError` —— `??` 救不了未声明的标识符,
 * 只有 `typeof` 对未声明标识符是安全的。这条差别在构建产物里看不出来,只有单测能看出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUILD_ID } from './buildId'

test('未注入 define 时 BUILD_ID 回落 dev(而不是抛 ReferenceError)', () => {
  assert.equal(BUILD_ID, 'dev')
})

test('BUILD_ID 恒为字符串:popup 拿它和 sw 报上来那份做全等比对,类型飘了比对就失效', () => {
  assert.equal(typeof BUILD_ID, 'string')
})

test('模块只导出 BUILD_ID 一个符号(它是「由产物自己开口」的唯一入口,#53)', async () => {
  const mod = await import('./buildId')
  assert.deepEqual(Object.keys(mod), ['BUILD_ID'])
})
