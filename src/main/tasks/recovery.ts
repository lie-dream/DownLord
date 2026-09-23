import type { Task, TaskStatus } from '../../shared/ipc'

export interface RecoveryPlan {
  /** 重提交下载引擎(占下载槽,受并发上限约束):http downloading/queued + video downloading/processing */
  toSubmit: Task[]
  /** 排队等待出队:paused 保持 + 超并发的 submittable 溢出 */
  toQueue: Task[]
  /** 重解析(视频下载前态,formats 瞬时已丢):resolving / awaiting_selection(§4.4.5) */
  toResolve: Task[]
}

/** 重启可恢复的非终态(completed / error 仅作历史,不恢复) */
const RECOVERABLE_STATUSES = new Set<TaskStatus>([
  'resolving',
  'awaiting_selection',
  'queued',
  'downloading',
  'processing',
  'paused'
])

/** 视频下载前态:重解析(不占下载槽) */
const RESOLVE_STATUSES = new Set<TaskStatus>(['resolving', 'awaiting_selection'])

/** 占下载槽、可重提交引擎的态(http downloading/queued + video downloading/processing) */
const SUBMITTABLE_STATUSES = new Set<TaskStatus>(['downloading', 'queued', 'processing'])

/**
 * 重启恢复计划(spec §4.4.5;§7.4 续传归 aria2 `.aria2` / yt-dlp `.part`,不自存字节进度):
 * - resolving / awaiting_selection(**video**)→ `toResolve` 重解析(formats 是瞬时的);
 * - resolving / awaiting_selection(**torrent**)→ `toSubmit` 重提交引擎(元数据阶段:v0.3 Task 1 §6.2;
 *   待选阶段:v0.3 Task 2 §4.4 —— `start()` 先归位 awaiting_selection→resolving 再以 awaitSelection 重提;
 *   torrent 无 videoResolver,triggerResolve 只服务 video;元数据 / 待选态不占下载槽,§5.5,
 *   不参与 maxConcurrent 截断);
 * - downloading / queued(http / torrent)+ downloading / processing(视频)→ `toSubmit` 重提交,
 *   按 createdAt 取前 maxConcurrent 个(processing 重提交即降回下载重跑,简化处理);
 * - paused 保持 + 超并发 submittable → `toQueue`(等出队)。
 * 纯函数,不碰 IO。
 */
export function buildRecoveryPlan(tasks: Task[], maxConcurrent: number): RecoveryPlan {
  const unfinished = tasks.filter((task) => RECOVERABLE_STATUSES.has(task.status))

  const toResolve = unfinished.filter(
    (task) => task.kind !== 'torrent' && RESOLVE_STATUSES.has(task.status)
  )

  const submittable = unfinished
    .filter((task) => SUBMITTABLE_STATUSES.has(task.status))
    .sort((a, b) => a.createdAt - b.createdAt)
  // torrent 的元数据阶段(resolving)+ 待选(awaiting_selection)恒重提(不占槽 → 不受 maxConcurrent 截断,
  // §5.5 / v0.3 Task 2 §4.4);待选态由 start() 先归位 resolving 再重提(awaiting_selection→resolving 非合法边)
  const torrentMetadata = unfinished
    .filter(
      (task) =>
        task.kind === 'torrent' &&
        (task.status === 'resolving' || task.status === 'awaiting_selection')
    )
    .sort((a, b) => a.createdAt - b.createdAt)
  const toSubmit = [...submittable.slice(0, Math.max(0, maxConcurrent)), ...torrentMetadata]
  const toSubmitIds = new Set(toSubmit.map((task) => task.id))
  const toResolveIds = new Set(toResolve.map((task) => task.id))

  const toQueue = unfinished.filter(
    (task) => !toSubmitIds.has(task.id) && !toResolveIds.has(task.id)
  )

  return { toSubmit, toQueue, toResolve }
}
