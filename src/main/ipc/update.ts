/**
 * 更新 IPC handler — 接线 YtdlpUpdater / AppUpdater 与渲染进程通信(v0.2 Task 6 · spec §4.2 / §1.8)。
 *
 * - `update:checkYtDlp` / `update:runYtDlp`:invoke/handle,纯转发 `YtdlpUpdater.check` / `run`。
 * - `update:checkApp` / `update:downloadApp` / `update:quitInstallApp`:invoke/handle,纯转发
 *   `AppUpdater.check` / `download` / `quitAndInstall`。
 * - `update:status`:main→renderer 主动推,两 updater 构造期注入的 `onStatus` 经 `broadcastUpdateStatus`
 *   向所有窗口推最新 `UpdateStatus`(yt-dlp / app 共用一条通道)。
 *
 * 职责:纯转发 IPC ↔ updater service,零业务逻辑(检查 / 网络 / 下载 / 校验 / 替换全在 service,ARCHITECTURE §7.2)。
 * handler 本体依赖 electron `ipcMain`,在 electron-as-node 测试环境下不可直跑(同 `history.ts` / `category.ts`):
 * 故转发主体抽为可导出 `createUpdateHandlers`(注入 fake service 单测调对应方法并回传),`registerUpdateIpc` 仅薄包装注册。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannel, type UpdateCheckResult, type UpdateStatus } from '../../shared/ipc'
import type { YtdlpUpdater } from '../update/ytdlpUpdater'
import type { AppUpdater } from '../update/appUpdater'

export interface UpdateIpcDeps {
  /** yt-dlp 热更新编排(handler 纯转发 check / run;检查 / 下载 / 三重校验 / 替换全在其内,spec §2) */
  ytdlpUpdater: Pick<YtdlpUpdater, 'check' | 'run'>
  /** 应用本体自更新(handler 纯转发 check / download / quitAndInstall;electron-updater 全在其内,spec §3) */
  appUpdater: Pick<AppUpdater, 'check' | 'download' | 'quitAndInstall'>
}

/** 更新 handler 转发主体(不碰 ipcMain,供 `registerUpdateIpc` 装配 + 单测直调,注入 fake service 断言) */
export interface UpdateHandlers {
  checkYtDlp(): Promise<UpdateCheckResult>
  runYtDlp(): Promise<void>
  checkApp(): Promise<UpdateCheckResult>
  downloadApp(): Promise<void>
  quitInstallApp(): Promise<void>
}

/**
 * 更新 handler 转发主体工厂(spec §7.1「IPC 纯转发」)。
 * 每个方法纯转发到对应 updater 方法并回传;**零校验 / 网络 / 下载 / 校验 / 替换逻辑**(全在 service,§7.2)。
 * 抽为可导出函数以便单测(注入 fake service,断言 handler 调对应方法并回传),与 `history.ts` 抽 `runHistorySearch` 同模式。
 */
export function createUpdateHandlers(deps: UpdateIpcDeps): UpdateHandlers {
  return {
    checkYtDlp: () => deps.ytdlpUpdater.check(),
    runYtDlp: () => deps.ytdlpUpdater.run(),
    checkApp: () => deps.appUpdater.check(),
    downloadApp: () => deps.appUpdater.download(),
    // quitAndInstall 同步(退出 → NSIS 升级 → 重启);包为 Promise<void> 与 invoke/handle 契约一致
    quitInstallApp: async () => {
      deps.appUpdater.quitAndInstall()
    }
  }
}

/**
 * 向所有窗口推送更新状态 / 进度(spec §4.2 `update:status`)。
 *
 * 供 `YtdlpUpdater` / `AppUpdater` 构造期 `onStatus` 注入:检查 / 下载 / 校验 / 替换各阶段经此把最新
 * `UpdateStatus` 广播到所有窗口。仿 `proxy.ts` 的 `broadcastProxyStatusChanged`,遍历未销毁窗口 `webContents.send`。
 */
export function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.UpdateStatus, status)
    }
  }
}

/**
 * 注册更新 IPC handler(五个 invoke/handle 通道;`update:status` 推送见 `broadcastUpdateStatus`)。
 *
 * @param deps - YtdlpUpdater / AppUpdater 注入(handler 内只调其方法并回传,绝不写检查 / 下载 / 校验等业务逻辑)
 */
export function registerUpdateIpc(deps: UpdateIpcDeps): void {
  const handlers = createUpdateHandlers(deps)

  // update:checkYtDlp — 手动检查 yt-dlp 更新(无视节流)
  ipcMain.handle(IpcChannel.UpdateCheckYtDlp, async (): Promise<UpdateCheckResult> => {
    return handlers.checkYtDlp()
  })

  // update:runYtDlp — 执行 yt-dlp 更新(检查→下载→三重校验→替换 / pending)
  ipcMain.handle(IpcChannel.UpdateRunYtDlp, async (): Promise<void> => {
    return handlers.runYtDlp()
  })

  // update:checkApp — 检查应用本体更新(不自动下载)
  ipcMain.handle(IpcChannel.UpdateCheckApp, async (): Promise<UpdateCheckResult> => {
    return handlers.checkApp()
  })

  // update:downloadApp — 下载应用更新(用户确认后)
  ipcMain.handle(IpcChannel.UpdateDownloadApp, async (): Promise<void> => {
    return handlers.downloadApp()
  })

  // update:quitInstallApp — 退出并安装已下载的应用更新(用户点「重启安装」)
  ipcMain.handle(IpcChannel.UpdateQuitInstallApp, async (): Promise<void> => {
    return handlers.quitInstallApp()
  })
}
