/**
 * 应用本体自更新封装(v0.2 Task 6 · spec §3;electron-updater + GitHub Releases 公开仓库)。
 *
 * 依赖**全注入**(autoUpdater / getProxy / configureProxy / onStatus / getCurrentVersion),
 * 单测注入 fake autoUpdater(EventEmitter)+ fake configureProxy,不碰真实网络 / Electron 运行时;
 * 真实走代理下载需发布 GitHub Release 方能验证 → 归手测(spec §7.3)。
 *
 * 诚实(逐条守住,§3.2 / §4.4):
 * - **不静默**:构造即设 `autoDownload=false` / `autoInstallOnAppQuit=false`——检查不自动下载、
 *   下载不自动装;下载 / 重启安装全由用户点击(UI 在 Phase 4)。启动只自动「检查」。
 * - **走代理**:`check()` / `download()` 前经注入 `configureProxy(getProxy().effectiveUrl)` 设
 *   electron-updater 自有 netSession 代理(非空 → 该地址;null → 显式直连);更新用 electron-updater
 *   自有 net,不污染 aria2 / yt-dlp(它们经命令行参数拿代理,Task 7)。
 * - **未签名**:不接 CSC / 证书(留 v0.3 #17);未签名 NSIS + latest.yml 可更新,SmartScreen 提示
 *   由 UI 如实说明。
 */
import type { ProxyResolved, UpdateCheckResult, UpdateStatus } from '../../shared/ipc'
import { mapUpdateError } from '../errors/mapError'
import { toReadable } from '../errors/errorCatalog'

/** electron-updater `checkForUpdates` 解析结果最小面(仅取版本 / 是否有更新) */
export interface AppUpdateCheckResultLike {
  updateInfo?: { version?: string }
  isUpdateAvailable?: boolean
}

/** `download-progress` 事件载荷最小面 */
export interface AppDownloadProgressLike {
  percent?: number
}

/** `update-available` / `-not-available` / `update-downloaded` 事件载荷最小面 */
export interface AppUpdateInfoLike {
  version?: string
}

/**
 * electron-updater `autoUpdater` 最小注入面(EventEmitter + 检查 / 下载 / 安装)。
 * 真实实现由 `electron-updater` 的 `autoUpdater` 满足(构造侧强制转型);单测注入 fake(EventEmitter)。
 */
export interface AppAutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (arg?: unknown) => void): unknown
  checkForUpdates(): Promise<AppUpdateCheckResultLike | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface AppUpdaterDeps {
  /** electron-updater 的 autoUpdater 实例(构造侧 `as unknown as AppAutoUpdaterLike` 注入) */
  autoUpdater: AppAutoUpdaterLike
  /** 当前代理解析态(实时读,切档即时生效;经 effectiveUrl 注入 configureProxy) */
  getProxy: () => ProxyResolved
  /**
   * 代理配置(注入式):真实实现设 electron-updater `netSession` 代理(effectiveUrl 非空 → 该地址;
   * null → 显式 `direct://`);单测注入 fake 断言 check / download 前按 getResolved 映射调用。
   */
  configureProxy: (effectiveUrl: string | null) => Promise<void>
  /** 状态 / 进度回调(Phase 2 占位空实现,Phase 3 接 broadcastUpdateStatus) */
  onStatus: (status: UpdateStatus) => void
  /** 当前应用版本(app.getVersion()) */
  getCurrentVersion: () => string
  /**
   * 是否支持检查(注入 `app.isPackaged`)。**dev 未打包态** electron-updater 从 `dev-app-update.yml`
   * 读 provider,若 owner/repo 为占位则 `checkForUpdates()` 会挂起 / 慢失败 → UI 卡「检查中…」(U5 修复)。
   * 未提供则默认支持(向后兼容单测);提供且返回 false → `check()` 诚实快速返回错误,不发网络请求、不 hang。
   */
  checkSupported?: () => boolean
}

export class AppUpdater {
  constructor(private readonly deps: AppUpdaterDeps) {
    // 诚实:检查不自动下载、下载不自动安装(全由用户点击,§3.2)
    deps.autoUpdater.autoDownload = false
    deps.autoUpdater.autoInstallOnAppQuit = false
    this.wireEvents()
  }

