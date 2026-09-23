/**
 * 链接类型识别(纯函数,spec §8.2)。
 *
 * **仅给默认建议**,yt-dlp 才是解析权威:magnet: / .torrent → torrent(BT,v0.3 Task 1);
 * 已知视频站点 → video(+友好名);流媒体清单 → video;明确「下载件」扩展名 → http;
 * 其余(普通网页 / 未知站)→ ambiguous(UI 默认建议 video)。不起子进程、不碰网络。
 */

import { SNIFF_STREAM_EXTS } from '../../shared/sniffMedia'

const STREAM_EXTS: ReadonlySet<string> = new Set(SNIFF_STREAM_EXTS)

export type LinkKind = 'video' | 'http' | 'ambiguous' | 'torrent'

/** 已知视频站点域名小表 → 友好来源名(子域名经 endsWith 匹配) */
const VIDEO_SITES: ReadonlyArray<{ domains: readonly string[]; label: string }> = [
  { domains: ['youtube.com', 'youtu.be'], label: 'YouTube' },
  { domains: ['bilibili.com', 'b23.tv'], label: '哔哩哔哩' },
  { domains: ['douyin.com'], label: '抖音' },
  { domains: ['vimeo.com'], label: 'Vimeo' },
  { domains: ['twitter.com', 'x.com'], label: 'X' }
]

/** 内置直链「下载件」扩展名基础集(非视频站时判 http;运行时再并入类别 extensions,spec §6.2) */
const DIRECT_FILE_EXTS: ReadonlySet<string> = new Set([
  'zip',
  'exe',
  'msi',
  '7z',
  'rar',
  'iso',
  'dmg',
  'pkg',
  'apk',
  'pdf',
  'mp3'
])

/** 取路径末段的小写扩展名(无扩展名 / 隐藏文件 → null) */
function extractExt(pathname: string): string | null {
  const lastSeg = pathname.split('/').filter(Boolean).pop()
  if (!lastSeg) {
    return null
  }
  const dot = lastSeg.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  return lastSeg.slice(dot + 1).toLowerCase()
}

/**
 * 据 URL 启发式判定链接类型(video / http / ambiguous)。
 *
 * @param knownFileExts 运行时类别扩展名集合,与内置 `DIRECT_FILE_EXTS` 取并集判直链(spec §6.2);
 *   不传时直链分支仅用 `DIRECT_FILE_EXTS`;流媒体清单始终优先判 video。
 */
export function classifyLink(
  url: string,
  knownFileExts?: ReadonlySet<string>
): { kind: LinkKind; siteLabel?: string } {
  // 0) 磁力链接最前置:`magnet:` 是非特殊 scheme,直接短路判 torrent,不入 `new URL`(spec §10.1)
  if (url.startsWith('magnet:')) {
    return { kind: 'torrent' }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // 非法 URL:无从判定 → ambiguous(默认建议 video)
    return { kind: 'ambiguous' }
  }

  const host = parsed.hostname.toLowerCase()

  // 1) 已知视频站点优先(高于扩展名启发式)
  for (const site of VIDEO_SITES) {
    if (site.domains.some((d) => host === d || host.endsWith('.' + d))) {
      return { kind: 'video', siteLabel: site.label }
    }
  }

  const ext = extractExt(parsed.pathname)

  // 2) `.torrent` 种子文件 → torrent(早于 DIRECT_FILE_EXTS,spec §10.1)
  if (ext === 'torrent') {
    return { kind: 'torrent' }
  }

  // 3) 流媒体清单 → video;直接消费共享真源,优先于用户类别扩展名。
  if (ext && STREAM_EXTS.has(ext)) {
    return { kind: 'video' }
  }

  // 4) 路径以已知文件扩展名结尾 → http(内置 DIRECT_FILE_EXTS ∪ 运行时类别 extensions,spec §6.2)
  if (ext && (DIRECT_FILE_EXTS.has(ext) || knownFileExts?.has(ext))) {
    return { kind: 'http' }
  }

  // 5) 其余 → ambiguous(默认建议 video,PRD §5)
  return { kind: 'ambiguous' }
}
