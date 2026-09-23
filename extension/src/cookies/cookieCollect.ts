/**
 * `BrowserCookie[]` → `OfferedCookie[]`:**字段搬运 + 形状校验,不做内容过滤**
 * (v0.4 Task 6 Phase 3 · spec §3.2)。纯函数(适配器的结果作为入参进来)。
 *
 * ★ **为什么不过滤内容**:我们**无法判断哪一条是「登录用的」** —— 站点用什么 cookie 名承载会话
 *   完全由它自己决定(`SESSDATA` / `sid` / `__Secure-…` / 一串随机字母皆有),而 yt-dlp 支持上千站点。
 *   「按域取」的必然含义就是**该域全取**。想只取一部分,就得先猜对,而猜错的失败形态是
 *   **yt-dlp 静默不带 cookie**,按日志红线又查不到域名与值 —— 最难诊断的那一类。
 *   这一点在安装说明与 UI 上如实交代,**不靠悄悄少取几条来假装更安全**。
 *
 * ★ **必须含 `httpOnly`**:登录 cookie 几乎恒为 httpOnly,**不取等于白取**
 *   (2026-08-17 探针 B3 实测:`getAll({url})` 返回的 31 条里确实含 httpOnly 项)。
 * ★ **必须含 session cookie**(无 `expirationDate` 那些):很多站点的会话就在里面。
 *   协议侧 `expires` 省略即 session,主进程侧写 Netscape 第 5 列 `0`(探针 B2 已验 yt-dlp
 *   把 `0` 当 session cookie,**不是**已过期)。
 *
 * 🔴 **`domain` 的前导点原样保留,一层都不许归一**:协议里**刻意没有 `hostOnly` 字段**,
 *    `.example.com` 与 `example.com` 的那个点**就是**它。归一掉会让主进程侧的
 *    `includeSubdomains` 列全算错,而失败形态同样是 yt-dlp 静默不带 cookie。
 *
 * ⚠️ **本文件不 log**(`cookies/` 全目录的隐私红线):这里流过的是 cookie 的名与值本身。
 */
import type { BrowserCookie } from '../adapter/browserAdapter'
import type { OfferedCookie } from '../contract'

/**
 * 搬运一批 cookie。
 *
 * **宽进严取**:形状不合的条目**整条跳过**(不补默认值 —— 编一个 `path: '/'` 出来,
 * 会让一条本该被丢掉的 cookie 以错误的作用域进到 Netscape 文件里),其余原样搬。
 * 一条坏数据不许带崩整次提供。
 */
export function toOfferedCookies(cookies: readonly BrowserCookie[]): OfferedCookie[] {
  const offered: OfferedCookie[] = []
  for (const cookie of cookies) {
    const one = toOfferedCookie(cookie)
    if (one !== undefined) offered.push(one)
  }
  return offered
}

function toOfferedCookie(cookie: BrowserCookie): OfferedCookie | undefined {
  if (typeof cookie.name !== 'string' || cookie.name === '') return undefined
  if (typeof cookie.value !== 'string') return undefined // 空值是合法的(站点用它清 cookie)
  if (typeof cookie.domain !== 'string' || cookie.domain === '') return undefined
  if (typeof cookie.path !== 'string' || cookie.path === '') return undefined
  if (typeof cookie.secure !== 'boolean') return undefined
  if (typeof cookie.httpOnly !== 'boolean') return undefined

  const offered: OfferedCookie = {
    name: cookie.name,
    value: cookie.value,
    // 🔴 原样。**这一行不许加 `replace(/^\./, '')` 之类的东西**,那个点就是 hostOnly
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly
  }

  const expires = toExpires(cookie.expirationDate)
  // **省略而非写 0**:协议里「没有这个键」才是 session cookie 的表达
  if (expires !== undefined) offered.expires = expires
  return offered
}

/**
 * 浏览器给的是**小数秒**,协议要 unix 秒整数 → `Math.floor`。
 *
 * `undefined` / 非有限数 / `<= 0` 一律回 `undefined`(= session cookie):
 * 一个非正的到期时刻要么是坏数据、要么本就表示「不持久」,两种情形下
 * 「当 session cookie 处理」都比「写一个 1970 年的时间戳」正确 —— 后者是**已过期**,
 * yt-dlp 会直接扔掉那一条。
 */
function toExpires(expirationDate: number | undefined): number | undefined {
  if (typeof expirationDate !== 'number' || !Number.isFinite(expirationDate)) return undefined
  if (expirationDate <= 0) return undefined
  return Math.floor(expirationDate)
}
