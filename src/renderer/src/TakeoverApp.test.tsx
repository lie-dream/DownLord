/// <reference types="node" />

/**
 * 接管小窗口外壳的接线单测(R-04 的另一半;v0.4 Task 4 · spec §4.3)。
 *
 * `TakeoverDialog.test.tsx` 测的是**组件**(回调参数逐字透传);本文件测的是**外壳把那些回调
 * 接到了 `window.takeoverApi` 的哪一条上** —— 两者少一个,「点了四决策却没送到主进程」这类
 * 接线错就没有任何机器守卫(组件测试全绿,功能是坏的)。
 *
 * ⚠️ 单跑本文件须带 `TSX_TSCONFIG_PATH=tsconfig.web.json`(既有踩坑)。
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  AppSettings,
  CategoryConfig,
  DuplicateConflict,
  ResolvedTheme,
  TakeoverApi,
  TakeoverBatch,
  TakeoverSubmitPayload
} from '../../shared/ipc'
import TakeoverApp from './TakeoverApp'

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).takeoverApi
})

const DEFAULT_DIR = 'D:\\Downloads'

const BATCH: TakeoverBatch = {
  theme: 'dark',
  items: [
    {
      id: 'tk_1',
      url: 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe',
      host: 'uu.gdl.netease.com',
      filename: 'UU-6.15.1.exe',
      totalBytes: 1000,
      kind: 'http'
    }
  ]
}

function conflictOf(conflictId: string, filename = 'UU-6.15.1.exe'): DuplicateConflict {
  return {
    conflictId,
    kind: 'http',
    items: [
      {
        index: 0,
        filename,
        qualityLabel: null,
        existingDir: DEFAULT_DIR,
        existingPath: `${DEFAULT_DIR}\\${filename}`,
        existing: 'completed'
      }
    ]
  }
}

interface Stub {
  api: TakeoverApi
  pushBatch(batch: TakeoverBatch): void
  pushDuplicate(conflict: DuplicateConflict): void
  calls: string[]
  resolved: unknown[]
  submits: TakeoverSubmitPayload[]
  opened: string[]
  readyCount: () => number
}

function installStub(): Stub {
  let onPresent: ((b: TakeoverBatch) => void) | null = null
  let onDuplicate: ((c: DuplicateConflict) => void) | null = null
  const calls: string[] = []
  const resolved: unknown[] = []
  const submits: TakeoverSubmitPayload[] = []
  const opened: string[] = []
  let readyCount = 0

  const api: TakeoverApi = {
    onPresent: (cb) => {
      onPresent = cb
      return () => void (onPresent = null)
    },
    onDuplicate: (cb) => {
      onDuplicate = cb
      return () => void (onDuplicate = null)
    },
    ready: () => void (readyCount += 1),
    submit: (p) => void submits.push(p),
    dismiss: () => void calls.push('dismiss'),
    duplicatesSettled: () => void calls.push('settled'),
    resolveDuplicate: async (res) => {
      calls.push('resolveDuplicate')
      resolved.push(res)
    },
    openPath: async (p) => {
      calls.push('openPath')
      opened.push(p)
      return ''
    },
    showItemInFolder: async (p) => {
      calls.push('showItemInFolder')
      opened.push(p)
      return ''
    },
    selectDirectory: async () => null,
    getSettings: async () => ({ defaultDir: DEFAULT_DIR }) as AppSettings,
    listCategories: async () => [] as CategoryConfig[],
    onThemeChanged: (_cb: (t: ResolvedTheme) => void) => () => {}
  }
  ;(window as unknown as Record<string, unknown>).takeoverApi = api

  return {
    api,
    pushBatch: (batch) => act(() => onPresent?.(batch)),
    pushDuplicate: (conflict) => act(() => onDuplicate?.(conflict)),
    calls,
    resolved,
    submits,
    opened,
    readyCount: () => readyCount
  }
}

// ─────────────────────────────────────────────────────────────────────────────

test('外壳挂载 → 取设置 / 类别后才 ready();present 到达即渲染', async () => {
  const stub = installStub()
  render(<TakeoverApp />)

  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)
  assert.ok(screen.getByText('接管下载'))
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', '主题随批次下发')
})

test('★ 态 C 接线:duplicate 到达 → 换查重框;点决策 → takeoverApi.resolveDuplicate 参数逐字透传', async () => {
  const stub = installStub()
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)

  stub.pushDuplicate(conflictOf('task_7'))
  assert.ok(screen.getByText('检测到重复下载'))
  assert.equal(screen.queryByText('接管下载'), null, '同一窗口内换内容')

  await act(async () => fireEvent.click(screen.getByText('重命名')))

  assert.deepStrictEqual(stub.resolved, [{ conflictId: 'task_7', decision: 'rename' }])
  // 队列清空 → 回报主进程(它据此推进下一批 / 关窗:**点完四决策才关窗**)
  assert.deepEqual(stub.calls, ['resolveDuplicate', 'settled'])
  assert.equal(screen.queryByText('检测到重复下载'), null, '出队后查重框消失')
})

test('★ 串行队列:两条冲突依次弹,**都在同一个窗口内**,只在最后一条点完才回报 settled', async () => {
  const stub = installStub()
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)

  stub.pushDuplicate(conflictOf('task_7', 'a.exe'))
  stub.pushDuplicate(conflictOf('task_8', 'b.zip'))

  // 队首唯一渲染
  assert.ok(screen.getByText('a.exe'))
  assert.equal(screen.queryByText('b.zip'), null)

  await act(async () => fireEvent.click(screen.getByText('跳过')))
  assert.ok(screen.getByText('b.zip'), '第二条接着弹,同一个窗口')
  assert.equal(stub.calls.filter((c) => c === 'settled').length, 0, '还有一条没点完,不许回报')

  await act(async () => fireEvent.click(screen.getByText('覆盖')))
  assert.deepStrictEqual(stub.resolved, [
    { conflictId: 'task_7', decision: 'skip' },
    { conflictId: 'task_8', decision: 'overwrite' }
  ])
  assert.equal(stub.calls.filter((c) => c === 'settled').length, 1, '★ 全部点完才回报一次')
})

test('「已存在 · 打开」接线:completed → openPath;diskOnly → showItemInFolder', async () => {
  const stub = installStub()
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)

  stub.pushDuplicate(conflictOf('task_7'))
  await act(async () => fireEvent.click(screen.getByText('已存在 · 打开')))
  assert.ok(stub.calls.includes('openPath'))
  assert.deepEqual(stub.opened, [`${DEFAULT_DIR}\\UU-6.15.1.exe`])

  const diskOnly = conflictOf('task_8', 'c.bin')
  diskOnly.items[0].existing = 'diskOnly'
  stub.pushDuplicate(diskOnly)
  await act(async () => fireEvent.click(screen.getByText('已存在 · 打开')))
  assert.ok(stub.calls.includes('showItemInFolder'))
})

test('提交 / 取消接线:submit 与 dismiss 各走各的通道', async () => {
  const stub = installStub()
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)

  fireEvent.click(screen.getByText('开始下载'))
  assert.deepStrictEqual(stub.submits, [
    { items: [{ id: 'tk_1', filename: 'UU-6.15.1.exe' }], dir: DEFAULT_DIR }
  ])

  cleanup()
  const stub2 = installStub()
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub2.readyCount(), 1))
  stub2.pushBatch(BATCH)
  fireEvent.click(screen.getByText('取消'))
  assert.deepEqual(stub2.calls, ['dismiss'])
})

test('M-011 覆盖处理中不提前 settled;失败原位可见且可重新选择重命名', async () => {
  const stub = installStub()
  let reject!: (reason: Error) => void
  const blocked = new Promise<void>((_resolve, fail) => { reject = fail })
  stub.api.resolveDuplicate = (res) => {
    stub.calls.push('resolveDuplicate')
    stub.resolved.push(res)
    return res.decision === 'overwrite' ? blocked : Promise.resolve()
  }
  render(<TakeoverApp />)
  await waitFor(() => assert.equal(stub.readyCount(), 1))
  stub.pushBatch(BATCH)
  stub.pushDuplicate(conflictOf('safe_http'))
  fireEvent.click(screen.getByRole('button', { name: '覆盖' }))
  assert.equal(stub.calls.includes('settled'), false, '真实决策未返回,不能提前关窗')
  assert.ok(screen.getByText('检测到重复下载'))
  for (const label of ['覆盖', '重命名', '跳过', '关闭', '已存在 · 打开']) {
    assert.equal(screen.getByRole('button', { name: label }).hasAttribute('disabled'), true)
  }
  fireEvent.keyDown(window, { key: 'Escape' })
  assert.equal(stub.resolved.length, 1, '处理中 Esc 不能另发 skip')
  await act(async () => reject(new Error('覆盖失败:文件仍被占用,请稍后重试')))
  assert.equal(screen.getByRole('alert').textContent, '覆盖失败:文件仍被占用,请稍后重试')
  assert.ok(screen.getByText('检测到重复下载'), '失败保留当前冲突')
  assert.equal(stub.calls.includes('settled'), false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '重命名' })))
  assert.deepEqual(stub.resolved, [
    { conflictId: 'safe_http', decision: 'overwrite' },
    { conflictId: 'safe_http', decision: 'rename' }
  ])
  assert.equal(stub.calls.filter((c) => c === 'settled').length, 1)
  assert.equal(screen.queryByText('检测到重复下载'), null)
  assert.equal(screen.queryByRole('alert'), null)
})
