/**
 * 主题 Provider。
 *
 * 本文件**只导出 Provider 组件**;Ctx / useTheme 与类型在 `./themeStore`
 * (同 tasksStore 先例,避免 react-refresh/only-export-components)。
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { ResolvedTheme, ThemeMode } from '../../../shared/ipc'
import { Ctx } from './themeStore'

export function ThemeProvider({
  children
}: {
  children: (resolved: ResolvedTheme) => ReactNode
}): React.JSX.Element {
  const [themeMode, setMode] = useState<ThemeMode>('system')
  const [resolvedTheme, setResolved] = useState<ResolvedTheme>('light')

  const applyResolvedTheme = (theme: ResolvedTheme): void => {
    setResolved(theme)
    document.documentElement.setAttribute('data-theme', theme)
  }

  useEffect(() => {
    const off = window.api.onThemeChanged((theme) => {
      applyResolvedTheme(theme)
    })
    document.documentElement.setAttribute('data-theme', resolvedTheme)
    // 挂载读持久化主题档:① 初始化 themeMode(按钮高亮档);② 主动 setTheme 同步 resolvedTheme(画面)。
    // 启动期主进程已按持久化值设 nativeTheme.themeSource,但其 theme:changed 广播在窗口创建前发出、
    // 渲染层尚未订阅而丢失 → 仅用 getSettings 设 themeMode 会致「档位=持久化值但画面/当前生效停留初始 light」
    // 错乱;故主动 setTheme(themeMode) 幂等重设 + 拿回真实 resolvedTheme 同步画面(spec §5)。
    window.api
      .getSettings()
      .then((s) => {
        setMode(s.themeMode)
        return window.api.setTheme(s.themeMode)
      })
      .then(applyResolvedTheme)
      .catch(() => {})
    return off
  }, [])

  const setTheme = async (mode: ThemeMode): Promise<void> => {
    setMode(mode)
    applyResolvedTheme(await window.api.setTheme(mode))
    // 持久化主题档(spec §5;失败不影响本次应用,下次启动回退上次持久化值)
    void window.api.setSettings({ themeMode: mode }).catch(() => {})
  }

  return (
    <Ctx.Provider value={{ themeMode, resolvedTheme, setTheme }}>
      {children(resolvedTheme)}
    </Ctx.Provider>
  )
}
