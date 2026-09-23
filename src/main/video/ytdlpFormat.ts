/**
 * 格式选择 → yt-dlp `-f` 选择器(纯函数,spec §3.3)。
 *
 * 把「muxed 直接可用」「video-only 需合音轨」「批量清晰度上限」「仅音频」四类统一推导为
 * `VideoSubmit`(formatSelector + audioOnly + mergeFormat),用户无需理解 yt-dlp 格式语义。
 * 区分 muxed / video-only 依据 `format.acodec`(spec §3.3「若该 format 已含音频」),
 * 故单视频 formatId 路径需传入对应 `ResolvedFormat`;批量(heightCap)无具体 format。
 */
import type { FormatChoice, ResolvedFormat, VideoSubmit } from '../../shared/ipc'

/**
 * 格式选择 → VideoSubmit(选择器逻辑见 `resolveSelector`),并透传字幕选择(v0.2 Task 1 · spec §4.3)。
 * 有 `choice.subtitles` 才带 `subtitles` 键;无则不加键 → 与既有 VideoSubmit 逐字节等价(零回归)。
 */
export function buildFormatSelector(choice: FormatChoice, format?: ResolvedFormat): VideoSubmit {
  const submit = resolveSelector(choice, format)
  return choice.subtitles ? { ...submit, subtitles: choice.subtitles } : submit
}

/** 四类选择 → formatSelector + audioOnly + mergeFormat(选择器逻辑,v0.1 原样,不含字幕)。 */
function resolveSelector(choice: FormatChoice, format?: ResolvedFormat): VideoSubmit {
  // 1) 仅音频:bestaudio,后处理由 -x --audio-format mp3 转码(不合并容器)
  if (choice.audioOnly) {
    return { formatSelector: 'bestaudio/best', audioOnly: true }
  }

  // 2) 单视频指定 formatId
  if (choice.formatId !== undefined) {
    const id = choice.formatId
    // 纯视频(无音轨)→ 合 bestaudio 并合并 mp4(回退单流);muxed(自带音轨)→ 直用,免合并
    if (format && format.acodec === 'none') {
      return { formatSelector: `${id}+bestaudio/${id}`, audioOnly: false, mergeFormat: 'mp4' }
    }
    return { formatSelector: id, audioOnly: false }
  }

  // 3) 批量清晰度策略(无具体 formatId,按高度上限)→ video+audio 合并 mp4
  if (choice.heightCap !== undefined) {
    const h = choice.heightCap
    return {
      formatSelector: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
      audioOnly: false,
      mergeFormat: 'mp4'
    }
  }

  // 4) 兜底(无 formatId / heightCap 且非 audioOnly):best
  return { formatSelector: 'best', audioOnly: false }
}
