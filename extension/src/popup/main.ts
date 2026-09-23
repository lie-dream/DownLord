/**
 * popup 入口 — **装配点**:adapter → 读事实 → model → view(v0.4 Task 2 · spec §2.1)。
 *
 * 只调 `createDefaultAdapter()`,不触 `chrome` / `fetch` 全局 —— 两个全局的字面分别只在
 * `chromeAdapter.ts` 与 `fetchNet.ts`。popup 每次打开都是全新文档,故这里不做任何缓存。
 *
 * **打开即向 sw 发一条消息**(v0.4 Task 3):一处改动兑现两件事 ——
 * ① 事件驱动握手的触发点(spec §5.4);② `docs/TODO.md` **#46** 的 M4 判据自此可达
 * (popup 打开 → sw 收到 `onMessage` → 唤醒计数 +1 且 `lastEvent` 为 `message`)。
 *
 * **打开即问一次接管状态**(v0.4 Task 4):接管状态**不落 storage**(约定 L1 的正向应用),
 * 每次打开现问 —— 问不到就显示占位符,**绝不留上一次的值**。
 *
 * **打开即读一次本页嗅探桶**(v0.4 Task 5):桶在会话存储里按 tabId 分,
 * 这里只读**当前活动标签页**那一个 —— 「本页」这个词的实现就是这一行。
 * (措辞刻意不带浏览器命名空间前缀 —— 那条 grep 判据只准命中适配实现那一个文件。)
 *
 * **点某一条才发那一条**(v0.4 Task 5 Phase 2):`handOver` 是全仓唯一的嗅探上行调用点,
 * 「未被用户选中的资源从不离开浏览器」这句话在那里兑现。
 *
 * **点按钮才取当前页地址**(v0.4 Task 6):`downloadPageVideo` 是甲路径的唯一调用点。
 * 地址**现取现发、不落任何 storage**;读不到时如实说一行(探针 B4:受限页恒读不到)。
 */
import { createDefaultAdapter } from '../adapter/chromeAdapter'
import type { BrowserAdapter } from '../adapter/browserAdapter'
import { BUILD_ID } from '../buildId'
import { readLastHandshake, readPairing, savePairing } from '../channel/handshakeClient'
import { DEFAULT_PORT, PROTOCOL_VERSION } from '../channel/protocol'
import { fetchTakeoverConfig, setTakeoverPause } from '../channel/takeoverConfigClient'
import type { TakeoverConfigView } from '../contract'
import { sendSniffSelected } from '../sniff/sniffClient'
import { emptyBucket, type SniffBucket } from '../sniff/sniffBucket'
import { readBucket } from '../sniff/sniffStore'
import { readSniffEnabled, setSniffEnabled } from '../sniff/sniffSwitch'
import type { SniffRow, SniffSendState } from '../sniff/sniffView'
import { WAKE_STATE_KEY, type WakeState } from '../sw/lifecycle'
import { SW_SYNC_KIND, isSwSyncReply, type SwSyncRequest } from '../sw/swMessage'
import { validatePairingForm } from './pairing'
import { buildPopupModel, type PopupFacts, type VideoIntentState } from './popupModel'
import { renderPopup } from './popupView'
import { sendVideoIntent } from './videoIntentClient'

/**
 * 读当前标签页的桶。
 *
 * ★ **`undefined` 只保留给「这次没读到」** —— 无当前 tab(popup 开在没有标签页的窗口里)
 *   或会话存储读失败。`readBucket` 对**「这个 tab 还没有桶」**同样返回 `undefined`,
 *   而那分明是「桶是空的」:两者混用会让「本页什么都没采到」被显示成「无法读取本页资源」,
 *   把一句正常的空状态谎报成故障。故这里把后者兜成空桶,让两个事实各归各位
 *   (与 `PopupFacts.takeover` 那条「没问到 ≠ 没暂停」是同一条约定)。
 */
async function readTabBucket(
  adapter: BrowserAdapter,
  tabId: number | undefined
): Promise<SniffBucket | undefined> {
  if (tabId === undefined) return undefined
  try {
    return (await readBucket(adapter, tabId)) ?? emptyBucket()
  } catch {
    return undefined
  }
}

