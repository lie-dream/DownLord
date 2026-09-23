/**
 * service worker 入口(v0.4 Task 2 立骨架 · Task 3 接本地通道 · Task 4 接下载接管 · Task 5 接网页嗅探)。
 *
 * **结构上就是顶层若干 `on*()` 同步注册调用**(约定 L2)—— 不写异步初始化、不把监听器放进 `await`
 * 之后或任何条件分支里。否则 sw 被唤醒时监听器还没注册,唤醒它的那个事件就被丢掉了。
 *
 * 前三条唤醒路径**都顺带握手一次**(spec §5.4 的事件驱动握手,**无定期心跳、不加 `alarms`**):
 * 安装 / 更新、浏览器启动、popup 打开发来的消息。未配对时 `runHandshake` 什么都不做。
 * 第四条(Task 4 新增)是 `downloads.onCreated` —— 它走接管路径,不额外握手
 * (`download.intent` 本身就会刷新 DownLord 侧的 `lastActiveAt`)。
 * 第五、六条(Task 5 新增)是 `webRequest.onHeadersReceived` 与 `tabs.onRemoved` ——
 * **两条都不握手、不发任何网络请求**:嗅探结果**从不离开浏览器**,只有用户点了某一条才上报那一条。
 */
import { createDefaultAdapter } from '../adapter/chromeAdapter'
import type { SniffedResponse } from '../adapter/browserAdapter'
import { BUILD_ID } from '../buildId'
import { runHandshake } from '../channel/handshakeClient'
import { handleDownloadCreated } from '../downloads/takeoverClient'
import { recordSniffedResponse, removeBucket } from '../sniff/sniffStore'
import { readSniffEnabled, watchSniffEnabled } from '../sniff/sniffSwitch'
import { recordWake, type WakeEvent } from './lifecycle'
import { isSwSyncRequest, type SwSyncReply } from './swMessage'

const adapter = createDefaultAdapter()

/** 一次唤醒该做的全部事:记账 + 握手。**全程 `await`**,不半途丢状态。 */
async function wakeAndHandshake(event: WakeEvent): Promise<SwSyncReply> {
  const wake = await recordWake(adapter, event)
  const handshake = await runHandshake(adapter)
  return { handled: true, buildId: BUILD_ID, wake, handshake }
}

/**
 * 约定 L4 的现实边界,**如实记录结论**(spec §5.4.3,不再是「待 Task 3 评估」):
 *
 * - **已兑现的那条**:下面 `onMessage` 的适配实现 `return true`,浏览器会等我们把异步工作做完
 *   再考虑回收 sw —— L4 在**消息这条路径**上首次真兑现。
 * - **不能修的那条**:浏览器原生的 `runtime.onInstalled` / `onStartup` 监听器**返回值被忽略**,
 *   MV3 也**没给这两个事件 `waitUntil`**。这是浏览器 API 形态决定的,不是我们的实现缺陷。
 *   本函数做到的两条(内部全程 `await` + 失败显式打日志不静默)就是这条路径上的上限。
 *   实际风险低:`storage.set` 是极短操作。
 *
 * (本行措辞刻意不带命名空间前缀 —— `grep -rn "\bchrome\." extension/src/` **只准命中适配实现那一个文件**,
 *  注释若写成带前缀的形态,这条判据就再也分不清「代码在用」与「注释在说」。)
 */
function handleWake(event: WakeEvent): void {
  void wakeAndHandshake(event).catch((error: unknown) => {
    console.error('[DownLord] sw 唤醒处理失败', error)
  })
}

adapter.runtime.onInstalled(handleWake)
adapter.runtime.onStartup((): void => handleWake('startup'))

/**
 * popup 打开 / 点「保存并连接」时发来的消息:记一次唤醒 + 立刻握手,**把结果当应答回给 popup**
 * (于是 popup 不必再去读 storage 猜最新值)。
 *
 * 认不出的消息如实回 `handled:false` —— 不假装处理过。
 */
adapter.runtime.onMessage(async (message: unknown): Promise<SwSyncReply> => {
  if (!isSwSyncRequest(message)) return { handled: false, buildId: BUILD_ID }
  return wakeAndHandshake('message')
})

/**
 * 用户在浏览器里点了下载(v0.4 Task 4)—— **第四条唤醒路径**。
 *
 * 与上面三条 `on*()` **并列写在顶层**(约定 L2):不进 `await` 之后、不进条件分支。
 * 否则 sw 被唤醒时监听器还没注册,**唤醒它的那个事件就被丢掉了**。
 *
 * 与 `handleWake` 同一形态:浏览器**忽略 `onCreated` 监听器的返回值、也没给 `waitUntil`**,
 * 故这条路径上约定 L4 的上限就是「内部全程 `await` + 失败显式打日志不静默」。
 * 兜底还有一层:整条链路的网络段超时上限只有 `TAKEOVER_TIMEOUT_MS = 1000ms`。
 */
