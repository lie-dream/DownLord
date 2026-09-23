/**
 * tracker 表热更新编排(v0.4 Task 1 · spec §4.1 / §4.3 / §4.5)。
 *
 * 链路:**按需触发**(添加 BT 任务时,非启动 → 非 BT 用户零外联)→ 查开关 + 两层节流 →
 * 跟随代理三档 → 双源堆叠拉取 → 解析 / 合并去重 / 截长 → 合格性(≥10 条)→ 自包含原子写 →
 * 热应用(`changeGlobalOption` + **追补**)→ 回写生效表 + 广播状态。
 *
 * ⚠️ **远端为准整表替换**(D6):内置 47 条**只在拉取失败或远端表不合格时兜底**,**绝不与远端表合并** ——
 * 合并会让 2026-07-25 静态快照里的死条目永不淘汰,且每条死条目都要走一遍 `bt-tracker-connect-timeout=10`。
 *
 * ⚠️ **失败面逐项**按 spec §4.5 十一行处理,不合并成一句笼统 catch;三条贯穿原则:
 * ①任何失败都**不影响下载任务本身**(调用方 fire-and-forget,本类顶层 try/catch 绝不外抛);
 * ②任何失败都**不删除已有缓存表**;③失败**不更新** `updatedAt`(否则被 12h 节流锁死当天无法重试),
 * 只用**内存** `lastAttemptAt` 做 30 分钟短退避。
 *
 * 依赖**全注入**(http / 代理 / store / 时钟 / 引擎 / 开关 / 回调 / 源),测试注入 fake 即可离线跑全链路。
 */
import { shouldCheckNow } from '../update/updateStateStore'
import type { UpdateHttpClient } from '../update/updateHttp'
import type { BtTrackerApplyResult } from '../engine/downloadEngine'
import type { BtTrackerState, BtTrackerStatus } from '../../shared/ipc'
import { DEFAULT_BT_TRACKERS } from '../engine/aria2Args'
import type { BtTrackerCache, BtTrackerStore } from './btTrackerStore'
import { DEFAULT_BT_TRACKER_CACHE } from './btTrackerStore'
import {
  BT_TRACKER_RETRY_MS,
  BT_TRACKER_THROTTLE_MS,
  MIN_TRACKERS,
  isTrackerListQualified,
  mergeRemoteTrackers,
  parseTrackerText
} from './trackerText'

/** 一组远端源:同一仓库的域名版 + IP 版两个文件(D7:两者之间合并去重,抗 DNS 污染) */
export interface BtTrackerSourceGroup {
  /** 组名(仅日志 / 排障用) */
  name: string
  /** 域名版列表 URL */
  best: string
  /** IP 直连版列表 URL */
  bestIp: string
}

/**
 * 双源堆叠常量(D11):jsDelivr 主 → GitHub raw 备,按顺序试,**任一组拿到合格表即停**。
 *
 * ⚠️ **不纳入第三方 GitHub 镜像**(ghproxy 类):寿命短、**可被投毒回恶意 tracker**、性质接近「中转」。
 * 加公开 CDN 不违背 §7.6「不提供翻墙能力」(禁的是内置节点 / 做墙外中转,拉一个公开文本文件不是),
 * 但**不承诺「一定拉得到」** —— 拉不到就退内置表,如实呈现。
 */
export const BT_TRACKER_SOURCES: readonly BtTrackerSourceGroup[] = [
  {
    name: 'jsdelivr',
    best: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
    bestIp: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best_ip.txt'
  },
  {
    name: 'ghraw',
    best: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
    bestIp: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt'
  }
]

/**
 * tracker 更新状态(spec §5.3 的 `BtTrackerStatus`)。
 *
 * ⚠️ 类型本体已按 spec §5.3 移入 `src/shared/ipc.ts`(跨进程共享,渲染层经 `bt:getTrackerStatus` /
 * `bt:trackerStatusChanged` 拿到同一形状);此处只作 re-export,既有 import 点不必改。
 */
export type { BtTrackerState, BtTrackerStatus }

/** 状态行短原因(诚实、非堆栈;逐条对应 spec §4.5) */
const REASON_NETWORK = '网络不可达' // #3
const REASON_TOO_FEW = '远端列表条目过少' // #6
const REASON_PERSIST_FAILED = '本次未能保存到磁盘,重启后会回退' // #7
const REASON_GLOBAL_FAILED = '需重启应用后对新任务生效' // #8

