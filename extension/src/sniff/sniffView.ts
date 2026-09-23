/**
 * 「本页资源」区的成品视图 —— **纯函数**(v0.4 Task 5 Phase 2 · spec §2.3 / §3.2 / §3.3)。
 *
 * 分组、徽章、大小格式化、分片归属、上限与隐藏计数、四种非列表状态、每一行按钮的文案与可点性
 * **全部在这里算完**;渲染层拿到的是**可直接写进 DOM 的字符串**(既有 `PopupModel` 的契约,一字不改)。
 * 于是 `popupView.ts` 里不会出现一个业务 `if` —— 它只是「数组 → DOM」。
 *
 * ⚠️ 本文件不 log(隐私红线,见 `sniffRules.ts` 文件头),也不碰 `chrome` / DOM。
 */
import type { SniffBucket, SniffedItem } from './sniffBucket'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 大小缺失时的显示 —— **`—`,不写「未知」更不写 0**(spec §3.2:0 会被读成「空文件」) */
export const SIZE_PLACEHOLDER = '—'

/**
 * 一条资源在本次 popup 打开期间的转交结果。**只活在内存,不落任何 storage**
 * (约定 L1:能不落就不落;popup 每次打开都是全新文档,重开即回默认)。
 */
export type SniffSendState = 'sending' | 'sent' | 'failed'

/** 一行资源。`url` / `contentType` / `initiator` / `totalBytes` 是转交时要交给 DownLord 的原料 */
export interface SniffRow {
  /** 完整 URL —— **只走原生 `title` tooltip**,不在行内显示(380px 放不下,且对判断「下不下」没帮助) */
  url: string
  /** 文件名:URL `pathname` 末段;末段为空 → 显示 host。**CSS 截断,不截字符串** */
  name: string
  /** 类型徽章短标:`HLS` / `DASH` / `MP4` / …;判不出 → 用组名 */
  badge: string
  /** `84.2 MB`;`Content-Length` 缺失 → `—` */
  size: string
  /** 条目级小字。目前只有「已聚合 N 片」(**恰好 1 条清单**时才挂,见 `attachSegments`) */
  note: string
  /** 下载按钮文案:`下载` / `发送中…` / `已发送` */
  actionLabel: string
  /** 按钮是否禁用(发送中 / 已发送) */
  actionDisabled: boolean
  /** 转交失败时这一行的实话;其余情况空串 */
  error: string
  // ↓ 转交载荷(**不进 DOM**,由渲染层原样回传给装配点)
  contentType: string
  /** 页面来源,**origin 级** */
  initiator: string
  /** `Content-Length`;**`-1` = 未知**(与 `SniffAddSelected.totalBytes` 同构) */
  totalBytes: number
}

export interface SniffSection {
  title: string
  rows: SniffRow[]
  /**
   * 分组级小字。只有一种来源:**清单 ≥ 2 条时的分片计数**
   * ——「本页有 N 个分片请求属于上方清单,不单独列出」。空串 = 不渲染。
   */
  note: string
}

/** 非列表状态(四种之一);`null` = 有列表,不出现 */
export interface SniffEmptyState {
  text: string
  /** 补充小字;空串 = 不渲染 */
  small: string
  /** 要不要给「强制刷新本页」按钮 */
  canReload: boolean
}

export interface SniffSectionsView {
  /** **这次没读到桶**(无当前 tab / storage 读失败)—— 与「桶是空的」不是同一件事 */
  unavailable: boolean
  /** **空组不渲染**:这里只会出现有行的组 */
  sections: SniffSection[]
  /** 灰显、**结构上没有下载按钮**的提示行(目前只有「有分片无清单」那一条) */
  notices: string[]
  /** 底部小字:隐藏计数 / 上限提示 / 缓存边界。同一排版,不吵 */
  footnotes: string[]
  empty: SniffEmptyState | null
}

/** 与主程序 `src/renderer/src/lib/format.ts` 的 `formatBytes` **同口径、独立一份**(契约单向穿透:值不能穿透) */
function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`
  let value = n
  let index = 0
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${UNITS[index]}`
}

/** 徽章短标:先看扩展名,再看 contentType,都判不出用组名(spec §3.2 的「缺失时」列) */
const BADGE_BY_EXT: Readonly<Record<string, string>> = {
  m3u8: 'HLS',
  mpd: 'DASH',
  mp4: 'MP4',
  webm: 'WEBM',
  flv: 'FLV',
  mp3: 'MP3',
  m4a: 'M4A'
}

