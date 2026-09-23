/**
 * Cookie 登录参数纯函数(v0.2 Task 1 · spec §2.1 / §6.1)。
 *
 * 仿 `proxy/proxyArgs.ts` / `video/ytdlpArgs.ts` 范式:只做「配置 → yt-dlp 参数」组装,
 * 不碰 fs / 网络 / 子进程,更**不读 cookie 内容**(cookie 值始终由 yt-dlp 运行时从浏览器 / 文件即时读取,§2.6)。
 * 四态(v0.4 Task 6 起):none / 配置不完整 → 零附加(向后兼容);browser → `--cookies-from-browser`;
 * file → `--cookies`;**extension → 同样 `--cookies`**(见下方第二参)。
 */
import type { CookieConfig } from '../../shared/ipc'

/**
 * Cookie 配置 → yt-dlp 参数片段(纯函数,spec §2.1 / §2.2)。
 * - `undefined` / `source==='none'` → `[]`(零附加,与 v0.1 逐字节等价,零回归);
 * - `browser`(browser 非空)→ `['--cookies-from-browser', browser[:profile]]`;
 * - `file`(file 非空)→ `['--cookies', <path>]`;
 * - `extension`(v0.4 Task 6)→ 见 `extensionCookieFile`;
 * - 配置不完整(browser / file / 临时文件缺失)→ `[]`(退化零附加,不产坏参数)。
 *
 * @param extensionCookieFile - 第四档「从扩展获取」为**本次 yt-dlp 进程**物化的一次性 cookies.txt
 *   绝对路径(`CookieLease.path`)。**可选、默认 `undefined`** → 既有三档与既有全部调用点
 *   **逐字节等价**(零回归靠「缺省分支返回常量」这条形状,不靠自觉)。
 *   - 有文件 → `['--cookies', p]` —— **与 `file` 档产出同形**,这就是「不改 yt-dlp 调用协议」的兑现;
 *   - 无文件 → `[]` —— 退化零附加,复用上面「配置不完整」那条既有语义。⚠️ **不是错误路径**:
 *     手上没有该任务需要的登录态时照常跑 yt-dlp(参数与 `none` 档逐字节相同),公开内容照下不误;
 *     真失败了再由 `mapError` 的上下文改判成 `COOKIE_EXTENSION_*`(spec §6.2)。
 */
export function toYtdlpCookieArgs(cookie?: CookieConfig, extensionCookieFile?: string): string[] {
  if (!cookie || cookie.source === 'none') return []

  if (cookie.source === 'browser' && cookie.browser) {
    const spec = cookie.profile ? `${cookie.browser}:${cookie.profile}` : cookie.browser
    return ['--cookies-from-browser', spec]
  }

  if (cookie.source === 'file' && cookie.file) {
    return ['--cookies', cookie.file]
  }

  // 第四档「从扩展获取」(v0.4 Task 6):与 file 档**同形**产出 —— yt-dlp 侧一个字都不知道
  // 这份文件是哪来的,它只是一个 Netscape cookies.txt。差别全在**谁写、谁删**(见 tempCookieFile.ts)。
  if (cookie.source === 'extension' && extensionCookieFile) {
    return ['--cookies', extensionCookieFile]
  }

  // 配置不完整(browser / file / 第四档临时文件缺失)→ 退化零附加,不产坏参数
  return []
}
