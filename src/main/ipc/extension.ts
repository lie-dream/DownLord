/**
 * 扩展本地通道 IPC handler — 接线 `ExtensionChannelService` 与渲染进程通信(v0.4 Task 3 · spec §5 / plan 1.8)。
 *
 * - `extension:getChannelConfig`:invoke/handle,读 `{enabled,port,token}`(设置页回显 + 配对码)。
 * - `extension:setChannelConfig`:invoke/handle,写 `{enabled,port}` → 起停 / 重绑 → 回即时状态。
 * - `extension:regenerateToken`:invoke/handle,重新生成配对码 → 回新配置(旧配对当场失效)。
 * - `extension:getChannelStatus`:invoke/handle,取两行状态(服务态 + 扩展三态)。
 * - `extension:getSideloadInfo`:invoke/handle,取扩展目录 `{dir,exists}`(#42)。
 * - `extension:channelStatusChanged`:main→renderer 主动推,service 广播回调里向所有窗口推最新状态。
 *
 * 职责:纯转发 IPC ↔ ExtensionChannelService,不含业务逻辑(校验 / 起停 / 鉴权 / 持久化均在
 * service 与其纯函数,ARCHITECTURE §7.2)。
 *
 * ⚠️ **`setChannelConfig` 刻意不接受 `token`** —— 渲染层不该有能力写入任意密钥,
 * 重新生成走独立的 `extension:regenerateToken`(spec §3.2)。
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  IpcChannel,
  type ExtensionChannelConfig,
  type ExtensionChannelConfigPatch,
  type ExtensionChannelStatus,
  type ExtensionSideloadInfo
} from '../../shared/ipc'
import type { ExtensionChannelService } from '../extensionChannel/extensionChannelService'

export interface ExtensionIpcDeps {
  /** 本地通道业务单元(主进程装配后传入;handler 纯转发其方法) */
  channelService: ExtensionChannelService
}

/**
 * 向所有窗口推送本地通道状态变更(spec §5)。
 *
 * 供 `ExtensionChannelService` 构造期 `onStatusChanged` 注入:起停 / 重绑 / 握手成功 /
 * 重新生成 token 后经此把最新 `ExtensionChannelStatus` 广播到所有窗口。
 * 逐字仿 `proxy.ts` 的 `broadcastProxyStatusChanged`,遍历未销毁窗口 `webContents.send`。
 */
export function broadcastExtensionChannelStatus(status: ExtensionChannelStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ExtensionChannelStatusChanged, status)
    }
  }
}

/**
 * 注册扩展通道 IPC handler(五个 invoke/handle 通道;
 * `extension:channelStatusChanged` 推送见 `broadcastExtensionChannelStatus`)。
 *
 * @param deps - ExtensionChannelService 注入(handler 内只调其方法并回传,绝不写校验 / 起停 / 持久化等业务逻辑)
 */
export function registerExtensionIpc(deps: ExtensionIpcDeps): void {
  // extension:getChannelConfig — 读通道配置(设置页回显开关 / 端口 + 展示配对码)
  ipcMain.handle(
    IpcChannel.ExtensionGetChannelConfig,
    async (): Promise<ExtensionChannelConfig> => {
      return deps.channelService.getConfig()
    }
  )

  // extension:setChannelConfig — 写开关 / 端口 → 起停 / 重绑 → 回即时状态(端口非法则不落盘)
  ipcMain.handle(
    IpcChannel.ExtensionSetChannelConfig,
    async (_event, patch: ExtensionChannelConfigPatch): Promise<ExtensionChannelStatus> => {
      return deps.channelService.setConfig(patch)
    }
  )

  // extension:regenerateToken — 重新生成配对码 → 落盘 + 清连接态 + 广播 → 回新配置
  ipcMain.handle(
    IpcChannel.ExtensionRegenerateToken,
    async (): Promise<ExtensionChannelConfig> => {
      return deps.channelService.regenerateToken()
    }
  )

  // extension:getChannelStatus — 取两行状态(设置页挂载回显)
  ipcMain.handle(
    IpcChannel.ExtensionGetChannelStatus,
    async (): Promise<ExtensionChannelStatus> => {
      return deps.channelService.getStatus()
    }
  )

  // extension:getSideloadInfo — 取扩展目录 {dir,exists}(#42 发现引导;运行时实探)
  ipcMain.handle(
    IpcChannel.ExtensionGetSideloadInfo,
    async (): Promise<ExtensionSideloadInfo> => {
      return deps.channelService.getSideloadInfo()
    }
  )
}
