/**
 * IPC 契约 — 主 / 渲染进程类型同源的单一来源。
 *
 * - 通道名集中常量化(`IpcChannel`),消除散落字符串的拼写漂移;主 / 渲染两端只引用此处。
 * - payload / 返回类型在此定义;main handler 与 preload bridge 共用同一份,renderer 经
 *   preload 暴露的 `DownLordApi` 访问,不直接接触 `ipcRenderer` 或通道名(§2.1 进程职责分离)。
 *
 * 本 Task(脚手架)最小集:`app:getVersion` 全链路 + `window:*` / `theme:*` 契约
 * (窗口控制 / 主题切换的实际联调见 Step 5 / Phase 4)。
 */

/** 用户可选的主题三态(`theme:set` 入参) */
export type ThemeMode = 'system' | 'light' | 'dark'

/** nativeTheme 解析后实际生效的明暗(`theme:set` 返回值 / `theme:changed` 推送值) */
export type ResolvedTheme = 'light' | 'dark'

export const TASK_ADD = 'task:add'
export const TASK_PAUSE = 'task:pause'
export const TASK_RESUME = 'task:resume'
export const TASK_REMOVE = 'task:remove'
export const TASK_RETRY = 'task:retry'
export const TASK_LIST = 'task:list'
export const TASK_PROGRESS = 'task:progress'

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error'

export type TaskStatus =
  | 'resolving'
  | 'awaiting_selection'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'processing'
  | 'completed'
  | 'error'

export type DesiredState = 'active' | 'paused'

export interface AddUriInput {
  url: string
  dir: string
  filename?: string
  /** 视频任务的 yt-dlp 提交参数;直链(http)不带此字段,aria2 后端无感(§4.1) */
  video?: VideoSubmit
  /**
   * 接管来源的请求头(v0.4 Task 4 · spec §6.2);只可能含 `Referer` / `User-Agent` 两个键。
   * 缺省不带此字段 → `toAria2HeaderOptions` 恒产 `{}` → 展开后 options **逐字节等价**、后端无感
   * (仿 `video?` / `torrent?` 的加性做法)。**BT 分支不消费**它,只走 http 分支。
   */
  headers?: Record<string, string>
  /**
   * BT 任务的种子来源(v0.3 Task 1 · spec §10.2)。`source==='magnet'` → `url` 即磁力链接、`content` 空;
   * `source==='file'` → 引擎走 `aria2.addTorrent`,`content` = 种子文件 base64。
   * 缺省(http / video)不带此字段 → aria2 / yt-dlp 后端无感(仿 `video?` 的加性做法)。
   *
   * `selectFile` / `awaitSelection` 为 v0.3 Task 2 文件选择新增(均加性可选,未带者引擎无感,零回归):
   * - `selectFile`:出队 / 恢复重建的 aria2 `--select-file` 索引串(1-based,如 `"1,3-5"`);**全选省略**(§4.3)。
   * - `awaitSelection`:首次 / 待选恢复提交 → 引擎元数据后暂停(magnet `pause-metadata` / `.torrent` `pause`),
   *   停在 `awaiting_selection` 待用户选文件(§5.1)。
   */
  torrent?: {
    source: 'magnet' | 'file'
    content?: string
    selectFile?: string
    awaitSelection?: boolean
  }
}

export interface DownloadTask {
  id: string
  gid?: string
  url: string
  dir: string
  filename?: string
  status: DownloadStatus
  desiredState: DesiredState
}

/**
 * BT 种子任务的元信息与进度类型(v0.3 Task 1 · spec §2.3 / §5.3)。
 * `TorrentFile` / `TorrentMeta` 描述种子内文件清单(Task 1 整包全选,为 Task 2 文件选择前置);
 * `TorrentInfo` 为引擎元数据阶段完成后随 `DownloadProgress` 一次性回报的种子信息。
 * 本 Phase 仅定义类型:`Task.torrentMeta` 落库列留 Phase 2、引擎产出 / 消费留 Phase 3。
 */

/** 种子内单个文件(§2.3;`selected` Task 1 整包恒 true,Task 2 文件选择用) */
export interface TorrentFile {
  /** 种子内相对路径(如 "Movie/movie.mkv") */
  path: string
  /** 文件字节数 */
  length: number
  /** 是否下载该文件(Task 1 整包恒 true) */
  selected: boolean
}

/** 种子元信息(持久化落 `tasks.torrentMeta`,§2.3;Phase 2 接 DB 列) */
export interface TorrentMeta {
  /** info.name(单文件 = 文件名 / 多文件 = 顶层文件夹名) */
  name: string
  /** BT infoHash(展示 / 去重用;元数据获取前为 null) */
  infoHash: string | null
  /** 文件清单(Task 1 整包全选) */
  files: TorrentFile[]
}

/** 引擎元数据阶段完成回报的种子信息(随 `DownloadProgress.torrentInfo`,§5.3) */
export interface TorrentInfo {
  name: string
  infoHash: string | null
  /** 种子总字节(落 `tasks.totalBytes`,不重复进 `torrentMeta`,§2.3) */
  totalBytes: number
  files: TorrentFile[]
}

export interface DownloadProgress {
  id: string
  status: DownloadStatus
  totalBytes: number
  downloadedBytes: number
  speed: number
  connections: number
  errorCode?: string
  /**
   * aria2 对失败下载给出的**原文**说明(真机修订 2026-07-27 · Task 4 spec §13)。
   * `errorCode=1`(unknown)时它是唯一说得清的信息(如 `SSL/TLS handshake failure: …`);
   * 经 `mapAria2DownloadError` 拼进用户可见文案,替代「引擎未知错误,请重试」的误导。
   * 仅 aria2 后端失败帧携带;yt-dlp 后端永不设(undefined),不污染其契约(同 `phase?` / `savePath?`)。
   */
  errorMessage?: string
  /** yt-dlp 后端区分下载 / 后处理阶段;aria2 后端不设(undefined)(§4.3) */
  phase?: 'downloading' | 'processing'
  /**
   * 后端回报的真实落盘绝对路径:yt-dlp 在 completed 用 after_move:filepath;
   * aria2 HTTP 从 files.path 提取(下载中亦可更新,含自动序号)。
   * 主进程据此校正 filename/savePath/category;BT 仍走 torrentInfo,不设此字段。
   */
  savePath?: string
  /**
   * BT 元数据阶段完成时,引擎经 followedBy 两段 gid 转移后一次性回报的种子信息(v0.3 Task 1 · spec §5.3):
   * name / infoHash / totalBytes / files。http / video 帧永不设(undefined),不污染 aria2 / yt-dlp 契约(仿 phase? / savePath?)。
   */
  torrentInfo?: TorrentInfo
  /**
   * BT 富进度(v0.3 Task 3 · spec §4;下载 / 做种中透传,**仅内存 + IPC 不落库**):
   * `numSeeders` = 做种节点数、`uploadSpeed` = 上行 B/s、`uploadLength` = 累计上传字节。
   * 仅 aria2 BT 帧对应原始键存在时设置;http / video 帧永不设(undefined,仿 phase? / torrentInfo?)。
   */
  numSeeders?: number
  uploadSpeed?: number
  uploadLength?: number
  /**
   * 做种中派生位(v0.3 Task 3 · spec §4):`isTorrent && 已下≥总>0 && rawStatus.status==='active' && 做种开档`。
   * 由引擎发帧路径附加(parseProgress 保持纯净);做种关档恒 false、http / video 帧永不设(无闪烁)。
   */
  seeding?: boolean
}

/**
 * Cookie 登录 + 字幕下载类型(v0.2 Task 1 · spec §2.1 / §3.1 / §3.2 / §4)。
 *
 * Cookie = 用户「自己浏览器已登录态」的三态来源(无 / 从浏览器 / 从文件),持久化在
 * `settings.json` 的 `video.cookie`,运行时经注入回调实时映射为 yt-dlp 参数(纯函数 `toYtdlpCookieArgs`);
 * **只存来源选择,绝不存 cookie 内容本身**(合规,§2.6)。字幕解析回填可用语言清单,下载可选旁挂 SRT / VTT。
 */

/**
 * Cookie 来源(v0.2 Task 1 立**三态**;v0.4 Task 6 起为**四态**,CONTEXT.md「Cookie 四态」)。
 *
 * ⚠️ **`'extension'` 与前三档的区别不是「从哪拿」而是「谁去读」**:`'browser'` 是 **yt-dlp 自己**
 * 读浏览器的 cookie 数据库(Chrome / Edge 运行中时通常读不到,这正是第四档存在的理由);
 * `'extension'` 是**浏览器扩展按任务请求**把 cookie 提供给 DownLord(「暂借登录态」)。
 *
 * ★ **`CookieConfig` 一个字段都不加**:第四档下 `browser` / `profile` / `file` 恒 `null`,
 *   与 `'none'` 档同形 → `settings.json` **零迁移**,且落盘形状里**没有位置能装 cookie 值**。
 */
export type CookieSource = 'none' | 'browser' | 'file' | 'extension'

/** yt-dlp 支持、Windows 常见的浏览器(`--cookies-from-browser` 取值,spec §2.1) */
export type CookieBrowser =
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'brave'
  | 'chromium'
  | 'opera'
  | 'vivaldi'

/**
 * Cookie 配置(持久化态,嵌入 `VideoPrefs`,spec §2.1)。
 * **只存来源选择 / 路径,绝不存 cookie 内容**(cookie 值始终由 yt-dlp 运行时即时读取,§2.6)。
 */
export interface CookieConfig {
  source: CookieSource
  /** source==='browser' 时有意义;其它档为 null */
  browser: CookieBrowser | null
  /** 可选指定浏览器 profile(MVP 恒 null 不在 UI 暴露;纯函数支持 `browser:profile` 拼接,前向兼容) */
  profile: string | null
  /** source==='file' 时的 Netscape cookie 文件绝对路径;其它档为 null */
  file: string | null
}

/** 默认 Cookie 配置:不使用(向后兼容,与 v0.1 逐字节等价,spec §2.1) */
export const DEFAULT_COOKIE_CONFIG: CookieConfig = {
  source: 'none',
  browser: null,
  profile: null,
  file: null
}

/**
 * 暂借登录态的**可见快照**(v0.4 Task 6 · spec §6.4)——「当前暂借:… [清除]」那一行的全部数据。
 *
 * 🔴 **整个类型只有一个 `hosts` 字段,连一个 `count` 都没有** —— 通往渲染层的三条 IPC
 * (`cookie:getBorrowedHosts` / `cookie:clearBorrowed` / `cookie:borrowedChanged`)全用它,
 * 于是「渲染层拿不到 cookie 值」不是一条需要人去遵守的纪律,而是**类型系统里根本没有那个位置**。
 * 想违反红线 R3,得先往这里加字段 —— 那一步足够刺眼(与 `DownloadIntent` 刻意没有 `dir`
 * 是同一手法)。
 */
export interface BorrowedCookieHosts {
  /** 当前持有登录态的**精确 host** 列表;插入序 = 借入序 */
  hosts: string[]
}