/** 约定 L5:每一项都可能读不到(刚装上 / 用户清过数据),数据层会兜成占位符 */
async function readFacts(adapter: BrowserAdapter, tabId: number | undefined): Promise<PopupFacts> {
  const [wake, pairing, lastHandshake, sniffEnabled, sniff] = await Promise.all([
    adapter.storage.get<WakeState>(WAKE_STATE_KEY),
    readPairing(adapter),
    readLastHandshake(adapter),
    readSniffEnabled(adapter),
    readTabBucket(adapter, tabId)
  ])

  return {
    extensionVersion: adapter.runtime.getVersion(),
    extensionId: adapter.runtime.getId(),
    wake,
    pairing,
    lastHandshake,
    defaultPort: DEFAULT_PORT,
    protocolVersion: PROTOCOL_VERSION,
    // 接管状态**不在这里读** —— 它不在 storage 里,只能问 DownLord。先渲染再问,
    // 于是 popup 打开的第一帧就已经可用(问不到时这个 `undefined` 就是最终值)。
    takeover: undefined,
    buildId: BUILD_ID,
    // sw 那份同样要现问(下面 `syncWithServiceWorker`)。**在问到之前按「不一致」显示** ——
    // 沉默不是一致(#53)。
    swBuildId: undefined,
    sniffEnabled,
    sniff,
    sniffJustEnabled: false,
    // 本次 popup 打开期间的转交结果,起点必然为空(**不落 storage**,重开即回默认)
    sniffSent: {},
    // 同上:本次打开还没点过那个按钮
    videoIntent: undefined
  }
}

