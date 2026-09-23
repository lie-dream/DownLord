import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toAria2GlobalLimitOption, toAria2TaskLimitOption } from './aria2Limit'

// ==================== toAria2GlobalLimitOption(全局限速选项,spec §2.1 / §7.1)====================

// v1.0 Task 8 · #100(C1 / C2):全局限速改为 `max-download-limit` 的全局默认值(每任务默认上限),
// 不再是 `max-overall-download-limit` 总量硬上限;断言对象就是本次修订的事实(映射键)。
test('T8-A01 toAria2GlobalLimitOption: kbps>0 → {max-download-limit: "<kbps>K"}(全局 = 每任务默认上限)', () => {
  assert.deepEqual(toAria2GlobalLimitOption(500), { 'max-download-limit': '500K' })
  assert.deepEqual(toAria2GlobalLimitOption(1048576), { 'max-download-limit': '1048576K' })
})

test('T8-A01 toAria2GlobalLimitOption: 0 → {max-download-limit: "0"}(全局默认不限)', () => {
  assert.deepEqual(toAria2GlobalLimitOption(0), { 'max-download-limit': '0' })
})

// ==================== toAria2TaskLimitOption(任务级限速选项,spec §2.1 / §7.1)====================

test('toAria2TaskLimitOption: kbps>0 → {max-download-limit: "<kbps>K"}', () => {
  assert.deepEqual(toAria2TaskLimitOption(500), { 'max-download-limit': '500K' })
  assert.deepEqual(toAria2TaskLimitOption(256), { 'max-download-limit': '256K' })
})

test('toAria2TaskLimitOption: 0 → {max-download-limit: "0"}(解除该任务限速)', () => {
  assert.deepEqual(toAria2TaskLimitOption(0), { 'max-download-limit': '0' })
})
