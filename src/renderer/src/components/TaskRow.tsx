/**
 * 任务行 — 对齐原型 .task,覆盖 DESIGN §5 全 8 态(React.memo,仅关键字段变化时重渲染)。
 *
 * - 视图描述来自 lib/taskView 纯函数(状态 → iconCategory / sub / progress / meta / speed / actions)。
 * - 直链(http)实际驱动 5 态(queued/downloading/paused/completed/error);
 *   视频专属 3 态(resolving/awaiting_selection/processing)视觉到位但本 Task 不触发(留 Task 5)。
 * - selectFormat 动作仅当父组件传入 onSelectFormat 时渲染(本 Task 不传 → 不出死按钮)。
 * - 纯展示:仅经 props 回调通信,不含下载 / 解析逻辑。
 */

import { memo } from 'react'
import type { Task } from '../../../shared/ipc'
import type { TaskRowView } from '../lib/types'
import { taskView } from '../lib/taskView'
import { formatPercent, formatSpeed } from '../lib/format'
import TaskRowMoreMenu from './TaskRowMoreMenu'
import TaskRowLimitMenu from './TaskRowLimitMenu'
import './TaskRow.css'

export interface TaskRowProps {
  task: Task
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  /** 三语义删除:completed 菜单「从列表删除」(false)/「删除文件」(true)+ 中间态行内删除(false);后端据此删文件 / 清残留(§1/§5) */
  onRemove: (id: string, deleteFile: boolean) => void
  onRetry: (id: string) => void
  onOpenFile: (savePath: string) => void
  onShowInFolder: (savePath: string) => void
  /**
   * 单任务限速(downloading / paused 态限速 popover 应用)→ TasksContext.setTaskLimit(§5.3);不传 → 不出限速入口。
   * 三态(v0.3 Task 4 #25):`null` = 跟随全局(清除任务级覆盖)/ `0` = 本任务不限 / `>0` = KB/s 限速值。
   */
  onLimit?: (id: string, kbps: number | null) => void
  /** 本 Task 不传 → awaiting_selection 态不出「选择清晰度」按钮(Task 5 传入真实回调) */
  onSelectFormat?: (id: string) => void
  /** 停止做种(v0.3 Task 3):仅 torrent 做种中(seeding)态渲染,中性图标 → onStopSeeding(id);不传 → 不出按钮 */
  onStopSeeding?: (id: string) => void
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/* ---------- 类别图标(原型 .t-icon svg)---------- */
const IconVideo = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="m22 8-6 4 6 4V8Z" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </svg>
)
const IconAudio = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
)
const IconFile = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <path d="M14 2v6h6" />
  </svg>
)
function categoryIcon(category: TaskRowView['iconCategory']): React.JSX.Element {
  switch (category) {
    case 'video':
      return <IconVideo />
    case 'audio':
      return <IconAudio />
    // file 与 error 同用文件图标,仅 .t-icon 配色不同(error → danger)
    default:
      return <IconFile />
  }
}

/* ---------- 副信息图标(ok / err)---------- */
const IconCheck = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
const IconAlert = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
)

/* ---------- 操作图标 ---------- */
const IconPause = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)
const IconPlay = (): React.JSX.Element => (
  <svg {...svgProps}>
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)
const IconClose = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
)
const IconRetry = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)
const IconFolder = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
)
// 「打开文件」用中性的外部打开图标(↗),不复用 ▶ 播放图标 —— 压缩包 / 文档非媒体亦适用
const IconOpen = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
  </svg>
)
const IconTrash = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
// 「停止做种」中性图标(非 danger):方形停止符号,语义=停止上传分享;不删文件(§2.5 / DESIGN §5)
const IconStopSeed = (): React.JSX.Element => (
  <svg {...svgProps}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
)

/* ---------- 子区渲染 ---------- */
function renderSub(v: TaskRowView): React.JSX.Element {
  switch (v.sub.kind) {
    case 'ok':
      return (
        <span className="ok">
          <IconCheck />
          {v.sub.text}
        </span>
      )
    case 'err':
      return (
        <span className="err">
          <IconAlert />
          {v.sub.text}
        </span>
      )
    case 'warn':
      return <span className="warn">{v.sub.text}</span>
    default:
      return <span>{v.sub.text}</span>
  }
}

