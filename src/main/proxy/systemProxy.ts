/**
 * 系统代理读取(Windows)— 纯解析 + 可注入读接口(Task 7 · spec §3)。
 *
 * `session.resolveProxy` 是**主进程主动行为**:aria2 / yt-dlp 不会自动读 Windows 系统代理,
 * 必须由主进程读出代理串、经 `parseResolveProxy` 解析为引擎可用地址,再以参数传入引擎。
 * 本步只定义纯解析与可 fake 的接口;真实 `session.defaultSession.resolveProxy` 接入留 Phase 2/3。
 */

/** `<TYPE> <host:port>` 节点 → 引擎地址前缀(spec §3.2 步 3 协议映射) */
const SCHEME_MAP: Record<string, string> = {
  PROXY: 'http://',
  HTTPS: 'http://', // resolveProxy 可能回 HTTPS 节点;aria2/yt-dlp 走 http 代理语义
  SOCKS: 'socks5://',
  SOCKS5: 'socks5://',
  SOCKS4: 'socks4://'
}

/** host:port 校验(host 非空、端口 1–65535;不接受路径 / 认证,系统代理串无此形态) */
const HOSTPORT_RE = /^([^\s:/]+):(\d{1,5})$/

/**
 * 解析 `session.resolveProxy` 原始串 → 引擎可用代理地址(纯函数,spec §3.2)。
 *
 * - `PROXY h:p` → `http://h:p`;`SOCKS` / `SOCKS5 h:p` → `socks5://h:p`;`SOCKS4 h:p` → `socks4://h:p`
 * - 仅 `DIRECT` / 空串 / 异常串 → `null`
 * - 多代理(`A;B;DIRECT`)取**第一个非 DIRECT** 节点(PAC 负载均衡只取首个,spec §10「明确不做」)
 */
export function parseResolveProxy(str: string): string | null {
  if (typeof str !== 'string') return null

  for (const rawNode of str.split(';')) {
    const node = rawNode.trim()
    if (!node || node.toUpperCase() === 'DIRECT') continue

    // 节点形如 `PROXY 127.0.0.1:7890`:首 token 协议关键字,其余 host:port
    const sep = node.indexOf(' ')
    if (sep < 0) continue
    const scheme = node.slice(0, sep).trim().toUpperCase()
    const hostPort = node.slice(sep + 1).trim()

    const prefix = SCHEME_MAP[scheme]
    if (!prefix) continue
    if (!HOSTPORT_RE.test(hostPort)) continue
    const port = Number(hostPort.split(':')[1])
    if (port < 1 || port > 65535) continue

    return `${prefix}${hostPort}`
  }

  return null
}

/**
 * 可注入的系统代理读接口(spec §3.3)。
 * 测试用 fake;真实实现(Phase 2/3)以代表性外网 URL 调 `session.defaultSession.resolveProxy`,
 * **不发起真实请求**,仅让系统 / PAC 给出代理判定,返回 resolveProxy 原始串。
 */
export interface SystemProxyReader {
  read(): Promise<string>
}