export interface BtTrackerServiceDeps {
  /** 只取需要的两个方法 —— 本 service **不下载文件**,类型上就堵死(复用 index 里同一个 updateHttp 实例) */
  http: Pick<UpdateHttpClient, 'configureProxy' | 'getText'>
  /** 当前代理档(同 YtdlpUpdater 范式:拉取前 configureProxy,跟随代理三档,不另起网络栈,D12) */
  getProxy: () => { effectiveUrl: string | null }
  /** tracker 缓存读写门面(内含注入 fs) */
  store: BtTrackerStore
  /** 时钟注入(测试固定) */
  now: () => number
  /** 热应用到引擎(`changeGlobalOption` + 追补);gid 全封在 engine 内,此处只拿计数(§7.4) */
  applyToEngine: (trackers: readonly string[]) => Promise<BtTrackerApplyResult>
  /** 自动路径开关(读 settings 的 `btAutoUpdateTrackers`);**手动路径无视本开关** */
  isEnabled: () => boolean
  /** 成功后回写 index 的生效表(供 aria2 崩溃重启 / 下次启动的 pull 通道取用) */
  onApplied: (trackers: readonly string[]) => void
  /** 状态变更回调(已接 `broadcastBtTrackerStatus` → `bt:trackerStatusChanged`;自动路径**不弹 toast**,只记日志 + 状态行,D15) */
  onStatus: (status: BtTrackerStatus) => void
  /** 源常量(默认双源堆叠;测试可换) */
  sources?: readonly BtTrackerSourceGroup[]
  /** 日志(默认 console.log;前缀统一 `[bt-tracker]`) */
  log?: (msg: string) => void
}

/** 单个 group 的拉取产物 */
interface GroupFetch {
  /** 各文件解析后的表(按 best → bestIp 顺序,空表已剔除) */
  lists: string[][]
  /** 有贡献条目的源 URL */
  urls: string[]
  /** 该组是否至少有一个文件成功取到(用于区分 §4.5 #3「全不可达」与 #6「条目过少」) */
  anyFetchOk: boolean
}

export class BtTrackerService {
  /** 缓存的内存镜像(首次用时读盘;写盘成功后同步更新) */
  private cache: BtTrackerCache | null = null
  /** 上次**尝试**拉取的时间戳(**仅内存、不落盘**,细则 S3 的 30min 短退避) */
  private lastAttemptAt = 0
  /** 上次失败的短原因(成功即清) */
  private lastError: string | null = null
  /** 上次成功但有保留的短原因(写盘失败 / 全局热改失败);不改判 state,只如实附注 */
  private lastWarning: string | null = null
  /** 拉取进行中(防并发重入:多个 BT 任务同时添加只拉一次) */
  private busy = false

  constructor(private readonly deps: BtTrackerServiceDeps) {}

  /**
   * 自动路径(spec §4.1):添加 BT 任务时 **fire-and-forget** 调用。
   * 顺序:开关 → 12h 成功节流 → 30min 失败退避 → 拉取。
   *
   * ⚠️ 顶层 try/catch 全包(§4.5 #11),**绝不向调用方抛** —— 任务立即提交,不等网络、不受本链路影响。
   */
  async maybeRefresh(): Promise<void> {
    try {
      // #10 开关关闭 → 整条链路不启动,**零外联**(不记日志:无事发生)
      if (!this.deps.isEnabled()) return
      if (this.busy) return

      const cache = await this.loadCache()
      const now = this.deps.now()
      // 12h 成功节流(D8):缓存新鲜就不动
      if (!shouldCheckNow(cache.updatedAt, now, BT_TRACKER_THROTTLE_MS)) return
      // 30min 失败退避(细则 S3):失败不写 updatedAt,改用内存 lastAttemptAt,保证「今天网络恢复今天就能拉到」
      if (!shouldCheckNow(this.lastAttemptAt, now, BT_TRACKER_RETRY_MS)) return

      await this.runRefresh()
    } catch (err) {
      // #11 任何未预料异常:进 30min 退避,状态保持上次不变
      this.lastAttemptAt = this.deps.now()
      this.busy = false
      this.log(`unexpected: ${toErrText(err)}`)
    }
  }

