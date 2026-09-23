/**
 * categoryModel 纯函数单测 — Task 8.5 保存位置模型(诚实归类,spec §1.2)。
 *
 * 聚焦 `categorySubdir`(key → 标准子目录)与 `defaultCategoryDefs`(seed 用,savePath 恒 '')。
 * C2 智能同步函数已移除(以 `resolveCategoryDir` 实时计算取代,spec §1.5)。
 * 纯函数、无 I/O。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_KEYS, categorySubdir, defaultCategoryDefs } from './categoryModel'

// ───────────────────────── categorySubdir(spec §1.2) ─────────────────────────

test('categorySubdir: 6 类各自标准子目录', () => {
  assert.equal(categorySubdir('video'), 'Videos')
  assert.equal(categorySubdir('audio'), 'Music')
  assert.equal(categorySubdir('archive'), 'Archives')
  assert.equal(categorySubdir('document'), 'Documents')
  assert.equal(categorySubdir('program'), 'Programs')
})

test('categorySubdir: other → 空串(跟随默认目录本身,不另起子目录)', () => {
  assert.equal(categorySubdir('other'), '')
})

test('categorySubdir: 未知 key → 空串', () => {
  assert.equal(categorySubdir('nope'), '')
  assert.equal(categorySubdir(''), '')
})

// ───────────────────────── defaultCategoryDefs(spec §1.2) ─────────────────────────

test('defaultCategoryDefs: 6 类齐全,顺序 = CATEGORY_KEYS', () => {
  const defs = defaultCategoryDefs()
  assert.equal(defs.length, CATEGORY_KEYS.length)
  assert.deepEqual(
    defs.map((d) => d.key),
    [...CATEGORY_KEYS]
  )
})

test('defaultCategoryDefs: 全部 savePath === ""(跟随默认目录的干净初值)', () => {
  for (const def of defaultCategoryDefs()) {
    assert.equal(def.savePath, '', `${def.key} seed savePath 应为空串`)
  }
})

test('defaultCategoryDefs: extensions 深拷贝(改返回值不污染 DEFAULT_CATEGORIES)', () => {
  const a = defaultCategoryDefs()
  const video = a.find((d) => d.key === 'video')!
  video.extensions.push('xxx')
  const b = defaultCategoryDefs()
  assert.ok(!b.find((d) => d.key === 'video')!.extensions.includes('xxx'), 'extensions 为独立副本')
})
