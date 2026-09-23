/**
 * 窗口控制 IPC handler — 自定义无边框标题栏的窗口操作(最小化 / 最大化 / 关闭)。
 *
 * - 监听 window:minimize / window:toggleMaximize / window:close(单向 send,不返回)。
 * - 从发送者的 webContents 回溯到对应 BrowserWindow(支持多窗口时自动适配)。
 */

import { ipcMain, type IpcMainEvent, BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'

/**
 * 注册窗口控制 IPC handler(单向 send 监听器)。
 */
export function registerWindowIpc(): void {
  ipcMain.on(IpcChannel.WindowMinimize, (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.minimize()
    }
  })

  ipcMain.on(IpcChannel.WindowToggleMaximize, (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  ipcMain.on(IpcChannel.WindowClose, (event: IpcMainEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })
}
