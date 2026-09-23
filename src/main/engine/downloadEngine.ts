import type { ChildProcess } from 'child_process'
import { basename } from 'node:path'
import type { AddUriInput, DownloadProgress, DownloadTask, ProxyResolved } from '../../shared/ipc'
import {
  startAria2,
  stopAria2,
  watchAria2Exit,
  Aria2CrashDetector,
  type Aria2ProcessDeps,
  type StartAria2Options
} from './aria2Process'
import { RpcClient } from './rpcClient'
import { parseProgress, type Aria2ProgressStatus } from './rpcCodec'
import { toAria2ProxyOption } from '../proxy/proxyArgs'
import { toAria2GlobalLimitOption, toAria2TaskLimitOption } from './aria2Limit'
import { toAria2HeaderOptions } from './aria2Headers'
import { buildBtOptions, type SeedConfig } from './btOptions'
import type { TorrentInfo } from '../../shared/ipc'

/**
 * DownloadEngine 依赖注入
 */
export interface DownloadEngineDeps {
  aria2ProcessDeps: Aria2ProcessDeps
  idGenerator?: () => string
  /**
   * 注入式当前代理回调(Task 7 · spec §4.1)。每次 addUri / 崩溃重提时**实时调用**取当前档,
   * 经 `toAria2ProxyOption` 注入 aria2 任务级 `all-proxy`(effectiveUrl=null → 显式空串关闭,
   * 杜绝继承 aria2 进程级 / 环境 HTTP_PROXY)。切档对**后续新任务**即时生效,不影响运行中任务。
   */
  getProxy?: () => ProxyResolved
  /**
   * 注入式当前全局限速 KB/s(v0.2 Task 2 · spec §2.2,与 getProxy 完全对称)。每次 `startAria2Internal`
   * (启动 + 崩溃重启)**实时调用**:① 作 `StartAria2Options.maxOverallLimitKBps` 启动初值(消除窗口期);
   * ② 启动成功后 `setGlobalLimit` apply 一次(崩溃重启自动 re-apply 当前限速)。未注入 → 不限速(向后兼容)。
   * ③ v1.0 Task 8 · #100:`setTaskLimit(id, null)`(跟随全局)也实时调用它取**当前全局值**下发,
   *    因为全局限速现在是每任务默认上限(`max-download-limit` 全局默认),null 不再等于 0。
   */
  getSpeedLimit?: () => number
  /**
   * 注入式当前做种配置(v0.3 Task 3 · spec §7,与 getSpeedLimit 对称:实时读 settings、切档对新建 / 重提生效)。
   * addUri / resubmitUnfinishedTasks 的 torrent 分支实时调,经 buildBtOptions 注入 seed-ratio / seed-time;
   * 未注入 → toSeedOptions(undefined) → seed-time='0'(下载完即停,向后兼容零回归)。做种派生位亦读此判开档。
   */
  getSeedConfig?: () => SeedConfig
  /**
   * 注入式当前 BT tracker 生效表(v0.4 Task 1 · spec §4.2 pull 通道,照 getSpeedLimit 的实时读范式)。
   * 每次 `startAria2Internal`(启动 + 崩溃重启)实时调 → 作 `StartAria2Options.btTrackers` 拼进 CLI;
   * 未注入 / 返回 undefined / 空数组 → `buildAria2Args` 用内置 `DEFAULT_BT_TRACKERS`(**与现状逐字节等价,零回归**)。
   */
  getBtTrackers?: () => readonly string[] | undefined
}

/**
 * tracker 热应用结果(v0.4 Task 1 · spec §4.2 push 通道)。
 *
 * ⚠️ **gid 不出 engine**(§7.4):追补的遍历封在 `DownloadEngine` 内部,本结构**只回计数**;
 * gid 仅进 `main.log` 本机日志,不进 UI、不落库。
 */
export interface BtTrackerApplyResult {
  /** `changeGlobalOption` 是否成功(管此后**新增**任务) */
  globalOk: boolean
  /** 追补成功的活跃 torrent 任务数 */
  patched: number
  /** 追补失败数(不影响整体成功判定) */
  failed: number
}

/**
 * DownloadEngine 配置
 */
export interface DownloadEngineOptions {
  aria2cPath: string
  defaultDir: string
  pollInterval?: number // 进度轮询间隔，默认 1000ms
  /** HTTP filename preflight deadline (including RPC/queueing), default 5000ms; tests may shorten it. */
  httpFilenameProbeTimeoutMs?: number
  /** DHT 路由表持久化路径(v0.3 修订三 · spec §4.2);index 装配 `<userData>/dht.dat`,缺省不加参数 */
  dhtFilePath?: string
  /** IPv6 DHT 路由表持久化路径(2026-07-25 真机修订 · spec §14);index 装配 `<userData>/dht6.dat` */
  dhtFilePath6?: string
}

/**
 * 内存任务映射
 */
interface InternalTask {
  id: string
  gid?: string
  url: string
  dir: string
  filename?: string
  status: DownloadTask['status']
  desiredState: DownloadTask['desiredState']
  /** BT 任务标记(v0.3 Task 1 · spec §5.3;以下 BT 字段全部**仅内存**,§7.4 不持久化 gid) */
  isTorrent?: boolean
  /** magnet 元数据阶段 gid(followedBy 转移后清空;.torrent 直得真实 gid,无此字段) */
  metaGid?: string
  /** 是否已发过 torrentInfo 帧(元数据信息只随进度发一次) */
  torrentInfoEmitted?: boolean
  /** .torrent 内容 base64(仅内存;崩溃重提 re-addTorrent 用,不落库) */
  torrentContent?: string
  /**
   * await 模式:元数据后暂停待选(v0.3 Task 2 · spec §5.1;仅内存,§7.4 不落库)。
   * 真时元数据到达后把内部 status 置 `paused`(与 aria2 `pause-metadata`/`pause` 实况一致),
   * 待 `applyTorrentSelection` + `resume(unpause)` 才下载;崩溃重提据此复原 await 选项。
   */
  awaitSelection?: boolean
  /**
   * 已定型的 `--select-file` 索引串(v0.3 Task 2;仅内存,崩溃重提复原)。
   * `applyTorrentSelection` 写入(全选 = undefined);`resubmitUnfinishedTasks` 据此重建 select-file。
   */
  selectFile?: string
  /**
   * 单任务限速三态(v1.0 Task 8 · #100;**仅内存**:不落库、不进 `list()` 快照、不进 IPC,§7.3 / §7.4)。
   * `undefined` = 跟随全局(上限 = 当前全局值)/ `0` = 本任务不限(覆盖全局)/ `N` = 限到 N KB/s(可大于全局)。
   * 唯一用途:`setGlobalLimit` 追补时筛出跟随者;崩溃重提 / followedBy 转移后对覆盖任务补发。
   * UI 回显仍靠 TaskManager 自己的 `task.limitKBps`,本字段不出 engine。
   */
  limitKBps?: number
}