adapter.downloads.onCreated((item): void => {
  void handleDownloadCreated(adapter, item).catch((error: unknown) => {
    console.error('[DownLord] 下载接管处理失败', error)
  })
})

// ── 网页嗅探(v0.4 Task 5)——第五、六条唤醒路径 ────────────────────────────

/**
 * 嗅探开关的 **sw 模块级缓存**(实现约束②)。
 *
 * ⚠️ **不是每条请求都去读 `storage`** —— `onHeadersReceived` 在一个视频页上一分钟能有上千条,
 *    逐条去读会制造大量异步排队。缓存由下面的冷启动读取 + `storage.onChanged` 订阅各刷一次。
 *
 * ⚠️ **初值是 `false`,即实现约束③「缓存未就绪按关处理」** —— 保守方向是
 *    「宁可漏嗅,不可在用户没开时监听」。这一行的初值就是那条约束本身,不需要额外的 ready 标志。
 */
let sniffEnabled = false

/**
 * 一条响应头事件的处理。
 *
 * ⚠️ 失败只记**不含 URL 的一句话**(隐私红线):嗅探事件量极大,把 URL 写进 DevTools
 *    等于攒一份完整浏览记录,用户截图求助时当场泄露。要看完整 URL,浏览器 Network 面板本来就有。
 */
function handleSniffedResponse(details: SniffedResponse): void {
  void recordSniffedResponse(adapter, details).catch((error: unknown) => {
    console.error('[DownLord] 嗅探结果写入失败', error)
  })
}

/**
 * ★ **唯一一个嗅探监听器**(spec §2.1):`contentType` 与 `Content-Length` **只有响应头阶段才有**,
 *   而两者一个用于判定、一个用于 1MB 门槛与大小显示。再注册一个 `onBeforeRequest` 只会让同一资源
 *   两次入列、徒增去重麻烦 —— 这是唯一解,不是取舍。
 *
 * 四条实现约束,逐条对应到下面的代码:
 *   ① **无条件注册在顶层**(约定 L2)—— 与上面四条 `on*()` 并列,不进 `await` 之后、不进条件分支。
 *      注册与否**不能依赖异步读来的开关值**:sw 被唤醒时监听器还没注册的话,
 *      **唤醒它的那个事件就被丢掉了**。开关关闭改在**回调第一行**早退。
 *   ② 开关值读模块级缓存(见 `sniffEnabled`),不是每条请求去读 storage。
 *   ③ 缓存未就绪按「关」处理(`sniffEnabled` 初值 `false`)。
 *   ④ **只处理 `details.tabId >= 0`** —— `-1` 是扩展自身 / 后台请求(含 DownLord 本地通道那些
 *      打到 `127.0.0.1` 的),既无从归属也不该被看。**这同时是「不看自己」的机器保障**。
 *
 * `{ urls: ['<all_urls>'] }` 写在**调用点**而不是藏进适配层:它是本 Task 唯一的表外权限增长
 * (`host_permissions` 从回环扩到全站),该在这里一眼看见。作为对冲,**开关默认关**。
 */
adapter.webRequest.onHeadersReceived(
  (details: SniffedResponse): void => {
    if (!sniffEnabled) return // ①②③
    if (details.tabId < 0) return // ④
    handleSniffedResponse(details)
  },
  { urls: ['<all_urls>'] }
)

/** 标签页关闭 → 清该桶(spec §2.5 的三个清理点之一;另两个是浏览器关闭与用户关开关) */
adapter.tabs.onRemoved((tabId: number): void => {
  void removeBucket(adapter, tabId).catch((error: unknown) => {
    console.error('[DownLord] 嗅探桶清理失败', error)
  })
})

/**
 * 开关缓存的两个刷新源:变更订阅 + 本次冷启动读一次。
 *
 * 订阅**同样注册在顶层**(约定 L2)。冷启动那次读是异步的,在它回来之前 `sniffEnabled`
 * 保持 `false` —— 这段窗口里漏掉几条请求,好过在用户没开时就开始看。
 */
watchSniffEnabled(adapter, (enabled: boolean): void => {
  sniffEnabled = enabled
})

void readSniffEnabled(adapter).then(
  (enabled: boolean): void => {
    sniffEnabled = enabled
  },
  (error: unknown): void => {
    console.error('[DownLord] 嗅探开关读取失败(本次按关闭处理)', error)
  }
)
