/**
 * Toast 状态与纯函数(值导出集中处)。
 *
 * 与 `ToastContext.tsx` 的分工同 `tasksStore.ts` / `TasksContext.tsx` 先例:
 * 本文件放**值导出**(Ctx / useToast / MAX_TOASTS / enqueueToast)与类型,
 * Provider 组件留在 `.tsx` —— 避免同一文件既导出组件又导出非组件,
 * 触发 react-refresh/only-export-components(热更新失效)。
 */

import { createContext, useContext } from 'react'

export type ToastKind = 'info' | 'error'

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

export interface ToastStore {
  showToast(text: string, kind?: ToastKind): void
}

export const Ctx = createContext<ToastStore | null>(null)

export const useToast = (): ToastStore => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useToast 需在 ToastProvider 内')
  return v
}

/** 同时最多显示的 toast 数;超出按 FIFO 挤掉最旧(防连点堆积占屏) */
export const MAX_TOASTS = 3

/** 入队 + 上限裁剪(纯函数,便于单测):超过 max 时保留最新的 max 条 */
export function enqueueToast(
  prev: ToastItem[],
  item: ToastItem,
  max: number = MAX_TOASTS
): ToastItem[] {
  const next = [...prev, item]
  return next.length > max ? next.slice(next.length - max) : next
}
