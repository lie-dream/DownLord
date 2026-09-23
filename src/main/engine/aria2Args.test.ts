import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAria2Args, DEFAULT_BT_TRACKERS } from './aria2Args'

const BASE = {
  port: 16800,
  secret: 'test-secret',
  dir: 'D:\\Downloads',
  mainPid: 4321
}

/**
 * `buildAria2Args(BASE)` 的**参数快照**(零回归基准)。
 * v0.4 Task 1 起兼作 pull 通道的钉子:不传 / 传空 `btTrackers` 时输出必须与本快照逐字节相同,
 * 任何参数增删改都得显式改这里(改不动 = 回归被挡住)。
 */
const EXPECTED_BASE_ARGS: string[] = [
  '--enable-rpc',
  '--rpc-listen-port=16800',
  '--rpc-listen-all=false',
  '--rpc-secret=test-secret',
  '--continue=true',
  '--max-connection-per-server=16',
  '--split=16',
  '--min-split-size=1M',
  '--file-allocation=none',
  '--connect-timeout=10',
  '--dir=D:\\Downloads',
  '--stop-with-process=4321',
  // =1(每秒保存 .aria2):aria2 语义 0 = 下载期间不保存(仅 stop 时),崩溃续传会失效(§7.4)
  '--auto-save-interval=1',
  // 与设置页并发上限(validateSettings MAX_CONCURRENT_MAX=10)同源,防 aria2 默认 5 卡住第 6-10 个任务
  '--max-concurrent-downloads=10',
  // BT 引导(v0.3 Task 1 · 2026-07-22 真机修订 · spec §4.2):DHT 冷启动引导 + 默认 tracker,只对 BT 生效
  '--enable-dht=true',
  '--dht-entry-point=router.bittorrent.com:6881',
  '--enable-peer-exchange=true',
  '--bt-enable-lpd=true',
  `--bt-tracker=${DEFAULT_BT_TRACKERS.join(',')}`,
  // BT 连通性四件套(v0.3 Task 2 · 2026-07-25 真机修订 · spec §14):固定高位端口 / IPv6 DHT /
  // tracker 快超时 / Transmission 伪装 + peer 池扩容,全部只对 BT 生效
  '--listen-port=52301-52310',
  '--dht-listen-port=52311-52320',
  '--enable-dht6=true',
  '--dht-entry-point6=dht.transmissionbt.com:6881',
  '--bt-tracker-connect-timeout=10',
  '--bt-tracker-timeout=10',
  '--peer-agent=Transmission/3.00',
  '--peer-id-prefix=-TR3000-',
  '--bt-max-peers=128'
]

test('buildAria2Args returns the aria2c RPC and resume arguments from the spec', () => {
  const args = buildAria2Args(BASE)

  assert.deepEqual(args, EXPECTED_BASE_ARGS)
})

// ==================== BT 引导启动参数(v0.3 Task 1 · 2026-07-22 真机修订 · spec §4.2)====================

test('buildAria2Args: 含 DHT 冷启动引导 + PEX + LPD + 默认 tracker(纯磁力取元数据必需)', () => {
  const args = buildAria2Args({ port: 16800, secret: 's', dir: 'D:\\DL', mainPid: 1 })
  assert.ok(args.includes('--enable-dht=true'), '显式开 DHT')
  assert.ok(
    args.includes('--dht-entry-point=router.bittorrent.com:6881'),
    'DHT 冷启动引导节点(缺此则 DHT 不加入网络,无 tracker 磁力卡死)'
  )
  assert.ok(args.includes('--enable-peer-exchange=true'), '开 PEX')
  assert.ok(args.includes('--bt-enable-lpd=true'), '开本地 peer 发现')
  const tracker = args.find((a) => a.startsWith('--bt-tracker='))
  assert.ok(tracker, '带默认 tracker 表')
  assert.ok(tracker!.includes('udp://tracker.opentrackr.org:1337/announce'), 'tracker 表含公共 udp')
  assert.ok(tracker!.includes('http://'), 'tracker 表含 http(可经 all-proxy 走代理)')
})

test('DEFAULT_BT_TRACKERS: 非空、去重、均为合法 tracker URL', () => {
  assert.ok(DEFAULT_BT_TRACKERS.length > 0, '非空')
  assert.equal(new Set(DEFAULT_BT_TRACKERS).size, DEFAULT_BT_TRACKERS.length, '无重复')
  for (const t of DEFAULT_BT_TRACKERS) {
    assert.match(t, /^(udp|https?):\/\/.+\/announce$/, `合法 tracker: ${t}`)
  }
})

