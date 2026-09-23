import type { Task } from '../../../shared/ipc'
import type { StatusBarStats } from './types'
export function statusBarStats(tasks: Task[]): StatusBarStats {
  let totalSpeed = 0,
    activeCount = 0,
    queuedCount = 0,
    totalUpload = 0
  for (const t of tasks) {
    if (t.status === 'downloading') {
      totalSpeed += t.speed
      activeCount++
    } else if (t.status === 'queued') queuedCount++
    // 上行聚合(v0.3 Task 3 · spec §6.5):仅做种中 / 下载中(BT 边下边传)任务计入 uploadSpeed(运行时富进度,不落库)。
    // 门控 seeding || downloading:停止做种后广播仅带 {seeding:false}、uploadSpeed 可能残留旧值 → 排除已停任务,避免幻影上行。
    if ((t.seeding || t.status === 'downloading') && t.uploadSpeed) totalUpload += t.uploadSpeed
  }
  return { totalSpeed, activeCount, queuedCount, totalUpload }
}
