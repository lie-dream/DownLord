/**
 * ★ 扩展侧自己的第三道约束:**点名只能落在它刚刚上报过的 URL 上**
 * (v0.4 Task 6 Phase 3 · spec §3.3)。纯函数,零 I/O,零依赖。
 *
 * ★★ **这是安全边界,不是便利函数**。它把「DownLord 能点名什么」从**语义约束**变成**结构约束**:
 *    即使应答被伪造成 `needCookieFor: ["bank.com"]`(占了通道端口的假 DownLord 能做到这一步),
 *    扩展手里也**没有 `bank.com` 的候选 URL** —— `getAll` 因此**根本不会被调用**。
 *    spec §7.3「三闸对这条最敏感的通道仍然足够」的论证有一半压在本文件上,
 *    **改动它等于改动威胁模型**(反向探针 RP-4 就是把它改成直接返回全部候选)。
 *
 * ⚠️ **本文件不 log**(`cookies/` 全目录的隐私红线):流过这里的是域名与页面地址,
 *    而扩展的 console **任何装了它的人都能在 sw / popup DevTools 里翻**。
 */

/**
 * 从「DownLord 点名的 host」与「本次请求自己携带的候选 URL」里挑出该去取 cookie 的 URL。
 *
 * @param needCookieFor 应答里的点名清单(精确 host)。**不无条件照办**。
 * @param candidates **这一次请求自己带过去的 URL**:甲路径 `[pageUrl]`,丙路径 `[url, referrer]`。
 *   它们活在**同一次调用的局部作用域**里,**不进任何 storage** —— 于是「上一次上报过的域」
 *   在下一次调用里天然不存在,不需要任何过期逻辑(与主进程侧否决时间窗口白名单同一条理由)。
 * @returns 采纳的候选 URL,按 `needCookieFor` 的顺序、每个 host 最多一条。
 *
 * 匹配规则(逐条,故意都很窄):
 * - `new URL(c).host === host` **全等**,**不做后缀 / 父域匹配** —— 与主进程侧 D3 同一把尺子
 *   (没有 Public Suffix List 就分不清 `a.github.io` 与 `b.github.io`)。
 * - 两侧都归一到小写:DNS 本就大小写不敏感,而 `new URL()` 解析出的 `host` 已是小写,
 *   若不归一点名侧,`WWW.Example.COM` 这种写法会莫名匹配不上。**这不是放宽域匹配**。
 * - 只认 `http:` / `https:`:别的 scheme(`edge://…` 这类受限页,`Tab.url` 本来就读不到)
 *   谈不上「会被发往该 URL 的 cookie」。
 * - 非法候选 URL(`new URL` 抛)**跳过**,不让一个坏字符串带崩整条路径。
 *
 * ⚠️ **匹配不上的名字静默丢弃,不回报给 DownLord** —— 回报等于告诉对方
 *    「你猜的那个域我这儿没有」,那是一条我们不必开的信息通路。
 *    「并计数」由调用方从 `needCookieFor.length - result.length` 当场得出(**不另设字段、不另开出口**);
 *    那个数**只用于扩展自己的降级判断**,同样不上行。
 */
export function pickCookieUrls(needCookieFor: string[], candidates: string[]): string[] {
  const byHost = new Map<string, string>()
  for (const candidate of candidates) {
    const host = hostOf(candidate)
    // 先到先得:丙路径的 `[url, referrer]` 同 host 时取前者(那才是真正要下的那个地址)
    if (host !== undefined && !byHost.has(host)) byHost.set(host, candidate)
  }

  const picked: string[] = []
  const used = new Set<string>()
  for (const name of needCookieFor) {
    const host = normalizeHost(name)
    if (host === undefined || used.has(host)) continue
    const candidate = byHost.get(host)
    if (candidate === undefined) continue // ★ 静默丢弃:没上报过的域,一个字都不回报
    used.add(host)
    picked.push(candidate)
  }
  return picked
}

/** 候选 URL 的 host;非法 / 非 http(s) / 无 host → `undefined`(单一「没有」的取值) */
function hostOf(candidate: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.host === '' ? undefined : parsed.host
}

/** 点名侧的 host 归一:去空白 + 小写。空 → `undefined` */
function normalizeHost(name: string): string | undefined {
  const trimmed = name.trim().toLowerCase()
  return trimmed === '' ? undefined : trimmed
}
