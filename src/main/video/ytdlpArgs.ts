/**
 * yt-dlp 参数组装(纯函数,spec §2.2 / §3.2)。
 *
 * 仿 `engine/aria2Args.ts` 范式:只返回 `string[]`,不起子进程、不碰 fs / 网络。
 * 解析命令一次兼顾单视频 / playlist 检测;下载命令按 `audioOnly` 分支(提取 MP3 vs 合并 mp4)。
 */
import { join } from 'path'
import type { CookieConfig, VideoSubmit } from '../../shared/ipc'
import { toYtdlpProxyArgs } from '../proxy/proxyArgs'
import { toYtdlpCookieArgs } from './ytdlpCookie'
import { toYtdlpDownloaderArgs } from './ytdlpDownloader'
import { toYtdlpHeaderArgs } from './ytdlpHeaders'
import { toYtdlpSubtitleArgs } from './ytdlpSubtitle'

/**
 * 进度逐行模板(spec §3.2):配合 `--newline`,每帧输出
 * `dlp:<status>|<downloaded>|<total>|<estimate>|<speed>`,供 `parseYtDlpLine` 解析。
 */
const PROGRESS_TEMPLATE =
  'dlp:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s'

/**
 * 解析命令参数:一次输出整棵信息树 JSON,playlist 只列条目(快)。
 *
 * `proxy` 三态(Task 7 · spec §4.2):`undefined` = 调用方不带代理概念 → 不追加 `--proxy`(向后兼容);
 * `string` = 走该代理;`null` = 注入回调已解析为直连 / system 未读到 → 追加 `--proxy ''`
 * 显式关闭(屏蔽环境变量 HTTP_PROXY 干扰,合规零泄漏)。
 *
 * `cookie`(v0.2 Task 1 · spec §2.2):末尾追加 `...toYtdlpCookieArgs(cookie)`;无 cookie / none → 空,
 * 与 v0.1 逐字节等价(零回归)。需登录站点连解析(`-J`)都会被拒,故 cookie 解析 + 下载都注入(与 proxy 对称)。
 *
 * `headers`(v0.4 Task 5 · spec §4.5 第 4 处):**解析阶段也必须带** —— 防盗链站点在 yt-dlp
 * **拉 m3u8 清单**那一步就会 403,只补下载是修不好的(这是 Step 1 从本函数签名里查出来的)。
 * 不传 → `toYtdlpHeaderArgs(undefined)` 恒产 `[]` → **与改动前逐字节等价**(U-27)。
 *
 * `extensionCookieFile`(v0.4 Task 6 · spec §2.2):第四档为**本次进程**物化的一次性 cookies.txt 路径。
 * 可选末参,不传 → `toYtdlpCookieArgs` 第二参 `undefined` → 既有三档与既有全部调用点**逐字节等价**。
 */
export function buildYtDlpResolveArgs(
  url: string,
  proxy?: string | null,
  cookie?: CookieConfig,
  headers?: Record<string, string>,
  extensionCookieFile?: string
): string[] {
  const proxyArgs = proxy === undefined ? [] : toYtdlpProxyArgs(proxy)
  const cookieArgs = toYtdlpCookieArgs(cookie, extensionCookieFile)
  const headerArgs = toYtdlpHeaderArgs(headers)
  return [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    // 单 socket 连接 / 读超时:IPv6 路由黑洞等环境下 Python 栈默认无限 hang(真机 2026-07-09
    // 解析卡死实证);超时后 yt-dlp 自动重试 / 换下一地址(IPv4),把「卡死」变「慢但可用」。
    '--socket-timeout',
    '30',
    ...proxyArgs,
    ...cookieArgs,
    ...headerArgs, // 接管 / 嗅探来源的 Referer / UA(v0.4 Task 5):缺省 → 空(零回归)
    url
  ]
}

