/**
 * `BtTrackerStoreFs` 的真实 node 实现(v0.4 Task 1 · spec §5.1)。
 *
 * `btTrackerStore.ts` 纯逻辑不碰真实 FS;主进程装配(`index.ts`)注入此薄封装。
 * 结构与 `nodeUpdateStateStoreFs` / `nodeSettingsStoreFs` / `nodeProxyStoreFs` 同形
 * (read/write/rename/mkdir);`mkdir` 用 `recursive: true`(`config/` 首次运行可能不存在,原子写前确保父目录)。
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import type { BtTrackerStoreFs } from './btTrackerStore'

export const nodeBtTrackerStoreFs: BtTrackerStoreFs = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, data) => writeFile(path, data, 'utf-8'),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  }
}
