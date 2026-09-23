/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueToast, MAX_TOASTS, type ToastItem } from './toastStore'

const mk = (id: number): ToastItem => ({ id, text: 't' + id, kind: 'info' })

test('未超上限:顺序追加', () => {
  const out = enqueueToast([mk(1), mk(2)], mk(3), 3)
  assert.deepEqual(
    out.map((t) => t.id),
    [1, 2, 3]
  )
})

test('超上限:FIFO 挤掉最旧,保留最新 max 条', () => {
  const out = enqueueToast([mk(1), mk(2), mk(3)], mk(4), 3)
  assert.deepEqual(
    out.map((t) => t.id),
    [2, 3, 4]
  )
})

test('默认上限 MAX_TOASTS=3', () => {
  assert.equal(MAX_TOASTS, 3)
  let list: ToastItem[] = []
  for (let i = 1; i <= 5; i++) list = enqueueToast(list, mk(i))
  assert.deepEqual(
    list.map((t) => t.id),
    [3, 4, 5]
  )
})
