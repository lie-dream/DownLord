/**
 * 接管终裁与归一(纯函数;v0.4 Task 4 · spec §3.2 · plan 2.3)。
 *
 * 「这个下载要不要从浏览器手里抢过来」的**全部判断**都在本文件,且**零副作用、零 electron**——
 * 窗口 / 缓冲 / 建任务由 `takeoverService` 编排(CONTEXT.md「接管判定」)。
 *
 * ⚠️ 这里的判定与「类别 / 类别落点」那套扩展名清单**是两回事**:后者管「抢过来之后放哪个目录」、
 * 从不拒绝任何文件;本文件管「抢不抢」。两者都会提到「文件类型」,放同一个界面里必被误解。
 */
import type { DownloadIntent, SniffAddSelected } from '../../shared/extensionProtocol'
import { isTakeoverPaused } from './pauseState'
import type { TakeoverConfig } from './takeoverConfig'

/**
 * 归一后的意图 —— **裁剪到主进程真正要用的字段**。
 *
 * `byExtensionId` 等「只记事实、不参与决策」的字段在此丢弃:留着迟早有人拿它写分支,
 * 而 Step 0 已拍板不据它决策。
 */
export interface NormalizedIntent {
  /** 原始下载地址(**不是 `finalUrl`**:后者带签名、绑定单一镜像;302 交给 aria2 跟随) */
  url: string
  /** `new URL(url).host`,解析不出即判不接管。**日志与确认框都只用它,不用完整 URL** */
  host: string
  /** 页面来源。⚠️ 可能带会话 token —— **绝不进日志**(Phase 3 才作为 `Referer` 头下发) */
  referrer: string
  /** 浏览器 UA 全串。⚠️ 同样**绝不进日志** */
  userAgent: string
  /** 浏览器危险度判定(见 `decideTakeover` 第四道的诚实标注) */
  danger: string
  /** 浏览器自报总字节;`<= 0` = 未知(确认框据此不渲染大小胶囊) */
  totalBytes: number
}

/** 不接管的原因码。**只进日志,不进应答** —— 应答只有 `{taken}`(spec §2.4 第一层) */
export type TakeoverRejectReason =
  | 'invalid_url'
  | 'disabled'
  | 'paused'
  | 'domain_excluded'
  | 'danger'

/**
 * 嗅探路径独有的不受理原因码(v0.4 Task 5)。**同样只进日志,不进应答**。
 *
 * 刻意与 `TakeoverRejectReason` **分开而不是并进去** —— 后者是 `decideTakeover` 的词汇表,
 * 而嗅探路径**刻意跳过 `decideTakeover`**(见该函数的 docstring);混成一个联合会让人以为
 * 这两个码也是它产出的。
 */
export type SniffRejectReason = 'sniff_segment' | 'sniff_unknown'

export interface TakeoverVerdict {
  taken: boolean
  /** 仅在 `taken === false` 时有值 */
  why?: TakeoverRejectReason
}

/**
 * 归一:URL 合法性 + host 解析 + 字段裁剪。**解析不出 host 即判不接管**(返回 `null`)。
 *
 * 只认 `http:` / `https:` —— 扩展侧已粗筛过一遍(`shouldReportIntent`),这里是主进程侧的独立复核:
 * 通道对本机任意程序开放,不能把「扩展筛过了」当成前提。
 */
