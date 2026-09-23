/**
 * 主窗口的 API 面(`window.api`,62 条)——**Step 4 从 `index.ts` 原样搬出,一个字未改**;
 * Step 6a 在末尾追加接管配置四条(spec §5.5),v0.4 Task 6 再追加暂借登录态三条,
 * 既有 55 条仍逐字未动。
 *
 * 拆成独立模块只为让 `index.ts` 只留「按窗口标记二选一 expose」那几行(v0.4 Task 4 · spec §3.6);
 * 形态、注释、方法顺序与搬出前逐字节一致,**零回归**。
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type DownLordApi,
  type ResolvedTheme,
  type ThemeMode,
  type AddTaskInput,
  type TaskFilter,
  type TaskProgress,
  type DuplicateConflict,
  type DuplicateResolution,
  type FormatChoice,
  type BatchPick,
  type CategoryPatch,
  type ProxyConfig,
  type ProxyStatus,
  type AppSettingsPatch,
  type ClipboardLink,
  type HistoryQuery,
  type UpdateStatus,
  type BtTrackerStatus,
  type InboundDiagnosis,
  type ExtensionChannelStatus,
  type TakeoverSettingsView,
  type BorrowedCookieHosts
} from '../shared/ipc'

/**
 * 渲染进程可见的最小 IPC bridge:只转发到主进程,不含任何业务逻辑(§2.1)。
 * 形态与类型由 shared 的 `DownLordApi` 约束,保证主 / 渲染同源。
 */