export interface YtDlpDownloadInput {
  url: string
  /** 落盘目录 */
  dir: string
  /** 清洗后的 basename(不含扩展名);ext 交 yt-dlp 模板 `%(ext)s` */
  outputBase: string
  /** 内置 ffmpeg 绝对路径(MediaTool 退化,§5) */
  ffmpegPath: string
  /** 由 buildFormatSelector 推导的提交参数(§3.3) */
  video: VideoSubmit
  /**
   * 当前代理地址(Task 7 · spec §4.2)。三态同 buildYtDlpResolveArgs:`undefined` = 不追加 `--proxy`
   * (向后兼容);`string` = 走该代理;`null` = 直连 / 未读到 → `--proxy ''` 显式关闭(屏蔽环境 HTTP_PROXY)。
   */
  proxy?: string | null
  /**
   * Cookie 配置(v0.2 Task 1 · spec §2.2)。经 `toYtdlpCookieArgs` 映射;`undefined` / none → 空(零回归)。
   * 字幕选择随 `input.video.subtitles` 到位(rebuildVideoSubmit 重建),不在此单列。
   */
  cookie?: CookieConfig
  /**
   * 第四档「从扩展获取」为**本次 yt-dlp 进程**物化的一次性 cookies.txt 绝对路径
   * (v0.4 Task 6 · spec §2.2;`CookieLease.path`)。
   *
   * 可选字段,缺省 `undefined` → `toYtdlpCookieArgs` 第二参 `undefined` → **与改动前逐字节等价**。
   * ⚠️ 这份文件的**删除责任**在调用方(`VideoEngine` 的 `close` / `error` 释放点,spec §4.4),
   * 本纯函数只把路径拼进参数,不碰 fs。
   */
  extensionCookieFile?: string
  /**
   * 全局 / 任务级有效限速 KB/s(v0.2 Task 2 · spec §2.4)。`undefined` / `0` → 不限速
   * (挂 aria2c 不带 `--max-download-limit`、未挂不加 `--limit-rate`),与 v0.1 逐字节等价。
   */
  limitKBps?: number
  /**
   * aria2c 分片加速态(v0.2 Task 2 · spec §3.1 / §3.4)。`undefined` / `enabled=false` → 用 yt-dlp
   * 自带下载器(不加 `--downloader`),与 v0.1 逐字节等价;`enabled=true` → 挂内置 aria2c(绝对路径定位)。
   */
  accel?: { enabled: boolean; aria2cPath: string }
  /**
   * 接管 / 嗅探来源的请求头(v0.4 Task 5 · spec §4.5 第 2 处)。经 `toYtdlpHeaderArgs` 映射为
   * **专用选项** `--referer` / `--user-agent`(白名单第③层,**刻意不用 `--add-header`**)。
   *
   * `undefined` / `{}` → 恒产 `[]` → 摊开后**与改动前逐字节等价**(U-26 / RP-6)。
   * ⚠️ **`AddUriInput.headers` 对 video 任务天然可得** —— `toAddUriInput` 的 headers 透传在
   * torrent 早退之后、video 分支之前,**与 kind 无关**(Task 4 已建好,本 Task 一个字不加)。
   */
  headers?: Record<string, string>
}

