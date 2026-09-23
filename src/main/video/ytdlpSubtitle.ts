/**
 * 字幕解析 + 参数纯函数(v0.2 Task 1 · spec §3.1 / §3.2 / §6.1)。
 *
 * 仿 `ytdlpJson.ts`(防御式解析)/ `ytdlpArgs.ts`(只组装参数)范式:不碰 fs / 网络 / 子进程。
 * - `parseSubtitleTracks`:yt-dlp `-J` 的 `subtitles`(人工)+ `automatic_captions`(自动)→ 合并语言清单;
 * - `toYtdlpSubtitleArgs`:字幕选择 → 下载命令追加段(空 langs 零附加,零回归);
 * - `normalizeSubtitle`:langs 去空 / 去重 / trim(设置持久化前归一,spec §4.4)。
 */
import type { SubtitleChoice, SubtitleTrack } from '../../shared/ipc'

/**
 * yt-dlp `-J` 信息树 → 可用字幕轨清单(纯函数,防御式,spec §3.1)。
 *
 * 结构:`subtitles` / `automatic_captions` 均为 `{ "<lang>": [ {ext,url,name}, … ], … }`。
 * 先收 `subtitles`(auto=false),再收 `automatic_captions`(auto=true);同 lang 人工 + 自动两条都保留。
 * 字段缺失 / 类型异常一律跳过,不抛不崩(站点改版常见),无字幕 → 空数组。
 */
export function parseSubtitleTracks(json: unknown): SubtitleTrack[] {
  const obj = isRecord(json) ? json : {}
  const tracks: SubtitleTrack[] = []
  collectTracks(obj.subtitles, false, tracks)
  collectTracks(obj.automatic_captions, true, tracks)
  return tracks
}

/** 收集单个字幕字段(`{ lang: entries[] }`)到 out;防御:非 record / 非数组条目跳过。 */
function collectTracks(field: unknown, auto: boolean, out: SubtitleTrack[]): void {
  if (!isRecord(field)) return
  for (const lang of Object.keys(field)) {
    const entries = field[lang]
    if (!Array.isArray(entries)) continue // 防御:非「lang → 数组」结构跳过
    out.push({ lang, name: firstName(entries), auto })
  }
}

/** 取该语言首个带可读名(string)的条目 name,缺失 → null。 */
function firstName(entries: unknown[]): string | null {
  for (const e of entries) {
    if (isRecord(e) && typeof e.name === 'string') return e.name
  }
  return null
}

/**
 * 字幕选择 → yt-dlp 下载命令追加段(纯函数,spec §3.2)。
 * - `undefined` / 空 `langs` → `[]`(不追加任何字幕参数,与 v0.1 逐字节等价,零回归);
 * - 否则:`--write-subs` [+ `--write-auto-subs`] `--sub-langs <逗号>` `--sub-format <fmt>/best` `--convert-subs <fmt>`。
 *
 * 字幕是**附属产物**,不改主视频 formatSelector;`--convert-subs` 借下载命令已提供的内置 ffmpeg。
 */
export function toYtdlpSubtitleArgs(sel?: SubtitleChoice): string[] {
  if (!sel || sel.langs.length === 0) return []

  const args = ['--write-subs']
  if (sel.includeAuto) args.push('--write-auto-subs')
  args.push('--sub-langs', sel.langs.join(','))
  args.push('--sub-format', `${sel.format}/best`) // 拿不到目标格式退 best
  args.push('--convert-subs', sel.format) // 统一转 srt / vtt(内置 ffmpeg)
  return args
}

/**
 * 归一字幕选择(纯函数,设置持久化前用,spec §4.4):langs 逐项 trim → 去空 → 去重(保序);
 * format / includeAuto 原样保留(合法性由 `validateSettings.isSubtitleChoice` 守卫)。
 */
export function normalizeSubtitle(sel: SubtitleChoice): SubtitleChoice {
  const seen = new Set<string>()
  const langs: string[] = []
  const raw = Array.isArray(sel.langs) ? sel.langs : []
  for (const lang of raw) {
    if (typeof lang !== 'string') continue
    const t = lang.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    langs.push(t)
  }
  return { ...sel, langs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
