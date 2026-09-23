/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { FormatChoice, ResolvedPlaylist } from '../../../shared/ipc'
import BatchDialog from './BatchDialog'

afterEach(cleanup)

const mockPlaylist: ResolvedPlaylist = {
  kind: 'playlist',
  title: '挪威风光合集',
  entries: [
    { id: 'a', title: '第一集 · 峡湾', url: 'https://x/a', durationSec: 215 },
    { id: 'b', title: '第二集 · 极光', url: 'https://x/b', durationSec: 320 },
    { id: 'c', title: '第三集 · 冰川', url: 'https://x/c', durationSec: null }
  ]
}

test('open=false 时不渲染', () => {
  render(
    <BatchDialog open={false} playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />
  )
  assert.equal(screen.queryByText(/批量下载/), null)
})

test('渲染标题 / 全部条目 / 默认全选计数', () => {
  render(<BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />)
  assert.ok(screen.getByRole('heading', { name: /批量下载/ }))
  assert.ok(screen.getByText(/挪威风光合集/))
  assert.ok(screen.getByText('第一集 · 峡湾'))
  assert.ok(screen.getByText('第二集 · 极光'))
  assert.ok(screen.getByText('第三集 · 冰川'))
  // 时长格式化(215s → 3:35);null 时长不渲染数值
  assert.ok(screen.getByText('3:35'))
  // 默认全选
  assert.ok(screen.getByText('已选 3 / 共 3'))
})

test('反选:全选态 → 反选 → 全不选;再反选 → 全选(真正互换)', () => {
  render(<BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />)
  fireEvent.click(screen.getByText('反选')) // 默认全选 → 反选 → 全不选
  assert.ok(screen.getByText('已选 0 / 共 3'))
  fireEvent.click(screen.getByText('反选')) // 全不选 → 反选 → 全选
  assert.ok(screen.getByText('已选 3 / 共 3'))
})

test('反选:部分选中 → 已选与未选互换', () => {
  let picks: number[] | null = null
  render(
    <BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={(p) => (picks = p)} />
  )
  fireEvent.click(screen.getByText('第二集 · 极光')) // 全选 → 取消第 2 条 → {0,2}
  assert.ok(screen.getByText('已选 2 / 共 3'))
  fireEvent.click(screen.getByText('反选')) // {0,2} → 反选 → {1}(已选变未选、未选变已选)
  assert.ok(screen.getByText('已选 1 / 共 3'))
  fireEvent.click(screen.getByText(/下载选中/))
  assert.deepEqual(picks, [1], '反选后仅原未选的第二集(index 1)被选中')
})

test('点单条切换勾选 → 计数更新', () => {
  render(<BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />)
  fireEvent.click(screen.getByText('第二集 · 极光'))
  assert.ok(screen.getByText('已选 2 / 共 3'))
})

test('下载选中:默认全选 + 最高策略 → onSubmit(全部序号, {audioOnly:false})', () => {
  let picks: number[] | null = null
  let policy: FormatChoice | null = null
  render(
    <BatchDialog
      open
      playlist={mockPlaylist}
      onClose={() => {}}
      onSubmit={(p, pol) => {
        picks = p
        policy = pol
      }}
    />
  )
  fireEvent.click(screen.getByText(/下载选中/))
  assert.deepEqual(picks, [0, 1, 2])
  assert.deepEqual(policy, { audioOnly: false })
})

test('选 720P 策略 + 取消勾选第三条 → onSubmit 反映 picks 与 heightCap', () => {
  let picks: number[] | null = null
  let policy: FormatChoice | null = null
  render(
    <BatchDialog
      open
      playlist={mockPlaylist}
      onClose={() => {}}
      onSubmit={(p, pol) => {
        picks = p
        policy = pol
      }}
    />
  )
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '720' } })
  fireEvent.click(screen.getByText('第三集 · 冰川'))
  fireEvent.click(screen.getByText(/下载选中/))
  assert.deepEqual(picks, [0, 1])
  assert.deepEqual(policy, { audioOnly: false, heightCap: 720 })
})

