/**
 * VideoEngine — yt-dlp 下载后端(实现 TaskEngine,spec §3 / ARCHITECTURE §4 / §7.1)。
 *
 * 与 aria2 后端的根本差异:aria2 是单常驻守护 + 多任务 RPC;yt-dlp 是**每任务一进程**(无常驻 RPC)。
 * 两者经 `TaskEngine` 抹平,对 TaskManager 透明(经 CompositeDownloadEngine 路由)。
 *
 * 视频经 **yt-dlp 后端**下载(非自拆直链交 aria2):分片 / 合并 / 站点怪癖全交 yt-dlp;
 * 合并 / 音频提取交 **yt-dlp 内部 ffmpeg**(`--ffmpeg-location`,MediaTool 退化,§5)。
 * 进度从 stdout 逐行解析(`parseYtDlpLine`),归一成与 aria2 一致的 `DownloadProgress`:
 * progress → downloading;postprocess → `phase:'processing'`(一次性);exit 0 → completed(带终路径
 * savePath);exit≠0 且非主动 kill → error(`mapDownloadError`)。
 *
 * 续传归属(§7.4):pause=kill(保 `.part`)、resume=同参数重起(靠 `.part` / `--continue`),
 * DownLord 不自存字节进度。主动 kill 置 per-child 标志,close 时不发 error/completed。
 * Windows 进程树:合并期 yt-dlp 拉起 ffmpeg 子进程,`child.kill()` 之外以 `taskkill /T /F`
 * 树杀兜底(注入式,默认仅 win32),防 ffmpeg 残留(§3.5)。
 */
