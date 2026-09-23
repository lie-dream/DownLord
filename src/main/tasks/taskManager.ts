/**
 * TaskManager — 统一任务协调枢纽(spec §6,ARCHITECTURE §4 / §7.3 / §7.4)。
 *
 * 唯一职责中心:归一 Task 的增删改查 + 协调 DownloadEngine(下发 + 收进度)+ 并发控制
 * + 持久化(关键节点落库)+ 重启恢复。对上层(IPC handler)只暴露归一接口。
 *
 * 红线遵守:
 * - §4 进度分层:瞬时 speed / downloadedBytes 仅内存 + IPC 推 UI;仅状态流转与
 *   started / paused / completed / error 关键节点写库(totalBytes 首次已知时一次性写)。
 * - §7.4 续传归属:重启 / 出队重提交只传业务信息(url / dir / filename),**不自存字节级进度**,
 *   续传交给 aria2 的 `.aria2` 控制文件;DB 的 downloadedBytes 仅供 UI 粗略展示。
 * - 状态流转前一律 canTransition 校验;非法流转记日志 + 不崩。
 */
import { basename, dirname, join, normalize, resolve } from 'path'
import { mkdirSync, existsSync, readdirSync, copyFileSync, readFileSync, renameSync } from 'fs'
import { mapFsError, mapAria2DownloadError } from '../errors/mapError'
import { toReadable } from '../errors/errorCatalog'
import type {
  AddTaskInput,
  AddUriInput,
  BatchPick,
  DownloadProgress,
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateDecision,
  DuplicateResolution,
  FormatChoice,
  ResolvedFormat,
  ResolveResult,
  Task,
  TaskFilter,
  TaskProgress,
  TaskStatus,
  TorrentInfo,
  TorrentMeta,
  VideoMeta,
  VideoPrefs,
  VideoSubmit
} from '../../shared/ipc'
import { filterDownloadHeaders } from '../../shared/downloadHeaders'
import { initDatabase as defaultInitDatabase, type AppDatabase } from '../db/connection'
import {
  deleteTask,
  findBySource,
  getTask as daoGetTask,
  insertTask,
  listTasks as daoListTasks,
  updateTask
} from '../db/taskDao'
import { listCategories } from '../db/categoryDao'
import { buildExtIndex, categorize, resolveCategoryDir } from '../category/categorize'
import type { CategoryDef } from '../category/categoryModel'
import { canRetry, canTransition } from './stateMachine'
import { dequeueNext } from './concurrency'
import { buildRecoveryPlan } from './recovery'
import { detectConflict, nextAvailableStem } from './duplicateDetect'
import { sanitizeBasename, predictExt } from '../video/filename'
import { buildFormatSelector } from '../video/ytdlpFormat'
import { qualityLabelOf, qualityTag, resolvedTopHeight } from '../video/qualityLabel'
import { isFragmentedProtocol } from '../video/formatAccel'
import { getVideoPrefs as defaultGetVideoPrefs } from '../video/videoPrefs'
import { magnetDisplayName, toBase64, selectFileArg, applyFileSelection } from '../engine/btOptions'
import { torrentSaveDir, managedTorrentPath } from '../bt/torrentPaths'

/** VideoResolver 对 TaskManager 暴露的最小面(便于测试 mock;VideoResolver 天然满足) */
export interface VideoResolverLike {
  /**
   * @param headers - 接管 / 嗅探来源的请求头(v0.4 Task 5 · spec §4.5 第 5~6 处)。
   *   **可选** —— 既有实现(含测试 mock)不接这个参数照样满足本接口,与改动前逐字节等价。
   */
  resolve(
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>
  ): Promise<ResolveResult>
}

/** DownloadEngine 对 TaskManager 暴露的最小面(便于测试 mock,DownloadEngine 天然满足) */
export interface TaskEngine {
  addUri(input: AddUriInput): Promise<string>
  /** HTTP 原生只探测取名;不建业务任务、不产生下载进度。失败回 null。 */
  resolveHttpFilename?(input: Pick<AddUriInput, 'url' | 'dir' | 'headers'>): Promise<string | null>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  remove(id: string): Promise<void>
  onProgress(callback: (progress: DownloadProgress) => void): () => void
  /**
   * 单任务限速(v0.2 Task 2 · spec §2.3):按引擎内部 id 设限速 KB/s;可选(便于 mock)。
   * CompositeEngine 按 id 路由后端(aria2 即时 / video 下次继续生效);全局限速非任务粒度、不经此。
   * v0.3 Task 4 #25:值域 `number | null`(`null` = 清除任务级覆盖 = 跟随全局,见各后端 null 语义)。
   */
  setTaskLimit?(id: string, kbps: number | null): Promise<void>
  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §5.4):按引擎内部 id 下发 aria2 `--select-file`
   * (`selectFileArg===null` = 全选,引擎跳过 changeOption);仅 aria2 后端实现,可选(便于 mock)。
   */
  applyTorrentSelection?(id: string, selectFileArg: string | null): Promise<void>
  /**
   * 停止单任务做种(v0.3 Task 3 · spec §7):按引擎内部 id 停上传(`forcePause` 保留文件 + `.aria2`);
   * 仅 aria2 后端实现,可选(便于 mock)。
   */
  stopSeeding?(id: string): Promise<void>
}

export interface TaskManagerDeps {
  engine: TaskEngine
  /** 视频解析器(yt-dlp 解析元信息 / 格式 / playlist);http-only 场景可省(视频任务才用) */
  videoResolver?: VideoResolverLike
  /** 默认清晰度偏好读取(占位,§6.5);默认走 videoPrefs 占位(每次询问) */
  getVideoPrefs?: () => VideoPrefs
  /** 注入式 DB 初始化(默认走 connection.initDatabase),便于测试替换 */
  initDatabase?: (dbPath: string) => AppDatabase
  /** 注入式任务 id 生成器,便于测试确定化 */
  idGenerator?: () => string
  /**
   * 注入式目录创建(默认 `fs.mkdirSync(dir, { recursive: true })`):分类保存路由提交引擎前确保
   * 目标目录存在(spec §5.1 步骤 4);便于测试 mock / 断言 / 注入失败(§5.3 目录创建失败降级)。
   */
  ensureDir?: (dir: string) => void
  /**
   * 注入式移入系统回收站(默认 electron `shell.trashItem`,懒加载不静态依赖 electron 便于测试)。
   * 删除文件 / 残留清理走回收站(可恢复,§7.3);best-effort:失败记日志不抛。测试注入 mock。
   */
  trashItem?: (path: string) => Promise<void>
  /** 注入式文件存在检测(默认 `fs.existsSync`);残留清理前判存在,测试注入 mock */
  existsSync?: (path: string) => boolean
  /**
   * 注入式延迟(默认真实 `setTimeout`;测试注入 no-op 立即返回,避免真等)。
   * 残留清理撞 Windows 文件锁失败后按退避重试用(见 `trashIfExists`)。
   */
  delay?: (ms: number) => Promise<void>
  /**
   * 注入式读目录(默认 `fs.readdirSync`);视频残留按同目录 stem 前缀匹配清理用(§4)。测试注入 mock。
   */
  readDir?: (dir: string) => string[]
  /**
   * 注入式文件拷贝(默认 `fs.copyFileSync`,仿 ensureDir):`.torrent` 添加时拷托管副本
   * `<userData>/torrents/<id>.torrent`(v0.3 Task 1 · spec §6.1);测试注入 mock。
   */
  copyFileSync?: (src: string, dest: string) => void
  /**
   * 注入式同步读文件(默认 `fs.readFileSync`):出队 / 恢复重提交时读 `.torrent` 托管副本转
   * base64 给 `aria2.addTorrent`(spec §6.2);测试注入 mock。
   */
  readFileSync?: (path: string) => Buffer
  /**
   * 注入式同步更名(默认 `fs.renameSync`):BT 完成时把 aria2 `bt-save-metadata` 落的
   * `<infoHash>.torrent` 更名 `<种子名>.torrent`(迅雷式伴生,2026-07-25 修订四);测试注入 mock。
   */
  renameSync?: (oldPath: string, newPath: string) => void
  /**
   * 注入式 tracker 表按需刷新(v0.4 Task 1 · spec §4.1):**添加 BT 任务时**触发(非启动 →
   * 非 BT 用户零外联)。调用点 **fire-and-forget、不 await** —— 任务立即提交引擎,**不等网络**(D9);
   * 开关 / 节流 / 失败降级全在 `BtTrackerService` 内,本类只管触发。未注入 → 不触发(零回归)。
   */
  refreshBtTrackers?: () => Promise<void>
}

export interface TaskManagerOptions {
  dbPath: string
  defaultDir: string
  maxConcurrent?: number
  /** userData 目录(`.torrent` 托管副本 `<userData>/torrents` 的根,v0.3 Task 1 · spec §6.1);缺省不支持 .torrent 文件任务 */
  userDataDir?: string
  /**
   * torrent 元数据硬超时毫秒(v0.3 Task 1 · 2026-07-22 真机修订二 · spec §4.3)。
   * 缺省 10 分钟;超时仍 `resolving` → 撤引擎任务 + 转 error 诚实文案(死磁力 / 受限网络不永久卡住)。测试注入小值。
   */
  torrentMetadataTimeoutMs?: number
  /**
   * 视频解析墙钟总超时毫秒(审计#1 · spec §6)。缺省 90s;超时仍 `resolving` → abort 解析(树杀防 orphan)
   * + 转 error 诚实「超时」文案(慢站 / 代理黑洞不永久卡 resolving)。测试注入小值触发。
   */
  resolveTimeoutMs?: number
}

/** 仅可落库字段(排除派生的瞬时 speed)的局部更新 */
type PersistableUpdates = Partial<Omit<Task, 'speed'>>

const DEFAULT_MAX_CONCURRENT = 3

/**
 * 视频解析(yt-dlp -J)墙钟总超时缺省 90s(审计#1 · spec §6)。正常解析远 <30s(args 的 --socket-timeout 30
 * 是单 socket 级、非总时);90s 仅兜底慢站 / 代理黑洞,不设 settings 免过度配置。超时 → controller.abort()
 * → ytdlpProcess 树杀 → exitCode null → 「超时」文案 → 任务转 error(可重试),不再无限 resolving。
 */
const RESOLVE_TIMEOUT_MS = 90_000

/** torrent 元数据硬超时缺省 10 分钟(spec §4.3;DHT 引导 + tracker 正常时活种远快于此,超时≈死种/网络受限) */
const TORRENT_METADATA_TIMEOUT_MS = 10 * 60 * 1000

/** 元数据超时诚实文案(spec §4.3:不承诺规避封锁,如实说明可能原因) */
const TORRENT_METADATA_TIMEOUT_ERROR =
  '获取种子元数据超时:长时间未找到可用节点(peers)——可能当前网络受限(DHT/UDP 被阻断)或种子无活跃做种者;请检查网络后重试或更换种子'

/**
 * 对外速度口径:仅活动态(downloading / processing)透出瞬时 speed,其余态一律 0。
 * 暂停 / 排队后引擎不再来新帧,内存残留的旧 speed 若原样透出,UI 会一直显示暂停前速度
 * ——被感知为「暂停后还在偷偷下载」(真机 2026-07-09 用户反馈)。
 */
function activeSpeed(task: Task): number {
  return task.status === 'downloading' || task.status === 'processing' ? task.speed : 0
}

/** filename → { stem, ext(含前导点) };无扩展名 / 前导点文件 ext=''(重命名序号只作用 stem,ext 原样拼回) */
function splitExt(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf('.')
  return dot > 0
    ? { stem: filename.slice(0, dot), ext: filename.slice(dot) }
    : { stem: filename, ext: '' }
}

/**
 * URL 末段推断文件名(v0.4 Task 4 · spec §1.4 从 `resolveFilename` **原样提取**,行为逐字节等价)。
 *
 * 提取的唯一理由:接管确认框要**预填**同一个建议名,而 `suggestFilename` **不得复制**这段逻辑 ——
 * 复制出来的第二份迟早与这份漂移(测试 U-12 钉死两者对同一输入输出相同)。
 *
 * 恒过 `sanitizeBasename`(§7.7 的唯一权威:`/ \ < > : " | ? *`、控制字符、保留设备名、尾部点空格),
 * 故**路径穿越无需新增缓解**;清洗后为空 / URL 非法 → 落回 `download-<时间戳>` 兜底名。
 */
export function filenameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    const base = decodeURIComponent(segments[segments.length - 1] ?? '')
    const cleaned = sanitizeBasename(base)
    if (cleaned) {
      return cleaned
    }
  } catch {
    // 非标准 URL,落回兜底名
  }
  return `download-${Date.now()}`
}

/** 批量 parked 单项:预建但未插库的子任务 + 其冲突项(供逐条 resolve;index 供 perItem 定位) */
interface BatchPendingItem {
  index: number
  childTask: Task
  item: DuplicateConflictItem
}

/**
 * parked 冲突三形态(内存瞬时,**不落库**、不新建 status,spec §6.2):
 * - http:检测在 insert 前 → 存待插的 Task(conflictId = 预生成 id);
 * - video:任务已在 awaiting_selection(复用既有合法态)→ 存 { taskId, choice };
 * - batch:父占位待决策 → 存 parentId + 逐条 { childTask, item }。
 * 重启不持久化:http/batch 丢弃、video 经既有 awaiting_selection 恢复路径自愈(§6.3)。
 */
type PendingConflict =
  | { kind: 'http'; task: Task; item: DuplicateConflictItem }
  | { kind: 'video'; taskId: string; choice: FormatChoice; item: DuplicateConflictItem }
  | { kind: 'batch'; parentId: string; items: BatchPendingItem[] }

