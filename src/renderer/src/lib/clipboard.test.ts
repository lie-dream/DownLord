/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyToClipboard } from './clipboard'

// 每测后清掉注入的 navigator.clipboard（jsdom navigator 本无该 own property，delete 即还原干净）
afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard
})

function stubClipboard(writeText: (t: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

test('copyToClipboard: 成功 → 以 text 调 writeText 且返回 true', async () => {
  const calls: string[] = []
  stubClipboard(async (t) => {
    calls.push(t)
  })
  const ok = await copyToClipboard('https://example.com/video.mp4')
  assert.equal(ok, true)
  assert.deepEqual(calls, ['https://example.com/video.mp4'], '原样以 source 调用一次')
})

test('copyToClipboard: writeText reject → 返回 false（吞异常不抛）', async () => {
  stubClipboard(async () => {
    throw new Error('权限被拒')
  })
  const ok = await copyToClipboard('x')
  assert.equal(ok, false)
})

test('copyToClipboard: navigator.clipboard 缺失 → 返回 false（不抛）', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  const ok = await copyToClipboard('x')
  assert.equal(ok, false)
})
