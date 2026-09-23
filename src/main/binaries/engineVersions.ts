/**
 * 内置引擎内核版本(「关于」分组**回退值**,spec §3.2 / §4.4)。
 *
 * Task 9:真实 `--version` 探测(`probeVersion.ts`)启动后台跑一次并缓存为「关于」分组数据源;
 * **本常量降级为探测前 / 探测失败的回退值**(诚实不崩),已按实际内置二进制以 `--version` 校正:
 * aria2 1.37.0 / yt-dlp 2026.07.04 / ffmpeg 8.1.2(`resources/bin/README.md` 版本列同源对齐)。
 *
 * ffmpeg 采用最新 stable 8.1.2(而非 spec 设计时预估的 7.x):最新 release 已含 CVE-2025 系列
 * 安全修复,出包安全性优先。
 */
import type { EngineVersions } from '../../shared/ipc'

export const ENGINE_VERSIONS: EngineVersions = {
  aria2: '1.37.0',
  ytdlp: '2026.07.04',
  ffmpeg: '8.1.2'
}
