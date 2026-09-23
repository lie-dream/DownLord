/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TaskRowMoreMenu from './TaskRowMoreMenu'
import { ToastProvider } from '../state/ToastContext'
import type { Task } from '../../../shared/ipc'

afterEach(() => {
  cleanup()
  delete (navigator as { clipboard?: unknown }).clipboard
})

function stubClipboard(writeText: (t: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

const done = (over: Partial<Task> = {}): Task => ({
  id: '1',
  kind: 'http',
  source: 'https://site.example/movie.mp4',
  status: 'completed',
  filename: 'movie.mp4',
  savePath: 'D:/Downloads/movie.mp4',
  category: 'video',
  totalBytes: 200,
  downloadedBytes: 200,
  speed: 0,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 1,
  startedAt: 1,
  completedAt: 1_700_000_000_000,
  ...over
})

const noop = (): void => {}

function renderMenu(task: Task, onRemove: (id: string, del: boolean) => void = noop): void {
  render(
    <ToastProvider>
      <TaskRowMoreMenu task={task} onRemove={onRemove} />
    </ToastProvider>
  )
}

test('操作区含「复制下载链接」中性项，位于两删除项之前（常用 → 危险秩序，§6.1）', () => {
  renderMenu(done())
  fireEvent.click(screen.getByTitle('更多'))
  const items = screen.getByRole('menu').querySelectorAll('.tm-item')
  assert.equal(items.length, 3, '复制 + 两删除共三项')
  assert.match(items[0].textContent ?? '', /复制下载链接/)
  assert.match(items[1].textContent ?? '', /从列表删除/)
  assert.match(items[2].textContent ?? '', /删除文件/)
  // 复制为中性（非 danger）；仅「删除文件」danger
  assert.equal(items[0].classList.contains('danger'), false, '复制项中性')
  assert.equal(items[2].classList.contains('danger'), true, '删除文件 danger')
  assert.ok(items[0].querySelector('svg'), '复制项含 IconCopy 图标')
})

test('点「复制下载链接」→ 以 task.source 调剪贴板 + Toast「已复制下载链接」+ 关闭菜单', async () => {
  const writes: string[] = []
  stubClipboard(async (t) => {
    writes.push(t)
  })
  renderMenu(done({ source: 'https://bili.example/BV123' }))
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText('复制下载链接'))
  assert.ok(await screen.findByText('已复制下载链接'), '成功 Toast 出现')
  assert.deepEqual(writes, ['https://bili.example/BV123'], '以 task.source 写剪贴板一次')
  assert.equal(screen.queryByRole('menu'), null, '复制后关闭菜单')
})

test('复制失败（writeText reject）→ Toast「复制失败」error（不崩）', async () => {
  stubClipboard(async () => {
    throw new Error('无剪贴板权限')
  })
  renderMenu(done())
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText('复制下载链接'))
  const t = await screen.findByText('复制失败')
  assert.ok(t.className.includes('error'), '失败 Toast 为 error 语义')
})

test('两删除项行为零回归：从列表删除 onRemove(id,false) / 删除文件 onRemove(id,true)', () => {
  const calls: Array<[string, boolean]> = []
  renderMenu(done({ id: 'z9' }), (id, del) => calls.push([id, del]))
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText(/从列表删除/))
  assert.equal(screen.queryByRole('menu'), null, '点删除项后关闭')
  fireEvent.click(screen.getByTitle('更多')) // 菜单已关，重开
  fireEvent.click(screen.getByText(/删除文件/))
  assert.deepEqual(calls, [
    ['z9', false],
    ['z9', true]
  ])
})
