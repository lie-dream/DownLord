/**
 * 主题状态(值导出集中处)。
 *
 * 与 `ThemeContext.tsx` 的分工同 `tasksStore.ts` / `TasksContext.tsx` 先例:
 * 本文件放**值导出**(Ctx / useTheme)与类型,Provider 组件留在 `.tsx` ——
 * 避免同一文件既导出组件又导出非组件,触发 react-refresh/only-export-components(热更新失效)。
 */

import { createContext, useContext } from 'react'
import type { ResolvedTheme, ThemeMode } from '../../../shared/ipc'

export interface ThemeStore {
  themeMode: ThemeMode
  resolvedTheme: ResolvedTheme
  setTheme(mode: ThemeMode): Promise<void>
}

export const Ctx = createContext<ThemeStore | null>(null)

export const useTheme = (): ThemeStore => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme 需在 ThemeProvider 内')
  return v
}
