/**
 * 接管编排(v0.4 Task 4 · spec §3.2 / §3.3 / §3.4 / §3.7 · plan 2.3)。
 *
 * 职责:受理意图 → 终裁 → 攒缓冲 → 呈现确认窗口 → 用户确认后走**既有 `addTask` 全链路**。
 * 判定全在纯函数(`takeoverRules` / `takeoverBuffer`),窗口副作用全在 `takeoverWindow`,
 * **本文件一个 `electron` import 都没有** —— 与 `ProxyService` / `ExtensionChannelService` 同一纪律。
 *
 * ★ **受理即回**(黑洞红线的正面形态,CONTEXT.md「接管」):`handleIntent` 跑完终裁 + `canPresent()`
 *   就**同步返回** `{taken:true}`,弹窗 / 建任务 / 查重全在应答之后异步进行。
 *   **绝不改成「等任务真建成再回」** —— 人类确认耗时不可知,而浏览器一直在写盘(等 30 秒就写了
 *   几十 MB 再作废);且 MV3 service worker 约 30 秒空闲销毁,sw 一死,`await` 的 Promise 连同
 *   `cancel()` 一起蒸发 → 浏览器继续下完而 DownLord 也建了一个任务 = **双份下载**。
 */
import {
  IpcChannel,
  type AddTaskInput,
  type CookieSource,
  type DuplicateConflict,
  type DuplicateResolution,
  type ResolvedTheme,
  type TakeoverBatch,
  type TakeoverPausePatch,
  type TakeoverSettingsPatch,
  type TakeoverSettingsView,
  type TakeoverSubmitPayload
} from '../../shared/ipc'
import type {
  DownloadIntent,
  DownloadIntentAck,
  SniffAddSelected,
  TakeoverConfigView,
  VideoIntent
} from '../../shared/extensionProtocol'
import { filterDownloadHeaders } from '../../shared/downloadHeaders'
import { classifySniffed } from '../video/sniffClassify'
import { needCookieForOf } from '../video/cookieDomains'
import type { ChannelLogger } from '../extensionChannel/channelServer'
import { createTakeoverBuffer, type TakeoverBuffer } from './takeoverBuffer'
import { isTakeoverPaused, pausedUntilFrom } from './pauseState'
import {
  cloneDefaultTakeoverConfig,
  normalizeDomainList,
  type TakeoverConfig,
  type TakeoverConfigStore
} from './takeoverConfig'
import {
  decideTakeover,
  normalizeIntent,
  normalizeSniffIntent,
  type NormalizedIntent,
  type SniffRejectReason,
  type TakeoverRejectReason
} from './takeoverRules'

/** 已受理、等待用户确认的一条:归一后的意图 + 批内 id + 主进程算好的建议名 */
export interface PendingIntent extends NormalizedIntent {
  id: string
  filename: string
  /**
   * 这一条要建成哪种任务(v0.4 Task 5 · spec §4.4)。
   *
   * - **接管路径(Task 4)恒填显式 `'http'`** —— 写字面量,**不是缺省值**:缺省值会让
   *   「接管永远是直链」这条事实退化成一个可以被无声改掉的默认(判据 U-32 / I-06)。
   * - **嗅探路径填 `classifySniffed` 的结果**(`video` / `http`)。
   */
  kind: 'http' | 'video'
}

/**
 * 确认窗口的最小操作面(真实实现见 `takeoverWindow.ts`,**那是全模块唯一 import electron 的文件**)。
 * 注入 → 单测无需真 `BrowserWindow`。
 */
export interface TakeoverWindowHandle {
  /** **定向** send(不经 `getAllWindows()` 遍历:这是指令,主窗口收到只会添乱) */
  send(channel: string, payload: unknown): void
  /** 首次呈现时 `show()` + `focus()` **一次**;已可见则 no-op(同窗换内容不再抢焦,DESIGN §4 (d)) */
  showOnce(): void
  /**
   * 按当前形态调整内容高度(态 A 固定 / 态 B 按条数 / 态 C 交给查重框)。
   * 宽度恒 460 不变 —— 「460px 固定小框」是形态本身,只有高度随内容走(spec §4.4)。
   */
  setContentHeight(height: number): void
  close(): void
  isDestroyed(): boolean
  /** 渲染进程 `webContents.id`(IPC 归属校验);未就绪 / 已销毁 → `null` */
  webContentsId(): number | null
  /** 窗口销毁回调(用户点任务栏关闭 / 渲染进程崩溃同样触发) */
  onClosed(callback: () => void): void
}

