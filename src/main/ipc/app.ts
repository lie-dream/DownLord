import { app, ipcMain } from 'electron'
import { join } from 'path'
import { IpcChannel, type EngineVersions } from '../../shared/ipc'

/** app 域 IPC 依赖(注入式,避免 handler 内碰可变缓存 / 全局状态) */
export interface AppIpcDeps {
  /**
   * 取引擎内核版本:启动 `--version` 探测的缓存读取器(在 index.ts 装配)。
   * 探测前 / 探测失败时回退静态 `ENGINE_VERSIONS`(诚实不崩,spec §4.4)。
   */
  getEngineVersions: () => EngineVersions
  /** 本地声明入口的运行环境与 I/O(由 main 装配,renderer 不提供路径)。 */
  thirdPartyNotices: {
    isPackaged: boolean
    appPath: string
    resourcesPath: string
    existsSync: (path: string) => boolean
    openPath: (path: string) => Promise<string>
  }
}

/**
 * 注册 app 域 IPC handler。
 * 版本 / 目录纯转发;第三方声明只允许打开主进程选定的固定文件。
 */
export function registerAppIpc(deps: AppIpcDeps): void {
  ipcMain.handle(IpcChannel.AppGetVersion, () => app.getVersion())
  ipcMain.handle(IpcChannel.AppGetDownloadDir, () => app.getPath('downloads'))
  // 关于分组内核版本:启动 --version 探测缓存(探测前 / 失败回退静态常量,spec §4.4)
  // —— 仅换数据源,通道 / EngineVersions 类型 / 关于 UI 一律不变。
  ipcMain.handle(IpcChannel.AppGetEngineVersions, () => deps.getEngineVersions())
  ipcMain.handle(
    IpcChannel.AppOpenThirdPartyNotices,
    async (_event, ...args: unknown[]): Promise<string> => {
      // 运行时也守住无参数边界,连显式 undefined 都不接受,且在任何 I/O 前拒绝。
      if (args.length !== 0) return '打开第三方许可与声明失败：此操作不接受参数。'
      try {
        const notices = deps.thirdPartyNotices
        const noticesPath = join(
          notices.isPackaged ? notices.resourcesPath : notices.appPath,
          'THIRD-PARTY-NOTICES.md'
        )
        if (!notices.existsSync(noticesPath)) {
          return '第三方许可与声明文件不存在，请检查应用文件是否完整。'
        }
        const error = await notices.openPath(noticesPath)
        return error === '' ? '' : `打开第三方许可与声明失败：${error}`
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : typeof error === 'string' ? error : ''
        return `打开第三方许可与声明失败：${detail || '未知错误，请重试。'}`
      }
    }
  )
}
