/**
 * 解析 / 下载失败 → 可读中文(纯函数,spec §2.4 / §3.4;ARCHITECTURE §6.3)。
 *
 * Task 9 收口:文案与判定逻辑统一迁入 `src/main/errors`(`errorCatalog` 单一文案来源 +
 * `mapError` 分领域映射器)。本模块仅保留对外签名 `mapResolveError` / `mapDownloadError`
 * (返回可读字符串),委托 `mapError` 拿条目后经 `toReadable` 拼接——**对外行为不变**。
 * 原始 stderr 由调用方进日志,此处只产可读中文 + 可操作下一步,无副作用。
 *
 * v0.4 Task 6 加性扩展:两支各加**可选末参** `extCookie`(第四档前置事实 + 点名的域)。
 * 不传 → 与改动前逐字节等价(既有三档零回归)。
 */
import { toReadable, COOKIE_HOSTS_PLACEHOLDER } from '../errors/errorCatalog'
import {
  mapYtdlpResolveError,
  mapYtdlpDownloadError,
  type ExtensionCookieContext
} from '../errors/mapError'

/**
 * 第四档「从扩展获取」交给错误映射的两件事(v0.4 Task 6 · spec §6.2)。
 *
 * 合成一个对象而不是两个并列参数:它们是**同一件事的两半** —— 前置事实选码,域名填进那个码的文案。
 */
export interface ExtensionCookieFacts {
  /** 取值时刻算出的前置事实,决定命中 login 那一格时改判成哪个 `COOKIE_EXTENSION_*` */
  context: ExtensionCookieContext
  /**
   * 本次任务点名的精确 host(`resolveCookieHosts` 的结果)。
   *
   * ⚠️ **只用于填 `COOKIE_EXTENSION_NONE` 的 `<域名>` 占位 —— 这是域名唯一允许出现的地方(UI)**,
   * 不入日志(红线 R4:日志零 cookie 值 + 零域名)。
   */
  hosts: string[]
}

/** 条目 → 可读中文,并把 `<域名>` 占位换成点名的域(顿号连接)。无占位的条目原样返回。 */
function readable(text: string, facts?: ExtensionCookieFacts): string {
  if (!facts || !text.includes(COOKIE_HOSTS_PLACEHOLDER)) return text
  // hosts 为空只可能是 URL 连 host 都解析不出来(`resolveCookieHosts` 全非法 → `[]`)。
  // 那时说「该网站」比留一个空洞诚实,也比暴露一个我们并不掌握的域名准确。
  const label = facts.hosts.length > 0 ? facts.hosts.join('、') : '该网站'
  return text.replace(COOKIE_HOSTS_PLACEHOLDER, label)
}

/** 映射 yt-dlp **解析**失败 → 可读中文(委托 `mapYtdlpResolveError`,不传 `extCookie` 时行为不变)。 */
export function mapResolveError(
  stderr: string,
  exitCode: number | null,
  extCookie?: ExtensionCookieFacts
): string {
  return readable(toReadable(mapYtdlpResolveError(stderr, exitCode, extCookie?.context)), extCookie)
}

/** 映射 yt-dlp **下载**失败 → 可读中文(委托 `mapYtdlpDownloadError`,不传 `extCookie` 时行为不变)。 */
export function mapDownloadError(
  stderr: string,
  exitCode: number | null,
  extCookie?: ExtensionCookieFacts
): string {
  return readable(toReadable(mapYtdlpDownloadError(stderr, exitCode, extCookie?.context)), extCookie)
}
