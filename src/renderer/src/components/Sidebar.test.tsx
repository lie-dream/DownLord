/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import Sidebar from './Sidebar'
import NavItem from './NavItem'
import type { NavCounts, NavKey } from '../lib/types'

afterEach(cleanup)

const counts: NavCounts = { all: 3, active: 2, completed: 1, failed: 0, torrent: 1 }

test('渲染任务区 4 项 + 计数 + 功能区两项(已无 soon 占位)', () => {
  render(<Sidebar nav="all" counts={counts} onNavChange={() => {}} onAddClick={() => {}} />)
  assert.ok(screen.getByText('全部'))
  assert.ok(screen.getByText('下载中'))
  assert.ok(screen.getByText('已完成'))
  assert.ok(screen.getByText('失败'))
  assert.ok(screen.getByText('3'))
  // v0.4 Task 5:「网页嗅探」「浏览器接管」两行 soon 合并激活为一行「浏览器扩展」
  assert.ok(screen.getByText('浏览器扩展'))
  assert.equal(screen.queryByText('网页嗅探'), null)
  assert.equal(screen.queryByText('浏览器接管'), null)
})

// v0.4 Task 5 — 左导航不再有任何 soon:接管在 Task 4 已交付、嗅探在 Task 5 交付,
// 还写「即将推出」是不诚实(spec §5.1)
test('★ 功能区已无「即将推出」占位(零命中判据,配正向对照)', () => {
  render(<Sidebar nav="all" counts={counts} onNavChange={() => {}} onAddClick={() => {}} />)
  assert.equal(screen.queryAllByText('即将推出').length, 0)
  // 正向对照:soon 标签的渲染路径本身还在(NavItem 仍支持 soon),故上面的 0 是「真没有」而非 query 恒空
  render(<NavItem icon={null} label="占位项" soon />)
  assert.equal(screen.queryAllByText('即将推出').length, 1)
})

// v0.4 Task 5 — 「浏览器扩展」是**独立页型**激活(与历史 / 设置同类):可点、无计数
test('点「浏览器扩展」触发 onNavChange(extension)', () => {
  let picked: NavKey | '' = ''
  render(
    <Sidebar nav="all" counts={counts} onNavChange={(k) => (picked = k)} onAddClick={() => {}} />
  )
  fireEvent.click(screen.getByText('浏览器扩展'))
  assert.equal(picked, 'extension')
})

test('★「浏览器扩展」**不显示计数**(它不筛任务,不是 BT 那种状态维过滤型)', () => {
  const { container } = render(
    <Sidebar
      nav="extension"
      counts={{ all: 5, active: 0, completed: 0, failed: 0, torrent: 4 }}
      onNavChange={() => {}}
      onAddClick={() => {}}
    />
  )
  const row = Array.from(container.querySelectorAll('.nav-item')).find(
    (e) => e.querySelector('.text')?.textContent === '浏览器扩展'
  )
  assert.ok(row)
  assert.equal(row?.querySelector('.nav-count'), null)
  // 对照:同在功能区的 BT 是状态维过滤型,它有计数 —— 证明上面的「无 .nav-count」不是 selector 写错
  const bt = Array.from(container.querySelectorAll('.nav-item')).find(
    (e) => e.querySelector('.text')?.textContent === 'BT · 磁力'
  )
  assert.equal(bt?.querySelector('.nav-count')?.textContent, '4')
  // active 态落在这一行上(nav==='extension')
  assert.ok(row?.className.includes('active'))
})

// v0.3 Task 3 — BT 入口激活:可点触发 onNavChange('torrent'),不再是 soon 占位
test('点「BT · 磁力」触发 onNavChange(torrent)(激活为可点)', () => {
  let picked: NavKey | '' = ''
  render(
    <Sidebar nav="all" counts={counts} onNavChange={(k) => (picked = k)} onAddClick={() => {}} />
  )
  fireEvent.click(screen.getByText('BT · 磁力'))
  assert.equal(picked, 'torrent')
})

test('BT 显示计数(counts.torrent)', () => {
  render(
    <Sidebar
      nav="all"
      counts={{ all: 5, active: 0, completed: 0, failed: 0, torrent: 4 }}
      onNavChange={() => {}}
      onAddClick={() => {}}
    />
  )
  assert.ok(screen.getByText('4'))
})

test('点任务项触发 onNavChange', () => {
  let picked: NavKey | '' = ''
  render(
    <Sidebar nav="all" counts={counts} onNavChange={(k) => (picked = k)} onAddClick={() => {}} />
  )
  fireEvent.click(screen.getByText('已完成'))
  assert.equal(picked, 'completed')
})

test('点设置触发 onNavChange(settings)', () => {
  let picked: NavKey | '' = ''
  render(
    <Sidebar nav="all" counts={counts} onNavChange={(k) => (picked = k)} onAddClick={() => {}} />
  )
  fireEvent.click(screen.getByText('设置'))
  assert.equal(picked, 'settings')
})

// NavItem 的 soon 能力仍在(留给后续未交付功能),只是 v0.4 Task 5 起左导航不再有任何 soon 项
test('soon 项不可点(不触发 onClick)', () => {
  let called = false
  render(<NavItem icon={null} label="占位项" soon onClick={() => (called = true)} />)
  fireEvent.click(screen.getByText('占位项'))
  assert.equal(called, false)
})

test('点添加任务触发 onAddClick', () => {
  let clicked = false
  render(
    <Sidebar nav="all" counts={counts} onNavChange={() => {}} onAddClick={() => (clicked = true)} />
  )
  fireEvent.click(screen.getByText('添加任务'))
  assert.equal(clicked, true)
})
