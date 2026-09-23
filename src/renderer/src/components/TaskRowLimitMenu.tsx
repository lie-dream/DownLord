/**
 * 单任务限速入口 — 自定义轻量 popover(v0.2 Task 2 · spec §5.3;v0.3 Task 4 #25 补第三态)。
 *
 * - 入口:downloading / paused 态任务行 .icon-btn(IconGauge);仅有意义态出现(§5.3,避免误触)。
 * - 内容:标题「单任务限速(临时,重启后恢复全局)」+ **模式 radio「跟随全局」/「自定义」** + 数值输入(MB/s)+ 应用;
 *   暂停中的视频任务灰字「将在继续时生效」(下载中的视频任务限速已立即生效——引擎无缝重起,2026-07-09)。
 * - **三态(#25 · spec §3)**:`limitKBps===undefined` = 跟随全局(无任务级覆盖)/ `0` = 本任务不限(覆盖全局)/
 *   `>0` = 具体限速值。选「跟随全局」→ `onLimit(id, null)`(清除覆盖,即时生效并关闭);选「自定义」→ 展开输入框,
 *   经「应用」/ Enter → `onLimit(id, kbps)`(空 / ≤0 → `0` = 本任务不限)。回显按同一三态映射。
 *   诚实:aria2 后端的全局限速是每个「跟随全局」任务各自的上限(`max-download-limit` 全局默认),「本任务不限」与「自定义 N」真能覆盖它、N 可大于全局;多任务并发时总速度可超过全局值(v1.0 Task 8 · #100,此前 aria2 侧为总量硬上限、两态字节等价)。
 * - 交互仿 TaskRowMoreMenu:点外 / Esc / 应用后关闭;底部空间不足向上翻转;复用 --bg-layer / --stroke / --shadow-flyout token。
 * - 纯 UI(§7.2):应用经 onLimit(→ TasksContext.setTaskLimit → window.api.setTaskLimit)落值;换算(MB/s→KB/s)仅前端计算,无业务逻辑。
 * - 回显当前值 `task.limitKBps`(运行时内存态、不落库,重启即清 = 恢复全局;真机反馈「数值没保留」,2026-07-09)。
 */

import { useEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/ipc'

const IconGauge = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </svg>
)

/** 向上展开的估算菜单高度(px):底部剩余空间不足则翻转,避免溢出窗口(仿 TaskRowMoreMenu §1.5) */
const MENU_EST_HEIGHT = 210

/** 限速模式:global = 跟随全局(无任务级覆盖)/ custom = 本任务自定义(含「不限」= 0) */
type LimitMode = 'global' | 'custom'

interface Props {
  task: Task
  /**
   * 应用单任务限速 → TasksContext.setTaskLimit → window.api.setTaskLimit(§6.4);aria2 即时 / video 下次继续生效。
   * `null` = 清除任务级覆盖(跟随全局)/ `0` = 本任务不限 / `>0` = KB/s 限速值(v0.3 Task 4 #25)。
   */
  onLimit: (id: string, kbps: number | null) => void
}

export default function TaskRowLimitMenu({ task, onLimit }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  // 模式 + 本地输入(MB/s,字符串态便于空值 / 小数);打开时按三态回显(内存态,重启即清)
  const [mode, setMode] = useState<LimitMode>('global')
  const [val, setVal] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

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
      if (next) {
        // 三态回显:undefined → 跟随全局;0 → 自定义 + 空(占位「不限速」);>0 → 自定义 + 值(KB/s → MB/s,两位小数)
        const kb = task.limitKBps
        setMode(kb === undefined ? 'global' : 'custom')
        setVal(kb !== undefined && kb > 0 ? String(Math.round((kb / 1024) * 100) / 100) : '')
        if (btnRef.current) {
          const rect = btnRef.current.getBoundingClientRect()
          setDropUp(window.innerHeight - rect.bottom < MENU_EST_HEIGHT)
        }
      }
      return next
    })
  }

  // 选「跟随全局」= 清除任务级覆盖(null),即时落值后关闭(该模式无需再填值)
  const pickGlobal = (): void => {
    setMode('global')
    onLimit(task.id, null)
    setOpen(false)
  }

  // 应用自定义:MB/s → KB/s 整数(value<=0 / 空 → 0 = 本任务不限速);主进程仍 clamp。经 onLimit 落值后关闭
  const apply = (): void => {
    const mb = parseFloat(val)
    const kbps = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024) : 0
    onLimit(task.id, kbps)
    setOpen(false)
  }

  return (
    <div className="task-limit" ref={rootRef}>
      <button
        ref={btnRef}
        className="icon-btn"
        title="限速"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <IconGauge />
      </button>
      {open && (
        <div
          className={`task-menu limit-menu${dropUp ? ' up' : ''}`}
          role="dialog"
          aria-label="单任务限速"
        >
          <div className="lm-title">单任务限速(临时,重启后恢复全局)</div>
          {/* 模式二选一(#25 第三态):跟随全局 = 清除本任务覆盖;自定义 = 本任务单独限速 / 不限 */}
          <div className="lm-modes" role="radiogroup" aria-label="限速模式">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'global'}
              className={`lm-mode${mode === 'global' ? ' sel' : ''}`}
              onClick={pickGlobal}
            >
              <span className="lm-radio" />
              跟随全局
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'custom'}
              className={`lm-mode${mode === 'custom' ? ' sel' : ''}`}
              onClick={() => setMode('custom')}
            >
              <span className="lm-radio" />
              自定义
            </button>
          </div>
          {mode === 'custom' && (
            <div className="lm-row">
              <input
                className="input lm-input"
                type="number"
                min={0}
                step={0.1}
                placeholder="不限速"
                aria-label="单任务限速(MB/s)"
                value={val}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    apply()
                  }
                }}
              />
              <span className="lm-unit">MB/s</span>
              <button className="btn btn-primary" onClick={apply}>
                应用
              </button>
            </div>
          )}
          {task.kind === 'video' && task.status === 'paused' && (
            <div className="lm-hint">将在继续时生效</div>
          )}
        </div>
      )}
    </div>
  )
}
