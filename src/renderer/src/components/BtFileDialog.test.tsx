/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { TorrentFile, TorrentMeta } from '../../../shared/ipc'
import BtFileDialog from './BtFileDialog'

afterEach(cleanup)

const f = (path: string, length: number): TorrentFile => ({ path, length, selected: true })

// 原 aria2 顺序:a.mkv(idx1)/ b.srt(idx2)/ c.mkv(idx3)
const META: TorrentMeta = {
  name: 'Show.S01',
  infoHash: 'abc123',
  files: [f('a.mkv', 1024 * 1024), f('b.srt', 2048), f('c.mkv', 3 * 1024 * 1024)]
}

const noop = (): void => {}

test('open=false 不渲染', () => {
  render(
    <BtFileDialog
      open={false}
      meta={META}
      landingDir="D:/DL/Torrents/Show.S01"
      onClose={noop}
      onSubmit={noop}
    />
  )
  assert.equal(screen.queryByText('选择要下载的文件'), null)
})

test('meta=null 不渲染', () => {
  render(<BtFileDialog open meta={null} landingDir="x" onClose={noop} onSubmit={noop} />)
  assert.equal(screen.queryByText('选择要下载的文件'), null)
})

test('渲染标题 / 种子名 / 文件数总大小 / 各文件路径 / 落点', () => {
  render(
    <BtFileDialog
      open
      meta={META}
      landingDir="D:/DL/Torrents/Show.S01"
      onClose={noop}
      onSubmit={noop}
    />
  )
  assert.ok(screen.getByText('选择要下载的文件'))
  assert.ok(screen.getByText('Show.S01'))
  // 3 文件 · 共 (1MB + 2048B + 3MB) = 4.0 MB
  assert.ok(screen.getByText(/3 个文件 · 共 4\.0 MB/))
  assert.ok(screen.getByText('a.mkv'))
  assert.ok(screen.getByText('b.srt'))
  assert.ok(screen.getByText('c.mkv'))
  assert.ok(screen.getByText('D:/DL/Torrents/Show.S01'))
})

test('默认全选:已选 N · 共 X = 3 · 3;开始下载可用', () => {
  render(<BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={noop} />)
  assert.ok(screen.getByText('已选 3 · 共 3'))
  assert.equal(
    (screen.getByText('开始下载').closest('button') as HTMLButtonElement).disabled,
    false
  )
})

test('行点击 toggle 取消勾选 → 合计减一', () => {
  render(<BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={noop} />)
  fireEvent.click(screen.getByText('a.mkv'))
  assert.ok(screen.getByText('已选 2 · 共 3'))
})

test('反选:全选态 → 全不选(合计 0 + 开始下载禁用)', () => {
  render(<BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={noop} />)
  fireEvent.click(screen.getByText('反选'))
  assert.ok(screen.getByText('已选 0 · 共 3'))
  assert.equal(
    (screen.getByText('开始下载').closest('button') as HTMLButtonElement).disabled,
    true,
    '空选禁用'
  )
})

test('全选:先反选清空 → 点全选恢复全选', () => {
  render(<BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={noop} />)
  fireEvent.click(screen.getByText('反选'))
  assert.ok(screen.getByText('已选 0 · 共 3'))
  fireEvent.click(screen.getByText('全选'))
  assert.ok(screen.getByText('已选 3 · 共 3'))
})

test('onSubmit 回传正确 1-based 索引(取消 b.srt=idx2 → [1,3]);按显示排序不影响 index 映射', () => {
  let got: number[] | null = null
  render(
    <BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={(idx) => (got = idx)} />
  )
  // 取消 b.srt(原 aria2 idx2)→ 剩 a.mkv(idx1)+ c.mkv(idx3)
  fireEvent.click(screen.getByText('b.srt'))
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, [1, 3])
})

test('全选提交 → 回传全部 1-based 索引 [1,2,3](整包)', () => {
  let got: number[] | null = null
  render(
    <BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={(idx) => (got = idx)} />
  )
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, [1, 2, 3])
})

test('单选提交 → 只回传该文件 1-based 索引', () => {
  let got: number[] | null = null
  render(
    <BtFileDialog open meta={META} landingDir="x" onClose={noop} onSubmit={(idx) => (got = idx)} />
  )
  fireEvent.click(screen.getByText('反选')) // 清空
  fireEvent.click(screen.getByText('c.mkv')) // 只选 c.mkv(原 idx3)
  fireEvent.click(screen.getByText('开始下载'))
  assert.deepEqual(got, [3])
})

test('取消 → onClose', () => {
  let closed = 0
  let submitted = 0
  render(
    <BtFileDialog
      open
      meta={META}
      landingDir="x"
      onClose={() => (closed += 1)}
      onSubmit={() => (submitted += 1)}
    />
  )
  fireEvent.click(screen.getByText('取消'))
  assert.equal(closed, 1)
  assert.equal(submitted, 0, '取消不提交')
})

test('× 关闭 → onClose', () => {
  let closed = 0
  render(
    <BtFileDialog open meta={META} landingDir="x" onClose={() => (closed += 1)} onSubmit={noop} />
  )
  fireEvent.click(screen.getByLabelText('关闭'))
  assert.equal(closed, 1)
})

test('Esc 关闭 → onClose', () => {
  let closed = 0
  render(
    <BtFileDialog open meta={META} landingDir="x" onClose={() => (closed += 1)} onSubmit={noop} />
  )
  fireEvent.keyDown(window, { key: 'Escape' })
  assert.equal(closed, 1)
})

test('点遮罩不关闭(防误触)', () => {
  let closed = 0
  const { container } = render(
    <BtFileDialog open meta={META} landingDir="x" onClose={() => (closed += 1)} onSubmit={noop} />
  )
  fireEvent.click(container.querySelector('.overlay') as HTMLElement)
  assert.equal(closed, 0, '点遮罩不触发关闭')
})
