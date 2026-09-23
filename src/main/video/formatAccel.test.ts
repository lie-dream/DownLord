import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isFragmentedProtocol, CONCURRENT_FRAGMENTS } from './formatAccel'

test('isFragmentedProtocol:HLS/DASH 分片协议 → true(不挂 aria2c)', () => {
  assert.equal(isFragmentedProtocol('m3u8'), true)
  assert.equal(isFragmentedProtocol('m3u8_native'), true)
  assert.equal(isFragmentedProtocol('http_dash_segments'), true)
  assert.equal(isFragmentedProtocol('dash'), true)
})

test('isFragmentedProtocol:progressive(https / http)→ false(保守挂 aria2c)', () => {
  assert.equal(isFragmentedProtocol('https'), false)
  assert.equal(isFragmentedProtocol('http'), false)
})

test('isFragmentedProtocol:未知 / 空 / null / undefined → false(保守,§7.1 回退不退化)', () => {
  assert.equal(isFragmentedProtocol(null), false)
  assert.equal(isFragmentedProtocol(undefined), false)
  assert.equal(isFragmentedProtocol(''), false)
  assert.equal(isFragmentedProtocol('some_unknown_protocol'), false)
})

test('CONCURRENT_FRAGMENTS = 4(保守并发)', () => {
  assert.equal(CONCURRENT_FRAGMENTS, 4)
})