function renderBar(v: TaskRowView, pct: string): React.JSX.Element | null {
  switch (v.progress) {
    case 'determinate':
      return (
        <div className="bar">
          <span style={{ width: pct }} />
        </div>
      )
    case 'paused':
      return (
        <div className="bar paused">
          <span style={{ width: pct }} />
        </div>
      )
    case 'indeterminate':
      return (
        <div className="bar indet">
          <span />
        </div>
      )
    case 'processing':
      return (
        <div className="bar proc indet">
          <span />
        </div>
      )
    default:
      return null
  }
}

function renderMeta(v: TaskRowView, pct: string, status: Task['status']): React.JSX.Element | null {
  if (v.meta.kind === 'percent') {
    return <div className={`t-pct${status === 'paused' ? ' muted' : ''}`}>{pct}</div>
  }
  if (v.meta.kind === 'pill') {
    return <span className={`pill ${v.meta.pillKind ?? 'wait'}`}>{v.meta.pillText}</span>
  }
  return null
}

function renderSpeed(v: TaskRowView, task: Task): React.JSX.Element | null {
  switch (v.speedTone) {
    case 'brand':
      return <div className="t-speed">↓ {formatSpeed(task.speed)}</div>
    // 做种上行(v0.3 Task 3):↑ + success 绿(与下行蓝区分,语义=分享出去)
    case 'upload':
      return <div className="t-speed upload">↑ {formatSpeed(task.uploadSpeed ?? 0)}</div>
    case 'muted':
      return <div className="t-speed muted">已暂停</div>
    case 'warning':
      return <div className="t-speed warning">处理中</div>
    default:
      return null
  }
}

/** 视频中间态:删除 = 未完成删除(行内 IconTrash),经 onRemove(id,false) 触发后端残留清理(§3/§4) */
const INTERMEDIATE_STATUSES = new Set<Task['status']>([
  'resolving',
  'awaiting_selection',
  'processing'
])

function renderActions(props: TaskRowProps, v: TaskRowView): React.ReactNode {
  const { task } = props
  return v.actions.map((action) => {
    switch (action) {
      case 'limit':
        // 单任务限速入口(downloading / paused);仅当父组件传入 onLimit 才渲染(不传 → 不出死按钮)
        return props.onLimit ? (
          <TaskRowLimitMenu key={action} task={task} onLimit={props.onLimit} />
        ) : null
      case 'pause':
        return (
          <button
            key={action}
            className="icon-btn"
            title="暂停"
            onClick={() => props.onPause(task.id)}
          >
            <IconPause />
          </button>
        )
      case 'resume':
        return (
          <button
            key={action}
            className="icon-btn"
            title="继续"
            onClick={() => props.onResume(task.id)}
          >
            <IconPlay />
          </button>
        )
      case 'cancel':
        // 中间态(解析 / 待选 / 合并):行内删除 → 未完成删除,后端把残留(.part/.aria2/部分)清到回收站(§3/§4)
        if (INTERMEDIATE_STATUSES.has(task.status)) {
          return (
            <button
              key={action}
              className="icon-btn danger"
              title="删除"
              onClick={() => props.onRemove(task.id, false)}
            >
              <IconTrash />
            </button>
          )
        }
        // error → 删除失败记录;downloading/paused/queued → 取消进行中 / 排队(既有交互不变,仍走 onCancel)
        return task.status === 'error' ? (
          <button
            key={action}
            className="icon-btn danger"
            title="删除"
            onClick={() => props.onCancel(task.id)}
          >
            <IconTrash />
          </button>
        ) : (
          <button
            key={action}
            className="icon-btn danger"
            title="取消"
            onClick={() => props.onCancel(task.id)}
          >
            <IconClose />
          </button>
        )
      case 'retry':
        return (
          <button
            key={action}
            className="icon-btn"
            title="重试"
            onClick={() => props.onRetry(task.id)}
          >
            <IconRetry />
          </button>
        )
      case 'openFile':
        return (
          <button
            key={action}
            className="icon-btn"
            title="打开文件"
            onClick={() => props.onOpenFile(task.savePath)}
          >
            <IconOpen />
          </button>
        )
      case 'showInFolder':
        return (
          <button
            key={action}
            className="icon-btn"
            title="打开文件夹"
            onClick={() => props.onShowInFolder(task.savePath)}
          >
            <IconFolder />
          </button>
        )
      case 'selectFormat':
        // 仅当父组件传入 onSelectFormat 才渲染(本 Task 不传 → 不出死按钮)
        // torrent 待选文件 → 「选择文件」(打开 BtFileDialog);video 待选清晰度 → 「选择清晰度」(v0.3 Task 2)
        return props.onSelectFormat ? (
          <span
            key={action}
            className="pill action"
            onClick={() => props.onSelectFormat?.(task.id)}
          >
            {task.kind === 'torrent' ? '选择文件' : '选择清晰度'}
          </span>
        ) : null
      case 'more':
        // 已完成任务「更多」菜单:信息只读 + 从列表删除(保留文件)/ 删除文件(→ 回收站);经 onRemove 透传 deleteFile(§2/§7.3)
        return <TaskRowMoreMenu key={action} task={task} onRemove={props.onRemove} />
      case 'stopSeed':
        // 停止做种(v0.3 Task 3):中性 icon-btn(非 danger,保留文件 + .aria2)→ onStopSeeding(id);不传 → 不出死按钮
        return props.onStopSeeding ? (
          <button
            key={action}
            className="icon-btn"
            title="停止做种"
            onClick={() => props.onStopSeeding?.(task.id)}
          >
            <IconStopSeed />
          </button>
        ) : null
      default:
        return null
    }
  })
}

