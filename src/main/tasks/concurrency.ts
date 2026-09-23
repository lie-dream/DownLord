import type { Task } from '../../shared/ipc'

export interface DequeueResult {
  toStart: Task[]
  activeCount: number
}

export function dequeueNext(tasks: Task[], maxConcurrent: number): DequeueResult {
  const activeCount = tasks.filter((task) => task.status === 'downloading').length
  const availableSlots = Math.max(0, maxConcurrent - activeCount)
  const toStart = tasks
    .filter((task) => task.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, availableSlots)

  return { toStart, activeCount }
}