  /** electron-updater 事件 → `UpdateStatus{target:'app'}` 广播(spec §3.2 / §4.2)。 */
  private wireEvents(): void {
    const { autoUpdater } = this.deps

    autoUpdater.on('update-available', (info) => {
      this.deps.onStatus({
        target: 'app',
        phase: 'available',
        currentVersion: this.deps.getCurrentVersion(),
        latestVersion: (info as AppUpdateInfoLike | undefined)?.version
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.deps.onStatus({
        target: 'app',
        phase: 'up-to-date',
        currentVersion: this.deps.getCurrentVersion(),
        latestVersion: (info as AppUpdateInfoLike | undefined)?.version
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = (progress as AppDownloadProgressLike | undefined)?.percent
      this.deps.onStatus({
        target: 'app',
        phase: 'downloading',
        percent: typeof percent === 'number' ? Math.round(percent) : undefined,
        currentVersion: this.deps.getCurrentVersion()
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.deps.onStatus({
        target: 'app',
        phase: 'ready',
        currentVersion: this.deps.getCurrentVersion(),
        latestVersion: (info as AppUpdateInfoLike | undefined)?.version,
        message: '更新已下载,点击「重启安装」完成更新'
      })
    })

    autoUpdater.on('error', (err) => {
      this.deps.onStatus({
        target: 'app',
        phase: 'error',
        currentVersion: this.deps.getCurrentVersion(),
        error: toReadable(mapUpdateError(err))
      })
    })
  }

  /**
   * 仅检查(走代理 → checkForUpdates;不自动下载,autoDownload=false 已保证)。
   * 失败诚实回退(error + latestVersion=null),不抛。事件另经 wireEvents 广播 available / up-to-date。
   */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = this.deps.getCurrentVersion()
    // dev 未打包 / provider 未配置真实仓库 → 诚实快速返回,不发网络请求 / 不 hang(U5 修复,§4.4 诚实)
    if (this.deps.checkSupported && !this.deps.checkSupported()) {
      const error = '开发模式(未打包)下不检查应用更新,请使用安装版本'
      this.deps.onStatus({ target: 'app', phase: 'error', currentVersion, error })
      return { target: 'app', currentVersion, latestVersion: null, hasUpdate: false, error }
    }
    this.deps.onStatus({ target: 'app', phase: 'checking', currentVersion })
    try {
      await this.deps.configureProxy(this.deps.getProxy().effectiveUrl)
      const result = await this.deps.autoUpdater.checkForUpdates()
      const latestVersion = result?.updateInfo?.version ?? null
      const hasUpdate =
        result?.isUpdateAvailable ?? (latestVersion !== null && latestVersion !== currentVersion)
      return { target: 'app', currentVersion, latestVersion, hasUpdate }
    } catch (err) {
      const readable = toReadable(mapUpdateError(err))
      console.warn('[AppUpdater] 检查应用更新失败(诚实回退,不影响运行):', err)
      this.deps.onStatus({ target: 'app', phase: 'error', currentVersion, error: readable })
      return {
        target: 'app',
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        error: readable
      }
    }
  }

  /**
   * 下载更新(用户点击后;走代理 → downloadUpdate)。进度 / 完成经 download-progress /
   * update-downloaded 事件广播;失败诚实回退经 error 事件 + 本地兜底 onStatus,不抛。
   */
  async download(): Promise<void> {
    const currentVersion = this.deps.getCurrentVersion()
    try {
      await this.deps.configureProxy(this.deps.getProxy().effectiveUrl)
      this.deps.onStatus({ target: 'app', phase: 'downloading', percent: 0, currentVersion })
      await this.deps.autoUpdater.downloadUpdate()
    } catch (err) {
      const readable = toReadable(mapUpdateError(err))
      console.warn('[AppUpdater] 下载应用更新失败(诚实回退,保留当前版本):', err)
      this.deps.onStatus({ target: 'app', phase: 'error', currentVersion, error: readable })
    }
  }

  /** 重启并安装(用户点击「重启安装」触发;退出 → NSIS 升级 → 重启,§3.2)。 */
  quitAndInstall(): void {
    this.deps.autoUpdater.quitAndInstall()
  }
}
