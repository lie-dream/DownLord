/**
 * buildId 格式单测(v0.4 Task 5 Phase 1 · spec §3.5 · 认领 `docs/TODO.md` #53)。
 *
 * 被测模块是 `scripts/buildId.mjs`(零副作用);**不 import `build-extension.mjs`** ——
 * 它顶层就 `await buildOnce()`,import 即真跑一次构建(与 `extensionVersion.test.ts` 同一处理)。
 *
 * 断言的硬口径是「**时刻必须在里面**」:只带 version 或只带 git sha 的标记,
 * 在「连续构建两次而未提交」这个**最需要它的场景**里给不出任何区分度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatBuildId } from './buildId.mjs'

/** 固定时刻:2026-08-09 14:30:22(本地时区)—— 不读时钟,故断言可重复 */
const FIXED = new Date(2026, 7, 9, 14, 30, 22)

test('formatBuildId: 形如 <version>+<YYYYMMDD-HHmmss>', () => {
  assert.equal(formatBuildId('0.4.0', FIXED), '0.4.0+20260809-143022')
})

test('formatBuildId: 月 / 日 / 时 / 分 / 秒各自补零到两位', () => {
  assert.equal(formatBuildId('1.0', new Date(2026, 0, 2, 3, 4, 5)), '1.0+20260102-030405')
})

test('formatBuildId: 同一天连续两次构建的标记不同(#53 的核心诉求)', () => {
  const first = formatBuildId('0.4.0', new Date(2026, 7, 9, 14, 30, 22))
  const second = formatBuildId('0.4.0', new Date(2026, 7, 9, 14, 30, 23))

  assert.notEqual(
    first,
    second,
    '两次构建标记相同 —— 那正是「只用 git short sha」会废掉的场景(未提交时 sha 恒等)'
  )
})

test('formatBuildId: 时刻确实进了标记(而不是只带版本号)', () => {
  const id = formatBuildId('0.4.0', FIXED)

  assert.match(id, /^0\.4\.0\+\d{8}-\d{6}$/, '版本号后必须跟一段 8 位日期 + 6 位时刻')
  assert.notEqual(id, '0.4.0', '只带版本号的标记在同版本内不可区分')
})

test('formatBuildId: 版本号原样前置,不做任何裁剪', () => {
  // 与 `assertValidExtensionVersion` 的口径一致:该拦的在那边报错退出,这里不悄悄改值
  assert.equal(formatBuildId('1.2.3.4', FIXED), '1.2.3.4+20260809-143022')
})
