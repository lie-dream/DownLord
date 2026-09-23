/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import EmptyState from './EmptyState'

afterEach(cleanup)

test('渲染空态文案', () => {
  render(<EmptyState onAddClick={() => {}} />)
  assert.ok(screen.getByText('还没有下载任务'))
})

test('点添加任务触发 onAddClick', () => {
  let clicked = false
  render(<EmptyState onAddClick={() => (clicked = true)} />)
  fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
  assert.equal(clicked, true)
})