export const api: DownLordApi = {
  getVersion: () => ipcRenderer.invoke(IpcChannel.AppGetVersion),
  openThirdPartyNotices: () => ipcRenderer.invoke(IpcChannel.AppOpenThirdPartyNotices),
  getDownloadDir: () => ipcRenderer.invoke(IpcChannel.AppGetDownloadDir),
  minimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
  toggleMaximize: () => ipcRenderer.send(IpcChannel.WindowToggleMaximize),
  close: () => ipcRenderer.send(IpcChannel.WindowClose),
  setTheme: (mode: ThemeMode) => ipcRenderer.invoke(IpcChannel.ThemeSet, mode),
  onThemeChanged: (callback: (theme: ResolvedTheme) => void) => {
    const listener = (_event: IpcRendererEvent, theme: ResolvedTheme): void => callback(theme)
    ipcRenderer.on(IpcChannel.ThemeChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.ThemeChanged, listener)
    }
  },
  selectDirectory: () => ipcRenderer.invoke(IpcChannel.DialogSelectDirectory),
  // v0.2 Task 1 Cookie=从文件 / v0.3 Task 1 torrent 选种子:可选 filters 透传(缺省 = cookie `.txt`,零回归)
  selectFile: (options) => ipcRenderer.invoke(IpcChannel.DialogSelectFile, options),
  openPath: (path: string) => ipcRenderer.invoke(IpcChannel.ShellOpenPath, path),
  showItemInFolder: (path: string) => ipcRenderer.invoke(IpcChannel.ShellShowItemInFolder, path),
  addTask: (input: AddTaskInput) => ipcRenderer.invoke(IpcChannel.TASK_ADD, input),
  pauseTask: (id: string) => ipcRenderer.invoke(IpcChannel.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IpcChannel.TASK_RESUME, id),
  removeTask: (id: string, deleteFile?: boolean) =>
    ipcRenderer.invoke(IpcChannel.TASK_REMOVE, id, deleteFile),
  retryTask: (id: string) => ipcRenderer.invoke(IpcChannel.TASK_RETRY, id),
  // 单任务限速纯转发(v0.3 Task 4 #25:值域扩 number | null,`null` = 清除覆盖 = 跟随全局)
  setTaskLimit: (id: string, kbps: number | null) =>
    ipcRenderer.invoke(IpcChannel.TaskSetLimit, id, kbps),
  listTasks: (filter?: TaskFilter) => ipcRenderer.invoke(IpcChannel.TASK_LIST, filter),
  onTaskProgress: (callback: (progress: TaskProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: TaskProgress): void => callback(progress)
    ipcRenderer.on(IpcChannel.TASK_PROGRESS, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TASK_PROGRESS, listener)
    }
  },
  // v0.4 Task 4:接管路径由**主进程侧**建任务 → 渲染层没有 invoke 可以 refresh,靠这条广播重拉
  onTaskAdded: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannel.TaskAdded, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TaskAdded, listener)
    }
  },
  // v0.2 Task 3 查重(纯转发;主进程检测 → 广播,渲染层订阅弹窗 + 回传决策,App 接线留 Phase 4)
  onTaskDuplicate: (callback: (conflict: DuplicateConflict) => void) => {
    const listener = (_event: IpcRendererEvent, conflict: DuplicateConflict): void =>
      callback(conflict)
    ipcRenderer.on(IpcChannel.TaskDuplicate, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TaskDuplicate, listener)
    }
  },
  resolveDuplicate: (res: DuplicateResolution) =>
    ipcRenderer.invoke(IpcChannel.DuplicateResolve, res),
  getResolved: (id: string) => ipcRenderer.invoke(IpcChannel.VideoGetResolved, id),
  selectFormat: (id: string, choice: FormatChoice) =>
    ipcRenderer.invoke(IpcChannel.VideoSelect, id, choice),
  submitBatch: (parentId: string, picks: BatchPick[]) =>
    ipcRenderer.invoke(IpcChannel.VideoSubmitBatch, parentId, picks),
  // v0.3 Task 2 BT 文件选择(纯转发;定型 / 校验 / 出队全在主进程 TaskManager,BtFileDialog / App 接线留 Step 4)
  applyTorrentSelection: (id: string, selectedIndices: number[]) =>
    ipcRenderer.invoke(IpcChannel.TorrentApplySelection, id, selectedIndices),
  // v0.3 Task 3 BT 停止做种(纯转发;校验 / forcePause / 清 runtime / 广播全在主进程 TaskManager,TaskRow / 设置页接线留 Step 4)
  stopSeeding: (id: string) => ipcRenderer.invoke(IpcChannel.TorrentStopSeeding, id),
  listCategories: () => ipcRenderer.invoke(IpcChannel.CategoryList),
  updateCategory: (key: string, patch: CategoryPatch) =>
    ipcRenderer.invoke(IpcChannel.CategoryUpdate, key, patch),
  // Task 7 代理(纯转发;维持 DownLordApi 契约自洽。main handler 注册 + statusChanged 广播接线留 Step 5)
  getProxyConfig: () => ipcRenderer.invoke(IpcChannel.ProxyGet),
  setProxyConfig: (config: ProxyConfig) => ipcRenderer.invoke(IpcChannel.ProxySet, config),
  getProxyStatus: () => ipcRenderer.invoke(IpcChannel.ProxyGetStatus),
  onProxyStatusChanged: (callback: (status: ProxyStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: ProxyStatus): void => callback(status)
    ipcRenderer.on(IpcChannel.ProxyStatusChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.ProxyStatusChanged, listener)
    }
  },
  // Task 8 设置(纯转发;handler 注册 + 联动接线留 Phase 2)
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setSettings: (patch: AppSettingsPatch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
  getEngineVersions: () => ipcRenderer.invoke(IpcChannel.AppGetEngineVersions),
  // v0.2 Task 4 剪贴板监控(纯转发;主进程 ClipboardWatcher 检测 → 广播,渲染层订阅弹提示,App 接线留 Step 4)
  onClipboardLink: (callback: (link: ClipboardLink) => void) => {
    const listener = (_event: IpcRendererEvent, link: ClipboardLink): void => callback(link)
    ipcRenderer.on(IpcChannel.ClipboardLinkDetected, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.ClipboardLinkDetected, listener)
    }
  },
  // v0.2 Task 5 历史检索 / 统计(纯转发;时间口径 / clamp / trim / 聚合全在主进程,渲染层只传 query,spec §7.2)
  searchHistory: (query: HistoryQuery) => ipcRenderer.invoke(IpcChannel.HistorySearch, query),
  getHistoryStats: () => ipcRenderer.invoke(IpcChannel.HistoryStats),
  // v0.2 Task 6 更新(纯转发;检查 / 下载 / 三重校验 / 替换全在主进程 updater,渲染层只触发 + 订阅进度,spec §4.2)
  checkYtDlpUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateCheckYtDlp),
  runYtDlpUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateRunYtDlp),
  checkAppUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateCheckApp),
  downloadAppUpdate: () => ipcRenderer.invoke(IpcChannel.UpdateDownloadApp),
  quitAndInstallApp: () => ipcRenderer.invoke(IpcChannel.UpdateQuitInstallApp),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: UpdateStatus): void => callback(status)
    ipcRenderer.on(IpcChannel.UpdateStatus, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.UpdateStatus, listener)
    }
  },
  // v0.4 Task 1 BT tracker 热更新 + 入站自检(纯转发;拉取 / 解析 / 合并 / 节流 / IPv6 判定 / 三态汇总
  // 全在主进程 service 与纯函数,渲染层只拉状态 + 订阅 + 渲染文字,设置页三行接线留 Step 5,spec §5.3)
  getBtTrackerStatus: () => ipcRenderer.invoke(IpcChannel.BtGetTrackerStatus),
  updateBtTrackersNow: () => ipcRenderer.invoke(IpcChannel.BtUpdateTrackersNow),
  getBtInboundDiagnosis: () => ipcRenderer.invoke(IpcChannel.BtGetInboundDiagnosis),
  onBtTrackerStatusChanged: (callback: (status: BtTrackerStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: BtTrackerStatus): void => callback(status)
    ipcRenderer.on(IpcChannel.BtTrackerStatusChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.BtTrackerStatusChanged, listener)
    }
  },
  onBtInboundChanged: (callback: (diagnosis: InboundDiagnosis) => void) => {
    const listener = (_event: IpcRendererEvent, diagnosis: InboundDiagnosis): void =>
      callback(diagnosis)
    ipcRenderer.on(IpcChannel.BtInboundChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.BtInboundChanged, listener)
    }
  },
  // v0.4 Task 3 浏览器扩展本地通道(纯转发;token 保障 / 三闸鉴权 / 起停 / 端口校验 / 连接态
  // 全在主进程 ExtensionChannelService 与纯函数,渲染层只读状态 + 改开关端口,设置页接线留 Step 5)
  getExtensionChannelConfig: () => ipcRenderer.invoke(IpcChannel.ExtensionGetChannelConfig),
  setExtensionChannelConfig: (patch) =>
    ipcRenderer.invoke(IpcChannel.ExtensionSetChannelConfig, patch),
  regenerateExtensionToken: () => ipcRenderer.invoke(IpcChannel.ExtensionRegenerateToken),
  getExtensionChannelStatus: () => ipcRenderer.invoke(IpcChannel.ExtensionGetChannelStatus),
  getExtensionSideloadInfo: () => ipcRenderer.invoke(IpcChannel.ExtensionGetSideloadInfo),
  onExtensionChannelStatusChanged: (callback: (status: ExtensionChannelStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: ExtensionChannelStatus): void =>
      callback(status)
    ipcRenderer.on(IpcChannel.ExtensionChannelStatusChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.ExtensionChannelStatusChanged, listener)
    }
  },
  // v0.4 Task 4 下载接管配置(纯转发;暂停的**唯一真源在主进程** —— 时长换算 / 域名归一 /
  // 「此刻是否暂停」全在 TakeoverService 与其纯函数,渲染层只读快照 + 报时长档,不自己判时钟)。
  // ⚠️ 这四条只在**主窗口**的 API 面里;接管确认小窗口的 `takeoverApi.ts` 一个字不改 —— 它不需要设置能力。
  getTakeoverConfig: () => ipcRenderer.invoke(IpcChannel.TakeoverGetConfig),
  setTakeoverConfig: (patch) => ipcRenderer.invoke(IpcChannel.TakeoverSetConfig, patch),
  setTakeoverPause: (patch) => ipcRenderer.invoke(IpcChannel.TakeoverSetPause, patch),
  onTakeoverConfigChanged: (callback: (view: TakeoverSettingsView) => void) => {
    const listener = (_event: IpcRendererEvent, view: TakeoverSettingsView): void => callback(view)
    ipcRenderer.on(IpcChannel.TakeoverConfigChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.TakeoverConfigChanged, listener)
    }
  },
  // v0.4 Task 6 暂借登录态(纯转发)。🔴 三条通道的载荷**只有 host 列表** ——
  // 渲染层从头到尾没有任何通路能拿到 cookie 值,这是接口形状的后果而非纪律(红线 R3)。
  // 设置页可见行 / 清除按钮的接线留 Step 5。
  getBorrowedCookieHosts: () => ipcRenderer.invoke(IpcChannel.CookieGetBorrowedHosts),
  clearBorrowedCookies: () => ipcRenderer.invoke(IpcChannel.CookieClearBorrowed),
  onBorrowedCookiesChanged: (callback: (snapshot: BorrowedCookieHosts) => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: BorrowedCookieHosts): void =>
      callback(snapshot)
    ipcRenderer.on(IpcChannel.CookieBorrowedChanged, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannel.CookieBorrowedChanged, listener)
    }
  }
}
