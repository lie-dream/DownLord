/**
 * 已完成任务行「更多(⋯)」菜单 — 自定义轻量 popover(spec §1,Task 9.5)。
 *
 * - 结构:信息区(只读:文件大小 / 完成时间 / 保存位置)+ 分隔线 + 操作区(复制下载链接 / 从列表删除【保留文件】/ 删除文件【→ 回收站】)。
 * - 纯 UI(§7.2):两删除经统一 onRemove(id, deleteFile) → task:remove(deleteFile);false 仅移记录、true 成品移回收站(§5),清理权威在主进程(§7.3)。
 * - 交互:点 ⋯ 开 / 关;点菜单外、Esc、点操作项后关闭;窗口底部空间不足时向上展开(不溢出)。
 * - 视觉复用 DESIGN token(--bg-layer / --stroke / --shadow-flyout / --divider),浅 / 深色一致,不写死色值。
 * - 复制下载链接(v0.2 Task 5 · #19):navigator.clipboard.writeText(task.source),纯渲染层零后端(不经 IPC / 不引 Electron clipboard),成功 / 失败经 Toast 反馈(§6.2)。
 */

import { useEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/ipc'
import { formatBytes, formatDate } from '../lib/format'
import { parentDir } from '../lib/saveLocationView'
import { copyToClipboard } from '../lib/clipboard'
import { useToast } from '../state/toastStore'

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const IconMore = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
)
const IconTrash = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
// 「从列表删除(保留文件)」用「列表 - x」图标:移除记录不动磁盘,与「删除文件」的垃圾桶图标视觉区分
const IconListX = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M11 12H3" />
    <path d="M16 6H3" />
    <path d="M16 18H3" />
    <path d="m19 10-4 4" />
    <path d="m15 10 4 4" />
  </svg>
)
// 「复制下载链接」用双叠矩形描边图标(spec §6.1),与删除类图标视觉区分
const IconCopy = (): React.JSX.Element => (
  <svg {...svgProps}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

/** 向上展开的估算菜单高度(px,含复制 + 两删除三项):底部剩余空间不足则翻转,避免溢出窗口(spec §1.5) */
const MENU_EST_HEIGHT = 264

interface Props {
  task: Task
  /** 统一删除回调 → removeTask(id, deleteFile) → task:remove;false=从列表删除(保留文件)/ true=删除文件(→ 回收站,§5/§7.3) */
  onRemove: (id: string, deleteFile: boolean) => void
}

export default function TaskRowMoreMenu({ task, onRemove }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { showToast } = useToast()

  // 点菜单外 / Esc 关闭(仅打开时挂载监听)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (): void => {
    setOpen((prev) => {
      const next = !prev
      // 开菜单时按 ⋯ 位置决定向下 / 向上,底部空间不足则向上(不溢出窗口)
      if (next && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect()
        setDropUp(window.innerHeight - rect.bottom < MENU_EST_HEIGHT)
      }
      return next
    })
  }

  // 复制下载链接(#19,纯渲染层零后端 §6.2):写 task.source 到剪贴板 → Toast 反馈;点后关菜单
  const copyLink = async (): Promise<void> => {
    setOpen(false)
    const ok = await copyToClipboard(task.source)
    if (ok) showToast('已复制下载链接')
    else showToast('复制失败', 'error')
  }
  // 从列表删除(保留文件)/ 删除文件(→ 回收站):同一 onRemove,deleteFile 区分语义;点后关闭菜单
  const removeFromList = (): void => {
    setOpen(false)
    onRemove(task.id, false)
  }
  const trashFile = (): void => {
    setOpen(false)
    onRemove(task.id, true)
  }

  const size = formatBytes(task.totalBytes || task.downloadedBytes)
  const time = formatDate(task.completedAt)
  const dir = parentDir(task.savePath)

  return (
    <div className="task-more" ref={rootRef}>
      <button
        ref={btnRef}
        className="icon-btn"
        title="更多"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <IconMore />
      </button>
      {open && (
        <div className={`task-menu${dropUp ? ' up' : ''}`} role="menu">
          <div className="tm-info">
            <div className="tm-row">
              <span className="tm-label">文件大小</span>
              <span className="tm-value">{size}</span>
            </div>
            <div className="tm-row">
              <span className="tm-label">完成时间</span>
              <span className="tm-value">{time}</span>
            </div>
            <div className="tm-row">
              <span className="tm-label">保存位置</span>
              <span className="tm-value tm-path" title={task.savePath}>
                {dir}
              </span>
            </div>
          </div>
          <div className="tm-divider" />
          {/* 操作区(常用 → 危险秩序,§6.1):复制下载链接(中性)→ 从列表删除(中性)→ 删除文件(→ 回收站,danger) */}
          <button className="tm-item" role="menuitem" onClick={copyLink}>
            <IconCopy />
            复制下载链接
          </button>
          <button className="tm-item" role="menuitem" onClick={removeFromList}>
            <IconListX />
            从列表删除(保留文件)
          </button>
          <button className="tm-item danger" role="menuitem" onClick={trashFile}>
            <IconTrash />
            删除文件(→ 回收站)
          </button>
        </div>
      )}
    </div>
  )
}
