/**
 * 导航项 — 对齐原型 .nav-item(图标 + 文字 + 计数 / soon 标签 + active 指示条)。
 *
 * - 任务区项:传 count → 右侧计数胶囊;active → 左侧 3px 主色指示条(由 Sidebar.css 控制)。
 * - 功能区项:传 soon → 灰显「即将推出」、不可点(无 onClick)。
 * - 纯展示组件,经 Sidebar 测试覆盖(无独立测试)。
 */

interface NavItemProps {
  icon: React.ReactNode
  label: string
  count?: number
  active?: boolean
  soon?: boolean
  onClick?: () => void
}

export default function NavItem({
  icon,
  label,
  count,
  active,
  soon,
  onClick
}: NavItemProps): React.JSX.Element {
  return (
    <div
      className={`nav-item${active ? ' active' : ''}${soon ? ' soon' : ''}`}
      onClick={soon ? undefined : onClick}
    >
      {icon}
      <span className="text">{label}</span>
      {soon ? (
        <span className="soon-tag">即将推出</span>
      ) : count !== undefined ? (
        <span className="nav-count">{count}</span>
      ) : null}
    </div>
  )
}