test('开「仅音频 MP3」开关 → onSubmit policy.audioOnly=true', () => {
  let policy: FormatChoice | null = null
  render(
    <BatchDialog
      open
      playlist={mockPlaylist}
      onClose={() => {}}
      onSubmit={(_p, pol) => (policy = pol)}
    />
  )
  fireEvent.click(screen.getByRole('switch'))
  fireEvent.click(screen.getByText(/下载选中/))
  assert.deepEqual(policy, { audioOnly: true })
})

test('未选任何条目 → 下载按钮禁用', () => {
  render(<BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />)
  fireEvent.click(screen.getByText('反选'))
  const btn = screen.getByText(/下载选中/).closest('button') as HTMLButtonElement
  assert.equal(btn.disabled, true)
})

test('点取消 / × 触发 onClose', () => {
  let closed = 0
  render(
    <BatchDialog open playlist={mockPlaylist} onClose={() => (closed += 1)} onSubmit={() => {}} />
  )
  fireEvent.click(screen.getByText('取消'))
  fireEvent.click(screen.getByTitle('关闭'))
  assert.equal(closed, 2)
})

test('点遮罩不关闭(防误触)', () => {
  let closed = false
  const { container } = render(
    <BatchDialog open playlist={mockPlaylist} onClose={() => (closed = true)} onSubmit={() => {}} />
  )
  fireEvent.click(container.querySelector('.overlay') as Element)
  assert.equal(closed, false)
})

// ==================== v1.0 Task 3 · P2「UI 文案」新增用例 ====================
// 逐字文案真源 = spec §4「如实说清单」;本段全部为**新增**。

test('M-026 头部交代按整列表处理 + 给出单集出路', () => {
  render(<BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />)
  const note = screen.getByText(
    '这个链接带播放列表参数,故按整个列表处理。只想下其中一集?用该集的分享链接(形如 youtu.be/<id>)单独添加。'
  )
  // ★ 位置:计数行**上方** —— 用户先读到「为什么是整列表」,再看到「已选 3 / 共 3」,
  //   顺序反了就会先被计数吓一跳(以为解析错了),这正是 M-026 的现象
  const body = note.closest('.dialog-body') as HTMLElement
  const kids = Array.from(body.children)
  assert.ok(
    kids.indexOf(note) < kids.findIndex((el) => el.classList.contains('batch-bar')),
    '说明应排在全选 / 计数条之前'
  )
  // 出路必须是**可操作**的,不能只说「这是设计如此」
  assert.ok(note.textContent?.includes('只想下其中一集'))
  assert.ok(note.textContent?.includes('youtu.be/<id>'))
})

// v1.0 Task 3 Step 5:裸跑未复现,不猜改表达式,按授权在操作现场交付限制说明。
test('M-025 批量失败边界在操作现场如实说明', () => {
  const view = render(
    <BatchDialog open playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />
  )
  const note = screen.getByText(
    'YouTube 播放列表批量下载当前不可用,请改用单视频分享链接 youtu.be/<id>'
  )
  const children = Array.from((note.closest('.dialog-body') as HTMLElement).children)
  assert.ok(children.indexOf(note) < children.findIndex((el) => el.classList.contains('batch-bar')))
  // 只提示已知的 YouTube 边界,不禁用其他站点的正常批量操作。
  assert.equal((screen.getByText(/下载选中/).closest('button') as HTMLButtonElement).disabled, false)
  view.rerender(
    <BatchDialog open={false} playlist={mockPlaylist} onClose={() => {}} onSubmit={() => {}} />
  )
  assert.equal(screen.queryByText(/YouTube 播放列表批量下载当前不可用/), null)
  view.rerender(<BatchDialog open playlist={null} onClose={() => {}} onSubmit={() => {}} />)
  assert.equal(screen.queryByText(/YouTube 播放列表批量下载当前不可用/), null)
})
