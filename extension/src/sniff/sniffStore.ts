/**
 * 嗅探桶的读写 —— **副作用层**(v0.4 Task 5 · spec §2.5 / §2.6)。
 *
 * 桶按标签页分:一个 tab 一条 `storage.session` 记录,互不干扰、清理只删一个键。
 *
 * ★ **为什么是 `storage.session`**(spec §2.5,开工前置实测 R1 已验证可用):
 *   - **不存 sw 内存** —— MV3 的 sw 空闲即被销毁,会出现「开着视频页等一分钟,popup 却是空的」;
 *   - **不存 `storage.local`** —— 那会落盘,违反「嗅探结果关浏览器即清」(CONTEXT.md「嗅探」条)。
 *   浏览器关闭时的全清**不需要我们写代码**,由 `storage.session` 自身语义保证 —— 这正是选它的理由。
 *
 * ★ **写入串行化**(与 `src/main/takeover/takeoverService.ts` 的 `lastWrite` 同构):
 *   `onHeadersReceived` 是高频事件,「读桶 → 改桶 → 写桶」并发跑必然互相覆盖。
 *   **不引入锁、不引入定时批量刷** —— 后者在 sw 被销毁时会把攒着没写的那批整个丢掉。
 *
 * ⚠️ 本文件**不 log**(隐私红线,见 `sniffRules.ts` 文件头)。写失败照常抛给调用方,
 *    由 sw 那侧记一条**不含 URL** 的错误。
 */
import type { BrowserAdapter, SniffedResponse } from '../adapter/browserAdapter'
import { acceptIntoBucket, emptyBucket, type SniffBucket } from './sniffBucket'
import {
  classifySniffedResource,
  normalizeContentType,
  parseContentLength,
  readHeader
} from './sniffRules'

/** 桶键前缀。清空全部桶 = 删掉所有以它打头的键 */
export const SNIFF_KEY_PREFIX = 'sniff:'

export function bucketKey(tabId: number): string {
  return `${SNIFF_KEY_PREFIX}${tabId}`
}

/** 模块级串行链。**不是**跨事件状态(那种要落 storage,约定 L1),只是一条本次存活期内的写队列 */
let lastWrite: Promise<unknown> = Promise.resolve()

/**
 * 排进串行链。
 *
 * 链本身**吞掉失败**(否则一次写失败会让此后所有写都被拒绝),但**照常把失败抛给调用方** ——
 * 「不打断队列」与「不吞掉错误」是两件事,这里两件都要。
 */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = lastWrite.then(work)
  lastWrite = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 等串行链跑空(测试断言落盘内容用;**不用于事件路径**) */
export function flushSniffWrites(): Promise<void> {
  return lastWrite.then(() => undefined)
}

export async function readBucket(
  adapter: BrowserAdapter,
  tabId: number
): Promise<SniffBucket | undefined> {
  return adapter.session.get<SniffBucket>(bucketKey(tabId))
}

/**
 * 收纳一条响应头事件。
 *
 * ★ **判定在排队之前做**:绝大多数请求(HTML / JS / 图片)判出来是 `ignore`,
 *   它们连队列都不进 —— 高频事件上这一步省掉的是成千上万次无谓的异步排队。
 */
export function recordSniffedResponse(
  adapter: BrowserAdapter,
  details: SniffedResponse
): Promise<void> {
  const contentType = normalizeContentType(readHeader(details.responseHeaders, 'Content-Type'))
  const contentLength = parseContentLength(readHeader(details.responseHeaders, 'Content-Length'))
  const outcome = classifySniffedResource({ url: details.url, contentType, contentLength })
  if (outcome.kind === 'ignore') return Promise.resolve()

  return enqueue(async () => {
    const key = bucketKey(details.tabId)
    const current = (await adapter.session.get<SniffBucket>(key)) ?? emptyBucket()
    const next = acceptIntoBucket(current, outcome, details.url, contentType, details.initiator)
    // 无变化不写盘(`acceptIntoBucket` 无变化时返回原引用)
    if (next === current) return
    await adapter.session.set(key, next)
  })
}

/** 标签页关闭 → 清该桶(三个清理点之一) */
export function removeBucket(adapter: BrowserAdapter, tabId: number): Promise<void> {
  return enqueue(() => adapter.session.remove(bucketKey(tabId)))
}

/**
 * 清空**全部**桶(三个清理点之一:用户关闭嗅探开关)。
 *
 * @returns 清掉了几个标签页的桶 —— 交给调用方记日志用(**只有计数,没有 URL**)
 */
export function clearAllBuckets(adapter: BrowserAdapter): Promise<number> {
  return enqueue(async () => {
    const keys = (await adapter.session.keys()).filter((key) => key.startsWith(SNIFF_KEY_PREFIX))
    for (const key of keys) await adapter.session.remove(key)
    return keys.length
  })
}