const BADGE_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'application/vnd.apple.mpegurl': 'HLS',
  'application/x-mpegurl': 'HLS',
  'application/dash+xml': 'DASH',
  'video/mp4': 'MP4',
  'video/webm': 'WEBM',
  'video/x-flv': 'FLV',
  'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A'
}

const GROUP_TITLE = { stream: '视频流', file: '媒体文件' } as const

function badgeOf(item: SniffedItem): string {
  const byExt = item.ext === null ? undefined : BADGE_BY_EXT[item.ext]
  return byExt ?? BADGE_BY_CONTENT_TYPE[item.contentType] ?? GROUP_TITLE[item.group]
}

/**
 * 拆出文件名的两段:末段 `last` 与它上一级目录 `parent`。
 *
 * **末段为空(如 `https://cdn.x/`)→ 用 host 当末段**;URL 解析不了(理论上进不了桶)→ 原样返回,
 * **绝不返回空串**:空行会让用户以为界面坏了。
 */
function nameParts(url: string): { last: string; parent: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { last: url, parent: '' }
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  const last = segments.pop()
  if (last === undefined || last === '') return { last: parsed.host, parent: '' }
  return { last: decodeName(last), parent: decodeName(segments.pop() ?? '') }
}

/**
 * 一次算出**本页全部条目**的显示名 —— 因为「叫什么」取决于**页内有没有重名**,逐条算不出来。
 *
 * ★ **末段在本页内重名时,补上一级目录**(2026-08-11 真机反馈):HLS 站点极常见的形态是
 *   `_1920_2.7M/prog_index.m3u8` 与 `_864_1.1M/prog_index.m3u8` —— 只显示末段的话,
 *   三条清单在列表里**长得一模一样**,用户连「哪条是哪条」都分不出,更别说挑。
 *   补的那一级恰好就是站点用来区分码率 / 音轨 / 字幕的目录名。
 *
 * ⚠️ **这不是判定,只是呈现**:不排序、不标注、不猜哪条是主清单 —— 补目录只让**本来就存在**
 *    的区别显示出来,判据是「重名」这个客观事实,不是任何关于内容的启发式。
 * ⚠️ **只补一级,不递归**:补完仍然重名(同目录、只有 query 不同)就到此为止 ——
 *    再往上补会把整条路径贴进 380px 的行里,而完整 URL 本来就在 `title` tooltip 里。
 *    如实止步,不假装能把每种情形都区分开。
 */
function resolveNames(items: readonly SniffedItem[]): Map<string, string> {
  const parts = items.map((item) => ({ url: item.url, ...nameParts(item.url) }))

  const seen = new Map<string, number>()
  for (const part of parts) seen.set(part.last, (seen.get(part.last) ?? 0) + 1)

  const names = new Map<string, string>()
  for (const part of parts) {
    const duplicated = (seen.get(part.last) ?? 0) > 1
    names.set(part.url, duplicated && part.parent !== '' ? `${part.parent}/${part.last}` : part.last)
  }
  return names
}

/** 百分号转义还原(`%E7%89%87.mp4` → `片.mp4`);还原不了就用原文,不抛 */
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 一行的按钮与错误文案。
 *
 * ★ **失败一律说实话**:超时 / 拒绝 / 看不懂的应答在装配点全部收敛成 `'failed'`,
 *   这里让按钮**恢复可点**并挂一行「没能交给 DownLord,请确认它正在运行」。
 *   **绝不假装成功** —— 那会让用户以为任务已经在下,而其实什么都没发生。
 */
function describeAction(state: SniffSendState | undefined): {
  actionLabel: string
  actionDisabled: boolean
  error: string
} {
  switch (state) {
    case 'sending':
      return { actionLabel: '发送中…', actionDisabled: true, error: '' }
    case 'sent':
      return { actionLabel: '已发送', actionDisabled: true, error: '' }
    case 'failed':
      return {
        actionLabel: '下载',
        actionDisabled: false,
        error: '没能交给 DownLord,请确认它正在运行'
      }
    default:
      return { actionLabel: '下载', actionDisabled: false, error: '' }
  }
}

function toRow(
  item: SniffedItem,
  name: string,
  sent: Readonly<Record<string, SniffSendState>>
): SniffRow {
  return {
    url: item.url,
    name,
    badge: badgeOf(item),
    size: item.sizeBytes === null ? SIZE_PLACEHOLDER : formatBytes(item.sizeBytes),
    note: '',
    ...describeAction(sent[item.url]),
    contentType: item.contentType,
    initiator: item.initiator,
    // `null`(chunked,没有 Content-Length)→ `-1` = 未知,与协议同构
    totalBytes: item.sizeBytes ?? -1
  }
}

