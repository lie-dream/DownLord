import type { TaskStatus } from '../../shared/ipc'

/**
 * 合法状态流转(spec §4.2)。http 子集(queued/downloading/paused/error/completed)为 Task 3 既有,
 * Task 5 补全视频态:resolving / awaiting_selection(下载前)+ processing(后处理),并扩展 error 重试目标。
 * 修复④:paused → queued —— 满槽时「继续 / 全部开始」让超额任务进队列排队(完成后自动出队),不卡死。
 */
const LEGAL_TRANSITIONS = new Map<TaskStatus, ReadonlySet<TaskStatus>>([
  // 视频:解析完成 → 待选 / 自动选直接排队 / 失败
  ['resolving', new Set<TaskStatus>(['awaiting_selection', 'queued', 'error'])],
  // 视频:用户选定 → 排队 / 失败
  ['awaiting_selection', new Set<TaskStatus>(['queued', 'error'])],
  ['queued', new Set<TaskStatus>(['downloading', 'error'])],
  // 增 processing(视频后处理:合并 / 音频提取)
  ['downloading', new Set<TaskStatus>(['paused', 'processing', 'completed', 'error'])],
  ['paused', new Set<TaskStatus>(['downloading', 'queued', 'error'])],
  // 视频:后处理 → 完成 / 失败(processing 不可暂停,§3.5)
  ['processing', new Set<TaskStatus>(['completed', 'error'])],
  // 重试:http → queued 重下;video 解析失败 → resolving 重解析
  ['error', new Set<TaskStatus>(['queued', 'resolving'])]
])

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false
}

export function isTerminalState(status: TaskStatus): boolean {
  return status === 'completed' || status === 'error'
}

export function isActiveState(status: TaskStatus): boolean {
  return status === 'downloading'
}

export function needsEngineSubmit(status: TaskStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'paused'
}

export function canRetry(status: TaskStatus): boolean {
  return status === 'error'
}

/** 视频下载前态:resolving / awaiting_selection(网络只读 / 等用户;不占下载槽、不入 dequeue,§4.6) */
export function isVideoPreDownload(status: TaskStatus): boolean {
  return status === 'resolving' || status === 'awaiting_selection'
}

/** 后处理态:processing(本地 ffmpeg 合并 / 提取,不可暂停,§3.5) */
export function isPostProcessing(status: TaskStatus): boolean {
  return status === 'processing'
}

/** 是否占用下载槽:仅 downloading(processing / 解析态均不占,与「最大并发下载数」语义正交,§4.6) */
export function occupiesDownloadSlot(status: TaskStatus): boolean {
  return status === 'downloading'
}