import type { ChildProcess } from 'child_process'
import { readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import type { AddUriInput, CookieConfig, DownloadProgress, ProxyResolved } from '../../shared/ipc'
import type { TaskEngine } from '../tasks/taskManager'
import { buildYtDlpDownloadArgs } from './ytdlpArgs'
import { parseYtDlpLine } from './ytdlpProgress'
import { ytdlpSpawnEnv } from './ytdlpEnv'
import { mapDownloadError, type ExtensionCookieFacts } from './resolveError'
import { resolveCookieHosts } from './cookieDomains'
import { extensionCookieContextOf } from './cookieLeaseFactory'
import type { CookieLease } from './tempCookieFile'

export interface VideoEngineDeps {
  spawn: typeof import('child_process').spawn
  /** Windows 树杀兜底(默认 win32 下 `taskkill /pid <pid> /T /F`);注入便于测试 / 跨平台 no-op。async:await 等 taskkill 执行完 */
  treeKill?: (pid: number) => void | Promise<void>
  /**
   * 注入式当前代理回调(Task 7 · spec §4.2)。每次 spawnFor(addUri / resume 重起)前**实时调用**
   * 取 effectiveUrl 传给 `buildYtDlpDownloadArgs`(切档即时生效);未注入 → 不追加 `--proxy`(向后兼容)。
   */
  getProxy?: () => ProxyResolved
  /**
   * 注入式当前 Cookie 回调(v0.2 Task 1 · spec §2.2 / §6.2,与 getProxy 完全对称)。每次 spawnFor
   * (addUri / resume 重起)前**实时调用**取 CookieConfig 传给 `buildYtDlpDownloadArgs`(切档即时生效;
   * resume 也读当前档);未注入 → 不追加 cookie 参数(向后兼容)。**cookie 是全局登录态实时读、不进任务持久化**;
   * 字幕选择随 `input.video.subtitles` 到位(rebuildVideoSubmit 重建),数据流不同。
   */
  getCookie?: () => CookieConfig
  /**
   * 第四档「从扩展获取」专用:为**本次 yt-dlp 进程**物化一份一次性 cookies.txt(v0.4 Task 6 · spec §2.3)。
   * 返回 `null` = 手上没有该任务需要的登录态 → 照常下载,只是不带 `--cookies`(参数与 `none` 档相同)。
   *
   * **未注入 → `undefined` → 恒不物化 → 与改动前逐字节等价**(与既有 `getProxy` / `getCookie` 同构)。
   * ⚠️ 拿到租约的一方**同时拿到删除责任**:释放点是 `child.on('close')` **最顶端** +
   * `child.on('error')`,各一次,靠幂等兜住重复(spec §4.4)。
   */
  leaseCookieFile?: (hosts: string[]) => CookieLease | null
  /**
   * 第四档专用:扩展通道**此刻是否连着**(启用 + 本次启动握手过)。
   *
   * ★ 它存在的唯一理由是把「没拿到登录态」分成 `unpaired` / `missing` 两半 —— 两半给用户的
   * 下一步完全不同(去配对 vs 回浏览器登录),合成一条必然指错一半人(spec §6.2)。
   * 未注入 → 保守判 `unpaired`(不知道就不声称连着)。
   */
  isExtensionLinked?: () => boolean
  /**
   * 注入式当前全局限速 KB/s(v0.2 Task 2 · spec §2.2,与 getProxy 完全对称)。每次 spawnFor(新任务 /
   * resume / 崩溃恢复)**实时读**;yt-dlp 每任务一进程无常驻 RPC → 只能下次 spawnFor 生效(运行中不改速)。
   * 任务级 `rec.limitKBps` 优先于全局。未注入 → 不限速(向后兼容)。
   */
  getSpeedLimit?: () => number
  /**
   * 注入式当前 aria2c 加速态(v0.2 Task 2 · spec §3.3 / §3.4)。`enabled` = 开关 && aria2c 可用(index
   * 装配期 `existsSync`);`aria2cPath` = 内置 aria2c 绝对路径(`--downloader` 定位)。每次 spawnFor 实时读。
   * 未注入 → 不挂 aria2c(用 yt-dlp 自带下载器,向后兼容)。
   */
  getVideoAccel?: () => { enabled: boolean; aria2cPath: string }
  /**
   * 落盘文件大小探针(注入式,默认真实 `fs.statSync().size`,失败 → null)。完成时从**最终文件**
   * 取真实大小(DASH 合并后总大小),而非最后一个流的进度(修完成显示 0B / 偏小,2026-07-01 手测)。
   */
  statSize?: (path: string) => number | null
  /**
   * 残留清理(注入式,默认真实 fs:删 `dir` 下 `outputBase.` 前缀的 `.part` / `.aria2` / `.ytdl`)。
   * **仅在 downloader 切换时调用**(aria2c↔自带:失败回退 / 用户切加速开关后 resume)——aria2c 16 段
   * 并行按偏移写,`.part` 长度早早≈总大小(中间有洞);自带下载器按文件长度定续传点 → Range 416 →
   * 「已下载完」假象,产出中段全零的坏文件(静默损坏)。同 downloader 续传不清理(§7.4)。
   */
  cleanPartials?: (dir: string, outputBase: string) => void
}

export interface VideoEngineConfig {
  /** resolveYtDlpPath 结果(优先可写副本,§1.1) */
  ytdlpPath: string
  /** 内置 ffmpeg 绝对路径(MediaTool.resolveFfmpegLocation,§5) */
  ffmpegPath: string
  /** 内置 aria2c 绝对路径(v0.2 Task 2 · spec §3.2,`--downloader` 定位;与 getVideoAccel().aria2cPath 同源) */
  aria2cPath: string
  /** 缺省落盘目录(input.dir 缺失时兜底;正常由 TaskManager 给 dir) */
  defaultDir: string
}

/** 单个 yt-dlp 下载任务的运行态(每任务一进程) */
interface VideoTaskRec {
  id: string
  input: AddUriInput
  child: ChildProcess | null
  /** 杀当前 child(先树杀再 child.kill)并标记其 close 为主动;async:等进程树真死(pause/remove/stop → 不发 error/completed) */
  killCurrent: (() => Promise<void>) | null
  /** yt-dlp `--print after_move:filepath` 回报的真实落盘路径(完成时随 completed 上报) */
  destination: string | null
  /**
   * 本次 spawn 内对外已报的最高字节 / 总量(发帧用;**spawnFor 重起归零**)。只在单次进程内取 max
   * 平滑抖动;不跨 spawn 保留——控制文件过期时新进程从低位重报是真实状态(那段要重下),钳在旧
   * 水位会把进度条冻死而速率照变(真机 2026-07-09 三轮「恢复后百分比不动、速率持续变化」)。
   */
  lastBytes: number
  lastTotal: number
  /** 已发过 phase:'processing'(后处理一次性,避免多行重复发) */
  postprocessing: boolean
  /** 单任务限速覆盖 KB/s(v0.2 Task 2 · spec §2.3,运行时内存态、不落库;下次 spawnFor 生效,优先于全局) */
  limitKBps?: number
  /** 本次 spawn 是否挂了 aria2c(回退判定用,spec §3.3) */
  accelUsed: boolean
  /** 已回退过一次自带下载器(防二次回退循环,spec §3.3) */
  accelFallbackTried: boolean
  /**
   * 选中 format 是否分片协议(HLS/DASH;v0.3 Task 4 · #24)。true → 主动不挂 aria2c(避免注定失败的
   * 加速回退):spawnFor 的 `useAccel &&= !fragmented`。false(progressive / 未知)→ 保守挂 + 回退(§7.1 不退化)。
   */
  fragmented: boolean
  /** 上次 spawn 用的下载器(null=尚未 spawn);与本次不同 → 先 cleanPartials(见 deps.cleanPartials) */
  lastDownloader: 'aria2c' | 'native' | null
  /**
   * 本次 spawn 内已完成流的累计字节(DASH 多流逐流下载、每流从 0 计;`dlp:finished` 时把该流
   * total 累进此基数,对外 downloadedBytes/totalBytes 单调不回跳 —— 否则切流 / 暂停恢复时
   * 进度条从 ~95% 跳回 0%,被感知为「从头下载」,真机 2026-07-09)。spawnFor 重起归零
   * (新进程从头汇报所有流:已完整流即刻 finished 重新累计,续传流从断点续报,衔接无缝)。
   */
  streamBase: number
}

export class VideoEngine implements TaskEngine {
  private readonly spawn: typeof import('child_process').spawn
  private readonly treeKill: (pid: number) => void | Promise<void>
  private readonly config: VideoEngineConfig
  private readonly getProxy?: () => ProxyResolved
  private readonly getCookie?: () => CookieConfig
  private readonly leaseCookieFile?: (hosts: string[]) => CookieLease | null
  private readonly isExtensionLinked?: () => boolean
  private readonly getSpeedLimit?: () => number
  private readonly getVideoAccel?: () => { enabled: boolean; aria2cPath: string }
  private readonly statSize: (path: string) => number | null
  private readonly cleanPartials: (dir: string, outputBase: string) => void

  private readonly tasks = new Map<string, VideoTaskRec>()
  private readonly callbacks = new Set<(progress: DownloadProgress) => void>()
  private counter = 0

  constructor(deps: VideoEngineDeps, config: VideoEngineConfig) {
    this.spawn = deps.spawn
    this.treeKill = deps.treeKill ?? ((pid) => this.defaultTreeKill(pid))
    this.config = config
    this.getProxy = deps.getProxy
    this.getCookie = deps.getCookie
    this.leaseCookieFile = deps.leaseCookieFile
    this.isExtensionLinked = deps.isExtensionLinked
    this.getSpeedLimit = deps.getSpeedLimit
    this.getVideoAccel = deps.getVideoAccel
    this.statSize =
      deps.statSize ??
      ((p) => {
        try {
          return statSync(p).size
        } catch {
          return null
        }
      })
    this.cleanPartials =
      deps.cleanPartials ??
      ((dir, outputBase) => {
        let entries: string[]
        try {
          entries = readdirSync(dir)
        } catch {
          return // 目录不存在 / 不可读 → no-op(best-effort)
        }
        const prefix = `${outputBase}.`
        for (const name of entries) {
          if (!name.startsWith(prefix)) continue
          // 只清下载残留:.part(半成品)/ .aria2(控制文件)/ .ytdl(分片状态);.part-Frag*(分片临时)。
          // 已完整落盘的 `<base>.fXXX.<ext>` / 最终文件不带这些后缀,不会被误删。
          const isPartial =
            name.endsWith('.part') ||
            name.endsWith('.aria2') ||
            name.endsWith('.ytdl') ||
            name.includes('.part-Frag')
          if (!isPartial) continue
          try {
            rmSync(join(dir, name), { force: true })
          } catch {
            // best-effort:单个删除失败不阻塞
          }
        }
      })
  }

  /** yt-dlp 无常驻守护进程,按任务起进程 → start 为 no-op(与 aria2 后端同接口) */
  async start(): Promise<void> {
    // no-op:无常驻守护进程,按任务起进程(见上方注释)
  }

  /** kill 所有在跑 yt-dlp 进程(主动关闭,不发终态事件);await 等各进程树真死 */
  async stop(): Promise<void> {
    const kills = Array.from(this.tasks.values()).map((rec) => rec.killCurrent?.())
    this.tasks.clear()
    await Promise.all(kills)
  }

  onProgress(callback: (progress: DownloadProgress) => void): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  async addUri(input: AddUriInput): Promise<string> {
    if (!input.video) {
      // 路由(CompositeDownloadEngine)保证视频任务带 video;防御性兜底
      throw new Error('VideoEngine.addUri 需要 video 提交参数(yt-dlp 后端)')
    }
    const id = `vid_${++this.counter}`
    const rec: VideoTaskRec = {
      id,
      input,
      child: null,
      killCurrent: null,
      destination: null,
      lastBytes: 0,
      lastTotal: 0,
      postprocessing: false,
      accelUsed: false,
      accelFallbackTried: false,
      fragmented: !!input.video?.fragmented, // #24:选中 format 分片(HLS/DASH)→ 不挂 aria2c(spec §2)
      lastDownloader: null,
      streamBase: 0
    }
    this.tasks.set(id, rec)
    this.spawnFor(rec)
    return id
  }

  /** 暂停:kill 当前进程(保 .part 续传),保留 rec 供 resume 重起;不发 error。await 等进程真死 */
  async pause(id: string): Promise<void> {
    await this.tasks.get(id)?.killCurrent?.()
  }

  /** 恢复:同参数重起 yt-dlp(靠 .part / --continue 续传) */
  async resume(id: string): Promise<void> {
    const rec = this.tasks.get(id)
    if (rec) {
      this.spawnFor(rec)
    }
  }

  /**
   * 删除:kill 进程树 + 清理映射。**await 等进程真正退出后才返回**(残留文件由 TaskManager 清理,§4)。
   * 关键:killChild 先 `taskkill /T /F` 树杀再 child.kill —— yt-dlp.exe(PyInstaller onefile)是
   * bootloader 父 + Python 子两进程,若先 child.kill 杀父会 orphan 子进程致下载不停(假取消,2026-07-01 手测)。
   */
  async remove(id: string): Promise<void> {
    const rec = this.tasks.get(id)
    if (rec) {
      this.tasks.delete(id)
      await rec.killCurrent?.()
    }
  }

  /**
   * 单任务限速(v0.2 Task 2 · spec §2.3;2026-07-09 行为升级):存 `rec.limitKBps`(覆盖全局,运行时
   * 内存态、不落库)。**正在下载 → 立即生效**:无缝重起本任务进程带新限速——等价用户手动暂停→继续,
   * `--auto-save-interval=1` 下续传损失 ≤~1s(真机反馈「单任务限速无效」:旧「下次 spawnFor 生效」
   * 对用户不可感知)。已暂停 / 无进程 → 只存值,resume 的 spawnFor 读 `rec.limitKBps ?? getSpeedLimit()`;
   * 后处理期不重起(kill 会打断 ffmpeg 合并,且下载已结束限速无意义)。
   *
   * v0.3 Task 4 #25 三态:`null` → `rec.limitKBps = undefined`(清除任务级覆盖 → spawnFor 的
   * `rec.limitKBps ?? globalKbps` **回落全局值**)/ `0` → 本任务真不限(覆盖全局)/ `>0` → 限速值。
   */
  async setTaskLimit(id: string, kbps: number | null): Promise<void> {
    const rec = this.tasks.get(id)
    if (!rec) return
    rec.limitKBps = kbps ?? undefined
    if (rec.child && !rec.postprocessing && rec.killCurrent) {
      // 落盘日志(logger 接管 console → main.log):真机验证「限速已触发无缝重起」的观测点
      const desc = kbps === null ? '跟随全局' : `${kbps} KB/s`
      console.log(`[VideoEngine] 单任务限速 ${desc} → 无缝重起任务 ${id} 立即生效`)
      await rec.killCurrent()
      this.spawnFor(rec)
    }
  }

  // ========== 内部:进程生命周期 ==========

  /** 起一个 yt-dlp 下载进程并挂接行流 / 退出处理(resume 时复用,新 child + 新 killed 闭包) */
  private spawnFor(rec: VideoTaskRec): void {
    const video = rec.input.video!
    // 实时取当前代理(切档即时生效;resume 重起也读当前档);未注入 → undefined → 不追加 --proxy
    const proxy = this.getProxy ? this.getProxy().effectiveUrl : undefined
    // 实时取当前 cookie(切档即时生效;resume 重起也读当前档);未注入 → undefined → 不追加 cookie
    const cookie = this.getCookie ? this.getCookie() : undefined
    // 第四档(v0.4 Task 6 · spec §2.4):**当场从已有数据重算**本次要哪些域 —— 不跟着任务传,
    // 故 `AddTaskInput` / `Task` / SQLite schema / `taskManager.ts` 一个字段都不用加。
    // ⚠️ 档位闸门在此:非第四档 → 恒 `[]` → 恒不调 `leaseCookieFile` → 零外泄(红线 R10)。
    // ⚠️ 每次 spawnFor(新任务 / resume / 限速重起 / 加速回退)**各建各的租约**:同域并发各写各的,
    //    省掉引用计数那一整类竞态(D5),代价只是多几个几 KB 的文件。
    const cookieHosts =
      cookie?.source === 'extension'
        ? resolveCookieHosts(rec.input.url, rec.input.headers?.['Referer'])
        : []
    const lease = cookieHosts.length > 0 ? (this.leaseCookieFile?.(cookieHosts) ?? null) : null
    const extCookie: ExtensionCookieFacts | undefined =
      cookie?.source === 'extension'
        ? { context: extensionCookieContextOf(lease, this.isExtensionLinked), hosts: cookieHosts }
        : undefined
    // 有效限速(spec §2.3):任务级 rec.limitKBps 优先于全局 getSpeedLimit();均无 → 0(不限)
    const globalKbps = this.getSpeedLimit ? this.getSpeedLimit() : 0
    const limitKBps = rec.limitKBps ?? globalKbps
    // 加速态(spec §3.3):已回退过一次 → 本任务不再挂 aria2c(useAccel=false → 自带下载器 + --limit-rate)
    const accel = this.getVideoAccel ? this.getVideoAccel() : { enabled: false, aria2cPath: '' }
    // #24(spec §2):分片协议(HLS/DASH)主动不挂 aria2c(避免注定失败的加速回退);progressive / 未知 → 保守挂(§7.1)
    const useAccel = accel.enabled && !rec.accelFallbackTried && !rec.fragmented
    rec.accelUsed = useAccel
    const dir = rec.input.dir || this.config.defaultDir
    const outputBase = this.toOutputBase(rec.input.filename)
    // downloader 切换(失败回退 / 用户切加速开关后 resume)→ 先清 .part/.aria2:两种下载器的半成品
    // 互不兼容,aria2c 分段扩长的 .part 交自带下载器续传会产出中段全零的坏文件(详见 deps.cleanPartials)
    const nextDownloader: 'aria2c' | 'native' = useAccel ? 'aria2c' : 'native'
    if (rec.lastDownloader !== null && rec.lastDownloader !== nextDownloader) {
      try {
        this.cleanPartials(dir, outputBase)
      } catch {
        // best-effort:清理失败不阻塞重起
      }
    }
    rec.lastDownloader = nextDownloader
    const args = buildYtDlpDownloadArgs({
      url: rec.input.url,
      dir,
      outputBase,
      ffmpegPath: this.config.ffmpegPath,
      video,
      proxy,
      cookie,
      // 第四档:一次性 cookies.txt 路径(无租约 → undefined → 参数与 `none` 档逐字节相同)
      extensionCookieFile: lease?.path,
      limitKBps,
      accel: { enabled: useAccel, aria2cPath: accel.aria2cPath },
      // 接管 / 嗅探来源的请求头(v0.4 Task 5 · spec §4.5 第 3 处)。
      // ★ **天然可得,零额外接线**:`toAddUriInput` 的 headers 透传在 torrent 早退之后、
      //   video 分支之前,**与 kind 无关** —— 故 `taskManager.ts` / `shared/ipc.ts` 在
      //   headers 这条线上零改动。缺省 `undefined` → 恒产 `[]` → 与改动前逐字节等价。
      headers: rec.input.headers
    })

    const child = this.spawn(this.config.ytdlpPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ytdlpSpawnEnv(), // 钉死 Python stdio UTF-8:after_move 回传中文路径不再 mojibake(2026-07-09)
      windowsHide: true // 打包 GUI 态防子进程闪控制台窗口(与 probeVersion 一致)
    })
    rec.child = child
    rec.postprocessing = false // 重起后后处理标志归零
    // 进度基线整体归零:新进程从头汇报所有流(已完整流即刻 finished 重新累计基数,续传流从断点续报)。
    // 不跨 spawn 保留 lastBytes/lastTotal——控制文件过期时新进程从低位重报是**真实状态**(那段确实
    // 要重下),钳在旧水位会把进度条冻死而速率照变(真机 2026-07-09 三轮);两帧之间 TaskManager
    // 保留上次值,重起瞬间 UI 不闪 0。
    rec.streamBase = 0
    rec.lastBytes = 0
    rec.lastTotal = 0

    // per-child 主动 kill 标志:close 时据此判定是否发终态事件;resume 起新 child → 新闭包
    let killed = false
    let buffer = ''
    let stderrLineBuffer = ''
    let stderr = ''

    rec.killCurrent = async () => {
      killed = true
      await this.killChild(child)
      // 进程已死 → 置空 child:setTaskLimit 等据 rec.child 判断「是否在跑」(暂停态只存值不重起)
      if (rec.child === child) rec.child = null
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (killed) return // 主动 kill 后丢弃后续输出
      buffer += chunk.toString()
      // aria2c 外部下载器的 readout 用 \r 重绘(无 \n),只按 \n 切会把整段进度囤死在缓冲
      // (真机 2026-07-09:挂 aria2c 时 UI 全程 0%),故 \r / \n 都作行界。
      const parts = buffer.split(/\r\n|\r|\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        this.handleLine(rec, part)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (killed) return
      const text = chunk.toString()
      stderr += text // 原文保留,供退出码≠0 时 mapDownloadError 映射错误
      // 兜底:进度主路径在 stdout(见 ytdlpArgs 的 --progress);但某些 yt-dlp 版本 / 视频
      // 可能把进度或后处理([Merger] 等)写到 stderr,一并按行喂 handleLine 解析,防漏进度 / 阶段。
      stderrLineBuffer += text
      const parts = stderrLineBuffer.split(/\r\n|\r|\n/)
      stderrLineBuffer = parts.pop() ?? ''
      for (const part of parts) {
        this.handleLine(rec, part)
      }
    })

    child.on('error', (err: Error) => {
      // 🔴 用完即删(spec §4.4 第 3 条):spawn 失败(ENOENT 等)时 Node 先发 `error` 再发 `close`,
      // 而下面那行 `killed = true` 会让随后的 close 在 flush 后**提前 return** —— 若只在 close 里删,
      // 这条路径就漏删了。两处都放,靠 `release()` 幂等兜住重复。
      lease?.release()
      if (killed) return
      // spawn 失败(ENOENT 等)时 Node 会先发 'error' 再发 'close':置 killed 让随后的 close 直接
      // 返回,防止对已报错、已清理的任务再走一次加速回退重起 / 重复发终态(进程从未运行、缓冲为空,
      // close 的 flush 无损失;姊妹模块 ytdlpProcess 以 settled 标志防的正是同一竞态)
      killed = true
      this.emit({
        id: rec.id,
        status: 'error',
        totalBytes: rec.lastTotal,
        downloadedBytes: rec.lastBytes,
        speed: 0,
        connections: 0,
        errorCode: `无法启动视频下载:${err.message}`
      })
      rec.child = null
      this.tasks.delete(rec.id)
    })

    child.on('close', (code: number | null) => {
      // 🔴 **最顶端,在 `if (killed) return` 之前**(spec §4.4 / 不变量卡 §5.3)——
      // 主动 kill(暂停 / 删除 / 限速重起)会走下面那个提前 return,放在它后面就漏删;
      // 而「暂停期间磁盘上无 cookie 文件」正是 D5 的承诺。yt-dlp 进程此刻已退出,文件不再有人读。
      // 加速回退重起也靠这一句:旧租约在 `spawnFor` 重建新租约**之前**就已释放,顺序天然正确。
      lease?.release()
      // flush 末行残留(非主动 kill 时):stdout(destination)+ stderr(末帧进度 / 后处理)
      if (!killed && buffer.trim() !== '') {
        this.handleLine(rec, stripCr(buffer))
      }
      if (!killed && stderrLineBuffer.trim() !== '') {
        this.handleLine(rec, stripCr(stderrLineBuffer))
      }
      if (killed) {
        // 主动 kill(pause/remove/stop):不发终态事件(rec 由 pause 保留 / remove 已清理)
        return
      }
      // aria2c 加速回退判定(spec §3.3):非 kill 的非零退出 + 本次挂了 aria2c + 未回退过 →
      // **不发 error**,置 accelFallbackTried、重起一次自带下载器(useAccel=false → --limit-rate 传导),
      // 保持 downloading(回退期不闪 error)。二次(自带下载器)仍失败才走下面的 error 分支。
      // 插在 `if(killed)return` 之后、completed/error 之前:主动 kill / 正常完成(code=0)路径不受影响(§6.3)。
      if (code !== 0 && rec.accelUsed && !rec.accelFallbackTried) {
        rec.accelFallbackTried = true
        console.warn('[VideoEngine] aria2c 加速下载失败,已回退 yt-dlp 自带下载器重试')
        this.spawnFor(rec) // 重起(自带下载器);新 child + 新闭包接管,旧 close 到此为止
        return
      }
      rec.child = null
      rec.killCurrent = null
      if (code === 0) {
        // 完成大小优先取最终落盘文件(DASH 合并后总大小),回退最后进度;修同名跳过 / 0B(2026-07-01)
        const statBytes = rec.destination ? this.statSize(rec.destination) : null
        const finalBytes = statBytes ?? rec.lastTotal
        this.emit({
          id: rec.id,
          status: 'completed',
          totalBytes: finalBytes,
          downloadedBytes: finalBytes || rec.lastBytes,
          speed: 0,
          connections: 0,
          savePath: rec.destination ?? undefined
        })
      } else {
        // 🔴 原始 stderr 进日志(ARCHITECTURE §6.3「原始 stderr 只进日志」),与解析侧
        // `[VideoResolver] 解析失败 url=… exitCode=…` **同形**。此前下载侧只把 stderr 喂给
        // `mapDownloadError` 取可读文案、**原文用完即丢** —— 承诺只兑现了一半,下载失败的真凶
        // 在日志里完全不可见(2026-08-19 YouTube 排障第一道墙)。
        //
        // 与红线 R4(日志**零 cookie 值 + 零域名**)的关系,三条:
        // ① **零 cookie 值**:cookie 值只存在于那份一次性 cookies.txt 里,从不进 argv、不进 stderr;
        //    这里落的是 yt-dlp 的 stderr 原文,不含任何 cookie 值。由 `scrubCookiePath` 之外再加
        //    一条捕获式 logger 断言(仿 I-C4)在测试里盯着。
        // ② **临时文件路径**:`--cookies <lease.path>` 有可能被 yt-dlp 回显进 stderr(如 IO 报错)。
        //    路径不是凭据、且文件此刻已删,但它是「这次借过登录态」的直接痕迹 → **一律抹成 `<cookies>`**。
        // ③ **域名**:R4 那条域名禁令针对的是**暂借登录态留下的痕迹**——「该域被借过」。而这一行
        //    日志**与 cookie 四档无关、四档下逐字相同**(失败即记),故它不携带任何「借过」的信息;
        //    它和 `[VideoResolver] 解析失败 url=…`(既有形态)记的是同一个 URL、同一个任务。
        //    这是**如实标注的边界,不是放宽**:若日后要求「日志零 URL」,该收敛的是解析侧与这里两处。
        console.error(
          `[VideoEngine] 下载失败 url=${rec.input.url} exitCode=${code}\n${scrubCookiePath(stderr, lease?.path)}`
        )
        this.emit({
          id: rec.id,
          status: 'error',
          totalBytes: rec.lastTotal,
          downloadedBytes: rec.lastBytes,
          speed: 0,
          connections: 0,
          errorCode: mapDownloadError(stderr, code, extCookie)
        })
      }
      this.tasks.delete(rec.id)
    })
  }

  /** 解析一行 stdout → 归一进度事件 */
  private handleLine(rec: VideoTaskRec, line: string): void {
    const event = parseYtDlpLine(line)
    if (!event) return

    if (event.type === 'progress') {
      // 多流聚合(2026-07-09):每流字节从 0 计 → 叠加已完成流基数;本次 spawn 内取 max 平滑
      // readout 起步 0B 帧 / 切流瞬间抖动。流完成(streamDone)只把该流 total 累进基数、**不发帧**:
      // 重起后重放「已完整流」的 finished 若发帧,会把百分比按旧流 total 闪到 100% 再回落。
      const absBytes = rec.streamBase + event.downloadedBytes
      const absTotal = rec.streamBase + event.totalBytes
      rec.lastBytes = Math.max(rec.lastBytes, absBytes)
      rec.lastTotal = Math.max(rec.lastTotal, absTotal)
      if (event.streamDone) {
        rec.streamBase += event.totalBytes || event.downloadedBytes
        return
      }
      this.emit({
        id: rec.id,
        status: 'downloading',
        phase: 'downloading',
        totalBytes: rec.lastTotal,
        downloadedBytes: rec.lastBytes,
        speed: event.speed,
        connections: 0
      })
      return
    }

    if (event.type === 'postprocess') {
      if (!rec.postprocessing) {
        rec.postprocessing = true
        this.emit({
          id: rec.id,
          status: 'downloading',
          phase: 'processing',
          totalBytes: rec.lastTotal,
          downloadedBytes: rec.lastBytes,
          speed: 0,
          connections: 0
        })
      }
      return
    }

    // destination:缓存,完成时随 completed 上报真实 savePath
    rec.destination = event.filepath
  }

  /**
   * 杀 yt-dlp 进程树。**顺序关键**:先 `taskkill /T /F`(整棵树)再 `child.kill()` 兜底 —— yt-dlp.exe
   * (PyInstaller onefile)是 bootloader 父 + Python 子两进程;若先 child.kill 杀父,Python 子进程被
   * orphan、脱离父的进程树,taskkill /T 就杀不到它 → 下载不停(假取消,2026-07-01 手测)。
   * treeKill await:等 taskkill 执行完(整棵树被强杀)再返回;child.kill 兜底(非 win / 无 pid)。
   */
  private async killChild(child: ChildProcess): Promise<void> {
    const pid = child.pid
    if (typeof pid === 'number') {
      try {
        await this.treeKill(pid)
      } catch {
        // 树杀 best-effort
      }
    }
    try {
      child.kill()
    } catch {
      // 已退出 / kill 失败不阻塞
    }
  }

  /**
   * 默认树杀:仅 win32 起 `taskkill /pid <pid> /T /F`(整棵进程树强杀),**await 其退出**确保执行完
   * (进程真死)再返回;注入式可被测试替换。非 win32 → no-op(child.kill 兜底)。
   */
  private defaultTreeKill(pid: number): Promise<void> {
    if (process.platform !== 'win32') return Promise.resolve()
    return new Promise<void>((resolve) => {
      try {
        const killer = this.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true // 每次暂停 / 取消都起 taskkill,防打包 GUI 态闪控制台窗口
        })
        killer.on?.('close', () => resolve())
        killer.on?.('error', () => resolve()) // taskkill 失败(进程已退出等)best-effort
      } catch {
        resolve() // best-effort
      }
    })
  }

  /** filename(含预测扩展名)→ outputBase(去扩展名);ext 交 yt-dlp `%(ext)s` 模板回填 */
  private toOutputBase(filename: string | undefined): string {
    const name = filename ?? 'video'
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(0, dot) : name
  }

  private emit(progress: DownloadProgress): void {
    for (const callback of this.callbacks) {
      try {
        callback(progress)
      } catch (err) {
        console.error('[VideoEngine] 进度回调失败:', err)
      }
    }
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 把 stderr 里出现的**一次性 cookies.txt 绝对路径**抹成 `<cookies>`(红线 R4 第 ② 条)。
 *
 * 路径本身不是凭据(文件在 `close` 最顶端已删),但它是「这次借过登录态」的直接痕迹,
 * 而日志会比它记录的东西活得更久。无租约(前三档 / 未拿到)→ `path` 为 `undefined` →
 * **原样返回,与改动前逐字节等价**。用 split/join 而非正则:Windows 路径里的 `\` 不必转义。
 */
export function scrubCookiePath(stderr: string, path?: string): string {
  if (!path) return stderr
  return stderr.split(path).join('<cookies>')
}