/**
 * 分片归属 —— **不是拼接,是把分片归到它们的清单那一条上**(spec §2.3,判据**只有 tabId**)。
 *
 * 三种情形,返回值分别落在**条目级 / 分组级 / 提示行**三个不同的地方:
 *
 * | 清单条数 | 落点 | 为什么不是别的做法 |
 * |---|---|---|
 * | 恰好 1 条 | 该条下方「已聚合 N 片」 | 归属明确,这才是「聚合成一条」 |
 * | ≥ 2 条 | **分组级**一行 | ⚠️ 多条清单时**无从判断 N 片归谁,猜就是错的**;硬挂给第一条会给出一个**具体但假**的数字,那比不给更坏 |
 * | 0 条 | 一条**无下载按钮**的提示行 | ⚠️ 我们确实没有可交给 yt-dlp 的 URL,**给按钮就是承诺一件做不到的事**;而页面明明在播、popup 却空着会让用户以为嗅探坏了 |
 *
 * ★ **分组级那句的措辞 2026-08-11 据真机反馈订正**:原文是「本页另检测到 N 个分片请求
 *   (**已归入上方视频流**)」,用户读成了「有 N 个东西被折叠在上面,但我展不开」。
 *   「归入」在暗示**容器关系**,而真实关系是**归属**:这些分片属于上方某条清单,
 *   下那条清单时由 yt-dlp 自己去把全部分片拉齐 —— 它们从来就不是 popup 里可以展开的东西
 *   (桶里**根本没存分片 URL**)。改后的措辞只陈述归属与「不单独列出」这两个事实。
 *
 * ⚠️ 顺带说清一件容易误读的事:**N 是「浏览器到目前为止请求过几片」,不是视频总片数** ——
 *    用户看了 30 秒就关页面,N 就只有几片。故这个数字**不能**被用来判断资源完不完整。
 */
function attachSegments(
  streamRows: SniffRow[],
  segmentCount: number
): { groupNote: string; notice: string } {
  if (segmentCount <= 0) return { groupNote: '', notice: '' }

  if (streamRows.length === 1) {
    streamRows[0] = { ...streamRows[0], note: `已聚合 ${segmentCount} 片` }
    return { groupNote: '', notice: '' }
  }
  if (streamRows.length >= 2) {
    return {
      groupNote: `本页有 ${segmentCount} 个分片请求属于上方清单,不单独列出`,
      notice: ''
    }
  }
  return { groupNote: '', notice: '本页检测到分片流,但未找到可下载的清单文件' }
}

/**
 * 底部小字。**不静默截断**:被隐藏的、被挤掉的都如实说,与历史页 `LIMIT 500` 达上限时同一做法。
 *
 * ★ 第三行是 **R2 实测(2026-08-09)留下的有界遗留的正面补救**:缓存命中**不触发**响应头事件
 *   (关掉标签页再打开同一 URL,采到的资源从 4 条掉到 2 条),而**真实影响是「采少了」不是
 *   「一条没有」** —— 空状态那句话只在零资源时出现,用户看到 2 条时根本不知道少了 2 条。
 *   故这一行**恒定可见**(开着嗅探且读到了桶时),与另两行同排版。
 *
 * ⚠️ 措辞照 ARCHITECTURE §7.6 措辞红线:只陈述**恒为真的事实**,
 *   **不写「已覆盖」「保证抓全」**,也不承诺强制刷新之后就一定齐。
 */
function buildFootnotes(bucket: SniffBucket, sniffEnabled: boolean): string[] {
  const notes: string[] = []
  if (bucket.hiddenSmallCount > 0) {
    notes.push(`已隐藏 ${bucket.hiddenSmallCount} 个小于 1MB 的媒体请求`)
  }
  if (bucket.overflowCount > 0) notes.push('仅显示最近 50 条')
  if (sniffEnabled) {
    notes.push('只列出本页发生过、并且收到了响应头的请求;走浏览器缓存的那些不在其中,强制刷新可重新采集')
  }
  return notes
}

/**
 * 四种非列表状态(spec §3.3 · 全部是**恒为真的事实陈述**)。有资源时返回 `null`。
 *
 * - **开关关闭**:把「开了会读什么」说在前面 —— 用户是在**打开之前**决定要不要开的。
 * - **刚开、本页零资源**:本页的请求早已发生过 → 嗅不到。**由用户自己点刷新,绝不自动 reload**
 *   (他可能正在填表单,替他 reload 会丢数据)。
 * - **已开、本页零资源**:配隐私小字。**时机恰好** —— 用户刚装完扩展、还没刷新页面时第一次
 *   打开 popup 看到的正是这一态;有列表后它自动消失(popup 已过载,不加常驻行)。
 * - **有分片无清单**:不在这里,它是 `notices` 里的一条(那时列表区并非空的)。
 */