export function normalizeIntent(payload: DownloadIntent): NormalizedIntent | null {
  let parsed: URL
  try {
    parsed = new URL(payload.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.host) return null

  return {
    url: payload.url,
    host: parsed.host,
    referrer: typeof payload.referrer === 'string' ? payload.referrer : '',
    userAgent: typeof payload.userAgent === 'string' ? payload.userAgent : '',
    danger: typeof payload.danger === 'string' ? payload.danger : '',
    // 非有限数(NaN / Infinity)一律当「未知」,不让它流进确认框的大小胶囊
    totalBytes: Number.isFinite(payload.totalBytes) ? payload.totalBytes : 0
  }
}

/**
 * 归一嗅探转交载荷(v0.4 Task 5 · spec §4.2 第 1 步)。与 `normalizeIntent` **并列而非复用**:
 * 两者的输入协议不同(`SniffAddSelected` 没有 `danger`,多一个 `contentType`),硬合成一个
 * 函数会逼出 `payload as any` 之类的东西。
 *
 * ⚠️ 产出的 `NormalizedIntent.danger` **恒为空串** —— `danger` 是 `chrome.downloads` 的字段,
 *    **嗅探路径根本没有它**。这也正是嗅探跳过 `decideTakeover` 第四道的理由之一。
 *    (不伪造成 `'safe'`:那会让「这条真的是安全的」看起来像有依据,而它没有。)
 *
 * ⚠️ `totalBytes` 的 `-1`(未知)**原样保留** —— 它只供确认框显示,**不参与任何决策**;
 *    确认框对 `<= 0` 不渲染大小胶囊,故不必在这里改写成 0。
 */
export function normalizeSniffIntent(payload: SniffAddSelected): NormalizedIntent | null {
  let parsed: URL
  try {
    parsed = new URL(payload.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.host) return null

  return {
    url: payload.url,
    host: parsed.host,
    referrer: typeof payload.referrer === 'string' ? payload.referrer : '',
    userAgent: typeof payload.userAgent === 'string' ? payload.userAgent : '',
    danger: '',
    // 非有限数(NaN / Infinity)一律当「未知」,不让它流进确认框的大小胶囊
    totalBytes: Number.isFinite(payload.totalBytes) ? payload.totalBytes : 0
  }
}

/**
 * 域名例外匹配:**精确匹配或后缀匹配**(`host === d || host.endsWith('.' + d)`),全部小写比较。
 *
 * **不支持通配符 / 正则 / 路径** —— 一条规则一个域名,用户看得懂,也不会写出意外命中
 * (`a.com` 命中 `x.a.com`,但**不**命中 `xa.com`)。空表 = 不排除任何域。
 */
export function isExcludedDomain(host: string, list: readonly string[]): boolean {
  const target = host.toLowerCase()
  return list.some((raw) => {
    const domain = raw.trim().toLowerCase()
    if (!domain) return false
    return target === domain || target.endsWith(`.${domain}`)
  })
}

/**
 * 终裁:四道**按序短路**。命中任一道即不接管,后面的不再看。
 *
 * `why` 只进日志、**不进应答** —— 应答多一个 reason 字段就会有人在扩展侧写
 * `if (reason === 'paused')`,那等于把决策泄回扩展侧(spec §2.4)。
 *
 * ⚠️ **本函数不是通往确认框的唯一入口**。v0.4 Task 5 的嗅探转交(`handleSniffSelected`)
 * **刻意跳过这四道**——它们判的是「要不要从浏览器手里抢过来」,而嗅探里浏览器没在下这个东西
 * (理由逐条见 Task 5 spec §4.2)。修改本函数时**不要假设「所有从扩展来的东西都过了这里」**。
 */
export function decideTakeover(
  intent: NormalizedIntent,
  config: TakeoverConfig,
  now: number
): TakeoverVerdict {
  if (config.enabled === false) return { taken: false, why: 'disabled' }
  if (isTakeoverPaused(config.pausedUntil, now)) return { taken: false, why: 'paused' }
  if (isExcludedDomain(intent.host, config.excludedDomains)) {
    return { taken: false, why: 'domain_excluded' }
  }
  // ★ 诚实标注(逐字来自 spec §3.2,不得改写):
  //   `danger !== 'safe'` 时不接管。⚠️ **`onCreated` 时刻浏览器的危险度判定很可能尚未完成**
  //   (2026-08-01 实测的三个样本均为 `safe`,但样本本身都是正常文件,**并未验证过恶意文件在
  //   `onCreated` 时刻会不会已经是非 `safe`**)。故这层防护**是尽力而为,不是可靠拦截**。
  //   **不得表述为「已覆盖恶意文件」/「已过滤危险下载」。** 它的真实价值是:浏览器若**恰好已经**
  //   判出危险,我们不去抢;而不是「我们替浏览器把关」。
  if (intent.danger !== 'safe') return { taken: false, why: 'danger' }
  return { taken: true }
}
