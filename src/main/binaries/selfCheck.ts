import { BinaryName, resolveBundledPath } from './locator'

/**
 * 启动期二进制存在性自检(spec §3.4)。
 *
 * 仅检查路径是否存在 —— 不做哈希 / 签名 / 版本校验(完整校验留 Task 9)。
 * 纯函数 + 注入式:经注入的 `existsSync` 探针判断,不直接碰 FS,便于单测;
 * **缺失不抛错**,只在结果里标 `ok:false`,由调用方写日志(不弹业务级错误 UI)。
 */

/** 待检的单个二进制探针项 */
export interface BinaryProbe {
  /** 引擎名(展示用) */
  name: string
  /** 解析出的待检绝对路径 */
  path: string
}

/** 单个二进制的自检结果(结构化) */
export interface BinaryCheckResult {
  name: string
  path: string
  /** 路径是否存在(仅存在性) */
  ok: boolean
}

/** `buildEngineProbes` 入参 */
export interface BuildEngineProbesInput {
  /** 内置二进制根目录(`resolveBinDir` 结果) */
  binDir: string
  /** yt-dlp 实际解析路径(`resolveYtDlpPath` 结果,可能为可写副本) */
  ytDlpPath: string
}

/**
 * 组装三引擎待检路径列表(纯函数)。
 * aria2c / ffmpeg 取内置路径;yt-dlp 用已解析路径(优先可写副本,见 `resolveYtDlpPath`)。
 */
export function buildEngineProbes({ binDir, ytDlpPath }: BuildEngineProbesInput): BinaryProbe[] {
  return [
    { name: 'aria2c', path: resolveBundledPath(binDir, BinaryName.Aria2c) },
    { name: 'yt-dlp', path: ytDlpPath },
    { name: 'ffmpeg', path: resolveBundledPath(binDir, BinaryName.Ffmpeg) }
  ]
}

/** 对一组路径做存在性自检,返回结构化结果(纯函数,不抛错)。 */
export function checkBinaries(
  probes: BinaryProbe[],
  existsSync: (path: string) => boolean
): BinaryCheckResult[] {
  return probes.map(({ name, path }) => ({ name, path, ok: existsSync(path) }))
}
