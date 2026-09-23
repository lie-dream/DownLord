/**
 * BT 文件清单展示纯函数(渲染层,v0.3 Task 2 · spec §3.1 / §6.2)。
 *
 * `BtFileDialog` 直取 `task.torrentMeta.files`(引擎按 aria2 `files` 自然顺序构建),经本函数整理为
 * 展示行:**保留 1-based aria2 索引不变**(§3.2 不变式 `files[i] ↔ --select-file 索引 i+1`),仅对显示顺序
 * 按路径自然排序、格式化大小。**无业务**(不算落点 / 不组装 `--select-file` / 不写库,§7.2)——那些全在主进程。
 */

import type { TorrentFile } from '../../../shared/ipc'
import { formatBytes } from './format'

/** 展示行:`index` 为 1-based aria2 索引(原 `files[]` 位 + 1),显示顺序可排序但 index 恒定 */
export interface TorrentFileRow {
  /** 1-based aria2 `--select-file` 索引(= 原数组位 + 1);勾选回传即此值(§3.2 不变式) */
  index: number
  /** 种子内相对路径(如 "Movie/CD1/movie.mkv") */
  path: string
  /** 文件字节数 */
  length: number
  /** 友好大小串(formatBytes) */
  sizeLabel: string
}

/**
 * `files[]` → 展示行:先按原数组位固定 1-based `index`,再按 `path` 自然排序显示。
 * 排序只影响**显示顺序**,`index` 始终锚定原 aria2 顺序 —— 勾选回传的 index 与 `--select-file` 对齐(§3.2)。
 */
export function buildTorrentFileRows(files: readonly TorrentFile[]): TorrentFileRow[] {
  return files
    .map((f, i) => ({
      index: i + 1,
      path: f.path,
      length: f.length,
      sizeLabel: formatBytes(f.length)
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** 全部文件总字节(头部信息条「共 X」;渲染层纯汇总,与 task.totalBytes 无关,始终反映全清单) */
export function totalTorrentBytes(files: readonly TorrentFile[]): number {
  return files.reduce((sum, f) => sum + f.length, 0)
}
