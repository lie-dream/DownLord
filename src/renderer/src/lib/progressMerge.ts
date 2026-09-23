import type { Task, TaskProgress } from '../../../shared/ipc'
export function progressMerge(tasks: Task[], progresses: TaskProgress[]): Task[] {
  if (progresses.length === 0) return tasks
  const byId = new Map(progresses.map((p) => [p.id, p]))
  let changed = false
  const next = tasks.map((t) => {
    const p = byId.get(t.id)
    if (!p) return t
    changed = true
    // BT 富进度(v0.3 Task 3 · 运行时内存态,不落库):connections 对所有任务透传;
    // seeding/uploadSpeed/uploadLength/numSeeders 仅 torrent 帧带(http/video 帧不含 → 保留旧值即 undefined)。
    // limitKBps 用 `in` 判定而非 `??`(v0.3 Task 4 #25):帧恒带该键,清除任务级覆盖时值就是 undefined,
    // `??` 会把「跟随全局」吞成旧数值 → radio 回显不生效(要等 loadTasks 全量重拉才对)。
    return {
      ...t,
      status: p.status,
      filename: p.filename ?? t.filename,
      savePath: p.savePath ?? t.savePath,
      category: p.category !== undefined ? p.category : t.category,
      downloadedBytes: p.downloadedBytes,
      totalBytes: p.totalBytes,
      speed: p.speed,
      error: p.error ?? t.error,
      limitKBps: 'limitKBps' in p ? p.limitKBps : t.limitKBps,
      connections: p.connections ?? t.connections,
      seeding: p.seeding ?? t.seeding,
      uploadSpeed: p.uploadSpeed ?? t.uploadSpeed,
      uploadLength: p.uploadLength ?? t.uploadLength,
      numSeeders: p.numSeeders ?? t.numSeeders
    }
  })
  return changed ? next : tasks
}