/**
 * 单条可用字幕轨(解析回填 `ResolvedVideo.subtitles`,spec §3.1)。
 * `auto=true` 为 automatic_captions(自动生成 / ASR),`false` 为 subtitles(人工 / 官方);
 * 同 lang 人工与自动可并存(UI 标注区分)。
 */
export interface SubtitleTrack {
  /** 语言码('zh-Hans' | 'en' | 'ai-zh'(B站自动)…) */
  lang: string
  /** yt-dlp 提供的可读名(如 'Chinese');缺失 null */
  name: string | null
  /** true=automatic_captions(自动生成)/ false=subtitles(人工) */
  auto: boolean
}

/**
 * 字幕下载选择(随 `videoMeta.subtitle` 持久化 / 默认偏好 `VideoPrefs.subtitle`,spec §3.2)。
 * `langs` 空数组 = 不下字幕(零附加,零回归)。
 */
export interface SubtitleChoice {
  /** 选中语言(空数组 = 不下字幕);多选,如 ['zh-Hans','en'] */
  langs: string[]
  /** 目标格式(默认 srt,最通用) */
  format: 'srt' | 'vtt'
  /** 是否允许自动生成字幕(--write-auto-subs) */
  includeAuto: boolean
}

/** 默认字幕选择:不下字幕(langs 空 → 零附加,零回归,spec §3.2) */
export const DEFAULT_SUBTITLE_CHOICE: SubtitleChoice = {
  langs: [],
  format: 'srt',
  includeAuto: false
}

export interface VideoMeta {
  title: string
  selectedFormat: string
  postProcess: string
  playlistIndex: number
  /**
   * 友好清晰度标签(Task 8.5 §3.1;仅音频 MP3 / `${height}P` / `≤${cap}P` / 最高)。
   * 可选 → 存量行 / 待选占位 meta(makeTitleMeta)无此字段,向后兼容不崩;选定后由 applySelection / submitBatch 填。
   */
  qualityLabel?: string
  /**
   * 字幕选择(langs 非空才下载,v0.2 Task 1 · spec §4.2)。
   * 可选 → 存量行 / 待选占位 meta 无此字段,向后兼容不崩;`applySelection` / `submitBatch` 有选择时写,
   * `rebuildVideoSubmit` 读回重建下载参数;`toYtdlpSubtitleArgs(undefined)` → `[]`,旧任务恢复零回归。
   */
  subtitle?: SubtitleChoice
  /**
   * 选中 / 归一 format 是否为分片协议(HLS/DASH;v0.3 Task 4 · #24 · spec §2)。加性可选、零回归:
   * `buildVideoPlan` 据选中 / 最高 format 的 protocol 判定(`isFragmentedProtocol`),仅确认分片才存 `true`;
   * `rebuildVideoSubmit` 读回透传 `VideoSubmit.fragmented` → VideoEngine `useAccel &&= !fragmented`(不挂 aria2c)。
   * 缺字段 / 旧任务 → undefined(保守挂 aria2c + 回退,§7.1 不退化)。
   */
  fragmented?: boolean
}

/**
 * 视频解析与提交类型(Task 5 · spec §2.3 / §3.3 / §4.3)。
 * `ResolveResult` 为 VideoResolver 解析产物(瞬时,不落库);`FormatChoice` / `VideoSubmit`
 * 承载格式选择 → yt-dlp `-f` 选择器;`BatchPick` 用于播放列表批量提交(§7.3)。
 */

/** yt-dlp 单条可选格式(由 `-J` formats 映射,缺字段填 null,不抛) */
export interface ResolvedFormat {
  formatId: string
  ext: string
  height: number | null
  fps: number | null
  vcodec: string | null
  acodec: string | null
  filesize: number | null
  tbr: number | null
  formatNote: string | null
  /**
   * 传输协议(yt-dlp `format.protocol`;v0.3 Task 4 · #24 · spec §2)。加性可选、零回归:
   * `https` / `http` = progressive,`m3u8` / `http_dash_segments` 等 = HLS/DASH 分片。供 `isFragmentedProtocol`
   * 判定是否挂 aria2c;缺字段 / 旧解析 → undefined / null(保守挂 aria2c + 回退,§7.1 不退化)。
   */
  protocol?: string | null
}

/** 单视频解析结果(含完整可选格式列表) */
export interface ResolvedVideo {
  kind: 'video'
  id: string
  title: string
  durationSec: number | null
  thumbnail: string | null
  extractor: string
  webpageUrl: string
  formats: ResolvedFormat[]
  /** 可用字幕轨(解析回填,v0.2 Task 1 · spec §3.1;无字幕字段 → 空数组兜底,必填不为 undefined) */
  subtitles: SubtitleTrack[]
}

/** 播放列表单条目(`--flat-playlist` 下只列条目,不逐条解析格式) */
export interface ResolvedPlaylistEntry {
  id: string
  title: string
  url: string
  durationSec: number | null
}

/** 播放列表解析结果 */
export interface ResolvedPlaylist {
  kind: 'playlist'
  title: string
  entries: ResolvedPlaylistEntry[]
}

/** VideoResolver.resolve 产物:单视频或播放列表 */
export type ResolveResult = ResolvedVideo | ResolvedPlaylist

/** 用户 / 自动的格式选择意图(单视频 formatId 或批量 heightCap) */
export interface FormatChoice {
  audioOnly: boolean
  formatId?: string
  heightCap?: number
  /** 字幕选择(可选,v0.2 Task 1 · spec §4.3;buildFormatSelector 透传至 VideoSubmit.subtitles) */
  subtitles?: SubtitleChoice
}

/** 经 buildFormatSelector 推导、供 yt-dlp 下载的提交参数 */
export interface VideoSubmit {
  formatSelector: string
  audioOnly: boolean
  mergeFormat?: string
  /** 字幕选择(可选,v0.2 Task 1 · spec §4.3;rebuildVideoSubmit / buildFormatSelector 透传,buildYtDlpDownloadArgs 追加) */
  subtitles?: SubtitleChoice
  /**
   * 选中 format 是否分片协议(HLS/DASH;v0.3 Task 4 · #24 · spec §2)。VideoEngine 据此
   * `useAccel &&= !fragmented`:分片 → 不挂 aria2c(改自带下载器 + --concurrent-fragments)。
   * undefined / false → 保守挂 aria2c + 回退(§7.1 不退化,与 v0.1 逐字节等价)。
   */
  fragmented?: boolean
}

/**
 * 播放列表批量勾选项(指向 ResolvedPlaylist.entries 序号 + 该条采用的格式选择,§7.3)。
 *
 * `choice` 由批量对话框的「统一清晰度策略 + 仅音频开关」推导(当前批量统一,故各 pick 同值);
 * 经 `buildFormatSelector` 推导为 yt-dlp `-f` 选择器,**不逐条解析格式**(yt-dlp 下载时自选)。
 * 携带在 pick 内(而非独立 policy 参数),使 `submitBatch(parentId, picks)` 签名稳定且天然支持未来逐条策略。
 */
export interface BatchPick {
  entryIndex: number
  choice: FormatChoice
}

/**
 * 默认清晰度偏好(占位,spec §6.5)。本 Task 仅读占位默认 `{ null, false }`(= 每次询问);
 * 真实设置项 + 持久化归 Task 8。设 `defaultHeight` → 解析后自动按 heightCap 选并跳过对话框;
 * `defaultAudioOnly` → 自动按「仅音频 MP3」提交。
 */
export interface VideoPrefs {
  defaultHeight: number | null
  defaultAudioOnly: boolean
  /** Cookie 来源默认(可选,v0.2 Task 1 · spec §4.4;缺省 DEFAULT_COOKIE_CONFIG,旧文件零迁移补全) */
  cookie?: CookieConfig
  /** 默认字幕偏好(可选,v0.2 Task 1 · spec §4.4;缺省 DEFAULT_SUBTITLE_CHOICE,旧文件零迁移补全) */
  subtitle?: SubtitleChoice
}

/**
 * 通用应用设置(Task 8 · 持久化 `<userData>/config/settings.json`;主 / 渲染共用单一来源,spec §3.2)。
 * 收纳此前未持久化(themeMode)或硬编码(maxConcurrent / defaultDir)/ 占位(video)的四项标量配置。
 */
export interface AppSettings {
  /** 默认下载目录;空串 = 运行时回落系统 downloads(SettingsService 首启解析为绝对路径) */
  defaultDir: string
  /** 最大同时下载数,整数 [1,10](原型滑块区间) */
  maxConcurrent: number
  /** 全局下载限速 KB/s;`0` = 不限速(v0.2 Task 2 · spec §2.1;clampSpeedLimit 归一 [0,1048576]) */
  maxOverallLimitKBps: number
  /** yt-dlp 挂内置 aria2c 分片加速开关;默认开,不可用时运行时自动回退默认下载器(v0.2 Task 2 · spec §3.4) */
  useAria2cForVideo: boolean
  /** 视频默认偏好(复用既有 VideoPrefs) */
  video: VideoPrefs
  /** 主题三档(复用既有 ThemeMode) */
  themeMode: ThemeMode
  /**
   * 剪贴板监控开关;**默认关**(隐私诚实,v0.2 Task 4 · spec §6.1 / §6.2)。
   * 开启后应用运行时轮询剪贴板文本、识别可下载链接;内容仅本机识别,不上传 / 不落库 / 不写日志(§6.4)。
   */
  clipboardWatch: boolean
  /**
   * Cookie 第四档「从扩展获取」的**首次说明已确认**标记(v0.4 Task 6 · spec §6.4 / plan Phase 4)。
   *
   * ★ **可选、且刻意不进 `DEFAULT_APP_SETTINGS`** —— 缺省即「未确认」,旧 `settings.json` 读进来
   *   没有这个键 → `undefined` → falsy → 首次切档照样弹说明。**零迁移代码、零默认回写**
   *   (与 `VideoPrefs.cookie?` / `VideoPrefs.subtitle?` 同一手法)。
   * ⚠️ 它记的是**「用户看过那段说明」这一事实**,不是任何 cookie 内容 —— 红线 R2「不写 settings」
   *   约束的是**登录态本身**;`CookieConfig` 仍一个字段都没加。
   */
  cookieExtensionNoticeAcked?: boolean
  /**
   * 自动检查 + 应用 yt-dlp 热更新;**默认开**(v0.2 Task 6 · spec §2.5 / §4.1)。
   * yt-dlp 更新是非破坏性 drop-in(单 exe、SHA256 + 可执行性验证、原子替换、失败保留旧版、
   * 不需重启、运行中任务不受影响),自动保持新鲜收益 >> 风险;应用后必 toast 告知(非静默,§7.5)。
   */
  autoUpdateYtDlp: boolean
  /**
   * 自动检查应用本体更新;**默认开**(v0.2 Task 6 · spec §3.4 / §4.1)。
   * 仅自动「检查」并提示;下载 / 安装始终需用户点击确认(不静默强制更新,#8 / §4.4)。
   */
  autoUpdateApp: boolean
  /**
   * BT 做种总开关;**默认关**(下载完即停止上传,PRD §4.4 / §7 诚实,v0.3 Task 3 · spec §2)。
   * 关 = `seed-time=0` 下载完即停(逐字节等价现状);开 = 经 aria2 原生 `seed-ratio` / `seed-time` 做种。
   */
  btSeedEnabled: boolean
  /** 做种分享率(上传量/下载量达此比率即停);`0` = 不按分享率停;clamp [0,100] 保留小数(v0.3 Task 3 · spec §2 / §5) */
  btSeedRatio: number
  /** 做种时长上限(分钟,达此时长即停);`0` = 不按时间停;clamp 整数 [0,10080](7 天)(v0.3 Task 3 · spec §2 / §5) */
  btSeedTimeMin: number
  /** 单 BT 任务最大 peer 连接数;`0` = 跟随 aria2 全局默认(128,不下发覆盖);clamp 整数 [0,512](v0.3 Task 3 · spec §2 / §5) */
  btMaxPeers: number
  /**
   * 自动更新 tracker 列表;**默认开**(v0.4 Task 1 · spec §5.2)。
   * 添加 BT 任务时按需拉取公开 tracker 列表(距上次成功 ≥ 12h 才拉,非 BT 用户零外联);
   * **不读用户数据、不上传任何内容**,拉取失败继续用内置表。关 = 整条链路不启动(零外联)。
   */
  btAutoUpdateTrackers: boolean
}

