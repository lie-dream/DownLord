import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import { BinaryName, resolveBundledPath, userWritableYtDlpPath } from './locator'

/**
 * yt-dlp 可写副本机制(spec §3.3 / ARCHITECTURE §7.5)。
 *
 * 首次运行把内置 yt-dlp 拷入用户可写区 `%APPDATA%/DownLord/bin/`——这是后续「脱离安装
 * 目录的独立热更新」的架构地基:yt-dlp 不能只读于安装目录。aria2c / ffmpeg **不进可写区**,
 * 始终从内置读取。
 *
 * 幂等策略:可写副本**存在且有效**(大小达标)才跳过;若副本是**占位 / 损坏**
 * (如 Task 1 脚手架期的 12 字节 "placeholder",或拷贝中断),则用内置**重拷覆盖**——
 * 否则 `resolveYtDlpPath` 优先返回坏副本,`spawn` 时报 `spawn UNKNOWN`,视频功能全挂
 * (2026-07-01 真引擎手测暴露的真 bug:占位副本 `existsSync` 为真被永久 skip)。
 *
 * 本 Task 只建机制:不查 GitHub releases、不比对版本、不下载替换、不定时检查(热更新留 TODO #7)。
 */

/**
 * 有效 yt-dlp.exe 的最小合理大小(字节)。真实 yt-dlp.exe ~18MB;Task 1 占位为 12 字节
 * 文本、拷贝中断 / 损坏亦远小于此。副本存在但小于此值 → 判定无效(占位 / 损坏)→ 内置重拷。
 *
 * **不以「等于内置大小」判定**:yt-dlp 可脱离应用独立热更新(§7.5),副本可能是与内置
 * 不同版本的真实 exe(大小不同但有效);故仅以「远小于任何真实 exe」的绝对下限拦截
 * 占位 / 损坏,避免误伤用户热更新的版本。
 */
export const MIN_VALID_YTDLP_BYTES = 1_000_000

/** 文件系统探针(默认绑定真实 `fs`;单测可注入以避免碰真实磁盘) */
export interface WritableFs {
  existsSync(path: string): boolean
  statSync(path: string): { size: number }
  mkdirSync(path: string, options: { recursive: true }): void
  copyFileSync(src: string, dest: string): void
}

const defaultFs: WritableFs = {
  existsSync,
  statSync: (path) => statSync(path),
  mkdirSync: (path, options) => {
    mkdirSync(path, options)
  },
  copyFileSync
}

/** `ensureWritableYtDlp` 入参 */
export interface EnsureWritableYtDlpInput {
  /** 内置二进制根目录(`resolveBinDir` 结果) */
  binDir: string
  /** 用户可写数据目录(`app.getPath('userData')`) */
  userDataDir: string
  /** 文件系统探针(默认真实 `fs`) */
  fs?: WritableFs
}

/** `ensureWritableYtDlp` 结果(结构化,供调用方写日志) */
export interface EnsureWritableResult {
  /** 内置源路径 */
  source: string
  /** 可写副本目标路径 */
  target: string
  /**
   * 本次动作:
   * - `skipped`:可写副本已存在且**有效**(大小 ≥ `MIN_VALID_YTDLP_BYTES`),未改动;
   * - `copied`:可写区无副本,已从内置拷贝;
   * - `replaced`:可写副本存在但**无效**(占位 / 损坏,大小 < 阈值),已用内置覆盖重拷;
   * - `source-missing`:无有效副本且内置 yt-dlp 也不存在,无法拷贝(不崩,仅记录)。
   */
  action: 'skipped' | 'copied' | 'replaced' | 'source-missing'
}

/**
 * 确保 yt-dlp 在用户可写区有一份**有效**副本(幂等)。
 * - 副本有效(≥ 阈值)→ 跳过(尊重可能的热更新版本);
 * - 副本无效(占位 / 损坏)且内置存在 → 覆盖重拷(`replaced`);
 * - 无副本且内置存在 → 拷贝(`copied`);
 * - 无有效副本且内置源缺失 → 返回 `source-missing` 而非抛错,保证启动不被拖垮(spec §3.4)。
 */
export function ensureWritableYtDlp({
  binDir,
  userDataDir,
  fs = defaultFs
}: EnsureWritableYtDlpInput): EnsureWritableResult {
  const source = resolveBundledPath(binDir, BinaryName.YtDlp)
  const target = userWritableYtDlpPath(userDataDir)

  const targetExists = fs.existsSync(target)
  if (targetExists && fs.statSync(target).size >= MIN_VALID_YTDLP_BYTES) {
    // 已有**有效**副本(可能是用户热更新的版本)→ 保留不动。
    return { source, target, action: 'skipped' }
  }
  if (!fs.existsSync(source)) {
    // 无有效副本、内置源又缺失:不崩,仅记录(坏副本保留,待源就位后下次替换)。
    return { source, target, action: 'source-missing' }
  }
  fs.mkdirSync(dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  // 副本原先存在(占位 / 损坏)→ replaced;原先不存在 → 首次 copied。
  return { source, target, action: targetExists ? 'replaced' : 'copied' }
}