function describeEmpty(sniffEnabled: boolean, justEnabled: boolean): SniffEmptyState {
  if (!sniffEnabled) {
    return {
      text: '嗅探已关闭',
      small:
        '开启后,本扩展会读取你浏览的页面所发出的网络请求的地址与响应头,用来识别可下载的媒体资源。',
      canReload: false
    }
  }
  if (justEnabled) {
    return { text: '已开启。刷新本页后才能看到本页的媒体资源。', small: '', canReload: true }
  }
  return {
    text: '本页未检测到媒体资源',
    small: '本扩展不注入页面脚本,只读取网络请求的地址与响应头',
    canReload: true
  }
}

/**
 * 桶 → 成品视图。
 *
 * ★ **排序 = 采集顺序(`seq` 升序,即 `items` 的天然顺序),不按大小、不按关键词**
 *   (2026-08-09 真机实测,Apple HLS 示例页一次采到 6 条 m3u8,只有第一条 master playlist
 *   是用户该点的那条):
 *   - **不按 URL 关键词过滤**(如滤掉 `iframe_index` / 字幕轨)—— 脆弱启发式,单站点一次观测
 *     不足以立规则,且**漏报代价大于误报**:滤错一条用户就永远下不到它。
 *   - **不读 body 判 master** —— `#EXT-X-STREAM-INF` 只在 master 的 body 里,而观察型
 *     `webRequest` 拿不到 body;为排序好看去扩权限不划算。
 *   - **更不按大小降序** —— 那次样片里 master 恰好最大纯属**样片短**:长视频的 media playlist
 *     要逐条列出每个分片、轻易上百 KB,而 master 只列几个 variant、恒定几 KB,按大小排会把
 *     master 排到**最后**。
 *   - ✅ 用的是**弱信号**:HLS 里**不解析 master 就拿不到任何子清单的 URL**,故 master 必然
 *     先于它引用的一切被请求 —— 第一条通常就是它;页面直接给 media playlist(无 master)时,
 *     第一条也仍是该点的那条。**这是弱信号不是断言,故不加任何「这是主清单」的标注** ——
 *     我们并不知道,只是它排得靠前。
 *
 * @param bucket `undefined` = **这次没读到桶**(无当前 tab / storage 读失败),与「桶是空的」
 *   不是同一件事 —— 沿用 `PopupFacts.takeover` 那条既有约定(「没问到」≠「没暂停」)。
 * @param sent 本次 popup 打开期间各条的转交结果(key = 完整 URL)
 */
export function buildSniffSections(
  bucket: SniffBucket | undefined,
  sniffEnabled: boolean,
  justEnabled: boolean,
  sent: Readonly<Record<string, SniffSendState>> = {}
): SniffSectionsView {
  if (!bucket) {
    return {
      unavailable: true,
      sections: [],
      notices: [],
      footnotes: [],
      // 「读不到」不是「没有」:不许拿空状态那套「本页未检测到媒体资源」去盖住一次读取失败
      empty: { text: '无法读取本页资源', small: '', canReload: false }
    }
  }

  // 「叫什么」取决于**本页有没有重名**,故先一次算完全部条目的显示名
  const names = resolveNames(bucket.items)
  const nameOf = (item: SniffedItem): string => names.get(item.url) ?? item.url

  const streamRows = bucket.items
    .filter((i) => i.group === 'stream')
    .map((i) => toRow(i, nameOf(i), sent))
  const fileRows = bucket.items
    .filter((i) => i.group === 'file')
    .map((i) => toRow(i, nameOf(i), sent))
  const { groupNote, notice } = attachSegments(streamRows, bucket.segmentCount)

  // **空组不渲染** —— 不显示「视频流(0)」这种噪音
  const sections: SniffSection[] = []
  if (streamRows.length > 0) {
    sections.push({ title: GROUP_TITLE.stream, rows: streamRows, note: groupNote })
  }
  if (fileRows.length > 0) {
    sections.push({ title: GROUP_TITLE.file, rows: fileRows, note: '' })
  }

  const notices = notice === '' ? [] : [notice]
  const hasAnything = sections.length > 0 || notices.length > 0

  return {
    unavailable: false,
    sections,
    notices,
    footnotes: buildFootnotes(bucket, sniffEnabled),
    empty: hasAnything ? null : describeEmpty(sniffEnabled, justEnabled)
  }
}