/**
 * 设置补丁(v0.3 Task 4 · 审计#10):顶层字段全可选,**`video` 允许只带被改的子字段**。
 *
 * 主进程 `mergeVideoPrefs` 本就是 `if ('field' in o)` 逐字段合并(运行时早已支持部分 patch),
 * 此类型只是把该能力如实反映到类型层——渲染侧连点两个 video 控件时各发单键补丁、互不覆盖
 * (整包 spread 会带着 stale 兄弟字段回退前一次改动)。`Partial<AppSettings>` 是本类型的子类型,
 * 既有调用点零改动仍可编译。**纯类型扩展,零运行时行为变化。**
 */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'video'>> & { video?: Partial<VideoPrefs> }

/** 默认设置:与现 index.ts 硬编码 / videoPrefs.ts 占位 / 主题默认档保持一致(spec §3.2) */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultDir: '',
  maxConcurrent: 3,
  maxOverallLimitKBps: 0, // 默认不限速(与 v0.1 行为逐字节等价)
  useAria2cForVideo: true, // 默认开(可用则加速、不可用运行时回退)
  video: {
    defaultHeight: null,
    defaultAudioOnly: false,
    cookie: DEFAULT_COOKIE_CONFIG,
    subtitle: DEFAULT_SUBTITLE_CHOICE
  },
  themeMode: 'system',
  clipboardWatch: false, // 默认关:用户显式开启前绝不读剪贴板(隐私诚实,spec §6.2)
  autoUpdateYtDlp: true, // 默认开:非破坏性 drop-in,应用后 toast 告知(v0.2 Task 6 · §2.5)
  autoUpdateApp: true, // 默认开:仅自动检查 + 提示,下载 / 安装需用户确认(v0.2 Task 6 · §3.4)
  btSeedEnabled: false, // 默认关:下载完即停做种(PRD §4.4 / §7 诚实,v0.3 Task 3 · spec §2)
  btSeedRatio: 1.0, // 开档默认分享率 1.0(上传量 = 下载量即停)
  btSeedTimeMin: 60, // 开档默认做种 60 分钟
  btMaxPeers: 0, // 0 = 跟随 aria2 全局默认(128)
  btAutoUpdateTrackers: true // 默认开:添加 BT 任务时按需拉取(12h 节流),失败退内置表(v0.4 Task 1 · spec §5.2)
}

/**
 * 引擎版本(关于分组,spec §3.2 / §4.5)。
 * MVP 为静态内置常量(随安装包分发的已知版本);真实 `--version` 探测留 Task 9。
 */
export interface EngineVersions {
  aria2: string
  ytdlp: string
  ffmpeg: string
}