/** 下载命令参数(spec §3.2):视频走合并 mp4,audioOnly 走提取 MP3 */
export function buildYtDlpDownloadArgs(input: YtDlpDownloadInput): string[] {
  const { url, dir, outputBase, ffmpegPath, video } = input
  const output = join(dir, `${outputBase}.%(ext)s`)

  const args: string[] = [
    '-f',
    video.formatSelector,
    '-o',
    output,
    '--no-playlist',
    '--newline',
    // 下方 `--print after_move:filepath` 隐含 quiet 会**抑制进度输出**;`--progress` 强制输出
    // 进度帧到 stdout(否则 UI 下载进度 / 速度全程 0,2026-07-01 真引擎手测暴露)。
    '--progress',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--ffmpeg-location',
    ffmpegPath
  ]

  if (video.audioOnly) {
    // 提取音轨转 MP3(yt-dlp 内部调 ffmpeg);不加 --merge-output-format
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0')
  } else {
    // 音视频合并容器(纯视频格式 +bestaudio 时由 yt-dlp 合并)
    args.push('--merge-output-format', video.mergeFormat ?? 'mp4')
  }

  const proxyArgs = input.proxy === undefined ? [] : toYtdlpProxyArgs(input.proxy)
  const cookieArgs = toYtdlpCookieArgs(input.cookie, input.extensionCookieFile)
  const subtitleArgs = toYtdlpSubtitleArgs(video.subtitles)
  const headerArgs = toYtdlpHeaderArgs(input.headers)
  // downloader / 限速传导(v0.2 Task 2 §2.4):accel/limit 缺省 → 空数组(与 v0.1 逐字节等价,零回归)
  const downloaderArgs = toYtdlpDownloaderArgs({
    enabled: input.accel?.enabled ?? false,
    aria2cPath: input.accel?.aria2cPath ?? '',
    limitKBps: input.limitKBps ?? 0
  })
  args.push(
    // --windows-filenames 让 yt-dlp 对**它自己从元数据填充**的字段清洗 Windows 非法字符(保留中文);
    // 但对 DownLord 先算好、拼进 -o 的字面 outputBase **不生效**(非「双保险」,2026-07-26 审计#3 订正)——
    // 保留设备名(CON/NUL)/ 尾部点等清洗以 filename.ts::sanitizeBasename 为唯一权威(§7.7,清洗补齐留 Phase 2)。
    '--windows-filenames',
    '--no-color',
    '--no-warnings',
    '--ignore-config',
    '--socket-timeout',
    '30', // 防 IPv6 黑洞类环境无限 hang(同 buildYtDlpResolveArgs,2026-07-09)
    ...proxyArgs, // 任务级代理(spec §4.2):undefined 不追加 / null→空串关闭 / 有值透传
    ...cookieArgs, // Cookie 登录(v0.2 §2.2):none / undefined → 空(零回归)
    ...subtitleArgs, // 字幕附属产物(v0.2 §3.2):空 langs → 空(零回归);置于 --print 前,不干扰落盘路径捕获
    // 字幕失败不再有一票否决权(v0.4 Task 6 Step 5b · 2026-08-19 真机)。
    // **出处**:main.log 两条 `ERROR: Unable to download video subtitles for 'zh-Hans':
    // HTTP Error 429: Too Many Requests` —— stderr 里**只有这一行**,exit 却是 1,整个任务报错。
    // 字幕是**附属产物**(见 ytdlpSubtitle.ts「不改主视频 formatSelector」),不该能杀掉主视频。
    //
    // ⚠️ **只在真要了字幕时才加**:没要字幕 → `subtitleArgs` 为空 → 这里也不加 →
    //    **与改动前逐字节等价**,把影响面精确关在「我们主动要了字幕」这一种情形里。
    // ⚠️ yt-dlp **没有**字幕专用的容错开关(`--help` 实测:只有 -i / --ignore-no-formats-error /
    //    --no-abort-on-error,无一是字幕专用),`-i` 是唯一可用机制。
    // ⚠️ **静默损坏的担忧已被实测排除**:带 `-i` 撞上 `unable to download video data:
    //    HTTP Error 403` 时,yt-dlp 仍 **exit=1 且零产物**(2026-08-19 裸跑)——
    //    `-i` 不会把真正的视频数据失败伪装成 completed。
    ...(subtitleArgs.length > 0 ? ['-i'] : []),
    ...downloaderArgs, // downloader / 限速(v0.2 Task 2 §2.4):缺省 → 空(零回归);置于 --print 前,不干扰落盘路径捕获
    ...headerArgs, // 接管 / 嗅探来源的 Referer / UA(v0.4 Task 5 §4.5):缺省 → 空(零回归);同样置于 --print 前
    '--print',
    // 末尾打印最终落盘绝对路径 → 捕获真实 savePath。`%(filepath)j` = JSON 字符串(ensure_ascii,
    // 全 ASCII \u 转义):PyInstaller 版 yt-dlp 忽略 PYTHONIOENCODING、中文 Windows 下 stdout 按
    // GBK 编码,裸路径含中文必 mojibake 污染 savePath(真机 2026-07-09 实锤);JSON 转义对任何
    // stdout 编码无歧义,Node 侧 JSON.parse 还原。
    'after_move:%(filepath)j',
    url
  )

  return args
}
