/**
 * 剪贴板薄封装（v0.2 Task 5 · spec §6.2）—— 任务行「复制下载链接」纯渲染层零后端。
 *
 * - Web API `navigator.clipboard.writeText`（渲染进程原生可用，`contextIsolation` 下无碍）：
 *   **不经 IPC、不引 Electron `clipboard` 模块、不新增 `DownLordApi` 方法**（TODO #19 / spec §6.2）。
 * - try/catch 吞异常（无剪贴板权限 / 环境缺失等罕见情形）返回成功 / 失败布尔，
 *   便于调用方（`TaskRowMoreMenu`）据此 Toast 反馈，且便于单测 mock。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