/**
 * 进度缓存，用于节流去重
 */
interface ProgressCache {
  status: string
  downloadedBytes: number
  speed: number
  savePath?: string
}

/** 基础进度 keys(http / BT 通用);BT 富进度 numSeeders/uploadSpeed/uploadLength 于 Task 3 追加(spec §4,http 无此键无害) */
const PROGRESS_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'downloadSpeed',
  'connections',
  'errorCode',
  // 真机修订 2026-07-27(spec §13):errorCode=1(unknown)语义就是「详见 errorMessage」——不取则真实原因
  // (如 SSL/TLS 握手失败)被丢弃,UI 只剩「引擎未知错误,请重试」误导用户。BT_STATUS_KEYS 由本表派生同享。
  'errorMessage',
  // BT 富进度(v0.3 Task 3 · spec §4):tellActive/tellStatus 一并取;http 任务无这些键 → parseProgress 不设,零回归
  'numSeeders',
  'uploadSpeed',
  'uploadLength',
  'files'
]

/** BT 扩展 keys(v0.3 Task 1 · spec §5.3):followedBy 转移 + 元数据信息读取用 */
const BT_STATUS_KEYS = [...PROGRESS_KEYS, 'following', 'followedBy', 'infoHash', 'bittorrent']

/** aria2 tellStatus 的 BT 扩展字段(spec §5.3;结构由 aria2 原生返回,不自研解析) */
interface Aria2BtStatus extends Aria2ProgressStatus {
  followedBy?: string[]
  infoHash?: string
  bittorrent?: { info?: { name?: string } }
}

/**
 * aria2 files[].path(绝对路径,dir 前缀)→ 种子内相对路径(TorrentFile.path,spec §2.3)。
 * 仅做前缀剥离(分隔符归一 `/`),剥不掉(如 magnet 元数据阶段的 `[METADATA]` 项)原样返回。
 */
function toTorrentRelPath(absPath: string, dir: string): string {
  const norm = absPath.replace(/\\/g, '/')
  const dirNorm = dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  return norm.startsWith(dirNorm) ? norm.slice(dirNorm.length) : norm
}

