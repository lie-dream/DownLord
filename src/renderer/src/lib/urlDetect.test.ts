import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHttpUrl, parseUrlLines } from './urlDetect'
test('isHttpUrl', () => {
  assert.equal(isHttpUrl('https://a.com/f.zip'), true)
  assert.equal(isHttpUrl('http://a.com'), true)
  assert.equal(isHttpUrl('ftp://a'), false)
  assert.equal(isHttpUrl('magnet:?x'), false)
  assert.equal(isHttpUrl('随便'), false)
})
test('parseUrlLines 去空白/去重/统计非法', () => {
  const r = parseUrlLines('https://a/1\n\n https://a/1 \nhttp://b/2\nmagnet:x\n')
  assert.deepEqual(r.urls, ['https://a/1', 'http://b/2'])
  assert.equal(r.invalidCount, 1)
})