export interface TakeoverServiceDeps {
  /** 时钟(真实 `() => Date.now()`;测试注入可推进的假时钟 —— 500ms 窗口与暂停到期全靠它) */
  now: () => number
  /**
   * 接管配置的真源(`<userData>/config/takeover.json`;测试注入内存 fake fs 组装的 store)。
   *
   * ★ **暂停状态的唯一真源在主进程**(CONTEXT.md「临时暂停接管」):popup 只是遥控器。
   *   「是否接管」是决策,按 ARCHITECTURE §7.2 必须留主进程;且本地通道**无反向推送**,
   *   状态若存扩展侧,DownLord 只能显示「最近一次听说的」。
   */
  configStore: TakeoverConfigStore
  /**
   * 配置变更广播(真实注入 `broadcastTakeoverConfig`)。
   *
   * 写方向有**两个入口**(设置页 / popup 遥控器),故任何一方写完都要推给所有窗口 ——
   * 否则开着的设置页显示的是它自己最后写的值,而不是真源。
   */
  onConfigChanged: (view: TakeoverSettingsView) => void
  /** 一次性定时器 + 取消句柄(真实 `setTimeout` / `clearTimeout`;测试注入手动触发器) */
  scheduleTick: (delayMs: number, fn: () => void) => () => void
  /** 建确认窗口(真实 `createTakeoverWindowHandle`);**抛错即熔断**,此后一律不接管 */
  createWindow: () => TakeoverWindowHandle
  isAppReady: () => boolean
  /** `canPresent` 第③条:主窗口已关 = 应用正在退出(`window-all-closed → app.quit()`) */
  hasMainWindow: () => boolean
  /** 注入 `taskManager.addTask`,**不持有整个 manager**;接管下来的是普通直链任务,复用既有全链路 */
  addTask: (input: AddTaskInput) => Promise<string>
  /**
   * 建完任务后通知主窗口重拉列表(真实注入 `broadcastTaskAdded`)。
   *
   * ★ 2026-08-02 真机修复:接管是**第一条主进程侧发起**的建任务路径,渲染层没有 invoke 可以
   *   顺手 refresh;不通知的话新任务的进度帧会被 `progressMerge` 整批丢弃,直到完成帧触发
   *   全量重拉,用户看到的是「点完什么都没有,过一会突然冒出一条已下完的记录」。
   */
  onTaskCreated: () => void
  /** 查重订阅(Phase 3 消费:接管路径自己那条冲突**定向**送小窗口,不广播) */
  onDuplicate: (callback: (conflict: DuplicateConflict) => void) => () => void
  /** 查重决策(Phase 3 消费:窗口关闭时对未决冲突显式下 `skip`) */
  resolveDuplicate: (res: DuplicateResolution) => Promise<void>
  /** 建议文件名(= `filenameFromUrl`,与 `resolveFilename` 同一份推断,零复制) */
  suggestFilename: (url: string) => string
  /** 已解析主题(小窗口不挂 `ThemeProvider`,随批次下发;真实注入 `nativeTheme.shouldUseDarkColors`) */
  getResolvedTheme: () => ResolvedTheme
  /** 日志出口。★ **只记 host + 决策 + 计数**;绝不记完整 URL / referrer 值 / UA 全串 / token */
  logger: ChannelLogger
  /**
   * 当前 Cookie 档位(v0.4 Task 6;真实注入 `() => settingsService.get().video.cookie.source`)。
   *
   * ★ **「没选第四档 = 零外泄」的闸门**(红线 R10):不是 `'extension'` → `needCookieForOf`
   * 恒回 `[]` → 应答里连 `needCookieFor` 这个键都不存在 → 扩展侧根本不进「读 cookie」那条分支。
   * 缺省(未注入)按 `'none'` 处理 —— **默认零外泄**。
   */
  getCookieSource?: () => CookieSource
  /**
   * 持有层当前有哪些域(v0.4 Task 6;真实注入 `() => borrowedCookieStore.hosts()`)。
   *
   * ⚠️ **只出 host、不出值** —— 确认框那一行要显示的就是 host,拿不到值也不需要值。
   * 在**批次被拉取(present)的那一刻**实读,理由见 `cookieHostsFor`。
   */
  getBorrowedCookieHosts?: () => string[]
}

const NOT_TAKEN: DownloadIntentAck = { taken: false }

/**
 * 甲路径日志里替代 host 的固定占位(v0.4 Task 6,红线 R4)。
 *
 * `video.intent` 的 host 就是马上要去借登录态的那个域 —— 记它等于把「用户在 X 站有登录态」
 * 写进跨会话留存的日志文件,而持有层本身是会话级的。**这条路径上一个域名都不记。**
 */
const VIDEO_PAGE_PLACEHOLDER = 'video-page'

/** 态 A(单条)的内容高度 —— 与 `takeoverWindow` 建窗时的初值一致(spec §4.4) */
const HEIGHT_SINGLE = 300
/** 态 B(列表)的骨架高度(头 / 落点 / 提示 / 底) */
const HEIGHT_LIST_CHROME = 268
/** 态 B 每行高度 */
const HEIGHT_LIST_ROW = 44
/** 态 B 最多铺 6 行,再多靠 `.dialog-body` 的 `overflow-y:auto` 滚(同 BtFileDialog 上百文件的做法) */
const LIST_ROWS_MAX = 6
/** 态 C(查重框)固定高度:单条 http 冲突 = 说明 + 一条 `.dup-item` + 注解 + 四按钮 */
const HEIGHT_DUPLICATE = 330

/** 按批次条数算内容高度(纯算术,便于单测与 R5 退路时集中一处改) */
export function takeoverContentHeight(itemCount: number): number {
  if (itemCount <= 1) return HEIGHT_SINGLE
  return HEIGHT_LIST_CHROME + Math.min(itemCount, LIST_ROWS_MAX) * HEIGHT_LIST_ROW
}

export class TakeoverService {
  private readonly buffer: TakeoverBuffer<PendingIntent>
  /**
   * 接管配置的内存副本。**真源是 `takeover.json`**,`init()` 读进来、每次写后同步更新。
   *
   * 内存留一份的理由:`handleIntent` 是**同步**的(受理即回),不能在应答路径上 `await` 读盘。
   */
  private config: TakeoverConfig = cloneDefaultTakeoverConfig()
  /** 最近一次落盘的 promise(`flushWrites()` 供测试与关停时等它落定) */
  private lastWrite: Promise<void> = Promise.resolve()
  private win: TakeoverWindowHandle | null = null
  /** 渲染层是否已 `ready()`(**先推后挂 = 载荷掉进虚空**,故改为就绪后来拉) */
  private rendererReady = false
  /** 正在确认框里的那一批;**一旦呈现就是快照**(新来的进缓冲、成为下一批) */
  private currentBatch: PendingIntent[] = []
  /** 熔断:建窗抛过错。宁可从此不接管,不可接了管不上。**用户重启即复位,不提供运行时复位入口** */
  private windowCreationBroken = false
  private cancelTickTimer: (() => void) | null = null
  private cancelWarmupTimer: (() => void) | null = null
  private started = false
  private intentSeq = 0
  private acceptedCount = 0
  /** 本服务建的、尚未决策的查重冲突 id(定向下发 + 关窗时显式 `skip`) */
  private readonly ownedConflictIds = new Set<string>()
  /**
   * 「此刻正在为接管路径调 `addTask`」的标记 —— **只覆盖同步段,不跨越 await**。
   *
   * ★ 为什么需要它:`taskManager.addTask` 命中查重后是**先 `emitDuplicate` 再 return id**,
   *   而 id 要等 `await` 回来才到我们手里 —— 也就是说,`isOwnedByTakeover(conflictId)` 被
   *   `broadcastDuplicate` 调用的那一刻,`ownedConflictIds` 里**还没有**这个 id。
   *   只靠集合判定,接管路径的第一条冲突必然漏给主窗口(定向当场失效)。
   *   故在同步段内用这个标记宣示归属;`await` 之前立刻落下,免得把别的调用方(主窗口添加任务)
   *   那条冲突也一起吞掉。
   */
  private submitting = false
  /** 本次 `addTask` 同步段内 emit 出来的冲突(归属由随后返回的 id 确认) */
  private emittedDuringSubmit: DuplicateConflict | null = null
  private unsubDuplicate: (() => void) | null = null

