/**
 * MediaTool（MVP 退化，spec §5.1 / ARCHITECTURE §4）。
 *
 * 合并音视频 / 音频提取转 MP3 **全交 yt-dlp 内部调 ffmpeg**(下载参数 `--merge-output-format` /
 * `-x --audio-format mp3`,§3.2);DownLord 不自己拼 ffmpeg 命令、不自己起 ffmpeg 进程。
 * 故 MediaTool **退化为「确保 ffmpeg 可被 yt-dlp 找到」**:只返回内置 ffmpeg 绝对路径,供
 * VideoEngine 注入 `--ffmpeg-location`。
 *
 * ffmpeg **不进用户可写区**(无需独立热更新,locator 已如此设计);路径取 Task 1 的
 * `resolveBundledPath(binDir, BinaryName.Ffmpeg)`,binDir 由主进程装配注入(可测、不碰 app)。
 */
import { resolveBundledPath, BinaryName } from '../binaries/locator'

export interface MediaToolDeps {
  /** 内置二进制根目录(`resolveBinDir` 结果) */
  binDir: string
}

export interface MediaTool {
  /** 内置 ffmpeg 绝对路径,供 yt-dlp `--ffmpeg-location`(不自起 ffmpeg) */
  resolveFfmpegLocation(): string
}

/** 创建退化的 MediaTool:只定位内置 ffmpeg,不自调 */
export function createMediaTool(deps: MediaToolDeps): MediaTool {
  return {
    resolveFfmpegLocation(): string {
      return resolveBundledPath(deps.binDir, BinaryName.Ffmpeg)
    }
  }
}
