import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { IpcChannel } from '../../shared/ipc'

/**
 * `dialog.showOpenDialog` 结果 →「取消 / 无选择 = null,否则首个绝对路径」的判定。
 * 纯函数、不依赖 electron 运行时,供 selectDirectory / selectFile 共用同一契约(可单测;
 * handler 本体依赖 electron 在 electron-as-node 测试环境不可直跑,故判定逻辑抽此,见 dialog.test.ts)。
 */
export function firstPathOrNull(res: { canceled: boolean; filePaths: string[] }): string | null {
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
}

export function registerDialogIpc(): void {
  ipcMain.handle(IpcChannel.DialogSelectDirectory, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    return firstPathOrNull(res)
  })

  // v0.2 Task 1 · Cookie=从文件:选 Netscape cookies.txt(纯转发,零业务;openFile + txt 过滤,
  // 契约与 selectDirectory 一致——取消 / 无选择返回 null,选中返回绝对路径)。
  // v0.3 Task 1 · 加可选 filters(§10.4 向后兼容):torrent 传 `.torrent` filter 选种子文件;
  // 缺省(未传 options / 无 filters)= cookie `.txt` + 所有文件,现有 cookie 文件选择零回归。
  ipcMain.handle(
    IpcChannel.DialogSelectFile,
    async (
      _event,
      options?: { filters?: { name: string; extensions: string[] }[] }
    ): Promise<string | null> => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const dialogOptions: OpenDialogOptions = {
        properties: ['openFile'],
        filters: options?.filters ?? [
          { name: 'Cookie 文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      }
      const res = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

      return firstPathOrNull(res)
    }
  )
}
