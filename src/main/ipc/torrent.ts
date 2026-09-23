/**
 * BT 种子专属 IPC handler — 接线 TaskManager 文件选择定型(v0.3 Task 2 · spec §8)+ 停止做种(v0.3 Task 3 · spec §7)。
 *
 * - `torrent:applySelection`:用户在 BtFileDialog 勾选种子内文件(1-based 索引集)→ 定型 + 出队下载
 * - `torrent:stopSeeding`:用户停止单任务做种 → forcePause 停上传(保留文件 + `.aria2`)
 *
 * 职责:纯转发 IPC ↔ TaskManager,不含业务逻辑(校验 / 定型 files[].selected / select-file 映射 / 出队
 * 全在 TaskManager.applyTorrentSelection;停做种的校验 / forcePause / 清 runtime / 广播全在
 * TaskManager.stopSeeding,§4.2 / §7;ARCHITECTURE §7.2)。仿 `ipc/video.ts` 1:1 同构。
 */

import { ipcMain } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type { TaskManager } from '../tasks/taskManager'

/**
 * 注册 BT 文件选择 IPC handler。
 *
 * @param taskManager - TaskManager 实例(由主进程 start 后传入)
 */
export function registerTorrentIpc(taskManager: TaskManager): void {
  // torrent:applySelection — 用户选定种子内文件(1-based 索引集)→ 定型 + 出队下载(纯转发,零业务)
  ipcMain.handle(
    IpcChannel.TorrentApplySelection,
    async (_event, id: string, selectedIndices: number[]): Promise<void> => {
      return await taskManager.applyTorrentSelection(id, selectedIndices)
    }
  )

  // torrent:stopSeeding — 用户停止单任务做种 → forcePause 停上传(保留文件 + .aria2)(纯转发,零业务)
  ipcMain.handle(IpcChannel.TorrentStopSeeding, async (_event, id: string): Promise<void> => {
    return await taskManager.stopSeeding(id)
  })
}
