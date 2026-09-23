/**
 * 轻量 toast — 操作级可读提示(打开文件 / 文件夹失败等,§6.3 错误可读)。
 *
 * - 右下角浮层、自动消失(默认 4s);不打断、不崩 UI。
 * - showToast(text, kind) 入队;TasksContext 等消费者在操作返回可读错误时调用。
 * - 本 Task 仅用于「文件不存在」一类操作错误;后续可复用为通用提示通道。
 *
 * 本文件**只导出 Provider 组件**;Ctx / useToast / MAX_TOASTS / enqueueToast 与类型在
 * `./toastStore`(同 tasksStore 先例,避免 react-refresh/only-export-components)。
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import Toast from '../components/Toast'
import { Ctx, enqueueToast, type ToastItem, type ToastKind } from './toastStore'

const TOAST_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  // showToast 引用稳定(内部只用 ref + 函数式 setState,无渲染期闭包依赖)+ context 值 memo:
  // 否则每条 toast 出现 / 消失都会换新 context 值,把消费方(TasksProvider)连同全树白重渲染两轮
  const showToast = useCallback((text: string, kind: ToastKind = 'info'): void => {
    const id = ++nextId.current
    setToasts((prev) => enqueueToast(prev, { id, text, kind }))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, TOAST_MS)
  }, [])

  const store = useMemo(() => ({ showToast }), [showToast])

  return (
    <Ctx.Provider value={store}>
      {children}
      <Toast toasts={toasts} />
    </Ctx.Provider>
  )
}