// ==================== BT 连通性四件套(v0.3 Task 2 · 2026-07-25 真机修订 · spec §14)====================

test('buildAria2Args: 固定高位 BT 端口 + IPv6 DHT + tracker 快超时 + Transmission 伪装(C1 正文 0 速修订)', () => {
  const args = buildAria2Args({ port: 16800, secret: 's', dir: 'D:\\DL', mainPid: 1 })
  assert.ok(
    args.includes('--listen-port=52301-52310'),
    'BT TCP 固定高位段(避开被干扰的默认 6881-6999)'
  )
  assert.ok(args.includes('--dht-listen-port=52311-52320'), 'DHT UDP 固定高位段')
  assert.ok(args.includes('--enable-dht6=true'), 'IPv6 DHT(大陆家宽 v6 直连常是分水岭)')
  assert.ok(args.includes('--dht-entry-point6=dht.transmissionbt.com:6881'), 'IPv6 DHT 引导节点')
  assert.ok(
    args.includes('--bt-tracker-connect-timeout=10'),
    'tracker 连接快超时(默认 60s 逐死条目长挂)'
  )
  assert.ok(args.includes('--bt-tracker-timeout=10'), 'tracker announce 快超时')
  assert.ok(
    args.includes('--peer-agent=Transmission/3.00'),
    'peer agent 伪装(aria2 身份被部分 peer 歧视拒连)'
  )
  assert.ok(args.includes('--peer-id-prefix=-TR3000-'), 'peer id 前缀同步伪装')
  assert.ok(args.includes('--bt-max-peers=128'), 'peer 池上限 55 → 128')
})

test('DEFAULT_BT_TRACKERS: 扩充表含域名版 + IP 直连版 + 国内可达 http(s)(ngosang best/best_ip 合并)', () => {
  assert.ok(DEFAULT_BT_TRACKERS.length >= 40, `合并表 ≥ 40 条(实际 ${DEFAULT_BT_TRACKERS.length})`)
  assert.ok(
    DEFAULT_BT_TRACKERS.some((t) => /^udp:\/\/\d+\.\d+\.\d+\.\d+:/.test(t)),
    '含 IP 直连版条目(不经 DNS,抗污染)'
  )
  assert.ok(
    DEFAULT_BT_TRACKERS.includes('http://open.acgnxtracker.com:80/announce'),
    '保留旧表国内可达条目'
  )
})

test('buildAria2Args: dhtFilePath6 有值 → 追加 --dht-file-path6(缺省不加,与 v4 语义一致)', () => {
  const base = buildAria2Args({ port: 16800, secret: 's', dir: 'D:\\DL', mainPid: 1 })
  assert.ok(!base.some((a) => a.startsWith('--dht-file-path6')), '缺省不加 v6 持久化参数')
  const args = buildAria2Args({
    port: 16800,
    secret: 's',
    dir: 'D:\\DL',
    mainPid: 1,
    dhtFilePath6: 'C:\\UserData\\dht6.dat'
  })
  assert.deepEqual(args, [...base, '--dht-file-path6=C:\\UserData\\dht6.dat'], '仅末尾多一个参数')
})

// ==================== DHT 路由表持久化(v0.3 Task 1 · 2026-07-22 真机修订三 · spec §4.2)====================

test('buildAria2Args: dhtFilePath 缺省 → 无 --dht-file-path(零回归)', () => {
  const args = buildAria2Args({ port: 16800, secret: 's', dir: 'D:\\DL', mainPid: 1 })
  assert.ok(
    !args.some((a) => a.startsWith('--dht-file-path')),
    '缺省不加持久化参数(与此前逐字节等价)'
  )
})

test('buildAria2Args: dhtFilePath 有值 → 追加 --dht-file-path=<path>(其余不变)', () => {
  const base = buildAria2Args({ port: 16800, secret: 's', dir: 'D:\\DL', mainPid: 1 })
  const args = buildAria2Args({
    port: 16800,
    secret: 's',
    dir: 'D:\\DL',
    mainPid: 1,
    dhtFilePath: 'C:\\UserData\\dht.dat'
  })
  assert.deepEqual(args, [...base, '--dht-file-path=C:\\UserData\\dht.dat'], '仅末尾多一个参数')
})

// ==================== 全局限速启动初值(v0.2 Task 2 · spec §2.2 / §7.1)====================

