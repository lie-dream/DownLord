import {
  app,
  shell,
  BrowserWindow,
  nativeTheme,
  clipboard,
  session,
  net as electronNet,
  powerMonitor
} from 'electron'
import { join } from 'path'
import { existsSync, statSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { readFile, rename, unlink } from 'fs/promises'
import { networkInterfaces } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initLogger, log } from './logging/logger'
import { registerAppIpc } from './ipc/app'
import { registerDialogIpc } from './ipc/dialog'
import { registerShellIpc } from './ipc/shell'
import { registerWindowIpc } from './ipc/window'
import { registerThemeIpc } from './ipc/theme'
import { registerTaskIpc } from './ipc/task'
import { registerVideoIpc } from './ipc/video'
import { registerTorrentIpc } from './ipc/torrent'
import { registerCategoryIpc } from './ipc/category'
import { registerHistoryIpc } from './ipc/history'
import { registerProxyIpc, broadcastProxyStatusChanged } from './ipc/proxy'
import { broadcastClipboardLink } from './ipc/clipboard'
import { registerUpdateIpc, broadcastUpdateStatus } from './ipc/update'
import { registerBtIpc, broadcastBtTrackerStatus, broadcastInboundChanged } from './ipc/bt'
import { diagnoseInbound, type InboundProbeDeps } from './bt/inboundDiagnosis'
import { ClipboardWatcher } from './clipboard/clipboardWatcher'
import { createTakeoverWindowHandle, isTakeoverWindow } from './takeover/takeoverWindow'
import { TakeoverService } from './takeover/takeoverService'
import { createTakeoverConfigStore } from './takeover/takeoverConfig'
import {
  registerTakeoverIpc,
  broadcastTaskAdded,
  broadcastTakeoverConfig
} from './ipc/takeover'
import { resolveBinDir, resolveYtDlpPath, resolveBundledPath, BinaryName } from './binaries/locator'
import { userWritableYtDlpPath } from './binaries/locator'
import { ensureWritableYtDlp } from './binaries/ensureWritable'
import { applyPendingYtDlp } from './update/applyPendingYtDlp'
import { YtdlpUpdater, type UpdaterFs } from './update/ytdlpUpdater'
import { AppUpdater, type AppAutoUpdaterLike } from './update/appUpdater'
import { autoUpdater } from 'electron-updater'
import { createUpdateHttpClient, type UpdateNetLike } from './update/updateHttp'
import { createUpdateStateStore, shouldCheckNow } from './update/updateStateStore'
import { nodeUpdateStateStoreFs } from './update/nodeUpdateStateStoreFs'
import { createBtTrackerStore } from './bt/btTrackerStore'
import { nodeBtTrackerStoreFs } from './bt/nodeBtTrackerStoreFs'
import { BtTrackerService } from './bt/btTrackerService'
import { buildEngineProbes, checkBinaries } from './binaries/selfCheck'
import { probeEngineVersions } from './binaries/probeVersion'
import { ENGINE_VERSIONS } from './binaries/engineVersions'
import { DEFAULT_COOKIE_CONFIG } from '../shared/ipc'
import type {
  EngineVersions,
  ProxyResolved,
  CookieConfig,
  InboundReachability
} from '../shared/ipc'
import { DownloadEngine } from './engine/downloadEngine'
import type { BtTrackerApplyResult } from './engine/downloadEngine'
import type { SeedConfig } from './engine/btOptions'
import { FakeEngine } from './engine/fakeEngine'
import { CompositeDownloadEngine } from './engine/compositeEngine'
import { VideoEngine } from './video/videoEngine'
import { VideoResolver } from './video/videoResolver'
import { FakeVideoResolver } from './video/fakeVideoResolver'
import { createYtdlpProcess } from './video/ytdlpProcess'
import { createMediaTool } from './media/mediaTool'
import {
  TaskManager,
  filenameFromUrl,
  type TaskEngine,
  type VideoResolverLike
} from './tasks/taskManager'
import { initDatabase } from './db/connection'
import { seedDefaultCategories } from './db/categoryDao'
import { ProxyService } from './proxy/proxyService'
import { createSystemProxyReader } from './proxy/systemProxyReader'
import { nodeProxyStoreFs } from './proxy/proxyStoreFs'
import { probe } from './proxy/proxyProbe'
import { SettingsService } from './settings/settingsService'
import { nodeSettingsStoreFs } from './settings/nodeSettingsStoreFs'
import { registerSettingsIpc } from './ipc/settings'
import { registerExtensionIpc, broadcastExtensionChannelStatus } from './ipc/extension'
import { registerCookieIpc, broadcastBorrowedCookiesChanged } from './ipc/cookie'
import { createBorrowedCookieStore } from './video/borrowedCookieStore'
import { createLeaseCookieFile } from './video/cookieLeaseFactory'
import { sweepCookieTempDir } from './video/cookieTempSweep'
import { ExtensionChannelService } from './extensionChannel/extensionChannelService'
import { nodeChannelStoreFs } from './extensionChannel/nodeChannelStoreFs'
import { nodeHttpFactory } from './extensionChannel/nodeHttpFactory'
import { generateSecret } from './engine/secret'
import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'

// dev 白屏修复(2026-07-25 真机;修订二收窄):Clash 全局 TUN / fake-ip DNS 劫持 `localhost` 域名致
// dev 下连不上 vite dev server 白屏。修复仅靠 electron.vite.config.ts `server.host=127.0.0.1`——
// 回环**字面 IP** 不经 DNS(绕过 fake-ip)、且命中 Chromium 内置 implicit bypass(不走任何代理)。
// ⚠️ 此处**不得**用 `no-proxy-server` 开关:它把整个 Chromium 网络栈的代理禁用,
// `session.resolveProxy` 永远返回 DIRECT → 代理「跟随系统」档在 dev 下彻底失明(2026-07-25 真机回归实证)。

type ManagedEngine = TaskEngine & {
  start(): Promise<void>
  stop(): Promise<void>
  /** 全局限速 push(v0.2 Task 2 · spec §2.2):onChange 直接调 aria2 后端 changeGlobalOption;composite / fake 均实现 */
  setGlobalLimit?(kbps: number): Promise<void>
  setTaskLimit?(id: string, kbps: number | null): Promise<void>
  /** tracker 表热应用 + 追补(v0.4 Task 1 · spec §4.2 push):仅 aria2 侧实现(composite 转发);fake 无 */
  applyBtTrackers?(trackers: readonly string[]): Promise<BtTrackerApplyResult>
}

