/**
 * 入站可达自检纯函数单测(v0.4 Task 1 · spec §7.1)。
 *
 * 覆盖两个纯函数:
 * - `hasGlobalUnicastIPv6` —— spec §3.2 八步判定逐条(含细则 S1 的 Teredo / 6to4 假阳性排除);
 * - `summarizeInbound` —— 三态汇总规则,**含「两因子」用例**:这条锁死「汇总规则对 N 条因子成立」,
 *   是 v0.5 接 UPnP 的接缝(spec §3.5)—— 将来若有人把规则改成只看第一条因子,本测试立刻红。
 *
 * 全部离线:网卡列表与时钟注入,不碰 `os`、不发网络请求。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectInboundFactors,
  diagnoseInbound,
  hasGlobalUnicastIPv6,
  summarizeInbound,
  type NetAddressLike,
  type NetInterfacesLike
} from './inboundDiagnosis'
import type { InboundFactor } from '../../shared/ipc'

/** 造一条外部 IPv6 地址(默认非 internal) */
function v6(address: string, internal = false): NetAddressLike {
  return { address, family: 'IPv6', internal }
}

/** 造一条 IPv4 地址 */
function v4(address: string, internal = false): NetAddressLike {
  return { address, family: 'IPv4', internal }
}

/** 单网卡表(名字随意,判定与接口名无关) */
function ifaces(...addrs: NetAddressLike[]): NetInterfacesLike {
  return { 以太网: addrs }
}

// ==================== hasGlobalUnicastIPv6(spec §3.2 八步) ====================

test('hasGlobalUnicastIPv6:合成文档 IPv6(非隧道全局单播形态)→ true', () => {
  // RFC 3849 文档夹具；验证现有分类语义，不引用本机网络地址
  assert.equal(
    hasGlobalUnicastIPv6(ifaces(v6('2001:db8:1234:5678:9abc:def0:1234:5678'))),
    true,
    '2000::/3 内、非隧道段 → 全局单播'
  )
})

test('hasGlobalUnicastIPv6:④ fe80::/10 链路本地(带 %zone)→ false', () => {
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('fe80::1%eth0'))), false, '去 zone 后仍是 fe80')
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('febf::1'))), false, 'fe80–febf 上界也排除')
})

test('hasGlobalUnicastIPv6:⑤ fc00::/7 ULA(含 fd00::/8)→ false', () => {
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('fd00::1'))), false, 'fd00::/8 唯一本地')
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('fc00::1'))), false, 'fc00::/7 完整段(RFC 4193)')
})

test('hasGlobalUnicastIPv6:⑥ ::1 / :: / IPv4-mapped → false', () => {
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('::1'))), false, '回环(即使 internal 标错)')
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('::'))), false, '未指定地址')
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('::ffff:192.168.1.1'))), false, 'IPv4-mapped')
})

test('hasGlobalUnicastIPv6:⑦ Teredo 2001:0::/32 → false(细则 S1 假阳性)', () => {
  // Windows 上 Teredo 常自动启用,落在 2000::/3 内但只是 IPv4 之上的隧道
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('2001:0:2851:782c:38f7:1f4d:a5b1:7e2c'))), false)
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('2001::5efe:c0a8:101'))), false, '压缩写法同段')
  assert.equal(
    hasGlobalUnicastIPv6(ifaces(v6('2001:db8::1'))),
    true,
    '第二组非 0 → 不是 Teredo,仍算全局单播'
  )
})

test('hasGlobalUnicastIPv6:⑦ 6to4 2002::/16 → false(细则 S1 假阳性)', () => {
  assert.equal(hasGlobalUnicastIPv6(ifaces(v6('2002:c0a8:101::1'))), false)
})

test('hasGlobalUnicastIPv6:② IPv4 地址一律不算(公网 v4 也不算)', () => {
  assert.equal(hasGlobalUnicastIPv6(ifaces(v4('192.168.1.5'), v4('8.8.8.8'))), false)
})

test('hasGlobalUnicastIPv6:① internal 的 v6 被跳过', () => {
  assert.equal(
    hasGlobalUnicastIPv6(ifaces(v6('2001:db8:1234:5678::1', true))),
    false,
    'internal=true 的地址不参与判定(回环侧)'
  )
})

test('hasGlobalUnicastIPv6:② family 为数字 6 也认', () => {
  const addr: NetAddressLike = {
    address: '2001:db8:1234:5678::1',
    family: 6,
    internal: false
  }
  assert.equal(hasGlobalUnicastIPv6(ifaces(addr)), true, 'Node 跨版本 family 可能是数字')
})

test('hasGlobalUnicastIPv6:空接口表 → false;接口值为 undefined 不崩', () => {
  assert.equal(hasGlobalUnicastIPv6({}), false, '空表')
  assert.equal(hasGlobalUnicastIPv6({ 以太网: [] }), false, '空地址数组')
  assert.equal(
    hasGlobalUnicastIPv6({ 以太网: undefined, WLAN: [v6('2408::1')] }),
    true,
    'undefined 的接口跳过,其余照常判定'
  )
})

test('hasGlobalUnicastIPv6:多网卡任一命中即 true', () => {
  const table: NetInterfacesLike = {
    回环: [v6('::1', true)],
    以太网: [v6('fe80::abcd%12'), v4('192.168.1.5')],
    WLAN: [v6('2001:db8:1234:5678:9abc:def0:1234:5678')]
  }
  assert.equal(hasGlobalUnicastIPv6(table), true)
})

