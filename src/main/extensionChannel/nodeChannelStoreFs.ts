/**
 * 通道配置落盘 fs 的真实 node 实现(v0.4 Task 3 · plan 1.3;仿 `../proxy/proxyStoreFs.ts`)。
 *
 * `channelConfig.ts` 纯逻辑不碰真实 FS;主进程装配(`index.ts`)注入此薄封装。
 * `mkdir` 用 `recursive: true`(`config/` 首次运行可能不存在,原子写前确保父目录)。
 *
 * ⚠️ 类型直接用通用的 `JsonConfigStoreFs`,**不再新造一个 `*StoreFs` 接口** ——
 * 那正是 spec §1.4.1 抽象要终结的重复。
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'

export const nodeChannelStoreFs: JsonConfigStoreFs = {
  readFile: (path) => readFile(path, 'utf-8'),
  writeFile: (path, data) => writeFile(path, data, 'utf-8'),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  }
}
