/**
 * 剪贴板链接识别 / 去重纯函数(v0.2 Task 4 · spec §4)。
 *
 * 零副作用、零 I/O、不起子进程、不碰网络:复用 `classifyLink` 的启发式识别能力,
 * 只增「整段即 URL」归一 + 「明确可下载才提示」过滤 + 「变化 / 已提示 / 已在列表」去重决策。
 * 决策 100% 纯,供 `ClipboardWatcher` 服务消费(Set 管理 / 副作用在服务侧,两者分层测试,§3.3)。
 */
import type { ClipboardLink } from '../../shared/ipc'
import { classifyLink } from '../video/linkClassify'

/** URL 最大长度护栏(trim 后超此长度直接判非链接;不处理巨型剪贴板内容,兼顾隐私与性能,§3.2 / §4.1) */
const MAX_URL_LEN = 2048

/**
 * 文本归一(spec §4.1):`trim` 后整段须为**单个 http(s) URL token**。
 * - 空 / 纯空白 → null;
 * - 含任意内部空白(空格 / 制表 / 换行,即多 token / 散文夹 URL)→ null(**不从散文抓取**,隐私 + 克制);
 * - 超 `maxLen`(默认 2048)→ null(超长护栏);
 * - 非 `http(s)://` 起头(file:// / 自定义协议 / 纯文本)→ null;
 * - 否则返回归一后的 URL(交 `classifyLink` 的 `new URL()` 做真实解析)。
 */
export function normalizeClipboardText(text: string, maxLen = MAX_URL_LEN): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > maxLen) return null
  // 整段须为单个 token:内部含任意空白 → 非单 URL,不抓取
  if (/\s/.test(trimmed)) return null
  // 仅 http(s),其余协议 / 纯文本一律不识别
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

/**
 * 归一 + 复用 `classifyLink` 判「明确可下载」(spec §4.2)。
 * 仅 `video`(已知视频站)/ `http`(路径扩展名命中 `DIRECT_FILE_EXTS ∪ knownFileExts`)返回 `{ url, kind }`;
 * `ambiguous`(普通网页 / 未知站)/ 非 URL → null(**不弹**,克制取向)。
 *
 * @param knownFileExts 运行时类别扩展名并集(加固直链判定;缺省仅内置扩展名)。
 * @param maxLen 归一长度护栏(默认 2048;`decideClipboard` 透传自身 `maxLen`)。
 */
export function classifyClipboardText(
  text: string,
  knownFileExts?: ReadonlySet<string>,
  maxLen = MAX_URL_LEN
): ClipboardLink | null {
  const url = normalizeClipboardText(text, maxLen)
  if (url === null) return null
  const { kind } = classifyLink(url, knownFileExts)
  return kind === 'video' || kind === 'http' ? { url, kind } : null
}

/** 单次剪贴板决策产物(spec §4.3) */
export interface ClipboardDecision {
  /** text !== lastText(变化门) */
  changed: boolean
  /** 新的、可提示的链接(否则 null) */
  link: ClipboardLink | null
}

/**
 * 单一纯决策函数(spec §4.3);便于全分支单测,`tick()` 只做「读 → 调此 → 按结果改 Set / 调 onDetected」。
 *
 * 判定链:
 * 1. `text === lastText` → `{ changed:false, link:null }`(无变化,零识别开销);
 * 2. 变化但非可下载(ambiguous / 非 URL / 超长)→ `{ changed:true, link:null }`;
 * 3. 已提示(`promptedUrls`)或已在任务列表(`trackedUrls`)→ `{ changed:true, link:null }`;
 * 4. 否则 → `{ changed:true, link:{ url, kind } }`。
 *
 * 去重口径统一为**归一后的 URL**(`link.url`),与服务侧 `promptedUrls` 存值一致。
 */
export function decideClipboard(input: {
  text: string
  lastText: string
  promptedUrls: ReadonlySet<string>
  trackedUrls?: ReadonlySet<string>
  knownFileExts?: ReadonlySet<string>
  maxLen?: number
}): ClipboardDecision {
  const { text, lastText, promptedUrls, trackedUrls, knownFileExts, maxLen } = input
  if (text === lastText) return { changed: false, link: null }

  const link = classifyClipboardText(text, knownFileExts, maxLen)
  if (link === null) return { changed: true, link: null }
  if (promptedUrls.has(link.url) || trackedUrls?.has(link.url)) {
    return { changed: true, link: null }
  }
  return { changed: true, link }
}
