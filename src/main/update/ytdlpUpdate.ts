/**
 * yt-dlp 独立热更新纯函数(v0.2 Task 6 · spec §2.1 / §2.3;ARCHITECTURE §7.2 / §7.5)。
 *
 * 全部**输入非法返回 null / false,不抛**(诚实回退,不因解析失败拖垮检查链路);无 I/O、无副作用,
 * 可脱离网络 / FS 单测。编排层(`ytdlpUpdater.ts`)组合这些函数完成「比对 → 选资产 → 校验」。
 *
 * 版本形如 `YYYY.MM.DD`(nightly 带第四段 `.N`);比对按点分数字段逐段数值比较(缺段补 0),
 * **非法格式判不可比**(返回 null)→ 调用方按「无更新」诚实处理(绝不误判为可升级)。
 */
import { createHash as nodeCreateHash } from 'crypto'

/** GitHub Releases API:yt-dlp 最新正式版(需 User-Agent 头;未认证限流 60 req/h,§2.1 / §2.5 节流) */
export const YTDLP_LATEST_RELEASE_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'

/** 目标资产名(Windows 单 exe) */
export const YTDLP_ASSET_NAME = 'yt-dlp.exe'

/** SHA256 校验清单资产名(权威完整性来源,§2.3) */
export const SHA256SUMS_ASSET_NAME = 'SHA2-256SUMS'

/**
 * 把版本串解析为点分数字段数组;任一段非纯数字 / 空串 → null(不可比)。
 * `2026.06.09` → `[2026,6,9]`;`2026.06.09.1` → `[2026,6,9,1]`;`nightly` / `` → null。
 */
function parseVersionSegments(v: string): number[] | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.length === 0) return null
  const parts = trimmed.split('.')
  const segments: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    segments.push(Number(part))
  }
  return segments
}

/**
 * 版本比对(spec §2.1):`-1` a<b / `0` 相等 / `1` a>b;任一非法格式 → `null`(不可比)。
 * 逐段数值比较,缺段补 0(`2026.06.09` 与 `2026.06.09.0` 相等)。
 */
export function compareYtDlpVersion(a: string, b: string): -1 | 0 | 1 | null {
  const sa = parseVersionSegments(a)
  const sb = parseVersionSegments(b)
  if (sa === null || sb === null) return null
  const len = Math.max(sa.length, sb.length)
  for (let i = 0; i < len; i++) {
    const na = sa[i] ?? 0
    const nb = sb[i] ?? 0
    if (na < nb) return -1
    if (na > nb) return 1
  }
  return 0
}

/**
 * 是否需要更新(spec §2.1):`current < latest` 且两者均可解析。
 * 不可比(非法格式)→ `false`(诚实,不误判为可升级)。
 */
export function needsYtDlpUpdate(current: string, latest: string): boolean {
  return compareYtDlpVersion(current, latest) === -1
}

/** releases 资产(选中项供下载) */
export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

/** 解析后的 release(tag + 资产列表) */
export interface ParsedRelease {
  tag: string
  assets: ReleaseAsset[]
}

/**
 * 解析 GitHub Releases API 的 latest JSON(spec §2.1):
 * 取 `tag_name` 与 `assets[]`(每项 `name` / `browser_download_url` / `size`)。
 * 结构非法(非对象 / 缺 tag / assets 非数组)→ null(诚实回退,不抛)。
 * 单个资产字段异型则跳过该项(容错),不整体失败。
 */
export function parseLatestRelease(json: unknown): ParsedRelease | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (typeof o.tag_name !== 'string' || o.tag_name.length === 0) return null
  if (!Array.isArray(o.assets)) return null

  const assets: ReleaseAsset[] = []
  for (const raw of o.assets) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (typeof a.name !== 'string') continue
    if (typeof a.browser_download_url !== 'string') continue
    const size = typeof a.size === 'number' ? a.size : 0
    assets.push({ name: a.name, url: a.browser_download_url, size })
  }
  return { tag: o.tag_name, assets }
}

/** 按名选资产(§2.2:`yt-dlp.exe`);缺失 → null。 */
export function selectAsset(assets: ReleaseAsset[], name: string): ReleaseAsset | null {
  return assets.find((a) => a.name === name) ?? null
}

/** 选 SHA256 校验清单资产(§2.3:`SHA2-256SUMS`);缺失 → null。 */
export function selectSumsAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return selectAsset(assets, SHA256SUMS_ASSET_NAME)
}

/**
 * 从 `SHA2-256SUMS` 文本取指定文件名的 hash(spec §2.3)。
 * 每行格式 `<hash>␠␠<filename>`(GitHub 双空格;兼容单空格 / `*` 二进制标记)。
 * 取 `filename` 精确匹配行的 64 位十六进制 hash(小写返回);无匹配 / 格式非法 → null。
 */
export function parseSha256Sums(text: string, filename: string): string | null {
  if (typeof text !== 'string' || typeof filename !== 'string') return null
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (!m) continue
    if (m[2].trim() === filename) return m[1].toLowerCase()
  }
  return null
}

/**
 * 计算 buffer 的 SHA256(十六进制小写);`createHash` 可注入(默认 node `crypto`,单测可注入已知实现)。
 * 用于下载完成后与 `SHA2-256SUMS` 比对(§2.3 完整性校验)。
 */
export function computeSha256(
  data: Buffer,
  createHash: typeof nodeCreateHash = nodeCreateHash
): string {
  return createHash('sha256').update(data).digest('hex')
}
