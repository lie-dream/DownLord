import type { AddUriInput, DownloadProgress, ProxyResolved, TorrentInfo } from '../../shared/ipc'
import type { TaskEngine } from '../tasks/taskManager'
import type { SeedConfig } from './btOptions'

type TimerHandle = ReturnType<typeof setInterval>

/** 视频任务下载完成后,模拟 yt-dlp 后处理(合并 / 转码)持续的进度帧数(dev 手测可见 proc 条,spec §4.5) */
const VIDEO_PROCESSING_FRAMES = 2

/** BT 任务模拟磁力元数据阶段的帧数(不含 torrentInfo,Task 侧保持 resolving;v0.3 spec §9) */
const TORRENT_META_FRAMES = 2

/** BT 做种模拟帧数(v0.3 Task 3):开档下载满后发若干 seeding 帧(上行 / seeding:true),耗尽转 completed(模拟达 seed 条件自然停) */
const SEED_FRAMES = 3

interface FakeDeps {
  setInterval?: (fn: () => void, ms: number) => TimerHandle
  clearInterval?: (handle: TimerHandle) => void
  totalBytes?: number
  stepBytes?: number
  intervalMs?: number
  /** 接同签名注入但 dev **忽略**(不真正连网,spec §4.4):仅为与真实 DownloadEngine 类型一致、dev:fake 可跑 */
  getProxy?: () => ProxyResolved
  /** 接同签名注入但 dev **忽略**值(不真限速,spec §6.6):仅为与真实引擎类型一致、dev:fake 可跑 */
  getSpeedLimit?: () => number
  /**
   * 接同签名注入(v0.3 Task 3):dev:fake 据 `enabled` 决定下载满后是否插做种帧(SEED_FRAMES 帧,上行 / seeding:true),
   * 不真做种。与真实 DownloadEngineDeps.getSeedConfig 类型一致,index dev:fake 装配可传。
   */
  getSeedConfig?: () => SeedConfig
}

interface FakeTask {
  id: string
  url: string
  done: number
  total: number
  step: number
  handle: TimerHandle | null
  failed: boolean
  failOnce: boolean
  /** 视频任务:下载完成后模拟一段 yt-dlp 后处理(phase:'processing')再 completed(spec §4.5) */
  isVideo: boolean
  /** 剩余后处理帧数(video 初始 VIDEO_PROCESSING_FRAMES,http 恒 0) */
  processingLeft: number
  /** BT 任务:先若干元数据帧 → 一帧 torrentInfo → 整包下载 → completed(v0.3 spec §9) */
  isTorrent: boolean
  /** 剩余元数据帧数(torrent 初始 TORRENT_META_FRAMES,其余恒 0) */
  metaFramesLeft: number
  /** 是否已发过 torrentInfo 帧 */
  torrentInfoEmitted: boolean
  /**
   * await 模式:提交带 awaitSelection(元数据后暂停待选,v0.3 Task 2 · spec §5.1 / §9.3)。
   * 真时 torrentInfo 帧后置 `btPaused`(模拟 pause-metadata),停推进直到 `resume`(unpause)。
   */
  torrentAwaitSelection: boolean
  /** 单文件种子(url 含 'single' 触发豁免路径,§2.2 单文件不待选);否则多文件(≥3,待选) */
  torrentSingleFile: boolean
  /** BT 元数据后暂停待选中:置 true 则 run 循环不推进(模拟 pause-metadata 暂停),resume 解除 */
  btPaused: boolean
  /** BT 做种(v0.3 Task 3):下载满后剩余 seeding 帧数(开档 SEED_FRAMES,关档 / 非 torrent 恒 0) */
  seedFramesLeft: number
  /** 正在做种中(已下满、发 seeding 帧);stopSeeding / 帧耗尽 → false */
  seeding: boolean
  /** 累计模拟上传字节(uploadLength;做种帧累加) */
  uploadedBytes: number
}

