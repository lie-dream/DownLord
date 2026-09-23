/**
 * 下载接管的编排(注入 `BrowserAdapter`,v0.4 Task 4 · spec §2.3 / §2.4)。
 *
 * 判定全在 `intent.ts` 的纯函数里,本文件只做带副作用的四件事:
 * 粗筛 → 读配对 → 发请求 → **(只有拿到 `taken:true` 时)取消原生下载**。
 *
 * **两条约定在这里最容易破,逐条钉住**:
 * - **L5**:`readPairing` 随时可能是空(刚装上 / 用户清过数据),未配对就什么都不做 ——
 *   不试探、不用默认 token 打一枪(与握手同规矩)。
 * - **L1**:接管路径**不写任何 storage** —— 它是无状态的一次性请求,`pairing` 只读不写。
 */
import type { BrowserAdapter, CreatedDownload } from '../adapter/browserAdapter'
import { readPairing } from '../channel/handshakeClient'
import {
  buildIntent,
  buildIntentRequest,
  isLiveDownload,
  isTakenResponse,
  shouldReportIntent
} from './intent'

/**
 * 处理一次 `downloads.onCreated`。
 *
 * 时序是「**先受理后取消**」(CONTEXT.md「黑洞」红线的正面形态):DownLord 表示收下
 * 并从此全权负责,扩展才取消原生下载。**不等任务真建成** —— 人类确认耗时不可知,
 * 而浏览器一直在写盘,且 MV3 sw 约 30 秒空闲销毁(sw 一死,`await` 的 Promise
 * 连同 `cancel()` 一起蒸发,浏览器继续下完而 DownLord 也建了任务 = 双份下载)。
 *
 * @param nowMs - 本机时钟(默认 `Date.now()`;测试注入定值)。**只用于粗筛历史重放**。
 */
export async function handleDownloadCreated(
  adapter: BrowserAdapter,
  item: CreatedDownload,
  nowMs: number = Date.now()
): Promise<void> {
  if (!shouldReportIntent(item.url)) return // 粗筛①:不适用的 scheme,连问都不问
  if (!isLiveDownload(item, nowMs)) return // 粗筛②:浏览器启动时重放的历史记录,同样连问都不问

  const pairing = await readPairing(adapter)
  if (!pairing) return // 未配对(约定 L5:任何一次唤醒都可能读到空)

  let taken = false
  try {
    const response = await adapter.net.postJson(
      buildIntentRequest(pairing, buildIntent(item, adapter.runtime.getUserAgent()))
    )
    taken = isTakenResponse(response.status, response.text) // ← 纯函数,唯一的真值判定
  } catch {
    taken = false // 超时 / ECONNREFUSED / 中止
  }

  // ★ 全文唯一的 cancel 点。**没拿到 `taken:true` 就不 cancel** ——
  //   下面这六种情况在这里是**同一行代码,一个分支都没有**:
  //     ① 暂停中  ② 规则不接管  ③ DownLord 未运行
  //     ④ 通道不通  ⑤ token 失效  ⑥ 协议版本不一致
  //   多一个分支就意味着扩展侧在做决策(§7.2 要求决策全留主进程);
  //   把兜底改成 `taken = true` 会让「通道不通时不取消」当场变红(X-05 + RP-4)。
  if (!taken) return

  await adapter.downloads.cancel(item.id)

  // ★ 2026-08-04 真机取证后补的一步(`docs/TODO.md` #52)。Step 0 实测⑤ 说「下载项自然消失、
  //   不需要 erase」,真机推翻:cancel 成功的那条记录**一律残留**在浏览器下载列表里
  //   (`interrupted` / `USER_CANCELED`,5 组延迟组合 5/5 全中)。用户看到的是「接管成功了,
  //   但浏览器里还留着一条『已取消』」—— 纯观感,却每次接管都发生。
  //
  //   ⚠️ **它绝不是「撤回受理」的补救**:cancel 若打在一个**已下完**的项目上是静默无效的
  //   (`lastError` 为 null、`state` 仍是 `complete`、文件已落在浏览器下载目录),此时
  //   `eraseCanceled` 的 `state: 'interrupted'` 条件会让它**什么都不做** —— 这是刻意的:
  //   那条 `complete` 记录是「浏览器那边也有一份」的唯一线索,抹掉它等于替用户隐藏事实
  //   (erase 只删记录、删不掉文件)。那一半是**另一个问题**,不在这里解决。
  //
  //   放在 cancel 之后 `await`:cancel 的回调返回时 state 已是终态(实测 G,三组 immediately
  //   全是终态),故不需要任何等待或轮询。
  await adapter.downloads.eraseCanceled(item.id)
}
