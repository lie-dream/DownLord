/**
 * 任务 IPC handler — 接线 TaskManager 与渲染进程通信(spec §9.2)。
 *
 * - `task:add/pause/resume/remove/retry/setLimit/list`:invoke/handle 模式,直接调用 TaskManager 方法
 * - `task:progress`:广播模式,订阅 TaskManager.onProgress 推送所有窗口
 *
 * 职责:纯转发 IPC ↔ TaskManager,不含业务逻辑(TaskManager 已是唯一枢纽,ARCHITECTURE §7.2)。
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  IpcChannel,
  type AddTaskInput,
  type DuplicateConflict,
  type DuplicateResolution,
  type Task,
  type TaskFilter,
  type TaskProgress
} from '../../shared/ipc'
import type { TaskManager } from '../tasks/taskManager'

/** 向所有窗口推送任务进度 */
function broadcastProgress(progress: TaskProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.TASK_PROGRESS, progress)
    }
  }
}

/**
 * 广播目标窗口的最小操作面。
 *
 * 抽出来只为**可注入**:`npm test` 跑在 electron-as-node 下,`BrowserWindow` 恒为 undefined,
 * 不注入就无从断言「每一个窗口都收到了」这条扇出行为(同 `createBtHandlers` /
 * `createTakeoverIpcHandlers` 的既有做法 —— 电子依赖留在薄包装里,主体可测)。
 */
export interface DuplicateBroadcastWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, conflict: DuplicateConflict): void }
}

/**
 * `registerTaskIpc` 的可选注入(**签名加性,缺省逐字等价**;v0.4 Task 4 · spec §6.3)。
 *
 * ★ 这是本 Task 对既有代码的**第二处**改动 —— Step 0 未预见、Step 1 推演出来,**如实记账,
 *   不硬凑成「唯一例外 headers」**(那样收口时 git diff 佐证对不上账)。
 */
export interface TaskIpcDeps {
  /**
   * v0.4 Task 4:接管确认小窗口独占的冲突,不再广播给其它窗口(否则主窗口会弹一个**陈旧的**
   * 查重框:用户在小窗口点完后它变僵尸框,点它 → `resolveDuplicate` 未知 conflictId → 记一条
   * console.error 后忽略,不出错但很难看,且直接违反「主窗口全程不动」)。
   *
   * **缺省 undefined → 短路(`?.` 恒回 undefined),广播行为与 Task 3 交付态逐字等价**(U-15)。
   */
  isOwnedByTakeover?: (conflictId: string) => boolean
}

/** 向所有窗口推送重复检测冲突(v0.2 Task 3 · spec §8;仿 broadcastProgress) */
export function broadcastDuplicate(
  conflict: DuplicateConflict,
  deps: TaskIpcDeps = {},
  windows: DuplicateBroadcastWindow[] = BrowserWindow.getAllWindows()
): void {
  // ★ spec §6.3 的全部改动 = 这一行;下面的遍历逐字不动
  if (deps.isOwnedByTakeover?.(conflict.conflictId)) return
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.TaskDuplicate, conflict)
    }
  }
}

/**
 * 注册任务 IPC handler + 订阅进度推送。
 *
 * @param taskManager - TaskManager 实例(由主进程 start 后传入)
 * @param deps - 可选注入(v0.4 Task 4 · spec §6.3);**缺省 `{}` → 与 Task 3 交付态逐字等价**
 */
export function registerTaskIpc(taskManager: TaskManager, deps: TaskIpcDeps = {}): void {
  // task:add — 新增统一任务,返回内部任务 id
  ipcMain.handle(IpcChannel.TASK_ADD, async (_event, input: AddTaskInput): Promise<string> => {
    return await taskManager.addTask(input)
  })

  // task:pause — 暂停指定任务
  ipcMain.handle(IpcChannel.TASK_PAUSE, async (_event, id: string): Promise<void> => {
    return await taskManager.pauseTask(id)
  })

  // task:resume — 恢复指定任务
  ipcMain.handle(IpcChannel.TASK_RESUME, async (_event, id: string): Promise<void> => {
    return await taskManager.resumeTask(id)
  })

  // task:remove — 删除指定任务(deleteFile 可选:completed 成品移回收站;缺省 false 向后兼容)
  ipcMain.handle(
    IpcChannel.TASK_REMOVE,
    async (_event, id: string, deleteFile?: boolean): Promise<void> => {
      return await taskManager.removeTask(id, { deleteFile })
    }
  )

  // task:retry — 重试失败任务
  ipcMain.handle(IpcChannel.TASK_RETRY, async (_event, id: string): Promise<void> => {
    return await taskManager.retryTask(id)
  })

  // task:setLimit — 设单任务限速 KB/s(纯转发;clamp / 换算不在此处,主进程 / 渲染负责)
  // v0.3 Task 4 #25:值域 number | null(`null` = 清除任务级覆盖 = 跟随全局),仍是纯转发
  ipcMain.handle(
    IpcChannel.TaskSetLimit,
    async (_event, id: string, kbps: number | null): Promise<void> => {
      return await taskManager.setTaskLimit(id, kbps)
    }
  )

  // task:list — 列出任务(支持状态 / 类别筛选)
  ipcMain.handle(IpcChannel.TASK_LIST, async (_event, filter?: TaskFilter): Promise<Task[]> => {
    return taskManager.listTasks(filter)
  })

  // duplicate:resolve — 提交用户重复决策(纯转发;判据 / 决策落地全在 TaskManager,ARCHITECTURE §7.2)
  ipcMain.handle(
    IpcChannel.DuplicateResolve,
    async (_event, res: DuplicateResolution): Promise<void> => {
      return await taskManager.resolveDuplicate(res)
    }
  )

  // 订阅 TaskManager 进度事件,广播给所有窗口
  taskManager.onProgress((progress: TaskProgress) => {
    broadcastProgress(progress)
  })

  // 订阅 TaskManager 重复检测事件,广播给所有窗口(仿 onProgress;index.ts 无需注入回调)
  taskManager.onDuplicate((conflict: DuplicateConflict) => {
    broadcastDuplicate(conflict, deps)
  })
}
