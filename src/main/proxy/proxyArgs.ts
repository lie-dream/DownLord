/**
 * 代理参数纯函数(Task 7 · spec §2.4 / §3.4 / §4.1 / §4.2)。
 *
 * 仿 `engine/aria2Args.ts` / `video/ytdlpArgs.ts` 范式:只做校验 / 解析 / 参数组装,
 * 不碰 fs / 网络 / 子进程。**合规地基**:direct 档与 system 未读到代理时 effectiveUrl 为 null,
 * `toAria2/toYtdlp` 产出「显式空串关闭代理」——不省略参数,杜绝继承 aria2 进程级 / 环境默认代理。
 */
import type { ProxyConfig } from '../../shared/ipc'

/** 支持的手动代理协议(spec §2.1 / §4.3 含认证;aria2 / yt-dlp 均原生支持) */
const MANUAL_URL_RE = /^(?:https?|socks[45]):\/\/(?:[^\s:@/]+(?::[^\s@/]*)?@)?[^\s:@/]+:(\d{1,5})$/

/**
 * 控制字符(\x00–\x1f 与 \x7f):防注入 / 防嵌入换行。源码用 \x 转义(纯 ASCII 文本)。
 *
 * 此处刻意匹配控制字符——本正则的**目的**就是检出并拒绝它们,非误写;
 * `no-control-regex` 意在拦截无意间写进正则的控制字符,与此处的安全校验用途相反,故豁免。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

/**
 * 校验手动代理地址(纯函数,spec §3.4)。
 * 合法 → 返回规整后(trim + 补协议)的地址;非法(不支持协议 / 无端口 / 空 / 注入字符 / 端口越界)→ null。
 * **无协议前缀的裸 `host:port`(Clash / v2rayN 生态惯用写法)按 `http://` 代理规整后接受**——
 * 真机(2026-07-08)用户输入 `127.0.0.1:7890` 被拒,致 manual 档 effectiveUrl=null → 引擎显式直连,
 * 在直连不可达的网络下全链路失败;宽进严出:规整值仍走同一正则校验,持久化保留用户原始输入。
 * 含认证的 `user:pass@host:port` 原样透传(不单独做认证 UI,spec §4.3)。
 */
export function validateManualUrl(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  if (CONTROL_CHARS_RE.test(trimmed)) return null

  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`

  const m = MANUAL_URL_RE.exec(candidate)
  if (!m) return null
  const port = Number(m[1])
  if (port < 1 || port > 65535) return null

  return candidate
}

/**
 * 三档矩阵 → 最终传引擎的地址(纯函数,spec §2.4)。
 * direct → null;manual → 校验通过的地址(失败 → null,不进 effectiveUrl);system → 读到的系统代理 / 未读到 → null。
 */
export function resolveEffectiveProxy(
  config: ProxyConfig,
  systemDetected: string | null
): string | null {
  switch (config.mode) {
    case 'direct':
      return null
    case 'manual':
      return config.manualUrl ? validateManualUrl(config.manualUrl) : null
    case 'system':
      return systemDetected ?? null
    default:
      return null
  }
}

/**
 * aria2 任务级 `all-proxy` 选项片段(纯函数,spec §4.1)。
 * 有值 → 透传;**null → 显式空串关闭**(避免继承 aria2 进程级 / 环境默认代理)。
 */
export function toAria2ProxyOption(effectiveUrl: string | null): Record<string, string> {
  return { 'all-proxy': effectiveUrl ?? '' }
}

/**
 * yt-dlp `--proxy` 参数片段(纯函数,spec §4.2)。
 * 有值 → `['--proxy', url]`;**null → `['--proxy', '']`**(空串显式禁用,屏蔽环境变量 HTTP_PROXY 干扰);
 * 绝不产出空数组 / 缺参数。
 */
export function toYtdlpProxyArgs(effectiveUrl: string | null): string[] {
  return ['--proxy', effectiveUrl ?? '']
}
