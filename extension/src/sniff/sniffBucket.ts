/**
 * 嗅探桶的收纳规则 —— **纯函数**(v0.4 Task 5 · spec §2.4 / §2.5)。
 *
 * 去重、上限淘汰、三个计数器、`sizeBytes` 补齐**全在 `acceptIntoBucket` 一个函数里**,
 * 输入输出都是普通对象、零 mock —— 这是本 Phase 最值得单测的一处。
 *
 * ⚠️ 本文件不 log(见 `sniffRules.ts` 文件头的隐私红线)。
 */
import type { SniffGroup, SniffOutcome } from './sniffRules'

/** 每个标签页最多留多少条。超出时**只挤 `file`**,`stream` 永不被挤掉(理由见 `evictOverflow`) */
export const MAX_ITEMS_PER_TAB = 50

export interface SniffedItem {
  /** **完整 URL,一个字符都不剥** —— 它同时是去重键(理由见 `findSameUrl`) */
  url: string
  /** 已归一(去 charset、小写)的 Content-Type;没有则空串 */
  contentType: string
  /**
   * 发起该请求的页面来源,**origin 级**;没有则空串。
   *
   * ★ 用户点「下载」时它作为 `SniffAddSelected.referrer` 上报(防盗链站点靠它过关)。
   *   **只能在采集时存**:popup 里点下载那一刻,`webRequest` 的 details 早已不存在,
   *   而适配层刻意读不到 tab 的 `url` —— 不在这里留,就等于永远拿不到 referrer。
   * ⚠️ 取值形态本身就是隐私边界:origin 级不含路径与 query(ARCHITECTURE §7.6),
   *   且随桶一起活在会话存储、关浏览器即清、全程不 log。
   */
  initiator: string
  ext: string | null
  group: SniffGroup
  /** `null` = 响应没给 `Content-Length`(chunked);后续同 URL 命中时可被补齐 */
  sizeBytes: number | null
  /** 首次出现的顺序号。**同键再次命中时不变** —— 列表顺序不该在用户眼皮底下跳动 */
  seq: number
}

export interface SniffBucket {
  /** 单调序号发号器(**不用时钟**:sw 里没有稳定的时间基准,序号只需单调) */
  seq: number
  /** 见过多少条分片(spec §2.3:**不存分片本身的 URL**,既是隐私也确实用不上) */
  segmentCount: number
  /** 被 1MB 门槛滤掉的条数 —— 要**显式告知**,不静默吞掉 */
  hiddenSmallCount: number
  /** 超过上限被丢弃的条数 —— 同样显式告知,不静默截断 */
  overflowCount: number
  items: SniffedItem[]
}

export function emptyBucket(): SniffBucket {
  return { seq: 0, segmentCount: 0, hiddenSmallCount: 0, overflowCount: 0, items: [] }
}

/**
 * 去重键 = **完整 URL 字符串,一个字符都不剥**。
 *
 * ⚠️ **为什么不剥 query**(会被反复挑战的决定,理由写死):剥掉 query 会把
 * `/play?id=1&q=1080` 与 `/play?id=1&q=720` 合并成一条 —— 那是**把两条真实不同的资源合并**,
 * 用户从此下不到另一个清晰度。而不剥的代价只是「签名 URL 在页面重新加载后可能多出一条」。
 * **合并真资源的损失 > 多一条冗余的损失。**
 *
 * 顺带:同 URL 的多个 Range 响应天然落到同一个键上 → 一条。
 */
function findSameUrl(items: readonly SniffedItem[], url: string): number {
  return items.findIndex((item) => item.url === url)
}

/**
 * 超限淘汰:**丢最旧的 `file`,`stream` 永不被挤掉**。
 *
 * 理由:`stream` 是嗅探的核心价值(用户自己粘不到那条 URL),而 `file` 在分片站点上可能几十条。
 * 极端情形 —— 满桶全是 `stream` 时**谁都不挤**,让新来的那条(末尾)落空:
 * 挤掉一条已在列的 stream 去换一条新的,并不比拒收更好,而「stream 永不被挤掉」这句话必须恒真。
 */
function evictOverflow(items: SniffedItem[]): { items: SniffedItem[]; overflowed: boolean } {
  if (items.length <= MAX_ITEMS_PER_TAB) return { items, overflowed: false }

  const oldestFile = items.findIndex((item) => item.group === 'file')
  const victim = oldestFile >= 0 ? oldestFile : items.length - 1
  return { items: items.filter((_, index) => index !== victim), overflowed: true }
}

/**
 * 把一次判定结果收进桶里,返回**新桶**。
 *
 * ★ **无变化时返回原引用**(`next === bucket`)—— 调用方据此跳过写盘。
 *   `onHeadersReceived` 是高频事件,「没变也写一遍」会把 `storage.session` 的写配额白白烧掉。
 *
 * @param contentType 已归一(去 charset、小写)的 Content-Type
 * @param initiator 发起该请求的页面来源(**origin 级**);缺省空串。
 *   **同键再次命中时不覆盖首次那份** —— 与 `seq` 同规矩:同一条资源的来源不该在用户眼皮底下换。
 */
export function acceptIntoBucket(
  bucket: SniffBucket,
  outcome: SniffOutcome,
  url: string,
  contentType: string,
  initiator: string = ''
): SniffBucket {
  switch (outcome.kind) {
    case 'ignore':
      return bucket

    case 'segment':
      // 只计数。**不存分片 URL** —— 存了既没用处,又平白攒出一份浏览记录
      return { ...bucket, segmentCount: bucket.segmentCount + 1 }

    case 'too-small':
      return { ...bucket, hiddenSmallCount: bucket.hiddenSmallCount + 1 }

    case 'stream':
    case 'file':
      break
  }

  const existing = findSameUrl(bucket.items, url)
  if (existing >= 0) {
    const item = bucket.items[existing]
    // 同键再次命中:**不新增条目**。只在原值为 null 且新值有效时补齐 sizeBytes ——
    // 首次可能是 chunked 无长度、后续 Range 响应才带得出大小。**已有值不覆盖**,`seq` 不变。
    if (item.sizeBytes !== null || outcome.sizeBytes === null) return bucket

    const items = [...bucket.items]
    items[existing] = { ...item, sizeBytes: outcome.sizeBytes }
    return { ...bucket, items }
  }

  const seq = bucket.seq + 1
  const appended: SniffedItem = {
    url,
    contentType,
    initiator,
    ext: outcome.ext,
    group: outcome.kind,
    sizeBytes: outcome.sizeBytes,
    seq
  }
  const { items, overflowed } = evictOverflow([...bucket.items, appended])

  return {
    ...bucket,
    seq,
    items,
    overflowCount: overflowed ? bucket.overflowCount + 1 : bucket.overflowCount
  }
}