export class TaskManager {
  private readonly engine: TaskEngine
  private readonly videoResolver?: VideoResolverLike
  private readonly getVideoPrefs: () => VideoPrefs
  private readonly initDatabase: (dbPath: string) => AppDatabase
  private readonly idGenerator?: () => string
  private readonly ensureDir: (dir: string) => void
  /** 移入系统回收站(注入式,§7.3;默认懒加载 electron shell.trashItem) */
  private readonly trashItem: (path: string) => Promise<void>
  /** 文件存在检测(注入式;默认 fs.existsSync) */
  private readonly fileExists: (path: string) => boolean
  /** 退避重试延迟(注入式;默认 setTimeout,测试注入立即) */
  private readonly delay: (ms: number) => Promise<void>
  /** 读目录(注入式;默认 fs.readdirSync);视频分片前缀匹配清理用(§4) */
  private readonly readDir: (dir: string) => string[]
  /** 同步更名(注入式;默认 fs.renameSync);BT 完成 `<infoHash>.torrent` → `<种子名>.torrent`(修订四) */
  private readonly renameFile: (oldPath: string, newPath: string) => void
  /** 文件拷贝(注入式;默认 fs.copyFileSync);.torrent 托管副本拷入用(v0.3 §6.1) */
  private readonly copyFile: (src: string, dest: string) => void
  /** 同步读文件(注入式;默认 fs.readFileSync);托管副本 → base64 重提交用(v0.3 §6.2) */
  private readonly readFile: (path: string) => Buffer
  /** tracker 表按需刷新(注入式,可缺省;添加 BT 任务时 fire-and-forget 触发,v0.4 Task 1 · spec §4.1) */
  private readonly refreshBtTrackers?: () => Promise<void>
  private readonly opts: TaskManagerOptions
  /** 最大并发数;Task 8 setMaxConcurrent 运行时可变(由 private readonly 改 private,spec §3.4) */
  private maxConcurrent: number
  /** 默认下载目录(路由兜底:other / 未命中类别落此);Task 8 setDefaultDir 运行时可变,后续新任务生效 */
  private defaultDir: string

  private db!: AppDatabase

  /** 内存任务映射(含瞬时 speed / downloadedBytes / totalBytes) */
  private readonly tasks = new Map<string, Task>()
  /** TaskManager id ↔ DownloadEngine 内部 id(进度事件经此回查) */
  private readonly taskIdToEngineId = new Map<string, string>()
  private readonly engineIdToTaskId = new Map<string, string>()
  /** 已落库 totalBytes 的任务 id(避免每帧进度重复写库) */
  private readonly totalPersisted = new Set<string>()
  /**
   * 做种中的 torrent 任务 id(v0.3 Task 3 · spec §3;**内存 runtime,不落库**)。持久化状态仍 `completed`;
   * 引擎帧 seeding 派生位置位 / 清除,stopSeeding / 自然停 / 删任务清除;broadcast 据此透传 TaskProgress.seeding。
   */
  private readonly seedingTasks = new Set<string>()
  /** 视频解析结果(瞬时,供格式 / 批量对话框;不落库,可重解析,§2.5) */
  private readonly resolvedMap = new Map<string, ResolveResult>()

  /** 类别配置缓存(启动读入 + Phase 5 updateCategory 后 refreshCategories 刷新;Phase 3 路由用) */
  private categories: CategoryDef[] = []
  /** ext → category key 反向索引(由 categories 预构建;Phase 3 categorize 路由用) */
  private extIndex: Map<string, string> = new Map()

  private readonly progressCallbacks = new Set<(progress: TaskProgress) => void>()
  /** 查重冲突广播订阅(仿 progressCallbacks;Phase 3 IPC 经此转 task:duplicate,§6.1) */
  private readonly duplicateCallbacks = new Set<(conflict: DuplicateConflict) => void>()
  /** parked 冲突(内存瞬时、不落库,§6.2);conflictId → PendingConflict,resolve 后清理 */
  private readonly pendingConflicts = new Map<string, PendingConflict>()
  /** HTTP 覆盖跨 await 的目标预约,防止并发决策交错回收同一文件。 */
  private readonly httpOverwritePaths = new Map<string, string>()
  /** torrent 元数据超时定时器(内存瞬时;taskId → timer,spec §4.3)。torrentInfo 到达 / 删除 / stop 即清 */
  private readonly metadataTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 视频解析中止控制器(审计#1 · spec §6;内存瞬时;taskId → AbortController)。triggerResolve 建 + 挂总超时,
   * 解析 settle(成功 / 失败 / 超时)/ 删除任务 / stop 即 abort + 清;abort → ytdlpProcess 树杀防孤儿 -J 进程。
   */
  private readonly resolveControllers = new Map<string, AbortController>()
  private unsubscribeEngine: (() => void) | null = null

  private idCounter = 0

  constructor(deps: TaskManagerDeps, opts: TaskManagerOptions) {
    this.engine = deps.engine
    this.videoResolver = deps.videoResolver
    this.getVideoPrefs = deps.getVideoPrefs ?? defaultGetVideoPrefs
    this.initDatabase = deps.initDatabase ?? defaultInitDatabase
    this.idGenerator = deps.idGenerator
    this.ensureDir = deps.ensureDir ?? ((dir) => mkdirSync(dir, { recursive: true }))
    this.trashItem =
      deps.trashItem ??
      (async (p) => {
        // 懒加载 electron:避免主进程 TaskManager 静态依赖 electron(单测无 electron 环境)
        const { shell } = await import('electron')
        await shell.trashItem(p)
      })
    this.fileExists = deps.existsSync ?? existsSync
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.readDir = deps.readDir ?? readdirSync
    this.renameFile = deps.renameSync ?? renameSync
    this.copyFile = deps.copyFileSync ?? copyFileSync
    this.readFile = deps.readFileSync ?? readFileSync
    this.refreshBtTrackers = deps.refreshBtTrackers
    this.opts = opts
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.defaultDir = opts.defaultDir
  }

  // ========== 生命周期 ==========

  /** 初始化库 → 读库恢复任务 → 订阅引擎进度 → 批量重提交未完成任务(§7) */
  async start(): Promise<void> {
    this.db = this.initDatabase(this.opts.dbPath)
    // 类别配置读入内存缓存 + 预构建 extIndex(供 Phase 3 分类保存路由;本 Phase 仅读入,不改路由)
    this.refreshCategories()
    if (this.categories.length > 0) {
      console.log(
        `[TaskManager] 类别配置已载入:${this.categories.length} 类 / ${this.extIndex.size} 扩展名映射`
      )
    }
    this.unsubscribeEngine = this.engine.onProgress((progress) =>
      this.handleEngineProgress(progress)
    )

    // 读库全量恢复到内存(completed / error 仅作历史展示)
    for (const task of daoListTasks(this.db)) {
      this.tasks.set(task.id, { ...task, speed: 0 })
    }

    // 重启恢复计划(spec §4.4.5):
    // - downloading/queued(http)+ downloading/processing(video)→ 重提交(按 createdAt,受并发约束);
    // - resolving/awaiting_selection(video)→ 重解析(formats 瞬时已丢);
    // - paused 保持暂停;超并发的活动态归位 queued 等待出队(§7.3)。
    const plan = buildRecoveryPlan([...this.tasks.values()], this.maxConcurrent)

    for (const planned of plan.toQueue) {
      const task = this.tasks.get(planned.id)
      // 恢复期归一化:超并发的活动态(downloading / 视频 processing)降回 queued(load-time 归位)
      if (task && (task.status === 'downloading' || task.status === 'processing')) {
        this.applyAndPersist(task, { status: 'queued' })
      }
    }

    // 视频下载前态:重解析(awaiting_selection 先归位 resolving,使 onResolved 流转合法)
    for (const planned of plan.toResolve) {
      const task = this.tasks.get(planned.id)
      if (!task) {
        continue
      }
      if (task.status === 'awaiting_selection') {
        this.applyAndPersist(task, { status: 'resolving' })
      }
      this.triggerResolve(task.id)
    }

    for (const planned of plan.toSubmit) {
      const task = this.tasks.get(planned.id)
      // torrent awaiting_selection 恢复(v0.3 Task 2 · spec §4.4):先归位 → resolving,使后续 onTorrentInfo
      // 的 resolving→awaiting_selection 合法。awaiting_selection→resolving **非合法状态机边**,故用
      // load-time applyAndPersist 直接改内存 + 落库(非 transition,同视频恢复 :303-304 做法)。
      // 归位后 recoverSubmit 走 keepResolving 分支(保持 resolving + 重挂超时 + 以 awaitSelection 重提)。
      if (task && task.kind === 'torrent' && task.status === 'awaiting_selection') {
        this.applyAndPersist(task, { status: 'resolving' })
      }
      await this.recoverSubmit(planned.id)
    }
  }

  /** 停止:退订引擎进度(better-sqlite3 同步,无需显式关库) */
  async stop(): Promise<void> {
    this.unsubscribeEngine?.()
    this.unsubscribeEngine = null
    for (const timer of this.metadataTimers.values()) {
      clearTimeout(timer)
    }
    this.metadataTimers.clear()
    // 审计#1:中止所有进行中解析(应用退出 / 停止时,防遗留 controller 与孤儿 -J 进程)
    for (const controller of this.resolveControllers.values()) {
      controller.abort()
    }
    this.resolveControllers.clear()
  }

  /**
   * 重读 categories 配置入内存缓存 + 重建 extIndex。
   * 启动时(start)调用载入;`category:update` 写库后由 IPC handler 调用刷新缓存,
   * 使后续新任务用新配置(Phase 5);**已存任务 savePath / category 不回迁**(spec §5.2 / §6.2 / §9)。
   */
  refreshCategories(): void {
    this.categories = listCategories(this.db)
    this.extIndex = buildExtIndex(this.categories)
  }

  /**
   * 运行时调整最大并发数(Task 8 · spec §3.4 / §3.5)。SettingsService.onChange 经 `index.ts` 闭包注入调用。
   * 调大:立即 `dequeueNext` 出队补足(排队任务拉起至新上限);调小:**不中断运行中任务**
   * (dequeueNext 仅启动 queued,availableSlots = max(0, n − active);超额者自然完成后才按新上限出队,§4.6)。
   * 出队为 fire-and-forget(与 onResolved / 完成事件出队同构),保持同步签名契合 onChange 闭包;失败记日志不崩。
   */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n
    this.triggerDequeue().catch((err) =>
      console.error('[TaskManager] setMaxConcurrent 出队补足失败:', err)
    )
  }

  /**
   * 运行时更新默认下载目录(Task 8 · spec §3.4 / §3.5)。供路由兜底:`addTask` / `routeForFilename`
   * 读取(other / 未命中类别 → defaultDir),对**后续新任务**生效;已存任务 savePath 与已 seed 的分类
   * 各类目录**不回迁**(§7.4 续传归属;§3.5 各类目录独立配置)。引擎实例构造期 defaultDir 仅兜底,
   * 运行时每任务传显式 dir(savePath 由 TaskManager 算好),故改默认目录无需更新引擎实例。
   */
  setDefaultDir(dir: string): void {
    this.defaultDir = dir
  }

  // ========== 只读访问器(v0.2 Task 4 剪贴板监控注入,spec §3.3;纯读、不改任何写路径 / 状态机)==========

  /**
   * 已知文件扩展名并集(= 类别 `extIndex` 的键集合;小写、无 `.`)。
   * 供 `ClipboardWatcher` 注入 `classifyLink` 的 `knownFileExts`,与直链识别加固同一并集(spec §1.1 / §3.3)。
   * 返回**快照副本**(new Set),不暴露内部 Map 引用。
   */
  getKnownFileExts(): ReadonlySet<string> {
    return new Set(this.extIndex.keys())
  }

  /**
   * 当前内存任务的源 URL 集合(去重「已在任务列表」用,spec §4.3)。
   * `ClipboardWatcher` 命中 `trackedUrls` 即不弹提示,避免为刚添加 / 正在下载的 URL 重复打扰。
   * 返回**快照副本**(new Set),每次映射 `Task.source`。
   */
  getTrackedSourceUrls(): ReadonlySet<string> {
    const urls = new Set<string>()
    for (const task of this.tasks.values()) {
      urls.add(task.source)
    }
    return urls
  }

  /**
   * 是否有视频任务正占用 yt-dlp(v0.2 Task 6 · spec §2.4)。
   * 供 `YtdlpUpdater` 判定热更新替换时机:占用则降级 `.pending` 下次启动生效,绝不 kill 运行中 yt-dlp
   * (§7.1)。**只读**,遍历内存任务:`kind==='video'` 且 status ∈ {resolving, downloading, processing};
   * 不改状态机、不触发任何副作用(零回归)。
   */
  hasActiveYtDlp(): boolean {
    for (const task of this.tasks.values()) {
      if (
        task.kind === 'video' &&
        (task.status === 'resolving' ||
          task.status === 'downloading' ||
          task.status === 'processing')
      ) {
        return true
      }
    }
    return false
  }

  // ========== 任务操作 ==========

