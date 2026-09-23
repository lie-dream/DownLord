import type { Task } from '../../../shared/ipc'

/** 仅归一用于匹配的副本；受控输入仍保留用户原文，内部空格和URL标点按字面。 */
export function normalizeTaskSearchQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * 仅派生已加载任务的展示子集，不查询/持久化、不改变任务身份或顺序。
 * source可能含私人URL：只在内存匹配，不扩展为展示、日志或网络输出。
 */
export function filterTasksBySearch(tasks: Task[], query: string): Task[] {
  const normalized = normalizeTaskSearchQuery(query)
  if (normalized === '') return tasks
  return tasks.filter(
    (task) =>
      task.filename.toLowerCase().includes(normalized) ||
      task.source.toLowerCase().includes(normalized)
  )
}
