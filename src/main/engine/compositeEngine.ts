/**
 * CompositeDownloadEngine — 双执行器路由(实现 TaskEngine,spec §4.1 / ARCHITECTURE §4)。
 *
 * TaskManager 仍只持**一个** engine(注入本路由),对后端类型无感:直链(无 `video`)走 aria2
 * `DownloadEngine`,视频(带 `video`)走 yt-dlp `VideoEngine`。**addUri 是唯一分流点**;
 * 记 id→backend 供 pause/resume/remove 按 id 回查;onProgress 合并两路;id 直接透传后端(不重映射)。
 *
 * aria2 不消费 video / phase 输入;HTTP 实际 savePath 由原生 files.path 进度回报。
 */
import type { AddUriInput, DownloadProgress } from '../../shared/ipc'
import type { TaskEngine } from '../tasks/taskManager'
import type { BtTrackerApplyResult } from './downloadEngine'

/** 受管后端:TaskEngine + 生命周期(aria2 DownloadEngine / yt-dlp VideoEngine 均满足) */
export interface ManagedTaskEngine extends TaskEngine {
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * 全局限速 push(v0.2 Task 2 · spec §2.2):aria2 后端经 changeGlobalOption 即时改运行中;
   * 视频后端靠 getSpeedLimit pull(每次 spawnFor 实时读)无需 push,故可选。
   */
  setGlobalLimit?(kbps: number): Promise<void>
  /**
   * 单任务限速(v0.2 Task 2 · spec §2.3):按 id 路由后端;aria2 即时 / video 下次继续生效。可选(便于 mock)。
   * v0.3 Task 4 #25:值域 `number | null`(`null` = 清除任务级覆盖 = 跟随全局)。
   */
  setTaskLimit?(id: string, kbps: number | null): Promise<void>
  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §5.2 / §5.4):按 id 路由后端(torrent 天然在 aria2 http 后端),
   * 经 aria2 `changeOption(select-file)` 在暂停态下发。可选(仅 aria2 后端实现;video 后端无 BT)。
   */
  applyTorrentSelection?(id: string, selectFileArg: string | null): Promise<void>
  /**
   * 停止单任务做种(v0.3 Task 3 · spec §7):按 id 路由后端 → `forcePause` 停上传(保留文件 + `.aria2`)。
   * 仅 aria2 后端实现(torrent 天然在 http 后端);video 后端无 BT,可选链 no-op。可选(便于 mock)。
   */
  stopSeeding?(id: string): Promise<void>
  /**
   * tracker 表热应用 + 追补(v0.4 Task 1 · spec §4.2 push 通道):**非任务粒度**,直转 aria2 后端
   * (仿 `setGlobalLimit`);video 后端无 BT,不转发。可选(便于 mock)。
   */
  applyBtTrackers?(trackers: readonly string[]): Promise<BtTrackerApplyResult>
}

export class CompositeDownloadEngine implements ManagedTaskEngine {
  /** 内部任务 id → 受理后端,供 pause/resume/remove 回查 */
  private readonly route = new Map<string, ManagedTaskEngine>()

  constructor(
    private readonly http: ManagedTaskEngine,
    private readonly video: ManagedTaskEngine
  ) {}

  async start(): Promise<void> {
    await this.http.start()
    await this.video.start()
  }

  async stop(): Promise<void> {
    await this.video.stop()
    await this.http.stop()
  }

  /** Filename preflight has no business id/route and belongs exclusively to the HTTP backend. */
  async resolveHttpFilename(
    input: Pick<AddUriInput, 'url' | 'dir' | 'headers'>
  ): Promise<string | null> {
    return (await this.http.resolveHttpFilename?.(input)) ?? null
  }

  async addUri(input: AddUriInput): Promise<string> {
    // 唯一分流点。torrent(v0.3 Task 1)不带 video → 天然路由到 aria2 http 后端
    // (aria2 单进程原生支持 BT,spec §1.3 / §10.2),路由不改。
    const backend = input.video ? this.video : this.http
    const id = await backend.addUri(input)
    this.route.set(id, backend)
    return id
  }

  async pause(id: string): Promise<void> {
    await this.pick(id).pause(id)
  }

  async resume(id: string): Promise<void> {
    await this.pick(id).resume(id)
  }

  async remove(id: string): Promise<void> {
    const backend = this.pick(id)
    this.route.delete(id)
    await backend.remove(id)
  }

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    const offHttp = this.http.onProgress(callback)
    const offVideo = this.video.onProgress(callback)
    return () => {
      offHttp()
      offVideo()
    }
  }

  /**
   * 全局限速(v0.2 Task 2 · spec §2.2):仅转 aria2 直链后端 push(changeGlobalOption 即时改运行中);
   * 视频后端靠注入的 getSpeedLimit pull(每次 spawnFor 实时读),无需在此 push(§6.4)。
   */
  async setGlobalLimit(kbps: number): Promise<void> {
    await this.http.setGlobalLimit?.(kbps)
  }

  /**
   * 单任务限速(v0.2 Task 2 · spec §2.3):按 id 回查受理后端并转发(aria2 即时 / video 下次继续生效)。
   * v0.3 Task 4 #25:`kbps` 三态(`null`=跟随全局 / `0`=本任务不限 / `>0`=限速值)原样透传后端,路由不做语义解释。
   */
  async setTaskLimit(id: string, kbps: number | null): Promise<void> {
    await this.pick(id).setTaskLimit?.(id, kbps)
  }

  /**
   * BT 文件选择定型(v0.3 Task 2 · spec §5.2 / §5.4):按 id 回查受理后端并转发。
   * torrent 无 `video` → 天然落 aria2 http 后端,由其 `changeOption(select-file)` 在暂停态下发;
   * video 后端不实现(可选链 no-op),不污染视频路径。
   */
  async applyTorrentSelection(id: string, selectFileArg: string | null): Promise<void> {
    await this.pick(id).applyTorrentSelection?.(id, selectFileArg)
  }

  /**
   * 停止做种(v0.3 Task 3 · spec §7):按 id 回查受理后端并转发(torrent 天然落 aria2 http 后端,
   * 经其 `forcePause` 停上传);video 后端不实现(可选链 no-op),不污染视频路径。仿 applyTorrentSelection 分派。
   */
  async stopSeeding(id: string): Promise<void> {
    await this.pick(id).stopSeeding?.(id)
  }

  /**
   * tracker 表热应用 + 追补(v0.4 Task 1 · spec §4.2 push 通道):仿 `setGlobalLimit` —— **非任务粒度**,
   * 不经 `pick(id)`,直转 aria2 直链后端(BT 天然只在该后端);video 后端无 BT,**不转发**。
   * 后端未实现(fake / mock)→ 诚实回全零,不假装成功。
   */
  async applyBtTrackers(trackers: readonly string[]): Promise<BtTrackerApplyResult> {
    return (
      (await this.http.applyBtTrackers?.(trackers)) ?? { globalOk: false, patched: 0, failed: 0 }
    )
  }

  /** 按 id 回查受理后端;未知 id(未提交 / 已移除)抛错 */
  private pick(id: string): ManagedTaskEngine {
    const backend = this.route.get(id)
    if (!backend) {
      throw new Error(`未知任务 id(无受理后端): ${id}`)
    }
    return backend
  }
}