  async addTask(input: AddTaskInput): Promise<string> {
    const id = this.generateId()
    const now = Date.now()

    // torrent 创建路径(v0.3 Task 1 · spec §5.1):与 http / video 分道 —— 建 resolving + 立即提交引擎
    if (input.kind === 'torrent') {
      return this.addTorrentTask(input, id, now)
    }

    let filename = this.resolveFilename(input)
    // 显式名字/视频/BT/恢复不探测;旧 mock 无此能力时保留原同步查重时序。
    if (input.kind === 'http' && !input.filename?.trim() && this.engine.resolveHttpFilename) {
      filename = await this.probeHttpFilename(input)
    }
    // 视频任务先进 resolving(等解析);直链直接 queued(spec §4.4.1)
    const isVideo = input.kind === 'video'

    // 分类保存路由(§5.2):
    // - 直链(http):filename 已知 → 立即 categorize + 路由 + ensureDir(替代旧「固定 defaultDir + category=null」);
    // - 视频:resolving 期 filename 为占位、category 未定 → 不路由(category 留 null,savePath 占位;§3.4),
    //   待 applySelection 选定格式、filename(predictExt)确定后再路由。
    let category: string | null = null
    let savePath: string
    let status: TaskStatus = isVideo ? 'resolving' : 'queued'
    let error: string | null = null

    if (isVideo) {
      savePath = join(input.dir ?? this.defaultDir, filename)
    } else {
      const routed = this.routeForFilename(filename, this.explicitDirOf(input.dir))
      category = routed.category
      savePath = routed.savePath
      if (routed.error) {
        // 目录创建失败(§5.3):任务仍创建但落 error(可读提示 + 可重试),不出队
        status = 'error'
        error = routed.error
      }
    }

    const task: Task = {
      id,
      kind: input.kind,
      source: input.source,
      status,
      filename,
      savePath,
      category,
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      videoMeta: null,
      torrentMeta: null,
      error,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      // 接管来源的请求头(v0.4 Task 4 · spec §6.2 白名单第②层):**恒过白名单**,调用方给什么都只
      // 剩 Referer / User-Agent;全越界 / 未传 → undefined(不是 {}),下游 `if (task.headers)` 不进。
      // ⚠️ **运行时内存态,不落库** —— `insertTask` / `updateTask` 的列清单不带 headers,
      //    「不落库」由 DAO 形状保证而非自觉(`src/main/db/` 本 Task 一个字不改)。
      headers: filterDownloadHeaders(input.headers)
    }

    // 直链查重(spec §6.2):routeForFilename 后、insertTask 前检测;命中则**不插库**、存待插 Task、
    // emit 一个 http 冲突事件,返回 id(任务待决策后才出现)。无冲突照 v0.1 原流程(逐字节等价,零回归)。
    // 视频查重延到 applySelection(落点 / 清晰度定后);error 态不查重。
    if (!isVideo && status !== 'error') {
      const item = this.detectHttpConflict(task)
      // 仅 control 占名不代表一个可供打开/覆盖的完成文件:选安全序号,不解析未知断点。
      if (!item && this.fileExists(task.savePath + '.aria2')) {
        this.assignAvailableHttpName(task)
      }
      if (item) {
        this.pendingConflicts.set(id, { kind: 'http', task, item })
        this.emitDuplicate({ conflictId: id, kind: 'http', items: [item] })
        return id
      }
    }

    insertTask(this.db, task)
    this.tasks.set(id, task)

    if (isVideo) {
      // 异步解析(不阻塞 IPC 返回):UI 立即显示 resolving 行(spec §4.4.1)
      this.triggerResolve(id)
    } else if (status !== 'error') {
      await this.triggerDequeue()
    }
    return id
  }

  /**
   * torrent 创建路径(v0.3 Task 1 · spec §5.1 / §5.2 / §7):
   * - 建 `resolving` 占位任务:filename = magnet `dn` / `.torrent` 文件名(占位,元数据完成后校正);
   *   **显式** dir = `<defaultDir>/Torrents`、category = `'other'`,不经 routeForFilename 扩展名路由(§7);
   * - **不查重**(magnet 无最终 filename;语义去重延后,§12 / duplicateDetect 不接入);
   * - `.torrent` 先拷托管副本 `<userData>/torrents/<id>.torrent`(用户移动 / 删原文件后仍可重加,§6.1),
   *   拷贝失败 → 诚实落 error(不假装可续);
   * - **立即**提交引擎取元数据并**设 startedAt**(区别于 video 的 resolving 不提交引擎:aria2 即起
   *   写盘,删任务清残留按 startedAt 门控,§6.3);元数据阶段不占下载槽、不经 dequeue(§5.5)。
   * 元数据完成经 handleEngineProgress 的 torrentInfo 分支定 filename / savePath / torrentMeta(§5.1)。
   */
  private async addTorrentTask(input: AddTaskInput, id: string, now: number): Promise<string> {
    const isMagnet = input.source.startsWith('magnet:')
    const dir = torrentSaveDir(this.defaultDir)
    const placeholder = isMagnet
      ? sanitizeBasename(magnetDisplayName(input.source) ?? '') || '获取元数据中'
      : sanitizeBasename(basename(input.source).replace(/\.torrent$/i, '')) || '获取元数据中'

    const task: Task = {
      id,
      kind: 'torrent',
      source: input.source,
      status: 'resolving',
      filename: placeholder,
      savePath: join(dir, placeholder),
      category: 'other',
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      videoMeta: null,
      torrentMeta: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null
    }

    if (!isMagnet) {
      try {
        const copyPath = this.managedCopyPathOf(id)
        this.ensureDir(dirname(copyPath))
        this.copyFile(input.source, copyPath)
      } catch (err) {
        console.error(`[TaskManager] 种子托管副本拷贝失败 ${input.source}:`, err)
        task.status = 'error'
        task.error = this.toErrorMessage(err)
        insertTask(this.db, task)
        this.tasks.set(id, task)
        return id
      }
    }

    insertTask(this.db, task)
    this.tasks.set(id, task)

    try {
      this.ensureDir(dir)
      const engineId = await this.engine.addUri(this.toAddUriInput(task))
      this.mapEngine(id, engineId)
      this.applyAndPersist(task, { startedAt: Date.now() })
      this.armMetadataTimeout(task)
      // tracker 表按需刷新(v0.4 Task 1 · spec §4.1 / D9):**任务已提交引擎之后**才触发,
      // fire-and-forget **不 await** —— 任务立即提交、不等网络;`.catch` 兜底(service 内本就不外抛,
      // 此处是双保险:任何失败都不影响下载任务本身)。
      void this.refreshBtTrackers?.().catch(() => {})
    } catch (err) {
      this.transition(task, 'error', { error: this.toErrorMessage(err) })
    }
    this.broadcast(task)
    return id
  }

  /**
   * torrent 元数据硬超时(v0.3 Task 1 · 2026-07-22 真机修订二 · spec §4.3):
   * 提交引擎取元数据时挂定时器;超时仍 `resolving`(死磁力 / DHT·UDP 被阻断)→ best-effort 撤引擎任务
   * + 转 error 诚实文案,不永久卡「获取元数据中」。torrentInfo 到达 / 删除 / stop 即清。
   */
  private armMetadataTimeout(task: Task): void {
    this.clearMetadataTimeout(task.id)
    const ms = this.opts.torrentMetadataTimeoutMs ?? TORRENT_METADATA_TIMEOUT_MS
    const timer = setTimeout(() => {
      void this.onMetadataTimeout(task.id)
    }, ms)
    // Node Timeout 才有 unref(不阻进程退出);测试环境注入小值真跑,同样适用
    timer.unref?.()
    this.metadataTimers.set(task.id, timer)
  }

