/**
 * 类别 IPC handler — 接线 categoryDao 与渲染进程通信(spec §6.3)。
 *
 * - `category:list`:invoke/handle 模式,列类别配置供顶部类型筛选 chips 渲染(落实「一处定义」)。
 * - `category:update`:invoke/handle 模式,改单类配置 → 写库 + 刷新 TaskManager 缓存(完整链路供 Task 8
 *   设置面板直接接 UI;本 Task 不渲染设置面板调用它,spec §6.3 / §6.4)。
 *
 * 职责:纯转发 IPC ↔ categoryDao,不含业务逻辑(`category:list` 把 DAO 行投影为跨进程 `CategoryConfig`,
 * 下发完整字段:chips 用 key+displayName,设置页 / 链接识别加固用 extensions+savePath;`category:update`
 * 写后经注入回调刷新缓存,ARCHITECTURE §7.2)。
 */

import { ipcMain } from 'electron'
import { IpcChannel, type CategoryConfig, type CategoryPatch } from '../../shared/ipc'
import { listCategories, updateCategory, type CategoryDaoDatabase } from '../db/categoryDao'
import { resolveCategoryDir } from '../category/categorize'
import type { CategoryDef } from '../category/categoryModel'

export interface CategoryIpcDeps {
  /** 已初始化的库句柄(index.ts 注入,与 seed / TaskManager 复用同一句柄,不二次打开) */
  db: CategoryDaoDatabase
  /**
   * 刷新主进程类别缓存(= `TaskManager.refreshCategories`):`category:update` 写库后调用,
   * 使后续新任务用新配置(已存任务不回迁,spec §6.2)。注入式以解耦 IPC 与 TaskManager 全表面。
   */
  refreshCategories: () => void
  /**
   * 取当前默认目录(= `settingsService.get().defaultDir || systemDownloads`,index.ts 注入)。
   * `category:list` 投影跟随类真实目录时按需实时读:改默认目录后,下次列举即按新目录解析(spec §1.7)。
   */
  getDefaultDir: () => string
}

/**
 * `category:list` 投影:DAO 行(`CategoryDef`)→ 跨进程 `CategoryConfig`(纯函数,无 I/O,可单测;spec §1.7)。
 * - `key` / `displayName` 供 chips;`extensions` 供链接识别加固;
 * - `savePath` 投影为「解析后真实目录」——**复用 Step 2 的 `resolveCategoryDir`**,与路由 `routeForFilename`
 *   落盘同源同值,杜绝「显示 ≠ 实存」;目录算法全在 `resolveCategoryDir`,本处只调用、不自拼 `join`;
 * - `isCustom` = 原始 DB `savePath` 是否非空(`true`=自定义 / `false`=跟随默认目录)供设置页高亮 / 重置。
 */
export function projectCategoryList(all: CategoryDef[], defaultDir: string): CategoryConfig[] {
  return all.map((c) => ({
    key: c.key,
    displayName: c.displayName,
    extensions: c.extensions,
    savePath: resolveCategoryDir(c.key, all, defaultDir),
    isCustom: !!c.savePath
  }))
}

/**
 * 注册类别 IPC handler。
 *
 * @param deps - 库句柄 + 缓存刷新回调注入(`category:list` 读 categories 表;`category:update` 写后刷新缓存)
 */
export function registerCategoryIpc(deps: CategoryIpcDeps): void {
  // category:list — 列类别配置,投影为跨进程 CategoryConfig(纯转发 IPC ↔ DAO,投影逻辑全在
  // projectCategoryList 纯函数,handler 仅取数 + 注入 defaultDir;ARCHITECTURE §7.2)。
  ipcMain.handle(IpcChannel.CategoryList, async (): Promise<CategoryConfig[]> => {
    return projectCategoryList(listCategories(deps.db), deps.getDefaultDir())
  })

  // category:update — 改单类可配置字段 → 写库(DAO 幂等、不存在 key no-op)后刷新 TaskManager 缓存。
  // 本 Task 无 UI 调用方(设置面板留 Task 8);链路就位 + 集成测试覆盖「配置改动生效 + 不回迁」(spec §6.3)。
  ipcMain.handle(
    IpcChannel.CategoryUpdate,
    async (_event, key: string, patch: CategoryPatch): Promise<void> => {
      updateCategory(deps.db, key, patch)
      deps.refreshCategories()
    }
  )
}