  constructor(private readonly deps: TakeoverServiceDeps) {
    this.buffer = createTakeoverBuffer<PendingIntent>({ now: deps.now })
  }

  /**
   * 读 `takeover.json` 填内存副本(**幂等**;仿 `ExtensionChannelService.init()`)。
   *
   * 与 `start()` 分开而不是把它改成 async:`start()` 只做订阅,失败与否不影响判定;
   * 而 `init()` 决定「用哪份配置判」,主进程装配处必须 `await` 它跑完再 `start()`。
   * 缺失 / 损坏 → store 回退默认并**回写修复**(`repairOnInvalid: true`),此处不必再判。
   */
  async init(): Promise<void> {
    this.config = await this.deps.configStore.read()
  }

  /**
   * 起服务(幂等)。
   *
   * 订阅查重:`taskManager.duplicateCallbacks` 是 Set,支持多订阅者 —— **不改 taskManager 一个字**。
   * 只认自己那条冲突,命中则**定向** send 给小窗口(不遍历 `getAllWindows()`);
   * 主窗口那一份由 `ipc/task.ts` 的 `isOwnedByTakeover` 拦下(spec §6.3,本 Task 第二处既有改动)。
   */
  start(): void {
    this.started = true
    this.unsubDuplicate?.()
    this.unsubDuplicate = this.deps.onDuplicate((conflict) => this.onDuplicateEmitted(conflict))
  }

  /** 停服务:清定时器 + 清缓冲 + 关窗(`before-quit` 的既有优雅关闭里调用,**不新增 quit 分支**) */
  stop(): void {
    this.started = false
    this.clearTimers()
    this.buffer.reset()
    this.currentBatch = []
    this.ownedConflictIds.clear() // R6 第三处清理点:跨启停不残留
    this.unsubDuplicate?.()
    this.unsubDuplicate = null
    this.closeWindow()
  }

  /**
   * 下载意图入口(通道 handler 直调,**同步**)。
   *
   * 顺序不可换:归一 → 终裁 → `canPresent()` → 入缓冲 → **立即回**。
   * 不接管的四道**不建窗口、不建任务**;应答**只有 `{taken}`**,原因码只进日志。
   */
  handleIntent(payload: DownloadIntent): DownloadIntentAck {
    // 生命周期守卫:未启动 / 已停(退出流程中)一律不接管 —— 接了也没人管,那正是黑洞
    if (!this.started) return NOT_TAKEN

    const intent = normalizeIntent(payload)
    if (!intent) {
      this.logRejected('invalid-url', 'invalid_url')
      return NOT_TAKEN
    }

    const verdict = decideTakeover(intent, this.config, this.deps.now())
    if (!verdict.taken) {
      this.logRejected(intent.host, verdict.why)
      return NOT_TAKEN
    }

    if (!this.canPresent()) {
      this.logRejected(intent.host, 'no_window')
      return NOT_TAKEN
    }

    const pending: PendingIntent = {
      ...intent,
      id: `tk_${++this.intentSeq}`,
      filename: this.deps.suggestFilename(intent.url),
      // ★ 接管路径恒填**显式字面量** `'http'`(不是缺省值)——「接管下来的是普通直链任务」
      //   这条事实必须写在代码里,不能靠一个可被无声改掉的默认(U-32 / I-06)
      kind: 'http'
    }
    const action = this.buffer.accept(pending)
    this.acceptedCount += 1
    // ⚠️ `byExtensionId` 取自**原始 payload 而非 `intent`**:`normalizeIntent` 刻意把它丢掉了
    //    (留着迟早有人拿它写分支,而 Step 0 已拍板不据它决策)。只在日志这一层还原「记事实」
    //    这一半 —— 决策层依旧拿不到它,那条形状保证一个字没动。
    const byExt = payload.byExtensionId ? ` byExt=${payload.byExtensionId}` : ''
    this.deps.logger.info(
      `[takeover] intent #${this.acceptedCount} host=${intent.host} danger=${intent.danger || 'unknown'}${byExt}` +
        ` → 受理(缓冲 ${this.buffer.size()} 条)`
    )
    if (action.kind === 'armed') {
      this.armTick(action.at)
      // ★ 应答之后立刻预热窗口(0ms 一次性定时器,**不占应答路径**):
      //   建窗抛错在这里就熔断,后续意图当场诚实回绝,而不是攒到 500ms 后才发现管不上;
      //   顺带让渲染层在这 500ms 里挂载完毕,呈现时 send 即到、窗口带着内容出现(无空帧)。
      this.armWarmup()
    }

    // ★ 受理即回 —— 下面这一行之后的一切(弹窗 / 建任务 / 查重)都与应答完全解耦
    return { taken: true }
  }

