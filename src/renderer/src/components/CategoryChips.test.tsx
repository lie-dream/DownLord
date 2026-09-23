/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import CategoryChips from './CategoryChips'
import type { CategoryConfig } from '../../../shared/ipc'
import type { CategoryFilterKey } from '../lib/categoryFilter'

afterEach(cleanup)

// 仿 category:list 下发(完整字段;chips 只读 key + displayName,extensions/savePath 为新增增量)
const categories: CategoryConfig[] = [
  {
    key: 'video',
    displayName: '视频',
    extensions: ['mp4', 'mkv'],
    savePath: 'D:/DL/Videos',
    isCustom: false
  },
  {
    key: 'audio',
    displayName: '音频',
    extensions: ['mp3', 'flac'],
    savePath: 'D:/DL/Music',
    isCustom: false
  },
  {
    key: 'archive',
    displayName: '压缩包',
    extensions: ['zip', '7z'],
    savePath: 'D:/DL/Archives',
    isCustom: false
  },
  {
    key: 'document',
    displayName: '文档',
    extensions: ['pdf', 'docx'],
    savePath: 'D:/DL/Documents',
    isCustom: false
  },
  {
    key: 'program',
    displayName: '程序',
    extensions: ['exe', 'msi'],
    savePath: 'D:/DL/Programs',
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: 'D:/DL', isCustom: false }
]

test('渲染固定首位「全部」+ categories 各 chip(displayName 来自 props)', () => {
  render(<CategoryChips categories={categories} value="all" onChange={() => {}} />)
  // 固定首位「全部」+ 6 类
  assert.ok(screen.getByText('全部'))
  assert.ok(screen.getByText('视频'))
  assert.ok(screen.getByText('音频'))
  assert.ok(screen.getByText('压缩包'))
  assert.ok(screen.getByText('文档'))
  assert.ok(screen.getByText('程序'))
  assert.ok(screen.getByText('其他'))
  // 不带计数:chip 文本即 displayName,无数字计数(对齐原型)
  assert.equal(screen.queryByText(/\d/), null)
})

test('value 决定 active 态(选中态走 .chip.active)', () => {
  const { rerender } = render(
    <CategoryChips categories={categories} value="all" onChange={() => {}} />
  )
  assert.ok(screen.getByText('全部').classList.contains('active'))
  assert.equal(screen.getByText('视频').classList.contains('active'), false)

  rerender(<CategoryChips categories={categories} value="video" onChange={() => {}} />)
  assert.ok(screen.getByText('视频').classList.contains('active'))
  assert.equal(screen.getByText('全部').classList.contains('active'), false)
})

test('点击 chip 触发 onChange(key)', () => {
  const picked: CategoryFilterKey[] = []
  render(<CategoryChips categories={categories} value="all" onChange={(k) => picked.push(k)} />)
  fireEvent.click(screen.getByText('视频'))
  fireEvent.click(screen.getByText('其他'))
  fireEvent.click(screen.getByText('全部'))
  assert.deepEqual(picked, ['video', 'other', 'all'])
})

test('空 categories → 仅渲染「全部」', () => {
  render(<CategoryChips categories={[]} value="all" onChange={() => {}} />)
  assert.ok(screen.getByText('全部'))
  assert.equal(screen.queryByText('视频'), null)
})
