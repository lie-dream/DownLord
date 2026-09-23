/**
 * 代理 IPC handler — 接线 ProxyService 与渲染进程通信(spec §7.1)。
 *
 * - `proxy:get`:invoke/handle,读当前代理配置(设置面板回显当前档 / 手动地址)。
 * - `proxy:set`:invoke/handle,写代理配置 → 返回 set 后即时 `ProxyStatus`(含一次代理端口探测)。
 * - `proxy:getStatus`:invoke/handle,取当前代理状态(含一次探测;direct 档不探)。
 * - `proxy:statusChanged`:main→renderer 主动推,`ProxyService` 广播回调里向所有窗口推最新 `ProxyStatus`。
 *
 * 职责:纯转发 IPC ↔ ProxyService,不含业务逻辑(校验 / 读系统代理 / 探测 / 持久化均在 ProxyService,ARCHITECTURE §7.2)。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannel, type ProxyConfig, type ProxyStatus } from '../../shared/ipc'
import type { ProxyService } from '../proxy/proxyService'

export interface ProxyIpcDeps {
  /** 代理业务单元(主进程装配后传入;handler 纯转发其 getProxyConfig / setConfig / getStatus) */
  proxyService: ProxyService
}

/**
 * 向所有窗口推送代理状态变更(spec §7.1 `proxy:statusChanged`)。
 *
 * 供 `ProxyService` 构造期 `onStatusChanged` 注入:`setConfig` 后经此把最新 `ProxyStatus` 广播到所有窗口。
 * 仿 `theme.ts` 的 `broadcastThemeChanged`,遍历未销毁窗口 `webContents.send`。
 */
export function broadcastProxyStatusChanged(status: ProxyStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ProxyStatusChanged, status)
    }
  }
}

/**
 * 注册代理 IPC handler(三个 invoke/handle 通道;`proxy:statusChanged` 推送见 `broadcastProxyStatusChanged`)。
 *
 * @param deps - ProxyService 注入(handler 内只调其方法并回传,绝不写校验 / 探测 / 持久化等业务逻辑)
 */
export function registerProxyIpc(deps: ProxyIpcDeps): void {
  // proxy:get — 读当前代理配置(设置面板回显当前档 / 手动地址)
  ipcMain.handle(IpcChannel.ProxyGet, async (): Promise<ProxyConfig> => {
    return deps.proxyService.getProxyConfig()
  })

  // proxy:set — 写代理配置(切档 / 改手动地址)→ 返回 set 后即时 ProxyStatus(含一次探测)
  ipcMain.handle(IpcChannel.ProxySet, async (_event, config: ProxyConfig): Promise<ProxyStatus> => {
    return deps.proxyService.setConfig(config)
  })

  // proxy:getStatus — 取当前代理状态(含一次代理端口探测;direct 档不探)
  ipcMain.handle(IpcChannel.ProxyGetStatus, async (): Promise<ProxyStatus> => {
    return deps.proxyService.getStatus()
  })
}
