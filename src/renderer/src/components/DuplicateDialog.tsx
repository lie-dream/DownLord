/**
 * 检测重复下载决策对话框 — 复刻原型 .overlay + .dialog 三段(头 / 体 / 底,复用 AddTaskDialog.css 骨架)。
 *
 * - 主进程三创建路径查重命中 → 广播 `task:duplicate` → App 串行入队 → 本对话框逐个弹出。
 * - 单条(http / video):.dialog-foot 四决策按钮 [跳过] [重命名] [已存在·打开] [覆盖];点即落地。
 *   「已存在·打开」仅 completed / diskOnly 命中态可用(active 无已存在文件可开,spec §9.3);
 *   「覆盖」为主操作(.btn-primary),**不用 .danger 背景**——以文案「旧文件移入回收站(可恢复)」
 *   传达可逆诚实,避免与「删除」混淆(spec §9.2)。
 * - 批量(playlist,N 条):body 加「应用到全部」.select(全部覆盖 / 全部跳过 / 全部重命名)+ 逐条
 *   覆盖 .select(默认继承「应用到全部」);foot 为 [取消] [确定],确定提交 { decision, perItem }。
 *   批量不逐条「打开」(避免弹一堆窗口,spec §4.2)。
 * - 纯 UI:查重判据 / 决策落地全在主进程(§7.2);本组件只经 props 回调把决策 / 打开意图上抛,
 *   自身无业务逻辑。复用既有 .overlay / .dialog / .btn / .pill / .select + token,新增仅 .dup-list /
 *   .dup-item 布局类(色值全取 token,零新造,DESIGN §6)。
 */

import { useEffect, useMemo, useState } from 'react'
import type {
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateDecision,
  DuplicateResolution
} from '../../../shared/ipc'
import './controls.css'
import './AddTaskDialog.css'
import './DuplicateDialog.css'

interface Props {
  open: boolean
  conflict: DuplicateConflict | null
  /** 异步决策尚未返回时禁重入;错误只呈现,决策仍由挂载方处理。 */
  pending?: boolean
  error?: string | null
  /** 提交决策(单条:foot 按钮;批量:确定)→ App 调 api.resolveDuplicate + 出队 */
  onResolve: (res: DuplicateResolution) => void
  /** 打开已存在文件 / 文件夹(渲染层发起 openPath / showItemInFolder,§7.2);completed / diskOnly 可用 */
  onOpenExisting: (item: DuplicateConflictItem) => void
  /** 关闭(取消 / × / Esc):不落地决策,任务留在 awaiting_selection 待稍后再决策(§6.2 兜底),仅出队 */
  onClose: () => void
}

/** 批量可选决策(不含 open —— 批量不逐条打开,spec §4.2) */
type BatchDecision = Exclude<DuplicateDecision, 'open'>

/** 命中态 → 诚实说明文案(spec §9.3;无大小字段则不编造大小) */
function existingText(item: DuplicateConflictItem): string {
  switch (item.existing) {
    case 'completed':
      return `已下载,位于 ${item.existingDir}`
    case 'diskOnly':
      return `磁盘已存在同名文件,位于 ${item.existingDir}`
    case 'active':
      return '已在下载列表(下载中 / 排队 / 暂停)'
  }
}

