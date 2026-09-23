/**
 * 播放列表批量选择对话框(spec §7.2)。
 *
 * - 结构复刻原型 .overlay / .dialog 骨架(复用 AddTaskDialog.css)+ FormatDialog 的 .switch / .select。
 * - 头:全选 / 反选 + 计数「已选 N / 共 M」;体:.batch-list 逐条(勾选 + 序号 + 标题 + 时长);
 *   底前:统一清晰度策略 select(最高 / 1080P / 720P / 480P)+「仅音频 MP3」开关;底:取消 + 「下载选中(N)」。
 * - 批量**不逐条解析格式**:统一策略 → FormatChoice(heightCap / audioOnly),交 TaskManager 用通用 -f 选择器。
 * - onSubmit(picks, policy):picks 为勾选 entry 序号(升序),policy 为统一 FormatChoice;App 合成 BatchPick[]。
 * - 关闭:取消 / 右上角 × / Esc;点遮罩不关闭(防误触,沿用 FormatDialog)。纯展示,仅经回调通信。
 */

import { useEffect, useMemo, useState } from 'react'
import type { FormatChoice, ResolvedPlaylist } from '../../../shared/ipc'
import { formatDuration } from '../lib/format'
import './controls.css'
import './BatchDialog.css'

interface Props {
  open: boolean
  playlist: ResolvedPlaylist | null
  onClose: () => void
  onSubmit: (picks: number[], policy: FormatChoice) => void
}

/** 清晰度策略选项 → heightCap(「最高」无上限,heightCap 留空) */
const QUALITY_OPTIONS: Array<{ value: string; label: string; heightCap?: number }> = [
  { value: 'best', label: '最高' },
  { value: '1080', label: '1080P', heightCap: 1080 },
  { value: '720', label: '720P', heightCap: 720 },
  { value: '480', label: '480P', heightCap: 480 }
]

/**
 * 头部说明(v1.0 Task 3 `M-026`;逐字真源在 spec §4「如实说清单」)。
 *
 * 成因(裁决表 `M-026`):从播放列表里复制某一集的地址栏 URL(`watch?v=X&list=Y`)
 * 粘进来,解析出来的是**整个播放列表** —— 这是结构必然
 * (`buildYtDlpResolveArgs` 恒带 `--flat-playlist`,`ytdlpJson.ts` 见到 `entries` 即判 playlist),
 * 不是解析错了。出口本来就有(反选 + 只勾那一集),但**界面一个字都没交代**,
 * 用户第一反应是「它把我的链接认错了」。
 * ⇒ 说清**为什么是整列表** + 给出**只下一集的出路**。判定逻辑一行不动。
 */
const PLAYLIST_NOTE =
  '这个链接带播放列表参数,故按整个列表处理。只想下其中一集?用该集的分享链接(形如 youtu.be/<id>)单独添加。'

/** M-025:裸跑未定位原批量失败原因,按已授权文案如实交代,不猜改下载表达式。 */
const YOUTUBE_BATCH_NOTE =
  'YouTube 播放列表批量下载当前不可用,请改用单视频分享链接 youtu.be/<id>'

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

export default function BatchDialog({
  open,
  playlist,
  onClose,
  onSubmit
}: Props): React.JSX.Element | null {
  const entries = useMemo(() => playlist?.entries ?? [], [playlist])
  // 勾选序号集合(默认全选)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [quality, setQuality] = useState('best')
  const [audioOnly, setAudioOnly] = useState(false)

  // 每次打开 / 切换播放列表:默认全选 + 重置策略。
  // 用「渲染期调整 state」(React 官方 derived-state 模式)而非 useEffect:少一轮级联渲染。
  // 语义与原 effect 一致(open 或 entries 变化时,open 才重置)。
  const [prevKey, setPrevKey] = useState<{ open: boolean; entries: typeof entries } | null>(null)
  if (prevKey?.open !== open || prevKey?.entries !== entries) {
    setPrevKey({ open, entries })
    if (open) {
      setSelected(new Set(entries.map((_, i) => i)))
      setQuality('best')
      setAudioOnly(false)
    }
  }

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !playlist) return null

  const total = entries.length
  const count = selected.size

  const toggle = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const selectAll = (): void => setSelected(new Set(entries.map((_, i) => i)))
  // 反选:已选 ↔ 未选 互换(全选态 → 全不选;全不选态 → 全选;部分态 → 取补集)
  const invertSelection = (): void =>
    setSelected((prev) => new Set(entries.map((_, i) => i).filter((i) => !prev.has(i))))

  const submit = (): void => {
    const picks = [...selected].sort((a, b) => a - b)
    const heightCap = QUALITY_OPTIONS.find((o) => o.value === quality)?.heightCap
    const policy: FormatChoice = audioOnly
      ? { audioOnly: true }
      : { audioOnly: false, ...(heightCap !== undefined ? { heightCap } : {}) }
    onSubmit(picks, policy)
  }

  return (
    <div className="overlay show">
      <div className="dialog">
        <div className="dialog-head">
          <h3>批量下载 · {playlist.title}</h3>
          <button className="dialog-close" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          {/* v1.0 Task 3 `M-026`:计数行**上方**先交代「为什么是整列表」+ 只下一集的出路 */}
          <div className="batch-note">{PLAYLIST_NOTE}</div>
          <div className="batch-note">{YOUTUBE_BATCH_NOTE}</div>
          <div className="batch-bar">
            <div className="batch-actions">
              <button className="link-btn" onClick={selectAll}>
                全选
              </button>
              <button className="link-btn" onClick={invertSelection}>
                反选
              </button>
            </div>
            <div className="batch-count">
              已选 {count} / 共 {total}
            </div>
          </div>

          <div className="batch-list">
            {entries.map((entry, i) => (
              <div
                key={entry.id}
                className={`batch-row${selected.has(i) ? ' sel' : ''}`}
                onClick={() => toggle(i)}
              >
                <div className="check">
                  {selected.has(i) && (
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
                <div className="b-idx">{i + 1}</div>
                <div className="b-title" title={entry.title}>
                  {entry.title}
                </div>
                {entry.durationSec != null && (
                  <div className="b-dur">{formatDuration(entry.durationSec)}</div>
                )}
              </div>
            ))}
          </div>

          <div className="batch-policy">
            <div className="bp-row">
              <label className="bp-label">统一清晰度</label>
              <select
                className="select"
                value={quality}
                disabled={audioOnly}
                onChange={(e) => setQuality(e.target.value)}
              >
                {QUALITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="audio-opt">
              <div className="ao-text">
                <div className="ao-title">仅下载音频(转 MP3)</div>
                <div className="ao-desc">忽略画面,所有勾选条目只提取音轨保存为 MP3</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={audioOnly}
                aria-label="仅下载音频转 MP3"
                className={`switch${audioOnly ? ' on' : ''}`}
                onClick={() => setAudioOnly((v) => !v)}
              />
            </div>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={count === 0} onClick={submit}>
            <svg {...svgProps}>
              <path d="M12 3v12" />
              <path d="m7 11 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            下载选中({count})
          </button>
        </div>
      </div>
    </div>
  )
}