  /**
   * 用户在 popup 里点了某条嗅探资源的「下载」(v0.4 Task 5 · spec §4.2)。
   *
   * 与 `handleIntent` **共用同一套编排**(生命周期守卫 → 归一 → `canPresent()` → `buffer.accept`
   * → 受理即回),但**刻意跳过 `decideTakeover` 的四道**,中间多一层 `classifySniffed` 定 kind。
   *
   * ── ✂ 为什么跳过那四道(逐条,不是一句「场景不同」)────────────────────────────────
   * 那四道判的是「要不要**从浏览器手里抢过来**」(CONTEXT.md「接管判定」),
   * 而嗅探里**浏览器根本没在下这个东西**:
   * - `enabled === false`      接管总开关关掉 **≠** 不想用嗅探 —— **是两个功能**;
   *                            何况用户刚在 popup 里主动点了「下载」。
   * - `isPaused(pausedUntil)`  「暂停接管」的语义是「把下载**交回浏览器自己处理**」,
   *                            可 **m3u8 浏览器根本没法自己下** —— 交回去等于交给空气。
   * - `isExcludedDomain(host)` 域名例外表的语义是「这个域的下载别来烦我」;
   *                            **用户主动点 > 域名例外**。
   * - `danger !== 'safe'`      `danger` 是 `chrome.downloads` 的字段,
   *                            **嗅探路径根本没有它**(`normalizeSniffIntent` 产出恒为空串)。
   *
   * ── ⚠️ 仍然弹确认框,这是**安全边界**不是体验偏好 ─────────────────────────────────
   * 主进程收到的是**一条 HTTP 请求**,它**无法区分「用户真的点了 popup」与「本机某个拿到
   * token 的程序伪造的」**。确认框是 token 泄露后的**最后一道人肉闸**
   * (ARCHITECTURE §7.6 威胁模型:Origin 校验是纵深不是主闸,token 才是主闸)。
   */
  handleSniffSelected(payload: SniffAddSelected): DownloadIntentAck {
    // 0. 生命周期守卫(与 `handleIntent` 逐字同构):未启动 / 已停一律不受理
    if (!this.started) return NOT_TAKEN

    // 1. 归一:URL 合法性 + host 解析 + 字段裁剪
    const intent = normalizeSniffIntent(payload)
    if (!intent) {
      this.logRejected('invalid-url', 'invalid_url')
      return NOT_TAKEN
    }

    // 2. 分流(纯函数四层,`src/main/video/sniffClassify.ts`)
    const { kind } = classifySniffed(payload.url, payload.contentType)
    if (kind === 'segment') {
      // 分片:扩展侧已过滤过一遍,这里挡的是**伪造的载荷**(分片过滤刻意做两遍)
      this.logRejected(intent.host, 'sniff_segment')
      return NOT_TAKEN
    }
    if (kind === 'unknown') {
      // 判不出就不猜 —— 输入是**程序上报的载荷**,不是用户手打的 URL(那种场景 UI 才有
      // 「默认建议 video」的人工兜底)。**拒绝是诚实且安全的。**
      this.logRejected(intent.host, 'sniff_unknown')
      return NOT_TAKEN
    }

    // ✂ 3. 跳过 decideTakeover 四道(理由见本方法 docstring)

    // 4. 副作用侧判定:**三条判据原样复用,一条不改**
    if (!this.canPresent()) {
      this.logRejected(intent.host, 'no_window')
      return NOT_TAKEN
    }

    // 5. 入缓冲(500ms 同域聚合状态机**原样复用**)
    const pending: PendingIntent = {
      ...intent,
      id: `tk_${++this.intentSeq}`,
      filename: this.deps.suggestFilename(intent.url),
      kind
    }
    const action = this.buffer.accept(pending)
    this.acceptedCount += 1
    // 日志红线:**只记 host + 原因码 + 计数**,不记完整 URL / 不记 referrer 完整值。
    // `kind` 是主进程自己的判定结论,不是用户数据,可以记(排障时最想知道的就是它)。
    this.deps.logger.info(
      `[takeover] sniff #${this.acceptedCount} host=${intent.host} kind=${kind}` +
        ` → 受理(缓冲 ${this.buffer.size()} 条)`
    )
    if (action.kind === 'armed') {
      this.armTick(action.at)
      this.armWarmup()
    }

    // ★ 受理即回(与接管路径同一收尾)。丙路径点名域上界 **2**:媒体 URL host + Referer host
    return this.takenAck([intent.url, intent.referrer])
  }

