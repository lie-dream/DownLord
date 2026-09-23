/**
 * 空态 — 复刻原型 .empty(圆形图标 + 标题 + 引导文案 + 动作按钮)。
 *
 * - 主列表(经 TaskList):默认「还没有下载任务」+「添加任务」主按钮(onAddClick)。
 * - 历史页(v0.2 Task 5 · spec §5.4):经可选 title / description / action 复用同一视觉表达两子态
 *   (「还没有下载历史」无按钮 /「没有匹配的历史记录」+「清除筛选」),默认值不变 → 主列表零回归。
 */

import './EmptyState.css'

interface Props {
  /** 主列表空态点击「添加任务」;历史页不传(改用 action / 无按钮) */
  onAddClick?: () => void
  /** 覆盖标题(默认 = 主列表引导文案,保证零回归) */
  title?: string
  /** 覆盖描述 */
  description?: string
  /**
   * 覆盖底部动作:
   * - undefined(默认)→「添加任务」主按钮(需 onAddClick),主列表零回归;
   * - null → 无按钮(历史「完全无历史」);
   * - ReactNode → 自定义按钮(历史「无匹配」的「清除筛选」)。
   */
  action?: React.ReactNode
}

export default function EmptyState({
  onAddClick,
  title = '还没有下载任务',
  description = '点击左上角「添加任务」,粘贴一个或多个直链即可开始下载。',
  action
}: Props): React.JSX.Element {
  return (
    <div className="empty">
      <div className="em-icon">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action !== undefined ? (
        action
      ) : onAddClick ? (
        <button className="btn btn-primary" onClick={onAddClick}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          添加任务
        </button>
      ) : null}
    </div>
  )
}
