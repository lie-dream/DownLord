/**
 * Toast 浮层 — 渲染 ToastContext 的 toast 列表(右下角,自动消失由 Provider 控制)。
 *
 * - 纯展示:无状态、无 IPC;语义类 error / info 控制左色条。
 * - 空列表不渲染(不占位)。
 */

import type { ToastItem } from '../state/toastStore'
import './Toast.css'

export default function Toast({ toasts }: { toasts: ToastItem[] }): React.JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className="toast-viewport">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          {t.text}
        </div>
      ))}
    </div>
  )
}
