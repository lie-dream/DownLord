/**
 * 格式列表整理(纯函数,spec §6.3)。
 *
 * 把 yt-dlp 解析出的几十条 `ResolvedFormat`(含纯音频 / 纯视频 / muxed / 多码率)整理为
 * 格式选择对话框可直接渲染的展示行:剔纯音频、按清晰度降序、同清晰度去重(muxed 优先)、
 * 大小估算 / 未知、含音频 vs 需合音轨标注。**仅做视图整理,不含解析 / 下载逻辑。**
 */

import type { ResolvedFormat, ResolvedVideo } from '../../../shared/ipc'
import { formatBytes } from './format'

/** 格式选择对话框单行(原型 #ov-format 的 .fmt) */
export interface FormatRow {
  formatId: string
  /** 清晰度标签:'1080P 60' / '720P'(由 height + fps) */
  resLabel: string
  /** 编码 / 容器 / 音频标注:'MP4 · H.264 · 含音频' / '… · 需合音轨' */
  infoLabel: string
  /** 大小:'~ 480.0 MB'(filesize / tbr 估算)/ '未知' */
  sizeLabel: string
  /** 排序 / 显示辅助(纯音频已剔,通常非 null) */
  height: number | null
}

/** 视频编码 → 友好名(取常见族;未知截首段) */
const VCODEC_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(avc1|avc3|h264)/i, 'H.264'],
  [/^(hev1|hvc1|h265)/i, 'H.265'],
  [/^vp0?9/i, 'VP9'],
  [/^vp0?8/i, 'VP8'],
  [/^av0?1/i, 'AV1']
]

function vcodecLabel(vcodec: string | null): string | null {
  if (!vcodec || vcodec === 'none') return null
  for (const [re, label] of VCODEC_LABELS) {
    if (re.test(vcodec)) return label
  }
  return vcodec.split('.')[0]
}

/** muxed(自带音轨)直接可用;纯视频需 +bestaudio 合并(spec §3.3) */
function hasAudio(f: ResolvedFormat): boolean {
  return f.acodec != null && f.acodec !== 'none'
}

function resLabel(f: ResolvedFormat): string {
  if (f.height == null) return f.formatNote ?? '未知'
  const base = `${f.height}P`
  return f.fps != null && f.fps > 30 ? `${base} ${Math.round(f.fps)}` : base
}

function infoLabel(f: ResolvedFormat): string {
  const parts: string[] = [f.ext.toUpperCase()]
  const vc = vcodecLabel(f.vcodec)
  if (vc) parts.push(vc)
  parts.push(hasAudio(f) ? '含音频' : '需合音轨')
  return parts.join(' · ')
}

/** filesize ?? (tbr × duration 估算);均缺 → null(显示「未知」) */
function estimateSize(f: ResolvedFormat, durationSec: number | null): number | null {
  if (f.filesize != null) return f.filesize
  if (f.tbr != null && durationSec != null) return ((f.tbr * 1000) / 8) * durationSec
  return null
}

function sizeLabel(size: number | null): string {
  return size == null ? '未知' : `~ ${formatBytes(size)}`
}

/** 同清晰度下哪条更适合保留:muxed 优先 → 体积可估优先 → 码率高优先 */
function preferOver(candidate: ResolvedFormat, current: ResolvedFormat): boolean {
  const ca = hasAudio(candidate)
  const cur = hasAudio(current)
  if (ca !== cur) return ca
  const cf = candidate.filesize != null
  const curf = current.filesize != null
  if (cf !== curf) return cf
  return (candidate.tbr ?? 0) > (current.tbr ?? 0)
}

/** ResolvedVideo → 格式选择展示行(spec §6.3) */
export function buildFormatRows(v: ResolvedVideo): FormatRow[] {
  // 1) 剔纯音频(音频走「仅音频」开关,不进格式单选)
  const videoFormats = v.formats.filter((f) => f.vcodec !== 'none')

  // 2) 同清晰度去重,保留代表(muxed 优先)
  const byRes = new Map<string, ResolvedFormat>()
  for (const f of videoFormats) {
    const key = resLabel(f)
    const cur = byRes.get(key)
    if (!cur || preferOver(f, cur)) byRes.set(key, f)
  }

  // 3) 按 height 降序、同 height 按 fps 降序
  const reps = [...byRes.values()].sort((a, b) => {
    const h = (b.height ?? -1) - (a.height ?? -1)
    if (h !== 0) return h
    return (b.fps ?? 0) - (a.fps ?? 0)
  })

  return reps.map((f) => ({
    formatId: f.formatId,
    resLabel: resLabel(f),
    infoLabel: infoLabel(f),
    sizeLabel: sizeLabel(estimateSize(f, v.durationSec)),
    height: f.height
  }))
}

/** yt-dlp extractor key → 友好来源名(未知原样返回) */
const EXTRACTOR_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['youtube', 'YouTube'],
  ['bilibili', '哔哩哔哩'],
  ['douyin', '抖音'],
  ['vimeo', 'Vimeo'],
  ['twitter', 'X'],
  ['x', 'X']
]

export function extractorLabel(extractor: string): string {
  // yt-dlp extractor 形如 'youtube' / 'youtube:tab' / 'BiliBili';取冒号前小写匹配
  const key = extractor.split(':')[0].toLowerCase()
  for (const [k, label] of EXTRACTOR_LABELS) {
    if (key === k) return label
  }
  return extractor
}
