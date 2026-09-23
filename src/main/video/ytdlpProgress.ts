/**
 * yt-dlp stdout 行解析(纯函数,spec §3.4)。
 *
 * 配合 `--newline` + `--progress-template`,把逐行 stdout 归类为三种事件:
 * - 进度(`dlp:downloading|...`)→ progress(归一字节 / 速度,total||estimate||0);
 * - 后处理(`[Merger]`/`[ExtractAudio]`/`[VideoConvertor]`/`Deleting original file`)→ postprocess;
 * - 终路径(`--print after_move:filepath` 的裸绝对路径行)→ destination;
 * - 其余噪声行 → null。
 * VideoEngine(Phase 2)据此发归一 `DownloadProgress`,对上层透明。
 */

export type YtdlpEvent =
  | {
      type: 'progress'
      downloadedBytes: number
      totalBytes: number
      speed: number
      /**
       * 该流下载完成(`dlp:finished` 帧)。DASH 多流(视频流+音频流)逐流下载,每流字节从 0
       * 计——VideoEngine 据此把完成流的 total 累进 streamBase,对外进度单调不回跳
       * (真机 2026-07-09:切流 / 暂停恢复时进度条从 ~95% 跳回 0%,被用户感知为「从头下载」)。
       */
      streamDone?: true
    }
  | { type: 'postprocess' }
  | { type: 'destination'; filepath: string }

const PROGRESS_PREFIX = 'dlp:'
/** 后处理阶段标签(行首):合并 / 音频提取 / 容器转换 / 修复 / 元数据 */
const RE_POSTPROCESS_TAG = /^\[(Merger|ExtractAudio|VideoConvertor|Fixup\w*|Metadata)\]/
const RE_DELETING_ORIGINAL = /Deleting original file/
/** 绝对路径(after_move 裸路径行):Windows 盘符 / UNC / POSIX 绝对 */
const RE_ABS_PATH = /^([A-Za-z]:[\\/]|\\\\|\/)/
/**
 * aria2c 外部下载器 readout 行(挂 `--downloader aria2c` 时,v0.2 Task 2):
 * `[#gid 15MiB/28MiB(52%) CN:16 DL:18MiB ETA:5m58s]`(`\r` 重绘;ETA 段完成前才有)。
 * 此期间 yt-dlp 的 `--progress-template` **不输出**(进度由 aria2c 打印)→ 不解析则 UI 全程 0%
 * 直到瞬间完成(真机 2026-07-09 验收实证),故把 readout 行归一为 progress 事件。
 */
const RE_ARIA2C_READOUT =
  /^\[#[0-9a-fA-F]+ ([\d.]+)(B|KiB|MiB|GiB|TiB)\/([\d.]+)(B|KiB|MiB|GiB|TiB)\([\d.-]*%?\)(?:.*? DL:([\d.]+)(B|KiB|MiB|GiB|TiB))?/
/**
 * yt-dlp「同名完整文件已存在 → 跳过下载」行(v0.2 Task 3 · spec §5.2 兜底):
 * `[download] <path> has already been downloaded`。跳过时**不发** `dlp:downloading` 进度帧、
 * 不触发 after_move → 旧链路完成大小回退 0(0B 假完成根因链 §1.2)。把该行抽出的已存在文件路径
 * 归一为 `destination` 事件(等价 after_move 的路径捕获)→ VideoEngine `close` 据此 statSize 校正
 * 真实大小 / 真实路径。该行**仅在跳过时出现**,正常下载零回归。
 */
const RE_ALREADY_DOWNLOADED = /^\[download\]\s+(.+?)\s+has already been downloaded$/
const BINARY_UNIT: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4
}

export function parseYtDlpLine(line: string): YtdlpEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') {
    return null
  }

  // 1) 进度行(--progress-template:dlp:<status>|<done>|<total>|<estimate>|<speed>)
  //    downloading:实时进度;finished:该流下载完(downloaded 常为 NA→用 total 兜底、speed 归 0),
  //    据此更新最终大小,修「同名跳过 / 完成显示 0B」(2026-07-01 手测)。
  if (trimmed.startsWith(PROGRESS_PREFIX)) {
    const parts = trimmed.slice(PROGRESS_PREFIX.length).split('|')
    const status = parts[0]
    if (status !== 'downloading' && status !== 'finished') {
      return null // 其余状态由进程退出码驱动完成,不在此出进度
    }
    const downloadedBytes = toNumber(parts[1])
    const total = toNumber(parts[2])
    const estimate = toNumber(parts[3])
    const speed = toNumber(parts[4])
    if (status === 'finished') {
      // 该流完成:downloaded 常为 NA → 用 total 兜底、speed 归 0;带 streamDone 供多流聚合
      return {
        type: 'progress',
        downloadedBytes: downloadedBytes || total,
        totalBytes: total || estimate || 0,
        speed: 0,
        streamDone: true
      }
    }
    return {
      type: 'progress',
      downloadedBytes,
      totalBytes: total || estimate || 0,
      speed
    }
  }

  // 2) aria2c readout(挂外部下载器期间进度的唯一来源)→ 归一 progress
  const readout = RE_ARIA2C_READOUT.exec(trimmed)
  if (readout) {
    return {
      type: 'progress',
      downloadedBytes: toBytes(readout[1], readout[2]),
      totalBytes: toBytes(readout[3], readout[4]),
      speed: readout[5] !== undefined ? toBytes(readout[5], readout[6]) : 0
    }
  }

  // 3) 后处理(合并 / 音频提取 / 容器转换 / 删除原始分片)
  if (RE_POSTPROCESS_TAG.test(trimmed) || RE_DELETING_ORIGINAL.test(trimmed)) {
    return { type: 'postprocess' }
  }

  // 3.5) 同名完整文件已存在 → yt-dlp 跳过下载(v0.2 Task 3 · spec §5.2 兜底):抽出该已存在
  //      文件路径作 destination(等价 after_move),供 close 时 statSize 校正真实大小 / 路径,
  //      消解「completed 0B + 错位 savePath」。该行只在跳过时出现,正常下载不打印 → 零回归。
  const already = RE_ALREADY_DOWNLOADED.exec(trimmed)
  if (already) {
    return { type: 'destination', filepath: already[1] }
  }

  // 4) 终路径(`--print after_move:%(filepath)j` 的 JSON 字符串行):全 ASCII \u 转义,
  //    对任何子进程 stdout 编码无歧义(中文路径防 mojibake,2026-07-09);JSON.parse 还原。
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string' && RE_ABS_PATH.test(parsed)) {
        return { type: 'destination', filepath: parsed }
      }
    } catch {
      // 非法 JSON → 落回噪声
    }
  }

  // 5) 终路径(裸绝对路径行):兼容旧格式 / 非模板来源
  if (RE_ABS_PATH.test(trimmed)) {
    return { type: 'destination', filepath: trimmed }
  }

  // 6) 噪声行(站点提取 / [download] 百分比 / 告警等)
  return null
}

/** aria2 readout 的「数值 + 二进制单位」→ 字节数(向下取整) */
function toBytes(value: string, unit: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.floor(n * (BINARY_UNIT[unit] ?? 1))
}

/** yt-dlp 数字字段:'NA' / 'N/A' / 空 / 非数 → 0(归一,§3.4) */
function toNumber(value: string | undefined): number {
  if (value === undefined) {
    return 0
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
