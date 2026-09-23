/**
 * 扩展版本号校验单测(v0.4 Task 2 · spec §8.1 断言 A8)。
 *
 * 断言的硬口径是「**报错退出、绝不裁剪**」:`0.4.0-rc1` 若被静默裁成 `0.4.0`,
 * 安装包与扩展就会各报一个版本、且没有任何人被告知 —— 那正是版本注入机制要防的漂移。
 *
 * 被测模块是 `scripts/extensionVersion.mjs`(零副作用);
 * **不 import `build-extension.mjs`** —— 它顶层就 `await buildOnce()`,import 即真跑一次构建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertValidExtensionVersion, isValidExtensionVersion } from './extensionVersion.mjs'

test('isValidExtensionVersion: 1–4 段纯数字合法', () => {
  for (const version of ['0.3.0', '1', '1.2', '1.2.3.4', '0', '65535.65535.65535.65535']) {
    assert.equal(isValidExtensionVersion(version), true, `${version} 应合法`)
  }
})

test('isValidExtensionVersion: 预发布后缀非法(绝不裁剪成 0.4.0)', () => {
  for (const version of ['0.4.0-rc1', '1.0.0-beta', '1.0.0+build3', '0.4.0rc1']) {
    assert.equal(isValidExtensionVersion(version), false, `${version} 应非法`)
  }
})

test('isValidExtensionVersion: 段数超 4 非法', () => {
  assert.equal(isValidExtensionVersion('1.2.3.4.5'), false)
})

test('isValidExtensionVersion: 单段超 65535 非法', () => {
  assert.equal(isValidExtensionVersion('70000.0'), false, '70000 > 65535')
  assert.equal(isValidExtensionVersion('65536'), false, '边界外')
  assert.equal(isValidExtensionVersion('65535'), true, '边界内')
})

test('isValidExtensionVersion: 非数字 / 空 / 前缀 v / 形状畸形均非法', () => {
  for (const version of ['1.2.a', '', 'v1.0', '1.', '.1', '1..2', ' 1.0', '1.0 ', '1,0']) {
    assert.equal(isValidExtensionVersion(version), false, `${JSON.stringify(version)} 应非法`)
  }
})

test('isValidExtensionVersion: 非字符串输入不崩,判非法', () => {
  for (const version of [undefined, null, 1, 1.2, {}, [], true]) {
    assert.equal(isValidExtensionVersion(version), false, `${String(version)} 应非法`)
  }
})

test('assertValidExtensionVersion: 合法则原样返回', () => {
  assert.equal(assertValidExtensionVersion('0.3.0'), '0.3.0')
})

test('assertValidExtensionVersion: 非法则抛错,且错误信息说清要求与「未产出任何产物」', () => {
  assert.throws(
    () => assertValidExtensionVersion('0.4.0-rc1'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /0\.4\.0-rc1/, '错误信息带上出问题的版本号')
      assert.match(error.message, /65535/, '说清每段上限')
      assert.match(error.message, /未产出任何产物/, '说清失败时零产出')
      return true
    }
  )
})

test('assertValidExtensionVersion: package.json 的当前版本能过闸(防仓库自身踩雷)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
    version: string
  }

  assert.equal(assertValidExtensionVersion(version), version)
})
