/**
 * 左导航 — 对齐原型 .sidebar。
 *
 * - 顶部:主色「添加任务」按钮(.btn-add)。
 * - 任务区:全部 / 下载中 / 已完成 / 失败(带计数,active 左侧 3px 主色指示条)。
 * - 功能区:BT / 浏览器扩展(均已激活为可点,功能区已无「即将推出」占位)。
 * - 底部:设置(nav-bottom,margin-top:auto 推到底)。
 * - 计数来自 props(App 经 countByNav 派生);功能区「浏览器扩展」无计数(独立页型,不筛任务)。
 */

import NavItem from './NavItem'
import type { NavKey, NavCounts } from '../lib/types'
import './Sidebar.css'

interface Props {
  nav: NavKey
  counts: NavCounts
  onNavChange: (key: NavKey) => void
  onAddClick: () => void
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const IconPlus = (): React.JSX.Element => (
  <svg {...svgProps}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)
const IconAll = (): React.JSX.Element => (
  <svg {...svgProps}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
)
const IconDown = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)
const IconDone = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M21.801 10A10 10 0 1 1 17 3.335" />
    <path d="m9 11 3 3L22 4" />
  </svg>
)
const IconFail = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
)
const IconBt = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" />
    <path d="m5 8 4 4" />
    <path d="m12 15 4 4" />
  </svg>
)
const IconTakeover = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
  </svg>
)
// 历史:时钟 + 回溯箭头(lucide history),语义贴切「下载历史」,描边风格与其余导航图标一致
const IconHistory = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </svg>
)
const IconSettings = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

export default function Sidebar({
  nav,
  counts,
  onNavChange,
  onAddClick
}: Props): React.JSX.Element {
  return (
    <nav className="sidebar">
      <button className="btn-add" onClick={onAddClick}>
        <IconPlus />
        添加任务
      </button>

      <div className="nav-section">任务</div>
      <NavItem
        icon={<IconAll />}
        label="全部"
        count={counts.all}
        active={nav === 'all'}
        onClick={() => onNavChange('all')}
      />
      <NavItem
        icon={<IconDown />}
        label="下载中"
        count={counts.active}
        active={nav === 'active'}
        onClick={() => onNavChange('active')}
      />
      <NavItem
        icon={<IconDone />}
        label="已完成"
        count={counts.completed}
        active={nav === 'completed'}
        onClick={() => onNavChange('completed')}
      />
      <NavItem
        icon={<IconFail />}
        label="失败"
        count={counts.failed}
        active={nav === 'failed'}
        onClick={() => onNavChange('failed')}
      />

      <div className="nav-section">功能</div>
      {/* BT · 磁力(v0.3 Task 3):从「即将推出」占位激活为可点(状态维过滤 kind==='torrent',与类别维正交) */}
      <NavItem
        icon={<IconBt />}
        label="BT · 磁力"
        count={counts.torrent}
        active={nav === 'torrent'}
        onClick={() => onNavChange('torrent')}
      />
      {/* 浏览器扩展(v0.4 Task 5 · spec §5.1):原「网页嗅探」「浏览器接管」两行「即将推出」占位
        * **合并为这一行**。
        * - **不再灰显占位**:接管在 Task 4 已交付、嗅探在 Task 5 交付,还写「即将推出」是不诚实。
        * - **合并而非各激活一行**:`sniff.report` 取消后 DownLord 侧没有资源列表,一个叫「网页嗅探」的
        *   入口点进去看不到列表才是真正让人找不到东西;这一页要承载的三样(连接状态 / 接管开关 /
        *   嗅探引导)全都是「关于扩展的」,没一样是「关于嗅探的」。图标沿用接管那枚,原嗅探图标已删。
        * - **无计数**:它不筛任务、不是任务列表的一个视图,属**独立页型**(与历史 / 设置同类),
        *   不套用 BT 那种「状态维过滤型」的计数。 */}
      <NavItem
        icon={<IconTakeover />}
        label="浏览器扩展"
        active={nav === 'extension'}
        onClick={() => onNavChange('extension')}
      />

      <div className="nav-bottom">
        {/* 历史与设置同类(独立页,非 TaskList 状态筛选)→ nav-bottom 内、设置上方;无 count(spec §2.2) */}
        <NavItem
          icon={<IconHistory />}
          label="历史"
          active={nav === 'history'}
          onClick={() => onNavChange('history')}
        />
        <NavItem
          icon={<IconSettings />}
          label="设置"
          active={nav === 'settings'}
          onClick={() => onNavChange('settings')}
        />
      </div>
    </nav>
  )
}
