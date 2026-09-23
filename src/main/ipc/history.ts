/**
 * 历史检索 / 统计 IPC handler — 接线 taskDao 只读查询与渲染进程通信(v0.2 Task 5 · spec §7.2)。
 *
 * - `history:search`:invoke/handle 模式,历史检索(filename/source LIKE + 状态/类别/时间过滤)。
 * - `history:stats`:invoke/handle 模式,历史统计聚合(按类别 + 时间窗口,仅 completed 计入)。
 *
 * 职责:纯转发 IPC ↔ taskDao,零业务逻辑(ARCHITECTURE §7.2)——时间口径换算 / limit clamp / text trim
 * 全调 Phase 1 纯函数(`historyTime.ts`),检索 / 聚合调 Phase 1 DAO(`taskDao.ts`),**只读** tasks 表(§7.3)。
 * 仿 `category.ts`:注入已初始化库句柄(与 seed / TaskManager / registerCategoryIpc 复用同一 db,不二次打开)。
 *
 * handler 本体依赖 electron `ipcMain`,在 electron-as-node 测试环境下不可直跑(同 `category.ts` / `dialog.ts`):
 * 故 handler 的编排主体抽为可导出函数 `runHistorySearch` / `runHistoryStats`(注入 `now` 便于单测,spec §4.3),
 * handler 仅薄包装调用它们并传 `Date.now()`;集成测试直测这两个编排函数(真 sqlite 往返 + 只读零变化,§8.2)。
 */

import { ipcMain } from 'electron'
import { IpcChannel, type HistoryQuery, type HistoryStats, type Task } from '../../shared/ipc'
import { historyStats, searchHistory, type TaskDaoDatabase } from '../db/taskDao'
import { clampHistoryLimit, resolveTimeRange, statWindowStarts } from '../history/historyTime'

export interface HistoryIpcDeps {
  /** 已初始化的库句柄(index.ts 注入,与 seed / TaskManager / registerCategoryIpc 复用同一句柄,不二次打开) */
  db: TaskDaoDatabase
}

/**
 * `history:search` 编排主体(handler 调用,注入 `now` 便于单测;spec §7.2 / §4.3)。
 * 纯转发,零业务:时间预设 → 具体 createdAt 区间调 `resolveTimeRange`;text `trim`(空串归 undefined 不搜)、
 * limit `clampHistoryLimit`(兜底 500)均调 Phase 1 纯函数,不在此重写;检索调 `searchHistory`(纯 SELECT 只读)。
 */
export function runHistorySearch(db: TaskDaoDatabase, query: HistoryQuery, now: number): Task[] {
  const { from, to } = resolveTimeRange(query.timePreset, query.from, query.to, now)
  return searchHistory(db, {
    text: query.text?.trim() || undefined,
    status: query.status,
    category: query.category,
    from,
    to,
    limit: clampHistoryLimit(query.limit)
  })
}

/**
 * `history:stats` 编排主体(handler 调用,注入 `now` 便于单测;spec §7.2 / §4.3)。
 * 时间窗口边界调 `statWindowStarts`(与 search 同口径,避免漂移),聚合调 `historyStats`(纯 SELECT/GROUP BY 只读)。
 */
export function runHistoryStats(db: TaskDaoDatabase, now: number): HistoryStats {
  return historyStats(db, statWindowStarts(now))
}

/**
 * 注册历史 IPC handler。
 *
 * @param deps - 已初始化库句柄注入(handler 只读 tasks 表:检索 / 统计,ARCHITECTURE §7.3)
 */
export function registerHistoryIpc(deps: HistoryIpcDeps): void {
  // history:search — 历史检索(纯转发:编排调 runHistorySearch,时间 / clamp / trim 全在 Phase 1 纯函数;§7.2)。
  ipcMain.handle(IpcChannel.HistorySearch, async (_event, query: HistoryQuery): Promise<Task[]> => {
    return runHistorySearch(deps.db, query, Date.now())
  })

  // history:stats — 历史统计聚合(纯转发:编排调 runHistoryStats;仅 completed 计入,口径 spec §4)。
  ipcMain.handle(IpcChannel.HistoryStats, async (): Promise<HistoryStats> => {
    return runHistoryStats(deps.db, Date.now())
  })
}
