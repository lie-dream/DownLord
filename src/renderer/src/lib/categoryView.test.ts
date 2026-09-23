import { test } from 'node:test'
import assert from 'node:assert/strict'
import { categoryLabel, categoryIconClass } from './categoryView'

test('categoryLabel:all + 6 类各 key 映射(与原型 / DEFAULT_CATEGORIES 同文案)', () => {
  assert.equal(categoryLabel('all'), '全部')
  assert.equal(categoryLabel('video'), '视频')
  assert.equal(categoryLabel('audio'), '音频')
  assert.equal(categoryLabel('archive'), '压缩包')
  assert.equal(categoryLabel('document'), '文档')
  assert.equal(categoryLabel('program'), '程序')
  assert.equal(categoryLabel('other'), '其他')
})

test('categoryIconClass:与 TaskRow .t-icon 同源(video/audio/file)', () => {
  assert.equal(categoryIconClass('video'), 'video')
  assert.equal(categoryIconClass('audio'), 'audio')
  // archive / document / program / other 复用文件图标(与 TaskRow file 同源)
  assert.equal(categoryIconClass('archive'), 'file')
  assert.equal(categoryIconClass('document'), 'file')
  assert.equal(categoryIconClass('program'), 'file')
  assert.equal(categoryIconClass('other'), 'file')
})
