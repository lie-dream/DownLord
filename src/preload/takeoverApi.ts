/**
 * 接管确认小窗口的 API 面(`window.takeoverApi`,十二条)——v0.4 Task 4 · spec §3.6。
 *
 * ★ **与 `mainApi.ts` 的 55 条互不可见**:preload 按窗口标记**只 expose 一个对象**(见 `index.ts`)。
 *   给一个「只该确认一次下载」的窗口发 `removeTask` / `settings:set` / `regenerateToken` 是错的 ——
 *   最小暴露面靠**分支**保障(§7.2 的「接口形状即职责边界」),不靠约定。
 *
 * 十二条里**七条复用既有 IPC 通道**(`resolveDuplicate` / `openPath` / `showItemInFolder` /
 * `selectDirectory` / `getSettings` / `listCategories` / `onThemeChanged`)——`ipcMain.handle` 与
 * `theme:changed` 广播都是全局注册、与窗口无关,故这七条**主进程侧一行都不改**。
 *
 * 纯转发,不含任何业务逻辑 —— 与 `mainApi.ts` 同一纪律。
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type ResolvedTheme,
  type TakeoverApi,
  type TakeoverBatch,
  type TakeoverSubmitPayload,
  type DuplicateConflict,
  type DuplicateResolution
} from '../shared/ipc'

export const takeoverApi: TakeoverApi = {
  onPresent: (callback: (batch: TakeoverBatch) => void) => {
    const listener = (_event: IpcRendererEvent, batch: TakeoverBatch): void => callback(batch)
    ipcRenderer.on(IpcChannel.TakeoverPresent, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TakeoverPresent, listener)
    }
  },
  onDuplicate: (callback: (conflict: DuplicateConflict) => void) => {
    const listener = (_event: IpcRendererEvent, conflict: DuplicateConflict): void =>
      callback(conflict)
    ipcRenderer.on(IpcChannel.TakeoverDuplicate, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TakeoverDuplicate, listener)
    }
  },
  ready: () => ipcRenderer.send(IpcChannel.TakeoverReady),
  submit: (payload: TakeoverSubmitPayload) => ipcRenderer.send(IpcChannel.TakeoverSubmit, payload),
  dismiss: () => ipcRenderer.send(IpcChannel.TakeoverDismiss),
  duplicatesSettled: () => ipcRenderer.send(IpcChannel.TakeoverSettled),
  // ── 以下六条复用既有通道,与 `mainApi.ts` 逐字同形(主进程 handler 零新增)──────────
  resolveDuplicate: (res: DuplicateResolution) =>
    ipcRenderer.invoke(IpcChannel.DuplicateResolve, res),
  openPath: (path: string) => ipcRenderer.invoke(IpcChannel.ShellOpenPath, path),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IpcChannel.ShellShowItemInFolder, path),
  selectDirectory: () => ipcRenderer.invoke(IpcChannel.DialogSelectDirectory),
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  listCategories: () => ipcRenderer.invoke(IpcChannel.CategoryList),
  onThemeChanged: (callback: (theme: ResolvedTheme) => void) => {
    const listener = (_event: IpcRendererEvent, theme: ResolvedTheme): void => callback(theme)
    ipcRenderer.on(IpcChannel.ThemeChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.ThemeChanged, listener)
    }
  }
}
