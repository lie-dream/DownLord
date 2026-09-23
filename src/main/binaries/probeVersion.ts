/**
 * 引擎内核真实版本探测(TODO #14 / spec §4.4)。
 *
 * 起子进程跑 `aria2c --version` / `yt-dlp --version` / `ffmpeg -version`,从原始输出解析
 * 版本号。**各引擎版本号解析为纯函数**(输入原始输出 → 版本串 | null,可单测);探测编排带
 * 超时,任一引擎探测 / 解析失败回退 `engineVersions.ts` 的静态 `ENGINE_VERSIONS`(诚实不崩,
 * spec §4.4)。
 *
 * 仅换「关于」分组的**数据源**:不改 IPC 通道 / `EngineVersions` 类型 / 关于 UI(spec §4.4)。
 * 不查 GitHub releases / 不下载替换 / 不定时检查(完整自动热更新留 TODO #7)。
 *
 * 设计纪律(ARCHITECTURE §6.2 可测性):版本号解析与回退合并为纯函数;起子进程的 `spawn`
 * 依赖注入(仿 `aria2Process` / `ytdlpProcess`),便于不碰真实进程地单测解析逻辑。
 */
import type { ChildProcess } from 'child_process'
import type { EngineVersions } from '../../shared/ipc'
import { ENGINE_VERSIONS } from './engineVersions'

/** 子进程探测默认超时(ms):探测在启动后后台进行,超时即回退,绝不拖慢 / 阻塞 UI(spec §4.4) */
export const DEFAULT_PROBE_TIMEOUT_MS = 6000

/** `aria2c --version` 首行形如 `aria2 version 1.37.0`,取点分版本号(失败 null 由调用方回退) */
export function parseAria2Version(raw: string): string | null {
  const match = raw.match(/aria2 version\s+v?(\d+(?:\.\d+)*)/i)
  return match ? match[1] : null
}

/** `yt-dlp --version` 输出纯日期版本 `YYYY.MM.DD`(nightly 带第四段),取首个匹配(失败 null) */
export function parseYtDlpVersion(raw: string): string | null {
  const match = raw.match(/\b(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)\b/)
  return match ? match[1] : null
}

/** `ffmpeg -version` 首行形如 `ffmpeg version 7.1-full_build...` / `ffmpeg version n7.1`,取数字版本(失败 null) */
export function parseFfmpegVersion(raw: string): string | null {
  const match = raw.match(/ffmpeg version\s+n?(\d+(?:\.\d+)*)/i)
  return match ? match[1] : null
}

/**
 * 合并探测原始输出 → 版本(纯函数,可单测回退逻辑)。
 * 任一引擎原始输出为空 / 解析失败,该字段回退 `fallback` 对应静态常量(诚实不崩,spec §4.4)。
 */
export function mergeProbedVersions(
  raw: { aria2: string | null; ytdlp: string | null; ffmpeg: string | null },
  fallback: EngineVersions
): EngineVersions {
  return {
    aria2: (raw.aria2 ? parseAria2Version(raw.aria2) : null) || fallback.aria2,
    ytdlp: (raw.ytdlp ? parseYtDlpVersion(raw.ytdlp) : null) || fallback.ytdlp,
    ffmpeg: (raw.ffmpeg ? parseFfmpegVersion(raw.ffmpeg) : null) || fallback.ffmpeg
  }
}

/** 探测依赖(注入 `child_process.spawn`,仿 aria2Process / ytdlpProcess,便于测试 / 不在纯逻辑碰真实进程) */
export interface ProbeVersionDeps {
  spawn: typeof import('child_process').spawn
}

/** 探测入参:三引擎解析路径(与 `selfCheck.buildEngineProbes` 同源)+ 可选超时 */
export interface ProbeVersionInput {
  /** 内置 aria2c 绝对路径(始终内置) */
  aria2cPath: string
  /** yt-dlp 解析路径(优先用户可写副本,见 `resolveYtDlpPath`) */
  ytdlpPath: string
  /** 内置 ffmpeg 绝对路径(始终内置) */
  ffmpegPath: string
  /** 单引擎探测超时(ms),默认 `DEFAULT_PROBE_TIMEOUT_MS` */
  timeoutMs?: number
}

/**
 * 起一个子进程取版本原始输出,合并 stdout + stderr 返回。
 * 进程启动失败 / 出错 / 超时 → 返回 null(调用方据此回退静态常量),**不抛、不阻塞**。
 *
 * 导出复用:v0.2 Task 6 yt-dlp 热更新的「下载后可执行性验证」直接复用此注入式探针
 * (`<tmp> --version` → `parseYtDlpVersion` 校验版本 == tag,spec §2.3),避免重复实现 spawn 捕获。
 */
export function captureVersionOutput(
  spawn: ProbeVersionDeps['spawn'],
  exePath: string,
  args: string[],
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    let child: ChildProcess
    try {
      // shell:false 避免命令注入;windowsHide 避免探测时闪黑窗
      child = spawn(exePath, args, { shell: false, windowsHide: true })
    } catch {
      resolve(null)
      return
    }

    // finish 虽在上方定义,但只会在本行之后被调用(超时回调 / error / close),不存在 TDZ 问题
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 忽略 kill 失败:仍按超时回退
      }
      finish(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(output.length > 0 ? output : null))
  })
}

/**
 * 探测三引擎真实版本(并行,各带超时),失败回退静态 `ENGINE_VERSIONS`。
 * **不抛**:任何异常都被 `captureVersionOutput` 吞为 null → `mergeProbedVersions` 回退,
 * 保证启动不被拖垮(spec §4.4)。
 */
export async function probeEngineVersions(
  deps: ProbeVersionDeps,
  input: ProbeVersionInput
): Promise<EngineVersions> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const [aria2, ytdlp, ffmpeg] = await Promise.all([
    captureVersionOutput(deps.spawn, input.aria2cPath, ['--version'], timeoutMs),
    captureVersionOutput(deps.spawn, input.ytdlpPath, ['--version'], timeoutMs),
    captureVersionOutput(deps.spawn, input.ffmpegPath, ['-version'], timeoutMs)
  ])
  return mergeProbedVersions({ aria2, ytdlp, ffmpeg }, ENGINE_VERSIONS)
}