function createWindow(): void {
  // Create the browser window with custom titlebar (frameless for Phase 4 外壳)
  const mainWindow = new BrowserWindow({
    width: 1040,
    height: 680,
    // #41-b：用户分别实测 624×534，宽高各留余量，避免内容或底部导航不可达。
    minWidth: 640,
    minHeight: 560,
    show: false,
    frame: false, // 无边框,使用自定义标题栏(spec §5.4)
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 只放行 http(s) 到系统浏览器:openExternal 对 file:// / 自定义协议会直接执行本地目标
    if (/^https?:\/\//i.test(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 启动期 pending yt-dlp 更新应用(v0.2 Task 6 · spec §2.4),**必须在 `setupBinaries()` 之前、
 * 任何引擎 spawn 之前**运行——此时无进程占用,校验通过的 `.pending` 可安全 rename 覆盖 yt-dlp.exe。
 * 之后 `ensureWritableYtDlp` 见有效副本自然 skipped(占位检测语义不倒退)。同步、不抛(内部吞异常)。
 */
function applyPendingYtDlpUpdate(): void {
  try {
    const ytdlpPath = userWritableYtDlpPath(app.getPath('userData'))
    const result = applyPendingYtDlp({ ytdlpPath })
    console.log(`[update] pending yt-dlp 应用[${result.action}]: ${result.pendingPath}`)
  } catch (err) {
    // 启动期不得因 pending 应用异常拖垮(spec §2.4):仅记录,继续启动
    console.error('[update] pending yt-dlp 应用异常(已忽略,不影响启动):', err)
  }
}

/**
 * 启动期二进制初始化(spec §3 / ARCHITECTURE §7.5),全程**不调用 / 不集成任何引擎**:
 * 1. 两态定位内置根目录(dev=<项目根>/resources/bin,打包=process.resourcesPath/bin);
 * 2. 首次把内置 yt-dlp 拷入用户可写区(为后续独立热更新留架构);
 * 3. 解析 yt-dlp 实际路径(优先可写副本,回退内置);
 * 4. 三引擎存在性自检,结构化结果写日志。
 *
 * 任何异常 / 缺失只记日志,不崩、不弹业务级错误 UI(spec §3.4)。
 */
function setupBinaries(): void {
  try {
    const binDir = resolveBinDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    const userDataDir = app.getPath('userData')
    console.log(`[binaries] 内置根目录(${app.isPackaged ? 'packaged' : 'dev'}): ${binDir}`)

    const ensured = ensureWritableYtDlp({ binDir, userDataDir })
    console.log(`[binaries] yt-dlp 可写副本[${ensured.action}]: ${ensured.target}`)

    const ytDlpPath = resolveYtDlpPath({ binDir, userDataDir, existsSync })
    console.log(`[binaries] yt-dlp 解析路径: ${ytDlpPath}`)

    const results = checkBinaries(buildEngineProbes({ binDir, ytDlpPath }), existsSync)
    for (const result of results) {
      console.log(`[binaries] 自检 ${result.name}: ${result.ok ? 'OK' : '缺失'} -> ${result.path}`)
    }
    const missing = results.filter((result) => !result.ok).map((result) => result.name)
    if (missing.length > 0) {
      console.warn(
        `[binaries] 缺失 ${missing.length} 个二进制(本 Task 仅占位,真实二进制待后续 Task): ${missing.join(', ')}`
      )
    }
  } catch (err) {
    // 启动自检不得拖垮应用(spec §3.4):异常仅记录,不崩、不弹业务 UI。
    console.error('[binaries] 初始化异常(已忽略,不影响启动):', err)
  }
}

/**
 * 引擎内核版本缓存 + 真实探测(Task 9 §4.4 / TODO #14)。
 *
 * 缓存初值即静态 `ENGINE_VERSIONS`;`probeAndCacheEngineVersions` 启动后台跑 `--version`
 * 探测真实版本就地更新缓存,**fire-and-forget 不阻塞启动**;探测前 / 失败始终回退静态常量
 * (诚实不崩)。`app:getEngineVersions` handler 经注入回调读此缓存(仅换数据源,通道 / 类型 / UI 不变,§4.4)。
 */
let engineVersionsCache: EngineVersions = ENGINE_VERSIONS

async function probeAndCacheEngineVersions(): Promise<void> {
  try {
    const binDir = resolveBinDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    const userDataDir = app.getPath('userData')
    const ytdlpPath = resolveYtDlpPath({ binDir, userDataDir, existsSync }) // 优先可写副本(§7.5)
    engineVersionsCache = await probeEngineVersions(
      { spawn },
      {
        aria2cPath: resolveBundledPath(binDir, BinaryName.Aria2c),
        ytdlpPath,
        ffmpegPath: resolveBundledPath(binDir, BinaryName.Ffmpeg)
      }
    )
    log.info(
      `[binaries] 引擎版本探测: aria2=${engineVersionsCache.aria2} yt-dlp=${engineVersionsCache.ytdlp} ffmpeg=${engineVersionsCache.ffmpeg}`
    )
  } catch (err) {
    // probeEngineVersions 自身不抛(内部吞错回退);此处兜底极端异常,保持静态常量,绝不崩
    log.warn('[binaries] 引擎版本探测异常(已回退静态常量):', err)
  }
}

/**
 * 全局崩溃兜底(Task 9 §2.2 / §2.3),**仅记录 + 尽量保活**,不新增产品功能、不改既有恢复逻辑:
 * - 主进程未捕获异常 / 未处理 Promise 拒绝:经 logger 记录(含栈),**不直接 app.quit()**——
 *   优先保活让用户看到 UI(§7.1 崩溃隔离);沿用既有「启动失败不阻止应用启动」策略。
 * - 渲染进程崩溃(render-process-gone):记录 reason/exitCode;非正常退出时 reload() 重载窗口,
 *   重载后经既有 task:list 从主进程内存 / SQLite 拉回任务列表(已有链路,不丢任务,§2.4)。
 * - GPU 等 child-process-gone 只记录,不强制动作。
 */
function registerCrashHandlers(): void {
  // 渲染崩溃自动重载的时间窗记录(见 render-process-gone 限次逻辑)
  let rendererReloadTimes: number[] = []

  process.on('uncaughtException', (err) => {
    log.error('[crash] 主进程未捕获异常(已记录,尽量保活):', err)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('[crash] 未处理的 Promise 拒绝(已记录,尽量保活):', reason)
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    log.error(`[crash] 渲染进程退出: reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason !== 'clean-exit') {
      // 重载限次(60s 窗口内最多 3 次):确定性启动崩溃(如加载即崩)会「崩溃→重载→崩溃」
      // 死循环空转 CPU / 刷屏日志;超限后停止自动重载,只保留记录供排查
      const now = Date.now()
      rendererReloadTimes = rendererReloadTimes.filter((t) => now - t < 60_000)
      if (rendererReloadTimes.length >= 3) {
        log.error('[crash] 渲染进程 60s 内已重载 3 次仍崩溃,停止自动重载(避免死循环)')
        return
      }
      rendererReloadTimes.push(now)
      // 非正常退出 → 重载窗口恢复 UI(任务列表经 task:list 自动拉回)
      try {
        webContents.reload()
        log.info('[crash] 已重载渲染窗口以恢复 UI')
      } catch (reloadErr) {
        log.error('[crash] 渲染窗口重载失败:', reloadErr)
      }
    }
  })

  app.on('child-process-gone', (_event, details) => {
    log.warn(`[crash] 子进程退出: type=${details.type} reason=${details.reason}`)
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.

// 全局引擎 / 任务管理实例（在 app.whenReady 中初始化）
let downloadEngine: ManagedEngine | null = null
let taskManager: TaskManager | null = null
// 剪贴板监控(v0.2 Task 4):在 taskManager 构造后装配,退出即停;默认关(spec §3.4)
let clipboardWatcher: ClipboardWatcher | null = null
// 代理服务模块级引用(2026-07-25 真机修订二):system 档跟随轮询在退出时 stop(实例仍在 whenReady 内 const 装配)
let proxyServiceRef: ProxyService | null = null
// 本地通道服务模块级引用(v0.4 Task 3):退出时 stop 释放监听端口(实例仍在 whenReady 内 const 装配)
let extensionChannelRef: ExtensionChannelService | null = null
/**
 * 接管编排模块级引用(v0.4 Task 4):退出时 stop(清定时器 + 清缓冲 + 关小窗口)。
 *
 * 通道 handler 经**惰性转发**读它:通道随设置提前起、接管随 TaskManager 后起,
 * 未装配时恒 `{taken:false}` —— 那正是「DownLord 未运行」的同一条诚实降级。
 */
let takeoverServiceRef: TakeoverService | null = null
// yt-dlp 独立热更新编排(v0.2 Task 6):whenReady 装配;后台自动检查 fire-and-forget(默认开,24h 节流)
let ytdlpUpdater: YtdlpUpdater | null = null
// tracker 表热更新编排(v0.4 Task 1):whenReady 装配(须在 updateHttp 之后,复用同一实例);
// 添加 BT 任务时 fire-and-forget 触发(非启动 → 非 BT 用户零外联)
let btTrackerService: BtTrackerService | null = null
/**
 * **生效表**(CONTEXT.md tracker 表三态):缓存表非空取缓存表,空则由 `buildAria2Args` 退内置 47 条。
 * pull 与 push 共享同一份真值 —— 启动早期读盘填入,拉取成功经 `onApplied` 回写;
 * `getBtTrackers` 每次 aria2 启动 / 崩溃重启实时读它。
 */
let effectiveBtTrackers: readonly string[] = []
/**
 * 入站自检的注入依赖(v0.4 Task 1 · spec §3.1 / §3.2):生产侧接真实网卡与时钟。
 * 判定全在 `inboundDiagnosis.ts` 纯函数里(本文件零业务逻辑,§7.2);**纯本地读网卡,零外联**,
 * 不查也不改防火墙、不做任何端口映射(D1 / D4)。
 */
const inboundProbeDeps: InboundProbeDeps = {
  readInterfaces: () => networkInterfaces(),
  now: () => Date.now()
}
/**
 * 上次**广播过**的入站态,仅作「变了才广播」的比较基准(spec §3.4 ② / ③)。
 *
 * ⚠️ **不是缓存** —— `bt:getInboundDiagnosis` 每次被问都实算(不读它、也不写它),
 * 这是「换网自动重算」的地基;此处只为避免 state 没变时反复推同一条广播刷屏。
 */
let lastBroadcastInboundState: InboundReachability | null = null

/**
 * 重算入站诊断,**`state` 与上次广播的不同才广播**(spec §3.4 ② `powerMonitor` resume / ③ 添加 BT 任务)。
 *
 * **不做常驻定时器轮询网卡**:主进程不知 UI 态,不为一个只在设置页可见的诊断行付出全程轮询成本;
 * 设置页可见期间的 60s 轮询由渲染层经 invoke 驱动(拉取节奏不是判定,§7.2)。
 */
function recomputeInboundAndBroadcast(reason: string): void {
  try {
    const diagnosis = diagnoseInbound(inboundProbeDeps)
    if (diagnosis.state === lastBroadcastInboundState) return
    lastBroadcastInboundState = diagnosis.state
    broadcastInboundChanged(diagnosis)
    console.log(`[bt-inbound] ${reason} → 入站可达 state=${diagnosis.state}(已广播)`)
  } catch (err) {
    // 自检失败绝不影响主流程(诊断只是如实呈现的一行字);纯函数内部已把读不到网卡兜成 unknown 因子
    console.warn('[bt-inbound] 重算异常(已忽略):', err)
  }
}
// 应用本体自更新(v0.2 Task 6 · electron-updater):whenReady 装配;后台仅自动「检查」(默认开,24h 节流),
// 下载 / 重启安装全由用户点击(autoDownload=false / autoInstallOnAppQuit=false,不静默,§3.2)
let appUpdater: AppUpdater | null = null

// 单实例锁:两个实例会打开同一 SQLite 库并把同一批未完成任务重提给各自的 aria2,
// 对同一 savePath / `.aria2` 控制文件并发写互踩(§7.3 / §7.4);config/*.json 的 `.tmp`
// 原子写也会跨进程互撞。抢锁失败(已有实例)→ 退出,由既有实例接管聚焦。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  // 用户二次启动(慢启动窗口期误双击等)→ 聚焦已有主窗口
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  // 抢锁失败时已在退出流程:不再装配(quit 异步,ready 可能先于退出触发)
  if (!gotSingleInstanceLock) {
    return
  }

  // Task 9 §2.1:**最早**初始化日志(在 setupBinaries 之前),使后续启动期 console.* 全部落盘。
  initLogger()
  // Task 9 §2.2/§2.3:注册全局崩溃兜底(主进程未捕获异常 / 渲染崩溃重载),仅记录 + 保活。
  registerCrashHandlers()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // v0.2 Task 6 §2.4:先应用上次「占用降级」暂存的 pending yt-dlp 更新(在任何引擎 spawn 前)
  applyPendingYtDlpUpdate()
  // 启动期二进制初始化:两态定位 + yt-dlp 可写副本 + 存在性自检(spec §3,不调用任何引擎)
  setupBinaries()
  // Task 9 §4.4:后台探测三引擎真实 --version 缓存(fire-and-forget,不阻塞启动;失败回退静态常量)
  void probeAndCacheEngineVersions()

  // 注册强类型 IPC handler(Phase 4:app + window + theme 全部就位)
  registerAppIpc({
    getEngineVersions: () => engineVersionsCache,
    thirdPartyNotices: {
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      existsSync,
      openPath: (path) => shell.openPath(path)
    }
  })
  registerDialogIpc()
  registerShellIpc()
  registerWindowIpc()
  registerThemeIpc()

  // Task 5 Phase 2: 装配双执行器(aria2 直链 + yt-dlp 视频)+ VideoResolver + TaskManager
  try {
    const binDir = resolveBinDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    const userDataDir = app.getPath('userData')
    const aria2cPath = resolveBundledPath(binDir, BinaryName.Aria2c)
    const ytdlpPath = resolveYtDlpPath({ binDir, userDataDir, existsSync }) // 优先可写副本(§7.5)
    const ffmpegPath = createMediaTool({ binDir }).resolveFfmpegLocation() // MediaTool 退化:仅定位
    const systemDownloads = app.getPath('downloads') // 系统下载目录(空 defaultDir 回落于此)
    const useFake = process.env.DOWNLORD_FAKE_ENGINE === '1'

    // Task 8 设置服务装配(在 TaskManager 前,spec §3.4):startup 读 settings.json(缺失 / 损坏回退默认并修复)
    // + 空 defaultDir 解析为系统下载目录;get() 供 getVideoPrefs 注入回调即时读视频偏好;
    // onChange 闭包延迟读 taskManager(构造在其后,仿现有 refreshCategories 注入缝)联动三项即时生效:
    // 并发出队补足 / 默认目录兜底(后续新任务)/ 主题(nativeTheme 驱动,触发 theme:changed 回流)。
    const settingsService = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath: join(userDataDir, 'config', 'settings.json'),
      systemDownloadsDir: systemDownloads,
      onChange: (s) => {
        taskManager?.setMaxConcurrent(s.maxConcurrent)
        taskManager?.setDefaultDir(s.defaultDir || systemDownloads)
        nativeTheme.themeSource = s.themeMode
        // 全局限速 push(v0.2 Task 2 · spec §2.2):即时改运行中 aria2(changeGlobalOption);
        // 视频后端靠 getSpeedLimit pull(下次 spawnFor)无需 push。fire-and-forget:失败内部记日志不崩。
        void downloadEngine?.setGlobalLimit?.(s.maxOverallLimitKBps)
        // 剪贴板监控开关即时启停(v0.2 Task 4 · spec §7.4):clipboardWatcher 延迟读(构造在其后,
        // 仿 taskManager?.);关→停轮询清会话态,开→seed lastText 启轮询;默认 false 时 no-op(零回归)。
        clipboardWatcher?.setEnabled(s.clipboardWatch)
      }
    })
    await settingsService.init()
    const settings = settingsService.get()
    const defaultDir = settings.defaultDir || systemDownloads // 解析后的默认目录(路由 / 引擎构造期兜底)
    const maxConcurrent = settings.maxConcurrent
    // 启动按持久化主题档应用(nativeTheme 驱动;system 跟随系统,触发 theme:changed 回流,spec §3.4)
    nativeTheme.themeSource = settings.themeMode

    // Task 7 代理服务装配:startup 读 proxy.json + system 档**主动**读系统代理缓存(Phase 2);
    // () => proxyService.getResolved() 注入两引擎 + resolver,切档对后续新任务即时生效(spec §4 / §6);
    // probe 注入真实代理端口 TCP 探测供 getStatus / setConfig(Phase 3);
    // onStatusChanged 接 broadcastProxyStatusChanged → webContents.send('proxy:statusChanged') 推所有窗口(Step 5)。
    const proxyService = new ProxyService({
      systemProxyReader: createSystemProxyReader(),
      store: nodeProxyStoreFs,
      configPath: join(userDataDir, 'config', 'proxy.json'),
      probe,
      onStatusChanged: broadcastProxyStatusChanged
    })
    await proxyService.init()
    // system 档跟随轮询(2026-07-25 真机修订二):系统代理变化(如 Clash 开关 / 换端口)30s 内自动
    // 跟上并广播状态栏;非 system 档轮询空转。真机问题:跟随系统档在系统代理变化后不更新。
    proxyService.startSystemWatch()
    proxyServiceRef = proxyService
    const getProxy = (): ProxyResolved => proxyService.getResolved()

    // 设置 / 代理 IPC 提前注册(两服务已就绪,handler 与引擎 / DB 无依赖):否则引擎或 DB 启动
    // 失败走 catch 后这两组 handler 永不注册,设置页 / 代理状态栏等无关功能陪葬(invoke 全部
    // reject "No handler registered")。成功路径行为不变(handler 注册先后互不影响)。
    registerSettingsIpc({ settingsService })
    registerProxyIpc({ proxyService })

    // v0.4 Task 6 暂借登录态持有层:**纯内存、会话级**,一个进程一个实例。
    // 关掉 DownLord 即消失 —— 不落盘、不落库、不写 settings、不写日志(连域名都不写),
    // 这不只是取舍,是 CONTEXT.md「暂借登录态」写明的安全承诺。
    // 三个消费者共用这一份:通道(写)/ 设置页 IPC(读 host + 清)/ 确认框那一行(读 host);
    // yt-dlp 侧的物化(`leaseCookieFile`)留 Step 3b。
    const borrowedCookies = createBorrowedCookieStore()

    // v0.4 Task 6 · spec §4.5:启动清扫残留临时 cookies.txt。
    // **在引擎启动之前** —— 那个时刻不可能有活跃租约,清扫不会误删正在用的文件。
    // 正常路径由 `CookieLease.release()` 在 yt-dlp 进程结束时删;**唯一兜不住的是应用崩溃 / 断电**,
    // 故清扫不是可选项,它是红线 R5「用完即删」在异常路径上的那一半。
    // ⚠️ 只删自己命名规则(`ck-<32hex>.txt`)的东西,绝不 `rm -rf` 整个目录;目录不存在则建之。
    // ⚠️ 日志**只记计数** —— 零文件名、零域名(红线 R4:日志会比它记录的东西活得更久)。
    const cookieTmpDir = join(userDataDir, 'cookies-tmp')
    const sweptCookies = sweepCookieTempDir(
      { existsSync, mkdirSync, readdirSync, rmSync },
      cookieTmpDir
    )
    console.log(`[cookie] 已清扫 ${sweptCookies.removed} 个残留临时文件`)

    // 第四档的物化入口(v0.4 Task 6 · spec §4.3):持有层 → 一次性 cookies.txt 租约。
    // 两个引擎注入同一个回调;`null` = 手上没有该任务要的登录态 → 不带 `--cookies` 照常跑。
    const leaseCookieFile = createLeaseCookieFile({
      store: borrowedCookies,
      fileDeps: {
        writeFileSync,
        rmSync,
        randomHex: (bytes) => crypto.randomBytes(bytes).toString('hex')
      },
      dir: cookieTmpDir
    })

    // v0.4 Task 3 浏览器扩展本地通道装配(与上面两组同批,同一理由:与引擎 / DB 零依赖)。
    // init() 读 extensionChannel.json 并保障 token(**不以「已启用」为条件**,否则设置页打开时
    // 配对码是空的);start() 在 `enabled:false` 时是 no-op —— **默认关**:不装扩展的用户
    // 不该白开一个监听端口(spec §5.1)。只绑 127.0.0.1,端口被占**不顺延不扫描**、如实报。
    const extensionChannelService = new ExtensionChannelService({
      httpFactory: nodeHttpFactory,
      store: nodeChannelStoreFs,
      configPath: join(userDataDir, 'config', 'extensionChannel.json'),
      generateToken: () => generateSecret(crypto),
      now: () => Date.now(),
      appVersion: app.getVersion(),
      onStatusChanged: broadcastExtensionChannelStatus,
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m)
      },
      sideload: {
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        existsSync
      },
      // v0.4 Task 4:意图转交接管编排。**惰性转发** —— 通道随设置提前起,接管随 TaskManager 后起;
      // 未装配(引擎 / DB 起不来)时恒 `{taken:false}` + 默认快照,浏览器照常下载,不黑洞。
      // Step 6a 补齐 popup 遥控的两支:读走 `getConfigView()`(三键),写走 `setPause()` ——
      // **暂停真源在 `TakeoverService`**,通道只转发。
      takeover: {
        handleIntent: (intent) => takeoverServiceRef?.handleIntent(intent) ?? { taken: false },
        // v0.4 Task 5:嗅探转交。同一惰性转发范式 —— 未装配时恒 `{taken:false}`,
        // popup 上那条按钮如实回落到「没送出去」,不制造黑洞。
        handleSniffSelected: (payload) =>
          takeoverServiceRef?.handleSniffSelected(payload) ?? { taken: false },
        getConfigView: () =>
          takeoverServiceRef?.getConfigView() ?? { enabled: true, pausedUntil: null, paused: false },
        setPause: (payload) => void takeoverServiceRef?.setPause(payload),
        // v0.4 Task 6:甲路径(popup「用 DownLord 下载此页视频」)。同一惰性转发范式。
        handleVideoIntent: (payload) =>
          takeoverServiceRef?.handleVideoIntent(payload) ?? { taken: false }
      },
      // v0.4 Task 6:`cookie.offer` 的落点与变更广播。载荷只有 host 列表流向渲染层。
      borrowedCookies,
      onBorrowedCookiesChanged: broadcastBorrowedCookiesChanged
    })
    await extensionChannelService.init()
    await extensionChannelService.start()
    extensionChannelRef = extensionChannelService
    registerExtensionIpc({ channelService: extensionChannelService })
    registerCookieIpc({ borrowedCookies })

    // Task 1(v0.2)Cookie 登录回调:与 getProxy 完全对称(全局登录态、实时读、解析 + 下载都注入、不进任务持久化)。
    // 每次 resolve / spawnFor 前实时读 settings.json 的 video.cookie(切档 / resume 即时生效);
    // 缺省(旧文件零迁移未补 / 显式 none)→ DEFAULT_COOKIE_CONFIG(source:'none')→ 纯函数零附加零回归(spec §6.3)。
    const getCookie = (): CookieConfig =>
      settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG

    // v0.4 Task 6:扩展通道**此刻是否连着**(spec §6.2 ①)。判据与设置页第二行同源 ——
    // `enabled` 是用户开关,`lastHandshakeAt` 是**握手**(CONTEXT.md 里「已配对」的唯一判据,
    // 只在内存、重启回落 null)。两者任一不成立 → `unpaired`。
    // ★ 它只用来把「没拿到登录态」分成两半:去配对 vs 回浏览器登录 —— 指错方向比不指更坏。
    const isExtensionLinked = (): boolean => {
      const status = extensionChannelService.getStatus()
      return status.enabled && status.lastHandshakeAt !== null
    }

    // 全局限速 / 加速注入(v0.2 Task 2 · spec §6.5,与 getProxy / getCookie 对称:实时读 settings、切档即时生效):
    //   getSpeedLimit → 两引擎 addUri / spawnFor 读当前全局限速(aria2 另作启动初值 + 崩溃 re-apply,§2.2);
    //   getVideoAccel → VideoEngine spawnFor 读加速态,gate = 开关 && aria2c 二进制存在(existsSync);
    //     不可用 → enabled=false → 纯函数不加 --downloader(自带下载器,零风险,§3.3 预探测)。
    const getSpeedLimit = (): number => settingsService.get().maxOverallLimitKBps
    const getVideoAccel = (): { enabled: boolean; aria2cPath: string } => ({
      enabled: settingsService.get().useAria2cForVideo && existsSync(aria2cPath),
      aria2cPath
    })
    // 做种档注入(v0.3 Task 3 · spec §7,与 getSpeedLimit 对称:实时读 settings、切档对新建 / 重提生效):
    //   getSeedConfig → aria2 http 后端 addUri / 崩溃重提读做种档,经 buildBtOptions 注入 seed-ratio/seed-time;
    //   视频后端无 BT 不注入(video 不做种)。onChange 不新增做种 push(pull 为主,已做种任务保留启动档,spec §2.5)。
    const getSeedConfig = (): SeedConfig => {
      const s = settingsService.get()
      return {
        enabled: s.btSeedEnabled,
        ratio: s.btSeedRatio,
        timeMin: s.btSeedTimeMin,
        maxPeers: s.btMaxPeers
      }
    }

    // 视频解析器仅真引擎路径装配(dev:fake 视频解析留 Phase 3 的 FakeVideoResolver)
    let videoResolver: VideoResolverLike | undefined

    // tracker 缓存(v0.4 Task 1 · spec §4.3 装配顺序):**必须早于 new DownloadEngine** ——
    // pull 通道要在 aria2 启动时就拿到生效表。纯 fs 读、无网络依赖;缺失 / 损坏回退默认(空表 → 内置 47 条)。
    const btTrackerStore = createBtTrackerStore(
      join(userDataDir, 'config', 'btTrackers.json'),
      nodeBtTrackerStoreFs
    )
    effectiveBtTrackers = (await btTrackerStore.read()).trackers

    if (useFake) {
      // dev:fake — FakeEngine(下载后端视频态)+ FakeVideoResolver(解析 mock),走视频全态(spec §4.5)。
      //   代理 / cookie 回调接同签名但 fake **忽略**其值(dev 不真正连网 / 不真读 cookie,spec §4.4 / §6.4)。
      downloadEngine = new FakeEngine({ getProxy, getSpeedLimit, getSeedConfig })
      videoResolver = new FakeVideoResolver({ getProxy, getCookie })
      console.log(
        '[engine] FakeEngine + FakeVideoResolver 已启用(dev 模拟引擎 / 解析;视频全态可手测)'
      )
    } else {
      // 双执行器:aria2 直链后端 + yt-dlp 视频后端,经 CompositeDownloadEngine 对 TaskManager 透明。
      //   getProxy 注入三处:aria2 任务级 all-proxy / yt-dlp 下载 --proxy / yt-dlp 解析 --proxy。
      //   getCookie 注入 yt-dlp 下载 + 解析两处(与 getProxy 对称;aria2 直链后端无 cookie 概念,不注入)。
      const httpEngine = new DownloadEngine(
        {
          aria2ProcessDeps: { spawn, net, crypto },
          getProxy,
          getSpeedLimit,
          getSeedConfig,
          // tracker 生效表 pull(v0.4 Task 1 · spec §4.2):每次启动 / 崩溃重启实时读;
          // 空表 → 返回 undefined → buildAria2Args 用内置 DEFAULT_BT_TRACKERS(与现状逐字节等价,零回归)
          getBtTrackers: () => (effectiveBtTrackers.length ? effectiveBtTrackers : undefined)
        },
        // dhtFilePath(6):DHT 路由表持久化(v0.3 修订三 + 2026-07-25 修订 v6),缩短每次启动 BT 找 peers 的等待
        {
          aria2cPath,
          defaultDir,
          dhtFilePath: join(userDataDir, 'dht.dat'),
          dhtFilePath6: join(userDataDir, 'dht6.dat')
        }
      )
      const videoEngine = new VideoEngine(
        {
          spawn,
          getProxy,
          getCookie,
          getSpeedLimit,
          getVideoAccel,
          // v0.4 Task 6 第四档:物化 + 连接态。两者都可选,不注入即与改动前逐字节等价。
          leaseCookieFile,
          isExtensionLinked
        },
        { ytdlpPath, ffmpegPath, aria2cPath, defaultDir }
      )
      downloadEngine = new CompositeDownloadEngine(httpEngine, videoEngine)
      videoResolver = new VideoResolver(
        {
          ytdlpProcess: createYtdlpProcess({ spawn }),
          getProxy,
          getCookie,
          leaseCookieFile,
          isExtensionLinked
        },
        { ytdlpPath }
      )
    }

    // 启动下载引擎(CompositeEngine 顺序启动 aria2 + yt-dlp)
    await downloadEngine.start()
    console.log(
      useFake ? '[FakeEngine] 启动成功' : '[CompositeEngine] 启动成功(aria2 + yt-dlp 双执行器)'
    )

    // 持久化库:初始化(建表 / 迁移)→ 幂等 seed 默认类别(spec §6.1,在迁移之后、TaskManager.start 前;
    // 非空跳过,绝不覆盖用户已改配置)。库句柄注入 TaskManager 复用,避免二次打开同一文件。
    const dbPath = join(userDataDir, 'database', 'downlord.db')
    const db = initDatabase(dbPath)
    seedDefaultCategories(db)

    // TaskManager 枢纽:复用已初始化的库句柄 → 读库恢复任务 → 订阅引擎进度 → 重提交未完成任务(§7)
    // getVideoPrefs 注入为 () => settingsService.get().video:每次解析实时读视频默认偏好(改设置即时生效,spec §3.4)
    taskManager = new TaskManager(
      {
        engine: downloadEngine,
        videoResolver,
        initDatabase: () => db,
        getVideoPrefs: () => settingsService.get().video,
        // 删除文件 / 残留清理走系统回收站(可恢复,§7.3);注入真实 shell.trashItem
        trashItem: (p) => shell.trashItem(p),
        // tracker 表按需刷新(v0.4 Task 1 · spec §4.1):延迟读 btTrackerService(它在 updateHttp 之后
        // 才装配,仿既有 taskManager?. 的注入缝);未就绪 → no-op。调用点 fire-and-forget 不 await。
        refreshBtTrackers: () => {
          // 同一触发点顺带重算入站诊断(spec §3.4 ③),但**不受 tracker 自动更新开关约束** ——
          // 自检是纯本地读网卡、零外联,与是否拉取远端表无关;同样「state 变了才广播」。
          recomputeInboundAndBroadcast('添加 BT 任务')
          return btTrackerService?.maybeRefresh() ?? Promise.resolve()
        }
      },
      // userDataDir:.torrent 托管副本 <userData>/torrents/<id>.torrent 的根(v0.3 Task 1 · §6.1);
      // copyFileSync / readFileSync 用 TaskManager 内置 fs 默认。BT 走既有 downloadEngine(aria2 后端),无新引擎实例。
      { dbPath, defaultDir, maxConcurrent, userDataDir }
    )

    // 注册任务 IPC（在 taskManager 创建后）
    // v0.4 Task 4 · spec §6.3:注入「这条查重冲突是不是接管小窗口独占的」——命中则不广播给其它窗口
    // (否则主窗口会弹一个陈旧的僵尸查重框,直接违反「主窗口全程不动」)。
    // 缺省不传即与 Task 3 交付态逐字等价;此处传的是**本 Task 对既有代码的第二处改动**,如实记账。
    registerTaskIpc(taskManager, {
      isOwnedByTakeover: (conflictId) => takeoverServiceRef?.owns(conflictId) ?? false
    })
    registerVideoIpc(taskManager)
    // BT 文件选择 IPC(v0.3 Task 2 · spec §8):纯转发 torrent:applySelection → TaskManager.applyTorrentSelection,
    // 与 registerVideoIpc 并列同构;定型 / 校验 / 出队全在主进程(渲染层零业务,§7.2)。
    registerTorrentIpc(taskManager)
    // 类别 IPC:复用已初始化库句柄。category:list 投影类别配置供 chips / 设置页;savePath 投影解析后真实
    // 目录(注入 getDefaultDir,跟随类随默认目录实时解析);category:update 写库后经回调刷新 TaskManager 缓存
    // (后续任务用新配置,已存不回迁;纯转发,§6.3 / §1.7)。
    registerCategoryIpc({
      db,
      refreshCategories: () => taskManager?.refreshCategories(),
      getDefaultDir: () => settingsService.get().defaultDir || systemDownloads
    })
    // 历史 IPC(v0.2 Task 5 · spec §7.2):复用已初始化库句柄(与 seed / TaskManager / registerCategoryIpc
    // 同一 db,不二次打开避免 WAL 冲突)。handler 只读 tasks 表(检索 / 统计),纯转发调 Phase 1 DAO / 纯函数。
    registerHistoryIpc({ db })
    // 代理 IPC(proxy:get/set/getStatus)与设置 IPC(settings:get/set)已在服务 init 后提前注册
    // (见上方 proxyService.init() 之后),此处不再重复。

    await taskManager.start()
    console.log('[TaskManager] 启动成功')

    // v0.4 Task 4 接管编排装配(spec §3.2 / plan 2.6):**须在 taskManager.start() 之后** ——
    // 它是接管路径的唯一落点(`addTask` 全链路:分类路由 / 查重 / 限速 / 断点续传 / 错误映射)。
    // 引擎或 DB 起不来时本段整体不执行 → `takeoverServiceRef` 恒 null → 通道 handler 恒回
    // `{taken:false}` → 扩展永不 cancel、浏览器照常下载(与「DownLord 未运行」同一条降级路径)。
    const takeoverService = new TakeoverService({
      now: () => Date.now(),
      // v0.4 Task 4 Step 6a:接管配置真源(第六份 jsonConfigStore;与 extensionChannel.json 同目录)。
      // `nodeChannelStoreFs` 是通用 `JsonConfigStoreFs` 的 node 实现,**不是通道专用**,直接复用。
      configStore: createTakeoverConfigStore(
        join(userDataDir, 'config', 'takeover.json'),
        nodeChannelStoreFs
      ),
      // 暂停真源有两个写入口(设置页 / popup 遥控器)→ 任一方写完都推给所有窗口
      onConfigChanged: broadcastTakeoverConfig,
      scheduleTick: (delayMs, fn) => {
        const timer = setTimeout(fn, delayMs)
        return () => clearTimeout(timer)
      },
      createWindow: () => createTakeoverWindowHandle(),
      isAppReady: () => app.isReady(),
      // 主窗口还在不在:除掉接管小窗口后还有窗口就算在。**不碰 `createWindow` / `window-all-closed`**
      hasMainWindow: () =>
        BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !isTakeoverWindow(w)),
      addTask: (input) => {
        if (!taskManager) throw new Error('TaskManager 未就绪')
        return taskManager.addTask(input)
      },
      // 主进程侧建的任务,主窗口不会自己知道 → 广播一条空载荷的「去重拉」(2026-08-02 真机修复)
      onTaskCreated: broadcastTaskAdded,
      // 查重两条:Phase 3 才消费(接管路径自己那条冲突定向送小窗口 + 关窗时显式 skip)
      onDuplicate: (cb) => taskManager?.onDuplicate(cb) ?? ((): void => {}),
      resolveDuplicate: async (res) => taskManager?.resolveDuplicate(res),
      // 建议名 = `resolveFilename` 未传 filename 时走的同一支纯函数(零复制,U-12 钉死)
      suggestFilename: filenameFromUrl,
      getResolvedTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      // v0.4 Task 6:档位闸门 + 确认框那一行的数据源。
      // `getCookieSource` 实时读 settings(与 `getCookie` 同一真源、同一「切档即时生效」口径);
      // 不是第四档 → `needCookieForOf` 恒 `[]` → 应答里连 `needCookieFor` 这个键都不存在。
      getCookieSource: () => getCookie().source,
      // 只出 host,不出值 —— 确认框要显示的就是 host(红线 R3 由接口形状保证)
      getBorrowedCookieHosts: () => borrowedCookies.hosts(),
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m)
      }
    })
    // 先 init 后 start:`init()` 读 takeover.json 决定「用哪份配置判」,必须先于任何 intent 到达。
    // 缺失 / 损坏 → store 回退默认并回写修复(用户配置,`repairOnInvalid: true`)。
    await takeoverService.init()
    takeoverService.start()
    takeoverServiceRef = takeoverService
    registerTakeoverIpc({
      service: takeoverService,
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m)
      }
    })

    // Task 4(v0.2)剪贴板监控装配(spec §3.4 / §7):须在 taskManager 构造 / 启动后创建——
    // getKnownFileExts / getTrackedUrls 延迟读它(运行时类别扩展名并集加固识别 / 已在列表源 URL 去重)。
    // onDetected 注入 broadcastClipboardLink 广播所有窗口;setEnabled 尊重持久化开关档(默认 false →
    // 不 seed / 不启动轮询,与接线前逐字节等价)。识别 / 去重 / 隐私逻辑全在服务与纯函数,此处纯装配(spec §7.2)。
    clipboardWatcher = new ClipboardWatcher(
      {
        readText: () => clipboard.readText(),
        onDetected: broadcastClipboardLink,
        getKnownFileExts: () => taskManager?.getKnownFileExts() ?? new Set(),
        getTrackedUrls: () => taskManager?.getTrackedSourceUrls() ?? new Set()
      },
      { intervalMs: 1000 }
    )
    clipboardWatcher.setEnabled(settings.clipboardWatch) // 尊重持久化档(默认 false → 不启动轮询)

    // Task 6(v0.2)yt-dlp 独立热更新装配(spec §2;§7.5 红线):独立 update session + Electron net
    // 走代理下载(与业务引擎隔离);getCurrentVersion 读启动已探测的 engineVersionsCache.ytdlp;
    // hasActiveYtDlp 决定替换时机(占用降级 pending,不杀进程,§7.1);替换目标只动可写副本 + .download/.pending,
    // 绝不碰内置 resources/bin/。onStatus 先占位空实现(Phase 3 接 broadcastUpdateStatus)。
    const updaterFs: UpdaterFs = {
      statSync: (p) => statSync(p),
      readFile: (p) => readFile(p),
      rename: (o, n) => rename(o, n),
      unlink: (p) => unlink(p)
    }
    const updateHttp = createUpdateHttpClient({
      net: electronNet as unknown as UpdateNetLike,
      session: session.fromPartition('update')
    })
    const updateStateStore = createUpdateStateStore(
      join(userDataDir, 'config', 'updateState.json'),
      nodeUpdateStateStoreFs
    )

    // tracker 表热更新编排装配(v0.4 Task 1 · spec §4.3):**复用同一个 updateHttp 实例**
    // (独立 update session,与业务引擎隔离),不另起网络栈(D12)。
    // 触发点在 TaskManager.addTorrentTask(添加 BT 任务时,fire-and-forget);开关 / 节流 / 失败降级全在 service 内。
    btTrackerService = new BtTrackerService({
      http: updateHttp,
      getProxy,
      store: btTrackerStore,
      now: () => Date.now(),
      // 热应用:aria2 后端 changeGlobalOption + 追补活跃 torrent 任务;fake / 未启动 → 诚实回全零
      applyToEngine: async (t) =>
        (await downloadEngine?.applyBtTrackers?.(t)) ?? {
          globalOk: false,
          patched: 0,
          failed: 0
        },
      // 自动路径开关(v0.4 Task 1 · spec §5.2):实时读 settings.btAutoUpdateTrackers(默认开);
      // 关 = 整条链路不启动、**零外联**。手动路径(bt:updateTrackersNow)无视本开关。
      isEnabled: () => settingsService.get().btAutoUpdateTrackers,
      // 生效表回写:此后 aria2 崩溃重启 / 下次启动的 pull 通道即用新表
      onApplied: (t) => {
        effectiveBtTrackers = t
      },
      // 状态广播(v0.4 Task 1 · spec §5.3):经 bt:trackerStatusChanged 推所有窗口更新状态行;
      // **自动路径不弹 toast**(D15),toast 只在手动「立即更新」由渲染层按 invoke 返回值弹。
      onStatus: broadcastBtTrackerStatus,
      log: (msg) => console.log(msg)
    })
    ytdlpUpdater = new YtdlpUpdater({
      http: updateHttp,
      fs: updaterFs,
      spawn,
      getProxy,
      getCurrentVersion: () => engineVersionsCache.ytdlp,
      hasActiveYtDlp: () => taskManager?.hasActiveYtDlp() ?? false,
      writableYtDlpPath: userWritableYtDlpPath(userDataDir),
      stateStore: updateStateStore,
      onStatus: broadcastUpdateStatus, // Phase 3:onStatus 接广播,更新各阶段 UpdateStatus 推渲染层(spec §4.2)
      // 替换真正生效 → 刷新当前版本缓存(否则再次检查仍读旧版 → 重复下载同一版本,U4 真机 bug 修复)。
      // 新副本已过 `--version == tag` 校验,直接用 tag 校正,无需再探测。pending 不调(下次启动 probeVersion 校正)。
      onApplied: (version) => {
        engineVersionsCache = { ...engineVersionsCache, ytdlp: version }
      }
    })

    // 后台自动检查(spec §2.5 时机):ready 后延迟 ~10s 避开启动高峰,fire-and-forget 不阻塞;
    // autoUpdateYtDlp(默认开)&& 距上次 ≥ 24h(节流)→ run()(有更新则下载 / 校验 / 替换 / toast)。
    // 无网络 / 失败静默回退记日志不崩(内部 try 兜底 + onStatus error);手动检查(Phase 3)无视节流。
    setTimeout(() => {
      void (async () => {
        try {
          if (!settingsService.get().autoUpdateYtDlp) return
          if (!(await ytdlpUpdater?.shouldCheckNow())) return
          console.log('[YtdlpUpdater] 后台自动检查 yt-dlp 更新(距上次 ≥ 24h)...')
          await ytdlpUpdater?.run()
        } catch (err) {
          console.warn('[YtdlpUpdater] 后台自动检查异常(已忽略,不影响运行):', err)
        }
      })()
    }, 10_000)

    // Task 6(v0.2)应用本体自更新装配(spec §3;electron-updater):autoUpdater 由 electron-updater 提供,
    // 构造侧强制转型注入(结构满足 AppAutoUpdaterLike);configureProxy 设 electron-updater 自有 netSession
    // 代理(与业务引擎隔离,不污染 aria2 / yt-dlp);getCurrentVersion 读 app.getVersion();AppUpdater 构造即
    // 置 autoDownload=false / autoInstallOnAppQuit=false(诚实不静默)。onStatus 先占位空实现(Phase 3 接广播)。
    appUpdater = new AppUpdater({
      autoUpdater: autoUpdater as unknown as AppAutoUpdaterLike,
      getProxy,
      // electron-updater 用自有 netSession 发起 net 请求(与业务下载引擎隔离);按当前档设代理
      // (非空 → 该地址;null → 显式直连,§3.3)。真实走代理需发布 Release 方能验证(归手测)。
      configureProxy: async (effectiveUrl) => {
        await autoUpdater.netSession.setProxy({ proxyRules: effectiveUrl ?? 'direct://' })
      },
      onStatus: broadcastUpdateStatus, // Phase 3:onStatus 接广播,更新各阶段 UpdateStatus 推渲染层(spec §4.2)
      getCurrentVersion: () => app.getVersion(),
      // dev 未打包态 electron-updater 无法真检查(dev-app-update.yml provider 占位会挂起)→ 诚实快速返回,不 hang(U5 修复)
      checkSupported: () => app.isPackaged
    })

    // Task 6(v0.2)更新 IPC 装配(Phase 3 · spec §4.2 / §1.8):纯转发两 updater 的 check / run /
    // download / quitAndInstall;onStatus 已注入 broadcastUpdateStatus,检查 / 下载 / 校验各阶段
    // UpdateStatus 经 update:status 推所有窗口(渲染层订阅 UI 见 Step 5)。handler 内零业务逻辑(§7.2)。
    registerUpdateIpc({ ytdlpUpdater, appUpdater })

    // BT IPC 装配(v0.4 Task 1 · spec §5.3):纯转发 tracker 状态 / 立即更新 / 入站自检三通道。
    // onStatus 已注入 broadcastBtTrackerStatus(自动路径完成经 bt:trackerStatusChanged 推所有窗口);
    // diagnose 注入纯函数绑定版 —— **每次被问都实算、不缓存**(换网自动重算的地基,§3.4)。
    // handler 内零业务逻辑(§7.2);渲染层设置页三行接线见 Step 5。
    registerBtIpc({
      trackerService: btTrackerService,
      diagnose: () => diagnoseInbound(inboundProbeDeps)
    })

    // 睡眠唤醒常伴随换网(spec §3.4 ②):resume 时重算入站诊断,**state 变了才广播**。
    // 只订阅系统事件,**不起常驻定时器轮询网卡**(D3 / §3.4)。
    powerMonitor.on('resume', () => {
      recomputeInboundAndBroadcast('系统唤醒')
    })

    // 后台自动检查应用更新(spec §3.4):ready 后延迟 fire-and-forget,autoUpdateApp(默认开)&&
    // 距上次 ≥ 24h(节流,复用 updateState.lastAppCheckAt)→ **仅检查**(check(),autoDownload=false
    // 保证不下载);有新版经事件广播提示,下载 / 安装全由用户点击(不静默,§3.2)。无网络 / 失败静默回退不崩。
    setTimeout(() => {
      void (async () => {
        try {
          // dev 未打包态不后台检查应用更新(electron-updater 无法真检查,避免慢失败 / 误弹;U5 修复)
          if (!app.isPackaged) return
          if (!settingsService.get().autoUpdateApp) return
          const state = await updateStateStore.read()
          if (!shouldCheckNow(state.lastAppCheckAt, Date.now())) return
          console.log('[AppUpdater] 后台自动检查应用更新(距上次 ≥ 24h)...')
          const result = await appUpdater?.check()
          await updateStateStore.write({
            ...state,
            lastAppCheckAt: Date.now(),
            lastAppLatest: result?.latestVersion ?? state.lastAppLatest
          })
        } catch (err) {
          console.warn('[AppUpdater] 后台自动检查异常(已忽略,不影响运行):', err)
        }
      })()
    }, 12_000)
  } catch (err) {
    console.error('[TaskManager] 启动失败:', err)
    // 启动失败不阻止应用启动（用户可看到 UI，但下载功能不可用）
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Phase 3: 应用退出前优雅关闭 TaskManager → DownloadEngine
let isQuitting = false
app.on('before-quit', async (event) => {
  if ((downloadEngine || taskManager) && !isQuitting) {
    event.preventDefault() // 阻止立即退出
    isQuitting = true
    try {
      // 剪贴板监控退出即停(v0.2 Task 4 · spec §3.4):先停轮询定时器,无残留监控 / 无后台读剪贴板。
      clipboardWatcher?.stop()
      // 代理 system 档跟随轮询退出即停(2026-07-25 真机修订二)
      proxyServiceRef?.stop()
      // 本地通道退出即停(v0.4 Task 3 · spec §5.1):释放监听端口,无残留 socket。
      // ⚠️ 本 before-quit 体仅在 `(downloadEngine || taskManager)` 为真时执行 —— 该分支不成立时
      // 进程照样退出、端口由 OS 释放,故不是缺口;放这里只为与既有停机序列一致。
      await extensionChannelRef?.stop()
      // 接管退出即停(v0.4 Task 4 · spec §3.4):清定时器 + 清缓冲 + 关小窗口,**不新增 quit 分支**
      takeoverServiceRef?.stop()
      if (taskManager) {
        console.log('[TaskManager] 正在关闭...')
        await taskManager.stop()
        console.log('[TaskManager] 已关闭')
      }
      if (downloadEngine) {
        console.log('[engine] 正在关闭...')
        await downloadEngine.stop()
        console.log('[engine] 已优雅关闭')
      }
    } catch (err) {
      console.error('[shutdown] 关闭失败:', err)
    } finally {
      taskManager = null
      downloadEngine = null
      app.quit() // 继续退出流程
    }
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
