import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeShareRatio } from './shareRatio'

test('completedLength <= 0 → 0(避免除零)', () => {
  assert.equal(computeShareRatio(0, 0), 0)
  assert.equal(computeShareRatio(100, 0), 0)
  assert.equal(computeShareRatio(100, -5), 0)
})
test('正常比值 = uploadLength / completedLength', () => {
  assert.equal(computeShareRatio(0, 1000), 0)
  assert.equal(computeShareRatio(850, 1000), 0.85)
  assert.equal(computeShareRatio(1200, 1000), 1.2)
  assert.equal(computeShareRatio(1000, 1000), 1)
})
