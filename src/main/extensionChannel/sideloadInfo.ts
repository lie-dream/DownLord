/**
 * 扩展目录定位(纯函数;v0.4 Task 3 · spec §4.5 · TODO #42)。
 *
 * 与 `../binaries/locator.ts` 的 `resolveBinDir` **同形**:运行态判定(`app.isPackaged`)、
 * Electron 路径(`process.resourcesPath` / `app.getAppPath()`)与存在性探针(`fs.existsSync`)
 * 一律由调用方注入,本模块不碰 `app` / 文件系统。
 */
import { join } from 'path'
import type { ExtensionSideloadInfo } from '../../shared/ipc'

export interface ResolveExtensionDirInput {
  /** 是否打包态(`app.isPackaged`) */
  isPackaged: boolean
  /** 打包态资源根(`process.resourcesPath`) */
  resourcesPath: string
  /** 应用根目录(`app.getAppPath()`);electron-vite dev 态下即项目根 */
  appPath: string
}

/**
 * 解析扩展解包目录,覆盖 dev 与打包两态:
 * - **打包态**:`<resources>/extension` —— electron-builder `extraResources` 落点。
 * - **dev 态**:`<项目根>/extension/dist` —— 构建产物目录(`scripts/build-extension.mjs` 的出口)。
 */
export function resolveExtensionDir({
  isPackaged,
  resourcesPath,
  appPath
}: ResolveExtensionDirInput): string {
  return isPackaged ? join(resourcesPath, 'extension') : join(appPath, 'extension', 'dist')
}

export interface SideloadDeps extends ResolveExtensionDirInput {
  /** 存在性探针(注入 `fs.existsSync`,单测可 mock) */
  existsSync: (path: string) => boolean
}

/**
 * 取扩展目录事实。**每次实探、不缓存** —— 未构建扩展 / 目录被删时如实回 `exists:false`,
 * 由 UI 显示「未找到扩展目录」而非空白(诚实,spec §4.5)。
 */
export function getSideloadInfo(deps: SideloadDeps): ExtensionSideloadInfo {
  const dir = resolveExtensionDir(deps)
  return { dir, exists: deps.existsSync(dir) }
}
