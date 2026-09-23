import log from 'electron-log/main'
import { app } from 'electron'
import { join } from 'path'

/**
 * 主进程日志(Task 9 §2.1 日志落盘)。
 *
 * - **落点**:`%APPDATA%/DownLord/logs/`(经 `app.getPath('userData')/logs`,对齐 ARCHITECTURE §2.1)。
 *   文件按 electron-log 默认滚动(`main.log` + 归档),单文件上限 ~1MB。
 * - **接管 console**:把 `console.log/info/warn/error/debug` 重定向到 electron-log,
 *   使既有 ~110 处 `console.*`(`[binaries]`/`[engine]`/`[TaskManager]` 等)**零改动**全部落盘
 *   (符合「最小改动」,不逐处改写)。
 * - **诚实(§6.3)**:原始 stderr / 异常栈只进日志,不糊用户脸;UI 仍只显 §3 可读文案。
 *
 * 必须在 `app.whenReady` **最早**调用(在 `setupBinaries` 之前),确保后续启动期日志均落盘。
 */

let initialized = false

export function initLogger(): void {
  if (initialized) return
  initialized = true

  // file transport 落点:%APPDATA%/DownLord/logs/<fileName>(默认 main.log)
  log.transports.file.resolvePathFn = (variables) =>
    join(app.getPath('userData'), 'logs', variables.fileName ?? 'main.log')

  // 接管 console:既有 console.* 经 electron-log 同时输出控制台 + 落盘,零改动
  Object.assign(console, log.functions)

  log.info(`[logger] 日志已初始化,落点: ${join(app.getPath('userData'), 'logs')}`)
}

/** 暴露 electron-log 实例,供全局崩溃兜底处理器记录(含栈)。 */
export { log }