function TaskRowImpl(props: TaskRowProps): React.JSX.Element {
  const { task } = props
  const v = taskView(task)
  const pct = formatPercent(task.downloadedBytes, task.totalBytes)
  const speed = renderSpeed(v, task)
  const meta = renderMeta(v, pct, task.status)

  return (
    <div className="task">
      <div className={`t-icon ${v.iconCategory}`}>{categoryIcon(v.iconCategory)}</div>
      <div className="t-main">
        <div className="t-name" title={task.filename}>
          {task.filename}
        </div>
        <div className="t-sub">
          {renderSub(v)}
          {/* 视频清晰度标签 — 仅 quality 非空时(直链不显示);与状态文案并存于副信息行 */}
          {v.quality && <span className="pill t-quality">{v.quality}</span>}
        </div>
        {renderBar(v, pct)}
      </div>
      {(meta || speed) && (
        <div className="t-meta">
          {meta}
          {speed}
        </div>
      )}
      <div className="t-actions">{renderActions(props, v)}</div>
    </div>
  )
}

export default memo(
  TaskRowImpl,
  (a, b) =>
    a.task.id === b.task.id &&
    a.task.status === b.task.status &&
    a.task.downloadedBytes === b.task.downloadedBytes &&
    a.task.totalBytes === b.task.totalBytes &&
    a.task.speed === b.task.speed &&
    a.task.error === b.task.error &&
    a.task.filename === b.task.filename &&
    a.task.videoMeta?.qualityLabel === b.task.videoMeta?.qualityLabel &&
    // 限速 popover 回显依赖 task.limitKBps(2026-07-09):暂停中任务设限速时其它字段全不变,
    // 比较器漏掉它会吞掉重渲染 → 重开 popover 读到旧 props 显示「不限速」
    a.task.limitKBps === b.task.limitKBps &&
    // 完成时刻主进程校正的三字段(completedAt / after_move 真实 savePath / 重判 category):
    // loadTasks 重拉后若仅这三处变化,漏比会吞掉重渲染 → 完成时间恒 '--'、打开文件用旧路径
    a.task.completedAt === b.task.completedAt &&
    a.task.savePath === b.task.savePath &&
    a.task.category === b.task.category &&
    // BT 富进度(v0.3 Task 3):做种 / peers 数据变化时 status/bytes/speed 可能全不变——
    // 比较器漏这些字段会吞掉重渲染 → 做种中上行 / 分享率 / 节点数恒不更新(同 limitKBps 坑)
    a.task.seeding === b.task.seeding &&
    a.task.uploadSpeed === b.task.uploadSpeed &&
    a.task.uploadLength === b.task.uploadLength &&
    a.task.numSeeders === b.task.numSeeders &&
    a.task.connections === b.task.connections &&
    // onStopSeeding 不入比较器(App 恒传、永不翻转,同 pause/resume 语义):身份每渲染变但捕获旧闭包仍正确调用
    a.onSelectFormat === b.onSelectFormat
)
