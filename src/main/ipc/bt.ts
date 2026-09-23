/**
 * BT IPC handler — 接线 tracker 热更新 service / 入站自检与渲染进程通信(v0.4 Task 1 · spec §5.3)。
 *
 * - `bt:getTrackerStatus`:invoke/handle,纯转发 `BtTrackerService.getStatus`(设置页挂载回显)。
 * - `bt:updateTrackersNow`:invoke/handle,纯转发 `BtTrackerService.updateNow`(**无视节流与开关**,
 *   返回本次结果供渲染层 toast —— 手动路径成败都弹,D15)。
 * - `bt:getInboundDiagnosis`:invoke/handle,纯转发注入的 `diagnose()`(**每次实算、不缓存**,spec §3.4)。
 * - `bt:trackerStatusChanged` / `bt:inboundChanged`:main→renderer 主动推,经 `broadcastBtTrackerStatus` /
 *   `broadcastInboundChanged` 向所有窗口推最新 payload(前者由 service 构造期 `onStatus` 注入,
 *   后者由 `index.ts` 在 powerMonitor resume / 添加 BT 任务时**比较后变了才**调用)。
 *
 * 职责:纯转发 IPC ↔ service / 纯函数,零业务逻辑(拉取 / 解析 / 合并 / 节流 / IPv6 判定 / 三态汇总
 * 全在主进程 service 与纯函数里,ARCHITECTURE §7.2)。
 * handler 本体依赖 electron `ipcMain`,在 electron-as-node 测试环境下不可直跑(同 `update.ts`):
 * 故转发主体抽为可导出 `createBtHandlers`(注入 fake service 单测调对应方法并回传),`registerBtIpc` 仅薄包装注册。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannel, type BtTrackerStatus, type InboundDiagnosis } from '../../shared/ipc'
import type { BtTrackerService } from '../bt/btTrackerService'

export interface BtIpcDeps {
  /** tracker 热更新编排(handler 纯转发 getStatus / updateNow;拉取 / 解析 / 节流 / 落盘 / 热应用全在其内,spec §4) */
  trackerService: Pick<BtTrackerService, 'getStatus' | 'updateNow'>
  /** 入站自检(注入 `diagnoseInbound` 的绑定版;**每次调用都实算**,主进程不缓存结果,spec §3.4) */
  diagnose: () => InboundDiagnosis
}

/** BT handler 转发主体(不碰 ipcMain,供 `registerBtIpc` 装配 + 单测直调,注入 fake service 断言) */
export interface BtHandlers {
  getTrackerStatus(): Promise<BtTrackerStatus>
  updateTrackersNow(): Promise<BtTrackerStatus>
  getInboundDiagnosis(): Promise<InboundDiagnosis>
}

/**
 * BT handler 转发主体工厂(spec §5.3「IPC 纯转发」)。
 * 每个方法纯转发到对应 service / 纯函数并回传;**零判定逻辑**(§7.2)。
 * 抽为可导出函数以便单测(注入 fake,断言 handler 调对应方法并回传),与 `update.ts` 同模式。
 */
export function createBtHandlers(deps: BtIpcDeps): BtHandlers {
  return {
    getTrackerStatus: () => deps.trackerService.getStatus(),
    updateTrackersNow: () => deps.trackerService.updateNow(),
    // diagnose 同步(纯本地读网卡,微秒级);包为 Promise 与 invoke/handle 契约一致
    getInboundDiagnosis: async () => deps.diagnose()
  }
}

/**
 * 向所有窗口推送 tracker 状态(spec §5.3 `bt:trackerStatusChanged`)。
 *
 * 供 `BtTrackerService` 构造期 `onStatus` 注入:自动路径拉取各阶段经此把最新 `BtTrackerStatus`
 * 广播到所有窗口(**自动路径只更新状态行,不弹 toast**,D15)。仿 `update.ts` 的 `broadcastUpdateStatus`。
 */
export function broadcastBtTrackerStatus(status: BtTrackerStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.BtTrackerStatusChanged, status)
    }
  }
}

/**
 * 向所有窗口推送入站诊断(spec §5.3 `bt:inboundChanged`)。
 *
 * 由 `index.ts` 在 `powerMonitor` resume / 添加 BT 任务时重算后调用,且**与上次结果比较、`state` 变了才**调用
 * (§3.4;比较逻辑在调用方,本函数只负责发)。仿 `broadcastUpdateStatus`。
 */
export function broadcastInboundChanged(diagnosis: InboundDiagnosis): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.BtInboundChanged, diagnosis)
    }
  }
}

/**
 * 注册 BT IPC handler(三个 invoke/handle 通道;两条推送见 `broadcastBtTrackerStatus` / `broadcastInboundChanged`)。
 *
 * @param deps - BtTrackerService + 入站自检注入(handler 内只调其方法并回传,绝不写拉取 / 节流 / 判定等业务逻辑)
 */
export function registerBtIpc(deps: BtIpcDeps): void {
  const handlers = createBtHandlers(deps)

  // bt:getTrackerStatus — 取 tracker 表更新状态(设置页挂载回显)
  ipcMain.handle(IpcChannel.BtGetTrackerStatus, async (): Promise<BtTrackerStatus> => {
    return handlers.getTrackerStatus()
  })

  // bt:updateTrackersNow — 立即更新 tracker 表(无视 12h 节流 / 30min 退避 / 自动更新开关)
  ipcMain.handle(IpcChannel.BtUpdateTrackersNow, async (): Promise<BtTrackerStatus> => {
    return handlers.updateTrackersNow()
  })

  // bt:getInboundDiagnosis — 取入站可达自检结果(每次实算,不缓存)
  ipcMain.handle(IpcChannel.BtGetInboundDiagnosis, async (): Promise<InboundDiagnosis> => {
    return handlers.getInboundDiagnosis()
  })
}