  /**
   * 手动路径(设置页「立即更新」,经 `bt:updateTrackersNow` 调):**无视开关与两层节流**,其余与自动路径完全相同。
   * 同样不外抛 —— 失败以 `state:'failed'` 的状态返回,交渲染层 toast(成败都弹,D15)。
   */
  async updateNow(): Promise<BtTrackerStatus> {
    try {
      if (this.busy) return await this.getStatus()
      await this.loadCache()
      return await this.runRefresh()
    } catch (err) {
      this.lastAttemptAt = this.deps.now()
      this.busy = false
      this.log(`unexpected: ${toErrText(err)}`)
      return await this.getStatus()
    }
  }

  /** 当前状态快照(经 `bt:getTrackerStatus` 供设置页挂载回显;每次现算,不缓存 state) */
  async getStatus(): Promise<BtTrackerStatus> {
    const cache = await this.loadCache()
    return this.statusOf(cache)
  }

  // ========== 内部实现 ==========

  /** 读盘一次并记内存镜像(损坏 / 缺失由 store 回退默认,不抛) */
  private async loadCache(): Promise<BtTrackerCache> {
    if (!this.cache) {
      this.cache = await this.deps.store.read()
    }
    return this.cache
  }

  /** 一次完整拉取(自动 / 手动共用);**不抛**,以状态回报结果 */
  private async runRefresh(): Promise<BtTrackerStatus> {
    // 进入即记尝试时间:无论成败都进 30min 退避(成功另有 12h 节流兜住)
    this.lastAttemptAt = this.deps.now()
    this.busy = true
    this.deps.onStatus(this.statusOf(this.cache ?? DEFAULT_BT_TRACKER_CACHE))

    try {
      // 跟随代理三档(D12):拉的是一个**公开文本文件**,不是 BT 流量;不另起网络栈
      await this.deps.http.configureProxy(this.deps.getProxy().effectiveUrl)

      const groups = this.deps.sources ?? BT_TRACKER_SOURCES
      let anyFetchOk = false
      let winner: { trackers: string[]; urls: string[] } | null = null

      // 堆叠语义:按顺序试每个 group,**任一 group 拿到合格表即停**
      for (const group of groups) {
        const fetched = await this.fetchGroup(group)
        anyFetchOk = anyFetchOk || fetched.anyFetchOk
        // 组内 best + bestIp 合并去重 + 截长(D7);其中一个文件失败不废掉整个 group
        const merged = mergeRemoteTrackers(fetched.lists)
        if (isTrackerListQualified(merged)) {
          winner = { trackers: merged, urls: fetched.urls }
          break
        }
        if (fetched.anyFetchOk) {
          // #6 该组取到了内容但合并后条数不足 → 不采纳,继续试下一组
          this.log(`merged ${merged.length} entries < min ${MIN_TRACKERS}, discard`)
        }
      }

      if (!winner) {
        this.markFailed(anyFetchOk)
      } else {
        await this.commitSuccess(winner.trackers, winner.urls)
      }
    } finally {
      this.busy = false
    }

    // 末次状态在 busy 落回 false **之后**才广播 —— 否则 UI 按钮会永久停在「更新中…」
    const status = this.statusOf(this.cache ?? DEFAULT_BT_TRACKER_CACHE)
    this.deps.onStatus(status)
    return status
  }

  /**
   * 拉一个 group 的两个文件。**单文件失败不中止**(§4.5 #1 / #2:网络错误 / 非 2xx 均由 `getText` 抛),
   * 空内容(#4)与解析后全非法(#5)各记各的日志、该文件贡献 0 条,不单独判失败。
   */
  private async fetchGroup(group: BtTrackerSourceGroup): Promise<GroupFetch> {
    const out: GroupFetch = { lists: [], urls: [], anyFetchOk: false }

    for (const url of [group.best, group.bestIp]) {
      let text: string
      try {
        text = await this.deps.http.getText(url)
      } catch (err) {
        // #1 不可达 / 超时 与 #2 非 2xx(getText 抛 `HTTP <status>`)同处理:继续试同组另一文件 / 下一组
        this.log(`fetch failed: ${url} ${toErrText(err)}`)
        continue
      }
      out.anyFetchOk = true

      if (!text.trim()) {
        // #4 2xx 但内容为空(0 字节 / 全空白)
        this.log(`source empty: ${url}`)
        continue
      }
      const parsed = parseTrackerText(text)
      if (parsed.length === 0) {
        // #5 有内容但解析后无一条合格
        this.log(`parsed 0 valid entries: ${url}`)
        continue
      }
      out.lists.push(parsed)
      out.urls.push(url)
    }

    return out
  }

