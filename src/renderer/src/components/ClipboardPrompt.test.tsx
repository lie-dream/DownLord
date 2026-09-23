/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ClipboardLink } from '../../../shared/ipc'
import ClipboardPrompt from './ClipboardPrompt'

afterEach(cleanup)

const VIDEO_LINK: ClipboardLink = { url: 'https://www.youtube.com/watch?v=abc', kind: 'video' }
const HTTP_LINK: ClipboardLink = { url: 'https://example.com/pack.zip', kind: 'http' }

test('渲染 URL + 视频类型标签', () => {
  render(<ClipboardPrompt link={VIDEO_LINK} onAdd={() => {}} onDismiss={() => {}} />)
  assert.ok(screen.getByText('检测到可下载链接'))
  assert.ok(screen.getByText('视频'))
  assert.ok(screen.getByText(VIDEO_LINK.url))
})

test('直链类型标签 = 直链下载', () => {
  render(<ClipboardPrompt link={HTTP_LINK} onAdd={() => {}} onDismiss={() => {}} />)
  assert.ok(screen.getByText('直链下载'))
  assert.ok(screen.getByText(HTTP_LINK.url))
})

test('点「添加」→ onAdd(url)', () => {
  const added: string[] = []
  render(<ClipboardPrompt link={VIDEO_LINK} onAdd={(u) => added.push(u)} onDismiss={() => {}} />)
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(added, [VIDEO_LINK.url])
})

test('点「忽略」→ onDismiss', () => {
  let dismissed = 0
  render(<ClipboardPrompt link={VIDEO_LINK} onAdd={() => {}} onDismiss={() => (dismissed += 1)} />)
  fireEvent.click(screen.getByText('忽略'))
  assert.equal(dismissed, 1)
})

test('link=null → 不渲染(返回 null,不占位)', () => {
  const { container } = render(
    <ClipboardPrompt link={null} onAdd={() => {}} onDismiss={() => {}} />
  )
  assert.equal(container.querySelector('.clip-prompt'), null)
  assert.equal(screen.queryByText('检测到可下载链接'), null)
})
