/**
 * 启动期 pending yt-dlp 更新应用(v0.2 Task 6 · spec §2.4)。
 *
 * yt-dlp 更新时若有视频任务占用该 exe(Windows 文件锁),不杀进程(§7.1)——校验通过的新版本
 * 暂存为 `<userData>/bin/yt-dlp.exe.pending`。本函数在 `setupBinaries()`**之前**、任何引擎 spawn
 * 之前运行(此时无进程占用,rename 必成):
 * - pending 有效(size ≥ `MIN_VALID_YTDLP_BYTES`)→ rename 覆盖 `yt-dlp.exe` + 删 pending → `applied`;
 * - pending 无效(< 阈值,占位 / 损坏 / 半文件)→ 仅删除,不污染 → `discarded`;
 * - 无 pending → no-op → `none`。
 *
 * 之后 `ensureWritableYtDlp` 见有效副本自然 `skipped`——**与占位检测语义完全一致、不倒退**
 * (校验用同一 `MIN_VALID_YTDLP_BYTES` 下限,绝不以「等于内置大小」判定,Task 9 修复不倒退)。
 *
 * 同步 + 注入式 fs(默认真实 `fs`,单测注入内存 fake);任何异常吞为 `error` 不抛,绝不拖垮启动。
 */
import { existsSync, statSync, renameSync, unlinkSync } from 'fs'
import { MIN_VALID_YTDLP_BYTES } from '../binaries/ensureWritable'
import { pendingYtDlpPath } from './paths'

/** 文件系统探针(默认真实 `fs`;单测注入以避免碰真实磁盘) */
export interface ApplyPendingFs {
  existsSync(path: string): boolean
  statSync(path: string): { size: number }
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

const defaultFs: ApplyPendingFs = {
  existsSync,
  statSync: (path) => statSync(path),
  renameSync,
  unlinkSync
}

export interface ApplyPendingYtDlpInput {
  /** yt-dlp 可写副本绝对路径(`userWritableYtDlpPath(userDataDir)`) */
  ytdlpPath: string
  /** 文件系统探针(默认真实 `fs`) */
  fs?: ApplyPendingFs
}

export interface ApplyPendingResult {
  /**
   * - `applied`:pending 有效,已 rename 覆盖 yt-dlp.exe(下次运行新版本);
   * - `discarded`:pending 无效(< 阈值),仅删除;
   * - `none`:无 pending,no-op;
   * - `error`:异常(已吞,不影响启动)。
   */
  action: 'applied' | 'discarded' | 'none' | 'error'
  /** pending 文件路径(供调用方写日志) */
  pendingPath: string
}

/**
 * 应用 pending yt-dlp 更新(见文件头)。**同步、不抛**:异常吞为 `error`,启动继续。
 */
export function applyPendingYtDlp({
  ytdlpPath,
  fs = defaultFs
}: ApplyPendingYtDlpInput): ApplyPendingResult {
  const pendingPath = pendingYtDlpPath(ytdlpPath)
  try {
    if (!fs.existsSync(pendingPath)) {
      return { action: 'none', pendingPath }
    }
    if (fs.statSync(pendingPath).size >= MIN_VALID_YTDLP_BYTES) {
      // 有效:无进程占用,rename 覆盖必成(占位检测随后自然 skipped)
      fs.renameSync(pendingPath, ytdlpPath)
      return { action: 'applied', pendingPath }
    }
    // 无效(占位 / 损坏 / 半文件):仅删除,不污染可写副本
    fs.unlinkSync(pendingPath)
    return { action: 'discarded', pendingPath }
  } catch {
    // 启动期任何异常都吞掉(不拖垮启动);pending 保留待下次重试
    return { action: 'error', pendingPath }
  }
}
