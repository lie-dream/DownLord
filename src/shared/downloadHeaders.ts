/**
 * 接管来源请求头的白名单与过滤(v0.4 Task 4 · spec §6.2「白名单的三层」第②层)。
 *
 * ★ **为什么放在 `src/shared/` 而不是 `src/main/takeover/`**(Step 0 第 10 条):
 *   Task 5 的 m3u8 走 yt-dlp,那条 referer 通路**本 Task 不建、由 Task 5 自建**并复用同一常量。
 *   两处各写一套白名单,这条安全边界必然漂移(改了一处忘了另一处 = 静默失效)。
 *   抽常量的成本近乎为零,是唯一能防漂移的形式。
 *
 * ⚠️ **本文件不被 `extension/` import,故可以含函数** —— 与 `src/shared/extensionProtocol.ts`
 *   「只放类型与常量、不放函数」的约束**理由不同**:那条是为了防止有人值导入、把主仓代码
 *   bundle 进扩展(`import type` 编译后消失,值导入不会)。扩展侧对 `src/shared/**` 的
 *   import 已由 eslint `no-restricted-imports` 默认禁死(只给 `extensionProtocol` 单点开口),
 *   故本文件天然到不了扩展的构建产物里。
 *
 * **白名单只放行 `Referer` / `User-Agent` 两个键。** 这不是「加固」,而是守既有红线的**必要条件**:
 * 不做白名单,扩展(或任何持 token 的本机程序)可直接把 `Cookie:` 塞进来 ——
 * 「本 Task 绝不传输 cookie 内容」当场破功(CONTEXT.md「Cookie 三态」:只记来源与路径,
 * 绝不存 cookie 内容)。
 */

/**
 * 允许下发给下载引擎的请求头键名(**规范大小写**,输出恒用这里的写法)。
 *
 * `as const` 不只是为了派生类型 —— 它让「白名单是一份不可变的清单」在类型层可见,
 * 任何新增都必须改这一行,改这一行就必然触发 `U-17` 与本 Task 的安全论证。
 */
export const TAKEOVER_HEADER_ALLOWLIST = ['Referer', 'User-Agent'] as const

/** 白名单键名的字面量联合类型(供调用方在类型层就写不出越界键) */
export type TakeoverHeaderName = (typeof TAKEOVER_HEADER_ALLOWLIST)[number]

/**
 * 过滤请求头:**只放行白名单键,越界键静默丢弃**。
 *
 * - **键名大小写不敏感匹配**:`referer` / `REFERER` / `Referer` 都进 —— HTTP 头名本就大小写不敏感,
 *   按大小写漏放行等于白名单被一个 `referer` 绕过去。
 * - **输出恒用规范大小写**(`Referer` / `User-Agent`):下游 `toAria2HeaderOptions` 按精确键取值,
 *   两边各自「大概齐」迟早对不上。
 * - **值为空串 / 非字符串的键不放行**:空 `Referer` 与不下发 referer 是同一件事,不制造一个空头。
 * - **全部越界(或入参为空)→ 返回 `undefined` 而非 `{}`**:`undefined` 才能让上游
 *   `if (task.headers)` 这一支不进、`toAria2HeaderOptions` 直接短路 —— 「没有头」与
 *   「有一个空的头集合」在缺省等价的证明里不是一回事(`{}` 会让 `Task.headers` 多出一个键)。
 *
 * @param raw - 原始头集合(键名大小写任意);`undefined` / 空对象直接回 `undefined`
 * @returns 规范大小写的白名单子集;一个都不剩时 `undefined`
 */
export function filterDownloadHeaders(
  raw?: Record<string, string>
): Record<string, string> | undefined {
  if (!raw) return undefined

  const filtered: Record<string, string> = {}
  for (const allowed of TAKEOVER_HEADER_ALLOWLIST) {
    const wanted = allowed.toLowerCase()
    for (const [key, value] of Object.entries(raw)) {
      if (key.toLowerCase() !== wanted) continue
      if (typeof value !== 'string' || value === '') continue
      filtered[allowed] = value
      break
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined
}
