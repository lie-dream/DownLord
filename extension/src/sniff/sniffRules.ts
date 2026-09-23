/**
 * 嗅探判定 —— **纯函数,零 I/O、零 `chrome`**(v0.4 Task 5 · spec §2.2)。
 *
 * 三个导出各自可单测:`normalizeContentType`(U-01)/ `extractPathExt`(U-07)/
 * `classifySniffedResource`(U-02~U-06)。副作用全在 `sniffStore.ts` 与 `sniffSwitch.ts`。
 *
 * ⚠️ **本文件(以及整个 `sniff/` 目录)一条 URL 都不 log** —— 嗅探事件量极大,把一条 URL 写进
 *    浏览器控制台就是在 DevTools 里攒一份完整浏览记录,用户截图求助时当场泄露。
 *    而且**我们根本不需要自己记**:要看完整 URL,浏览器 Network 面板本来就有,
 *    重复造一份只增加泄露面。判据是 `grep -rn "console\." extension/src/sniff/` 恰好 0~2 条
 *    (故这段话刻意不写出那个调用的字面形态 —— 写了,判据就再也分不清「代码在用」与「注释在说」)。
 */
import {
  MEDIA_EXTS,
  SEGMENT_CONTENT_TYPES,
  SEGMENT_EXTS,
  STREAM_CONTENT_TYPES,
  STREAM_EXTS
} from './mediaExts'

/** 直链媒体的大小门槛:小于它的当作播放器碎片 / 探测请求,不进列表(只计数) */
export const MIN_FILE_BYTES = 1024 * 1024

/** 进列表的两组。`stream` → 主进程判 `video`(yt-dlp);`file` → 判 `http`(aria2) */
export type SniffGroup = 'stream' | 'file'

/**
 * 一次响应头的判定结果。
 *
 * `segment` / `too-small` **只带 kind** —— 它们不进列表,故连 URL 都不必往下传
 * (少一个能把 URL 带进桶里的通路,就少一条能泄露浏览记录的路径)。
 */
export type SniffOutcome =
  | { kind: 'segment' }
  | { kind: 'stream'; ext: string | null; sizeBytes: number | null }
  | { kind: 'file'; ext: string | null; sizeBytes: number | null }
  | { kind: 'too-small' }
  | { kind: 'ignore' }

export interface SniffInput {
  url: string
  /** **已归一**的 Content-Type(调用方先过 `normalizeContentType`);没有则空串 */
  contentType: string
  /** `null` = 响应没给 `Content-Length`(chunked) */
  contentLength: number | null
}

/**
 * Content-Type 归一:去掉 `; charset=…` 之类的参数、去空白、转小写。
 *
 * 缺失(`null` / `undefined` / 空串)→ 返回空串 —— 判定里用「空串命不中任何清单」表达「不知道」,
 * 不引入第二个「没有」的取值。
 */
export function normalizeContentType(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw.split(';')[0].trim().toLowerCase()
}

/**
 * 响应头取值 —— **头名大小写不敏感**(HTTP 头名本就大小写不敏感,按大小写取会漏)。
 *
 * 同名多条时取第一条:`Content-Type` / `Content-Length` 按 RFC 都不该重复,重复了也只能挑一个,
 * 挑第一个至少是确定的。
 */
export function readHeader(
  headers: readonly { name: string; value?: string }[],
  name: string
): string | undefined {
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (header.name.toLowerCase() === wanted) return header.value
  }
  return undefined
}

/** `Content-Length` 解析:非数字 / 负数 / 缺失一律 `null`(= 未知,按 spec §2.2 第 4 步放行) */
export function parseContentLength(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

/** URL 解析失败返回 `null` —— 与「解析成功但没有扩展名」共用同一个取值,故判定里另行区分 */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function extFromPathname(pathname: string): string | null {
  const lastSeg = pathname.split('/').filter(Boolean).pop()
  if (!lastSeg) return null
  const dot = lastSeg.lastIndexOf('.')
  if (dot <= 0) return null
  return lastSeg.slice(dot + 1).toLowerCase()
}

/**
 * 取 URL 末段的扩展名(小写),没有则 `null`。
 *
 * ⚠️ **先取 `pathname` 再取末段** —— 嗅探到的 URL 常带 query(`…/index.m3u8?token=abc`),
 *    直接对整串取「最后一个点之后」会拿到 `m3u8?token=abc`。
 *
 * 与主进程 `linkClassify.ts` 的 `extractExt` **同构但独立一份**:扩展侧不能值导入主仓
 * (「契约单向穿透」),故这里是一份刻意的手写实现,不是遗漏的复用。
 */
export function extractPathExt(url: string): string | null {
  const parsed = parseUrl(url)
  if (!parsed) return null
  return extFromPathname(parsed.pathname)
}

/** tuple 常量传进来会收窄成字面量联合,统一用 `readonly string[]` 接,免得每处都写断言 */
function includes(list: readonly string[], value: string | null): boolean {
  return value !== null && list.includes(value)
}

/**
 * 五步判定 —— **顺序不可换**,每一步的理由都写在旁边(spec §2.2)。
 *
 * ⚠️ 判据一律是 **OR 不是 AND**:`/play?id=123` + `application/vnd.apple.mpegurl` 靠 contentType
 *    命中,`x.webm` + `application/octet-stream` 靠扩展名命中。AND 会把**无扩展名的流媒体清单**
 *    整类排除掉,而那正是嗅探唯一不可替代的价值。误报代价只是「多列一条可以不点」,漏报才是真损失。
 */
export function classifySniffedResource(input: SniffInput): SniffOutcome {
  const { contentType, contentLength } = input

  // URL 解析不了 → 连交给下载引擎都做不到,不进列表也不计数
  const parsed = parseUrl(input.url)
  if (!parsed) return { kind: 'ignore' }
  const ext = extFromPathname(parsed.pathname)

  // 1) 分片:`video/mp2t` 就是 HLS 的 `.ts`。放行会让每个分片各成一条直链涌进列表,
  //    正面违反 CONTEXT.md「嗅探」条(分片流聚合成一条,不逐片罗列)。只计数,不入列。
  if (includes(SEGMENT_CONTENT_TYPES, contentType) || includes(SEGMENT_EXTS, ext)) {
    return { kind: 'segment' }
  }

  // 2) 流媒体清单。⚠️ **第 4 步的门槛绝不上移到这一步之前** —— m3u8 / mpd 清单本身只有几 KB,
  //    设门槛会把**最该抓的那一条**滤掉。
  if (includes(STREAM_CONTENT_TYPES, contentType) || includes(STREAM_EXTS, ext)) {
    return { kind: 'stream', ext, sizeBytes: contentLength }
  }

  // 3) 直链媒体:contentType 前缀命中 **或** 扩展名命中(OR,理由见函数头)
  const looksMedia =
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    includes(MEDIA_EXTS, ext)
  if (!looksMedia) return { kind: 'ignore' } // 5) 其余

  // 4) 门槛**只对直链**。chunked 无 `Content-Length` 时**放行** —— 与 OR 的取向一致:
  //    宁可多列一条可以不点的,不可把真资源判没。
  if (contentLength === null || contentLength >= MIN_FILE_BYTES) {
    return { kind: 'file', ext, sizeBytes: contentLength }
  }
  return { kind: 'too-small' }
}