// v1.0 Task 8 · #100(C3–C5):启动初值改为 `--max-download-limit`(每任务默认上限的初值),字段名沿用 settings 键。
test('T8-A03 buildAria2Args: maxOverallLimitKBps 缺省 → 无 --max-download-limit(逐字节等价 v0.1)', () => {
  const args = buildAria2Args(BASE)
  assert.ok(!args.some((a) => a.startsWith('--max-download-limit')), '缺省不加限速参数')
})

test('T8-A03 buildAria2Args: maxOverallLimitKBps=0(不限)→ 无 --max-download-limit(逐字节等价 v0.1)', () => {
  const args = buildAria2Args({ ...BASE, maxOverallLimitKBps: 0 })
  // 0 与缺省输出完全一致(零回归)
  assert.deepEqual(args, buildAria2Args(BASE))
})

test('T8-A03 buildAria2Args: maxOverallLimitKBps=500 → 追加 --max-download-limit=500K(其余不变)', () => {
  const args = buildAria2Args({ ...BASE, maxOverallLimitKBps: 500 })
  assert.ok(args.includes('--max-download-limit=500K'), '含启动限速初值')
  // 仅在基准末尾多一个限速参数,其余逐字节等价
  assert.deepEqual(args, [...buildAria2Args(BASE), '--max-download-limit=500K'])
})

test('T8-A03 buildAria2Args: 缺省 / 0 与 EXPECTED_BASE_ARGS 逐字节相同且无任何限速前缀;500 仅末尾多 --max-download-limit=500K', () => {
  for (const input of [BASE, { ...BASE, maxOverallLimitKBps: 0 }]) {
    const args = buildAria2Args(input)
    assert.deepEqual(args, EXPECTED_BASE_ARGS, '缺省 / 0 输出与快照逐字节相同(I-4)')
    assert.ok(
      !args.some(
        (a) => a.startsWith('--max-download-limit') || a.startsWith('--max-overall-download-limit')
      ),
      '缺省 / 0 不出现任何限速参数(新键与旧键都不出现)'
    )
  }
  const limited = buildAria2Args({ ...BASE, maxOverallLimitKBps: 500 })
  assert.deepEqual(
    limited,
    [...EXPECTED_BASE_ARGS, '--max-download-limit=500K'],
    '仅末尾多一个新键参数'
  )
  assert.ok(
    !limited.some((a) => a.includes('max-overall-download-limit')),
    '不再下发总量硬上限(I-1)'
  )
})

// ==================== BT tracker pull 通道(v0.4 Task 1 · spec §4.2 / §7.1)====================

test('buildAria2Args: 不传 btTrackers → 与既有参数快照 deepEqual(逐字节零回归钉子)', () => {
  const args = buildAria2Args(BASE)
  assert.deepEqual(args, EXPECTED_BASE_ARGS, '缺省与 v0.3 输出逐字节等价')
  assert.ok(
    args.includes(`--bt-tracker=${DEFAULT_BT_TRACKERS.join(',')}`),
    '缺省用内置表(拉取失败时的唯一退路,常量不可删)'
  )
})

test('buildAria2Args: btTrackers=[] → 回退内置表,输出仍与快照 deepEqual(零回归)', () => {
  assert.deepEqual(buildAria2Args({ ...BASE, btTrackers: [] }), EXPECTED_BASE_ARGS)
})

test('buildAria2Args: btTrackers 非空 → --bt-tracker= 换成缓存表(整表替换),其余参数一字不变', () => {
  const cached = [
    'udp://cached-a.example.com:6969/announce',
    'http://cached-b.example.com:1337/announce'
  ]
  const args = buildAria2Args({ ...BASE, btTrackers: cached })
  const expected = EXPECTED_BASE_ARGS.map((a) =>
    a.startsWith('--bt-tracker=') ? `--bt-tracker=${cached.join(',')}` : a
  )
  assert.deepEqual(args, expected, '仅 --bt-tracker= 的值变了:位置 / 数量 / 其余参数一字不变')

  const tracker = args.find((a) => a.startsWith('--bt-tracker='))!
  assert.equal(tracker, `--bt-tracker=${cached.join(',')}`)
  assert.ok(
    !tracker.includes('exodus.desync.com'),
    '整表替换而非与内置表合并(D6:合并会让快照里的死条目永不淘汰)'
  )
  assert.ok(
    args.includes('--bt-tracker-connect-timeout=10') && args.includes('--bt-tracker-timeout=10'),
    'BT 四件套等既有参数不受影响'
  )
})