export default function DuplicateDialog({
  open,
  conflict,
  pending = false,
  error = null,
  onResolve,
  onOpenExisting,
  onClose
}: Props): React.JSX.Element | null {
  const isBatch = conflict?.kind === 'batch'
  // 批量:应用到全部(默认跳过,最安全 —— 不误覆盖用户已下资产,spec §4.2)+ 逐条覆盖(空 = 继承)
  const [bulk, setBulk] = useState<BatchDecision>('skip')
  const [perItem, setPerItem] = useState<Record<number, BatchDecision>>({})

  // 每次换一个新冲突:重置批量选择态。
  // 用「渲染期调整 state」(React 官方 derived-state 模式)而非 useEffect:少一轮级联渲染。
  // 哨兵初值取当前 conflictId,故首渲不触发 —— 与原 effect 等价(原 effect 挂载时设的正是初始值,React 自身 bail out)。
  const [prevConflictId, setPrevConflictId] = useState(conflict?.conflictId)
  if (prevConflictId !== conflict?.conflictId) {
    setPrevConflictId(conflict?.conflictId)
    setBulk('skip')
    setPerItem({})
  }

  // Esc 关闭(沿用 AddTaskDialog / FormatDialog)
  useEffect(() => {
    if (!open || pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, pending])

  const items = useMemo(() => conflict?.items ?? [], [conflict])

  if (!open || !conflict) return null

  const single = items[0]
  const canOpenSingle = !isBatch && single != null && single.existing !== 'active'

  const resolve = (decision: DuplicateDecision): void => {
    onResolve({ conflictId: conflict.conflictId, decision })
  }

  const confirmBatch = (): void => {
    const overrides = Object.keys(perItem).length > 0 ? perItem : undefined
    onResolve({ conflictId: conflict.conflictId, decision: bulk, perItem: overrides })
  }

  const setItemDecision = (index: number, value: string): void => {
    setPerItem((cur) => {
      const next = { ...cur }
      if (value === '') delete next[index]
      else next[index] = value as BatchDecision
      return next
    })
  }

  return (
    <div className="overlay show">
      <div className="dialog" aria-busy={pending}>
        <div className="dialog-head">
          <h3>检测到重复下载</h3>
          <button
            disabled={pending}
            className="dialog-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          {error && (
            <p className="dup-error" role="alert">
              {error}
            </p>
          )}
          <p className="dup-lead">
            {isBatch
              ? `以下 ${items.length} 个文件已存在,请选择处理方式。`
              : '该文件已存在,请选择处理方式。'}
          </p>

          {isBatch && (
            <div className="dup-all">
              <label>应用到全部</label>
              <select
                disabled={pending}
                className="select"
                aria-label="应用到全部"
                value={bulk}
                onChange={(e) => setBulk(e.target.value as BatchDecision)}
              >
                <option value="skip">全部跳过</option>
                <option value="overwrite">全部覆盖</option>
                <option value="rename">全部重命名</option>
              </select>
            </div>
          )}

          <div className="dup-list">
            {items.map((item) => (
              <div className="dup-item" key={item.index}>
                <div className="dup-info">
                  <div className="dup-name">
                    <span className="dup-fn" title={item.filename}>
                      {item.filename}
                    </span>
                    {item.qualityLabel && <span className="pill">{item.qualityLabel}</span>}
                  </div>
                  <div className="dup-existing">{existingText(item)}</div>
                </div>
                {isBatch && (
                  <select
                    disabled={pending}
                    className="select"
                    aria-label={`处理方式:${item.filename}`}
                    value={perItem[item.index] ?? ''}
                    onChange={(e) => setItemDecision(item.index, e.target.value)}
                  >
                    <option value="">继承(应用到全部)</option>
                    <option value="overwrite">覆盖</option>
                    <option value="skip">跳过</option>
                    <option value="rename">重命名</option>
                  </select>
                )}
              </div>
            ))}
          </div>

          <p className="dup-note">
            覆盖:旧文件移入回收站(可恢复);重命名:新文件加序号 (1),旧文件保留。
          </p>
        </div>
        <div className="dialog-foot">
          {isBatch ? (
            <>
              <button disabled={pending} className="btn btn-default" onClick={onClose}>
                取消
              </button>
              <button disabled={pending} className="btn btn-primary" onClick={confirmBatch}>
                确定
              </button>
            </>
          ) : (
            <>
              <button
                disabled={pending}
                className="btn btn-default"
                onClick={() => resolve('skip')}
              >
                跳过
              </button>
              <button
                disabled={pending}
                className="btn btn-default"
                onClick={() => resolve('rename')}
              >
                重命名
              </button>
              {canOpenSingle && (
                <button
                  disabled={pending}
                  className="btn btn-default"
                  onClick={() => {
                    onOpenExisting(single)
                    resolve('open')
                  }}
                >
                  已存在 · 打开
                </button>
              )}
              <button
                disabled={pending}
                className="btn btn-primary"
                onClick={() => resolve('overwrite')}
              >
                覆盖
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