// ==================== summarizeInbound(三态汇总 · 对因子条数无假设) ====================

/** 造一条因子;`id` 允许传虚构值以模拟 v0.5 的第二条因子(接缝用例) */
function factor(verdict: InboundFactor['verdict'], id = 'publicIPv6'): InboundFactor {
  return { id: id as InboundFactor['id'], label: 'x', verdict, detail: 'x' }
}

test('summarizeInbound:单因子三态', () => {
  assert.equal(summarizeInbound([factor('supports')]), 'likely')
  assert.equal(summarizeInbound([factor('against')]), 'unlikely')
  assert.equal(summarizeInbound([factor('unknown')]), 'unknown')
})

test('summarizeInbound:空数组 → unknown(不猜)', () => {
  assert.equal(summarizeInbound([]), 'unknown')
})

test('⭐ summarizeInbound 接缝:两因子 against + supports → likely(锁死「对 N 条因子成立」)', () => {
  // 模拟 v0.5 接 UPnP 的形态:第一条公网 IPv6 反对、第二条端口映射支持。
  // 可达性是「或」关系 → 仍判 likely。**若将来有人把规则改成只看第一条因子,本用例立刻红**(spec §3.5)。
  const upnp = factor('supports', 'upnpMapping')
  assert.equal(summarizeInbound([factor('against'), upnp]), 'likely', 'against 在前也不遮蔽 supports')
  assert.equal(summarizeInbound([upnp, factor('against')]), 'likely', '顺序无关')
})

test('summarizeInbound:两因子全 against → unlikely', () => {
  assert.equal(summarizeInbound([factor('against'), factor('against', 'upnpMapping')]), 'unlikely')
})

test('summarizeInbound:against + unknown → unknown(非全部反对,不判不可达)', () => {
  assert.equal(summarizeInbound([factor('against'), factor('unknown', 'upnpMapping')]), 'unknown')
})

// ==================== collectInboundFactors / diagnoseInbound ====================

test('collectInboundFactors:有公网 IPv6 → supports;无 → against', () => {
  const yes = collectInboundFactors({
    readInterfaces: () => ifaces(v6('2001:db8:1234:5678::1')),
    now: () => 1000
  })
  assert.equal(yes.length, 1, 'v0.4 只有一条因子')
  assert.equal(yes[0].id, 'publicIPv6')
  assert.equal(yes[0].verdict, 'supports')
  assert.match(yes[0].detail, /检测到公网 IPv6 地址/)
  assert.match(yes[0].detail, /还取决于路由器与系统防火墙是否放行/, '后果必须带限定,不承诺打通')

  const no = collectInboundFactors({
    readInterfaces: () => ifaces(v6('fe80::1'), v4('192.168.1.5')),
    now: () => 1000
  })
  assert.equal(no[0].verdict, 'against')
  assert.match(no[0].detail, /未检测到公网 IPv6 地址/)
})

test('collectInboundFactors:readInterfaces 抛错 → unknown(不吞成 against)', () => {
  const factors = collectInboundFactors({
    readInterfaces: () => {
      throw new Error('EPERM')
    },
    now: () => 1000
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].verdict, 'unknown', '读不到 ≠ 没有')
  assert.match(factors[0].detail, /未能读取本机网络接口/)
})

test('诊断文案不含越界承诺(§7.6 措辞红线)', () => {
  const all = [
    ...collectInboundFactors({ readInterfaces: () => ifaces(v6('2408::1')), now: () => 0 }),
    ...collectInboundFactors({ readInterfaces: () => ifaces(v6('fe80::1')), now: () => 0 }),
    ...collectInboundFactors({
      readInterfaces: () => {
        throw new Error('x')
      },
      now: () => 0
    })
  ]
  const text = all.map((f) => f.detail).join('\n')
  for (const banned of ['提速', '加速', '保证', '更多节点', '就能上传']) {
    assert.equal(text.includes(banned), false, `文案不得出现「${banned}」`)
  }
})

test('diagnoseInbound:汇总 state + 注入时钟打 checkedAt', () => {
  const d = diagnoseInbound({
    readInterfaces: () => ifaces(v6('2001:db8:1234:5678::1')),
    now: () => 1_700_000_000_000
  })
  assert.equal(d.state, 'likely')
  assert.equal(d.checkedAt, 1_700_000_000_000, '时钟注入,不用真实时间')
  assert.equal(d.factors.length, 1)

  const off = diagnoseInbound({ readInterfaces: () => ({}), now: () => 1 })
  assert.equal(off.state, 'unlikely', '无任何网卡地址 → 唯一因子 against → unlikely')
})

test('diagnoseInbound:每次都实算(换网即得新结论,不缓存)', () => {
  let hasV6 = false
  const deps = {
    readInterfaces: (): NetInterfacesLike =>
      hasV6 ? ifaces(v6('2408::1')) : ifaces(v6('fe80::1')),
    now: () => 0
  }
  assert.equal(diagnoseInbound(deps).state, 'unlikely')
  hasV6 = true
  assert.equal(diagnoseInbound(deps).state, 'likely', '换网后同一 deps 立即给出新结论')
})
