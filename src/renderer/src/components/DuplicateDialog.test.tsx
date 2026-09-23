/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type {
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateResolution
} from '../../../shared/ipc'
import DuplicateDialog from './DuplicateDialog'

afterEach(cleanup)

const item = (over: Partial<DuplicateConflictItem> = {}): DuplicateConflictItem => ({
  index: 0,
  filename: 'movie.zip',
  qualityLabel: null,
  existingDir: 'D:/DL/Archives',
  existingPath: 'D:/DL/Archives/movie.zip',
  existing: 'completed',
  ...over
})

const HTTP_COMPLETED: DuplicateConflict = {
  conflictId: 'c1',
  kind: 'http',
  items: [item()]
}

const VIDEO_COMPLETED: DuplicateConflict = {
  conflictId: 'c2',
  kind: 'video',
  items: [
    item({
      filename: 'Clip [1080p].mp4',
      qualityLabel: '1080P',
      existingDir: 'D:/DL/Videos',
      existingPath: 'D:/DL/Videos/Clip [1080p].mp4'
    })
  ]
}

const VIDEO_ACTIVE: DuplicateConflict = {
  conflictId: 'c3',
  kind: 'video',
  items: [
    item({
      filename: 'Clip [720p].mp4',
      qualityLabel: '720P',
      existingDir: 'D:/DL/Videos',
      existingPath: null,
      existing: 'active'
    })
  ]
}

const BATCH: DuplicateConflict = {
  conflictId: 'p1',
  kind: 'batch',
  items: [
    item({
      index: 0,
      filename: 'Ep0 [1080p].mp4',
      qualityLabel: '1080P',
      existingDir: 'D:/DL/Videos',
      existingPath: 'D:/DL/Videos/Ep0 [1080p].mp4'
    }),
    item({
      index: 1,
      filename: 'Ep1 [1080p].mp4',
      qualityLabel: '1080P',
      existingDir: 'D:/DL/Videos',
      existingPath: 'D:/DL/Videos/Ep1 [1080p].mp4'
    })
  ]
}

const noop = (): void => {}

test('open=false 时不渲染', () => {
  render(
    <DuplicateDialog
      open={false}
      conflict={HTTP_COMPLETED}
      onResolve={noop}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  assert.equal(screen.queryByText('检测到重复下载'), null)
})

test('conflict=null 时不渲染', () => {
  render(
    <DuplicateDialog open conflict={null} onResolve={noop} onOpenExisting={noop} onClose={noop} />
  )
  assert.equal(screen.queryByText('检测到重复下载'), null)
})

test('单条渲染:标题 / 文件名 / 已存在文案 / 四决策按钮', () => {
  render(
    <DuplicateDialog
      open
      conflict={HTTP_COMPLETED}
      onResolve={noop}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  assert.ok(screen.getByText('检测到重复下载'))
  assert.ok(screen.getByText('movie.zip'))
  assert.ok(screen.getByText(/已下载,位于 D:\/DL\/Archives/))
  // 四决策按钮(completed → 含打开)
  assert.ok(screen.getByRole('button', { name: '跳过' }))
  assert.ok(screen.getByRole('button', { name: '重命名' }))
  assert.ok(screen.getByRole('button', { name: '已存在 · 打开' }))
  assert.ok(screen.getByRole('button', { name: '覆盖' }))
})

test('视频冲突渲染清晰度胶囊', () => {
  render(
    <DuplicateDialog
      open
      conflict={VIDEO_COMPLETED}
      onResolve={noop}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  assert.ok(screen.getByText('Clip [1080p].mp4'))
  assert.ok(screen.getByText('1080P'))
})

test('覆盖 → onResolve(overwrite)', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={HTTP_COMPLETED}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '覆盖' }))
  assert.deepEqual(got, { conflictId: 'c1', decision: 'overwrite' })
})

test('跳过 → onResolve(skip)', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={HTTP_COMPLETED}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '跳过' }))
  assert.deepEqual(got, { conflictId: 'c1', decision: 'skip' })
})

