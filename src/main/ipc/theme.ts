/**
 * 主题控制 IPC handler — 驱动 nativeTheme 切换系统级主题,并推送变化。
 *
 * - `theme:set`:接收三态(system/light/dark),设置 `nativeTheme.themeSource`,返回生效主题。
 * - `theme:changed`:监听 `nativeTheme.on('updated')`,向所有窗口推送当前生效主题。
 * - nativeTheme.shouldUseDarkColors 为权威源(Windows 11 跟随系统暗色模式)。
 */

import { ipcMain, nativeTheme, BrowserWindow } from 'electron'
import { IpcChannel, type ThemeMode, type ResolvedTheme } from '../../shared/ipc'

/**
 * 获取当前生效主题(light/dark),基于 nativeTheme 权威源。
 */
function getResolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 向所有窗口推送主题变化。
 */
function broadcastThemeChanged(): void {
  const theme = getResolvedTheme()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ThemeChanged, theme)
    }
  }
}

/**
 * 注册主题控制 IPC handler + 监听系统主题变化。
 */
export function registerThemeIpc(): void {
  // theme:set — 设置三态主题模式,驱动 nativeTheme
  ipcMain.handle(IpcChannel.ThemeSet, (_event, mode: ThemeMode): ResolvedTheme => {
    // 设置 themeSource:system(跟随系统)/ light / dark
    nativeTheme.themeSource = mode
    // 返回当前生效主题(system 态下需根据系统偏好解析)
    return getResolvedTheme()
  })

  // 监听系统主题变化(Windows 用户切换系统暗色模式时触发),推送所有窗口
  nativeTheme.on('updated', () => {
    broadcastThemeChanged()
  })
}
