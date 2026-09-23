/**
 * 视频专属 IPC handler — 接线 TaskManager 视频解析 / 格式选择 / 批量(spec §6.4 / plan Task 3.1)。
 *
 * - `video:getResolved`:取瞬时解析结果(格式 / 批量对话框拉取)
 * - `video:select`:用户 / 自动选定格式 → 入队下载
 * - `video:submitBatch`:播放列表批量提交(展开 N 子任务,Phase 5 收口)
 *
 * 职责:纯转发 IPC ↔ TaskManager,不含业务逻辑(TaskManager 已是唯一枢纽,ARCHITECTURE §7.2)。
 */

import { ipcMain } from 'electron'
import { IpcChannel, type BatchPick, type FormatChoice, type ResolveResult } from '../../shared/ipc'
import type { TaskManager } from '../tasks/taskManager'

/**
 * 注册视频 IPC handler。
 *
 * @param taskManager - TaskManager 实例(由主进程 start 后传入)
 */
export function registerVideoIpc(taskManager: TaskManager): void {
  // video:getResolved — 取瞬时解析结果(不落库、可重解析;同步读内存 resolvedMap)
  ipcMain.handle(
    IpcChannel.VideoGetResolved,
    async (_event, id: string): Promise<ResolveResult | null> => {
      return taskManager.getResolved(id)
    }
  )

  // video:select — 用户 / 自动选定格式 → 入队下载
  ipcMain.handle(
    IpcChannel.VideoSelect,
    async (_event, id: string, choice: FormatChoice): Promise<void> => {
      return await taskManager.selectFormat(id, choice)
    }
  )

  // video:submitBatch — 播放列表批量提交(展开为 N 子任务)
  ipcMain.handle(
    IpcChannel.VideoSubmitBatch,
    async (_event, parentId: string, picks: BatchPick[]): Promise<void> => {
      return await taskManager.submitBatch(parentId, picks)
    }
  )
}