  /**
   * 甲路径:用户在 popup 点了「用 DownLord 下载此页视频」(v0.4 Task 6 · spec §2.5)。
   *
   * 与 `handleSniffSelected` **共用同一套编排**(生命周期守卫 → 归一 → `canPresent()` →
   * `buffer.accept` → 受理即回),两处差异**都是刻意的**:
   *
   * 1. **`kind` 恒 `'video'`,不过 `classifySniffed` 四层** —— 输入是**页面 URL**,
   *    它本来也分不出类型(`https://www.bilibili.com/video/BV1x` 既不像 m3u8 也不像 mp4)。
   *    「这是个视频页」正是用户点那个按钮时表达的意思,不需要再猜一遍。
   *    ⚠️ 反过来说,**判不出是不是视频页也是常态**:popup 那个按钮恒可点、不做页面类型判断
   *    (要判断就得注入 content script = 表外权限,而 yt-dlp 支持上千站点,我们本来就判不了)。
   *    不是视频页就走既有解析失败路径 —— **诚实且零新权限**(spec §7.4)。
   * 2. **同样跳过 `decideTakeover` 四道** —— 与 `handleSniffSelected` 逐字同理由:那四道判的是
   *    「要不要从浏览器手里抢过来」,而这里**浏览器根本没在下这个东西**,用户是主动点的。
   *
   * ── ⚠️ 仍然弹确认框(与丙路径同一条安全边界)────────────────────────────────
   * 主进程收到的只是**一条 HTTP 请求**,分不清「用户真的点了 popup」与「本机某个拿到 token 的
   * 程序伪造的」。确认框是 token 泄露后的最后一道人肉闸(ARCHITECTURE §7.6)。
   */
  handleVideoIntent(payload: VideoIntent): DownloadIntentAck {
    // 0. 生命周期守卫(与另两条入口逐字同构)
    if (!this.started) return NOT_TAKEN

    // 1. 归一:**复用 `normalizeSniffIntent`**(URL 合法性 + host 解析 + 字段裁剪)。
    //    甲路径没有 referrer / contentType / 大小可报,故填空值 —— `totalBytes: -1` 会让确认框
    //    不渲染大小胶囊(页面 URL 本来就没有"大小"这回事,写 0 反而像"0 字节")。
    //    ⚠️ 不为它另写一个 `normalizeVideoIntent`:归一规则一旦有两份就会漂。
    const intent = normalizeSniffIntent({
      url: payload.pageUrl,
      contentType: '',
      referrer: '',
      userAgent: typeof payload.userAgent === 'string' ? payload.userAgent : '',
      totalBytes: -1
    })
    if (!intent) {
      this.logRejected(VIDEO_PAGE_PLACEHOLDER, 'invalid_url')
      return NOT_TAKEN
    }

    // ✂ 2. 跳过 classifySniffed 四层(kind 恒 'video',见本方法 docstring 第 1 条)
    // ✂ 3. 跳过 decideTakeover 四道(同上第 2 条)

    // 4. 副作用侧判定:**三条判据原样复用,一条不改**
    if (!this.canPresent()) {
      this.logRejected(VIDEO_PAGE_PLACEHOLDER, 'no_window')
      return NOT_TAKEN
    }

    // 5. 入缓冲(500ms 同域聚合状态机**原样复用**)
    const pending: PendingIntent = {
      ...intent,
      id: `tk_${++this.intentSeq}`,
      filename: this.deps.suggestFilename(intent.url),
      // ★ 恒填**显式字面量**(与接管路径的 `'http'` 同一手法):这条事实必须写在代码里,
      //   不能靠一个可被无声改掉的默认
      kind: 'video'
    }
    const action = this.buffer.accept(pending)
    this.acceptedCount += 1
    // 🔴 **甲路径的日志一个域名都不记**(红线 R4),与接管 / 嗅探两条既有路径**刻意不同**:
    //    那两条在没选第四档时也照跑,它们的 host 记的是「用户点了下载」;而 `video.intent`
    //    这条路径**是为第四档而生的** —— 它的 host 就是马上要去借登录态的那个域,记下来等于把
    //    「用户在 X 站有登录态」写进一个**跨会话留存**的文件,而持有层本身是会话级的
    //    (CONTEXT.md「暂借登录态」:日志会比它记录的东西活得更久)。
    //    代价如实:甲路径排障时看不到是哪个站 —— 换来的是红线在**这条路径上**无例外。
    this.deps.logger.info(
      `[takeover] video #${this.acceptedCount} kind=video → 受理(缓冲 ${this.buffer.size()} 条)`
    )
    if (action.kind === 'armed') {
      this.armTick(action.at)
      this.armWarmup()
    }

    // ★ 受理即回。甲路径只有 `pageUrl` 一个 URL → 点名域上界 **1**
    return this.takenAck([intent.url])
  }

  /**
   * 受理应答的统一装配 —— ★ **`needCookieFor` 的两个写入点,只有这一个出口**(spec §2.4)。
   *
   * - 档位闸门在 `needCookieForOf` 里:不是第四档 → 恒 `[]`(红线 R10);
   * - **空数组 → 不写该键**(缺省 = 不要 cookie = 零外泄默认),不是写一个 `[]`;
   * - 🔴 **`handleIntent`(接管直链)刻意不调本方法** —— 「直链带 cookie 本版不做」是靠
   *   **写入点只有两处**保证的,不是靠一个可以被将来某次改动绕过的 `if`。I-C6 断言它的应答
   *   永不含该键。
   */
  private takenAck(urls: (string | undefined)[]): DownloadIntentAck {
    const need = needCookieForOf(this.deps.getCookieSource?.() ?? 'none', true, urls)
    return need.length > 0 ? { taken: true, needCookieFor: need } : { taken: true }
  }

  /**
   * 这一条待确认的任务**将会用到**哪些域的暂借登录态(v0.4 Task 6;确认框那一行的数据源)。
   *
   * ⚠️ **为什么在 present 时刻实读,而不是受理时刻算好存下来**:cookie 是在受理**之后**、
   * 人类点确认**之前**才到的(spec §2.5 ③④ 与 ⑤⑥ 并行)。窗口创建远慢于一次本地 fetch,
   * 故 present 时刻基本都已到手;万一没到,**少一行**是「未报」不是「谎报」,可接受。
   * **不做实时推送更新** —— 那要新增一条 IPC,收益只在极窄竞态(退路已在 spec §10.2 预写)。
   *
   * ⚠️ **`kind !== 'video'` 恒 `undefined`**:只有 yt-dlp 通路会带 cookie,直链走 aria2 不带。
   * 对一条 http 任务说「将使用 X 的登录态」是**谎报**。接管路径恒 `kind:'http'`,故它天然拿不到
   * 这一行 —— 与 `takenAck` 那一半是同一条红线的两个投影。
   */
  private cookieHostsFor(item: PendingIntent): string[] | undefined {
    if (item.kind !== 'video') return undefined
    const need = needCookieForOf(this.deps.getCookieSource?.() ?? 'none', true, [
      item.url,
      item.referrer
    ])
    if (need.length === 0) return undefined
    // 只报**持有层真有的**那些 —— 点了名但没借到的不显示(说了就得是真的)
    const held = new Set(this.deps.getBorrowedCookieHosts?.() ?? [])
    const hit = need.filter((host) => held.has(host))
    return hit.length > 0 ? hit : undefined
  }

  /**
   * 「确认能创建确认窗口」的三条判据(黑洞防护第②④变体,spec §3.2)。**一条都不能少。**
   */
  private canPresent(): boolean {
    if (!this.deps.isAppReady()) return false // ① app 尚未 ready
    if (this.windowCreationBroken) return false // ② 熔断:此前建窗抛过错
    if (!this.deps.hasMainWindow()) return false // ③ 主窗口已关 = 应用正在退出
    return true
  }

  // ── 渲染层来的三条(归属校验在 `ipc/takeover.ts`,此处只做业务)────────────────

  /** 渲染层挂载完成 → 送当前批(主进程主动先推会早于挂载、载荷掉进虚空) */
  onRendererReady(): void {
    this.rendererReady = true
    if (this.currentBatch.length > 0) this.presentCurrent()
  }