export interface Task {
  id: string
  kind: 'http' | 'video' | 'torrent'
  source: string
  status: TaskStatus
  filename: string
  savePath: string
  category: string | null
  totalBytes: number
  downloadedBytes: number
  speed: number
  videoMeta: VideoMeta | null
  /**
   * BT 种子元信息(v0.3 Task 1 · spec §2.3;落 `tasks.torrentMeta` JSON 列):
   * torrent 任务元数据完成时写入 name / infoHash / files;http / video 任务恒 null。
   */
  torrentMeta: TorrentMeta | null
  error: string | null
  /**
   * 单任务限速 KB/s(v0.2 Task 2 · spec §2.3;运行时内存态**不落库**):undefined = 跟随全局,
   * 0 = 本任务不限速(覆盖全局),>0 = 限速值。重启即清 = 恢复全局;供限速 popover 回显当前值。
   */
  limitKBps?: number
  /**
   * 接管来源的请求头(v0.4 Task 4;运行时内存态**不落库**):只可能含 `Referer` / `User-Agent`
   * 两个键(白名单过滤后)。undefined = 不下发任何头。
   * 重启即清 = 回落无头,与 `limitKBps` 同构 —— 这是设计而非缺陷(CONTEXT.md「运行时态」)。
   *
   * ⚠️ 但**后果的量级与 `limitKBps` 不同**:限速回落只是慢一点,referer 丢失可能让强校验站点
   * 直接 403。属**有界遗留**(spec §6.2 末):影响仅限「重启后恢复」×「站点强校验 referer」
   * 同时成立,此时走既有错误映射、失败可见可重试,**不静默**;用户在浏览器里重新点一次下载即可。
   */
  headers?: Record<string, string>
  /**
   * BT 富进度运行时内存态(v0.3 Task 3 · spec §4;由 TaskProgress 合并进内存 task,**不落库**,仿 limitKBps?):
   * `seeding` = 做种中、`uploadSpeed` = 上行 B/s、`uploadLength` = 累计上传字节(算分享率)、
   * `numSeeders` = 做种节点数、`connections` = 连接数(peers)。
   * 仅 torrent 帧携带(seeding/uploadSpeed/uploadLength/numSeeders);connections 对所有任务透传。重启即清。
   */
  seeding?: boolean
  uploadSpeed?: number
  uploadLength?: number
  numSeeders?: number
  connections?: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface AddTaskInput {
  kind: 'http' | 'video' | 'torrent'
  source: string
  filename?: string
  dir?: string
  /**
   * 接管来源的请求头(v0.4 Task 4;**运行时内存态,不落库**):只可能含 `Referer` / `User-Agent`
   * 两个键(`TAKEOVER_HEADER_ALLOWLIST` 白名单过滤后)。undefined = 不下发任何头。
   * 调用方**不必**自己过滤 —— `addTask` 内恒过 `filterDownloadHeaders`(白名单第②层)。
   */
  headers?: Record<string, string>
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  category?: string
}

/**
 * 历史检索 / 统计类型(v0.2 Task 5 · spec §3.1 / §4.2)。
 * 历史查询**只读** `tasks` 表(真实下载历史源数据),绝不改写(ARCHITECTURE §7.3);
 * 时间口径(今日 / 本周一 / 本月初,本地时区)集中主进程纯函数 `historyTime.ts`,搜索与统计共用。
 */

/** 时间预设(基于 `createdAt`;custom 配合 from/to;spec §3.1) */
export type HistoryTimePreset = 'today' | 'week' | 'month' | 'custom'

/** 历史检索条件(全部可选,AND 组合;全空 = 最近 500 条;spec §3.1) */
export interface HistoryQuery {
  /** filename / source 子串搜索(LIKE %text%);空串 / undefined = 不搜 */
  text?: string
  /** 状态筛选(空数组 / undefined = 全部状态);复用 idx_tasks_status */
  status?: TaskStatus[]
  /** 类别筛选(单值;undefined = 全部);复用 idx_tasks_category */
  category?: string
  /** 时间预设(基于 createdAt);custom 配合 from/to */
  timePreset?: HistoryTimePreset
  /** 自定义时间下界 createdAt >=(ms,含);仅 timePreset==='custom' */
  from?: number
  /** 自定义时间上界 createdAt <=(ms,含);仅 timePreset==='custom' */
  to?: number
  /** 结果上限;主进程兜底 DEFAULT_HISTORY_LIMIT=500(防极端量一次性全渲染,§5.5) */
  limit?: number
}

/** 按类别统计单元(spec §4.2;count 降序) */
export interface CategoryHistoryStat {
  category: string
  count: number
  totalBytes: number
}

/** 时间窗口统计单元(spec §4.2) */
export interface HistoryWindowStat {
  count: number
  totalBytes: number
}

/** 历史统计聚合结果(**仅 completed** 计入,口径 completedAt;spec §4.1 / §4.2) */
export interface HistoryStats {
  total: HistoryWindowStat
  today: HistoryWindowStat
  week: HistoryWindowStat
  month: HistoryWindowStat
  /** 按类别聚合,count 降序 */
  byCategory: CategoryHistoryStat[]
}

export interface TaskProgress {
  /** 主进程校正的实际输出路径元信息;HTTP 每帧携带,渲染只合并。 */
  filename?: string
  savePath?: string
  category?: string | null
  id: string
  status: TaskStatus
  downloadedBytes: number
  totalBytes: number
  speed: number
  error?: string
  /** 单任务限速 KB/s 当前值(同 Task.limitKBps,随广播透传供 UI 回显;undefined = 跟随全局) */
  limitKBps?: number
  /**
   * BT 富进度透传(v0.3 Task 3 · spec §4;运行时瞬时、**不落库**,均可选仿 limitKBps?):
   * `connections`(peers)**对所有任务透传**;`numSeeders` / `uploadSpeed` / `uploadLength` / `seeding`
   * **仅 kind==='torrent' 透传**(http / video 帧不含 BT 字段);`seeding` true=做种中、false=下载中 / 已停做种。
   */
  connections?: number
  numSeeders?: number
  uploadSpeed?: number
  uploadLength?: number
  seeding?: boolean
}

/**
 * 检测重复下载(v0.2 Task 3 · spec §8)。**仅类型契约,非 SQLite schema 变更**;
 * 本 Phase 只加类型,IPC 通道(`task:duplicate` / `duplicate:resolve`)+ `DownLordApi`
 * 方法留 Phase 3(避免牵连 preload / App typecheck)。查重只读历史、覆盖走回收站(spec §7.3)。
 */

/** 重复检测决策(spec §4.1):覆盖(旧文件入回收站)/ 跳过 / 重命名加序号 / 已存在打开 */
export type DuplicateDecision = 'overwrite' | 'skip' | 'rename' | 'open'

/** 命中态(spec §3.3;决定「已存在」决策可用性 / 文案) */
export type DuplicateExisting = 'completed' | 'diskOnly' | 'active'

/** 单条冲突项(UI 展示 + 逐条决策) */
export interface DuplicateConflictItem {
  /** 批量逐条决策定位;单条 / http 为 0 */
  index: number
  filename: string
  /** 清晰度标签(视频;直链为 null) */
  qualityLabel: string | null
  /** 已存在文件所在目录(展示 + 打开文件夹) */
  existingDir: string
  /** 已存在真实文件绝对路径(completed / diskOnly 时有;active 为 null) */
  existingPath: string | null
  existing: DuplicateExisting
}

/** task:duplicate 事件载荷(M→R 主动推,spec §6.1) */
export interface DuplicateConflict {
  conflictId: string
  kind: 'http' | 'video' | 'batch'
  items: DuplicateConflictItem[]
}

/** duplicate:resolve 入参(R→M) */
export interface DuplicateResolution {
  conflictId: string
  /** 「应用到全部」的默认决策 */
  decision: DuplicateDecision
  /** 批量逐条覆盖(index → decision);缺省继承 decision */
  perItem?: Record<number, DuplicateDecision>
}

/**
 * 类别配置(跨进程,经 `category:list` 下发,spec §2.1 / §2.3 / §3.2)。
 * 下发完整字段:key + displayName 供渲染层 chips / 类型筛选;extensions + savePath 供设置页
 * (Task 8「分类与保存位置」分组显示 / 编辑目录)与链接识别加固(Step 6 `classifyLink` 按需取)。
 * chips / 筛选仍只读 key + displayName,新增两字段为增量,向后兼容。
 */
export interface CategoryConfig {
  key: string
  displayName: string
  /** 该类扩展名清单(设置页展示 / 编辑 + `classifyLink` 加固;小写、无 `.`) */
  extensions: string[]
  /** 解析后真实目录(`savePath || join(defaultDir, subdir)`;`other` → `defaultDir`);显示目录 === 路由目录(spec §1.7) */
  savePath: string
  /** 原始 DB `savePath` 是否非空(`true`=自定义 / `false`=跟随默认目录,设置页据此高亮 / 显示「重置为默认」) */
  isCustom: boolean
}

/**
 * 类别可配置字段的局部更新补丁(`category:update` 入参,spec §6.2 / §6.3)。
 * 仅含可改写字段(displayName / extensions / savePath);**不含主键 key、不增删类别**(spec §9)。
 * 跨进程契约单一来源:渲染层(Task 8 设置面板)→ preload → 主进程 IPC handler → categoryDao.updateCategory。
 */
export interface CategoryPatch {
  displayName?: string
  extensions?: string[]
  savePath?: string
}

/**
 * 代理三档配置与派生态(Task 7 · spec §2.2 / §2.4 / §5.1,单一来源,主 / 渲染共用)。
 *
 * `ProxyConfig` 为持久化态(落 `<userData>/config/proxy.json`);`ProxyResolved` / `ProxyStatus`
 * 为运行时派生态(不落盘):前者供引擎注入回调即时取「最终传引擎的地址」,后者供状态栏诚实显示。
 * 代理 IPC 通道见下方 `IpcChannel.Proxy*`(Phase 3 加);API 见 `DownLordApi`(handler / preload 实现留 Step 5)。
 */

/** 代理档位:跟随系统 / 手动指定 / 不使用(直连)(spec §2.1) */
export type ProxyMode = 'system' | 'manual' | 'direct'

/** 持久化的代理配置;`manualUrl` 仅 `mode==='manual'` 有意义,其它档为 null(spec §2.2) */
export interface ProxyConfig {
  mode: ProxyMode
  manualUrl: string | null
}

/** 默认配置:跟随系统代理(spec §2.1 默认档) */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = { mode: 'system', manualUrl: null }

/**
 * 运行时解析态(派生,不持久化,spec §2.4)。
 * `effectiveUrl` = 最终传引擎的地址;**null = 直连**(引擎侧产出显式空串关闭代理,不省略参数)。
 * `systemDetected` = `mode==='system'` 时实际读到的系统代理(供状态栏诚实显示),其它档为 null。
 */
export interface ProxyResolved {
  mode: ProxyMode
  effectiveUrl: string | null
  systemDetected: string | null
}

/**
 * 代理状态指示(派生,状态栏用,spec §5.1)。
 * `label` 文案诚实——「已连接」仅指到代理端口本身连通,不承诺墙外可达;
 * `dot` 圆点色:ok=success / warn=warning / off=中性。
 */
export interface ProxyStatus {
  mode: ProxyMode
  label: string
  dot: 'ok' | 'warn' | 'off'
  effectiveUrl: string | null
}

/**
 * 剪贴板检测到的可下载链接(`clipboard:linkDetected` 载荷,M→R;v0.2 Task 4 · spec §7.1)。
 * 仅 `video`(已知视频站)/ `http`(已知直链扩展名)两类会广播;`ambiguous` / 非 URL 不弹(§4.2)。
 */
export interface ClipboardLink {
  url: string
  kind: 'video' | 'http'
}

/**
 * 自动更新目标(v0.2 Task 6 · spec §4.2)。
 * `ytdlp` = yt-dlp 组件独立热更新(§2 / §7.5);`app` = 应用本体自更新(§3 / electron-updater)。
 */
export type UpdateTarget = 'ytdlp' | 'app'

/**
 * 更新流程阶段(派生 / 瞬时,不落 settings;v0.2 Task 6 · spec §4.2)。
 * - `idle` 空闲 / `checking` 检查中 / `up-to-date` 已最新 / `available` 有新版
 * - `downloading` 下载中(带 percent)/ `verifying` 校验中 / `ready` 已下载待安装(应用侧)
 * - `applied` 已应用(yt-dlp 空闲即时替换)/ `pending-restart` 已就绪下次启动生效(占用降级)
 * - `error` 失败(保留旧版,带可读错误)
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'applied'
  | 'pending-restart'
  | 'error'

/** 检查结果(invoke 返回,v0.2 Task 6 · spec §4.2) */
export interface UpdateCheckResult {
  target: UpdateTarget
  currentVersion: string
  /** 查不到 / 出错为 null(诚实,不假装可达) */
  latestVersion: string | null
  hasUpdate: boolean
  /** 可读错误(检查失败;诚实展示,不糊原始栈) */
  error?: string
}

/** 进度 / 状态广播(M→R;v0.2 Task 6 · spec §4.2 / §5.3) */
export interface UpdateStatus {
  target: UpdateTarget
  phase: UpdatePhase
  /** downloading 时 0–100 */
  percent?: number
  currentVersion?: string
  latestVersion?: string
  /** 诚实文案(pending-restart / applied 等) */
  message?: string
  /** 可读错误 */
  error?: string
}

/**
 * tracker 表更新状态(v0.4 Task 1 · spec §5.3)。
 * `never` 从未成功拉取(用内置表)/ `ok` 有生效表 / `failed` 上次拉取失败 / `disabled` 自动更新开关关闭。
 */
export type BtTrackerState = 'never' | 'ok' | 'failed' | 'disabled'

/**
 * tracker 表状态快照(invoke 返回 + M→R 广播;v0.4 Task 1 · spec §5.3)。
 * 全部判定(生效表口径 / `usingBuiltin` / 节流 / 失败原因)在主进程算好,渲染层只渲染文字(§7.2)。
 */
export interface BtTrackerStatus {
  state: BtTrackerState
  /** 上次**成功**拉取并落盘的时间戳(0 = 从未) */
  updatedAt: number
  /** **生效表**条数(缓存表非空取缓存表,否则取内置表;CONTEXT.md tracker 表三态) */
  count: number
  /** true = 当前用内置 47 条 */
  usingBuiltin: boolean
  /** 诚实的短原因(非堆栈),如「网络不可达」「远端列表条目过少」;成功但有保留时也非空 */
  lastError: string | null
  /** 正在拉取(UI 按钮 disabled) */
  busy: boolean
}

/**
 * 入站可达的单条独立证据(v0.4 Task 1 · spec §3.1)。
 *
 * v0.4 只有 `publicIPv6` 一条;v0.5 接 UPnP 即在 `id` 联合类型加 `'upnpMapping'` 并 push 第二条 ——
 * 汇总规则 `summarizeInbound` 对因子条数**无任何假设**,新因子接上即自动参与判定(spec §3.5 接缝)。
 */
export interface InboundFactor {
  /** 证据种类(v0.5 追加 `| 'upnpMapping'`) */
  id: 'publicIPv6'
  /** UI 短语,如「公网 IPv6」 */
  label: string
  /** 支持可达 / 不支持 / 无法判断(读不到 ≠ 没有,一律 `unknown`,不猜) */
  verdict: 'supports' | 'against' | 'unknown'
  /** 一句诚实说明(**只陈述事实,不承诺打通**;CONTEXT.md「入站可达」) */
  detail: string
}

/** 入站可达三态(v0.4 Task 1 · spec §3.1);DownLord **只检测与如实呈现,不承诺打通** */
export type InboundReachability = 'likely' | 'unlikely' | 'unknown'

/**
 * 入站可达自检结果(invoke 返回 + M→R 广播;v0.4 Task 1 · spec §3.1)。
 * **每次被问都实算、不缓存**(换网自动重算的地基,§3.4);UI 渲染 `factors` 数组,**不硬编码条数**。
 */
export interface InboundDiagnosis {
  state: InboundReachability
  factors: InboundFactor[]
  /** 本次实算的时间戳(注入时钟给值) */
  checkedAt: number
}

/**
 * 本地通道的持久化配置(落 `<userData>/config/extensionChannel.json`;v0.4 Task 3 · spec §5.3)。
 *
 * ⚠️ **只有这三个键,一个都不许多** —— 连接状态(`lastActiveAt` / 服务态 / 三态)是**运行时态**、
 * 故意不落库(CONTEXT.md「运行时态」),重启回落「未配对」是设计而非缺陷。有单测断言键集合。
 */
export interface ExtensionChannelConfig {
  /** 默认 `false` —— 本地通道是可选功能,不装扩展的用户不该白开一个监听端口(spec §5.1) */
  enabled: boolean
  /** 默认 52330;被占则**不顺延不扫描**,如实报 `port_in_use`(spec §5.2) */
  port: number
  /** 64 位小写 hex 配对码;缺失 / 非法时 `init()` 当场生成并写回(spec §3.2) */
  token: string
}

/** 本地通道默认配置(服务默认关) */
export const DEFAULT_EXTENSION_CHANNEL_CONFIG: ExtensionChannelConfig = {
  enabled: false,
  port: 52330,
  token: ''
}

/**
 * `extension:setChannelConfig` 的入参(v0.4 Task 3 · spec §3.2)。
 * **刻意不含 `token`** —— 渲染层不该有能力写入任意密钥,重新生成走专用通道。
 */
export interface ExtensionChannelConfigPatch {
  enabled: boolean
  port: number
}

/** 通道服务三态(第一行状态;v0.4 Task 3 · spec §5.2)。`port_in_use` 之外的 listen 失败归 `stopped` + `lastError` */
export type ChannelServiceState = 'listening' | 'port_in_use' | 'stopped'

/**
 * 扩展连接三态(第二行状态;v0.4 Task 3 · spec §5.3)。
 * 第三态对外文案是「**待活动**」,**绝不写「断开」** —— 握手是事件驱动、无心跳,
 * 分不清「扩展挂了」与「用户一天没下载」,分不清就不假装分得清(CONTEXT.md「待活动」)。
 */
export type ExtensionLinkState = 'unpaired' | 'connected' | 'idle_pending'

/**
 * 本地通道状态(invoke 返回 + M→R 广播;v0.4 Task 3 · spec §5.2 / §5.3)。
 *
 * **两行不合并**:「端口绑上了」与「扩展连上了」是两件独立的事,
 * 「端口绑成功但没装扩展」完全正常,合并成一行必然要么谎报要么含糊。
 */
export interface ExtensionChannelStatus {
  /** 用户开关(= 配置里的 `enabled`,供 UI 回显) */
  enabled: boolean
  /** 第一行:服务状态 */
  service: ChannelServiceState
  /** 当前配置端口(未监听时也回,供「端口 N 被占用」文案) */
  port: number
  /**
   * 真实失败原因码(如 `'EADDRINUSE'` / `'EACCES'` / `'invalid_port:reserved_bt'`),无错为 `null`。
   * 存在的理由是**诚实**:罕见 listen 失败不许被「已关闭」掩盖,同时避免为它造第四态。
   */
  lastError: string | null
  /** 第二行:扩展连接三态 */
  link: ExtensionLinkState
  /**
   * 最近一次**成功且已鉴权**的通道请求时间(内部实现名 `lastActiveAt`,与本字段是同一件事)。
   * **只在内存**,重启回落 `null`(spec §5.3)。
   */
  lastHandshakeAt: number | null
}

/** 扩展目录事实(#42 应用内发现入口;v0.4 Task 3 · spec §4.5) */
export interface ExtensionSideloadInfo {
  /** 扩展解包目录绝对路径(打包态 `<resources>/extension`;dev 态 `<项目根>/extension/dist`) */
  dir: string
  /** 该目录当下是否存在(**运行时实探**,不缓存 —— 未构建扩展时如实显示「未找到」) */
  exists: boolean
}

/**
 * IPC 通道名常量(主 / 渲染共用)。
 * 每项注释标注「方式 · 方向 · 用途」,对应 spec §2.2 通道表。
 */
export const IpcChannel = {
  /** invoke/handle · R→M→R · 全链路验证锚点,返回 `app.getVersion()` */
  AppGetVersion: 'app:getVersion',
  /** invoke/handle · R→M→R · 无参数打开本地第三方声明,路径仅由主进程决定 */
  AppOpenThirdPartyNotices: 'app:openThirdPartyNotices',
  /** invoke/handle · R→M→R · 读取系统默认下载目录 */
  AppGetDownloadDir: 'app:getDownloadDir',
  /** send · R→M · 自定义标题栏最小化 */
  WindowMinimize: 'window:minimize',
  /** send · R→M · 最大化 / 还原 */
  WindowToggleMaximize: 'window:toggleMaximize',
  /** send · R→M · 关闭窗口 */
  WindowClose: 'window:close',
  /** invoke/handle · R→M→R · 设置主题模式,驱动 nativeTheme,返回生效主题 */
  ThemeSet: 'theme:set',
  /** send(主动推)· M→R · 系统主题变化时推送当前生效主题 */
  ThemeChanged: 'theme:changed',
  /** invoke/handle · R→M→R · 打开系统目录选择对话框 */
  DialogSelectDirectory: 'dialog:selectDirectory',
  /** invoke/handle · R→M→R · 打开系统文件选择对话框(Cookie=从文件选 cookies.txt;v0.2 Task1,handler / preload 实现留 Step 4) */
  DialogSelectFile: 'dialog:selectFile',
  /** invoke/handle · R→M→R · 用系统默认程序打开路径 */
  ShellOpenPath: 'shell:openPath',
  /** invoke/handle · R→M→R · 在文件管理器中显示路径 */
  ShellShowItemInFolder: 'shell:showItemInFolder',
  /** invoke/handle · R→M→R · 新增统一任务,返回内部任务 id */
  TASK_ADD,
  /** invoke/handle · R→M→R · 暂停指定任务 */
  TASK_PAUSE,
  /** invoke/handle · R→M→R · 恢复指定任务 */
  TASK_RESUME,
  /** invoke/handle · R→M→R · 删除指定任务 */
  TASK_REMOVE,
  /** invoke/handle · R→M→R · 重试失败任务 */
  TASK_RETRY,
  /** invoke/handle · R→M→R · 列出任务,支持状态 / 类别筛选 */
  TASK_LIST,
  /** send(主动推) · M→R · 统一任务进度事件广播 */
  TASK_PROGRESS,
  /** invoke/handle · R→M→R · 设单任务限速 KB/s */
  TaskSetLimit: 'task:setLimit',
  /** send(主动推)· M→R · 检测到重复广播冲突详情(v0.2 Task 3 · spec §8) */
  TaskDuplicate: 'task:duplicate',
  /** invoke/handle · R→M→R · 提交用户重复决策(v0.2 Task 3 · spec §8) */
  DuplicateResolve: 'duplicate:resolve',
  /** invoke/handle · R→M→R · 取视频瞬时解析结果(格式 / 批量对话框拉取) */
  VideoGetResolved: 'video:getResolved',
  /** invoke/handle · R→M→R · 选定格式(用户 / 自动)→ 入队下载 */
  VideoSelect: 'video:select',
  /** invoke/handle · R→M→R · 播放列表批量提交,展开 N 子任务 */
  VideoSubmitBatch: 'video:submitBatch',
  /**
   * invoke/handle · R→M→R · 提交 BT 文件选择(选中文件 1-based 索引集)→ 定型 + 出队下载
   * (v0.3 Task 2 · spec §8)。**本 Phase 仅加通道常量**;`DownLordApi.applyTorrentSelection` 方法 +
   * handler + preload 留 Step 3(纯转发,避免跨 Step typecheck 牵连)。
   */
  TorrentApplySelection: 'torrent:applySelection',
  /**
   * invoke/handle · R→M→R · 停止单任务做种(forcePause 保留文件 + `.aria2`;v0.3 Task 3 · spec §7)。
   * **本 Phase 仅加通道常量**;`DownLordApi.stopSeeding` + handler + preload 留 Step 3(纯转发,避免跨 Step typecheck 牵连)。
   */
  TorrentStopSeeding: 'torrent:stopSeeding',
  /** invoke/handle · R→M→R · 列类别完整配置(key/displayName/extensions/savePath)供 chips 渲染 + 设置页 */
  CategoryList: 'category:list',
  /** invoke/handle · R→M→R · 改单类配置(displayName/extensions/savePath)→ 写库 + 刷新缓存(UI 留 Task 8) */
  CategoryUpdate: 'category:update',
  /** invoke/handle · R→M→R · 读当前代理配置(设置面板回显当前档 / 手动地址,Task 7 §7.1) */
  ProxyGet: 'proxy:get',
  /** invoke/handle · R→M→R · 写代理配置(校验→落盘→system 重读→探测),返回 set 后即时 ProxyStatus */
  ProxySet: 'proxy:set',
  /** invoke/handle · R→M→R · 取当前代理状态(含一次代理端口 TCP 探测;direct 档不探测) */
  ProxyGetStatus: 'proxy:getStatus',
  /** send(主动推)· M→R · 系统代理重读 / set 后广播最新 ProxyStatus */
  ProxyStatusChanged: 'proxy:statusChanged',
  /** invoke/handle · R→M→R · 读全量应用设置(设置页挂载回显,Task 8 §3.3) */
  SettingsGet: 'settings:get',
  /** invoke/handle · R→M→R · 写设置补丁(校验→落盘→联动),返回 clamp 后最新全量 */
  SettingsSet: 'settings:set',
  /** invoke/handle · R→M→R · 取引擎内核版本(关于分组;MVP 静态常量) */
  AppGetEngineVersions: 'app:getEngineVersions',
  /** send(主动推)· M→R · 剪贴板检测到可下载链接广播(v0.2 Task 4 · spec §7.1) */
  ClipboardLinkDetected: 'clipboard:linkDetected',
  /** invoke/handle · R→M→R · 历史检索(filename/source LIKE + 状态/类别/时间过滤,只读;v0.2 Task 5 · spec §7.1) */
  HistorySearch: 'history:search',
  /** invoke/handle · R→M→R · 历史统计聚合(按类别 + 时间窗口,只读,仅 completed 计入;v0.2 Task 5 · spec §7.1) */
  HistoryStats: 'history:stats',
  /** invoke/handle · R→M→R · 手动检查 yt-dlp 更新(无视节流;v0.2 Task 6 · spec §4.2) */
  UpdateCheckYtDlp: 'update:checkYtDlp',
  /** invoke/handle · R→M→R · 执行 yt-dlp 更新(检查→下载→三重校验→替换 / pending;v0.2 Task 6 · spec §4.2) */
  UpdateRunYtDlp: 'update:runYtDlp',
  /** invoke/handle · R→M→R · 检查应用本体更新(不自动下载;v0.2 Task 6 · spec §4.2) */
  UpdateCheckApp: 'update:checkApp',
  /** invoke/handle · R→M→R · 下载应用更新(用户确认后触发;v0.2 Task 6 · spec §4.2) */
  UpdateDownloadApp: 'update:downloadApp',
  /** invoke/handle · R→M→R · 退出并安装已下载的应用更新(用户点「重启安装」;v0.2 Task 6 · spec §4.2) */
  UpdateQuitInstallApp: 'update:quitInstallApp',
  /** send(主动推)· M→R · 更新进度 / 阶段广播(yt-dlp / app 共用;v0.2 Task 6 · spec §4.2 / §5.3) */
  UpdateStatus: 'update:status',
  /** invoke/handle · R→M→R · 取 tracker 表更新状态(设置页挂载回显;v0.4 Task 1 · spec §5.3) */
  BtGetTrackerStatus: 'bt:getTrackerStatus',
  /** invoke/handle · R→M→R · 立即更新 tracker 表(**无视节流与开关**),返回本次结果供 toast(v0.4 Task 1 · spec §5.3) */
  BtUpdateTrackersNow: 'bt:updateTrackersNow',
  /** send(主动推)· M→R · 自动路径拉取完成后广播最新 BtTrackerStatus(**不弹 toast**;v0.4 Task 1 · spec §5.3) */
  BtTrackerStatusChanged: 'bt:trackerStatusChanged',
  /** invoke/handle · R→M→R · 取入站可达自检结果(**每次实算、不缓存**;v0.4 Task 1 · spec §3.4 / §5.3) */
  BtGetInboundDiagnosis: 'bt:getInboundDiagnosis',
  /** send(主动推)· M→R · 换网重算后广播入站诊断(**`state` 变了才发**;v0.4 Task 1 · spec §3.4 / §5.3) */
  BtInboundChanged: 'bt:inboundChanged',
  /** invoke/handle · R→M→R · 读本地通道配置 `{enabled,port,token}`(设置页回显 + 配对码展示;v0.4 Task 3 · spec §5) */
  ExtensionGetChannelConfig: 'extension:getChannelConfig',
  /**
   * invoke/handle · R→M→R · 写本地通道配置 `{enabled,port}` → 起停 / 重绑 → 回即时 `ExtensionChannelStatus`。
   * **刻意不接受 `token`**:渲染层不该有能力写入任意密钥(v0.4 Task 3 · spec §3.2)。
   */
  ExtensionSetChannelConfig: 'extension:setChannelConfig',
  /** invoke/handle · R→M→R · 重新生成配对码 → 落盘 + 清连接态 → 回新 `{enabled,port,token}`(旧配对当场失效;v0.4 Task 3 · spec §3.2) */
  ExtensionRegenerateToken: 'extension:regenerateToken',
  /** invoke/handle · R→M→R · 取当前两行状态(设置页挂载回显;v0.4 Task 3 · spec §5.2 / §5.3) */
  ExtensionGetChannelStatus: 'extension:getChannelStatus',
  /** invoke/handle · R→M→R · 取扩展目录 `{dir,exists}`(#42 发现引导;**运行时实探**;v0.4 Task 3 · spec §4.5) */
  ExtensionGetSideloadInfo: 'extension:getSideloadInfo',
  /** send(主动推)· M→R · 起停 / 重绑 / 握手 / 重新生成后广播最新 `ExtensionChannelStatus`(v0.4 Task 3 · spec §5) */
  ExtensionChannelStatusChanged: 'extension:channelStatusChanged',
  /**
   * send(主动推)· M→R · **定向**送接管小窗口:呈现一批待确认的下载(v0.4 Task 4 · spec §3.7)。
   * 与既有状态广播刻意不同 —— 这是**定向指令**,主窗口收到只会添乱,故 `win.webContents.send`
   * 直投,不经 `getAllWindows()` 遍历。
   */
  TakeoverPresent: 'takeover:present',
  /** send(主动推)· M→R · **定向**送接管小窗口:接管路径自己那条查重冲突(v0.4 Task 4 · spec §3.7) */
  TakeoverDuplicate: 'takeover:duplicate',
  /**
   * send · R→M · 接管小窗口渲染层挂载完成,主动拉取当前批(v0.4 Task 4 · spec §3.6)。
   * ★ 握手方向刻意是「渲染层就绪后来拉」而非「主进程先推」—— 先推会早于挂载、载荷掉进虚空。
   */
  TakeoverReady: 'takeover:ready',
  /** send · R→M · 用户点「开始下载」:提交保留条目 + 落点(v0.4 Task 4 · spec §4.1) */
  TakeoverSubmit: 'takeover:submit',
  /** send · R→M · 用户点「取消」/ `Esc` / `×`:放弃当前批(**不是黑洞,是用户知情的放弃**) */
  TakeoverDismiss: 'takeover:dismiss',
  /**
   * send · R→M · 当前批的查重**已全部决策完**(态 C 的串行队列清空;v0.4 Task 4 · spec §4.3)。
   *
   * ★ 为什么由渲染层报:四决策经**既有** `duplicate:resolve` 通道直达 `TaskManager`
   *   (那七条复用通道主进程侧一行都不改),`takeoverService` 看不到回执;
   *   渲染层的串行队列才是「还剩几条没点」的唯一真源。收到才推进下一批 / 关窗 ——
   *   **点完四决策才关窗**(Step 0 第 6 条)。
   */
  TakeoverSettled: 'takeover:settled',
  /**
   * invoke/handle · R→M→R · 读接管配置快照(设置页「下载接管」子区回显;v0.4 Task 4 · spec §5.5)。
   *
   * ⚠️ 比 popup 走通道拿的 `TakeoverConfigView` **多一个 `excludedDomains`** —— 域名例外表的编辑
   *   **只在设置页一处**(README 第 6 条:嗅探页不重复造),popup 只是暂停的遥控器,拿不到也不需要。
   */
  TakeoverGetConfig: 'takeover:getConfig',
  /**
   * invoke/handle · R→M→R · 写接管配置(总开关 / 域名例外表)→ 落盘 + 广播 → 回写后快照。
   *
   * ⚠️ **刻意不接受 `pausedUntil`**:暂停是「设一个时长档」而不是「填一个时刻」,走独立的
   *   `takeover:setPause`(与 `extension:setChannelConfig` 不收 `token` 同一手法 —— 形状里没有的
   *   东西,调用方连塞都塞不进来)。
   */
  TakeoverSetConfig: 'takeover:setConfig',
  /** invoke/handle · R→M→R · 设暂停时长档(`minutes: null` = 立即恢复接管)→ 回写后快照(v0.4 Task 4 · spec §5.2) */
  TakeoverSetPause: 'takeover:setPause',
  /**
   * send(主动推)· M→R · 接管配置变更后广播最新快照(v0.4 Task 4 · spec §5.5)。
   *
   * 为什么需要它:暂停的**唯一真源在主进程**,而写方向有两个入口(设置页 / popup 遥控器)。
   * popup 把暂停设上时,开着的设置页必须跟上 —— 否则它显示的是「最近一次自己写的值」,
   * 正是 CONTEXT.md「临时暂停接管」警告的那种「只能显示最近一次听说的」。
   */
  TakeoverConfigChanged: 'takeover:configChanged',
  /**
   * send(主动推)· M→R · **主进程侧新建了任务,请重拉列表**(v0.4 Task 4 Step 4 · 2026-08-02 真机修复)。
   *
   * 为什么需要它:v0.4 之前任务**只可能由渲染层发起**(`task:add` invoke 之后渲染层自己 refresh),
   * 接管是第一条**主进程侧发起**的建任务路径。不广播的话主窗口对这个任务一无所知 ——
   * `TasksContext` 的 `progressMerge` 只合并**已在列表里**的任务,新任务的进度帧被整批丢弃,
   * 直到「完成帧触发全量重拉」才突然冒出一条**已下完**的记录(2026-08-02 真机现象逐字如此)。
   *
   * 载荷刻意为空:它只说「有变化,去问真源」,不带任何可能与库不一致的快照。
   */
  TaskAdded: 'task:added',
  /**
   * invoke/handle · R→M→R · 取当前暂借登录态的**域列表**(v0.4 Task 6 · spec §6.4)。
   *
   * 🔴 **载荷里没有任何能装 cookie 值的位置** —— 「渲染层看不到值」是靠**接口形状**保证的
   * (与 Task 5 的 U-34 同一手法)。不许为「将来可能有用」加字段。
   */
  CookieGetBorrowedHosts: 'cookie:getBorrowedHosts',
  /** invoke/handle · R→M→R · 清空持有层 → 回**写后快照**(恒 `{hosts:[]}`,渲染层就地更新不再回读) */
  CookieClearBorrowed: 'cookie:clearBorrowed',
  /**
   * send(主动推)· M→R · 持有层变更后广播最新域列表(v0.4 Task 6 · spec §6.4)。
   *
   * 为什么需要它:offer 到达的时刻**由用户在浏览器里的动作决定**,设置页正开着时那一行必须
   * 当场更新 —— 否则它显示的是「打开设置页那一刻的快照」。
   */
  CookieBorrowedChanged: 'cookie:borrowedChanged'
} as const

/** 全部通道名的字面量联合类型 */
export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]

