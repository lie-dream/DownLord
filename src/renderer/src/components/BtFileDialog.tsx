/**
 * BT 文件选择对话框(v0.3 Task 2 · spec §6.2)—— 多文件种子待选态勾选要下载的文件。
 *
 * - 结构仿 `FormatDialog` 三段:`.overlay` 遮罩 + `.dialog` 卡片 + 头 / 体(信息条 + 全选反选条 + 扁平清单 + 落点)/ 底。
 * - 数据源 = 传入的 `meta.files`(直取 `task.torrentMeta`,**不经 getResolved** —— 与视频关键差异,§6.2)。
 * - 默认全选(整包默认 = 零回归);行点击 toggle;头部全选 / 反选;底部「已选 N · 共 X」实时汇总;
 *   `canSubmit = 已选 ≥ 1`(空选禁用「开始下载」防呆)。
 * - `onSubmit` 回传**1-based 索引集**(与 aria2 `--select-file` 对齐,§3.2);选择定型 / 映射 / 落点全在主进程(§7.2)。
 * - 关闭:取消 / 右上 × / `Esc`;**点遮罩不关闭**(防误触,同 FormatDialog)。上百文件靠 `.dialog-body` overflow-y 滚动。
 * - 纯 UI:仅经 props 回调通信,不算落点(landingDir 由主进程 saveLocationView 给)/ 不写库 / 不组装 select-file。
 *   复用全局 `.overlay`/`.dialog`/`.btn`/`.pill`/`.link-btn` + token,零新造色值(DESIGN §6)。
 */

import { useEffect, useMemo, useState } from 'react'
import type { TorrentMeta } from '../../../shared/ipc'
import { buildTorrentFileRows, totalTorrentBytes } from '../lib/torrentFileList'
import { formatBytes } from '../lib/format'
import './BtFileDialog.css'

interface Props {
  open: boolean
  /** 直取 task.torrentMeta(已随 task:list / task:progress 在渲染层,无需 IPC 往返;§6.2) */
  meta: TorrentMeta | null
  /** 落点显示 `<Torrents>/<种子名>`,主进程 saveLocationView 算好下发(渲染层不拼 join,§7.2) */
  landingDir: string
  onClose: () => void
  /** 勾选的 1-based 索引集(升序)→ App 调 window.api.applyTorrentSelection(§8) */
  onSubmit: (selectedIndices: number[]) => void
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export default function BtFileDialog({
  open,
  meta,
  landingDir,
  onClose,
  onSubmit
}: Props): React.JSX.Element | null {
  const rows = useMemo(() => (meta ? buildTorrentFileRows(meta.files) : []), [meta])
  const totalBytes = useMemo(() => (meta ? totalTorrentBytes(meta.files) : 0), [meta])
  // 勾选的 1-based 索引集(默认全选 = 整包默认,§2.3)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // 每次打开 / 切换种子:重置为全选。
  // 用「渲染期调整 state」(React 官方 derived-state 模式)而非 useEffect:少一轮级联渲染,
  // 且避免打开瞬间先渲染出空选再跳全选。语义与原 effect 一致(open 或 rows 变化时,open 才重置)。
  const [prevKey, setPrevKey] = useState<{ open: boolean; rows: typeof rows } | null>(null)
  if (prevKey?.open !== open || prevKey?.rows !== rows) {
    setPrevKey({ open, rows })
    if (open) setSelected(new Set(rows.map((r) => r.index)))
  }

  // Esc 关闭(沿用 FormatDialog)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !meta) return null

  const total = rows.length
  const count = selected.size
  const canSubmit = count >= 1

  const toggle = (index: number): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const selectAll = (): void => setSelected(new Set(rows.map((r) => r.index)))
  // 反选:已选 ↔ 未选 互换(取补集)
  const invert = (): void =>
    setSelected((prev) => new Set(rows.map((r) => r.index).filter((i) => !prev.has(i))))

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit([...selected].sort((a, b) => a - b))
  }

  return (
    <div className="overlay show">
      <div className="dialog">
        <div className="dialog-head">
          <h3>选择要下载的文件</h3>
          <button className="dialog-close" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          <div className="bt-info">
            <div className="bt-name" title={meta.name}>
              {meta.name}
            </div>
            <div className="bt-sub">
              {total} 个文件 · 共 {formatBytes(totalBytes)}
            </div>
          </div>

          <div className="bt-bar">
            <div className="bt-actions">
              <button className="link-btn" onClick={selectAll}>
                全选
              </button>
              <button className="link-btn" onClick={invert}>
                反选
              </button>
            </div>
            <div className="bt-count">
              已选 {count} · 共 {total}
            </div>
          </div>

          <div className="bt-list">
            {rows.map((row) => (
              <div
                key={row.index}
                className={`bt-row${selected.has(row.index) ? ' sel' : ''}`}
                onClick={() => toggle(row.index)}
              >
                <div className="check">
                  {selected.has(row.index) && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </div>
                <div className="bt-path" title={row.path}>
                  {row.path}
                </div>
                <span className="pill">{row.sizeLabel}</span>
              </div>
            ))}
          </div>

          <div className="bt-save">
            <span className="bt-save-label">保存到</span>
            <span className="bt-save-dir" title={landingDir}>
              {landingDir}
            </span>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            <svg {...svgProps}>
              <path d="M12 3v12" />
              <path d="m7 11 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            开始下载
          </button>
        </div>
      </div>
    </div>
  )
}
