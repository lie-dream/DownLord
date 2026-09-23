/**
 * 任务列表容器 — 渲染过滤后的任务行;为空时回退到空态。
 *
 * - 行回调经 spread 透传给每个 TaskRow(本 Task 不传 onSelectFormat → awaiting 态不出按钮)。
 */

import TaskRow, { type TaskRowProps } from './TaskRow'
import EmptyState from './EmptyState'
import type { Task } from '../../../shared/ipc'
import './TaskList.css'

type RowCbs = Omit<TaskRowProps, 'task'>
interface Props extends RowCbs {
  tasks: Task[]
  hasLoadedTasks: boolean
  searchActive: boolean
  onClearSearch: () => void
  onAddClick: () => void
}

export default function TaskList({
  tasks,
  hasLoadedTasks,
  searchActive,
  onClearSearch,
  onAddClick,
  ...cbs
}: Props): React.JSX.Element {
  // 三个展示 props 在此消费，不透传到行；空态不回显查询或来源。
  if (tasks.length === 0) {
    if (!hasLoadedTasks) return <EmptyState onAddClick={onAddClick} />
    if (searchActive) {
      return (
        <EmptyState
          title="没有搜索结果"
          description="当前导航和类别下没有匹配的任务。可更换关键词，或清除搜索。"
          action={
            <button type="button" className="btn btn-default" onClick={onClearSearch}>
              清除搜索
            </button>
          }
        />
      )
    }
    return (
      <EmptyState
        title="当前筛选下没有任务"
        description="试试其他导航或类别，或添加任务。"
        onAddClick={onAddClick}
      />
    )
  }
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} {...cbs} />
      ))}
    </div>
  )
}