  /** 用户点「开始下载」:按保留条目建任务,**走既有 `addTask` 全链路**(分类路由 / 查重 / 限速 / 续传) */
  onSubmit(payload: TakeoverSubmitPayload): void {
    const batch = this.currentBatch
    if (batch.length === 0) {
      this.deps.logger.warn('[takeover] 收到 submit 但当前无待确认条目,已忽略')
      return
    }
    void this.runSubmit(batch, payload)
  }

  /** 用户点「取消」/ `Esc` / `×`:放弃当前批。**不是黑洞** —— 确认框已如实告知「浏览器那边已经取消」 */
  onDismiss(): void {
    if (this.currentBatch.length === 0) return
    this.deps.logger.info(
      `[takeover] 用户放弃 ${this.currentBatch.length} 条(host=${this.currentBatch[0].host})`
    )
    this.advance()
  }

  /**
   * 渲染层报「当前批的查重全部点完了」(态 C 队列清空)→ 推进到下一批 / 关窗。
   *
   * ★ 为什么由渲染层报而不是主进程自己数:四决策经**既有** `duplicate:resolve` 通道直达
   *   `TaskManager`(§3.6 那七条复用通道,主进程侧一行都不改),本服务看不到回执。
   *   渲染层的串行队列才是「还剩几条没点」的唯一真源 —— 让知道的人说话,不去猜。
   */
  onDuplicatesSettled(): void {
    if (this.ownedConflictIds.size === 0) return
    this.deps.logger.info(`[takeover] 查重已全部决策(${this.ownedConflictIds.size} 条)`)
    this.ownedConflictIds.clear() // R6 第一处清理点:决策落地
    // 覆盖 / 重命名会真的建任务,主窗口对此一无所知 → 通知它重拉(与 runSubmit 同一理由)
    this.deps.onTaskCreated()
    this.advance()
  }

  /** IPC 归属校验的真值:只有当前确认窗口的渲染进程才能驱动接管流程(spec §3.7) */
  ownsSender(senderId: number): boolean {
    const own = this.win?.webContentsId()
    return typeof own === 'number' && own === senderId
  }

  /**
   * 这条查重冲突是不是接管路径独占的(注入给 `registerTaskIpc` 的 `isOwnedByTakeover`,spec §6.3)。
   *
   * 两个来源缺一不可:
   * - `submitting` —— 冲突在 `addTask` 的**同步段**内就 emit 了,那一刻 id 还没回来(见字段注释);
   * - `ownedConflictIds` —— id 回来之后、用户点完四决策之前的那段时间。
   */
  owns(conflictId: string): boolean {
    return this.submitting || this.ownedConflictIds.has(conflictId)
  }

  // ── 配置真源:读 / 写(设置页经 IPC,popup 经本地通道;两个入口同一份状态)────────

  /**
   * 设置页用的快照(**四键**:总开关 + 到期时刻 + 算好的 `paused` + 域名例外表)。
   *
   * `excludedDomains` 返回**副本**:调用方(IPC handler → 序列化)拿到的是值,
   * 不给任何人 mutate 内存真源的机会。
   */
  getSettings(): TakeoverSettingsView {
    return {
      enabled: this.config.enabled,
      pausedUntil: this.config.pausedUntil,
      paused: isTakeoverPaused(this.config.pausedUntil, this.deps.now()),
      excludedDomains: [...this.config.excludedDomains]
    }
  }

  /**
   * popup 用的只读快照(**三键**,经本地通道下发)。
   *
   * ⚠️ **刻意不含 `excludedDomains`** —— 域名例外表是本机配置,没有理由下发给扩展;
   * 通道对本机任意程序开放,最小暴露面靠**形状**保障(与 intent 载荷不设 `dir` 同一手法)。
   * ⚠️ 同时给 `pausedUntil` 与服务端算好的 `paused`,**免得 popup 再判一次时钟**(spec §5.3)。
   */
  getConfigView(): TakeoverConfigView {
    const s = this.getSettings()
    return { enabled: s.enabled, pausedUntil: s.pausedUntil, paused: s.paused }
  }

  /**
   * 设暂停时长档(设置页与 popup 共用的**同一个真源写入口**)。
   *
   * **同步更新内存 + 同步返回快照,落盘在后台** —— 通道 handler 的契约是同步的
   * (`takeoverSetPause: (payload) => TakeoverConfigView`),不能在那里 `await` 写盘;
   * 而「暂停立刻生效」比「暂停已落盘」更要紧:下一条 intent 可能在几毫秒后就到。
   * 落盘失败**如实记 error 日志**(不静默),内存态照旧生效到本次运行结束。
   */
  setPause(payload: TakeoverPausePatch): TakeoverSettingsView {
    const pausedUntil = pausedUntilFrom(payload.minutes, this.deps.now())
    this.applyConfig({ ...this.config, pausedUntil })
    this.deps.logger.info(
      `[takeover] 暂停真源已更新:${pausedUntil === null ? '恢复接管' : `暂停 ${payload.minutes} 分钟`}`
    )
    return this.getSettings()
  }

