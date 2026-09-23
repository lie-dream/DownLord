/**
 * BT 落点与托管副本路径纯函数(v0.3 Task 1 · spec §6.1 / §7)。
 *
 * 仿 `binaries/locator.ts` 范式:只做路径拼接,不碰 fs。BT 整包落**兜底子目录**
 * `<defaultDir>/Torrents`(不按扩展名分类,§7);`.torrent` 托管副本存 `<userData>/torrents/<id>.torrent`
 * ——路径由 task id 派生,免额外持久化(§2.2 / §6.1),用户移动 / 删原文件后仍可重加。
 */
import { join } from 'node:path'

/** BT 整包落点兜底子目录(aria2 `--dir`;种子按 info.name 在其下自建文件夹,§7) */
export function torrentSaveDir(defaultDir: string): string {
  return join(defaultDir, 'Torrents')
}

/** `.torrent` 托管副本目录(`<userData>/torrents`,§6.1) */
export function managedTorrentDir(userDataDir: string): string {
  return join(userDataDir, 'torrents')
}

/** 单任务 `.torrent` 托管副本路径(`<userData>/torrents/<taskId>.torrent`;路径由 id 派生,§6.1) */
export function managedTorrentPath(userDataDir: string, taskId: string): string {
  return join(managedTorrentDir(userDataDir), `${taskId}.torrent`)
}
