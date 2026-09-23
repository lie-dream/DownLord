/**
 * 下载历史页(v0.2 Task 5 · spec §5)——独立页(类比 settings),守 DESIGN §1/§2/§6 缰绳:
 * 复用 token + 既有组件(CategoryChips / TaskRow / EmptyState / .input / .select / .set-card 结构),
 * 与主列表 / 设置页同基调、不漂移。
 *
 * - 纯 UI(ARCHITECTURE §7.2):检索 / 统计 / 时间口径 / clamp 全在主进程,渲染层只传语义 query、纯展示。
 * - 数据源走主进程只读 DAO(window.api.searchHistory / getHistoryStats),**不复用 TasksContext 内存 tasks**
 *   (语义分离:活动工作台 vs 完整历史检索,spec §2.3);历史页自管刷新,不与内存耦合。
 * - 筛选为**页内独立局部态**,不读写 App 的 nav / categoryFilter(spec §3.4),主列表正交链路零回归。
 * - 行操作只经既有 window.api(open / showInFolder / removeTask / retryTask / pause / resume),零新后端(spec §5.3)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CategoryConfig, HistoryStats, Task } from '../../../shared/ipc'
import type { CategoryKey } from '../../../main/category/categoryModel'
import { useTasks } from '../state/tasksStore'
import { useToast } from '../state/toastStore'
import { categoryIconClass } from '../lib/categoryView'
import type { CategoryFilterKey } from '../lib/categoryFilter'
import { formatBytes } from '../lib/format'
import {
  buildHistoryQuery,
  categoryDisplayName,
  hasActiveFilter,
  validateCustomRange,
  type CustomRangeIssue,
  type HistoryFilterState,
  type HistoryStatusKey,
  type HistoryTimeKey
} from '../lib/historyView'
import CategoryChips from './CategoryChips'
import TaskRow from './TaskRow'
import EmptyState from './EmptyState'
import './HistoryPage.css'

// 与主进程 DEFAULT_HISTORY_LIMIT 对齐(spec §5.5):结果达此上限时列表底部诚实提示,不静默截断。
const HISTORY_LIMIT = 500
// 搜索 / 筛选防抖(spec §5.2:约 250ms,避免逐字符打 IPC)。
const DEBOUNCE_MS = 250

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const IconSearch = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)
// 类别图标(与 TaskRow .t-icon 同源 SVG path;配色经 .t-icon 类走 token)
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
function catIconEl(cls: 'video' | 'audio' | 'file'): React.JSX.Element {
  if (cls === 'video') return <IconVideo />
  if (cls === 'audio') return <IconAudio />
  return <IconFile />
}

const STATUS_OPTIONS: { value: HistoryStatusKey; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'active', label: '进行中' }
]
const TIME_OPTIONS: { value: HistoryTimeKey; label: string }[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'custom', label: '自定义' }
]
const STAT_WINDOWS: { key: 'today' | 'week' | 'month' | 'total'; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'total', label: '累计' }
]

/** 统计区:4 数字卡(数量 + formatBytes)+ 按类别纯 CSS 占比条(spec §4.4) */
function StatsPanel({
  stats,
  categories
}: {
  stats: HistoryStats
  categories: CategoryConfig[]
}): React.JSX.Element {
  // 占比条按数据量(总大小)降序展示(B8):下载器稀缺资源是磁盘 / 流量,「哪类占最多空间」比个数更有
  // 决策价值,数量已在右侧文字呈现。基准 = 最大类别总大小(至少 1 防除零),宽 = totalBytes / maxBytes。
  const bars = [...stats.byCategory].sort((a, b) => b.totalBytes - a.totalBytes)
  const maxBytes = Math.max(1, ...bars.map((c) => c.totalBytes))
  return (
    <div className="hist-stats">
      <div className="hist-cards">
        {STAT_WINDOWS.map((w) => (
          <div className="stat-card" key={w.key}>
            <div className="sc-label">{w.label}</div>
            <div className="sc-count">
              {stats[w.key].count}
              <span className="sc-unit">个</span>
            </div>
            <div className="sc-bytes">{formatBytes(stats[w.key].totalBytes)}</div>
          </div>
        ))}
      </div>
      {bars.length > 0 && (
        <div className="hist-cat-bars">
          {bars.map((c) => {
            const cls = categoryIconClass(c.category as CategoryKey)
            return (
              <div className="hcb-row" key={c.category}>
                <span className={`t-icon ${cls} hcb-ico`}>{catIconEl(cls)}</span>
                <span className="hcb-name">{categoryDisplayName(c.category, categories)}</span>
                <div className="hcb-bar">
                  <span style={{ width: `${(c.totalBytes / maxBytes) * 100}%` }} />
                </div>
                <span className="hcb-num">
                  {c.count} 个 · {formatBytes(c.totalBytes)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function HistoryPage(): React.JSX.Element {
  // 类别 chips / 占比条名复用启动已拉的 category:list(TasksProvider);历史页不改写它。
  const { categories } = useTasks()
  const { showToast } = useToast()

  // 页内独立筛选态(不读写 App 的 nav / categoryFilter,spec §3.4)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<HistoryStatusKey>('all')
  const [category, setCategory] = useState<CategoryFilterKey>('all')
  const [time, setTime] = useState<HistoryTimeKey>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // date 控件对不存在的日期(如 6.31)清空 value 但置 validity.badInput=true;用它捕获「填了非法日」(B5)
  const [fromBad, setFromBad] = useState(false)
  const [toBad, setToBad] = useState(false)

  const [results, setResults] = useState<Task[]>([])
  const [stats, setStats] = useState<HistoryStats | null>(null)
  // 首次查询已返回:未加载时不闪现空态(初始 results 空但可能库里有历史)。
  const [loaded, setLoaded] = useState(false)

  const filter: HistoryFilterState = useMemo(
    () => ({ text, status, category, time, from, to }),
    [text, status, category, time, from, to]
  )
  const query = useMemo(() => buildHistoryQuery(filter), [filter])

  // 检索 + 统计一起拉:筛选变更(query 变)防抖调 / 行操作后立即调(spec §5.2 / §4.3 stats 无参、全库口径)。
  const runQuery = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        window.api.searchHistory(query),
        window.api.getHistoryStats()
      ])
      setResults(r)
      setStats(s)
      setLoaded(true)
    } catch {
      // 历史只读失败不阻断页面;主进程抛的已是可读错误,静默处理(与既有拉取式操作一致)。
    }
  }, [query])

  // 稳定 refresh:行操作后用最新 query 的 runQuery 刷新(经 ref 持最新,回调身份稳定)。
  // 渲染期写 ref.current 是 latest-ref 模式,**刻意为之**:refresh 身份必须恒定(否则下方 useEffect
  // 与行操作回调每次 query 变化都重建),而 React 目前无稳定替代(useEffectEvent 仍是实验 API)。
  // 该写入不产生渲染副作用(不读旧值、不触发重渲染),故豁免 react-hooks/refs。
  const runRef = useRef(runQuery)
  // eslint-disable-next-line react-hooks/refs
  runRef.current = runQuery
  const refresh = useCallback(() => void runRef.current(), [])

  // 挂载 + 筛选变更:防抖拉取(连续输入时不断重置 timer,停 250ms 后才打 IPC)。
  useEffect(() => {
    const t = setTimeout(() => void runQuery(), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [runQuery])

  // 行操作薄封装:只经既有 window.api,操作后刷新历史列表 + 统计(零新后端,spec §5.3)。
  const onOpenFile = useCallback(
    (p: string) => {
      void window.api.openPath(p).then((err) => {
        if (err) showToast(err, 'error')
      })
    },
    [showToast]
  )
  const onShowInFolder = useCallback(
    (p: string) => {
      void window.api.showItemInFolder(p).then((err) => {
        if (err) showToast(err, 'error')
      })
    },
    [showToast]
  )
  const onRemove = useCallback(
    (id: string, deleteFile: boolean) => {
      void window.api.removeTask(id, deleteFile).then(refresh)
    },
    [refresh]
  )
  const onRetry = useCallback(
    (id: string) => void window.api.retryTask(id).then(refresh),
    [refresh]
  )
  const onPause = useCallback(
    (id: string) => void window.api.pauseTask(id).then(refresh),
    [refresh]
  )
  const onResume = useCallback(
    (id: string) => void window.api.resumeTask(id).then(refresh),
    [refresh]
  )
  // 取消进行中 / 删除失败记录 = 仅移记录(与主列表 cancel 同语义:removeTask(id,false))。
  const onCancel = useCallback(
    (id: string) => void window.api.removeTask(id, false).then(refresh),
    [refresh]
  )

  const clearFilters = (): void => {
    setText('')
    setStatus('all')
    setCategory('all')
    setTime('all')
    setFrom('')
    setTo('')
    setFromBad(false)
    setToBad(false)
  }

  const filtered = hasActiveFilter(filter)
  const limitReached = results.length >= HISTORY_LIMIT
  // 自定义区间校验:某端非法日期(badInput,含控件清空 value 的 6.31)→ invalid;两端合法但起 > 止 → inverted(B5)
  const rangeIssue: CustomRangeIssue =
    time !== 'custom' ? null : fromBad || toBad ? 'invalid' : validateCustomRange(from, to)
  // 全库完成统计有内容才显示统计区(完全无历史时不堆一排 0 卡;统计按 completed 口径,与筛选无关 spec §4)。
  const showStats = stats !== null && (stats.total.count > 0 || stats.byCategory.length > 0)

  return (
    <div className="history-page">
      {/* 搜索栏(复用 .input;放大镜描边图标) */}
      <div className="hist-search-row">
        <span className="hist-search-ico">
          <IconSearch />
        </span>
        <input
          className="input hist-search-input"
          placeholder="搜索文件名或链接…"
          aria-label="搜索历史"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {/* 筛选行:类别 chips(原样复用 CategoryChips)+ 状态 / 时间 .select(+ 自定义日期) */}
      <div className="hist-filter-row">
        <CategoryChips categories={categories} value={category} onChange={setCategory} />
        <div className="hist-selects">
          <select
            className="select"
            aria-label="状态筛选"
            value={status}
            onChange={(e) => setStatus(e.target.value as HistoryStatusKey)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="时间筛选"
            value={time}
            onChange={(e) => setTime(e.target.value as HistoryTimeKey)}
          >
            {TIME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {time === 'custom' && (
            <>
              <input
                type="date"
                className="input hist-date"
                aria-label="起始日期"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setFromBad(e.target.validity.badInput)
                }}
              />
              <span className="hist-date-sep">~</span>
              <input
                type="date"
                className="input hist-date"
                aria-label="结束日期"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setToBad(e.target.validity.badInput)
                }}
              />
            </>
          )}
        </div>
        {rangeIssue === 'invalid' && (
          <div className="hist-date-hint" role="alert">
            日期无效,请选择存在的日期。
          </div>
        )}
        {rangeIssue === 'inverted' && (
          <div className="hist-date-hint" role="alert">
            起始日期晚于结束日期,当前范围无结果——请调整。
          </div>
        )}
      </div>

      {/* 滚动区:统计卡 + 列表 / 空态 */}
      <div className="hist-scroll">
        {showStats && stats && <StatsPanel stats={stats} categories={categories} />}

        {results.length > 0 ? (
          <>
            <div className="hist-task-list">
              {results.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onPause={onPause}
                  onResume={onResume}
                  onCancel={onCancel}
                  onRemove={onRemove}
                  onRetry={onRetry}
                  onOpenFile={onOpenFile}
                  onShowInFolder={onShowInFolder}
                />
              ))}
            </div>
            {limitReached && (
              <div className="hist-limit-note">
                仅显示最近 {HISTORY_LIMIT} 条,请用搜索 / 筛选缩小范围查看更多。
              </div>
            )}
          </>
        ) : loaded ? (
          filtered ? (
            <EmptyState
              title="没有匹配的历史记录"
              description="试试调整搜索关键字、类别、状态或时间范围。"
              action={
                <button className="btn btn-default" onClick={clearFilters}>
                  清除筛选
                </button>
              }
            />
          ) : (
            <EmptyState
              title="还没有下载历史"
              description="下载过的任务会出现在这里,可搜索、筛选并查看统计。"
              action={null}
            />
          )
        ) : null}
      </div>
    </div>
  )
}
