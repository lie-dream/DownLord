/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import Toast from './Toast'

afterEach(cleanup)

test('空列表不渲染浮层', () => {
  const { container } = render(<Toast toasts={[]} />)
  assert.equal(container.querySelector('.toast-viewport'), null)
})

test('渲染 toast 文案与语义类', () => {
  render(<Toast toasts={[{ id: 1, text: '文件不存在,可能已被移动或删除', kind: 'error' }]} />)
  assert.ok(screen.getByText(/文件不存在/))
  assert.ok(document.querySelector('.toast.error'))
})
