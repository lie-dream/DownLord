/**
 * yt-dlp `-J` 信息树 → ResolveResult(纯函数,防御式;spec §2.3)。
 *
 * 含 `entries`(或 `_type==='playlist'`)→ ResolvedPlaylist(只列条目,§7.1);
 * 否则单视频 → ResolvedVideo(formats 映射,`filesize ?? filesize_approx`)。
 * **防御**:字段缺失 / 类型异常一律返回结构化空值 / null,不抛不崩(站点改版常见),
 * 由调用方(VideoResolver)据「formats 为空」给可读提示(§2.4)。
 */
import type {
  ResolveResult,
  ResolvedFormat,
  ResolvedPlaylist,
  ResolvedPlaylistEntry,
  ResolvedVideo
} from '../../shared/ipc'
import { parseSubtitleTracks } from './ytdlpSubtitle'

/** yt-dlp 已解析的 -J 对象 → 结构化解析结果(已 JSON.parse,JSON.parse 失败归 VideoResolver) */
export function parseYtDlpInfoJson(json: unknown): ResolveResult {
  const obj = isRecord(json) ? json : {}

  if (obj._type === 'playlist' || Array.isArray(obj.entries)) {
    return toPlaylist(obj)
  }
  return toVideo(obj)
}

function toPlaylist(obj: Record<string, unknown>): ResolvedPlaylist {
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : []
  const entries: ResolvedPlaylistEntry[] = rawEntries.filter(isRecord).map((e) => ({
    id: asString(e.id) ?? '',
    title: asString(e.title) ?? asString(e.id) ?? '', // 标题缺失回退 id
    url: asString(e.webpage_url) ?? asString(e.url) ?? '', // --flat-playlist 下条目页地址
    durationSec: asNumberOrNull(e.duration)
  }))

  return {
    kind: 'playlist',
    title: asString(obj.title) ?? '',
    entries
  }
}

function toVideo(obj: Record<string, unknown>): ResolvedVideo {
  const rawFormats = Array.isArray(obj.formats) ? obj.formats : []
  const formats: ResolvedFormat[] = rawFormats.filter(isRecord).map(toFormat)

  return {
    kind: 'video',
    id: asString(obj.id) ?? '',
    title: asString(obj.title) ?? '',
    durationSec: asNumberOrNull(obj.duration),
    thumbnail: asString(obj.thumbnail) ?? null,
    extractor: asString(obj.extractor) ?? asString(obj.extractor_key) ?? '',
    webpageUrl: asString(obj.webpage_url) ?? asString(obj.original_url) ?? '',
    formats,
    // 回填可用字幕语言清单(v0.2 Task 1 · spec §3.1);无字幕字段 → 空数组兜底,零回归
    subtitles: parseSubtitleTracks(obj)
  }
}

function toFormat(f: Record<string, unknown>): ResolvedFormat {
  return {
    formatId: asString(f.format_id) ?? '',
    ext: asString(f.ext) ?? '',
    height: asNumberOrNull(f.height),
    fps: asNumberOrNull(f.fps),
    vcodec: asString(f.vcodec) ?? null,
    acodec: asString(f.acodec) ?? null,
    filesize: asNumberOrNull(f.filesize) ?? asNumberOrNull(f.filesize_approx),
    tbr: asNumberOrNull(f.tbr),
    formatNote: asString(f.format_note) ?? null,
    // 传输协议(v0.3 Task 4 · #24 · spec §2):判定 HLS/DASH 分片是否挂 aria2c;缺字段 → null(保守挂)
    protocol: asString(f.protocol) ?? null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