  /**
   * 写总开关 / 域名例外表(设置页专用;popup 没有这个能力)。
   *
   * 域名在此**统一归一**(小写 / 去协议 / 去路径 / 去端口 / 保序去重)—— 结论归主进程,
   * 渲染层以回包为准(与端口校验同一纪律:渲染层不自己判)。
   */
  setSettings(patch: TakeoverSettingsPatch): TakeoverSettingsView {
    const next: TakeoverConfig = {
      ...this.config,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.excludedDomains === undefined
        ? {}
        : { excludedDomains: normalizeDomainList(patch.excludedDomains) })
    }
    this.applyConfig(next)
    this.deps.logger.info(
      `[takeover] 配置已更新:总开关=${next.enabled} 域名例外 ${next.excludedDomains.length} 条`
    )
    return this.getSettings()
  }

  /** 等最近一次落盘落定(测试断言落盘内容 / 关停时收尾用;**不用于应答路径**) */
  async flushWrites(): Promise<void> {
    await this.lastWrite
  }

  /**
   * 内存先行 → 广播 → 后台落盘(失败如实记 error,不静默、不回滚内存态)。
   *
   * ★ **落盘串行化**(`lastWrite.then(...)` 而不是各写各的):`jsonConfigStore.write` 是
   *   「写 `${path}.tmp` → `rename` 覆盖」,两次写并发时**共用同一个 tmp 路径** ——
   *   先完成的那次 rename 会把 tmp 搬走,后一次的 rename 就落到一个不存在的文件上。
   *   本 Step 之前没有任何 store 会被连着写两次,故这个坑在此才第一次暴露(设置页切开关 +
   *   加域名是两次紧挨着的写)。串行化后「最后一次写赢」,且 tmp 永不重叠。
   */
  private applyConfig(next: TakeoverConfig): void {
    this.config = next
    this.deps.onConfigChanged(this.getSettings())
    this.lastWrite = this.lastWrite
      .then(() => this.deps.configStore.write(next))
      .catch((err) => {
        this.deps.logger.error(`[takeover] 配置落盘失败(本次运行内仍生效):${String(err)}`)
      })
  }

  // ── 内部:呈现 / 推进 / 窗口 ─────────────────────────────────────────────

  /** 查重事件到达:同步段内先扣下(归属待 id 确认),否则只认自己的那条并**定向**送小窗口 */
  private onDuplicateEmitted(conflict: DuplicateConflict): void {
    if (this.submitting) {
      this.emittedDuringSubmit = conflict
      return
    }
    if (!this.ownedConflictIds.has(conflict.conflictId)) return
    this.sendDuplicate(conflict)
  }

  /** 定向下发一条查重冲突 + 把窗口调成查重框的高度(态 C) */
  private sendDuplicate(conflict: DuplicateConflict): void {
    this.win?.send(IpcChannel.TakeoverDuplicate, conflict)
    this.win?.setContentHeight(HEIGHT_DUPLICATE)
  }

  private async runSubmit(batch: PendingIntent[], payload: TakeoverSubmitPayload): Promise<void> {
    const wanted = Array.isArray(payload.items) ? payload.items : []
    let created = 0
    let parked = 0
    for (const one of wanted) {
      const intent = batch.find((i) => i.id === one.id)
      if (!intent) continue // 不在当前批(已换批 / 载荷不对)→ 跳过,不臆造任务
      const conflict = await this.createOne(intent, one.filename, payload.dir)
      if (conflict === undefined) continue // 建任务抛错(已记 error)
      if (conflict === null) {
        created += 1
        continue
      }
      // 查重命中:任务扣留在内存(既不入队也不落库),等用户在**同一个小窗口**里点四决策
      this.ownedConflictIds.add(conflict.conflictId)
      parked += 1
      this.sendDuplicate(conflict)
    }
    this.deps.logger.info(
      `[takeover] 已确认 ${created}/${batch.length} 条(host=${batch[0].host})` +
        (parked > 0 ? `,${parked} 条命中查重待决策` : '')
    )
    // 主窗口没有 invoke 可以顺手 refresh(这条路径由主进程发起)→ 建成了就通知它重拉
    if (created > 0) this.deps.onTaskCreated()
    // ★ 有扣留的冲突 → 窗口留着换成查重框(态 C),**点完四决策才关窗**(Step 0 第 6 条);
    //   推进交给渲染层的 `takeover:settled`。
    if (parked > 0) return
    // 期间窗口被关 / 已换批 → 不重复推进
    if (this.currentBatch === batch) this.advance()
  }

  /**
   * 建一条任务。
   *
   * @returns `null` = 建成;`DuplicateConflict` = 命中查重被扣留;`undefined` = 抛错(已记 error)
   */
  private async createOne(
    intent: PendingIntent,
    filename: string | undefined,
    dir: string
  ): Promise<DuplicateConflict | null | undefined> {
    // 接管来源的请求头(spec §6.2):白名单第②层就在这里 —— 协议层只有 referrer / userAgent
    // 两个语义字段(第①层),这里再按键名过滤一次,下游 aria2 只认专用选项(第③层)。
    // 空 referrer 由 `filterDownloadHeaders` 丢弃(空 Referer 与不下发 referer 是同一件事),
    // 故此处不必再判一次;全空 → undefined → 与不带 headers 逐字段等价。
    const headers = filterDownloadHeaders({
      Referer: intent.referrer,
      'User-Agent': intent.userAgent
    })

    this.emittedDuringSubmit = null
    try {
      // ★ 标记只覆盖**同步段**:`addTask` 命中查重时在 return 之前就 emit 了(见 `submitting` 注释)
      this.submitting = true
      const pending = this.deps.addTask({
        // ★ 由 `pending.kind` 决定(v0.4 Task 5 · spec §4.4):接管路径恒 `'http'`(逐字段等价,
        //   I-06);嗅探路径按 `classifySniffed`。**`addTask` 本体一字不改** —— 这是调用点唯一的改动。
        kind: intent.kind,
        source: intent.url,
        filename: filename?.trim() || undefined,
        // ★ 落点 sentinel 原样透传:主进程 `explicitDirOf` 自己判显式 / 走分类,镜像天然成立
        dir,
        headers
      })
      this.submitting = false
      const taskId = await pending
      const conflict = this.takeEmittedConflict()
      // conflictId 恒等于 addTask 的返回值(spec §1.3),故归属判定不需要任何猜测
      return conflict && conflict.conflictId === taskId ? conflict : null
    } catch (err) {
      this.submitting = false
      this.takeEmittedConflict()
      this.deps.logger.error(`[takeover] 建任务失败 host=${intent.host}:${String(err)}`)
      return undefined
    }
  }

  /** 取走同步段内扣下的冲突并清空(独立成方法:避免 `this.x = null` 的控制流窄化把类型收成 `never`) */
  private takeEmittedConflict(): DuplicateConflict | null {
    const conflict = this.emittedDuringSubmit
    this.emittedDuringSubmit = null
    return conflict
  }

  /** 当前批处理完:问缓冲要下一批,再没有就关窗 */
  private advance(): void {
    const action = this.buffer.settled()
    if (action.kind === 'present') {
      this.currentBatch = action.batch
      this.presentCurrent()
      return
    }
    this.currentBatch = []
    this.closeWindow()
  }

  /** 呈现当前批:窗口不在就建(复用则不新建、不重载、不再 focus);渲染层未就绪则等它来 `ready()` */
  private presentCurrent(): void {
    const win = this.ensureWindow()
    if (!win) {
      this.dropAccepted('确认窗口不可用')
      return
    }
    if (!this.rendererReady) return
    win.send(IpcChannel.TakeoverPresent, this.buildBatch())
    // 高度随形态走(态 A 固定 / 态 B 按条数,超 6 行滚动);宽度恒 460 不变
    win.setContentHeight(takeoverContentHeight(this.currentBatch.length))
    // 先送内容再 show:窗口带着内容出现,不闪空帧
    win.showOnce()
  }

  private buildBatch(): TakeoverBatch {
    return {
      items: this.currentBatch.map((i) => {
        const cookieHosts = this.cookieHostsFor(i)
        return {
          id: i.id,
          url: i.url,
          host: i.host,
          filename: i.filename,
          totalBytes: i.totalBytes,
          kind: i.kind,
          // 空则**不写该键**(与应答里的 `needCookieFor` 同一口径:没有就是没有,不是空数组)
          ...(cookieHosts === undefined ? {} : { cookieHosts })
        }
      }),
      theme: this.deps.getResolvedTheme()
    }
  }

  /** 建窗(幂等)。抛错 → **熔断** + 一条 error 日志,此后 `canPresent()` 第②条恒假 */
  private ensureWindow(): TakeoverWindowHandle | null {
    if (this.win && !this.win.isDestroyed()) return this.win
    if (this.windowCreationBroken) return null
    try {
      const win = this.deps.createWindow()
      this.win = win
      this.rendererReady = false
      win.onClosed(() => this.onWindowClosed(win))
      return win
    } catch (err) {
      this.windowCreationBroken = true
      this.win = null
      this.deps.logger.error(
        `[takeover] 创建确认窗口失败,此后一律不接管(重启 DownLord 复位):${String(err)}`
      )
      return null
    }
  }

  private closeWindow(): void {
    const win = this.win
    // ★ 立刻断开引用:关窗期间来的新意图会开一个新窗口,不会送进一个正在关的窗口
    this.win = null
    this.rendererReady = false
    if (win && !win.isDestroyed()) win.close()
  }

  /** 窗口销毁(用户关窗 / 渲染进程崩溃):清引用 → 缓冲非空则**立刻重开一个**(不静默积压) */
  private onWindowClosed(win: TakeoverWindowHandle): void {
    if (this.win !== win) return // 我们已主动断开引用(或已换新窗口)→ 状态早清好
    this.win = null
    this.rendererReady = false
    this.currentBatch = []
    this.skipPendingConflicts()
    if (this.buffer.size() > 0) {
      this.advance()
      return
    }
    this.buffer.settled()
  }

  /**
   * 关窗时对所有未决冲突**显式**下 `skip`(黑洞第三变体的正面处理,spec §3.7)。
   *
   * ★ 为什么必须显式下决策、而不是把 id 一扔了事:任务此刻**扣留在 `pendingConflicts` 里** ——
   *   既不在库、也不在列表、无人应答。那正是 CONTEXT.md 定义的**黑洞**(判据是「谁负责」,
   *   不是「谁在下」)。显式 `skip` 把「静默蒸发」变成「用户关窗即放弃」—— **有人负责了**。
   *
   * 对 http 而言 `skip` = 直接 return、不 `insertTask`,即丢弃该任务 —— 这**正是**用户关窗的语义
   * (等同点取消),且确认框已如实告知「浏览器那边已经取消」,用户知情。
   *
   * R6 第二处清理点(另两处:`onDuplicatesSettled` 的决策落地 / `stop()` 的跨启停)。
   */
  private skipPendingConflicts(): void {
    if (this.ownedConflictIds.size === 0) return
    const ids = [...this.ownedConflictIds]
    this.ownedConflictIds.clear()
    this.deps.logger.info(`[takeover] 关窗:${ids.length} 条未决查重按「跳过」放弃(不静默蒸发)`)
    for (const conflictId of ids) {
      void this.deps.resolveDuplicate({ conflictId, decision: 'skip' }).catch((err) => {
        this.deps.logger.error(`[takeover] 未决冲突跳过失败 ${conflictId}:${String(err)}`)
      })
    }
  }

  /** 熔断后把已受理却永远弹不出来的条目**当场丢弃并如实记 error**(不静默积压) */
  private dropAccepted(reason: string): void {
    const lost = this.currentBatch.length + this.buffer.size()
    this.currentBatch = []
    this.buffer.reset()
    this.clearTimers()
    if (lost > 0) {
      this.deps.logger.error(`[takeover] ${reason},已受理的 ${lost} 条无法确认(浏览器那边已取消)`)
    }
  }

  private armTick(at: number): void {
    this.cancelTickTimer?.()
    const delay = Math.max(0, at - this.deps.now())
    this.cancelTickTimer = this.deps.scheduleTick(delay, () => {
      this.cancelTickTimer = null
      const action = this.buffer.tick()
      if (action.kind === 'present') {
        this.currentBatch = action.batch
        this.presentCurrent()
      }
    })
  }

  private armWarmup(): void {
    this.cancelWarmupTimer?.()
    this.cancelWarmupTimer = this.deps.scheduleTick(0, () => {
      this.cancelWarmupTimer = null
      if (!this.ensureWindow()) this.dropAccepted('确认窗口不可用')
    })
  }

  private clearTimers(): void {
    this.cancelTickTimer?.()
    this.cancelTickTimer = null
    this.cancelWarmupTimer?.()
    this.cancelWarmupTimer = null
  }

  /** 拒绝路径的日志:**只有 host 与原因码**(URL / referrer / UA / token 一个字都不进日志) */
  private logRejected(
    host: string,
    why: TakeoverRejectReason | SniffRejectReason | 'no_window' | undefined
  ): void {
    this.deps.logger.info(`[takeover] host=${host} → 不接管(${why ?? 'unknown'})`)
  }
}
