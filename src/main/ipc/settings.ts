/**
 * 设置 IPC handler — 接线 SettingsService 与渲染进程通信(spec §3.3 / §3.4)。
 *
 * - `settings:get`:invoke/handle,读全量应用设置(设置页挂载回显)。
 * - `settings:set`:invoke/handle,写设置补丁 → 校验 / 落盘 / 联动后回最新全量(clamp 后真实值)。
 *
 * 职责:纯转发 IPC ↔ SettingsService,不含任何业务逻辑(校验 / 持久化 / 联动均在 SettingsService,
 * ARCHITECTURE §7.2)。结构仿 `ipc/proxy.ts`。
 */

import { ipcMain } from 'electron'
import { IpcChannel, type AppSettings, type AppSettingsPatch } from '../../shared/ipc'
import type { SettingsService } from '../settings/settingsService'

export interface SettingsIpcDeps {
  /** 设置业务单元(主进程装配后传入;handler 纯转发其 get / set) */
  settingsService: SettingsService
}

/**
 * 注册设置 IPC handler(两个 invoke/handle 通道,纯转发)。
 *
 * @param deps - SettingsService 注入(handler 内只调其方法并回传,绝不写校验 / 持久化 / 联动等业务逻辑)
 */
export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  // settings:get — 读全量应用设置(设置页挂载回显当前配置)
  ipcMain.handle(IpcChannel.SettingsGet, async (): Promise<AppSettings> => {
    return deps.settingsService.get()
  })

  // settings:set — 写设置补丁 → 校验 / 原子落盘 / 联动后回最新全量(clamp 后真实值供回显)
  ipcMain.handle(
    IpcChannel.SettingsSet,
    async (_event, patch: AppSettingsPatch): Promise<AppSettings> => {
      return deps.settingsService.set(patch)
    }
  )
}
