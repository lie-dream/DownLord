/**
 * Netscape `cookies.txt` 格式识别(v1.0 Task 3 · `M-015`)—— **纯函数,零 fs、零 Electron**。
 *
 * 存在理由(裁决表 `M-015`):Cookie 来源 =「从 Cookie 文件(高级)」时选一个 `.jpg` 也不报错,
 * 用户要等到下载失败、拿到一个指向别处的错误码才知道选错了(v1.0 Task 2 手测 N08)。
 *
 * 🔴 **判定必须在主进程**(ARCHITECTURE §7.2):渲染层连「字符串转数字」都不当成校验,
 *   在那边写文件格式判断是直接破红线。渲染层只做「我要的路径 ≠ 主进程回包里的路径」这一次比较。
 *
 * 🔴 **只否定能证明为假的**:本函数的调用方在**读不到文件时一律放行** —— 「读不到」既可能是
 *   路径打错,也可能是 U 盘没插、权限不足,拿不准就不替用户下结论(下载时 `COOKIE_FILE_INVALID`
 *   仍然兜底)。这与「入站可达」「待活动」是同一种收敛:分不清就不假装分得清。
 *
 * 格式(yt-dlp 接受的 Netscape 形态):
 * - 可选注释头,常见 `# Netscape HTTP Cookie File` / `# HTTP Cookie File`;
 * - 数据行为 **TAB 分隔的 7 个字段**:domain / includeSubdomains / path / secure / expiry / name / value,
 *   其中第 2、4 字段恒为 `TRUE` / `FALSE`;domain 允许 `#HttpOnly_` 前缀(浏览器扩展导出常见)。
 */

/** 只看开头这么多字符:够判格式,又不会为一个几百 MB 的误选文件把内存吃光 */
const SNIFF_CHARS = 64 * 1024

/** 注释头的两种常见写法(大小写不敏感);命中即认 —— 头都写了,后面是空表也是合法的空 cookie 文件 */
const NETSCAPE_HEADER = /^#\s*(netscape\s+)?http\s+cookie\s+file/i

/** 一条合法数据行:7 个 TAB 字段,第 2 / 4 字段是 TRUE|FALSE */
function isCookieDataLine(line: string): boolean {
  const f = line.split('\t')
  if (f.length < 7) return false
  const flag = (s: string): boolean => s === 'TRUE' || s === 'FALSE'
  return f[0].trim() !== '' && flag(f[1].trim()) && flag(f[3].trim())
}

/**
 * 这段文本看起来是不是 Netscape `cookies.txt`。
 *
 * 判据(**任一成立即为真**):① 有 Netscape / HTTP Cookie File 注释头;② 至少有一条合法数据行。
 * ⚠️ **二进制内容直接为假**:含 NUL 的文件不可能是 cookies.txt —— 这正是误选 `.jpg` / `.png` 的形态。
 */
export function isNetscapeCookieText(text: string): boolean {
  const head = text.slice(0, SNIFF_CHARS)
  // 以 utf-8 读二进制会得到替换字符 U+FFFD;连同 NUL 一起作为「这不是文本文件」的判据
  if (head.includes('\0') || head.includes('\uFFFD')) return false
  const lines = head.split(/\r?\n/)
  for (const line of lines) {
    if (NETSCAPE_HEADER.test(line)) return true
  }
  for (const line of lines) {
    if (line.startsWith('#')) continue
    if (isCookieDataLine(line)) return true
  }
  return false
}