// ── 接管确认小窗口(v0.4 Task 4 · spec §3.4 / §3.6)──────────────────────────

/**
 * 接管小窗口的**窗口标记**:主进程建窗时经 `webPreferences.additionalArguments` 下发,
 * preload 读 `process.argv.includes(...)` 判断自己被加载进了哪个窗口(spec §3.6)。
 *
 * ★ 放在 shared 是为了**单一真源** —— 主进程写入与 preload 读取必须逐字一致,
 *   两边各写一遍字面量迟早会漂。
 */
export const TAKEOVER_WINDOW_ARG = '--downlord-takeover'

/**
 * 呈现给确认框的一条下载意图 —— **主进程已归一、已推断建议名、已解析 host**。
 *
 * ⚠️ 渲染层拿到的是**结论,不是原料**:host 由主进程 `new URL(url).host` 解析后下发
 * (不下发完整 URL 让渲染层去切);建议名由主进程 `filenameFromUrl` 推断(§7.2 决策留主进程)。
 */
export interface TakeoverItem {
  /** 批次内唯一 id:逐条移除 / 提交对账全按它,**不用 url 当键**(同一 URL 可能连点两次) */
  id: string
  /** 原始下载地址。**只读、不在框内展示** —— 一行放不下带签名的长 URL,截断反而误导(spec §4.1) */
  url: string
  /** 来源域名(`new URL(url).host`),确认框「来自 …」那一行 */
  host: string
  /** 建议文件名(主进程推断,用户可改)。空串时禁用「开始下载」 */
  filename: string
  /** 浏览器自报总字节;**`<= 0` = 未知,整个大小 `.pill` 不渲染**(不写「未知大小」这种噪音) */
  totalBytes: number
  /**
   * 这一条会建成哪种任务(v0.4 Task 5 · spec §4.6)。
   *
   * 确认框据此**诚实呈现**:`'video'` 的 `filename` / `savePath` 在 `addTask` 阶段都是占位、
   * 最终由 `applySelection` 按「标题 [清晰度].ext」重算 —— 让用户改一个不生效的名字是不诚实的,
   * 故 `'video'` 时把文件名输入框换成一行只读说明。**`'http'` 时逐字保持现状。**
   */
  kind: 'http' | 'video'
  /**
   * 这一条**将会用到**哪些域的暂借登录态(v0.4 Task 6;确认框「将使用 … 的登录态」那一行)。
   *
   * - **只有 host,没有任何 cookie 值** —— 红线 R3 由**接口形状**保证,不是靠纪律;
   * - 空 / 用不上时**不写该键**(`kind:'http'` 恒没有:直链走 aria2,不带登录态);
   * - 在**批次被拉取的那一刻**从持有层实读 —— cookie 是在受理之后、用户点确认之前才到的。
   */
  cookieHosts?: string[]
}

