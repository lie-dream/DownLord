/**
 * 代理端口连通探测(Task 7 · spec §5.2)。
 *
 * 仅对 `effectiveUrl` 的 `host:port` 做**一次性 TCP 连接探测**(`net.connect`,超时 1.5s,成功即关闭):
 * - **只连代理端口本身**(通常本机 Clash `127.0.0.1:xxxx`),**绝不向外网发请求、绝不发送任何应用层字节** ——
 *   无隐私 / 合规争议,不误判墙外可达性;「已连接」语义仅指到代理端口连通(spec §5.1 / PRD §4.4)。
 * - **非周期**:仅 startup / `proxy:set` 后 / 系统代理重读后各一次(触发由调用方 `ProxyService` 控制);`direct` 档不探测。
 *
 * `net.connect` 依赖经 `ConnectFn` 注入(测试注入 fake 模拟连通 / 拒绝 / 超时,无需真实网络);
 * `parseHostPort` 为纯函数,把规整后的 `effectiveUrl` 拆出 `host:port` 供探测(忽略认证段,不连账号密码)。
 */
import net from 'node:net'

/** 探测超时(毫秒,spec §5.2:1.5s) */
export const PROBE_TIMEOUT_MS = 1500

/**
 * 探测所需的最小 socket 行为(`node:net.Socket` 子集),便于注入 fake 单测。
 * 只用到:设超时、监听 connect/timeout/error、销毁释放;不读写任何数据。
 */
export interface ProbeSocket {
  setTimeout(ms: number): void
  once(event: 'connect' | 'timeout' | 'error', listener: () => void): void
  destroy(): void
}

/** 可注入的 TCP 连接器(默认包 `node:net.connect`;测试注入 fake) */
export type ConnectFn = (port: number, host: string) => ProbeSocket

/** 默认连接器:`node:net.connect`(仅建立 TCP 连接,不发送任何字节) */
const defaultConnect: ConnectFn = (port, host) =>
  net.connect({ port, host }) as unknown as ProbeSocket

/** WHATWG URL 会把特殊协议的默认端口规范化为空串,按协议补回(socks 无默认端口,须显式) */
const DEFAULT_PROTO_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443
}

/**
 * 从规整后的代理地址提取 `host:port`(纯函数)。
 * `effectiveUrl` 已经 `validateManualUrl` / `parseResolveProxy` 规整(`http://` / `socks5://` 等);
 * 用 WHATWG `URL` 解析,**忽略认证段**(只取 hostname/port,探测不连账号密码);非法 / 缺端口 → null。
 */
export function parseHostPort(effectiveUrl: string): { host: string; port: number } | null {
  try {
    const u = new URL(effectiveUrl)
    const host = u.hostname
    // `http://…:80` / `https://…:443` 被 URL 规范化为 port=''(Number('')=0)→ 不补回会判非法,
    // 标准端口代理永远探测不到、状态栏恒显「未响应」误报
    const port = u.port !== '' ? Number(u.port) : (DEFAULT_PROTO_PORTS[u.protocol] ?? 0)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  } catch {
    return null
  }
}

/**
 * 对 `host:port` 做一次 TCP 连接探测(spec §5.2)。
 * - `connect` 事件 → `true`(代理端口可连);`timeout` / `error` → `false`;
 * - 无论结果都 `destroy()` 释放;首个事件即定胜负(`settled` 去重,后续事件忽略)。
 * - **只连该 `host:port`,不发送任何数据、不向外网发请求**。
 *
 * @param connect  可注入连接器(默认 `node:net.connect`;测试注入 fake)
 * @param timeoutMs 超时毫秒(默认 1.5s)
 */
export function probe(
  host: string,
  port: number,
  connect: ConnectFn = defaultConnect,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const sock = connect(port, host)

    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        // 释放失败无碍探测结论
      }
      resolve(result)
    }

    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}
