/**
 * `ProxyStoreFs` 的真实 node 实现(Task 7 · spec §2.3)。
 *
 * `proxyStore.ts` 纯函数地基不碰真实 FS;主进程装配(`index.ts`)注入此薄封装。
 * `mkdir` 用 `recursive: true`(`config/` 首次运行可能不存在,原子写前确保父目录)。
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import type { ProxyStoreFs } from './proxyStore'

export const nodeProxyStoreFs: ProxyStoreFs = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, data) => writeFile(path, data, 'utf-8'),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  }
}