/** 一批(500ms 固定窗口聚合)。**`items.length === 1` → 态 A;`> 1` → 态 B,就这一条判据** */
export interface TakeoverBatch {
  items: TakeoverItem[]
  /**
   * 呈现这一批时**已解析**的主题(v0.4 Task 4 Step 4 补)。
   *
   * 小窗口刻意不挂 `ThemeProvider`(它只做一件事),故拿不到主窗口那条 `nativeTheme` 通路;
   * 主进程随批次把**结论**下发,渲染层只 `setAttribute('data-theme', theme)`。
   * 呈现期间用户改主题由 `takeoverApi.onThemeChanged`(复用既有 `theme:changed` 广播)跟上。
   */
  theme: ResolvedTheme
}

/** 用户点「开始下载」后回主进程的载荷 */
export interface TakeoverSubmitPayload {
  /** **保留下来**的条目(态 B 逐条 `×` 移除后的结果);`filename` 为用户可能改过的最终值 */
  items: { id: string; filename: string }[]
  /** 落点 sentinel:`pickedDir ?? defaultDir` —— 与既有 `AddTaskDialog` 逐字同一镜像,渲染层不自算落点 */
  dir: string
}

/**
 * 接管配置快照(设置页「下载接管」子区用;v0.4 Task 4 · spec §5.5)。
 *
 * ⚠️ 与扩展协议里 popup 用的 `TakeoverConfigView` **是两个类型,刻意不合并**:
 * 那个只有 `{enabled, pausedUntil, paused}` 三键,本类型多一个 `excludedDomains`。
 * 域名例外表是**本机配置**,没有理由经本地通道下发给扩展(通道对本机任意程序开放,
 * 最小暴露面靠**形状**保障,不靠约定)。
 */
