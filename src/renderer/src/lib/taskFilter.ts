import type { Task, TaskStatus } from '../../../shared/ipc'
import type { NavKey, NavCounts } from './types'

const ACTIVE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'downloading',
  'paused',
  'resolving',
  'awaiting_selection',
  'processing'
])
export function filterTasksByNav(tasks: Task[], nav: NavKey): Task[] {
  switch (nav) {
    case 'all':
      return tasks
    case 'active':
      return tasks.filter((t) => ACTIVE.has(t.status))
    case 'completed':
      return tasks.filter((t) => t.status === 'completed')
    case 'failed':
      return tasks.filter((t) => t.status === 'error')
    // BT 入口(v0.3 Task 3 · spec §6.4):状态维过滤 kind==='torrent',与类别维 categoryFilter 正交叠加
    case 'torrent':
      return tasks.filter((t) => t.kind === 'torrent')
    default:
      return tasks // 'settings' / 'history' 不用于列表
  }
}
export function countByNav(tasks: Task[]): NavCounts {
  return {
    all: tasks.length,
    active: tasks.filter((t) => ACTIVE.has(t.status)).length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'error').length,
    torrent: tasks.filter((t) => t.kind === 'torrent').length
  }
}
