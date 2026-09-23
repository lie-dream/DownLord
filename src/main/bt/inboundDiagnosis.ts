/**
 * 入站可达自检(v0.4 Task 1 · spec §3.1 / §3.2 / §3.3)。
 *
 * **口径**(CONTEXT.md「入站可达」+ backlog #32 的 2026-07-29 决议):外界能否主动连到本机 BT 监听端口
 * 决定做种上传能否发生。DownLord **只检测与如实呈现,不承诺打通**。
 *
 * ⚠️ 本模块**不做**、将来也不在此做的事:
 * - ❌ **UPnP / NAT-PMP / 任何端口映射** —— 校园网出口设备不归用户管、CGNAT 家宽同样无效,
 *   而本机已有公网 IPv6 时 IGD 只映射 IPv4 端口、完全用不着(D1 / D2);
 * - ❌ **查或改 Windows 防火墙规则** —— 规则按程序路径 + 专用/公用网络档分别匹配,漏判误判都容易,
 *   **给假结论比不给更坏**(D4);更不要求提权;
 * - ❌ 外部端口探测服务 / CGNAT 检测 —— 需外联第三方,违背「纯本地零外联」;
 * - ❌ 常驻定时器轮询网卡 —— 主进程不知 UI 态;重算只在「被 IPC 问到 / powerMonitor resume /
 *   添加 BT 任务」三个时机发生,且**每次都实算、不缓存**(spec §3.4,这是「换网自动重算」的地基)。
 *
 * **纯函数 + 依赖全注入**:网卡列表与时钟由调用方注入,本模块**不 import 'os'**、无 IO、无随机 ——
 * 判定逻辑可离线单测,生产侧才把 `os.networkInterfaces` 接上(spec §3.2)。
 *
 * **多因子结构是 v0.5 接 UPnP 的接缝**:`summarizeInbound` 对因子条数**无任何假设**,
 * 届时只需在 `InboundFactor['id']` 加 `'upnpMapping'` + 在 `collectInboundFactors` 里 push 第二条,
 * 汇总规则 / IPC 通道 / payload 类型 / UI 一行不改(spec §3.5)。
 */

import type { InboundDiagnosis, InboundFactor, InboundReachability } from '../../shared/ipc'

/** `os.networkInterfaces()` 单条地址的最小面(注入;`family` 跨 Node 版本可能是 `'IPv6'` 或 `6`) */
export interface NetAddressLike {
  address: string
  family: string | number
  internal: boolean
}

/** `os.networkInterfaces()` 返回值的最小面(值可能为 `undefined`,须容忍) */
export type NetInterfacesLike = Record<string, NetAddressLike[] | undefined>

/** 因子采集的注入依赖(**不直接调 `os`**,测试注入 fake 即可全离线跑) */
export interface InboundProbeDeps {
  /** 生产注入 `os.networkInterfaces`;抛错 → 产出 `unknown` 因子(读不到 ≠ 没有) */
  readInterfaces: () => NetInterfacesLike
  /** 时钟注入(测试固定) */
  now: () => number
}

/** 公网 IPv6 因子的 UI 短语(spec §3.1) */
const LABEL_PUBLIC_IPV6 = '公网 IPv6'

/**
 * 三态说明文案(spec §3.3 逐字)。
 *
 * ⚠️ 此处**只存冒号之后的正文**;行首标签「入站可达:」由渲染层统一加 —— 因子有 N 条时
 * 前缀只该出现一次(v0.5 接 UPnP 后 `factors` 会有两条)。措辞自查:无「提速」「保证连上更多节点」
 * 「加速他人」「装了就能上传」;`supports` 档**只陈述「检测到公网 IPv6」这一事实**,
 * 后果一律加「还取决于路由器与系统防火墙是否放行」(§7.6 措辞红线 / CONTEXT.md「诚实」)。
 */
const DETAIL_SUPPORTS =
  '检测到公网 IPv6 地址。能否真的被外部连入,还取决于路由器与系统防火墙是否放行 —— DownLord 只检测,不修改任何网络设置。'
const DETAIL_AGAINST =
  '未检测到公网 IPv6 地址。处于 NAT / 校园网之后时,外部通常无法主动连入,做种上传速度可能长期为 0。这由所在网络决定,应用层无法改变。'
const DETAIL_UNKNOWN = '未能读取本机网络接口,无法判断。'

/**
 * 汇总若干条独立证据 → 入站可达三态(spec §3.1)。
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 任一因子 `supports` | `likely` |
 * | 因子非空且**全部** `against` | `unlikely` |
 * | 其余(空数组 / 含 `unknown` 且无 `supports`) | `unknown` |
 *
 * 语义:可达性是**「或」关系**(有公网 IPv6 可达,**或**有 UPnP 映射可达)→ 任一条证据支持即判 `likely`;
 * **全部反对才判不可达**;拿不准就 `unknown`,**不猜**。
 *
 * ⚠️ **对因子条数不得有任何假设** —— 这正是 v0.5 接 UPnP 的接缝(spec §3.5),
 * 单测里的「两因子:against + supports → likely」用例把这条性质钉死。
 */
export function summarizeInbound(factors: readonly InboundFactor[]): InboundReachability {
  if (factors.some((f) => f.verdict === 'supports')) return 'likely'
  if (factors.length > 0 && factors.every((f) => f.verdict === 'against')) return 'unlikely'
  return 'unknown'
}