export interface TakeoverSettingsView {
  /** 接管总开关 */
  enabled: boolean
  /** 暂停到期的**绝对时刻**(epoch ms);`null` = 未暂停 */
  pausedUntil: number | null
  /**
   * 服务端算好的「此刻是否暂停中」—— **免得渲染层再判一次时钟**。
   *
   * 与 `pausedUntil` 同时给,是因为两者答的是两个问题:`paused` 答「现在拦不拦」,
   * `pausedUntil` 答「还剩多久」(渲染层据它算剩余分钟与到期时刻文案)。
   */
  paused: boolean
  /** 域名例外表(已归一:小写、无协议 / 路径 / 端口、保序去重);空数组 = 不排除任何域 */
  excludedDomains: string[]
}

/**
 * 接管配置补丁(设置页写)。**刻意没有 `pausedUntil`** —— 暂停走 `takeover:setPause`,
 * 那里收的是**时长档**(分钟),绝对时刻由主进程现算,渲染层无从也无需构造。
 */
export interface TakeoverSettingsPatch {
  enabled?: boolean
  /** 整表替换(不是增量):渲染层持有完整表,增删都回传整表,免得两侧各维护一份合并逻辑 */
  excludedDomains?: string[]
}

/** 暂停时长档。`minutes: null` = 立即恢复接管;`15 / 60 / 240` 是设置页与 popup 共用的三档 */
export interface TakeoverPausePatch {
  minutes: number | null
}

/**
 * 接管小窗口经 `contextBridge` 拿到的 API 面(`window.takeoverApi`)。
 *
 * ★ **与 `DownLordApi` 是两个互不可见的对象**:preload 按窗口标记**只 expose 一个**(spec §3.6)。
 *   给一个「只该确认一次下载」的窗口发 `removeTask` / `settings:set` / `regenerateToken` 那 59 条
 *   钥匙是错的 —— 最小暴露面靠**分支**保障,不靠约定。
 *
 * 十二条里**七条复用既有 IPC 通道**(`resolveDuplicate` / `openPath` / `showItemInFolder` /
 * `selectDirectory` / `getSettings` / `listCategories` / `onThemeChanged`)—— `ipcMain.handle` 与
 * `theme:changed` 广播都是**全局注册、与窗口无关**,故这七条**主进程侧一行都不改**。
 */
export interface TakeoverApi {
  /**
   * 订阅「呈现这一批」推送,返回取消订阅函数。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onPresent(callback: (batch: TakeoverBatch) => void): () => void
  /**
   * 订阅**本窗口自己那条**查重冲突(主进程按 `ownedConflictIds` 过滤后定向下发)。
   * @returns 调用即移除监听。
   */
  onDuplicate(callback: (conflict: DuplicateConflict) => void): () => void
  /** 渲染层挂载完成 → 拉当前批(主进程收到才 `send('takeover:present')`,免得推早了掉进虚空) */
  ready(): void
  /** 提交:保留条目 + 落点。**fire-and-forget** —— 关窗时机由主进程的缓冲状态机决定,不靠回执 */
  submit(payload: TakeoverSubmitPayload): void
  /** 放弃当前批(取消 / `Esc` / `×`)。确认框已如实告知「浏览器那边已经取消」,故这是知情的放弃 */
  dismiss(): void
  /** 当前批的查重已全部决策完(态 C 队列清空)→ 主进程据此推进下一批 / 关窗 */
  duplicatesSettled(): void
  /** 提交查重四决策(**复用既有** `duplicate:resolve`,主进程零新增) */
  resolveDuplicate(res: DuplicateResolution): Promise<void>
  /** 用系统默认程序打开路径(**复用既有**;查重命中态的「已存在·打开」按钮靠它) */
  openPath(path: string): Promise<string>
  /** 在文件管理器中显示路径(**复用既有**) */
  showItemInFolder(path: string): Promise<string>
  /** 选择目录(**复用既有**;「浏览…」按钮) */
  selectDirectory(): Promise<string | null>
  /** 读全量设置(**复用既有**;算 `previewDir` 要 `defaultDir`) */
  getSettings(): Promise<AppSettings>
  /** 列类别配置(**复用既有**;算 `previewDir` 要 `categories`) */
  listCategories(): Promise<CategoryConfig[]>
  /**
   * 订阅主题变化(**复用既有** `theme:changed` 广播 —— 那条本就是发给所有窗口的状态广播,
   * 小窗口听它是天经地义,主进程一行都不改)。初始值随 `takeover:present` 的 `batch.theme` 到达。
   * @returns 调用即移除监听。
   */
  onThemeChanged(callback: (theme: ResolvedTheme) => void): () => void
}

/**
 * preload 经 `contextBridge` 暴露给渲染进程的最小 API 面。
 *
 * renderer 只依赖此接口,不感知通道名 / `ipcRenderer`;preload 实现此接口,
 * `src/preload/index.d.ts` 将其挂到全局 `Window.api` —— 定义、实现、消费三处类型同源。
 */