export class FakeEngine implements TaskEngine {
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private readonly tasks = new Map<string, FakeTask>()
  private readonly failedOnceUrls = new Set<string>()
  /** applyTorrentSelection 收到的 arg 记录(集成断言用:引擎收到正确 --select-file;dev no-op 不真过滤字节) */
  readonly applyTorrentSelectionCalls: Array<{ id: string; arg: string | null }> = []
  /** stopSeeding 收到的 id 记录(集成断言用:停做种 → 引擎 stopSeeding;v0.3 Task 3) */
  readonly stopSeedingCalls: string[] = []
  private readonly setIntervalFn: NonNullable<FakeDeps['setInterval']>
  private readonly clearIntervalFn: NonNullable<FakeDeps['clearInterval']>
  private readonly totalBytes: number
  private readonly stepBytes: number
  private readonly intervalMs: number
  /** 注入的做种档读取(v0.3 Task 3;dev:fake 据 enabled 决定是否插做种帧) */
  private readonly getSeedConfigFn?: FakeDeps['getSeedConfig']
  private nextId = 0

  constructor(deps: FakeDeps = {}) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => clearInterval(handle))
    this.totalBytes = deps.totalBytes ?? 64 * 1024 * 1024
    this.stepBytes = deps.stepBytes ?? Math.floor(this.totalBytes / 16)
    this.intervalMs = deps.intervalMs ?? 500
    this.getSeedConfigFn = deps.getSeedConfig
  }

  async start(): Promise<void> {
    /* no-op:FakeEngine 无真实子进程可启动,dev 模拟引擎在 addUri 时即驱动帧序;空体刻意,仅满足 TaskEngine 接口 */
  }

  async stop(): Promise<void> {
    for (const task of this.tasks.values()) {
      this.clear(task)
    }
  }

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  async addUri(input: AddUriInput): Promise<string> {
    const id = `fake_${++this.nextId}`
    const slow = /slow/i.test(input.url)
    const failOnce = /failonce/i.test(input.url)
    const shouldFail = /fail/i.test(input.url) && (!failOnce || !this.failedOnceUrls.has(input.url))
    // 视频任务:TaskManager 出队带 video(VideoSubmit),或 url 含 video 关键字(dev 直触,spec §4.5)
    const isVideo = input.video !== undefined || /video/i.test(input.url)
    // BT 任务:TaskManager 带 torrent 标记,或 url 是 magnet(dev 直触,v0.3 spec §9)
    const isTorrent = input.torrent !== undefined || /^magnet:/i.test(input.url)
    // await 模式:仅当 TaskManager 首次 / 待选恢复提交显式带 awaitSelection=true → 元数据后暂停待选(§5.1);
    // 已定型重提(带 selectFile,无 awaitSelection)/ dev 直触 magnet(无 torrent 字段)→ 不待选、整包直下
    const torrentAwaitSelection = input.torrent?.awaitSelection === true
    // 做种档(v0.3 Task 3):dev:fake 据注入的 getSeedConfig().enabled 决定下载满后是否插 seeding 帧(不真做种)
    const seedOn = isTorrent && this.getSeedConfigFn?.().enabled === true
    const task: FakeTask = {
      id,
      url: input.url,
      done: 0,
      total: this.totalBytes,
      step: slow ? Math.max(1, Math.floor(this.stepBytes / 8)) : this.stepBytes,
      handle: null,
      failed: shouldFail,
      failOnce,
      isVideo,
      processingLeft: isVideo ? VIDEO_PROCESSING_FRAMES : 0,
      isTorrent,
      metaFramesLeft: isTorrent ? TORRENT_META_FRAMES : 0,
      torrentInfoEmitted: false,
      torrentAwaitSelection,
      torrentSingleFile: /single/i.test(input.url),
      btPaused: false,
      seedFramesLeft: seedOn ? SEED_FRAMES : 0,
      seeding: false,
      uploadedBytes: 0
    }

    this.tasks.set(id, task)
    this.run(task)
    return id
  }

  async pause(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (task) {
      this.clear(task)
    }
  }

  async resume(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (task) {
      // 解除 BT 待选暂停(模拟 aria2 unpause):选定文件后 TaskManager 出队经 resume 继续下载(§5.2)
      task.btPaused = false
      if (!task.handle) {
        this.run(task)
      }
    }
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (task) {
      this.clear(task)
      this.tasks.delete(id)
    }
  }

  /** 全局限速(v0.2 Task 2 · spec §6.6):dev:fake **no-op**(不真限速,与忽略 proxy 同构;仅保证类型一致 / 可交互手测) */
  async setGlobalLimit(_kbps: number): Promise<void> {
    /* no-op:dev:fake 不真限速(见上 JSDoc);空体刻意,仅保持与真实引擎类型一致 */
  }

  /** 单任务限速(v0.2 Task 2 · spec §6.6;v0.3 Task 4 #25 值域扩 number|null):dev:fake **no-op**(不真限速) */
  async setTaskLimit(_id: string, _kbps: number | null): Promise<void> {
    /* no-op:dev:fake 不真限速(见上 JSDoc);空体刻意 */
  }

  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §9.3):dev:fake **记录 arg**(供集成断言引擎收到正确 --select-file),
   * 不真过滤字节(整包仍下载,选择语义由 TaskManager 落 torrentMeta 断言)。全选时 TaskManager 传 arg=null。
   */
  async applyTorrentSelection(id: string, selectFileArg: string | null): Promise<void> {
    this.applyTorrentSelectionCalls.push({ id, arg: selectFileArg })
  }

  /**
   * 停止做种(v0.3 Task 3 · spec §7):dev:fake **记调用** + 停 seeding 帧序 → 收尾 completed 帧(seeding 派生 false)。
   * 真做种由 aria2 承担,fake 只驱动帧序供集成断言(停做种 → TaskProgress seeding:false)。
   */
  async stopSeeding(id: string): Promise<void> {
    this.stopSeedingCalls.push(id)
    const task = this.tasks.get(id)
    if (task && task.seeding) {
      task.seedFramesLeft = 0
      task.seeding = false
      this.emit(task, 'completed')
      this.clear(task)
    }
  }

  private run(task: FakeTask): void {
    task.handle = this.setIntervalFn(() => {
      if (task.failed) {
        this.emit(task, 'error', { errorCode: '模拟失败 — 测试用' })
        this.clear(task)
        if (task.failOnce) {
          this.failedOnceUrls.add(task.url)
          task.failed = false
        }
        return
      }

      // BT 帧序(v0.3 spec §9):元数据帧(不含 torrentInfo,Task 侧保持 resolving)→ 一帧 torrentInfo
      // (多文件默认待选 / url 含 'single' → 单文件豁免)→ await 则暂停(pause-metadata)待 resume → 整包推进 → completed
      if (task.isTorrent && task.metaFramesLeft > 0) {
        task.metaFramesLeft--
        this.emit(task, 'downloading')
        return
      }
      if (task.isTorrent && !task.torrentInfoEmitted) {
        task.torrentInfoEmitted = true
        // await 模式:先置 btPaused=true 再 emit(模拟 pause-metadata):emit 同步驱动 TaskManager,单文件豁免会
        // 同步回调 engine.resume 解除 btPaused;若在 emit 后才置位,会覆盖 resume 的解除致永久暂停(§5.1 再入序)
        if (task.torrentAwaitSelection) {
          task.btPaused = true
        }
        this.emit(task, 'downloading', { torrentInfo: this.fakeTorrentInfo(task) })
        return
      }
      // BT 待选暂停中:不推进(等 TaskManager 选定 → resume 解除)
      if (task.btPaused) {
        return
      }

      // 下载已满:视频任务先发若干后处理帧(phase:'processing'),耗尽后 completed(spec §4.5)
      if (task.done >= task.total) {
        if (task.processingLeft > 0) {
          task.processingLeft--
          this.emit(task, 'downloading', { phase: 'processing' })
          return
        }
        // BT 做种(v0.3 Task 3):开档 → 下载满后发 seedFramesLeft 帧 seeding(status 仍 downloading、bytes 100%、
        // 上行 / numSeeders / seeding:true),TaskManager 据字节判 completed + seeding runtime;帧耗尽(模拟达 seed
        // 条件自然停)→ 收尾 completed(seeding 派生 false)
        if (task.isTorrent && task.seedFramesLeft > 0) {
          task.seedFramesLeft--
          task.seeding = true
          this.emit(task, 'downloading', { seeding: true })
          return
        }
        this.emit(task, 'completed')
        this.clear(task)
        return
      }

      // 推进下载
      task.done = Math.min(task.total, task.done + task.step)
      if (task.done >= task.total && !task.isVideo) {
        // BT 做种开档:填满即发首帧 seeding(bytes 100%),后续帧由上方 done>=total 块续发;timer 续跑(不 clear)
        if (task.isTorrent && task.seedFramesLeft > 0) {
          task.seedFramesLeft--
          task.seeding = true
          this.emit(task, 'downloading', { seeding: true })
          return
        }
        // 直链 / BT(关档)下载满即 completed
        this.emit(task, 'completed')
        this.clear(task)
        return
      }

      // 下载中帧:video 带 phase:'downloading'(归一进度),http 不带 phase(不污染 aria2 契约)
      this.emit(task, 'downloading', task.isVideo ? { phase: 'downloading' } : {})
    }, this.intervalMs)
  }

  /**
   * 构造假种子信息(v0.3 Task 2 · spec §9.3):多文件(≥3,含目录层级路径,触发 awaiting_selection)
   * 或单文件(url 含 'single',触发整包豁免直下)。lengths 求和 = total(与 emit 的 totalBytes 自洽)。
   */
  private fakeTorrentInfo(task: FakeTask): TorrentInfo {
    if (task.torrentSingleFile) {
      return {
        name: 'Fake Single',
        infoHash: '51ce1e51ce1e51ce1e51ce1e51ce1e51ce1e51ce',
        totalBytes: task.total,
        files: [{ path: 'Fake Single/movie.mkv', length: task.total, selected: true }]
      }
    }
    const a = Math.floor(task.total / 2)
    const b = Math.floor(task.total / 4)
    return {
      name: 'Fake Torrent',
      infoHash: 'f4kef4kef4kef4kef4kef4kef4kef4kef4kef4ke',
      totalBytes: task.total,
      files: [
        { path: 'Fake Torrent/season/ep1.mkv', length: a, selected: true },
        { path: 'Fake Torrent/season/ep2.mkv', length: b, selected: true },
        { path: 'Fake Torrent/info.nfo', length: task.total - a - b, selected: true }
      ]
    }
  }

  private clear(task: FakeTask): void {
    if (task.handle) {
      this.clearIntervalFn(task.handle)
      task.handle = null
    }
  }

  private emit(
    task: FakeTask,
    status: DownloadProgress['status'],
    opts: {
      errorCode?: string
      phase?: DownloadProgress['phase']
      torrentInfo?: TorrentInfo
      seeding?: boolean
    } = {}
  ): void {
    // 后处理帧(phase:'processing')/ 做种帧(seeding)语义上不在下载,downloadSpeed 归零(spec §4.3);http 帧不设 phase
    const isActiveDownload =
      status === 'downloading' && opts.phase !== 'processing' && !opts.seeding
    const progress: DownloadProgress = {
      id: task.id,
      status,
      totalBytes: task.total,
      downloadedBytes: task.done,
      speed: isActiveDownload ? task.step * (1000 / this.intervalMs) : 0,
      connections: 8,
      errorCode: opts.errorCode,
      phase: opts.phase,
      torrentInfo: opts.torrentInfo
    }
    if (opts.seeding) {
      // 做种富进度(v0.3 Task 3;仅内存 + IPC,不落库):模拟上行 / 做种数 / 累计上传
      const up = Math.max(1, Math.floor((task.step * (1000 / this.intervalMs)) / 2))
      task.uploadedBytes += up
      progress.seeding = true
      progress.uploadSpeed = up
      progress.numSeeders = 3
      progress.uploadLength = task.uploadedBytes
    }

    for (const callback of this.callbacks) {
      callback(progress)
    }
  }
}
