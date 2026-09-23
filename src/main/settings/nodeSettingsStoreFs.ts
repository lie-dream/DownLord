/**
 * `SettingsStoreFs` 的真实 node 实现(Task 8 · spec §3.1 / §3.4)。
 *
 * `settingsStore.ts` 纯函数地基不碰真实 FS;主进程装配(`index.ts`)注入此薄封装。
 * 结构与 `proxyStoreFs.ts` 的 `nodeProxyStoreFs` 同形(read/write/rename/mkdir);仍**单列一份**
 * 并显式标注 `SettingsStoreFs` 类型,使 settings 模块自包含、与 proxy 模块解耦(不跨 import),
 * 这是 plan §3.1「择一」中刻意选「新增专属薄封装」而非复用 proxy 的依据。
 * `mkdir` 用 `recursive: true`(`config/` 首次运行可能不存在,原子写前确保父目录)。
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import type { SettingsStoreFs } from './settingsStore'

export const nodeSettingsStoreFs: SettingsStoreFs = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, data) => writeFile(path, data, 'utf-8'),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  }
}