  private clearMetadataTimeout(id: string): void {
    const timer = this.metadataTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.metadataTimers.delete(id)
    }
  }

  private async onMetadataTimeout(id: string): Promise<void> {
    this.metadataTimers.delete(id)
    const task = this.tasks.get(id)
    // 已离开 resolving(元数据到了 / 已删除 / 已 error)→ 迟到的定时器无害忽略
    if (!task || task.kind !== 'torrent' || task.status !== 'resolving') {
      return
    }
    const engineId = this.taskIdToEngineId.get(id)
    if (engineId) {
      try {
        await this.engine.remove(engineId)
      } catch (err) {
        console.error(`[TaskManager] 元数据超时撤销引擎任务失败 ${id}:`, err)
      }
      this.clearEngineMap(id)
    }
    this.transition(task, 'error', { error: TORRENT_METADATA_TIMEOUT_ERROR })
    this.broadcast(task)
  }

  /** `.torrent` 托管副本路径(id 派生,§6.1);未装配 userDataDir → 诚实抛错(调用方落 error) */
  private managedCopyPathOf(taskId: string): string {
    if (!this.opts.userDataDir) {
      throw new Error('种子托管目录未配置,无法处理种子文件任务')
    }
    return managedTorrentPath(this.opts.userDataDir, taskId)
  }

  async pauseTask(id: string): Promise<void> {
    const task = this.requireTask(id)
    if (!canTransition(task.status, 'paused')) {
      throw new Error(`任务 ${id} 当前状态 ${task.status} 不可暂停`)
    }

    const engineId = this.taskIdToEngineId.get(id)
    if (engineId) {
      await this.engine.pause(engineId)
    }

    // 暂停为关键节点:快照当前已下字节落库(§4.1)
    this.transition(task, 'paused', { downloadedBytes: task.downloadedBytes })
    this.broadcast(task)

    // 释放槽位 → 出队下一个
    await this.triggerDequeue()
  }

  async resumeTask(id: string): Promise<void> {
    const task = this.requireTask(id)
    if (!canTransition(task.status, 'downloading')) {
      throw new Error(`任务 ${id} 当前状态 ${task.status} 不可恢复`)
    }

    // 并发控制:有空位直接恢复下载;无空位则转入队列排队(完成后自动出队),
    // 不再停在 paused —— 否则「全部开始 / 单点继续」时超额任务会卡死、无法自动轮到(修复④,spec §6.2 调整)
    if (this.countDownloading() >= this.maxConcurrent) {
      this.transition(task, 'queued')
      this.broadcast(task)
      return
    }

    await this.startOnEngine(task, true)
  }

  async removeTask(id: string, options?: { deleteFile?: boolean }): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) {
      // 已不存在视为幂等成功,仍清理 DB 兜底
      deleteTask(this.db, id)
      return
    }

    const engineId = this.taskIdToEngineId.get(id)
    if (engineId) {
      try {
        await this.engine.remove(engineId)
      } catch (err) {
        // 引擎侧删除失败不阻塞内存 / DB 清理
        console.error(`[TaskManager] 引擎删除任务失败 ${id}:`, err)
      }
      this.clearEngineMap(id)
    }

    // 先移除记录 + 出队补足:不被下面文件清理的退避重试阻塞(满槽删任务须即时补足下一个)。
    deleteTask(this.db, id)
    this.tasks.delete(id)
    this.clearMetadataTimeout(id)
    this.abortResolve(id) // 审计#1:中止进行中解析(resolving 视频),防孤儿 yt-dlp -J 进程
    this.totalPersisted.delete(id)
    this.seedingTasks.delete(id) // 做种 runtime 随任务清理(v0.3 Task 3)
    this.resolvedMap.delete(id) // 解析结果快照随任务清理,防会话期只增不减(playlist 元数据可观)
    await this.triggerDequeue()

    // 再清理磁盘文件 / 残留(全走回收站,可恢复 §7.3;best-effort 失败记日志、不抛)。
    // 放在出队之后,故重试延迟不拖慢并发补足。
    await this.cleanupTaskFiles(task, options?.deleteFile ?? false)
  }

  /**
   * 删除任务后的磁盘清理(§1 三语义):
   * - completed:成品是用户资产,默认保留(零回归);仅显式「删除文件」移回收站。
   * - 未完成:清残留(本体 / `.part` / `.aria2` 存在者 → 回收站,§4)。清 `.aria2` 仅在用户
   *   主动删任务时(放弃续传),不碰恢复重提 / 续传流程(§7.4)。
   */
  private async cleanupTaskFiles(task: Task, deleteFile: boolean): Promise<void> {
    // torrent 内部工件(非用户资产,v0.3 §6.3;2026-07-25 修订四扩 .aria2):任务删除即 best-effort
    // 移除(含 completed / 从未提交引擎的任务,不看 deleteFile)——托管副本 + `.aria2` 控制文件
    // (BT 完成后 aria2 不自删,与 http 不同;完成时已清一次,此处兜底老任务 / 清理失败者)
    if (task.kind === 'torrent') {
      if (this.opts.userDataDir) {
        await this.trashIfExists(managedTorrentPath(this.opts.userDataDir, task.id))
      }
      await this.trashIfExists(task.savePath + '.aria2')
    }
    if (task.status === 'completed') {
      // 成品是用户资产:默认保留(零回归);仅显式「删除文件」移回收站(§1)。正常完成的 savePath 已由
      // yt-dlp after_move 校正为真实路径,精确删即可;0B 同名跳过场景 savePath 未校正致删除无效,根在
      // 「检测重复下载」,留 TODO #18 v0.2 一并解决(不对 completed 成品做前缀扫,避免误删同前缀文件)。
      // torrent 伴生 `.torrent` 跟随内容命运(迅雷式,修订四):删内容才一并删,保留内容则保留。
      if (deleteFile) {
        await this.trashIfExists(task.savePath)
        if (task.kind === 'torrent') {
          await this.trashTorrentSidecars(task)
        }
      }
      return
    }
    // 未完成任务:从未提交过引擎(startedAt 仅在 addUri/resume 成功后设置)⇒ 引擎从未写盘、
    // 无残留可清,必须早退——此时 filename 可能还是 URL 占位(视频 resolving 期如 `watch`),
    // 按其前缀扫描 / 精确清理会把用户目录里无关的同名文件误移回收站(批量提交的父占位任务同理)。
    if (task.startedAt === null) {
      return
    }
    // 未完成任务:清磁盘残留(全走回收站,§4)。两类引擎残留命名不同:
    if (task.kind === 'video') {
      // yt-dlp 中间文件与最终 savePath 不同名(DASH 分片 `<stem>.fXXX.<ext>`、半成品
      // `<stem>.<ext>.part`)→ 按同目录 `<stem>.` 前缀匹配尽力清理。
      await this.trashVideoResiduals(task.savePath)
    } else if (task.kind === 'torrent') {
      // BT 残留(v0.3 §6.3 Task 1 最小):清 Torrents 下该种子根(单文件 = 文件 / 多文件 = 整个
      // 文件夹树入回收站,可恢复)+ 伴生 `.torrent`(内容残留都清,元数据随行,修订四),best-effort;
      // `.aria2` 已在上方内部工件段统一清;仅用户主动删任务时(放弃续传),不碰恢复重提 / 续传流程(§7.4)。
      await this.trashIfExists(task.savePath)
      await this.trashTorrentSidecars(task)
    } else {
      // 直链(aria2):残留即本体 + `.aria2` 控制文件,精确清理(不前缀匹配,避免误删同前缀文件)。
      // 清 `.aria2` 仅在用户主动删任务时(放弃续传),不碰恢复重提 / 续传流程(§7.4)。
      await this.trashIfExists(task.savePath)
      await this.trashIfExists(task.savePath + '.part')
      await this.trashIfExists(task.savePath + '.aria2')
    }
  }

  /**
   * BT 完成收尾(2026-07-25 真机修订四):
   * - 清 `.aria2` 控制文件——BT 完成后 aria2 **不**自删(http 会),真机实证残留、对用户是垃圾;
   * - `bt-save-metadata` 落的 `<infoHash>.torrent`(仅磁力任务产生)更名 `<种子名>.torrent`
   *   (迅雷式伴生:内容在元数据在,可分享 / 换客户端复用;删除任务时随内容一起清,cleanupTaskFiles)。
   *   目标名已存在(同磁力重复下载)→ 源文件直接回收(内容等价,不覆盖);更名失败保留原名(best-effort)。
   */
  private async finalizeTorrentArtifacts(task: Task): Promise<void> {
    await this.trashIfExists(task.savePath + '.aria2')
    const infoHash = task.torrentMeta?.infoHash
    if (!infoHash) return
    const src = join(dirname(task.savePath), `${infoHash}.torrent`)
    if (!this.fileExists(src)) return
    const dst = task.savePath + '.torrent'
    if (this.fileExists(dst)) {
      await this.trashIfExists(src)
      return
    }
    try {
      this.renameFile(src, dst)
    } catch (err) {
      console.error(`[TaskManager] 种子元数据更名失败(保留原名 ${src}):`, err)
    }
  }

  /**
   * 伴生 `.torrent` 元数据清理(修订四):随内容一起清——已更名的 `<种子名>.torrent` +
   * 未及更名的 `<infoHash>.torrent`(未完成删除 / 更名失败)两个名字都 best-effort 回收。
   */
  private async trashTorrentSidecars(task: Task): Promise<void> {
    await this.trashIfExists(task.savePath + '.torrent')
    const infoHash = task.torrentMeta?.infoHash
    if (infoHash) {
      await this.trashIfExists(join(dirname(task.savePath), `${infoHash}.torrent`))
    }
  }

  /**
   * 视频(yt-dlp)未完成残留清理(§4):扫描 savePath 所在目录,把所有以 `<stem>.` 开头的文件
   * 移回收站。覆盖 DASH 分片(`<stem>.f137.mp4` / `<stem>.f140.m4a`)、半成品(`<stem>.mp4.part` /
   * `<stem>.f137.mp4.part`)、已合并成品(`<stem>.mp4`)。`stem` = 去最后扩展名的 basename
   * (= yt-dlp `outputBase`,含完整标题 [清晰度],同名概率极低;前缀带 `.` 边界避免误删 `<stem>X.*`)。
   * readDir 失败 → 兜底精确清已知名(不阻塞删除)。
   */
  private async trashVideoResiduals(savePath: string): Promise<void> {
    const dir = dirname(savePath)
    const prefix = basename(savePath).replace(/\.[^.]+$/, '') + '.' // `<stem>.`
    let entries: string[] | null = null
    try {
      entries = this.readDir(dir)
    } catch (err) {
      console.error(`[TaskManager] 读目录失败,退化为精确清理 ${dir}:`, err)
    }
    if (entries) {
      for (const name of entries) {
        if (name.startsWith(prefix)) {
          await this.trashIfExists(join(dir, name))
        }
      }
    } else {
      // 目录读不到 → 兜底清已知名(本体 / .part / .aria2)
      await this.trashIfExists(savePath)
      await this.trashIfExists(savePath + '.part')
      await this.trashIfExists(savePath + '.aria2')
    }
  }

  /**
   * 存在才移回收站;best-effort。**失败退避重试**是关键:downloading 态部分文件正被 aria2 进程
   * 写入,`engine.remove` 只发 `aria2.remove` RPC —— 其返回不保证 aria2 已释放文件句柄,Windows 下
   * 文件被占用会致 `shell.trashItem` 失败(EBUSY / EPERM),致「记录已删、残留还在」。故失败后按
   * 退避(0 / 200 / 500 / 1000ms)重试给 aria2 释放句柄的时间;仍失败才记日志放弃(不抛,§6)。
   * 未被占用的常态(completed / paused / 已释放)首次即成功、无额外延迟。
   */
  private async trashIfExists(path: string): Promise<void> {
    // 末档 2000ms(2026-07-25 真机修订三):BT 多文件删除即便 forceRemove 后仍偶有句柄尾延,
    // 1.7s 内三删三败(main.log 实证);加一档兜底,常态首次即成功、无额外延迟
    const backoffMs = [0, 200, 500, 1000, 2000]
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      if (backoffMs[attempt] > 0) await this.delay(backoffMs[attempt])
      if (!this.fileExists(path)) return // 不存在 / 期间已被移除 → 完成
      try {
        await this.trashItem(path)
        return // 移入回收站成功
      } catch (err) {
        // 末次仍失败 → best-effort 放弃(记日志、不抛,仍保留已删的任务记录)
        if (attempt === backoffMs.length - 1) {
          console.error(`[TaskManager] 移入回收站失败(退避重试后仍被占用 / 不可移)${path}:`, err)
        }
      }
    }
  }

  async retryTask(id: string): Promise<void> {
    const task = this.requireTask(id)
    if (!canRetry(task.status)) {
      throw new Error(`任务 ${id} 当前状态 ${task.status} 不可重试`)
    }

    // 视频未选定格式(解析阶段失败)→ 回 resolving 重解析;http / 已选定格式的视频 → queued 重下(spec §4.2)
    if (task.kind === 'video' && !task.videoMeta?.selectedFormat) {
      this.transition(task, 'resolving', { error: null })
      this.broadcast(task)
      this.triggerResolve(id)
      return
    }

    // torrent 元数据未完成(如硬超时 / 提交失败落 error)→ 回 resolving 重提引擎取元数据(spec §4.3)。
    // 不能走下方 queued 路径:出队会直接转 downloading,再次到达的 torrentInfo 被幂等忽略、永不定名。
    if (task.kind === 'torrent' && !task.torrentMeta) {
      this.transition(task, 'resolving', { error: null })
      this.broadcast(task)
      try {
        const engineId = await this.engine.addUri(this.toAddUriInput(task))
        this.mapEngine(id, engineId)
        this.applyAndPersist(task, { startedAt: task.startedAt ?? Date.now() })
        this.armMetadataTimeout(task)
      } catch (err) {
        this.transition(task, 'error', { error: this.toErrorMessage(err) })
      }
      this.broadcast(task)
      return
    }

    // 清空 error,回到排队(error → queued)
    this.transition(task, 'queued', { error: null })
    await this.triggerDequeue()
  }

  /**
   * 单任务限速(v0.2 Task 2 · spec §2.3 / §6.4;v0.3 Task 4 #25 扩三态):经 `taskIdToEngineId` 转引擎内部 id 后调
   * `engine.setTaskLimit`(CompositeEngine 按 id 路由后端:aria2 即时 / video 无缝重起即时,2026-07-09)。
   * **三态**:`null` = 清除任务级覆盖 → `task.limitKBps = undefined`(回落全局)/ `0` = 本任务不限覆盖全局 /
   * `>0` = 限速值;三态均原样透传引擎(各后端 null 语义见 spec §3.4)。
   * **不落库**(运行时瞬时态,§7.2 / §7.4)但存内存 `task.limitKBps` 并广播——供 UI 回显当前值(真机反馈
   * 「设置的数值没有保留」);重启即清 = 恢复全局,语义不变。未提交引擎(无映射)/ 引擎不支持 → 仍存值。
   * **不含全局限速**——全局限速非任务粒度,由 index.onChange 直接调 engine.setGlobalLimit(§6.4)。
   */
  async setTaskLimit(taskId: string, kbps: number | null): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task) {
      // null → 删除任务级覆盖(内存回 undefined = 跟随全局);非 null 原样存值。仍只内存 + 广播,不写库。
      task.limitKBps = kbps ?? undefined
      this.broadcast(task)
    }
    const engineId = this.taskIdToEngineId.get(taskId)
    if (engineId) {
      await this.engine.setTaskLimit?.(engineId, kbps)
    }
  }

  /**
   * 停止单任务做种(v0.3 Task 3 · spec §3 / §7):**只对「已 completed + 做种中(seedingRuntime)」的 torrent 生效**
   * —— 校验 kind==='torrent' && seedingTasks.has(id),否则记日志幂等拒绝(**绝不作用于下载中任务**,不误伤续传)。
   * 命中 → 引擎 `stopSeeding`(forcePause 停上传、保留文件 + `.aria2`)→ 清 runtime → 广播 `{seeding:false}`。
   * 持久化状态仍 `completed`(做种走 runtime,不改状态机、不改 schema)。
   */
  async stopSeeding(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task || task.kind !== 'torrent' || !this.seedingTasks.has(id)) {
      console.error(`[TaskManager] stopSeeding 非法:任务 ${id} 非 torrent 或未在做种,已忽略`)
      return
    }
    const engineId = this.taskIdToEngineId.get(id)
    if (engineId) {
      await this.engine.stopSeeding?.(engineId)
    }
    this.seedingTasks.delete(id)
    this.broadcast(task) // seeding 取 runtime → 广播 {seeding:false}
  }

  // ========== 视频解析 / 格式选择(spec §4.4)==========

  /** 取瞬时解析结果(供格式 / 批量对话框;不落库、可重解析,§2.5) */
  getResolved(id: string): ResolveResult | null {
    return this.resolvedMap.get(id) ?? null
  }

  /** 用户 / 自动选定格式 → 入队下载(spec §4.4.3) */
  async selectFormat(id: string, choice: FormatChoice): Promise<void> {
    this.applySelection(id, choice)
    await this.triggerDequeue()
  }

  /**
   * 播放列表批量提交 → 展开为 N 个 kind:'video' 子任务(spec §7.3)。
   *
   * 归一:产物是 N 个普通 kind:'video' Task,与单视频在 TaskManager 之上完全同构
   * (同状态机 / 进度 / 持久化 / 列表),无父子关系持久化;父占位任务展开后 removeTask。
   * 不逐条解析格式:用统一清晰度策略(pick.choice → buildFormatSelector),yt-dlp 下载时自选 format。
   * 单条建子任务失败隔离(try/catch),不影响其他;受并发约束(子任务进 queued,removeTask 触发出队)。
   */
  async submitBatch(parentId: string, picks: BatchPick[]): Promise<void> {
    const parent = this.tasks.get(parentId)
    const resolved = this.resolvedMap.get(parentId)
    if (!parent || !resolved || resolved.kind !== 'playlist') {
      console.error(`[TaskManager] submitBatch 非法:父任务 ${parentId} 无 playlist 解析结果,已忽略`)
      return
    }

    const dir = dirname(parent.savePath)
    // 父任务目录来自 addTask(input.dir ?? defaultDir):默认预填 defaultDir → 子任务走分类路由,
    // 用户自定义目录 → 显式优先(整批落同一显式目录,§5.1 / §5.2)
    const explicitDir = this.explicitDirOf(dir)
    // createdAt 按 pick 顺序递增 → 出队 FIFO 保持 playlist 次序(dequeueNext 按 createdAt 升序)
    const baseTime = Date.now()
    // 批量查重(§4.2 / §6.2):有冲突的子任务不建、聚合入 batchItems,待一个 batch 事件决策
    const batchItems: BatchPendingItem[] = []
    let conflictIndex = 0

    picks.forEach((pick, i) => {
      try {
        const entry = resolved.entries[pick.entryIndex]
        if (!entry) {
          console.error(
            `[TaskManager] submitBatch:entryIndex ${pick.entryIndex} 越界(共 ${resolved.entries.length} 条),跳过`
          )
          return
        }
        const submit = buildFormatSelector(pick.choice)
        const postProcess = pick.choice.audioOnly ? 'mp3' : submit.mergeFormat ? 'merge' : 'none'
        const base = sanitizeBasename(entry.title) || `video-${entry.id}`
        const tag = qualityTag(pick.choice)
        const named = tag ? `${base} [${tag}]` : base
        const filename = `${named}.${predictExt(pick.choice)}`
        // 每子任务按自身 filename 分类路由 + ensureDir(各自独立目录,§5.2);目录失败 → 该子任务落 error
        const routed = this.routeForFilename(filename, explicitDir)
        const id = this.generateId()
        const videoMeta: VideoMeta = {
          title: entry.title,
          selectedFormat: submit.formatSelector,
          postProcess,
          playlistIndex: pick.entryIndex,
          // 批量无逐条解析 format → 仅按 choice(仅音频 / heightCap / 兜底)算友好清晰度(§3.1)
          qualityLabel: qualityLabelOf(pick.choice)
        }
        // 批量字幕来源(v0.2 §3.4):--flat-playlist 无逐条字幕,用批量对话框统一的 pick.choice.subtitles
        // (当前批量统一,由默认偏好初始化);有选择才写,无 → 零回归
        if (pick.choice.subtitles) {
          videoMeta.subtitle = pick.choice.subtitles
        }
        const child: Task = {
          id,
          kind: 'video',
          source: entry.url,
          status: routed.error ? 'error' : 'queued', // 跳过逐条 resolving:策略选择器无需父级 formats
          filename,
          savePath: routed.savePath,
          category: routed.category,
          totalBytes: 0,
          downloadedBytes: 0,
          speed: 0,
          videoMeta,
          torrentMeta: null,
          error: routed.error,
          createdAt: baseTime + i,
          startedAt: null,
          completedAt: null
        }
        // 逐条查重(注入历史 + 磁盘):无冲突照常建;有冲突入 batch pending(不建,待决策);error 态不查重。
        const item = routed.error
          ? null
          : this.detectConflictFor('video', child.source, dirname(child.savePath), child.filename)
        if (item) {
          item.index = conflictIndex++
          batchItems.push({ index: item.index, childTask: child, item })
        } else {
          insertTask(this.db, child)
          this.tasks.set(id, child)
        }
      } catch (err) {
        // 单条建子任务失败隔离:记日志,不影响其他子任务(§7.4 崩溃隔离)
        console.error(
          `[TaskManager] submitBatch 子任务创建失败(entryIndex=${pick.entryIndex}),已隔离:`,
          err
        )
      }
    })

    if (batchItems.length > 0) {
      // 有冲突:非冲突子任务已入库 → 先出队补足;冲突聚合为一个 batch 事件;父占位**待 resolve 后**
      // 才 removeTask(§6.2),故此处不移除父任务(它留在 awaiting_selection,不参与出队)。
      await this.triggerDequeue()
      this.pendingConflicts.set(parentId, { kind: 'batch', parentId, items: batchItems })
      this.emitDuplicate({
        conflictId: parentId,
        kind: 'batch',
        items: batchItems.map((b) => b.item)
      })
      return
    }

    // 无冲突:原样移除父占位任务(removeTask 内部已 triggerDequeue,逐字节等价 v0.1,零回归)。
    await this.removeTask(parentId)
  }

  /** 异步解析视频元信息(不阻塞 addTask 返回);成功 → onResolved,失败 → onResolveError(§4.4.1) */
  private triggerResolve(id: string): void {
    const task = this.tasks.get(id)
    if (!task) {
      return
    }
    if (!this.videoResolver) {
      this.onResolveError(id, new Error('视频解析器未配置(请稍后重试)'))
      return
    }
    // 审计#1(spec §6):每个 resolving 任务建 AbortController + 墙钟总超时(慢站 / 代理黑洞不永久 resolving);
    // 传真 signal 给 resolve(接活既有 AbortSignal 管线 → ytdlpProcess 树杀防 orphan);settle(成功 / 失败 /
    // 超时)清 timer + controller;删除任务经 abortResolve 中止(防孤儿 yt-dlp -J 进程)。
    const controller = new AbortController()
    this.resolveControllers.set(id, controller)
    const ms = this.opts.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), ms)
    timer.unref?.()
    const settle = (): void => {
      clearTimeout(timer)
      if (this.resolveControllers.get(id) === controller) {
        this.resolveControllers.delete(id)
      }
    }
    this.videoResolver
      // 接管 / 嗅探来源的请求头(v0.4 Task 5 · spec §4.5 第 6 处):防盗链站点在 yt-dlp
      // 拉 m3u8 清单那一步就会 403,故解析阶段也要带。
      // `task.headers` 缺省 undefined → 恒产 `[]` → 与改动前逐字节等价(I-06 钉死)。
      // ⚠️ 设计期预计本文件只改这一处,实际是**两处** —— `VideoResolverLike` 这个接口就声明在
      //    本文件顶部,不放宽它这一行根本编译不过。第二处纯属类型放宽(加可选参),零行为改动。
      .resolve(task.source, controller.signal, task.headers)
      .then((result) => {
        settle()
        this.onResolved(id, result)
      })
      .catch((err) => {
        settle()
        this.onResolveError(id, err)
      })
  }

  /** 中止进行中的视频解析(审计#1 · spec §6):删除 resolving 任务时调,abort → ytdlpProcess 树杀 → 无孤儿 -J 进程 */
  private abortResolve(id: string): void {
    const controller = this.resolveControllers.get(id)
    if (controller) {
      controller.abort()
      this.resolveControllers.delete(id)
    }
  }

  /** 解析完成:单视频按默认清晰度自动选 or 待选;playlist → 待选(批量,spec §4.4.2) */
  private onResolved(id: string, result: ResolveResult): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'resolving') {
      // 任务可能已被 remove / 已离开解析态(幂等保护)
      return
    }
    this.resolvedMap.set(id, result)

    // playlist → 批量对话框(§7);父任务进 awaiting_selection,写 playlist 标题
    if (result.kind === 'playlist') {
      this.transition(task, 'awaiting_selection', {
        videoMeta: this.makeTitleMeta(task, result.title)
      })
      this.broadcast(task)
      return
    }

    // 单视频:读默认清晰度占位 → 自动选(跳过对话框)or 待选(§4.4.2 / §6.5)
    const autoChoice = this.autoSelectChoice(this.getVideoPrefs())
    if (autoChoice) {
      this.applySelection(id, autoChoice) // resolving → queued(applySelection 写完整 videoMeta)
      this.triggerDequeue().catch((err) => console.error('[TaskManager] 自动选后出队失败:', err))
      return
    }
    this.transition(task, 'awaiting_selection', {
      videoMeta: this.makeTitleMeta(task, result.title)
    })
    this.broadcast(task)
  }

  /** 解析失败 → error,落可读中文(VideoResolver 已经 mapResolveError 映射,§4.4.2) */
  private onResolveError(id: string, err: unknown): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'resolving') {
      return
    }
    this.transition(task, 'error', { error: this.toErrorMessage(err) })
    this.broadcast(task)
  }

  /** 默认清晰度占位 → FormatChoice(null = 每次询问 → 弹对话框,§6.5) */
  private autoSelectChoice(prefs: VideoPrefs): FormatChoice | null {
    if (prefs.defaultAudioOnly) {
      // 仅音频提取不配字幕(v0.2 §5.1 简化,与 FormatDialog audioOnly 隐藏字幕区一致)
      return { audioOnly: true }
    }
    if (prefs.defaultHeight !== null) {
      // 默认清晰度自动选跳过对话框:并入默认字幕偏好(v0.2 §3.4),使自动选也带默认字幕;
      // prefs.subtitle 未配置 → undefined → applySelection 不写 videoMeta.subtitle(零回归)
      return { audioOnly: false, heightCap: prefs.defaultHeight, subtitles: prefs.subtitle }
    }
    return null
  }

  /**
   * 选定(用户 / 自动)→ 写 videoMeta.selectedFormat/postProcess + 重算 filename(清洗 §7.7)+ queued。
   * 不在此 triggerDequeue(由调用方:selectFormat 显式 await / onResolved 自动选 fire-and-forget),spec §4.4.3。
   * 落点(含清晰度)定后查重(§6.2):命中则 parked(不 queue)、交决策——自动选分支从 resolving 转
   * awaiting_selection(**不静默 queued 致 0B**),用户选分支保持 awaiting_selection。
   */
  private applySelection(id: string, choice: FormatChoice): void {
    const task = this.tasks.get(id)
    if (!task) {
      return
    }
    // 合法触发态:awaiting_selection(用户选)或 resolving(默认清晰度自动选)
    if (task.status !== 'awaiting_selection' && task.status !== 'resolving') {
      console.error(`[TaskManager] selectFormat 非法:任务 ${id} 状态 ${task.status},已忽略`)
      return
    }

    const { videoMeta, filename } = this.buildVideoPlan(task, choice)
    // 分类保存路由(§5.2):filename(predictExt)定后判定 category + 目录 + ensureDir。
    // 当前 dir 来自 addTask(input.dir ?? defaultDir):默认预填 defaultDir → 走分类,用户自定义目录 → 显式优先。
    const routed = this.routeForFilename(filename, this.explicitDirOf(dirname(task.savePath)))
    if (routed.error) {
      // 目录创建失败(§5.3):落 error(可读提示 + 可重试),不入队
      this.transition(task, 'error', {
        videoMeta,
        filename,
        savePath: routed.savePath,
        category: routed.category,
        error: routed.error
      })
      this.broadcast(task)
      return
    }

    // 视频查重(spec §6.2):真实落点目录(dirname(routed.savePath))+ 清晰度已定 → 检测;命中则 parked。
    // 排除自身(task.savePath 尚为占位、一般不自匹配,excludeId 双保险)。
    const item = this.detectConflictFor(
      'video',
      task.source,
      dirname(routed.savePath),
      filename,
      id
    )
    if (item) {
      if (task.status === 'resolving') {
        // 自动选分支:resolving → awaiting_selection(复用既有合法态,不静默 queued,§6.2)
        this.transition(task, 'awaiting_selection', {
          videoMeta: this.makeTitleMeta(task, videoMeta.title)
        })
      }
      this.pendingConflicts.set(id, { kind: 'video', taskId: id, choice, item })
      this.emitDuplicate({ conflictId: id, kind: 'video', items: [item] })
      this.broadcast(task)
      return
    }

    this.transition(task, 'queued', {
      videoMeta,
      filename,
      savePath: routed.savePath,
      category: routed.category
    })
    this.broadcast(task)
  }

  /**
   * 由 FormatChoice 计算视频 videoMeta + filename(applySelection / resolveDuplicate 共用;**不含**
   * detection / 路由 / 落库)。标题清洗(§7.7)+ 清晰度标签(避免同视频不同清晰度同名覆盖 / 跳过)+
   * 预测 ext(最终以 yt-dlp 终路径校正,§4.3);字幕选择随 choice 承载(§4.2,有选择才写)。
   */
  private buildVideoPlan(
    task: Task,
    choice: FormatChoice
  ): { videoMeta: VideoMeta; filename: string } {
    const resolved = this.resolvedMap.get(task.id)
    const resolvedVideo = resolved?.kind === 'video' ? resolved : undefined
    // 手选具体 format(供 buildFormatSelector / predictExt;逐字节不变,自动 / 最高时为 undefined)
    const selectedFormat: ResolvedFormat | undefined =
      choice.formatId && resolvedVideo
        ? resolvedVideo.formats.find((f) => f.formatId === choice.formatId)
        : undefined
    const submit = buildFormatSelector(choice, selectedFormat)
    const postProcess = choice.audioOnly ? 'mp3' : submit.mergeFormat ? 'merge' : 'none'
    const title = resolvedVideo ? resolvedVideo.title : (task.videoMeta?.title ?? task.filename)
    const base = sanitizeBasename(title) || sanitizeBasename(task.filename) || `video-${task.id}`
    // #30 清晰度归一 + #24 protocol 判定共用「命名 format」:手选 format ?? 自动 / 最高 / cap 归一到实际最高 height 的 format。
    // **仅供 qualityTag / qualityLabelOf(标签)+ protocol(fragmented)**,绝不喂 buildFormatSelector / predictExt
    // (那会改下载选择器 / 预测 ext);audioOnly / 批量无 formats / cap 排除所有 → undefined(标签回落原「最高」,诚实盲区 §5)。
    const namingFormat =
      selectedFormat ??
      (!choice.audioOnly && resolvedVideo
        ? this.topFormatOf(resolvedVideo.formats, choice.heightCap)
        : undefined)
    const tag = qualityTag(choice, namingFormat)
    const named = tag ? `${base} [${tag}]` : base
    const filename = `${named}.${predictExt(choice, selectedFormat)}`
    const videoMeta: VideoMeta = {
      title,
      selectedFormat: submit.formatSelector,
      postProcess,
      playlistIndex: task.videoMeta?.playlistIndex ?? -1,
      qualityLabel: qualityLabelOf(choice, namingFormat)
    }
    // #24(spec §2):选中 / 归一 format 的 protocol → fragmented(HLS/DASH → true,VideoEngine 不挂 aria2c);
    // 仅确认分片才存 true,progressive / 未知 / 无 formats → 不存(undefined = 保守挂 aria2c + 回退,§7.1 不退化)
    if (isFragmentedProtocol(namingFormat?.protocol)) {
      videoMeta.fragmented = true
    }
    if (choice.subtitles) {
      videoMeta.subtitle = choice.subtitles
    }
    return { videoMeta, filename }
  }

  /**
   * #30 / #24(spec §5 / §2):choice 无具体 formatId(自动 / 最高 / cap)时,取 `resolved.formats` 中
   * ≤cap 实际最高 height 的 format —— 供命名标签归一为具体 `${height}p`(与手选同 height 一致 → 查重命中)
   * 及 protocol 判分片(fragmented)。无有效 height(纯音频 / cap 排除所有)→ undefined(命名回落原「最高」)。
   */
  private topFormatOf(formats: ResolvedFormat[], heightCap?: number): ResolvedFormat | undefined {
    const top = resolvedTopHeight(formats, heightCap)
    return top != null ? formats.find((f) => f.height === top) : undefined
  }

  // ========== 查重接入 / 决策落地(spec §4.1 / §6.2)==========

  /**
   * 三创建路径共用的查重(候选集经 `findBySource` 取同源历史 / 注入 this.fileExists / this.readDir);
   * 命中返回冲突项,否则 null。`excludeId` 排除自身(视频 applySelection 时任务已在内存)。
   * **只读历史**(detectConflict 不写 tasks,§7.3)。
   *
   * #29(v0.3 Task 4 · spec §4):候选集从「`[...this.tasks.values()]` 全量内存拷贝」收窄为
   * 「`WHERE source = ?` 同源命中」(走 migration v4 的 `idx_tasks_source`)。**语义等价**依据:
   * ① 纯函数首条判据就是 `t.source !== source continue`,非同源行本就不参与判定,收窄不改结果;
   * ② 内存与 DB 的 id 集恒一致(每处 `this.tasks.set` 前必 `insertTask`、`this.tasks.delete` 与
   *    `deleteTask` 成对;批量 parked 子任务两侧同样都还没有),故「同源候选」两侧同集;
   * ③ 每行以 `this.tasks.get(row.id) ?? row` 取**内存 runtime 态**——状态流转先改内存、仅关键节点落库,
   *    DB 可能滞后,内存才是权威;这保证 `active`(非终态)/ `completed` 判定与原全量内存扫描逐条一致。
   */
  private detectConflictFor(
    kind: 'http' | 'video',
    source: string,
    dir: string,
    filename: string,
    excludeId?: string
  ): DuplicateConflictItem | null {
    const { stem, ext } = splitExt(filename)
    const historyTasks: Task[] = []
    for (const row of findBySource(this.db, source)) {
      if (row.id === excludeId) continue
      historyTasks.push(this.tasks.get(row.id) ?? row)
    }
    return detectConflict({
      kind,
      source,
      dir,
      stem,
      ext,
      historyTasks,
      fileExists: this.fileExists,
      listDir: this.readDir
    })
  }

  /** 只比较应用持有的目标路径,不扩张 duplicateDetect 的同源语义。 */
  private httpPathKey(path: string): string {
    const absolute = resolve(path)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }

  /** A new HTTP download owns both its data name and its native control name. */
  private httpOutputFiles(path: string): readonly string[] {
    return [path, path + '.aria2']
  }

  private httpFileBusy(path: string, excludeId?: string): boolean {
    const key = this.httpPathKey(path)
    const reserved = this.httpOverwritePaths.get(key)
    if (reserved !== undefined && reserved !== excludeId) return true
    for (const task of this.tasks.values()) {
      if (task.id === excludeId) continue
      if (
        task.status === 'error' ||
        (task.status === 'completed' && !this.seedingTasks.has(task.id))
      )
        continue
      const owned = task.kind === 'http' ? this.httpOutputFiles(task.savePath) : [task.savePath]
      if (owned.some((file) => this.httpPathKey(file) === key)) return true
    }
    return false
  }

  private httpPathBusy(path: string, excludeId?: string): boolean {
    return this.httpOutputFiles(path).some((file) => this.httpFileBusy(file, excludeId))
  }

  private detectHttpConflict(task: Task): DuplicateConflictItem | null {
    if (this.httpPathBusy(task.savePath, task.id)) {
      return {
        index: 0,
        filename: task.filename,
        qualityLabel: null,
        existingDir: dirname(task.savePath),
        existingPath: null,
        existing: 'active'
      }
    }
    return this.detectConflictFor(
      'http',
      task.source,
      dirname(task.savePath),
      task.filename,
      task.id
    )
  }

  private assignAvailableHttpName(task: Task): void {
    const dir = dirname(task.savePath)
    const { stem, ext } = splitExt(task.filename)
    const newStem = nextAvailableStem(stem, ext, (candidate) => {
      const filename = candidate + ext
      const path = join(dir, filename)
      return (
        this.httpPathBusy(path, task.id) ||
        this.fileExists(path + '.aria2') ||
        this.detectConflictFor('http', task.source, dir, filename, task.id) !== null
      )
    })
    task.filename = newStem + ext
    task.savePath = join(dir, task.filename)
  }

  /** 覆盖不是 best-effort 清理:任何回收失败都不得提交,更不能消费遗留 control。 */
  private async trashForHttpOverwrite(file: string): Promise<void> {
    // The caller has already checked and reserved this exact file, including every companion.
    if (!this.fileExists(file)) return
    await this.trashItem(file)
    if (this.fileExists(file)) throw new Error('覆盖失败:文件仍被占用,请稍后重试')
  }

  /**
   * 覆盖决策:把**被覆盖的旧完成记录**从列表 / DB 移除(spec §2.2 / §4.1,2026-07-12 手测反馈)。
   *
   * 覆盖后新任务与旧完成记录**指向同一 savePath**,若不清理则列表留两条同路径完成记录(旧那条文件
   * 已入回收站、成僵尸重复)。此处对同 savePath 的 completed 记录 `removeTask(deleteFile:false)`——
   * **仅移记录、不删文件**(文件已由覆盖流程 `trashIfExists` 入回收站可恢复;completed + deleteFile:false
   * 时 `cleanupTaskFiles` 早退不碰磁盘)。**仅 completed 命中执行**(diskOnly 无记录、active 进行中任务不动);
   * 是用户主动覆盖操作的一部分(非静默丢弃),不违反 §7.3。
   */
  private async removeOverwrittenRecord(item: DuplicateConflictItem): Promise<void> {
    if (item.existing !== 'completed' || !item.existingPath) {
      return
    }
    const targetPath = item.existingPath
    const stale = [...this.tasks.values()].filter(
      (t) => t.status === 'completed' && t.savePath === targetPath
    )
    for (const t of stale) {
      await this.removeTask(t.id, { deleteFile: false })
    }
  }

  /**
   * 用户决策落地(spec §4.1):overwrite(旧文件入回收站 → 建)/ rename(序号 → 建)/ skip(丢弃)/
   * open(渲染层打开,主进程只清 pending / 不建)。覆盖走回收站不永久删、重命名双留、查重只读历史
   * (旧记录原样保留,§7.3)。conflictId 未知 → 忽略(幂等)。
   */
  async resolveDuplicate(res: DuplicateResolution): Promise<void> {
    const pending = this.pendingConflicts.get(res.conflictId)
    if (!pending) {
      console.error(`[TaskManager] resolveDuplicate 未知 conflictId ${res.conflictId},已忽略`)
      return
    }
    this.pendingConflicts.delete(res.conflictId)
    if (pending.kind === 'http') {
      try {
        await this.resolveHttpConflict(pending.task, pending.item, res.decision)
      } catch (err) {
        // 未建任务时保留待决策项,允许用户改选 rename/skip,不吞错误。
        if (!this.tasks.has(pending.task.id)) this.pendingConflicts.set(res.conflictId, pending)
        throw err
      }
    } else if (pending.kind === 'video') {
      await this.resolveVideoConflict(pending.taskId, pending.choice, pending.item, res.decision)
    } else {
      await this.resolveBatchConflict(pending, res)
    }
  }

  /** 直链决策:overwrite 先 trash 旧文件 → 建 + 出队;rename 序号重算 → 建;skip/open 不建(open 由渲染层打开 existingPath) */
  private async resolveHttpConflict(
    task: Task,
    item: DuplicateConflictItem,
    decision: DuplicateDecision
  ): Promise<void> {
    if (decision === 'skip' || decision === 'open') {
      return
    }
    const overwritePaths = new Map<string, string>()
    try {
      if (decision === 'overwrite') {
        for (const path of [item.existingPath, task.savePath]) {
          if (!path) continue
          for (const file of this.httpOutputFiles(path)) {
            overwritePaths.set(this.httpPathKey(file), file)
          }
        }
        if ([...overwritePaths.values()].some((file) => this.httpFileBusy(file, task.id))) {
          throw new Error('该路径正被另一个下载任务使用,请重新添加并选择重命名或稍后重试')
        }
        // 旧完成记录可能同 stem 不同 ext;完整 data/control 集合先预约,再开始 await。
        for (const key of overwritePaths.keys()) this.httpOverwritePaths.set(key, task.id)
        for (const path of overwritePaths.values()) await this.trashForHttpOverwrite(path)
        await this.removeOverwrittenRecord(item)
      } else {
        this.assignAvailableHttpName(task)
      }
      insertTask(this.db, task)
      this.tasks.set(task.id, task)
      await this.triggerDequeue()
    } finally {
      for (const key of overwritePaths.keys()) {
        if (this.httpOverwritePaths.get(key) === task.id) this.httpOverwritePaths.delete(key)
      }
    }
  }

  /** 视频决策:overwrite trash 旧文件 → queued;rename 序号 → queued;skip/open → removeTask(不建) */
  private async resolveVideoConflict(
    taskId: string,
    choice: FormatChoice,
    item: DuplicateConflictItem,
    decision: DuplicateDecision
  ): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return
    }
    if (decision === 'skip' || decision === 'open') {
      // 丢弃 parked:任务(awaiting_selection,startedAt=null)removeTask,cleanupTaskFiles 早退零磁盘改动
      await this.removeTask(taskId)
      return
    }
    // 重算落点(不再 detect,避免覆盖 trash 后 / active 命中的循环 re-park);真实目标目录 = dirname(routed.savePath)
    const { videoMeta, filename } = this.buildVideoPlan(task, choice)
    const routed = this.routeForFilename(filename, this.explicitDirOf(dirname(task.savePath)))
    if (routed.error) {
      this.transition(task, 'error', {
        videoMeta,
        filename,
        savePath: routed.savePath,
        category: routed.category,
        error: routed.error
      })
      this.broadcast(task)
      return
    }
    const targetDir = dirname(routed.savePath)
    let finalName = filename
    let finalSavePath = routed.savePath
    if (decision === 'overwrite') {
      if (item.existingPath) {
        await this.trashIfExists(item.existingPath)
      }
      await this.removeOverwrittenRecord(item)
    } else {
      const { stem, ext } = splitExt(filename)
      const newStem = nextAvailableStem(
        stem,
        ext,
        (cand) =>
          this.detectConflictFor('video', task.source, targetDir, cand + ext, taskId) !== null
      )
      finalName = newStem + ext
      finalSavePath = join(targetDir, finalName)
    }
    this.transition(task, 'queued', {
      videoMeta,
      filename: finalName,
      savePath: finalSavePath,
      category: routed.category
    })
    this.broadcast(task)
    await this.triggerDequeue()
  }

  /**
   * 批量决策(逐条 perItem 继承整体 decision):跳过 / 打开不建;覆盖 trash 旧文件 + 建;重命名序号 + 建;
   * 全部处理完出队补足后,再移除父占位任务(§6.2:父占位待批量决策全部处理后 removeTask)。
   */
  private async resolveBatchConflict(
    pending: { parentId: string; items: BatchPendingItem[] },
    res: DuplicateResolution
  ): Promise<void> {
    for (const entry of pending.items) {
      const decision = res.perItem?.[entry.index] ?? res.decision
      if (decision === 'skip' || decision === 'open') {
        continue
      }
      let child = entry.childTask
      if (decision === 'overwrite') {
        if (entry.item.existingPath) {
          await this.trashIfExists(entry.item.existingPath)
        }
        await this.removeOverwrittenRecord(entry.item)
      } else {
        const dir = dirname(child.savePath)
        const { stem, ext } = splitExt(child.filename)
        const newStem = nextAvailableStem(
          stem,
          ext,
          (cand) => this.detectConflictFor('video', child.source, dir, cand + ext) !== null
        )
        child = { ...child, filename: newStem + ext, savePath: join(dir, newStem + ext) }
      }
      insertTask(this.db, child)
      this.tasks.set(child.id, child)
    }
    await this.triggerDequeue()
    // 父占位待批量决策全部处理后移除(§6.2);removeTask 内部再 triggerDequeue
    await this.removeTask(pending.parentId)
  }

  /** 解析成功但待选时的占位 videoMeta(只写 title,selectedFormat 待选定时填) */
  private makeTitleMeta(task: Task, title: string): VideoMeta {
    return {
      title,
      selectedFormat: '',
      postProcess: 'none',
      playlistIndex: task.videoMeta?.playlistIndex ?? -1
    }
  }

  // ========== 查询 ==========

  /** 内存 + DB 合并:历史来自 DB,活动任务瞬时进度(downloadedBytes / totalBytes / speed)覆盖自内存 */
  listTasks(filter: TaskFilter = {}): Task[] {
    return daoListTasks(this.db, filter).map((row) => {
      const mem = this.tasks.get(row.id)
      if (!mem) {
        return row
      }
      return {
        ...row,
        downloadedBytes: mem.downloadedBytes,
        totalBytes: mem.totalBytes,
        speed: activeSpeed(mem),
        limitKBps: mem.limitKBps
      }
    })
  }

  getTask(id: string): Task | null {
    const mem = this.tasks.get(id)
    if (mem) {
      return { ...mem }
    }
    return daoGetTask(this.db, id)
  }

  /** 订阅进度推送,返回退订函数(暴露给 IPC) */
  onProgress(callback: (progress: TaskProgress) => void): () => void {
    this.progressCallbacks.add(callback)
    return () => {
      this.progressCallbacks.delete(callback)
    }
  }

  /** 订阅查重冲突推送,返回退订函数(暴露给 IPC;仿 onProgress,Phase 3 转 task:duplicate 广播) */
  onDuplicate(callback: (conflict: DuplicateConflict) => void): () => void {
    this.duplicateCallbacks.add(callback)
    return () => {
      this.duplicateCallbacks.delete(callback)
    }
  }

  /** 遍历查重回调广播冲突详情;单回调失败隔离(try/catch,不崩) */
  private emitDuplicate(conflict: DuplicateConflict): void {
    for (const callback of this.duplicateCallbacks) {
      try {
        callback(conflict)
      } catch (err) {
        console.error('[TaskManager] 查重冲突回调失败:', err)
      }
    }
  }

  // ========== 内部:引擎进度接收 ==========

  private handleEngineProgress(progress: DownloadProgress): void {
    const id = this.engineIdToTaskId.get(progress.id)
    if (!id) {
      return
    }
    const task = this.tasks.get(id)
    if (!task) {
      return
    }

    // HTTP 的 files.path 是原生实际输出(含自动序号)。清洗已在提交前完成,此处不可再改名
    // 否则 DB 会指向并不存在的文件;仅校正元信息,不移动目录或控制文件。
    if (task.kind === 'http' && progress.savePath) {
      // aria2 uses '/' on Windows; keep the platform representation used by existing history matching.
      const savePath = normalize(progress.savePath)
      if (savePath !== task.savePath) {
        const filename = basename(savePath)
        this.applyAndPersist(task, {
          filename,
          savePath,
          category: categorize(filename, this.extIndex)
        })
      }
    }

    // 瞬时进度只更新内存(§4.1)
    task.downloadedBytes = progress.downloadedBytes
    // totalBytes=0 的过渡帧(BT unpause 后 piece 存储未就绪等瞬时窗口)不清已知总大小:
    // 总大小一旦已知不回退「未知」(真机 2026-07-25 C1:选择提交后 UI 总大小显示「未知」)
    if (progress.totalBytes > 0) {
      task.totalBytes = progress.totalBytes
    }
    task.speed = progress.speed

    // torrent 元数据阶段(resolving,v0.3 §5.1):帧里的 totalBytes 是**元数据大小**,不落库
    // (真实 totalBytes 待 torrentInfo 一次性写,onTorrentInfo)
    const torrentResolving = task.kind === 'torrent' && task.status === 'resolving'

    // totalBytes 首次已知时一次性落库(aria2 返回后)
    if (progress.totalBytes > 0 && !torrentResolving && !this.totalPersisted.has(id)) {
      this.totalPersisted.add(id)
      updateTask(this.db, id, { totalBytes: progress.totalBytes })
    }

    // BT 元数据完成(v0.3 Task 1 · spec §5.1;Task 2 分流 · spec §2.2):resolving 期收到 torrentInfo →
    // 定 filename / savePath / totalBytes / torrentMeta,再按文件数分流(多文件 → awaiting_selection 待选;
    // 单文件 → queued + triggerDequeue,正式过并发闸门)——详见 onTorrentInfo。已离开 resolving(如崩溃重提
    // 后引擎再次发 torrentInfo)→ 落到下方普通帧处理,幂等忽略。
    if (torrentResolving && progress.torrentInfo) {
      this.onTorrentInfo(task, progress.torrentInfo)
      return
    }

    // ===== BT 做种生命周期(v0.3 Task 3 · spec §3)=====
    // 护栏:已 completed 的 torrent 帧(做种 active / 自然停 complete / paused)只更新 seeding runtime
    // + 广播富进度,**绝不再 transition**(杜绝 completed→paused 非法边;做种走 runtime,持久化仍 completed)。
    if (task.kind === 'torrent' && task.status === 'completed') {
      this.updateSeedingRuntime(task, progress)
      this.broadcast(task, progress)
      return
    }

    // 视频后处理阶段:downloading → processing(phase 仅 yt-dlp 后端设,不污染 aria2 契约,§4.3)
    if (progress.phase === 'processing' && task.status === 'downloading') {
      this.transition(task, 'processing', { downloadedBytes: progress.downloadedBytes })
      this.broadcast(task)
      return
    }

    // torrent 完成判定按字节(v0.3 Task 3 · spec §3):做种开档时 aria2 下载满后长期停在 active(mapped
    // downloading),不发 completed 帧;故 torrent 帧 downloadedBytes≥totalBytes>0 即判完成(http/video 仍等引擎
    // completed,零回归)。固化 completed(持久化终态)+ 做种 runtime + 收尾产物;做种中保留引擎映射供 stopSeeding。
    if (
      task.kind === 'torrent' &&
      (task.status === 'downloading' || task.status === 'processing') &&
      progress.totalBytes > 0 &&
      progress.downloadedBytes >= progress.totalBytes
    ) {
      this.transition(task, 'completed', {
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        completedAt: Date.now()
      })
      this.updateSeedingRuntime(task, progress)
      // 做种中保留引擎映射(stopSeeding 需 engineId 下发 forcePause);非做种(关档直下完成)清映射(仿普通完成)
      if (!this.seedingTasks.has(id)) {
        this.clearEngineMap(id)
      }
      this.broadcast(task, progress)
      void this.finalizeTorrentArtifacts(task) // 清 .aria2 + <infoHash>.torrent 更名(修订四;best-effort 不抛)
      this.triggerDequeue().catch((err) => console.error('[TaskManager] BT 完成后出队失败:', err))
      return
    }

    if (
      progress.status === 'completed' &&
      (task.status === 'downloading' || task.status === 'processing')
    ) {
      const updates: PersistableUpdates = {
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        completedAt: Date.now()
      }
      // yt-dlp 回报的真实终路径(ext / 名可能与预测不同)→ 校正 savePath / filename(§4.3);
      // 真实 ext 可能改变类别 → 一并重判 category 标签(savePath 已定不回迁,仅校正筛选标签,spec §3.4)
      // HTTP was normalized above, including its completed frame; do not overwrite it with raw '/'.
      if (task.kind !== 'http' && progress.savePath && progress.savePath !== task.savePath) {
        const correctedFilename = basename(progress.savePath)
        updates.savePath = progress.savePath
        updates.filename = correctedFilename
        updates.category = categorize(correctedFilename, this.extIndex)
      }
      this.transition(task, 'completed', updates)
      this.clearEngineMap(id)
      this.broadcast(task)
      // BT 完成收尾(2026-07-25 修订四,fire-and-forget 不阻塞进度处理):清 .aria2 +
      // <infoHash>.torrent 更名 <种子名>.torrent(迅雷式伴生);trashIfExists/更名均 best-effort 不抛
      if (task.kind === 'torrent') {
        void this.finalizeTorrentArtifacts(task)
      }
      this.triggerDequeue().catch((err) => console.error('[TaskManager] 完成后出队失败:', err))
      return
    }

    if (progress.status === 'error') {
      if (canTransition(task.status, 'error')) {
        this.transition(task, 'error', {
          // aria2 下载 errorCode(如磁力 12=相同 infoHash 已在下载)→ 友好中文,不再显示裸码(spec §4.3);
          // errorMessage 为 aria2 原文(码 1 unknown 时唯一说得清的信息)→ 一并透出(真机修订 2026-07-27 · §13)
          error: progress.errorCode
            ? mapAria2DownloadError(progress.errorCode, progress.errorMessage)
            : '下载失败',
          downloadedBytes: progress.downloadedBytes
        })
        this.clearEngineMap(id)
        this.broadcast(task)
        this.triggerDequeue().catch((err) => console.error('[TaskManager] 失败后出队失败:', err))
      }
      return
    }

    // 普通下载中进度:仅广播(不落库;connections / BT 富进度随帧透传,§4)
    this.broadcast(task, progress)
  }

  /**
   * BT 元数据完成落地(v0.3 Task 1 · spec §5.1 / §5.4;Task 2 分流 · spec §2.2):定 filename(sanitize
   * 后的 info.name)/ savePath(原 Torrents 目录 + name,改默认目录不回迁)/ totalBytes(首次一次性写库)/
   * torrentMeta 落库,再按**文件数分流**:
   * - **多文件(>1)**:停在 `awaiting_selection` 待用户勾选(`resolving→awaiting_selection` 复用现成边);
   * - **单文件(≤1)**:整包豁免 —— `resolving→queued` + `triggerDequeue`(经并发闸门,§2.2 / §2.4),
   *   等价 Task 1 整包直下(但现在如实过槽位闸门、如实占用并发槽)。
   * **不重发任何引擎命令**:aria2 经 pause-metadata/pause 已暂停 realGid,选定 / 单文件后经 `resume`(unpause)
   * 出队下载(§5);torrentMeta.files 初始 selected 全 true(全选默认,§2.3)。
   */
  private onTorrentInfo(task: Task, info: TorrentInfo): void {
    this.clearMetadataTimeout(task.id) // 元数据已到,硬超时解除(spec §4.3)
    const filename = sanitizeBasename(info.name) || task.filename
    const savePath = join(dirname(task.savePath), filename)
    const torrentMeta: TorrentMeta = { name: info.name, infoHash: info.infoHash, files: info.files }

    if (info.files.length > 1) {
      // 多文件:进 awaiting_selection 待选(元数据 totalBytes 首次一次性落库,同单文件路径)
      if (
        !this.transition(task, 'awaiting_selection', {
          filename,
          savePath,
          totalBytes: info.totalBytes,
          torrentMeta
        })
      ) {
        return
      }
      task.totalBytes = info.totalBytes
      this.totalPersisted.add(task.id)
      this.broadcast(task)
      return
    }

    // 单文件豁免(整包零回归):resolving→queued,经 triggerDequeue 出队 → resume(unpause) → downloading
    if (
      !this.transition(task, 'queued', {
        filename,
        savePath,
        totalBytes: info.totalBytes,
        torrentMeta
      })
    ) {
      return
    }
    task.totalBytes = info.totalBytes
    this.totalPersisted.add(task.id)
    this.broadcast(task)
    this.triggerDequeue().catch((err) => console.error('[TaskManager] 单文件种子出队失败:', err))
  }

  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §4.2 / §7):用户勾选(1-based 索引集)→ 定型
   * `torrentMeta.files[].selected`(单一真源,落既有 JSON 列,不改 schema)→ 引擎下发 `--select-file`
   * (暂停态合法;全选 arg=null 引擎跳过 changeOption)→ `awaiting_selection→queued` → 出队 `resume`(unpause)。
   * 校验:torrent + 有 torrentMeta + `awaiting_selection` + 非空选;否则记日志幂等忽略(防呆)。
   */
  async applyTorrentSelection(id: string, selectedIndices: number[]): Promise<void> {
    const task = this.tasks.get(id)
    if (!task || task.kind !== 'torrent' || !task.torrentMeta) {
      console.error(
        `[TaskManager] applyTorrentSelection 非法:任务 ${id} 非 torrent 或无 torrentMeta,已忽略`
      )
      return
    }
    if (task.status !== 'awaiting_selection') {
      console.error(
        `[TaskManager] applyTorrentSelection 非法:任务 ${id} 状态 ${task.status}(非 awaiting_selection),已忽略`
      )
      return
    }
    if (selectedIndices.length === 0) {
      console.error(`[TaskManager] applyTorrentSelection 空选:任务 ${id} 未选任何文件,已忽略`)
      return
    }
    const files = applyFileSelection(task.torrentMeta.files, selectedIndices)
    const arg = selectFileArg(files) // null = 全选
    const torrentMeta: TorrentMeta = { ...task.torrentMeta, files }
    // 会话内 gid 存活 → 暂停态下发 select-file(全选 arg=null 引擎跳过);gid 丢失(崩溃 / 重启)由
    // rebuildTorrentSubmit 重建 --select-file(§4.3)
    const engineId = this.taskIdToEngineId.get(id)
    if (engineId) {
      await this.engine.applyTorrentSelection?.(engineId, arg)
    }
    this.transition(task, 'queued', { torrentMeta }) // 落 torrentMeta(不改 schema)
    this.broadcast(task)
    await this.triggerDequeue() // 有槽 → resume(unpause) → 只下选中
  }

  // ========== 内部:并发控制与引擎下发 ==========

  /** 出队:有空位则从 queued 按 FIFO 启动,流转 queued → downloading + 落库 */
  private async triggerDequeue(): Promise<void> {
    const { toStart } = dequeueNext([...this.tasks.values()], this.maxConcurrent)
    if (toStart.length === 0) {
      return
    }

    // 同步预占槽位:把待启动任务内存态先置 downloading,避免 await 期间重入重复出队
    for (const planned of toStart) {
      const task = this.tasks.get(planned.id)
      if (task) {
        task.status = 'downloading'
      }
    }

    await Promise.all(toStart.map((planned) => this.startReserved(planned.id)))
  }

  /**
   * 启动一个已预占(内存态 downloading)的任务:落库 + 提交引擎。
   * 本会话已有引擎任务(曾下载 / 暂停过,如满槽 resume 转 queued 的任务)→ `engine.resume` 复用进度,
   * 避免 `addUri` 新建导致引擎从头下载 / 留孤儿任务;首次出队(无映射)→ `addUri` 提交(修复④续)。
   */
  private async startReserved(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) {
      return
    }

    try {
      let engineId = this.taskIdToEngineId.get(id)
      if (engineId) {
        await this.engine.resume(engineId)
      } else {
        engineId = await this.engine.addUri(this.toAddUriInput(task))
        if (!this.tasks.has(id)) {
          // await 窗口内被删除:彼时尚无引擎映射,removeTask 无从通知引擎 → 刚建的引擎任务是
          // 孤儿(会持续写盘),就地补删 + 清残留(startedAt 置非空副本以通过「从未提交引擎」守卫)
          await this.engine
            .remove(engineId)
            .catch((err) => console.error(`[TaskManager] 补删引擎孤儿任务失败 ${id}:`, err))
          await this.cleanupTaskFiles({ ...task, startedAt: Date.now() }, false)
          return
        }
        this.mapEngine(id, engineId)
      }
      // await 窗口内被暂停 / 删除时不得无条件写回 downloading(吞掉用户操作 + 并发超额):
      // 删除 → 到此为止(引擎已由 removeTask 经映射通知);暂停 → 引擎侧补 pause 对齐后保持 paused
      if (!this.tasks.has(id)) {
        return
      }
      if (task.status !== 'downloading') {
        await this.engine
          .pause(engineId)
          .catch((err) => console.error(`[TaskManager] 窗口期暂停对齐失败 ${id}:`, err))
        return
      }
      this.applyAndPersist(task, {
        status: 'downloading',
        startedAt: task.startedAt ?? Date.now()
      })
      this.broadcast(task)
    } catch (err) {
      // 提交失败 → error(预占的 downloading 直接落为 error);出队补足,防止剩余 queued 卡等
      // 下一个无关事件(与 startOnEngine 的 catch 行为一致;失败任务已转 error,不会循环重试)
      this.applyAndPersist(task, { status: 'error', error: this.toErrorMessage(err) })
      this.broadcast(task)
      await this.triggerDequeue()
    }
  }

  /** resume 路径:有 gid 优先 engine.resume,否则重新 addUri(重启后 paused 无 gid 走此路) */
  private async startOnEngine(task: Task, preferResume: boolean): Promise<void> {
    const engineId = this.taskIdToEngineId.get(task.id)
    try {
      if (preferResume && engineId) {
        await this.engine.resume(engineId)
      } else {
        const newId = await this.engine.addUri(this.toAddUriInput(task))
        this.mapEngine(task.id, newId)
      }
      this.transition(task, 'downloading', { startedAt: task.startedAt ?? Date.now() })
      this.broadcast(task)
    } catch (err) {
      this.transition(task, 'error', { error: this.toErrorMessage(err) })
      this.broadcast(task)
      await this.triggerDequeue()
    }
  }

  /** 重启恢复重提交:只传业务信息,续传交 aria2 `.aria2`(§7.4),不自存字节进度 */
  private async recoverSubmit(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) {
      return
    }
    // torrent 的 resolving = 元数据未完成即退出(v0.3 §6.3):重提引擎续取元数据后**保持 resolving**
    // (followedBy 再次转移、torrentInfo 到达才流转),不归一化为 downloading
    const keepResolving = task.kind === 'torrent' && task.status === 'resolving'
    try {
      const engineId = await this.engine.addUri(this.toAddUriInput(task))
      this.mapEngine(id, engineId)
      if (keepResolving) {
        this.applyAndPersist(task, { startedAt: task.startedAt ?? Date.now() })
        this.armMetadataTimeout(task) // 恢复重提仍在取元数据 → 重挂硬超时(spec §4.3)
      } else {
        // 恢复期归一化为 downloading(load-time,非用户流转,故直接 applyAndPersist)
        this.applyAndPersist(task, {
          status: 'downloading',
          startedAt: task.startedAt ?? Date.now()
        })
      }
      this.broadcast(task)
    } catch (err) {
      this.applyAndPersist(task, { status: 'error', error: this.toErrorMessage(err) })
      this.broadcast(task)
    }
  }

  // ========== 内部:状态流转 / 持久化 / 广播 ==========

  /** 校验合法流转 → 内存更新 + 落库;非法流转记日志并返回 false(不崩) */
  private transition(task: Task, to: TaskStatus, updates: PersistableUpdates = {}): boolean {
    if (!canTransition(task.status, to)) {
      console.error(`[TaskManager] 非法状态流转 ${task.status} -> ${to}(任务 ${task.id}),已忽略`)
      return false
    }
    this.applyAndPersist(task, { status: to, ...updates })
    return true
  }

  /** 内存更新 + 落库(updateTask 内部自动忽略非列字段如 speed / id) */
  private applyAndPersist(task: Task, updates: PersistableUpdates): void {
    Object.assign(task, updates)
    updateTask(this.db, task.id, updates)
  }

  /**
   * 依引擎帧的 seeding 派生位维护做种 runtime(v0.3 Task 3 · spec §3 / §4;**内存,不落库**):
   * progress.seeding 真 → 标记做种中(seedingTasks.add),假 / 未设 → 清除。仅对 torrent 生效。
   */
  private updateSeedingRuntime(task: Task, progress: DownloadProgress): void {
    if (task.kind !== 'torrent') return
    if (progress.seeding) {
      this.seedingTasks.add(task.id)
    } else {
      this.seedingTasks.delete(task.id)
    }
  }

  private broadcast(task: Task, live?: DownloadProgress): void {
    const progress: TaskProgress = {
      id: task.id,
      status: task.status,
      downloadedBytes: task.downloadedBytes,
      totalBytes: task.totalBytes,
      speed: activeSpeed(task),
      error: task.error ?? undefined,
      limitKBps: task.limitKBps
    }
    // 每个 HTTP 帧都携带当前路径,避免渲染批处理后帧覆盖前帧时吞掉 path-only 变更。
    if (task.kind === 'http') {
      progress.filename = task.filename
      progress.savePath = task.savePath
      progress.category = task.category
    }
    // BT 富进度透传(v0.3 Task 3 · spec §4;仅内存 + IPC,不落库):connections 对所有任务透传(帧携带才设);
    // numSeeders/uploadSpeed/uploadLength 仅 torrent 帧携带;seeding 仅 torrent、取 runtime 权威(seedingTasks)。
    if (live?.connections !== undefined) {
      progress.connections = live.connections
    }
    if (task.kind === 'torrent') {
      if (live?.numSeeders !== undefined) progress.numSeeders = live.numSeeders
      if (live?.uploadSpeed !== undefined) progress.uploadSpeed = live.uploadSpeed
      if (live?.uploadLength !== undefined) progress.uploadLength = live.uploadLength
      progress.seeding = this.seedingTasks.has(task.id)
    }
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress)
      } catch (err) {
        console.error('[TaskManager] 进度回调失败:', err)
      }
    }
  }

  // ========== 内部:辅助 ==========

  private toAddUriInput(task: Task): AddUriInput {
    // torrent 分支(v0.3 Task 1 · spec §6.2;Task 2 附 select-file / 待选标记 · spec §4.3):
    // magnet → 原样 source;.torrent → url 空(引擎读 base64 走 addTorrent)。torrent 载荷由
    // rebuildTorrentSubmit 组装(待选前 awaitSelection / 已定型 selectFile;副本缺失抛错)。
    // 不带 filename/out(落盘名由种子 info.name 决定,aria2 原生)。
    if (task.kind === 'torrent') {
      const dir = dirname(task.savePath)
      const url = task.source.startsWith('magnet:') ? task.source : ''
      return { url, dir, torrent: this.rebuildTorrentSubmit(task) }
    }

    const base: AddUriInput = {
      url: task.source,
      dir: dirname(task.savePath),
      filename: task.filename
    }
    // 接管来源的请求头(v0.4 Task 4 · spec §1.5 / §6.2):与既有 `video?` 的加性做法**逐字同构**。
    // `task.headers` 缺省 undefined → 本支不进 → base 与改动前**逐字段相同**(U-14 / I-05 钉死)。
    // ⚠️ 不写成无条件赋值:那会留下一个 `headers: undefined` 键,deepStrictEqual 当场不等。
    if (task.headers) {
      base.headers = task.headers
    }
    // 视频任务带 video 分支(持久化 selectedFormat/postProcess → VideoSubmit)→ 路由到 yt-dlp 后端;
    // http 不带 video → 路由到 aria2(唯一分流点在 CompositeDownloadEngine,§4.4.4)
    if (task.kind === 'video' && task.videoMeta) {
      base.video = this.rebuildVideoSubmit(task.videoMeta)
    }
    return base
  }

  /** 持久化 videoMeta(selectedFormat + postProcess + 字幕)→ 重建 VideoSubmit(出队 / 恢复重提交,§4.4.4) */
  private rebuildVideoSubmit(meta: VideoMeta): VideoSubmit {
    return {
      formatSelector: meta.selectedFormat,
      audioOnly: meta.postProcess === 'mp3',
      mergeFormat: meta.postProcess === 'merge' ? 'mp4' : undefined,
      // 字幕选择随 videoMeta 重建(v0.2 §4.2 / §4.3):出队 / 恢复重提交时透传给 buildYtDlpDownloadArgs;
      // 存量任务 / 无字幕 → undefined → toYtdlpSubtitleArgs(undefined)=[] 零回归
      subtitles: meta.subtitle,
      // #24:分片判定随 videoMeta 重建(出队 / 崩溃重启)→ VideoEngine useAccel &&= !fragmented;
      // 存量任务 / progressive → undefined → 保守挂 aria2c + 回退(§7.1 不退化)
      fragmented: meta.fragmented
    }
  }

  /**
   * 持久化 torrent 选择 → 重建 `AddUriInput.torrent`(出队 / 恢复重提交,v0.3 Task 2 · spec §4.3;
   * 类比 `rebuildVideoSubmit`)。会话内 gid 存活时出队走 `engine.resume`(不重建);**仅 gid 丢失**
   * (引擎崩溃 / 应用重启)才经此重建 `--select-file` / 待选标记,续字节交 aria2 `.aria2`(§7.4,不持久化 gid):
   * - **待选前**(resolving / awaiting_selection / 无 torrentMeta)→ `awaitSelection:true`(重提即再取元数据 → 待选);
   * - **已定型**(queued/downloading/paused + torrentMeta)→ `selectFileArg(files)` 有值则带 `selectFile`,
   *   全选(null)则省略(整包零回归)。
   * 同一 `torrentMeta.files[].selected` → 同一 `selectFileArg` → 出队 / 恢复产出**同一** `--select-file`(一致性)。
   * `.torrent` 副本缺失 → 抛可读错误(调用方 catch → 诚实落 error;Task 1 既有语义)。
   */
  private rebuildTorrentSubmit(task: Task): NonNullable<AddUriInput['torrent']> {
    let base: NonNullable<AddUriInput['torrent']>
    if (task.source.startsWith('magnet:')) {
      base = { source: 'magnet' }
    } else {
      const copyPath = this.managedCopyPathOf(task.id)
      if (!this.fileExists(copyPath)) {
        throw new Error('种子文件副本缺失,请重新添加')
      }
      base = { source: 'file', content: toBase64(this.readFile(copyPath)) }
    }
    if (task.status === 'resolving' || task.status === 'awaiting_selection' || !task.torrentMeta) {
      return { ...base, awaitSelection: true }
    }
    const arg = selectFileArg(task.torrentMeta.files)
    return arg ? { ...base, selectFile: arg } : base
  }

  private countDownloading(): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.status === 'downloading') {
        count++
      }
    }
    return count
  }

  private mapEngine(taskId: string, engineId: string): void {
    this.taskIdToEngineId.set(taskId, engineId)
    this.engineIdToTaskId.set(engineId, taskId)
  }

  private clearEngineMap(taskId: string): void {
    const engineId = this.taskIdToEngineId.get(taskId)
    if (engineId) {
      this.engineIdToTaskId.delete(engineId)
    }
    this.taskIdToEngineId.delete(taskId)
  }

  private requireTask(id: string): Task {
    const task = this.tasks.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }
    return task
  }

  /**
   * 统一分类保存路由(spec §5.1)—— 直链 / 视频单条 / 批量三创建路径共用,行为一致:
   * 1. `category = categorize(filename, extIndex)`(扩展名判定;未知 / 无扩展名 → `other`);
   * 2. `dir = explicitDir ?? resolveCategoryDir(category, ...)`(**用户显式选目录优先**;否则按类别,
   *    `other` / 未命中 → `defaultDir` 兜底);
   * 3. `ensureDir(dir)`(提交引擎前确保目录存在,§5.1 步骤 4)。
   *
   * `category` 始终为判定结果(即便显式选了非对应目录,筛选语义稳定,§5.1);
   * `error` 非空表示目录创建失败(§5.3,可读提示 + 可重试,调用方据此落 `error` 态)。
   */
  private routeForFilename(
    filename: string,
    explicitDir?: string
  ): { category: string; savePath: string; error: string | null } {
    const category = categorize(filename, this.extIndex)
    const dir = explicitDir ?? resolveCategoryDir(category, this.categories, this.defaultDir)
    const savePath = join(dir, filename)
    try {
      this.ensureDir(dir)
      return { category, savePath, error: null }
    } catch (err) {
      // 原始错误进日志(ARCHITECTURE §6.3);用户见按 errno 映射的可读提示 + 下一步(Task 9 §3.2);任务可重试(§5.3)
      console.error(`[TaskManager] 创建保存目录失败 ${dir}:`, err)
      return { category, savePath, error: toReadable(mapFsError(err)) }
    }
  }

  /**
   * 显式目录判定(§5.1):添加对话框默认预填 `defaultDir`(= 系统下载目录),用户未改动 →
   * 视为未显式选目录 → 返回 undefined(走分类路由);用户浏览改到自定义目录 → 返回该目录(显式优先)。
   */
  private explicitDirOf(dir: string | undefined): string | undefined {
    return dir && dir !== this.defaultDir ? dir : undefined
  }

  private resolveFilename(input: AddTaskInput): string {
    if (input.filename?.trim()) {
      return sanitizeBasename(input.filename)
    }
    return filenameFromUrl(input.source)
  }

  private async probeHttpFilename(input: AddTaskInput): Promise<string> {
    try {
      const headers = filterDownloadHeaders(input.headers)
      const path = await this.engine.resolveHttpFilename!({
        url: input.source,
        dir: input.dir ?? this.defaultDir,
        ...(headers ? { headers } : {})
      })
      if (path?.trim()) return sanitizeBasename(basename(path))
    } catch {
      // HEAD 不可用不等于 GET 不可用;仍按 URL 名尝试下载,不阻断原能力。
    }
    return filenameFromUrl(input.source)
  }

  private generateId(): string {
    if (this.idGenerator) {
      return this.idGenerator()
    }
    return `task_${++this.idCounter}_${Date.now()}`
  }

  private toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}