/**
 * 本机是否有全局单播 IPv6 地址(spec §3.2 八步判定;顺序即实现顺序)。
 *
 * 纯函数:输入网卡列表、输出布尔,**无 IO、无时钟、无随机**。任一地址命中 `2000::/3` 即 `true`。
 */
export function hasGlobalUnicastIPv6(ifaces: NetInterfacesLike): boolean {
  for (const addrs of Object.values(ifaces)) {
    // 接口值可能为 undefined(Node 类型如此),不崩
    if (!addrs) continue
    for (const addr of addrs) {
      if (isGlobalUnicastIPv6Address(addr)) return true
    }
  }
  return false
}

/** 单条地址的八步判定(逐条排除 → 最后判 `2000::/3`) */
function isGlobalUnicastIPv6Address(addr: NetAddressLike): boolean {
  // ① 跳过 internal(回环 ::1 / 127.0.0.1)
  if (addr.internal === true) return false
  // ② 只看 IPv6;IPv4 一律不算 —— 有公网 v4 也不等于入站放行,且本 Task 口径只认 v6(D2)
  if (!(addr.family === 'IPv6' || addr.family === 6)) return false
  // ③ 规范化:去首尾空白 → 小写 → 去 %zone 后缀(`fe80::1%eth0` → `fe80::1`)
  const text = String(addr.address ?? '')
    .trim()
    .toLowerCase()
    .split('%')[0]
  if (!text) return false

  const g0 = firstGroup(text)
  const g1 = secondGroup(text)
  if (g0 === null || g1 === null) return false // 非法 hex → 不认(宁可漏判,不给假结论)
  const firstByte = g0 >>> 8

  // ④ 排除 fe80::/10 链路本地(首字节 fe 且次字节高 2 bit 为 10,即 fe80–febf)
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return false
  // ⑤ 排除 fc00::/7 ULA(含 fd00::/8;用 /7 是 RFC 4193 完整段,属**更严格的超集**)
  if (firstByte === 0xfc || firstByte === 0xfd) return false
  // ⑥ 排除 ::1(回环)、::(未指定)、::ffff:0:0/96(IPv4-mapped)—— 三者首组皆为 0
  if (g0 === 0) return false
  // ⑦ 排除 Teredo 2001:0::/32 与 6to4 2002::/16(细则 S1:IPv4 之上的过渡隧道,
  //    Windows 上 Teredo 常自动启用,算作公网 IPv6 会**假阳性**)
  if (g0 === 0x2001 && g1 === 0) return false
  if (g0 === 0x2002) return false
  // ⑧ 判全局单播 2000::/3(首字节 0x20–0x3f)
  return firstByte >= 0x20 && firstByte <= 0x3f
}

/**
 * 取地址的第一个 16-bit 分组值。
 * 以 `:` 开头(`::1` / `::` / `::ffff:…` 等压缩形式)→ 首组为 0;非法 hex → `null`。
 */
function firstGroup(text: string): number | null {
  if (text.startsWith(':')) return 0
  return parseHexGroup(text.split(':')[0])
}

/**
 * 取地址的第二个 16-bit 分组值(仅步骤 ⑦ 判 Teredo 用)。
 * 空段(`2001::` 的 `::` 压缩)/ 缺失 → 0(压缩位展开后确为 0);非法 hex → `null`。
 */
function secondGroup(text: string): number | null {
  const part = text.split(':')[1]
  if (part === undefined || part === '') return 0
  return parseHexGroup(part)
}

/** 解析一个 1–4 位十六进制分组;非法 → `null` */
function parseHexGroup(part: string | undefined): number | null {
  if (!part || part.length > 4 || !/^[0-9a-f]+$/.test(part)) return null
  return Number.parseInt(part, 16)
}

/**
 * 采集入站可达的证据(spec §3.1)。
 *
 * v0.4 只有 `publicIPv6` 一条;`readInterfaces()` 抛错 → 产出 `verdict:'unknown'` 的因子
 * (**不吞成 `against`** —— 读不到 ≠ 没有,给假结论比不给更坏)。
 */
export function collectInboundFactors(deps: InboundProbeDeps): InboundFactor[] {
  let ifaces: NetInterfacesLike
  try {
    ifaces = deps.readInterfaces()
  } catch {
    return [
      { id: 'publicIPv6', label: LABEL_PUBLIC_IPV6, verdict: 'unknown', detail: DETAIL_UNKNOWN }
    ]
  }

  const has = hasGlobalUnicastIPv6(ifaces)
  return [
    {
      id: 'publicIPv6',
      label: LABEL_PUBLIC_IPV6,
      verdict: has ? 'supports' : 'against',
      detail: has ? DETAIL_SUPPORTS : DETAIL_AGAINST
    }
  ]
}

/**
 * 一次完整的入站自检:采集因子 → 汇总三态 → 打时间戳(spec §3.1)。
 * **每次调用都实算**(纯本地读网卡,微秒级),调用方不缓存结果 —— 换网后任何一次查询拿到的
 * 都是当前网络的真实结论(§3.4)。
 */
export function diagnoseInbound(deps: InboundProbeDeps): InboundDiagnosis {
  const factors = collectInboundFactors(deps)
  return {
    state: summarizeInbound(factors),
    factors,
    checkedAt: deps.now()
  }
}
