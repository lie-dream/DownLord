/**
 * yt-dlp 更新临时文件路径推导(v0.2 Task 6 · spec §2.2 / §2.4)。
 *
 * 纯字符串推导,无 I/O。落点均在 yt-dlp 可写副本**同目录**(`<userData>/bin/`),保证 `rename` 同卷原子;
 * **绝不触碰内置 `resources/bin/`**(§7.5 独立热更新红线)。
 * - `.download`:下载中的临时文件(下载完成 / 失败均清理);
 * - `.pending`:校验通过但目标被占用时的暂存(下次启动 `applyPendingYtDlp` 生效)。
 */

/** 下载临时文件路径(`<ytdlp>.download`) */
export function downloadYtDlpPath(ytdlpPath: string): string {
  return `${ytdlpPath}.download`
}

/** pending 暂存路径(`<ytdlp>.pending`) */
export function pendingYtDlpPath(ytdlpPath: string): string {
  return `${ytdlpPath}.pending`
}
