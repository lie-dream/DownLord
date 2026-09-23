import { join } from 'path'

/**
 * 三引擎二进制定位 —— 注入式纯函数,覆盖 dev 与打包两态。
 *
 * 落地 ARCHITECTURE §7.5 / spec §3.2 §3.3:三引擎随包内置;yt-dlp 另放用户可写区
 * 并在解析时优先,为后续「脱离应用整体升级的独立热更新」留架构地基。
 *
 * 设计纪律(ARCHITECTURE §6.2 可测性):路径推导全部为纯函数,运行态判定
 * (`app.isPackaged`)、Electron 路径(`process.resourcesPath` / `app.getAppPath()` /
 * `app.getPath('userData')`)与存在性探针(`fs.existsSync`)一律由调用方注入,本模块
 * 不直接接触 `app` / 文件系统,便于单测两态(测试用例由后续 Step 落地)。
 */

/** 三引擎二进制文件名(Windows;DownLord 仅 Windows 分发,见 ARCHITECTURE §1) */
export const BinaryName = {
  Aria2c: 'aria2c.exe',
  YtDlp: 'yt-dlp.exe',
  Ffmpeg: 'ffmpeg.exe'
} as const

/** 用户可写区内的引擎子目录名(对齐 ARCHITECTURE §2.1 `%APPDATA%/DownLord/bin/`) */
export const WRITABLE_BIN_SUBDIR = 'bin'

/** `resolveBinDir` 入参:注入运行态与 Electron 路径,避免在纯逻辑里碰 `app` */
export interface ResolveBinDirInput {
  /** 是否打包态(`app.isPackaged`) */
  isPackaged: boolean
  /** 打包态资源根(`process.resourcesPath`) */
  resourcesPath: string
  /** 应用根目录(`app.getAppPath()`);electron-vite dev 态下即项目根 */
  appPath: string
}

/**
 * 解析内置二进制根目录,覆盖 dev 与打包两态(spec §3.2)。
 *
 * - **打包态**:`process.resourcesPath/bin` —— electron-builder `extraResources` 落点。
 * - **dev 态**:`<项目根>/resources/bin` —— dev 下 `process.resourcesPath` 指向 Electron
 *   自带目录、不含我方二进制,故改以 `app.getAppPath()`(项目根)定位到项目内的资源目录。
 */
export function resolveBinDir({ isPackaged, resourcesPath, appPath }: ResolveBinDirInput): string {
  return isPackaged ? join(resourcesPath, 'bin') : join(appPath, 'resources', 'bin')
}

/** 解析某个内置二进制的绝对路径 */
export function resolveBundledPath(binDir: string, name: string): string {
  return join(binDir, name)
}

/** 用户可写区内 yt-dlp 副本的绝对路径(独立热更新的落点 / 解析优先项) */
export function userWritableYtDlpPath(userDataDir: string): string {
  return join(userDataDir, WRITABLE_BIN_SUBDIR, BinaryName.YtDlp)
}

/** `resolveYtDlpPath` 入参 */
export interface ResolveYtDlpPathInput {
  /** 内置二进制根目录(`resolveBinDir` 结果) */
  binDir: string
  /** 用户可写数据目录(`app.getPath('userData')`) */
  userDataDir: string
  /** 存在性探针(注入 `fs.existsSync`,单测可 mock,不碰真实 FS) */
  existsSync: (path: string) => boolean
}

/**
 * 解析 yt-dlp 实际可执行路径,**优先用户可写副本**(spec §3.3 / ARCHITECTURE §7.5)。
 *
 * 优先级:`userData/bin/yt-dlp.exe` 存在 → 用它(独立热更新落点);否则回退内置副本。
 * aria2c / ffmpeg 不走可写区,始终用 `resolveBundledPath` 取内置(它们无需独立热更新)。
 */
export function resolveYtDlpPath({
  binDir,
  userDataDir,
  existsSync
}: ResolveYtDlpPathInput): string {
  const writableCopy = userWritableYtDlpPath(userDataDir)
  if (existsSync(writableCopy)) return writableCopy
  return resolveBundledPath(binDir, BinaryName.YtDlp)
}
