import { ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { IpcChannel } from '../../shared/ipc'

/** 文件缺失统一可读提示(§6.3 错误可读;打开文件 / 文件夹一致) */
const FILE_MISSING = '文件不存在,可能已被移动或删除'

/**
 * 注册 shell 域 IPC handler(纯转发系统 shell,无业务逻辑)。
 *
 * - 打开前先 existsSync 检测:文件不存在 → 返回可读中文错误,避免
 *   openPath 依赖系统英文弹窗、showItemInFolder 静默无反应的不一致(§6.3)。
 * - 两者均返回错误串(空=成功),renderer 经 toast 展示。
 */
export function registerShellIpc(): void {
  ipcMain.handle(IpcChannel.ShellOpenPath, async (_event, p: string): Promise<string> => {
    if (!existsSync(p)) return FILE_MISSING
    return shell.openPath(p)
  })
  ipcMain.handle(IpcChannel.ShellShowItemInFolder, async (_event, p: string): Promise<string> => {
    if (!existsSync(p)) return FILE_MISSING
    shell.showItemInFolder(p)
    return ''
  })
}
