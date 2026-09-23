/**
 * 「收到点名 → 提供 cookie」的**编排**(v0.4 Task 6 Phase 3 · spec §3.2)。
 *
 * 纯编排:适配器注入,自己不碰任何浏览器全局。四步,一步不多 ——
 *   ① 读应答里的 `needCookieFor` → ② `pickCookieUrls` 过滤(**安全边界**,见 `cookiePick.ts`)
 *   → ③ 逐 URL `cookies.getAll({url})` → ④ 逐域 `cookie.offer`。
 *
 * ★ **两条路径共用本文件**:甲路径(popup「用 DownLord 下载此页视频」,候选 `[pageUrl]`)与
 *   丙路径(嗅探转交,候选 `[url, referrer]`)。候选清单**由调用方按「这一次请求自己带过去的
 *   URL」给出**,本文件不去任何 storage 里翻 —— 那正是 §3.3 那道结构约束的前提。
 *
 * ★ **没有任何定时器 / 预取 / 批量**(红线 R9):本文件只在拿到一次带点名的应答后跑一遍,
 *   跑完即止。定时唤醒那个权限因此从来不需要,轮询计时器一个都没有。
 *   (⚠️ 上面这句**刻意不写出那个权限名与那个计时器 API 名** —— 判据是它们在本目录 grep
 *    **零命中**,注释若照抄名字,判据就再也分不清「代码在用」与「注释在说」。
 *    同一个坑本项目已踩过三次,解法固定为改注释措辞,**不是**收窄判据。)
 *
 * ⚠️ **本文件不 log**(`cookies/` 全目录的隐私红线):这里流过域名与页面地址。
 *    失败**静默降级**,由 popup 那一行如实说结果 —— 不写 console。
 */
import type { BrowserAdapter } from '../adapter/browserAdapter'
import { toOfferedCookies } from './cookieCollect'
import { sendCookieOffer } from './cookieClient'
import { pickCookieUrls } from './cookiePick'

/**
 * 一次编排的结果 —— **只装「能如实说给用户听」的东西**。
 *
 * ⚠️ 刻意**没有** cookie 条数 / 名字 / 值:那些不该出现在返回值里(返回值会一路进 view model,
 *    而 view model 会进 DOM)。「已附 `<域名>` 的登录态」需要的仅仅是域名。
 */
export interface CookieFlowOutcome {
  /** DownLord **明确收下**的域(按点名顺序);空数组 = 一个都没送出去 */
  accepted: string[]
  /** 有域因载荷超 64KB 而**没发**(popup 据此说「登录态过大,未能提供」) */
  tooLarge: boolean
  /**
   * 被点名却**没能采纳**的域数 = `needCookieFor.length - 采纳的候选数`。
   *
   * ⚠️ **只用于扩展自己的判断,绝不上行**(回报等于告诉对方「你猜的那个域我这儿没有」)。
   *    留这个字段是为了让「静默丢弃」在单测里**可观察** —— 否则那条安全边界只能靠读代码确认。
   */
  droppedNames: number
}

const EMPTY: CookieFlowOutcome = { accepted: [], tooLarge: false, droppedNames: 0 }

/**
 * 按一次应答的点名提供 cookie。
 *
 * @param needCookieFor 应答里的 `needCookieFor`;`undefined`(没选第四档 / 没受理)= **直接返回空**,
 *   连 `getAll` 都不会被调用 —— 「没选第四档 = 零外泄」在这条路径上的形状(红线 R10)。
 * @param candidates 本次请求自己携带的 URL(甲 `[pageUrl]`,丙 `[url, referrer]`)。
 *
 * 单个域失败(`getAll` 抛 / 通道拒)**不影响其余域**,也**不抛给调用方** ——
 * 这条路径是附加能力:cookie 没送到,下载本身照样已经交给 DownLord 了。
 */
export async function offerCookiesFor(
  adapter: BrowserAdapter,
  needCookieFor: string[] | undefined,
  candidates: string[]
): Promise<CookieFlowOutcome> {
  if (needCookieFor === undefined || needCookieFor.length === 0) return EMPTY

  const urls = pickCookieUrls(needCookieFor, candidates)
  const outcome: CookieFlowOutcome = {
    accepted: [],
    tooLarge: false,
    // 点名了却没被采纳的那些 —— 静默丢弃,只在本地记个数
    droppedNames: needCookieFor.length - urls.length
  }

  for (const url of urls) {
    // 逐个串行:一次点名最多 2 个域(主进程侧上界),并发省不下什么,
    // 而串行让「哪一域先送到」是确定的,单测断言得起来。
    const one = await offerOne(adapter, url)
    if (one === 'too_large') outcome.tooLarge = true
    // `domainOf` 与 `pickCookieUrls` 用同一把尺子(`new URL().host`),故它必与点名项全等
    else if (one === 'accepted') outcome.accepted.push(domainOf(url))
  }
  return outcome
}

async function offerOne(
  adapter: BrowserAdapter,
  url: string
): Promise<'accepted' | 'too_large' | 'failed'> {
  let cookies
  try {
    cookies = await adapter.cookies.getAll({ url })
  } catch {
    return 'failed' // 浏览器拒读 / 受限页 —— 静默降级,不 log(那会记下域名)
  }
  // **空数组也照发**:「这个域我这儿没有 cookie」是一个 DownLord 该知道的事实,
  // 它据此把该域算作「已问过、无登录态」,而不是一直当作缺失在等。
  return sendCookieOffer(adapter, domainOf(url), toOfferedCookies(cookies))
}

/**
 * URL → 精确 host。
 *
 * 这里**不需要 try**:`url` 来自 `pickCookieUrls` 的返回值,而那个函数只会返回
 * `new URL()` 已经解析成功过的候选。写 try 反而会掩盖「有人绕过 pick 直接调进来」这个真问题。
 */
function domainOf(url: string): string {
  return new URL(url).host
}
