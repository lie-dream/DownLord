/**
 * Netscape cookies.txt 转换纯函数(v0.4 Task 6 · spec §5)。
 *
 * 把「暂借登录态」的内存快照渲染成 yt-dlp `--cookies` 认的那种文本。**手写、不引库**(D8):
 * 7 列 tab 分隔,格式简单,可逐条单测。
 *
 * ⚠️ **这一节为什么值得逐条覆盖**(spec §5.3):本函数的失败形态是**静默的** —— 格式错 →
 * yt-dlp 跳过那些行 → 表现为「明明借到了登录态却仍报需要登录」,而按 §7.1 日志红线,
 * 日志里**既没有域名也没有 cookie 值**可供排查。**边界单测是这类失败的唯一防线**,
 * 故 spec §5.2 的 12 条边界各有一例,不做抽样覆盖。
 *
 * 纯函数:不碰 fs / 网络 / 子进程,**零 `electron` import**。
 */
import type { OfferedCookie } from '../../shared/extensionProtocol'

/** 一个域的 cookie 快照(`host` 只用于分组与保序,不参与行内容) */
export interface NetscapeCookieGroup {
  host: string
  cookies: OfferedCookie[]
}

/** `toNetscapeCookieFile` 的产出。`written === 0` = 「等于没有」,调用方据此决定不物化文件 */
export interface NetscapeCookieFile {
  text: string
  written: number
  /** 被丢弃的条数。⚠️ **只记计数,不记 name / domain / value**(§7.1 日志红线) */
  skipped: number
}

/**
 * 首行魔术注释 —— **必须有**:Python `http.cookiejar.MozillaCookieJar.load` 用
 * `#( Netscape)? HTTP Cookie File` 校验首行,不匹配直接 `LoadError`(整份文件作废)。
 */
const MAGIC_HEADER = '# Netscape HTTP Cookie File'

/**
 * httpOnly 的编码方式:整行前缀。该格式**没有 httpOnly 列**,
 * yt-dlp 的 `YoutubeDLCookieJar._HTTPONLY_PREFIX` 会剥掉它再解析。
 *
 * ✅ **2026-08-14 裸跑实测成立**(Phase 0 探针 B1,`scripts/verify/task6-netscape-probe.mts`):
 * 带前缀的行,靶站确实收到了 `dlp_b1=vb1_httponly`。故保留前缀,退路(不加前缀)未启用。
 */
const HTTPONLY_PREFIX = '#HttpOnly_'

/**
 * 会把 7 列结构挤歪的字符。该格式**无转义机制**,含这些字符的字段只能整条丢弃(§5.2⑦⑧)。
 */
const STRUCTURE_BREAKING = /[\t\r\n]/

/**
 * 内存快照 → Netscape cookies.txt 文本(spec §5.1 逐字钉死的形状)。
 *
 * ```
 * # Netscape HTTP Cookie File
 * <domain>\t<includeSubdomains>\t<path>\t<secure>\t<expires>\t<name>\t<value>\n
 * ```
 *
 * **恰好 7 字段 / 6 个 TAB**:yt-dlp 对字段数不等于 7 的行跳过并打 WARNING(不是致命错)——
 * 这正是「格式错会导致 yt-dlp **静默**不带 cookie」的确切机制。行尾 `\n`,不用 `\r\n`。
 *
 * 多域合并进同一个文件:按 `groups` 顺序、组内保序 → **输出确定**,故测试可做全串相等。
 */
export function toNetscapeCookieFile(groups: NetscapeCookieGroup[]): NetscapeCookieFile {
  const lines: string[] = [MAGIC_HEADER]
  let written = 0
  let skipped = 0

  for (const group of groups) {
    for (const cookie of group.cookies) {
      // ⑨ name 为空串 → 整条丢弃:Python 见空 name 会把 value 当 name(`name = value; value = None`),
      //    产出一条语义完全不同的 cookie —— 比少一条 cookie 更坏
      if (cookie.name === '') {
        skipped += 1
        continue
      }

      // ⑥ path 空 / 缺省 → `/`(空字段会让第 3 列为空串,匹配不到任何请求)
      const path = cookie.path === undefined || cookie.path === '' ? '/' : cookie.path

      // ⑦⑧ 任一字段含 TAB / CR / LF → 整条丢弃。⑩ value 为空串**保留**(空值 cookie 真实存在)
      if (
        STRUCTURE_BREAKING.test(cookie.name) ||
        STRUCTURE_BREAKING.test(cookie.value) ||
        STRUCTURE_BREAKING.test(cookie.domain) ||
        STRUCTURE_BREAKING.test(path)
      ) {
        skipped += 1
        continue
      }

      // ① domain **原样输出**;第 2 列由前导点决定(前导点就是 hostOnly 的编码)
      const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'

      // ② 全大写:Python 判 `secure == "TRUE"`,小写 `true` 会被当作**非 secure**
      const secure = cookie.secure ? 'TRUE' : 'FALSE'

      lines.push(
        (cookie.httpOnly ? HTTPONLY_PREFIX : '') +
          [
            cookie.domain,
            includeSubdomains,
            path,
            secure,
            expiresColumn(cookie.expires),
            cookie.name,
            cookie.value
          ].join('\t')
      )
      written += 1
    }
  }

  // ⑪ 无可写条目 → 只有首行魔术注释,`written: 0`
  return { text: `${lines.join('\n')}\n`, written, skipped }
}

/**
 * 第 5 列 `expires`(§5.2④⑤)。
 *
 * - 缺省 / 非有限 / `NaN` / 负数 / `0` → **`0`**;否则 `Math.floor`。
 * - **必须是纯数字串**:yt-dlp 对非全数字的 `expires` 抛 `LoadError` → **该行被跳过**(静默少一条)。
 *
 * ✅ **`0` 的语义 2026-08-14 裸跑实测成立**(Phase 0 探针 B2):yt-dlp 把 `expires == 0` 改判为
 * session cookie(而非裸 `MozillaCookieJar` 的「已过期」)并以 `ignore_discard=True` 加载 ——
 * 靶站确实收到了 `dlp_b2=vb2_session`。故 session 写 `0`,退路(改写 now+400 天)未启用。
 * **登录 cookie 大量是 session cookie,这一格错了等于第四档整体失效。**
 */
function expiresColumn(expires: number | undefined): string {
  if (expires === undefined || !Number.isFinite(expires) || expires <= 0) return '0'
  return String(Math.floor(expires))
}
