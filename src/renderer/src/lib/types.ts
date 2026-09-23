// history 是独立页(类比 settings),非 TaskList 的状态筛选;NavCounts 不加 history 字段(spec §2.2:
// 历史规模在页内统计卡呈现,避免左导航计数噪声,并与 NavCounts 结构解耦)
// 'torrent' 为「BT · 磁力」入口(v0.3 Task 3):状态维过滤 kind==='torrent',与类别维正交(spec §6.4)
// 'extension' 为「浏览器扩展」入口(v0.4 Task 5 · spec §5.1):功能区原「网页嗅探」「浏览器接管」两行
// soon 合并激活,走**独立页型**(与 history / settings 同类:NavKey 加值 + App 三元链加一支 + 独立组件),
// **不是** BT 那种状态维过滤型 —— 它不筛任务,故 NavCounts 同样不加字段、左导航不显示计数
export type NavKey =
  | 'all'
  | 'active'
  | 'completed'
  | 'failed'
  | 'torrent'
  | 'history'
  | 'extension'
  | 'settings'
export interface NavCounts {
  all: number
  active: number
  completed: number
  failed: number
  torrent: number
}
// totalUpload:做种 / 上传中任务的 uploadSpeed 聚合(v0.3 Task 3 · spec §6.5;>0 时状态栏显 ↑ 聚合上行)
export interface StatusBarStats {
  totalSpeed: number
  activeCount: number
  queuedCount: number
  totalUpload: number
}

export type TaskRowAction =
  | 'limit'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'openFile'
  | 'showInFolder'
  | 'selectFormat'
  | 'more'
  | 'stopSeed'
export interface TaskRowView {
  iconCategory: 'video' | 'audio' | 'file' | 'error'
  sub: { kind: 'text' | 'warn' | 'ok' | 'err'; text: string }
  progress: 'determinate' | 'indeterminate' | 'processing' | 'paused' | 'none'
  meta: { kind: 'percent' | 'pill' | 'none'; pillText?: string; pillKind?: 'wait' | 'seed' }
  speedTone: 'brand' | 'muted' | 'warning' | 'upload' | 'none'
  /** 视频任务友好清晰度标签(Task 8.5 §3.3;仅 video + videoMeta.qualityLabel,直链 / 待选占位为 undefined → 不显示) */
  quality?: string
  actions: TaskRowAction[]
}