/** 错误取短文案(日志用;spec §4.5 的 `<err.message>` 口径,不带堆栈) */
function toErrText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Keep a slow RPC (including its JSON body) from defeating the filename probe deadline. */
async function beforeFilenameDeadline<T>(pending: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP filename probe timed out')),
          Math.max(0, deadline - Date.now())
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * DownloadEngine — 下载引擎核心，封装 aria2c 子进程 + 进度轮询 + 崩溃自恢复
 *
 * 职责：
 * 1. 启动 / 停止 aria2c 子进程
 * 2. 维护内存任务映射（id ↔ gid）
 * 3. 进度轮询（仅有活动任务时）+ 节流去重
 * 4. 崩溃检测 → 自动重启 → 重提未完成任务续传
 *
 * 对上层暴露干净接口，不暴露 gid / RPC 细节。
 */
export class DownloadEngine {
  private deps: DownloadEngineDeps
  private opts: DownloadEngineOptions

  // aria2c 子进程相关
  private child: ChildProcess | null = null
  private rpcClient: RpcClient | null = null
  private crashDetector = new Aria2CrashDetector()

  // 任务映射
  private idToTask = new Map<string, InternalTask>()
  private gidToId = new Map<string, string>()

  // 进度轮询
  private pollTimer: NodeJS.Timeout | null = null
  private progressCallbacks = new Set<(progress: DownloadProgress) => void>()
  private progressCache = new Map<string, ProgressCache>()

  // ID 生成器（注入式，便于测试）
  private nextIdCounter = 0

  // 引擎复活单飞(见 ensureEngineAlive):并发 addUri 共享同一次重启,防双起 aria2
  private reviving: Promise<void> | null = null

  constructor(deps: DownloadEngineDeps, opts: DownloadEngineOptions) {
    this.deps = deps
    this.opts = opts
  }

  /**
   * 启动引擎（启动 aria2c + RPC 就绪）
   */
  async start(): Promise<void> {
    if (this.child) {
      throw new Error('DownloadEngine 已启动')
    }

    await this.startAria2Internal()
  }

  /**
   * 停止引擎（优雅关闭 aria2c）
   */
  async stop(): Promise<void> {
    if (!this.child || !this.rpcClient) {
      return
    }

    // 停止进度轮询
    this.stopPolling()

    // 优雅关闭 aria2c
    await stopAria2(this.child, this.rpcClient, this.crashDetector)

    this.child = null
    this.rpcClient = null
  }

  /**
   * Native HEAD/redirect/CD preflight only. Its gid never enters business mappings or progress;
   * dry-run's completedLength is not downloaded data. Main sanitizes before the real explicit out.
   */
  async resolveHttpFilename(
    input: Pick<AddUriInput, 'url' | 'dir' | 'headers'>
  ): Promise<string | null> {
    const rpc = this.rpcClient
    if (!rpc) return null

    const timeoutMs = this.opts.httpFilenameProbeTimeoutMs ?? 5_000
    const deadline = Date.now() + timeoutMs
    // Cleanup is best effort and separately bounded: at most 1s per RPC (shorter in tests).
    const cleanupTimeoutMs = Math.min(timeoutMs, 1_000)
    const cleanup = async (probeGid: string, terminal: boolean): Promise<void> => {
      if (!terminal) {
        try {
          await beforeFilenameDeadline(rpc.forceRemove(probeGid), Date.now() + cleanupTimeoutMs)
        } catch {
          // It may already have stopped, or this original engine may have exited.
        }
      }
      try {
        await beforeFilenameDeadline(
          rpc.removeDownloadResult(probeGid),
          Date.now() + cleanupTimeoutMs
        )
      } catch {
        // Never purge other results or make best-effort preflight block a subsequent GET.
      }
    }

    let gid: string | undefined
    let terminal = false
    let finished = false
    try {
      const added = rpc
        .addUri([input.url], {
          dir: input.dir,
          'dry-run': 'true',
          continue: 'false',
          'auto-file-renaming': 'true',
          'allow-overwrite': 'false',
          'connect-timeout': '3',
          timeout: '5',
          'max-tries': '1',
          'retry-wait': '0',
          ...toAria2ProxyOption(this.deps.getProxy?.().effectiveUrl ?? null),
          ...toAria2HeaderOptions(input.headers)
        })
        .then(async (probeGid) => {
          gid = probeGid
          // addUri itself can arrive after our deadline; still clean only its own gid on the old RPC.
          if (finished) await cleanup(probeGid, false)
          return probeGid
        })
      gid = await beforeFilenameDeadline(added, deadline)
      while (Date.now() < deadline && this.rpcClient === rpc) {
        const raw = (await beforeFilenameDeadline(
          rpc.tellStatus(gid, ['status', 'files']),
          deadline
        )) as Aria2ProgressStatus
        if (this.rpcClient !== rpc) return null
        terminal = raw.status === 'complete' || raw.status === 'error' || raw.status === 'removed'
        if (terminal) {
          const path = raw.files?.[0]?.path
          return raw.status === 'complete' && typeof path === 'string' && path.trim() !== ''
            ? path
            : null
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())))
        )
      }
      return null
    } catch {
      return null
    } finally {
      finished = true
      if (gid) await cleanup(gid, terminal)
    }
  }

  /**
   * 添加直链下载任务
   */
  async addUri(input: AddUriInput): Promise<string> {
    // 引擎死亡(崩溃自动恢复失败,如二进制缺失 / 被占用)后的复活缝(2026-07-11 真机 R6):
    // 此前用户修复环境后「重试」只重提任务,永远失败在死 RPC 上,无任何路径能再拉起 aria2。
    await this.ensureEngineAlive()

    if (!this.rpcClient) {
      throw new Error('DownloadEngine 未启动')
    }

    // 生成内部任务 id
    const id = this.generateId()

    // BT 分支(v0.3 Task 1 · spec §4 / §5.3):magnet → addUri([magnet]) 先下元数据(metaGid),
    // followedBy 转移见 pollProgress;.torrent → addTorrent(base64) 直得真实 gid。
    // 任务级 options 叠加原生 BT 选项(follow-torrent / seed-time=0 / bt-save-metadata,§4.2),
    // 协议全交 aria2(§6.1),代理注入与 http 同构。
    // Task 2(spec §5.1):awaitSelection → 元数据后暂停(magnet pause-metadata / .torrent pause)待选;
    // selectFile → 出队 / 恢复重建的 --select-file(全选省略);均加性,未带者与 Task 1 整包等价。
    if (input.torrent) {
      const isMagnet = input.torrent.source === 'magnet'
      const awaitSelection = !!input.torrent.awaitSelection
      const btOptions: Record<string, unknown> = {
        ...toAria2ProxyOption(this.deps.getProxy?.().effectiveUrl ?? null),
        ...buildBtOptions({
          dir: input.dir,
          selectFile: input.torrent.selectFile ?? null,
          pauseMetadata: awaitSelection && isMagnet,
          pause: awaitSelection && !isMagnet,
          // 做种档实时读(v0.3 Task 3 · spec §7):开档注入 seed-ratio/seed-time;未注入 / 关档 → seed-time='0'
          seed: this.deps.getSeedConfig?.()
        })
      }
      const gid = isMagnet
        ? await this.rpcClient.addUri([input.url], btOptions)
        : await this.rpcClient.addTorrent(input.torrent.content ?? '', [], btOptions)

      const btTask: InternalTask = {
        id,
        gid,
        url: input.url,
        dir: input.dir,
        // await 的 .torrent 以暂停态创建(pause=true):初始 status 即 paused,避免轮询 flip 误判为终态(§5.1);
        // magnet 元数据阶段仍活跃 → queued(followedBy 转移后按 awaitSelection 置 paused);非 await → queued(Task 1)
        status: awaitSelection && !isMagnet ? 'paused' : 'queued',
        desiredState: 'active',
        isTorrent: true,
        metaGid: isMagnet ? gid : undefined,
        torrentInfoEmitted: false,
        torrentContent: input.torrent.content,
        awaitSelection: awaitSelection || undefined,
        selectFile: input.torrent.selectFile
      }
      this.idToTask.set(id, btTask)
      this.gidToId.set(gid, id)
      this.ensurePolling()
      return id
    }

    // 调用 aria2 addUri
    const options: Record<string, unknown> = {
      dir: input.dir,
      // 任务级代理:实时取当前档(direct / 未读到 → 显式空串关闭,合规零泄漏,spec §4.1)
      ...toAria2ProxyOption(this.deps.getProxy?.().effectiveUrl ?? null),
      // 接管来源的请求头(v0.4 Task 4 · spec §6.2 白名单第③层):映射到 aria2 **专用**选项
      // `referer` / `user-agent`,**刻意不用 `header`**(那是任意头的入口)。
      // 缺省恒产 `{}` → 展开后与改动前逐字节等价(U-13 钉死),BT 分支不碰。
      ...toAria2HeaderOptions(input.headers)
    }
    if (input.filename) {
      options.out = input.filename
    }

    const gid = await this.rpcClient.addUri([input.url], options)

    // 记录内存任务
    const task: InternalTask = {
      id,
      gid,
      url: input.url,
      dir: input.dir,
      filename: input.filename,
      status: 'queued',
      desiredState: 'active'
    }

    this.idToTask.set(id, task)
    this.gidToId.set(gid, id)

    // 启动轮询（如果尚未启动）
    this.ensurePolling()

    return id
  }

  /**
   * 引擎复活单飞(2026-07-11 真机 R6 补全):崩溃自动恢复失败后 child 指向死进程、rpcClient 指向
   * 死端口——「崩溃须自动重启」(§7.1)的自动分支已尽(退避重试 / 风暴上限),此处是**手动分支**:
   * 用户修复环境(如放回二进制)后经「重试 / 新任务」的 addUri 按需拉起 aria2。
   * - 从未启动 / 已主动 stop(child === null):不自动拉起,保持「DownloadEngine 未启动」原语义;
   * - 进程在跑:直接返回,零开销;
   * - 死进程:单飞重启(并发 addUri 共享同一 in-flight,防双起);成功即 reset 崩溃风暴计数
   *   (startAria2Internal 内)并恢复轮询;失败则把启动错误抛给本次 addUri(任务转 error 可再重试)。
   */
  private ensureEngineAlive(): Promise<void> {
    if (this.child === null) {
      return Promise.resolve()
    }
    const running =
      this.child.exitCode === null && this.child.signalCode === null && this.rpcClient !== null
    if (running) {
      return Promise.resolve()
    }
    if (!this.reviving) {
      console.warn(
        '[DownloadEngine] 引擎不在运行(崩溃后未能自动恢复),随重试 / 新任务按需重启 aria2c...'
      )
      this.reviving = (async () => {
        try {
          await this.startAria2Internal()
          this.ensurePolling()
        } finally {
          this.reviving = null
        }
      })()
    }
    return this.reviving
  }

  /**
   * 暂停任务
   */
  async pause(id: string): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }

    if (!task.gid) {
      throw new Error(`任务 ${id} 尚未提交到 aria2`)
    }

    if (!this.rpcClient) {
      throw new Error('DownloadEngine 未启动')
    }

    // forcePause 立即暂停(真机修订四):优雅 pause 的「pause pending」窗口内 unpause 会报
    // 「cannot be unpaused now」(BT 收尾要联系 tracker,窗口更长);续传不受影响(auto-save-interval=1)
    await this.rpcClient.forcePause(task.gid)

    // 更新 desiredState
    task.desiredState = 'paused'
    task.status = 'paused'
  }

  /**
   * 恢复任务
   */
  async resume(id: string): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }

    if (!task.gid) {
      throw new Error(`任务 ${id} 尚未提交到 aria2`)
    }

    if (!this.rpcClient) {
      throw new Error('DownloadEngine 未启动')
    }

    await this.rpcClient.unpause(task.gid)

    // 更新 desiredState
    task.desiredState = 'active'
    task.status = 'downloading'

    // 重启进度轮询:pause 后 checkStopPolling 已因「无活动任务」停表,不重启则恢复后
    // 进度事件永不再来、完成也无人发现(任务假死;真机 2026-07-09 验收 A4 实证)
    this.ensurePolling()
  }

  /**
   * 删除任务
   */
  async remove(id: string): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task) {
      throw new Error(`任务不存在: ${id}`)
    }

    if (task.gid && this.rpcClient) {
      try {
        // forceRemove 非 remove(2026-07-25 真机修订三):优雅 remove 的 BT tracker 收尾窗口内
        // 文件句柄不释放 → 删除文件移回收站失败(残留 + 用户手删撞锁弹提权框);强制移除即刻放句柄
        await this.rpcClient.forceRemove(task.gid)
      } catch {
        // 删除失败不影响内存清理
      }
      this.gidToId.delete(task.gid)
    }

    this.idToTask.delete(id)
    this.progressCache.delete(id)

    // 检查是否需要停止轮询
    this.checkStopPolling()
  }

  /**
   * 获取任务列表快照
   */
  list(): DownloadTask[] {
    return Array.from(this.idToTask.values()).map((task) => ({
      id: task.id,
      gid: task.gid,
      url: task.url,
      dir: task.dir,
      filename: task.filename,
      status: task.status,
      desiredState: task.desiredState
    }))
  }

  /**
   * 订阅进度事件
   */
  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.progressCallbacks.add(callback)
    return () => {
      this.progressCallbacks.delete(callback)
    }
  }

  // ========== 内部实现 ==========

  /**
   * 启动 aria2c（内部，支持崩溃重启复用）
   */
  private async startAria2Internal(): Promise<void> {
    const startOpts: StartAria2Options = {
      aria2cPath: this.opts.aria2cPath,
      dir: this.opts.defaultDir,
      // 启动初值(spec §2.2):实时读当前全局限速;崩溃重启复用本路径 → 自动带当前限速
      maxOverallLimitKBps: this.deps.getSpeedLimit?.(),
      // DHT 路由表持久化(v0.3 修订三 · spec §4.2):崩溃重启同样带上,路由表跨重启复用
      dhtFilePath: this.opts.dhtFilePath,
      dhtFilePath6: this.opts.dhtFilePath6,
      // tracker 生效表(v0.4 Task 1 · spec §4.2 pull):实时读;缺省 / 空 → buildAria2Args 用内置表(零回归)。
      // 崩溃重启走同一路径 → 自动带上当时的生效表,与 maxOverallLimitKBps 同构。
      btTrackers: this.deps.getBtTrackers?.()
    }

    const result = await startAria2(this.deps.aria2ProcessDeps, startOpts)

    this.child = result.child
    this.rpcClient = new RpcClient(
      { fetch: globalThis.fetch },
      {
        baseURL: `http://127.0.0.1:${result.port}/jsonrpc`,
        secret: result.secret
      }
    )

    // 重置崩溃检测器状态
    this.crashDetector.reset()

    // 监听崩溃(审计#8:加崩溃风暴超限回调 → handleCrashStorm 对非终态任务发 error 终态,不静默假死)
    watchAria2Exit(
      this.child,
      this.crashDetector,
      () => this.handleCrash(),
      (msg) => this.handleCrashStorm(msg)
    )

    // 启动 / 崩溃重启后 re-apply 全局限速(spec §2.2):启动初值已在 args 里,此处再经 RPC apply 一次,
    // 与「运行中改限速」同路径(双保险,幂等)。仅注入了 getSpeedLimit 且值>0 时 apply(0 = 不限,启动本就不加)。
    // v1.0 Task 8 · #100:首次启动 idToTask 为空 → 只 changeGlobalOption;崩溃重启时 gidToId 已被 handleCrash
    // 清空 → setGlobalLimit 的追补条件 ③′ 让旧 gid 全部跳过,随后 resubmitUnfinishedTasks 的新 gid 继承全局默认。
    if (this.deps.getSpeedLimit) {
      const kbps = this.deps.getSpeedLimit()
      if (kbps > 0) {
        await this.setGlobalLimit(kbps)
      }
    }
  }

  /**
   * 动态改全局限速(v0.2 Task 2 · spec §2.2;v1.0 Task 8 · #100 改语义):**全局 = 每个「跟随全局」任务
   * 各自的上限**(`max-download-limit` 的全局默认值),不是总量上限。SettingsService.onChange 经 index 闭包调用,
   * 不重启进程、不碰 `.aria2`。照 `applyBtTrackers` 范式,两件**互相独立**的事,各自 try/catch、互不中断:
   * 1. `changeGlobalOption({'max-download-limit'})` —— **只对此后新任务生效**(2026-09-17 裸跑探针 P4 实证:
   *    改全局默认后已有任务不变,与 bt-tracker 那次取证同构)。
   * 2. **追补**:遍历内存任务,只对**跟随全局**(`limitKBps === undefined`)且 gid 活着的任务逐个
   *    `changeOption(gid, …)`;覆盖任务(0 / N)不动。每条单独 try/catch,单条失败不牵连其他。
   *    追补条件四条(设计 D5 ①′–④′):①′ 跟随全局;②′ 有 gid;③′ `gidToId.get(gid) === id`(gid 是当前 aria2
   *    进程里的活 gid —— `handleCrash` 先清空 gidToId 再重启,重启末尾 re-apply 时旧 gid 全是陈旧值,
   *    不加此条会对每条任务各打一次注定失败的 RPC);④′ 非 completed / error(aria2 拒绝对已停止下载改选项)。
   * **失败不崩**:两步的 RPC 失败均仅记日志(崩溃重启会 re-apply;不影响下载本身,spec §7.1)。
   * 不回计数、不加返回类型(与 applyBtTrackers 不同:index.ts 是 fire-and-forget)。gid 不出 engine(§7.4)。
   */
  async setGlobalLimit(kbps: number): Promise<void> {
    const rpc = this.rpcClient
    if (!rpc) return // 未启动 / 已停止:静默(启动前调用不抛)

    // ① 全局默认(管此后新任务)
    try {
      await rpc.changeGlobalOption(toAria2GlobalLimitOption(kbps))
    } catch (err) {
      console.error(
        '[DownloadEngine] setGlobalLimit changeGlobalOption 失败(不崩,崩溃重启会 re-apply):',
        err
      )
    }

    // ② 追补:只发给跟随全局且 gid 活着的非终态任务;单条失败不牵连其他
    for (const task of this.idToTask.values()) {
      if (task.limitKBps !== undefined) continue // ①′ 覆盖任务不动
      if (!task.gid) continue // ②′ 无 gid 无从下发
      if (this.gidToId.get(task.gid) !== task.id) continue // ③′ 陈旧 gid(崩溃现场)跳过
      if (task.status === 'completed' || task.status === 'error') continue // ④′ 终态不可改选项
      try {
        await rpc.changeOption(task.gid, toAria2TaskLimitOption(kbps))
      } catch (err) {
        console.error(`[DownloadEngine] setGlobalLimit 追补 gid=${task.gid} 失败(不崩):`, err)
      }
    }
  }

  /**
   * tracker 表热应用 + **追补**(v0.4 Task 1 · spec §4.2 push 通道 / §4.5 #8 #9)。
   *
   * 两件**互相独立**的事,故各自 try/catch、互不中断:
   * 1. `changeGlobalOption({'bt-tracker': csv})` —— 管此后**新增**的任务;失败只置 `globalOk=false`。
   * 2. **追补**:遍历内存任务筛 torrent 且已有 gid 者,逐个 `changeOption(gid, …)` —— 因为
   *    `changeGlobalOption` **只对新任务生效**,运行中任务保持 addUri 那一刻的 tracker 快照
   *    (2026-07-29 裸跑真 aria2 取证,spec §2.1 F4)。**每个任务单独 try/catch**,单条失败不牵连其他。
   *
   * ⚠️ 用 `task.gid` 而**非** `task.metaGid`:`resolveFollowedBy` 在元数据完成后已把 `task.gid` 换成
   * realGid 并清空 `metaGid`,`task.gid` 恒为当前有效 gid。
   *
   * ⚠️ **诚实边界**(spec §4.6,不得越过):已验证的只有「`changeOption` 调用被 aria2 接受 +
   * `getOption` 读回新值」;**未验证下一轮 announce 是否真用新表**(需抓包)。追补属**尽力而为**,
   * 是**有界遗留** —— 日志 / UI / 文档均**不得**写成「追补已生效」。
   *
   * ⚠️ **gid 不出 engine**(§7.4):遍历封在本方法内,只回计数;gid 仅进 `main.log`,不进 UI、不落库。
   */
  async applyBtTrackers(trackers: readonly string[]): Promise<BtTrackerApplyResult> {
    const csv = trackers.join(',')
    const result: BtTrackerApplyResult = { globalOk: false, patched: 0, failed: 0 }
    const rpc = this.rpcClient
    if (!rpc) {
      // 引擎未启动 / 已停止:本次热应用无从下发(表仍已落盘,下次启动经 pull 生效),诚实回全零
      console.error('[bt-tracker] apply skipped: engine not running')
      return result
    }

    // ① 全局值(spec §4.5 #8):失败**不中断**追补 —— 表仍已落盘,下次启动经 pull 生效
    try {
      await rpc.changeGlobalOption({ 'bt-tracker': csv })
      result.globalOk = true
    } catch (err) {
      console.error(`[bt-tracker] changeGlobalOption failed: ${toErrText(err)}`)
    }

    // ② 追补(spec §4.5 #9):单条失败计入 failed,不牵连其他任务、不影响整体成功判定
    for (const task of this.idToTask.values()) {
      if (task.isTorrent !== true || !task.gid) continue
      try {
        await rpc.changeOption(task.gid, { 'bt-tracker': csv })
        result.patched += 1
      } catch (err) {
        result.failed += 1
        console.error(`[bt-tracker] patch gid=${task.gid} failed: ${toErrText(err)}`)
      }
    }

    return result
  }

  /**
   * 动态改单任务限速(v0.2 Task 2 · spec §2.3):按内部 id 取 gid,经 `aria2.changeOption(gid)` 即时改该
   * 任务的 `max-download-limit`,不碰 `.aria2`。**失败不崩**:RPC 失败仅记日志(不影响下载本身,spec §7.1)。
   *
   * v1.0 Task 8 · #100 三态(全局 = 每任务默认上限后,三态在 aria2 层**真可分**):
   * - `null` = 跟随全局 → 下发**当前全局值**(`deps.getSpeedLimit`;未注入 → 0)。⚠️ 不能下发 0:
   *   旧实现 null 下发 '0',新语义下会把「跟随全局」变成「不限」(设计 D4,最容易漏的一处)。
   * - `0` = 本任务不限 → 下发 '0'(真能覆盖全局默认,探针 P6);`N` → 'NK'(N 可大于全局)。
   * 先存 `task.limitKBps`(无 gid 也存,供崩溃重提 / followedBy 补发),再下发;未知 id 不存、不下发、不抛。
   */
  async setTaskLimit(id: string, kbps: number | null): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task) return
    task.limitKBps = kbps ?? undefined
    if (!task.gid || !this.rpcClient) return
    const effective = kbps ?? this.deps.getSpeedLimit?.() ?? 0
    try {
      await this.rpcClient.changeOption(task.gid, toAria2TaskLimitOption(effective))
    } catch (err) {
      console.error('[DownloadEngine] setTaskLimit 失败(不崩):', err)
    }
  }

  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §5.2):存 `InternalTask.selectFile`(崩溃重提复原),
   * `arg` 非空 → `aria2.changeOption(realGid, {'select-file': arg})`。
   * **仅在暂停 / 等待态下发合法**(元数据后 `pause-metadata`/`pause` 使 realGid 暂停,§5;下载中不改选,§4.5);
   * TaskManager 保证仅 `awaiting_selection` 态调用。`arg===null`(全选)不下发 changeOption(aria2 默认全下)。
   * **失败不崩**:RPC 失败仅记日志(选择未生效但不影响后续 unpause 整包续下;§7.1)。
   */
  async applyTorrentSelection(id: string, selectFileArg: string | null): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task) {
      return
    }
    task.selectFile = selectFileArg ?? undefined
    if (selectFileArg && task.gid && this.rpcClient) {
      try {
        // bt-remove-unselected-file(2026-07-25 真机修订三):aria2 按 piece 下载会给未选文件预创建
        // 0B 条目、且与选中文件同 piece 的边界字节会写入未选文件——完成时由 aria2 删除未选文件,
        // 磁盘最终只留选中项(C1 真机:未选文件 0B 占位 + 部分有边界字节)
        await this.rpcClient.changeOption(task.gid, {
          'select-file': selectFileArg,
          'bt-remove-unselected-file': 'true'
        })
        // 成功也留痕:真机 0 速排查时日志可证明选择链路已走通(2026-07-25 C1 只有失败才有日志,无从判断)
        console.log(
          `[DownloadEngine] BT 文件选择已下发 (gid: ${task.gid}, select-file: ${selectFileArg})`
        )
      } catch (err) {
        console.error('[DownloadEngine] applyTorrentSelection changeOption 失败(不崩):', err)
      }
    }
  }

  /**
   * 停止单任务做种(v0.3 Task 3 · spec §2 / §7):BT 做种走 aria2 原生,停做种 = `forcePause` 立即停上传
   * (保留已下文件 + `.aria2` 续传,与 pause / remove 修订四同理:做种是完成后的上传,停止是明确意图,
   * 无需 tracker 优雅注销)+ 从 `gidToId` 解绑(仿 remove):pollProgress 的 gid 离场检测不再命中该 gid →
   * 不 `checkFinalStatus` 误判。任务已 completed(TaskManager 侧),内部标记终态并按需停轮询。失败仅记日志不崩。
   */
  async stopSeeding(id: string): Promise<void> {
    const task = this.idToTask.get(id)
    if (!task || !task.gid || !this.rpcClient) {
      return
    }
    try {
      await this.rpcClient.forcePause(task.gid)
    } catch (err) {
      console.error('[DownloadEngine] stopSeeding forcePause 失败(不崩):', err)
    }
    this.gidToId.delete(task.gid)
    task.status = 'completed'
    this.checkStopPolling()
  }

  /**
   * 处理崩溃：重启 + 重提未完成任务
   */
  private async handleCrash(): Promise<void> {
    // stop() 已标记主动关闭时不复活:崩溃退避 setTimeout 可能在引擎停止后才触发本回调
    if (this.crashDetector.isIntentionalShutdown()) {
      return
    }

    console.error('[DownloadEngine] 检测到 aria2c 崩溃，开始重启...')

    // 停止轮询
    this.stopPolling()

    // 标记所有非终态任务为「重连中」（对外显示为 queued）
    for (const task of this.idToTask.values()) {
      if (task.status !== 'completed' && task.status !== 'error') {
        task.status = 'queued'
      }
    }

    // 清空 gidToId（旧 gid 全部失效）
    this.gidToId.clear()

    try {
      // 重启 aria2c
      await this.startAria2Internal()

      console.log('[DownloadEngine] aria2c 重启成功，开始重提未完成任务...')

      // 重提未完成任务
      await this.resubmitUnfinishedTasks()

      // 恢复轮询
      this.ensurePolling()

      console.log('[DownloadEngine] 崩溃恢复完成')
    } catch (err) {
      console.error('[DownloadEngine] 崩溃恢复失败:', err)
      // 恢复失败不得静默:任务留在引擎内部 queued 而 TaskManager 侧永远「下载中 0 速」、无出口。
      // 对非终态任务发 error 终态事件,走既有 error 流转链(落库 + 广播 + 可重试)。
      this.failNonTerminalTasks('下载引擎崩溃后重启失败,请稍后重试任务')
    }
  }

  /**
   * 崩溃风暴超限处理(审计#8 · spec §8):`watchAria2Exit` 检测到 60s 内崩溃 >5 次 → 停止自动重启,
   * 经 onGiveUp 回调到此。原实现只 `console.error` 后静默 return,任务永久「下载中 0 速」假死;
   * 此处停轮询 + 对非终态任务发 error 终态(§7.1 崩溃隔离不静默失败),与 `ensureEngineAlive`
   * (下次 addUri 复活)互补:超限时**立即通知**,不等用户操作。不改重启 / 退避机制本身。
   */
  private handleCrashStorm(msg: string): void {
    console.error(`[DownloadEngine] aria2c 崩溃风暴超限,已停止自动重启:${msg}`)
    // 引擎已确认死亡不再重启 → 停轮询(否则每秒 tellActive 必然失败刷日志)
    this.stopPolling()
    this.failNonTerminalTasks(msg)
  }

  /**
   * 对所有非终态任务发 error 终态事件(handleCrash 恢复失败 / handleCrashStorm 风暴超限共用):
   * 走既有 error 流转链(TaskManager 落库 + 广播 + 可重试);downloadedBytes 取进度缓存最后已知值,
   * 避免把 0 覆盖进库;totalBytes=0(崩溃后不可知)。仅内存标记 error,不碰 `.aria2`(§7.4)。
   */
  private failNonTerminalTasks(errorCode: string): void {
    for (const task of this.idToTask.values()) {
      if (task.status === 'completed' || task.status === 'error') {
        continue
      }
      task.status = 'error'
      this.emitProgress({
        id: task.id,
        status: 'error',
        totalBytes: 0,
        downloadedBytes: this.progressCache.get(task.id)?.downloadedBytes ?? 0,
        speed: 0,
        connections: 0,
        errorCode
      })
    }
  }

  /**
   * 重提未完成任务（崩溃恢复时调用）
   */
  private async resubmitUnfinishedTasks(): Promise<void> {
    if (!this.rpcClient) {
      throw new Error('rpcClient 未就绪')
    }

    for (const task of this.idToTask.values()) {
      // 只重提非终态任务
      if (task.status === 'completed' || task.status === 'error') {
        continue
      }

      try {
        // 重新 addUri（aria2 会自动从 .aria2 续传）
        // 同 addUri 注入当前代理:崩溃恢复重提也需显式 all-proxy(direct 档空串关闭,
        // 否则 aria2 未设任务级代理时会回退环境 HTTP_PROXY → 泄漏,spec §4.1)
        let newGid: string
        if (task.isTorrent) {
          // BT 崩溃重提(v0.3 Task 1 · spec §6.2):magnet re-addUri / .torrent re-addTorrent(内存 base64),
          // BT 选项与代理注入同首提;分片续传交 aria2 `.aria2`(§7.4)。magnet 重提又从元数据阶段起
          // (新 gid 记回 metaGid,followedBy 再次转移;已发过 torrentInfo 的任务上层幂等忽略)。
          // Task 2(spec §5.3):按 awaitSelection / selectFile 复原 —— 待选中 → 再暂停待选(pause-metadata/
          // pause);已定型 → 带 select-file 直下(全选省略)。isMagnet 以 torrentContent 缺席判定(与首提一致)。
          const isMagnet = !task.torrentContent
          const btOptions: Record<string, unknown> = {
            ...toAria2ProxyOption(this.deps.getProxy?.().effectiveUrl ?? null),
            ...buildBtOptions({
              dir: task.dir,
              selectFile: task.selectFile ?? null,
              pauseMetadata: !!task.awaitSelection && isMagnet,
              pause: !!task.awaitSelection && !isMagnet,
              // 崩溃重提也实时读做种档(v0.3 Task 3):与首提一致,做种档对重提生效
              seed: this.deps.getSeedConfig?.()
            })
          }
          newGid = task.torrentContent
            ? await this.rpcClient.addTorrent(task.torrentContent, [], btOptions)
            : await this.rpcClient.addUri([task.url], btOptions)
          task.metaGid = task.torrentContent ? undefined : newGid
        } else {
          const options: Record<string, unknown> = {
            dir: task.dir,
            ...toAria2ProxyOption(this.deps.getProxy?.().effectiveUrl ?? null)
          }
          if (task.filename) {
            options.out = task.filename
          }
          newGid = await this.rpcClient.addUri([task.url], options)
        }

        // 更新 gid 映射
        task.gid = newGid
        this.gidToId.set(newGid, task.id)

        // v1.0 Task 8 · #100:覆盖任务(limitKBps = 0 / N)在新 gid 上补发一次任务级限速(走 changeOption,
        // 不塞进 addUri 选项);跟随全局者不补发(新进程启动参数 + 重启末尾 changeGlobalOption 让新 gid 自动继承)。
        // 补发失败只记日志、不置 error(限速丢失只是快 / 慢一点,不是黑洞)。与 resolveFollowedBy 的补发同形态。
        if (task.limitKBps !== undefined) {
          try {
            await this.rpcClient.changeOption(newGid, toAria2TaskLimitOption(task.limitKBps))
          } catch (err) {
            console.error(`[DownloadEngine] 重提后补发单任务限速失败(不崩): ${task.id}`, err)
          }
        }

        // await 模式 BT(未定型待选)重提:realGid 以暂停态创建(pause-metadata/pause),内部保持 paused
        // 待选(torrentInfoEmitted 已置,元数据到达经 resolveFollowedBy/兜底再置 paused);其余按 desiredState。
        if (task.isTorrent && task.awaitSelection) {
          task.status = 'paused'
        } else if (task.desiredState === 'paused') {
          await this.rpcClient.pause(newGid)
          task.status = 'paused'
        } else {
          task.status = 'downloading'
        }

        console.log(`[DownloadEngine] 重提任务成功: ${task.id} (新 gid: ${newGid})`)
      } catch (err) {
        console.error(`[DownloadEngine] 重提任务失败: ${task.id}`, err)
        task.status = 'error'
      }
    }
  }

  /**
   * 确保进度轮询已启动（仅当有活动任务时）
   */
  private ensurePolling(): void {
    if (this.pollTimer) {
      return // 已在轮询
    }

    const interval = this.opts.pollInterval || 1000

    this.pollTimer = setInterval(() => {
      this.pollProgress().catch((err) => {
        console.error('[DownloadEngine] 进度轮询失败:', err)
      })
    }, interval)
  }

  /**
   * 停止进度轮询
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 检查是否需要停止轮询（无活动任务时）
   */
  private checkStopPolling(): void {
    const hasActiveTasks = Array.from(this.idToTask.values()).some(
      (task) => task.status === 'downloading' || task.status === 'queued'
    )

    if (!hasActiveTasks) {
      this.stopPolling()
    }
  }

  /**
   * 进度轮询逻辑
   */
  private async pollProgress(): Promise<void> {
    if (!this.rpcClient) {
      return
    }

    try {
      // 批量获取活动任务进度
      const rawStatuses = (await this.rpcClient.tellActive(PROGRESS_KEYS)) as Aria2ProgressStatus[]

      // 当前轮的 gid 集合
      const currentGids = new Set(rawStatuses.map((s) => s.gid))

      // 检测状态翻转：上轮在 active、本轮消失 → 查终态。
      // 快照遍历:BT followedBy 转移会在循环内改写 gidToId(删 metaGid / 加 realGid),不动 live 迭代器。
      for (const [gid, id] of Array.from(this.gidToId.entries())) {
        const task = this.idToTask.get(id)
        if (!task) continue

        // 上轮是活动态，本轮消失
        if ((task.status === 'downloading' || task.status === 'queued') && !currentGids.has(gid)) {
          if (task.isTorrent && task.metaGid === gid) {
            // BT 元数据 gid 离场 ≠ 任务完成(spec §5.3):经 followedBy 转移到真实下载 gid,
            // 不走 checkFinalStatus(那会把元数据完成误判为任务 completed)
            await this.resolveFollowedBy(gid, id)
          } else {
            await this.checkFinalStatus(gid, id)
          }
        }
      }

      // 解析并触发进度事件（节流去重）
      for (const rawStatus of rawStatuses) {
        const gid = rawStatus.gid
        const id = this.gidToId.get(gid)
        if (!id) continue

        const progress = parseProgress(rawStatus, id)
        this.decorateHttpPath(progress, rawStatus, this.idToTask.get(id))
        // 做种派生位(v0.3 Task 3 · spec §4):parseProgress 后、emit 前附加(引擎侧才知 isTorrent + 做种开档)
        this.decorateSeeding(progress, rawStatus, this.idToTask.get(id))

        // 节流去重：同 id 字段无变化不重复触发
        if (this.shouldEmitProgress(id, progress)) {
          this.emitProgress(progress)
          this.updateProgressCache(id, progress)

          // 更新任务状态
          const task = this.idToTask.get(id)
          if (task) {
            task.status = progress.status
          }
        }
      }

      // 首次 torrentInfo 兜底(spec §5.3):.torrent(无元数据阶段)或未在 metaGid 离场瞬间捕获的
      // magnet(metaGid 已清)→ 活动期从 tellStatus.bittorrent 读出 info 即发一帧 torrentInfo。
      // Task 2(spec §5.1):await 的 .torrent 以暂停态创建(status=paused)、磁力 await 元数据到达后置
      // paused,故兜底条件纳入「awaitSelection && paused」,使暂停态种子也能读出 files 发 torrentInfo。
      for (const task of this.idToTask.values()) {
        if (
          task.isTorrent &&
          !task.torrentInfoEmitted &&
          !task.metaGid &&
          (task.status === 'downloading' ||
            task.status === 'queued' ||
            (task.awaitSelection === true && task.status === 'paused'))
        ) {
          await this.tryEmitTorrentInfo(task)
        }
      }

      // 检查是否需要停止轮询
      this.checkStopPolling()
    } catch (err) {
      // 进度轮询失败不中断引擎
      console.error('[DownloadEngine] tellActive 失败:', err)
    }
  }

  /**
   * 检查任务终态（completed / error）
   */
  private async checkFinalStatus(gid: string, id: string): Promise<void> {
    if (!this.rpcClient) return

    try {
      const rawStatus = (await this.rpcClient.tellStatus(gid, PROGRESS_KEYS)) as Aria2ProgressStatus

      const progress = parseProgress(rawStatus, id)
      this.decorateHttpPath(progress, rawStatus, this.idToTask.get(id))

      // 触发终态进度事件
      this.emitProgress(progress)

      // 更新任务状态
      const task = this.idToTask.get(id)
      if (task) {
        task.status = progress.status
      }
    } catch (err) {
      console.error(`[DownloadEngine] tellStatus 失败 (gid: ${gid}):`, err)
    }
  }

  /**
   * BT 元数据完成 → followedBy 两段 gid 转移(v0.3 Task 1 · spec §5.3):
   * `tellStatus(metaGid).followedBy[0]` = 真实下载 gid(follow-torrent 自动跟进)→ 重映射
   * gid(metaGid → realGid,进度归属**同一**内部 id)→ 发一帧带 torrentInfo。
   * 无 followedBy(元数据获取失败 / 被移除)→ 回落既有 checkFinalStatus(诚实 error / 终态)。
   */
  private async resolveFollowedBy(metaGid: string, id: string): Promise<void> {
    if (!this.rpcClient) return
    const task = this.idToTask.get(id)
    if (!task) return

    try {
      const raw = (await this.rpcClient.tellStatus(metaGid, BT_STATUS_KEYS)) as Aria2BtStatus
      const realGid = raw.followedBy?.[0]
      if (!realGid) {
        await this.checkFinalStatus(metaGid, id)
        return
      }
      this.gidToId.delete(metaGid)
      task.gid = realGid
      task.metaGid = undefined
      this.gidToId.set(realGid, id)
      // v1.0 Task 8 · #100:覆盖任务对 realGid 幂等补发一次任务级限速(不赌 followedBy 子下载是否继承父下载的
      // 任务级选项,多发一次无害);跟随全局者靠全局默认继承,不补发。自己的 try/catch,失败不影响 torrentInfo 帧。
      // 与 resubmitUnfinishedTasks 的补发同形态。
      if (task.limitKBps !== undefined) {
        try {
          await this.rpcClient.changeOption(realGid, toAria2TaskLimitOption(task.limitKBps))
        } catch (err) {
          console.error(`[DownloadEngine] followedBy 后补发单任务限速失败(不崩): ${id}`, err)
        }
      }
      // await 模式(元数据后暂停待选,Task 2 · spec §5.1):realGid 经 pause-metadata 以暂停态存在,
      // 内部标记 paused 与实况一致(避免 flip 误判);非 await(Task 1 整包 / 定型重提)保持 downloading
      task.status = task.awaitSelection ? 'paused' : 'downloading'
      // 真实 gid 已可读 bittorrent.info(name / files / totalLength)→ 就地发 torrentInfo 帧;
      // 读不出(极端时序)由 pollProgress 的兜底循环下一轮补发
      await this.tryEmitTorrentInfo(task)
    } catch (err) {
      console.error(`[DownloadEngine] followedBy 转移失败 (metaGid: ${metaGid}):`, err)
    }
  }

  /**
   * 从 `tellStatus(realGid)` 读 bittorrent.info,组 torrentInfo 随进度帧发出(spec §5.3)。
   * info 未就绪(name 缺)→ 静默返回,下一轮兜底再试;成功即置 torrentInfoEmitted(只发一次)。
   */
  private async tryEmitTorrentInfo(task: InternalTask): Promise<void> {
    if (!this.rpcClient || !task.gid) return
    try {
      const raw = (await this.rpcClient.tellStatus(task.gid, BT_STATUS_KEYS)) as Aria2BtStatus
      const name = raw.bittorrent?.info?.name
      if (!name) return
      const torrentInfo: TorrentInfo = {
        name,
        infoHash: raw.infoHash ?? null,
        totalBytes: Number(raw.totalLength ?? '0') || 0,
        files: (raw.files ?? []).map((f) => ({
          path: toTorrentRelPath(String(f.path ?? ''), task.dir),
          length: Number(f.length ?? '0') || 0,
          selected: true // Task 1 整包全选(文件选择留 Task 2)
        }))
      }
      task.torrentInfoEmitted = true
      this.emitProgress({ ...parseProgress(raw, task.id), torrentInfo })
    } catch (err) {
      console.error(`[DownloadEngine] 读取种子元信息失败 (gid: ${task.gid}):`, err)
    }
  }

  /** Native HTTP path is authoritative after writing; do not sanitize again or move data/control. */
  private decorateHttpPath(
    progress: DownloadProgress,
    rawStatus: Aria2ProgressStatus,
    task: InternalTask | undefined
  ): void {
    if (!task || task.isTorrent) return
    const path = rawStatus.files?.[0]?.path
    if (typeof path !== 'string' || path.trim() === '') return
    progress.savePath = path
    // aria2 uses both slash styles on Windows. Keep the actual basename for crash resubmission.
    task.filename = basename(path.replace(/\\/g, '/'))
  }

  /**
   * 做种派生位标注(v0.3 Task 3 · spec §4):BT 任务下载满(已下≥总>0)且 aria2 原始 `status==='active'`
   * (做种期停在 active)且做种开档 → `progress.seeding=true`。关档 / 非 BT / 未满 → 不设(undefined)。
   * 富进度三字段(numSeeders/uploadSpeed/uploadLength)已由 parseProgress 解出;此处只补引擎侧才知的
   * isTorrent + getSeedConfig()。放在 parseProgress 后、emit 前,parseProgress 保持纯净(spec §4)。
   */
  private decorateSeeding(
    progress: DownloadProgress,
    rawStatus: Aria2ProgressStatus,
    task: InternalTask | undefined
  ): void {
    if (
      task?.isTorrent &&
      progress.totalBytes > 0 &&
      progress.downloadedBytes >= progress.totalBytes &&
      rawStatus.status === 'active' &&
      this.deps.getSeedConfig?.().enabled === true
    ) {
      progress.seeding = true
    }
  }

  /**
   * 判断是否应触发进度事件（节流去重）
   */
  private shouldEmitProgress(id: string, progress: DownloadProgress): boolean {
    const cached = this.progressCache.get(id)
    if (!cached) {
      return true // 首次，必须触发
    }

    // 比较关键字段
    return (
      cached.status !== progress.status ||
      cached.downloadedBytes !== progress.downloadedBytes ||
      cached.speed !== progress.speed ||
      cached.savePath !== progress.savePath
    )
  }

  /**
   * 更新进度缓存
   */
  private updateProgressCache(id: string, progress: DownloadProgress): void {
    this.progressCache.set(id, {
      status: progress.status,
      downloadedBytes: progress.downloadedBytes,
      speed: progress.speed,
      savePath: progress.savePath
    })
  }

  /**
   * 触发进度回调
   */
  private emitProgress(progress: DownloadProgress): void {
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress)
      } catch (err) {
        console.error('[DownloadEngine] 进度回调失败:', err)
      }
    }
  }

  /**
   * 生成内部任务 id
   */
  private generateId(): string {
    if (this.deps.idGenerator) {
      return this.deps.idGenerator()
    }
    return `dl_${++this.nextIdCounter}_${Date.now()}`
  }
}
