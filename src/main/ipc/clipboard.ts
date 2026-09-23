/**
 * 剪贴板 IPC — M→R 广播 helper(v0.2 Task 4 · spec §7.3)。
 *
 * - `clipboard:linkDetected`:main→renderer 主动推,`ClipboardWatcher` 检测到可下载新链接时经此向所有
 *   窗口广播 `ClipboardLink`,渲染层弹不夺焦的克制提示(用户一键添加)。
 *
 * 本 Task 无 R→M invoke handler(点「添加」只在渲染层打开既有 AddTaskDialog、走既有 addTask / addVideo),
 * 故**无 `registerClipboardIpc`**,此文件仅导出广播 helper。职责:纯转发主进程检测结果 → 窗口;
 * 识别 / 去重 / 隐私逻辑全在 `ClipboardWatcher` 服务与纯函数(ARCHITECTURE §7.2)。
 */

import { BrowserWindow } from 'electron'
import { IpcChannel, type ClipboardLink } from '../../shared/ipc'

/**
 * 向所有窗口推送剪贴板检测到的可下载链接(spec §7.3 `clipboard:linkDetected`)。
 *
 * 供 `ClipboardWatcher` 构造期 `onDetected` 注入:检测到新链接经此把最新 `ClipboardLink` 广播到所有窗口。
 * 仿 `proxy.ts` 的 `broadcastProxyStatusChanged`,遍历未销毁窗口 `webContents.send`。
 */
export function broadcastClipboardLink(link: ClipboardLink): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ClipboardLinkDetected, link)
    }
  }
}