async function main(): Promise<void> {
  const root = document.getElementById('root')
  if (!root) return

  const adapter = createDefaultAdapter()
  /** 本次 popup 打开时的活动标签页 —— 「本页」的实现;popup 每次打开都是全新文档,故只取一次 */
  const activeTabId = await adapter.tabs.queryActiveId()
  let facts = await readFacts(adapter, activeTabId)

  const handle = renderPopup(root, buildPopupModel(facts), {
    onSubmit(input: { token: string; port: string }): void {
      void saveAndConnect(input)
    },
    onSetPause(minutes: number | null): void {
      void applyPause(minutes)
    },
    onToggleSniff(enabled: boolean): void {
      void toggleSniff(enabled)
    },
    onReloadTab(): void {
      void reloadActiveTab()
    },
    onDownload(row: SniffRow): void {
      void handOver(row)
    },
    onDownloadPageVideo(): void {
      void downloadPageVideo()
    }
  })

  /**
   * 「用 DownLord 下载此页视频」(v0.4 Task 6 甲路径)。
   *
   * ★ **按钮恒可点,这里也不判断当前页是不是视频页** —— 要判断就得注入 content script
   *   (表外权限)或写不可靠的 URL 启发式,而 yt-dlp 支持上千站点,**我们本来就判断不了**。
   *   点了就把页面地址交给它试;不是视频页,就走 DownLord 既有的解析失败路径(spec §7.4)。
   *
   * ★ **地址是现取的,而且**必须**有一条读不到的分支**(探针 B4,2026-08-17 实测):
   *   仅 `<all_urls>`、无 `tabs` 权限时,普通 http(s) 页的地址读得到(7 个 tab 中 6 个);
   *   但 `edge://…` / 新建标签页 / 扩展商店这类**不在匹配范围内**的页面,地址恒被抹掉。
   *   于是**恒可点 ≠ 恒能拿到地址** —— 那种情形如实说一行,**不崩、也不装作拿到了**。
   *   ⚠️ 为它追加 `tabs` / `activeTab` 是**表外权限**,须回用户拍板,本 Step 明确不加。
   *
   * ★ **只有确实收到 `cookie.offer` 的成功应答,那半句「已附 … 的登录态」才会出现** ——
   *   措辞与出现条件全在 `popupModel.describeVideoIntent` 里(可逐条断言)。
   */
  async function downloadPageVideo(): Promise<void> {
    const pageUrl = await adapter.tabs.queryActiveUrl()
    if (pageUrl === undefined) {
      markVideoIntent({ phase: 'no_url' })
      return
    }

    markVideoIntent({ phase: 'sending' })
    const result = await sendVideoIntent(adapter, pageUrl)
    markVideoIntent(
      result.taken
        ? {
            phase: 'taken',
            cookieDomains: result.cookies.accepted,
            cookieTooLarge: result.cookies.tooLarge
          }
        : { phase: 'failed' }
    )
  }

  /** ⚠️ **不写任何 storage**(约定 L1):这份结果只对本次 popup 有意义 */
  function markVideoIntent(state: VideoIntentState): void {
    facts = { ...facts, videoIntent: state }
    handle.update(buildPopupModel(facts))
  }

  /**
   * 把用户点中的**那一条**交给 DownLord。
   *
   * ★ **一次只发一条**,且只在用户点了才发 —— 「未被用户选中的资源从不离开浏览器」这句话
   *   在这里兑现(全仓唯一的嗅探上行调用点)。
   *
   * ★ **三段式如实落地,绝不假装成功**:先落 `sending`(按钮当场禁用,免得连点两次建两个任务)→
   *   拿到明确受理才落 `sent` → **其余一切**(未配对 / 连不上 / 超时 / 应答看不懂)落 `failed`,
   *   按钮恢复可点并挂一行「没能交给 DownLord,请确认它正在运行」。
   *   `sendSniffSelected` 内部不抛,这里因此不需要 try —— 它把降级判定收在了纯函数一侧。
   *
   * ⚠️ **不写任何 storage**(约定 L1):这份结果只对本次 popup 有意义。
   */
  async function handOver(row: SniffRow): Promise<void> {
    markSent(row.url, 'sending')
    const taken = await sendSniffSelected(adapter, row)
    markSent(row.url, taken ? 'sent' : 'failed')
  }

  function markSent(url: string, state: SniffSendState): void {
    facts = { ...facts, sniffSent: { ...facts.sniffSent, [url]: state } }
    handle.update(buildPopupModel(facts))
  }

  /**
   * 「强制刷新本页」——**只在用户点了才刷**,页面绝不被自动 reload。
   *
   * ★ **必须绕过缓存**(2026-08-09 实测 R2):关掉标签页再打开同一 URL,采到的资源从
   *   4 条掉到 2 条 —— **缓存命中不触发响应头事件**,没有响应头就没有嗅探。普通刷新刷完
   *   照样走缓存、照样嗅不到,那个按钮会变成一个看着有用的摆设。约束焊在适配层的方法名与
   *   实现里(`reloadBypassingCache`),这里想退化成普通刷新都没有入口。
   *
   * ★ **刷完就把 popup 关掉**:reload 不会关闭 popup,于是页面已经换了一份、popup 却仍停在
   *   刷新前读到的那份事实上 —— 条数是旧的,那句提示也还挂着,像是没刷成功。而新页面的资源
   *   要等请求陆续回来才进桶,**此刻回读一次也只会读到旧值**,所以正确的做法不是刷新界面,
   *   而是退场:用户重开 popup 时读到的就是新页面真正采到的东西。
   */
  async function reloadActiveTab(): Promise<void> {
    if (activeTabId === undefined) return
    await adapter.tabs.reloadBypassingCache(activeTabId)
    window.close()
  }

  /**
   * 拨动嗅探开关。
   *
   * `sniffJustEnabled` 只是**本次 popup 打开期间**的一个标记(popup 每次打开都是全新文档,
   * 故它天然表达「刚刚在这里开的」)—— **不落 storage**:那会让人下次打开还看到「刷新本页」。
   *
   * ★ **关闭后回读一次桶,而不是就地假设它已经空了**(2026-08-09 真机验收暴露):
   *   `setSniffEnabled(false)` 确实会清桶,但「我以为清了」与「我读到它空了」是两回事 ——
   *   前者在清桶失败时会给出一句安心的「已关闭」,把故障盖住。回读之后,残留会当场
   *   显示成「已关闭 · N 条」,而 N 本该是 0。
   */
  async function toggleSniff(enabled: boolean): Promise<void> {
    await setSniffEnabled(adapter, enabled)
    const sniff = await readTabBucket(adapter, activeTabId)
    facts = { ...facts, sniffEnabled: enabled, sniff, sniffJustEnabled: enabled }
    handle.update(buildPopupModel(facts))
  }

  /**
   * 落一次新拿到的接管快照。
   *
   * ⚠️ **`Date.now()` 必须在这里取** —— 和它一起进 model 的 `pausedUntil` 是刚回来的那份,
   *    两个数得来自同一个时间点。Step 6a 的设置页正是在这里踩过:拿旧时刻减新 `pausedUntil`,
   *    `Math.ceil` 把偏差整个藏起来,三档一律显示 16 / 61 / 241 分钟。
   *
   * ⚠️ `config` 为 `undefined`(没问到)时**照样写进去** —— 那是「不知道」的如实表达,
   *    不是「保留上一个值」。CONTEXT.md「临时暂停接管」警告的就是后者。
   */
  function applyTakeover(config: TakeoverConfigView | undefined): void {
    facts = { ...facts, takeover: config ? { config, at: Date.now() } : undefined }
    handle.update(buildPopupModel(facts))
  }

  async function refreshTakeover(): Promise<void> {
    applyTakeover(await fetchTakeoverConfig(adapter))
  }

  /** 按下时长档 / 「恢复接管」。应答**就是写后的快照**,故就地更新、**不再回读一次** */
  async function applyPause(minutes: number | null): Promise<void> {
    const written = await setTakeoverPause(adapter, minutes)
    applyTakeover(written)
    if (!written) {
      // 没拿到应答 = **没写成**。不许装作写成功了 —— 那会让 popup 显示一个不存在的暂停态
      handle.setMessage('没能改动接管状态 —— DownLord 可能没在运行,或本地通道已关闭')
    }
  }

  /**
   * 叫醒 sw:它记一次唤醒、顺带握手,把结果当应答回来 —— popup 不必再回头读 storage。
   *
   * ★ 应答里还带着 **sw 自己那份 buildId**(#53)。形状不认(**含旧 sw 回不出这个字段**)时
   *   把 `swBuildId` 明确落成 `undefined` —— 数据层会把它当作「不一致」并告警。
   *   **沉默不是一致**:失效模式②(浏览器缓存了旧 SW 脚本)最可能的表现恰恰就是沉默。
   */
  async function syncWithServiceWorker(): Promise<void> {
    const reply = await adapter.runtime.sendMessage({ kind: SW_SYNC_KIND } satisfies SwSyncRequest)
    if (!isSwSyncReply(reply)) {
      facts = { ...facts, swBuildId: undefined }
      handle.update(buildPopupModel(facts))
      return
    }

    facts = {
      ...facts,
      swBuildId: reply.buildId,
      // `handled:false` = sw 活着但不认识这条消息 —— 它的 buildId 照收(那正是要比对的东西),
      // 但唤醒 / 握手的事实这次没有,不拿旧值冒充新值
      wake: reply.handled ? (reply.wake ?? facts.wake) : facts.wake,
      lastHandshake: reply.handled ? (reply.handshake ?? facts.lastHandshake) : facts.lastHandshake
    }
    handle.update(buildPopupModel(facts))
  }

  async function refresh(): Promise<void> {
    if (facts.pairing) handle.setMessage('正在连接…')
    try {
      await syncWithServiceWorker()
      handle.setMessage('')
    } catch (error: unknown) {
      console.error('[DownLord] 与 service worker 通信失败', error)
      handle.setMessage('扩展后台没有应答 —— 可到浏览器的扩展页点「重新加载」后重开本弹窗')
    }
    // 与 sw 那条路**互不依赖**:sw 没应答不代表 DownLord 不在(popup 自己有网络出口)。
    // **串行而非 Promise.all**:两条路都做 `facts = {...facts, …}` 的读改写,并发会互相盖掉。
    // 代价是多一次本地回环往返(<10ms),换来一个不会漂的装配点。
    await refreshTakeover()
  }

  async function saveAndConnect(input: { token: string; port: string }): Promise<void> {
    const result = validatePairingForm({
      token: input.token,
      port: input.port,
      hasSavedToken: facts.pairing !== undefined
    })
    // 非法 → 不存、不发请求,只说**具体哪一项**不合法
    if (!result.ok) {
      handle.setMessage(result.message)
      return
    }

    // `token` 为 null = 用户留空沿用旧的(改端口不必重新配对);此时必有旧值,兜底只为类型收敛
    const token = result.token ?? facts.pairing?.token
    if (token === undefined) {
      handle.setMessage('请粘贴 DownLord 设置页「浏览器扩展」里的配对码')
      return
    }

    const pairing = { token, port: result.port }
    await savePairing(adapter, pairing)
    facts = { ...facts, pairing }
    handle.update(buildPopupModel(facts))
    await refresh()
  }

  await refresh()
}

void main().catch((error: unknown) => {
  console.error('[DownLord] popup 渲染失败', error)
})