  /**
   * 本次失败(§4.5 #3 全源不可达 / #6 条数不足):**不写盘、不 push、`updatedAt` 不更新**、
   * 已有缓存表**不删**;已在 `runRefresh` 入口置 `lastAttemptAt` → 进 30min 退避。生效表保持原样。
   */
  private markFailed(anyFetchOk: boolean): void {
    const cache = this.cache ?? DEFAULT_BT_TRACKER_CACHE
    if (!anyFetchOk) {
      // #3 两个 group 全不可达 / 全非 2xx
      const usingBuiltin = cache.trackers.length === 0
      const n = usingBuiltin ? DEFAULT_BT_TRACKERS.length : cache.trackers.length
      this.log(`all sources failed, keep current list (${n} entries, builtin=${usingBuiltin})`)
    }
    this.lastError = anyFetchOk ? REASON_TOO_FEW : REASON_NETWORK
    this.lastWarning = null
  }

  /**
   * 本次成功:写盘 → push → 回写生效表。
   * - #7 写盘失败:**仍继续 push**(内存里已有合格新表,不因持久化失败放弃本次收益),但 `updatedAt`
   *   **不更新**(下次重试写盘),状态行如实说明「重启后会回退」;
   * - #8 `changeGlobalOption` 失败:表**仍已落盘**(下次启动经 pull 生效),**仍继续追补**(engine 内两者独立),
   *   状态行如实说明「需重启应用后对新任务生效」;
   * - #9 追补单条失败:engine 内已 catch 并计入 `failed`,**不影响整体成功判定**;状态行**不提追补**
   *   (§4.6 表述禁令:追补是尽力而为,未验证 announce 实效,不得暗示已生效)。
   */
  private async commitSuccess(trackers: string[], urls: string[]): Promise<void> {
    const now = this.deps.now()
    const prev = this.cache ?? DEFAULT_BT_TRACKER_CACHE
    let persisted = true

    try {
      await this.deps.store.write({ updatedAt: now, sourceUrls: urls, trackers })
    } catch (err) {
      persisted = false
      this.log(`persist failed: ${toErrText(err)}`)
    }

    // 生效表在内存里立即换成新表(aria2 崩溃重启的 pull 也吃到);写盘失败则 updatedAt 保持旧值
    this.cache = {
      updatedAt: persisted ? now : prev.updatedAt,
      sourceUrls: urls,
      trackers
    }

    // 热应用本身抛错(引擎未启动 / 后端未实现)按 #8 同族处理:表已落盘,下次启动经 pull 生效
    let applied: BtTrackerApplyResult = { globalOk: false, patched: 0, failed: 0 }
    try {
      applied = await this.deps.applyToEngine(trackers)
    } catch (err) {
      this.log(`apply failed: ${toErrText(err)}`)
    }
    this.deps.onApplied(trackers)

    this.lastError = null
    this.lastWarning = !persisted
      ? REASON_PERSIST_FAILED
      : !applied.globalOk
        ? REASON_GLOBAL_FAILED
        : null
    this.log(
      `applied ${trackers.length} entries from ${urls.join(' + ')} ` +
        `(globalOk=${applied.globalOk}, patched=${applied.patched}, failed=${applied.failed})`
    )
  }

  /** 由缓存 + 内存标记算状态;**生效表** = 缓存表非空 ? 缓存表 : 内置表(CONTEXT.md 三态口径) */
  private statusOf(cache: BtTrackerCache): BtTrackerStatus {
    const usingBuiltin = cache.trackers.length === 0
    const state: BtTrackerState = !this.deps.isEnabled()
      ? 'disabled'
      : this.lastError
        ? 'failed'
        : cache.updatedAt > 0 || cache.trackers.length > 0
          ? 'ok'
          : 'never'
    return {
      state,
      updatedAt: cache.updatedAt,
      count: usingBuiltin ? DEFAULT_BT_TRACKERS.length : cache.trackers.length,
      usingBuiltin,
      lastError: this.lastError ?? this.lastWarning,
      busy: this.busy
    }
  }

  private log(msg: string): void {
    const line = `[bt-tracker] ${msg}`
    if (this.deps.log) {
      this.deps.log(line)
      return
    }
    console.log(line)
  }
}

/** 错误取短文案(日志 / 状态行用,不带堆栈) */
function toErrText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