test('重命名 → onResolve(rename)', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={HTTP_COMPLETED}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '重命名' }))
  assert.deepEqual(got, { conflictId: 'c1', decision: 'rename' })
})

test('已存在·打开 → onOpenExisting(item) + onResolve(open)', () => {
  const opened: DuplicateConflictItem[] = []
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={VIDEO_COMPLETED}
      onResolve={(r) => (got = r)}
      onOpenExisting={(it) => opened.push(it)}
      onClose={noop}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '已存在 · 打开' }))
  assert.equal(opened[0]?.existingPath, 'D:/DL/Videos/Clip [1080p].mp4', '把该冲突项交渲染层打开')
  assert.deepEqual(
    got,
    { conflictId: 'c2', decision: 'open' },
    '打开后仍上报 open 决策清理 pending'
  )
})

test('active 命中态:不提供「打开」+ 文案「已在下载列表」', () => {
  render(
    <DuplicateDialog
      open
      conflict={VIDEO_ACTIVE}
      onResolve={noop}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  assert.equal(screen.queryByRole('button', { name: '已存在 · 打开' }), null, 'active 无打开按钮')
  assert.ok(screen.getByText(/已在下载列表/))
  // 其它决策仍在(覆盖 active existingPath=null → 主进程无文件可移、直接建)
  assert.ok(screen.getByRole('button', { name: '覆盖' }))
})

test('批量:N 项 + 应用到全部 select + 确定 / 取消(无四决策按钮 / 无逐条打开)', () => {
  render(
    <DuplicateDialog open conflict={BATCH} onResolve={noop} onOpenExisting={noop} onClose={noop} />
  )
  assert.ok(screen.getByText('Ep0 [1080p].mp4'))
  assert.ok(screen.getByText('Ep1 [1080p].mp4'))
  assert.ok(screen.getByLabelText('应用到全部'), '批量含「应用到全部」下拉')
  assert.ok(screen.getByRole('button', { name: '确定' }))
  assert.ok(screen.getByRole('button', { name: '取消' }))
  // 批量 foot 不是四决策按钮、不逐条打开
  assert.equal(screen.queryByRole('button', { name: '已存在 · 打开' }), null)
})

test('批量「应用到全部」= 全部覆盖 → 确定提交 { decision: overwrite }', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={BATCH}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  fireEvent.change(screen.getByLabelText('应用到全部'), { target: { value: 'overwrite' } })
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  assert.deepEqual(
    got,
    { conflictId: 'p1', decision: 'overwrite', perItem: undefined },
    '无逐条覆盖 → perItem undefined'
  )
})

test('批量逐条覆盖:默认全部跳过 + 第 0 条改覆盖 → { skip, perItem:{0:overwrite} }', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={BATCH}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  // 应用到全部默认 skip;把第 0 条改为「覆盖」
  fireEvent.change(screen.getByLabelText('处理方式:Ep0 [1080p].mp4'), {
    target: { value: 'overwrite' }
  })
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  assert.deepEqual(got, { conflictId: 'p1', decision: 'skip', perItem: { 0: 'overwrite' } })
})

test('批量逐条改回「继承」→ 从 perItem 移除', () => {
  let got: DuplicateResolution | null = null
  render(
    <DuplicateDialog
      open
      conflict={BATCH}
      onResolve={(r) => (got = r)}
      onOpenExisting={noop}
      onClose={noop}
    />
  )
  const sel = screen.getByLabelText('处理方式:Ep0 [1080p].mp4')
  fireEvent.change(sel, { target: { value: 'rename' } })
  fireEvent.change(sel, { target: { value: '' } }) // 改回继承
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  assert.deepEqual(got, { conflictId: 'p1', decision: 'skip', perItem: undefined })
})

test('取消 → onClose(不落地决策)', () => {
  let closed = 0
  let resolved = 0
  render(
    <DuplicateDialog
      open
      conflict={BATCH}
      onResolve={() => (resolved += 1)}
      onOpenExisting={noop}
      onClose={() => (closed += 1)}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.equal(closed, 1)
  assert.equal(resolved, 0, '取消不提交任何决策')
})
