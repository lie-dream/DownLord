/**
 * 三闸鉴权判定(纯函数;v0.4 Task 3 · spec §3.3 · plan 1.4)。
 *
 * ```
 * 请求到达
 *   ├─ 闸⓪ 路径 / 方法:非 POST /channel → 404 / 405(空体)      ← 便宜的形状检查,不是安全闸
 *   ├─ 闸②  OPTIONS → 405 且**零个跨源放行响应头**              ← 由**浏览器**强制执行的那一闸
 *   ├─ 闸①  token 请求头全等 → 失败记一次 → 401(超窗口 429)      ← **唯一的主闸**
 *   ├─ 闸③  Origin 前缀(纵深,不是主闸 —— 本机程序可任意伪造)
 *   └─ 体积上限 → 413
 * ```
 *
 * **一句话的诚实总结**(spec §3.6):真正在挡本机攻击者的**只有 token 一件事**;
 * 闸②③ 挡的是**浏览器里的网页 JS** —— 那是另一类攻击者。三闸**分工不同、不叠加**,
 * 把它说成「三倍安全」是错的。
 *
 * ⚠️ **鉴权必须先于版本检查**(版本协商在 `channelDispatch.ts`)—— 换了顺序就等于
 * 向未鉴权的调用方泄漏协议版本。
 */
import {
  EXTENSION_CHANNEL_MAX_BODY_BYTES,
  EXTENSION_CHANNEL_ORIGIN_PREFIXES,
  EXTENSION_CHANNEL_PATH,
  EXTENSION_CHANNEL_TOKEN_HEADER
} from '../../shared/extensionProtocol'

/** token 请求头的小写形态 —— Node 把入站头名统一归一为小写 */
export const TOKEN_HEADER_LOWER = EXTENSION_CHANNEL_TOKEN_HEADER.toLowerCase()

export interface AuthInput {
  /** HTTP 方法(Node 给的是大写) */
  method: string
  /** **纯路径**(调用方已去掉查询串 —— 完整查询串一个字都不许进日志,spec §3.5) */
  path: string
  /** 入站请求头(键**已由 Node 归一为小写**) */
  headers: Record<string, string | undefined>
  /** `content-length` 声明值;缺失 / 非法为 `null` */
  contentLength: number | null
}

/**
 * **内部诊断码**:只用于聚合计数(`鉴权失败 ×N`),
 * **既不回给对方**(否则等于免费给攻击者一个「我的 Origin 对了、只差 token」的指路牌)
 * **也不逐条落日志**(spec §3.5)。
 */
export type AuthLogCode =
  | 'method'
  | 'path'
  | 'preflight'
  | 'token_missing'
  | 'token_mismatch'
  | 'origin_missing'
  | 'origin_bad'
  | 'too_large'
  | 'rate_limited'

export type AuthDecision =
  | { ok: true }
  | { ok: false; status: 404 | 405 | 401 | 413 | 429; reason: 'unauthorized'; logCode: AuthLogCode }

export interface AuthConfig {
  /** 当前配置里的 token;与请求头做**全等**比较 */
  token: string
  /**
   * 失败窗口是否已触发。**惰性回调**:只在 **token 校验失败**后才会被调用 ——
   * ★ token 正确的请求根本不走限速分支(有单测断言它未被调用)。缺省 = 从不触发。
   */
  isTripped?: () => boolean
}

/** 哪些内部码计入「鉴权失败」聚合计数(形状检查与体积超限不算:它们不是安全闸) */
export function isAuthFailure(logCode: AuthLogCode): boolean {
  return (
    logCode === 'token_missing' ||
    logCode === 'token_mismatch' ||
    logCode === 'origin_missing' ||
    logCode === 'origin_bad' ||
    logCode === 'rate_limited'
  )
}

function deny(
  status: 404 | 405 | 401 | 413 | 429,
  logCode: AuthLogCode
): { ok: false; status: 404 | 405 | 401 | 413 | 429; reason: 'unauthorized'; logCode: AuthLogCode } {
  return { ok: false, status, reason: 'unauthorized', logCode }
}

/**
 * 三闸判定。**顺序不可换**(见文件头流程图)。
 *
 * 注:`OPTIONS` 的判定夹在「路径」与「方法」之间 —— 它本可被后面的「非 POST → 405」顺带挡掉,
 * 单列一支只为让预检有**独立的内部诊断码**(`preflight`),便于观测「有没有网页 JS 在打我们」。
 * 两支的对外行为完全一致:`405` + 空体 + **零个 CORS 头**。
 */
export function authorizeRequest(input: AuthInput, config: AuthConfig): AuthDecision {
  // 闸⓪-a 路径:非 /channel 一律 404,一个字都不必回
  if (input.path !== EXTENSION_CHANNEL_PATH) {
    return deny(404, 'path')
  }

  // 闸② CORS 预检:405 + 空体,且**响应绝不带任何跨源放行头**(由 channelServer 保证)。
  // 这一闸的价值在于「不依赖任何头的内容可信度」—— 它不判断谁说自己是谁,
  // 而是让浏览器根据**我们的沉默**拒绝它自己的请求。
  if (input.method === 'OPTIONS') {
    return deny(405, 'preflight')
  }

  // 闸⓪-b 方法:只认 POST
  if (input.method !== 'POST') {
    return deny(405, 'method')
  }

  // 闸① token(唯一主闸):全等比较,**不 trim、不忽略大小写** ——
  // hex 小写是生成端唯一形态,宽容只会扩大匹配面。
  const token = input.headers[TOKEN_HEADER_LOWER]
  if (typeof token !== 'string' || token.length === 0) {
    if (config.isTripped?.()) return deny(429, 'rate_limited')
    return deny(401, 'token_missing')
  }
  if (token !== config.token) {
    if (config.isTripped?.()) return deny(429, 'rate_limited')
    return deny(401, 'token_mismatch')
  }

  // 闸③ Origin 前缀(纵深,不是主闸):用 `startsWith` **不用 `includes`** ——
  // 后者会被 `https://evil.com/#chrome-extension://` 之类的串骗过。
  // P2 真机取证为**阳性**(浏览器确实带 Origin 到达服务端),故缺 Origin 判拒。
  const origin = input.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) {
    return deny(401, 'origin_missing')
  }
  if (!EXTENSION_CHANNEL_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))) {
    return deny(401, 'origin_bad')
  }

  // 体积上限:`content-length` 声明超限就地拒,**不读 body**(流式累计的第二道在 channelServer)
  if (input.contentLength !== null && input.contentLength > EXTENSION_CHANNEL_MAX_BODY_BYTES) {
    return deny(413, 'too_large')
  }

  return { ok: true }
}
