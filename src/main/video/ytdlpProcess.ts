/**
 * yt-dlp 子进程封装(spawn 注入,可测;spec §3.1 / ARCHITECTURE §6.2)。
 *
 * 仿 `engine/aria2Process.ts` 的注入式范式:spawn 由依赖注入,单测 mock 一个吐预存
 * stdout/stderr 的假子进程,不起真 yt-dlp。`run` 统一供 VideoResolver(一次性 JSON)
 * 与后续 VideoEngine(--newline 逐行进度)使用:
 * - `onLine`:配合 `--newline`,stdout 按整行回调(剥除末尾 \r);
 * - `signal`:AbortSignal 触发即 kill 子进程(解析超时 / 任务取消),被 kill 后以
 *   exitCode=null 正常 resolve,由调用方据 null 映射「超时 / 取消」(§2.4)。
 */
import type { ChildProcess } from 'child_process'
import { ytdlpSpawnEnv } from './ytdlpEnv'

export interface YtdlpProcessDeps {
  spawn: typeof import('child_process').spawn
  /**
   * Windows 进程树杀(注入式,审计#1 · spec §6):默认 win32 下 `taskkill /pid <pid> /T /F`;非 win32 no-op。
   * yt-dlp.exe(PyInstaller onefile)是 bootloader 父 + Python 子两进程,裸 `child.kill()` 杀父会 orphan
   * Python 子进程(-J 解析照跑成孤儿)—— 先树杀再 child.kill 兜底(复刻 videoEngine.defaultTreeKill)。
   */
  treeKill?: (pid: number) => void | Promise<void>
}

export interface YtdlpRunOptions {
  /** 配合 --newline:每收到一整行 stdout 回调一次(已剥除末尾 \r) */
  onLine?: (line: string) => void
  /** 触发即 kill 子进程(超时 / 取消);被 kill 后 run 以 exitCode=null 正常 resolve */
  signal?: AbortSignal
}

export interface YtdlpRunResult {
  /** 进程退出码;被信号杀死(超时 / 取消)时为 null */
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface YtdlpProcess {
  run(ytdlpPath: string, args: string[], opts?: YtdlpRunOptions): Promise<YtdlpRunResult>
}

/** 创建注入式 yt-dlp 进程封装(spawn 注入,不经 shell 避免命令注入) */
export function createYtdlpProcess(deps: YtdlpProcessDeps): YtdlpProcess {
  // 审计#1:abort(超时 / 删除)时用进程树杀防 orphan;注入优先,缺省 win32 taskkill(非 win32 no-op)
  const treeKill = deps.treeKill ?? ((pid: number) => defaultTreeKill(deps.spawn, pid))
  return {
    run(ytdlpPath, args, opts = {}) {
      return new Promise<YtdlpRunResult>((resolve, reject) => {
        const child: ChildProcess = deps.spawn(ytdlpPath, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: ytdlpSpawnEnv(), // 钉死 Python stdio UTF-8(中文 Windows 下默认 GBK → mojibake)
          windowsHide: true // 打包 GUI 态防解析子进程闪控制台窗口(与 probeVersion 一致)
        })

        let stdout = ''
        let stderr = ''
        let lineBuffer = ''
        let settled = false

        const onAbort = (): void => {
          killChildTree(child, treeKill)
        }

        const cleanup = (): void => {
          if (opts.signal) {
            opts.signal.removeEventListener('abort', onAbort)
          }
        }

        if (opts.signal) {
          if (opts.signal.aborted) {
            killChildTree(child, treeKill)
          } else {
            opts.signal.addEventListener('abort', onAbort, { once: true })
          }
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          stdout += text
          if (opts.onLine) {
            lineBuffer += text
            const parts = lineBuffer.split('\n')
            lineBuffer = parts.pop() ?? '' // 末段可能是半行,留待下次 / close flush
            for (const part of parts) {
              opts.onLine(stripCr(part))
            }
          }
        })

        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })

        child.on('error', (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err) // spawn 失败(找不到可执行文件等)
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          cleanup()
          // flush 末行残留(若非空)
          if (opts.onLine && lineBuffer.trim() !== '') {
            opts.onLine(stripCr(lineBuffer))
          }
          resolve({ exitCode: code, stdout, stderr })
        })
      })
    }
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 杀 yt-dlp 进程树(审计#1 · spec §6):先 `treeKill`(taskkill /T /F 整棵树,含 PyInstaller Python 子进程)
 * 再 `child.kill()` 兜底 —— **顺序关键**,先 child.kill 杀 bootloader 父会 orphan 子进程(-J 解析照跑成孤儿)。
 * treeKill 为 async(taskkill 需时间);child.kill 挂其后(promise chain);无 pid → 仅 child.kill 兜底。
 */
function killChildTree(child: ChildProcess, treeKill: (pid: number) => void | Promise<void>): void {
  const pid = child.pid
  if (typeof pid !== 'number') {
    try {
      child.kill()
    } catch {
      // best-effort
    }
    return
  }
  Promise.resolve(treeKill(pid))
    .catch(() => {}) // 树杀 best-effort
    .finally(() => {
      try {
        child.kill()
      } catch {
        // 已退出 / kill 失败不阻塞
      }
    })
}

/**
 * 默认树杀:仅 win32 起 `taskkill /pid <pid> /T /F`(整棵进程树强杀),await 其退出再返回;
 * 非 win32 → no-op(child.kill 兜底)。复刻 `videoEngine.defaultTreeKill`(注入式可测,windowsHide 防闪窗)。
 */
function defaultTreeKill(spawn: typeof import('child_process').spawn, pid: number): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise<void>((resolve) => {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on?.('close', () => resolve())
      killer.on?.('error', () => resolve()) // taskkill 失败(进程已退出等)best-effort
    } catch {
      resolve() // best-effort
    }
  })
}
