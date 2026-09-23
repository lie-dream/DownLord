/**
 * 列表类型筛选纯函数(spec §4.3)。
 *
 * 与 `taskFilter.filterTasksByNav`(状态维)正交:主列表 =
 * `filterTasksByCategory(filterTasksByNav(tasks, nav), categoryFilter)`。
 * 两函数各自纯、可独立单测,组合即「状态 × 类别」二维筛选。过滤在渲染层做(与 Task 4 同构)。
 */
import type { Task } from '../../../shared/ipc'
import type { CategoryKey } from '../../../main/category/categoryModel'

/** chips 选中键:'all'(首位固定)+ 6 类(category:list 的 key,spec §2.1) */
export type CategoryFilterKey = 'all' | CategoryKey

/**
 * 'all' → 原样返回;具体类别 → 仅保留 `task.category === key`。
 * `category === null`(http 判定前 / 视频 resolving·awaiting 前置态)在具体类别下**不显示**,
 * 仅 'all' 时显示——尚未归类,符合直觉(spec §4.3)。
 */
export function filterTasksByCategory(tasks: Task[], key: CategoryFilterKey): Task[] {
  if (key === 'all') return tasks
  return tasks.filter((t) => t.category === key)
}