export interface DownLordApi {
  /** 全链路验证锚点:取主进程 `app` 版本号 */
  getVersion(): Promise<string>
  /** 打开本地第三方许可与声明(不接受路径 / URL);空串=成功,非空=可见错误 */
  openThirdPartyNotices(): Promise<string>
  /** 读取系统默认下载目录(添加任务对话框预填) */
  getDownloadDir(): Promise<string>
  /** 窗口最小化(外壳标题栏用,Step 5 联调) */
  minimize(): void
  /** 窗口最大化 / 还原(Step 5 联调) */
  toggleMaximize(): void
  /** 关闭窗口(Step 5 联调) */
  close(): void
  /** 设置主题模式,返回生效主题(Step 5 联调) */
  setTheme(mode: ThemeMode): Promise<ResolvedTheme>
  /**
   * 订阅系统主题变化推送,返回取消订阅函数(Step 5 联调)。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onThemeChanged(callback: (theme: ResolvedTheme) => void): () => void
  /** 选择目录,取消时返回 null */
  selectDirectory(): Promise<string | null>
  /**
   * 选择文件,取消 / 无选择时返回 null。可选 `options.filters` 指定文件类型过滤;
   * 缺省(未传 options)= Cookie=从文件的 `.txt` + 所有文件(v0.2 Task 1 零回归),
   * torrent 选种子时传 `.torrent` filter(v0.3 Task 1 · spec §10.4)。
   */
  selectFile(options?: {
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null>
  /** 用系统默认程序打开路径,返回 Electron shell.openPath 的错误串 */
  openPath(path: string): Promise<string>
  /** 在文件管理器中显示路径,返回可读错误串(空=成功;文件不存在时返回中文提示) */
  showItemInFolder(path: string): Promise<string>
  /** 新增统一任务(直链 / 视频),返回内部任务 id */
  addTask(input: AddTaskInput): Promise<string>
  /** 暂停指定任务 */
  pauseTask(id: string): Promise<void>
  /** 恢复指定任务 */
  resumeTask(id: string): Promise<void>
  /** 删除指定任务;`deleteFile=true`(completed)成品移回收站,缺省 false 仅移记录(向后兼容,§5) */
  removeTask(id: string, deleteFile?: boolean): Promise<void>
  /** 重试失败任务 */
  retryTask(id: string): Promise<void>
  /**
   * 设单任务限速 KB/s;aria2 直链即时生效、video 下次继续生效(§6.4)。
   * 三态(v0.3 Task 4 · #25 · spec §3):`null` = 清除任务级覆盖 = 跟随全局(内存回 `undefined`)/
   * `0` = 本任务不限速覆盖全局 / `>0` = 限速值。运行时态,**不落库**(重启即清 = 恢复全局)。
   */
  setTaskLimit(id: string, kbps: number | null): Promise<void>
  /** 列出任务,支持状态 / 类别筛选(内存 + DB 合并) */
  listTasks(filter?: TaskFilter): Promise<Task[]>
  /**
   * 订阅任务进度推送,返回取消订阅函数。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onTaskProgress(callback: (progress: TaskProgress) => void): () => void
  /**
   * 订阅重复检测推送,返回取消订阅函数(v0.2 Task 3 · spec §8;仿 onTaskProgress)。
   * 主进程三创建路径查重命中 → 广播 DuplicateConflict → 渲染层弹 DuplicateDialog(App 接线留 Phase 4)。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onTaskDuplicate(callback: (conflict: DuplicateConflict) => void): () => void
  /**
   * 订阅「主进程侧新建了任务」推送,收到即重拉列表(v0.4 Task 4 · 接管路径;仿 onTaskProgress)。
   * 载荷为空 —— 它只说「有变化,去问真源」。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onTaskAdded(callback: () => void): () => void
  /** 提交用户重复决策(覆盖 / 跳过 / 重命名 / 已存在;主进程按 decision 落地,v0.2 Task 3 · spec §8) */
  resolveDuplicate(res: DuplicateResolution): Promise<void>
  /** 取视频瞬时解析结果(格式 / 批量对话框拉取;未解析 / 已丢 → null) */
  getResolved(id: string): Promise<ResolveResult | null>
  /** 选定格式(用户 / 自动)→ 入队下载 */
  selectFormat(id: string, choice: FormatChoice): Promise<void>
  /** 播放列表批量提交,展开为 N 子任务 */
  submitBatch(parentId: string, picks: BatchPick[]): Promise<void>
  /**
   * 提交 BT 文件选择(选中文件 1-based 索引集)→ 主进程定型 `files[].selected` + 出队下载(v0.3 Task 2 · spec §8)。
   * 纯转发:校验(torrent / awaiting_selection / 非空)/ 定型 / `select-file` 映射 / 落点全在
   * 主进程 `TaskManager.applyTorrentSelection`(§4.2 / §7.2);渲染层零业务。
   */
  applyTorrentSelection(id: string, selectedIndices: number[]): Promise<void>
  /**
   * 停止单任务做种(forcePause 停上传、保留文件 + `.aria2`;v0.3 Task 3 · spec §7)。
   * 纯转发:校验(torrent + 做种中)/ 引擎 forcePause / 清 runtime / 广播 `{seeding:false}` 全在
   * 主进程 `TaskManager.stopSeeding`(§3 / §7.2);渲染层零业务。**只对「已 completed + 做种中」torrent 生效**。
   */
  stopSeeding(id: string): Promise<void>
  /** 列类别完整配置(key/displayName/extensions/savePath);chips 只读 key+displayName,extensions/savePath 供设置页(落实「一处定义」,spec §6.3) */
  listCategories(): Promise<CategoryConfig[]>
  /**
   * 改单类配置(displayName / extensions / savePath)→ 写库 + 刷新主进程缓存(后续任务用新配置,已存不回迁)。
   * 完整链路就位供 Task 8 设置面板直接接 UI;本 Task 不渲染设置面板调用它(spec §6.3 / §6.4)。
   */
  updateCategory(key: string, patch: CategoryPatch): Promise<void>
  /** 读当前代理配置(设置面板回显当前档 / 手动地址,Task 7 §7.1;handler / preload 实现留 Step 5) */
  getProxyConfig(): Promise<ProxyConfig>
  /**
   * 写代理配置(切档 / 改手动地址),返回 set 后即时代理状态(含探测)。
   * 非法 manual 地址不落盘,但返回 `手动代理(地址无效)` 告警态(spec §2.3 / §5.1)。
   */
  setProxyConfig(config: ProxyConfig): Promise<ProxyStatus>
  /** 取当前代理状态(状态栏启动拉取;含一次代理端口探测,direct 档不探) */
  getProxyStatus(): Promise<ProxyStatus>
  /**
   * 订阅代理状态变更推送,返回取消订阅函数(组件卸载清理)。
   * @returns 调用即移除监听。
   */
  onProxyStatusChanged(callback: (status: ProxyStatus) => void): () => void
  /** 读全量应用设置(设置页挂载回显;Task 8 §3.3) */
  getSettings(): Promise<AppSettings>
  /**
   * 写设置补丁(切档 / 改并发 / 改目录 / 视频偏好),返回校验 + clamp 后的最新全量设置。
   * 主进程合并校验 → 原子写盘 → 联动即时生效(并发 / 主题 / 默认目录 / 视频偏好,spec §3.4)。
   * `video` 可只带被改子字段(主进程逐字段合并;避免连点丢改,v0.3 Task 4 审计#10)。
   */
  setSettings(patch: AppSettingsPatch): Promise<AppSettings>
  /** 取引擎内核版本(关于分组;MVP 静态常量,真实探测留 Task 9) */
  getEngineVersions(): Promise<EngineVersions>
  /**
   * 订阅剪贴板检测推送,返回取消订阅函数(v0.2 Task 4 · spec §7.1;仿 onProxyStatusChanged / onTaskDuplicate)。
   * 主进程 ClipboardWatcher 检测到可下载新链接 → 广播 `clipboard:linkDetected` → 渲染层弹 ClipboardPrompt(App 接线留 Step 4)。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onClipboardLink(callback: (link: ClipboardLink) => void): () => void
  /** 历史检索(只读 tasks 表;空条件返回最近 500 条,时间口径 / clamp / trim 全在主进程,v0.2 Task 5 · spec §7.1) */
  searchHistory(query: HistoryQuery): Promise<Task[]>
  /** 历史统计聚合(只读;口径见 spec §4,仅 completed 计入 · completedAt,v0.2 Task 5 · spec §7.1) */
  getHistoryStats(): Promise<HistoryStats>
  /** 手动检查 yt-dlp 更新(无视节流;返回当前 / 最新版本对比,v0.2 Task 6 · spec §4.2) */
  checkYtDlpUpdate(): Promise<UpdateCheckResult>
  /** 执行 yt-dlp 更新(检查→下载→三重校验→替换 / pending;进度经 onUpdateStatus 广播,v0.2 Task 6 · spec §4.2) */
  runYtDlpUpdate(): Promise<void>
  /** 检查应用本体更新(不自动下载;v0.2 Task 6 · spec §4.2) */
  checkAppUpdate(): Promise<UpdateCheckResult>
  /** 下载应用更新(用户确认后触发;进度经 onUpdateStatus 广播,v0.2 Task 6 · spec §4.2) */
  downloadAppUpdate(): Promise<void>
  /** 退出并安装已下载的应用更新(用户点「重启安装」;v0.2 Task 6 · spec §4.2) */
  quitAndInstallApp(): Promise<void>
  /**
   * 订阅更新进度 / 阶段推送,返回取消订阅函数(v0.2 Task 6 · spec §4.2;仿 onProxyStatusChanged)。
   * 主进程 YtdlpUpdater / AppUpdater 经 onStatus → broadcastUpdateStatus 推 UpdateStatus(yt-dlp / app 共用)。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  /** 取 tracker 表更新状态(设置页挂载回显;生效表口径 / usingBuiltin 全在主进程算好,v0.4 Task 1 · spec §5.3) */
  getBtTrackerStatus(): Promise<BtTrackerStatus>
  /**
   * 立即更新 tracker 表(设置页「立即更新」):**无视 12h 节流、30min 退避与自动更新开关**。
   * 返回本次结果供渲染层 toast(**手动路径成败都弹**,D15);拉取 / 解析 / 合并 / 合格性 / 落盘 / 热应用全在主进程(§7.2)。
   */
  updateBtTrackersNow(): Promise<BtTrackerStatus>
  /**
   * 订阅 tracker 状态变更推送,返回取消订阅函数(v0.4 Task 1 · spec §5.3;仿 onUpdateStatus)。
   * 自动路径(添加 BT 任务时按需拉取)完成后经 broadcastBtTrackerStatus 推最新状态;**自动路径永不 toast**。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onBtTrackerStatusChanged(callback: (status: BtTrackerStatus) => void): () => void
  /**
   * 取入站可达自检结果(**每次实算、不缓存**,换网即得新结论;v0.4 Task 1 · spec §3.4)。
   * 纯本地读网卡、零外联、不查也不改防火墙;IPv6 判定与三态汇总全在主进程纯函数(§7.2)。
   */
  getBtInboundDiagnosis(): Promise<InboundDiagnosis>
  /**
   * 订阅入站诊断变更推送,返回取消订阅函数(v0.4 Task 1 · spec §3.4)。
   * 主进程在 `powerMonitor` resume / 添加 BT 任务时重算,**`state` 变了才广播**(不刷屏)。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onBtInboundChanged(callback: (diagnosis: InboundDiagnosis) => void): () => void
  /**
   * 读本地通道配置 `{enabled,port,token}`(设置页回显 + 配对码展示;v0.4 Task 3 · spec §5)。
   * token 恒有值(`init()` 已保障),**与「是否启用」无关** —— 否则设置页打开时配对码是空的,
   * 用户不知道该等什么(spec §3.2)。
   */
  getExtensionChannelConfig(): Promise<ExtensionChannelConfig>
  /**
   * 写本地通道配置(开关 / 改端口)→ 起停 / 重绑 → 返回即时状态。
   * **端口非法则整体不落盘**(仿非法 manual 代理地址的处理),回状态里 `lastError` 为
   * `invalid_port:<code>` 让 UI 显示无效态;`token` **不可经此写入**(spec §3.2)。
   */
  setExtensionChannelConfig(patch: ExtensionChannelConfigPatch): Promise<ExtensionChannelStatus>
  /**
   * 重新生成配对码:新 token 落盘 + **清空连接态**(立刻回落「未配对」)+ 广播,返回新配置。
   * 旧配对当场失效,UI 须提示需重新配对(spec §3.2 / §4.4)。
   */
  regenerateExtensionToken(): Promise<ExtensionChannelConfig>
  /** 取本地通道两行状态(设置页挂载回显;服务态 + 扩展三态,spec §5.2 / §5.3) */
  getExtensionChannelStatus(): Promise<ExtensionChannelStatus>
  /** 取扩展目录 `{dir,exists}`(#42 发现引导;路径**从运行时取**,dev / 打包两态不同) */
  getExtensionSideloadInfo(): Promise<ExtensionSideloadInfo>
  /**
   * 订阅本地通道状态变更推送,返回取消订阅函数(v0.4 Task 3 · spec §5;仿 onProxyStatusChanged)。
   * 起停 / 重绑 / 握手成功 / 重新生成 token 后经 broadcastExtensionChannelStatus 推所有窗口。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onExtensionChannelStatusChanged(callback: (status: ExtensionChannelStatus) => void): () => void
  /**
   * 读接管配置快照(设置页「下载接管」子区挂载回显;v0.4 Task 4 · spec §5.5)。
   * `paused` 是**主进程算好的**结论,渲染层不自己判时钟。
   */
  getTakeoverConfig(): Promise<TakeoverSettingsView>
  /**
   * 写接管配置(总开关 / 域名例外表)→ 落盘 + 广播 → 回写后快照。
   * 域名由主进程归一(小写 / 去协议 / 去路径 / 去端口 / 保序去重),故回包里的表可能与传入的不同 ——
   * 渲染层**以回包为准**(与端口那条「结论归主进程」同一纪律)。
   */
  setTakeoverConfig(patch: TakeoverSettingsPatch): Promise<TakeoverSettingsView>
  /**
   * 设暂停时长档(`minutes: null` = 立即恢复接管)→ 落盘 + 广播 → 回写后快照。
   * **绝对到期时刻由主进程现算**(`now + minutes`),渲染层只报「多少分钟」。
   */
  setTakeoverPause(patch: TakeoverPausePatch): Promise<TakeoverSettingsView>
  /**
   * 订阅接管配置变更推送,返回取消订阅函数(v0.4 Task 4;仿 onExtensionChannelStatusChanged)。
   * 设置页改开关 / 例外表、**或 popup 遥控器设暂停**之后主进程广播 —— 后者是它存在的理由。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onTakeoverConfigChanged(callback: (view: TakeoverSettingsView) => void): () => void
  /**
   * 取当前暂借登录态的域列表(v0.4 Task 6;设置页可见行挂载时读)。
   *
   * 🔴 回的是 `{hosts}` —— **没有任何字段能装 cookie 值**(红线 R3 由接口形状保证)。
   */
  getBorrowedCookieHosts(): Promise<BorrowedCookieHosts>
  /**
   * 清空暂借登录态 → 回写后快照(恒 `{hosts:[]}`)。
   *
   * ⚠️ 清的是**主进程内存里的持有层**,不碰浏览器里的任何 cookie —— DownLord 从不写、
   * 不删用户浏览器的 cookie(安装说明里那句承诺的代码侧对应物)。
   */
  clearBorrowedCookies(): Promise<BorrowedCookieHosts>
  /**
   * 订阅持有层变更推送,返回取消订阅函数(v0.4 Task 6)。
   * offer 到达的时刻由用户在浏览器里的动作决定,设置页正开着时靠它当场更新。
   * @returns 调用即移除监听,供组件卸载时清理。
   */
  onBorrowedCookiesChanged(callback: (snapshot: BorrowedCookieHosts) => void): () => void
}
