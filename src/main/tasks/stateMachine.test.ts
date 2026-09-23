import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TaskStatus } from '../../shared/ipc'
import {
  canRetry,
  canTransition,
  isActiveState,
  isPostProcessing,
  isTerminalState,
  isVideoPreDownload,
  needsEngineSubmit,
  occupiesDownloadSlot
} from './stateMachine'

test('canTransition allows the Task 3 http state transitions', () => {
  const legalTransitions: Array<[TaskStatus, TaskStatus]> = [
    ['queued', 'downloading'],
    ['downloading', 'paused'],
    ['paused', 'downloading'],
    ['paused', 'queued'], // 满槽时「继续 / 全部开始」→ 排队等出队(修复④,spec §6.2 调整)
    ['downloading', 'completed'],
    ['queued', 'error'],
    ['downloading', 'error'],
    ['paused', 'error'],
    ['error', 'queued']
  ]

  for (const [from, to] of legalTransitions) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`)
  }
})

test('canTransition allows the Task 5 video state transitions (spec §4.2)', () => {
  const legalVideoTransitions: Array<[TaskStatus, TaskStatus]> = [
    ['resolving', 'awaiting_selection'], // 解析完成 → 待选
    ['resolving', 'queued'], // 自动选(占位默认清晰度)直接排队
    ['resolving', 'error'], // 解析失败
    ['awaiting_selection', 'queued'], // 用户选定 → 排队
    ['awaiting_selection', 'error'],
    ['downloading', 'processing'], // 视频后处理(合并 / 提取)
    ['processing', 'completed'], // 后处理完成
    ['processing', 'error'], // 后处理失败(如 ffmpeg 不可用)
    ['error', 'resolving'] // 视频解析失败重试 → 重解析
  ]

  for (const [from, to] of legalVideoTransitions) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`)
  }
})

test('canTransition rejects illegal and not-yet-driven transitions', () => {
  const illegalTransitions: Array<[TaskStatus, TaskStatus]> = [
    ['queued', 'completed'],
    ['downloading', 'queued'],
    ['paused', 'completed'],
    ['completed', 'queued'],
    ['error', 'downloading'],
    // 视频态非法流转(必须经合法中间态)
    ['resolving', 'downloading'], // 必须先选定 → queued
    ['resolving', 'completed'],
    ['awaiting_selection', 'downloading'], // 选定 → queued,不直跳 downloading
    ['awaiting_selection', 'processing'],
    ['processing', 'paused'], // 后处理不可暂停(spec §3.5)
    ['processing', 'downloading'],
    ['queued', 'processing'],
    ['completed', 'processing']
  ]

  for (const [from, to] of illegalTransitions) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`)
  }
})

test('state helpers classify terminal, active, engine-submit, and retry states', () => {
  assert.equal(isTerminalState('completed'), true)
  assert.equal(isTerminalState('error'), true)
  assert.equal(isTerminalState('queued'), false)

  assert.equal(isActiveState('downloading'), true)
  assert.equal(isActiveState('paused'), false)

  assert.equal(needsEngineSubmit('queued'), true)
  assert.equal(needsEngineSubmit('downloading'), true)
  assert.equal(needsEngineSubmit('paused'), true)
  assert.equal(needsEngineSubmit('completed'), false)

  assert.equal(canRetry('error'), true)
  assert.equal(canRetry('queued'), false)
})

test('video state predicates classify pre-download / post-processing / slot occupancy (spec §4.2 / §4.6)', () => {
  // isVideoPreDownload:resolving | awaiting_selection(不占下载槽、不入 dequeue)
  assert.equal(isVideoPreDownload('resolving'), true)
  assert.equal(isVideoPreDownload('awaiting_selection'), true)
  assert.equal(isVideoPreDownload('queued'), false)
  assert.equal(isVideoPreDownload('downloading'), false)

  // isPostProcessing:processing
  assert.equal(isPostProcessing('processing'), true)
  assert.equal(isPostProcessing('downloading'), false)

  // occupiesDownloadSlot:仅 downloading(processing 不占下载槽,§4.6)
  assert.equal(occupiesDownloadSlot('downloading'), true)
  assert.equal(occupiesDownloadSlot('processing'), false)
  assert.equal(occupiesDownloadSlot('resolving'), false)
  assert.equal(occupiesDownloadSlot('queued'), false)
})
