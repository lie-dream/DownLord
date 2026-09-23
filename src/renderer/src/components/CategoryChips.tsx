/**
 * 类型筛选 chips — 复刻原型 .filter-bar,复用 buttons.css 的 .chip / .chip.active(绝不另造色值)。
 *
 * - 受控组件:value(当前选中 CategoryFilterKey)+ onChange(切换回调);过滤逻辑在 categoryFilter
 *   纯函数,组件只发 onChange(渲染纯 UI,spec §4.4)。
 * - chips = 固定首位「全部」(categoryLabel('all'))+ categories 各项(displayName 来自 category:list,
 *   落实「一处定义」spec §2.3 / §4.1);顺序即 props 顺序。
 * - **不带计数**(对齐原型,spec §4.1);左导航状态计数另算(正交,决策 a)。
 */

import type { CategoryConfig } from '../../../shared/ipc'
import type { CategoryFilterKey } from '../lib/categoryFilter'
import { categoryLabel } from '../lib/categoryView'
import './CategoryChips.css'

interface Props {
  categories: CategoryConfig[]
  value: CategoryFilterKey
  onChange: (key: CategoryFilterKey) => void
}

function Chip({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <div className={`chip${active ? ' active' : ''}`} onClick={onClick}>
      {label}
    </div>
  )
}

export default function CategoryChips({ categories, value, onChange }: Props): React.JSX.Element {
  return (
    <div className="filter-bar">
      <Chip label={categoryLabel('all')} active={value === 'all'} onClick={() => onChange('all')} />
      {categories.map((c) => (
        <Chip
          key={c.key}
          label={c.displayName}
          active={value === c.key}
          // category:list 下发的 key 即 6 类枚举,收窄为 CategoryFilterKey
          onClick={() => onChange(c.key as CategoryFilterKey)}
        />
      ))}
    </div>
  )
}
