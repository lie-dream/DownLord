/**
 * yt-dlp 下载器(`--downloader`)与限速传导纯函数(v0.2 Task 2 · spec §2.4 / §3.1)。
 *
 * 仿 `proxy/proxyArgs.ts` 范式:只返回 `string[]`,不起子进程、不碰 fs / 网络。
 * 按「是否挂 aria2c」二分支:
 * - **挂 aria2c**(`enabled`):委托内置 aria2c 多线程分片下载;限速经 `--downloader-args aria2c:… --max-download-limit`
 *   传给 aria2c(§2.4:此时 yt-dlp `--limit-rate` 对外部下载器无效)。`-x 16 -s 16 -k 1M` 与直链 `buildAria2Args`
 *   默认一致(§3.1),行为可预期;`--downloader-args` 值为单个 argv 元素(yt-dlp 内部 shlex 拆分),无 shell 注入。
 * - **未挂**(`!enabled`):yt-dlp 自带下载器,限速经 `--limit-rate`。
 *
 * `limitKBps=0`(不限速)→ 挂 aria2c 分支不带 `--max-download-limit` 段、未挂分支带 `--concurrent-fragments`
 * 并发提速(v0.3 Task 4 · #24;对 progressive 无副作用,对 HLS/DASH 提速),`0` 时不加 `--limit-rate`。
 */
import { CONCURRENT_FRAGMENTS } from './formatAccel'

/**
 * `toYtdlpDownloaderArgs` 入参。
 * `enabled` = 是否挂内置 aria2c(装配期 gate:开关 && aria2c 存在,§3.3);
 * `aria2cPath` = 内置 aria2c 绝对路径(`--downloader` 定位,§3.2);
 * `limitKBps` = 有效限速 KB/s(任务级优先于全局,§2.3;`0` = 不限)。
 */
export interface YtdlpDownloaderInput {
  enabled: boolean
  aria2cPath: string
  limitKBps: number
}

export function toYtdlpDownloaderArgs(input: YtdlpDownloaderInput): string[] {
  const { enabled, aria2cPath, limitKBps } = input
  if (enabled) {
    // 挂 aria2c:限速经 --downloader-args 传给 aria2c(§2.4);kbps>0 才带 --max-download-limit 段。
    // --connect-timeout=10:防 IPv6 黑洞类环境单地址连接长挂(aria2 默认 60s×多地址,真机 2026-07-09
    // 表现为「加速失败回退」前长时间假死);超时即换下一地址 / 重试。
    // --auto-save-interval=1:暂停/取消是 taskkill /F 硬杀,aria2c 无优雅退出机会;控制文件默认 60s
    // 才落一次盘 → 硬杀丢最多 60s 进度(短任务≈全丢,恢复从 0 重下,真机 2026-07-09 表现为
    // 「恢复后进度冻结但速率在变」)。改 1s → 硬杀最多丢 ~1s。
    // --allow-overwrite=true:.part 在而控制文件缺失(开跑 1s 内被杀等)时,aria2c 从头重下自愈,
    // 而非 exit 13「文件已存在」→ 误触加速回退、任务被锁死在自带下载器。
    const limitSeg = limitKBps > 0 ? ` --max-download-limit=${limitKBps}K` : ''
    return [
      '--downloader',
      aria2cPath,
      '--downloader-args',
      `aria2c:-x 16 -s 16 -k 1M --connect-timeout=10 --auto-save-interval=1 --allow-overwrite=true${limitSeg}`
    ]
  }
  // 未挂 aria2c:自带下载器(§2.4)。--concurrent-fragments 并发抓取 HLS/DASH 分片提速(v0.3 Task 4 · #24;
  // 对 progressive 单文件无副作用,yt-dlp 忽略);限速经 --limit-rate(0 = 不限 → 不加,零回归)。
  const rateArgs = limitKBps > 0 ? ['--limit-rate', `${limitKBps}K`] : []
  return ['--concurrent-fragments', String(CONCURRENT_FRAGMENTS), ...rateArgs]
}
