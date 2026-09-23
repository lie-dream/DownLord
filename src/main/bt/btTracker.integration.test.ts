/**
 * tracker 热更新链路集成测试(v0.4 Task 1 · spec §7.1 集成表九行)。
 *
 * 注入 **fake HTTP + 内存 fs + 固定时钟 + 真 DownloadEngine(fake rpcClient)**,全链路离线跑:
 * 按需触发 → 双源堆叠 → 解析 / 合并 / 合格性 → 原子写 → `changeGlobalOption` + **追补**。
 *
 * 两条守门断言:
 * ① **成功路径**:`changeGlobalOption` 收到的是**远端合并表**,逐项断言**不含内置表独有条目**
 *    —— 这是 D6「远端为准整表替换、内置只兜底、绝不合并」的守门测试;
 * ② **失败路径**:两源全抛 → `maybeRefresh()` **不抛**、**零写盘**、`changeGlobalOption` **零调用**、
 *    生效表仍为内置 47 条。
 *
 * ⚠️ 本测试**测不到**的(D16 点名的 fake 盲区,归签收前置手测):真实源 URL 是否可达 / 仓库是否改了
 * 文件名或分支 / 真实文件的脏形态。喂自造假数据的测试必然自洽全绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BtTrackerService, BT_TRACKER_SOURCES, type BtTrackerStatus } from './btTrackerService'
import { createBtTrackerStore, type BtTrackerStoreFs } from './btTrackerStore'
import { DEFAULT_BT_TRACKERS } from '../engine/aria2Args'
import { DownloadEngine } from '../engine/downloadEngine'

const CACHE_PATH = '/userData/config/btTrackers.json'
/** 固定时钟基准(真实量级;`shouldCheckNow` 的窗口判定按差值,基准过小会假性命中退避) */
const T0 = 1_700_000_000_000

/** 内置表独有条目(远端表不含)——用于钉死「绝不与内置合并」 */
const BUILTIN_ONLY = 'udp://exodus.desync.com:6969/announce'

/** 远端 best.txt(域名版)12 条;含空行 / 注释 / CRLF,模拟真实文件形态 */
const REMOTE_BEST = [
  '# ngosang/trackerslist fake',
  '',
  ...Array.from({ length: 12 }, (_, i) => `udp://remote-best-${i}.example:6969/announce`)
].join('\r\n')

/** 远端 best_ip.txt(IP 版)6 条,其中 2 条与 best 重复(跨源去重) */
const REMOTE_BEST_IP = [
  ...Array.from({ length: 4 }, (_, i) => `udp://10.0.0.${i}:6969/announce`),
  'udp://remote-best-0.example:6969/announce',
  'udp://remote-best-1.example:6969/announce'
].join('\n')

/** 合并后应得的条数:12(best) + 4(best_ip 独有) = 16 */
const EXPECTED_MERGED = 16

// ========== fake 依赖 ==========

interface FakeHttp {
  proxyCalls: (string | null)[]
  urls: string[]
  configureProxy(effectiveUrl: string | null): Promise<void>
  getText(url: string): Promise<string>
}

/** fake HTTP:按 URL 查表;值为 Error → 抛(模拟不可达 / 非 2xx);未登记 → 抛 `HTTP 404` */
function createFakeHttp(table: Record<string, string | Error>): FakeHttp {
  return {
    proxyCalls: [],
    urls: [],
    async configureProxy(effectiveUrl: string | null): Promise<void> {
      this.proxyCalls.push(effectiveUrl)
    },
    async getText(url: string): Promise<string> {
      this.urls.push(url)
      const hit = table[url]
      if (hit === undefined) throw new Error('HTTP 404')
      if (hit instanceof Error) throw hit
      return hit
    }
  }
}

/** 两源全通的响应表(键用**真实源常量**,顺带钉死 service 确实按 jsDelivr → GitHub raw 的顺序请求) */
function allSourcesOk(): Record<string, string | Error> {
  return {
    [BT_TRACKER_SOURCES[0].best]: REMOTE_BEST,
    [BT_TRACKER_SOURCES[0].bestIp]: REMOTE_BEST_IP,
    [BT_TRACKER_SOURCES[1].best]: REMOTE_BEST,
    [BT_TRACKER_SOURCES[1].bestIp]: REMOTE_BEST_IP
  }
}

/** 两源全抛的响应表 */
function allSourcesFail(): Record<string, string | Error> {
  const err = (): Error => new Error('net::ERR_CONNECTION_TIMED_OUT')
  return {
    [BT_TRACKER_SOURCES[0].best]: err(),
    [BT_TRACKER_SOURCES[0].bestIp]: err(),
    [BT_TRACKER_SOURCES[1].best]: err(),
    [BT_TRACKER_SOURCES[1].bestIp]: err()
  }
}

interface MemoryFs extends BtTrackerStoreFs {
  files: Map<string, string>
  writes: number
  failWrite: boolean
}

/** 内存 fs(原子写 tmp → rename);`failWrite=true` 模拟写盘失败(§4.5 #7) */
function createMemoryFs(seed: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    writes: 0,
    failWrite: false,
    async readFile(path: string): Promise<string> {
      const hit = files.get(path)
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
    async writeFile(path: string, data: string): Promise<void> {
      if (this.failWrite) throw new Error('EACCES: permission denied')
      files.set(path, data)
      this.writes++
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      const hit = files.get(oldPath)
      if (hit === undefined) throw new Error('rename: source missing')
      files.set(newPath, hit)
      files.delete(oldPath)
    },
    async mkdir(): Promise<void> {
      /* 内存 fs 无目录树 */
    }
  }
}

/** fake rpcClient 记录(注入真 DownloadEngine 的私有位,避免起真 aria2) */
interface FakeRpc {
  globalCalls: Record<string, string>[]
  optionCalls: Array<{ gid: string; options: Record<string, string> }>
  failGlobal: boolean
  failGids: Set<string>
  changeGlobalOption(options: Record<string, string>): Promise<void>
  changeOption(gid: string, options: Record<string, string>): Promise<void>
}

/** 引擎内部私有位的最小面(仿 `engine/integration.test.ts` 的 `as unknown as` 取内部状态) */
interface EngineInternals {
  rpcClient: FakeRpc | null
  idToTask: Map<string, { id: string; gid?: string; isTorrent?: boolean; url: string; dir: string }>
}

/**
 * 真 `DownloadEngine` + fake rpcClient:能真正断言「追补只发给 torrent 且有 gid 的任务」
 * (fake engine 做不到 —— 筛选逻辑正是被测对象)。不启动 aria2 子进程。
 */
function createEngineHarness(): { engine: DownloadEngine; rpc: FakeRpc } {
  const rpc: FakeRpc = {
    globalCalls: [],
    optionCalls: [],
    failGlobal: false,
    failGids: new Set<string>(),
    async changeGlobalOption(options): Promise<void> {
      if (this.failGlobal) throw new Error('aria2 rpc unavailable')
      this.globalCalls.push(options)
    },
    async changeOption(gid, options): Promise<void> {
      if (this.failGids.has(gid)) throw new Error(`GID#${gid} not found`)
      this.optionCalls.push({ gid, options })
    }
  }

  const engine = new DownloadEngine(
    // 只测 applyBtTrackers,不 start():进程依赖给空壳即可
    { aria2ProcessDeps: {} as never },
    { aria2cPath: '/fake/aria2c', defaultDir: '/downloads' }
  )
  const internals = engine as unknown as EngineInternals
  internals.rpcClient = rpc
  // 三个 torrent(其一无 gid:元数据尚未提交)+ 一个直链任务
  internals.idToTask.set('t1', {
    id: 't1',
    gid: 'gid-t1',
    isTorrent: true,
    url: 'magnet:?xt=1',
    dir: '/d'
  })
  internals.idToTask.set('t2', {
    id: 't2',
    gid: 'gid-t2',
    isTorrent: true,
    url: 'magnet:?xt=2',
    dir: '/d'
  })
  internals.idToTask.set('t3', { id: 't3', isTorrent: true, url: 'magnet:?xt=3', dir: '/d' })
  internals.idToTask.set('h1', {
    id: 'h1',
    gid: 'gid-h1',
    url: 'https://example.com/a.zip',
    dir: '/d'
  })

  return { engine, rpc }
}

interface Harness {
  service: BtTrackerService
  http: FakeHttp
  fs: MemoryFs
  rpc: FakeRpc
  applied: string[][]
  statuses: BtTrackerStatus[]
  logs: string[]
  setNow(t: number): void
}

function createHarness(opts: {
  table: Record<string, string | Error>
  seedFiles?: Record<string, string>
  enabled?: boolean
}): Harness {
  const http = createFakeHttp(opts.table)
  const fs = createMemoryFs(opts.seedFiles)
  const { engine, rpc } = createEngineHarness()
  const applied: string[][] = []
  const statuses: BtTrackerStatus[] = []
  const logs: string[] = []
  let now = T0

  const service = new BtTrackerService({
    http,
    getProxy: () => ({ effectiveUrl: 'http://127.0.0.1:7890' }),
    store: createBtTrackerStore(CACHE_PATH, fs),
    now: () => now,
    applyToEngine: (t) => engine.applyBtTrackers(t),
    isEnabled: () => opts.enabled !== false,
    onApplied: (t) => applied.push([...t]),
    onStatus: (s) => statuses.push(s),
    log: (msg) => logs.push(msg)
  })

  return {
    service,
    http,
    fs,
    rpc,
    applied,
    statuses,
    logs,
    setNow: (t) => {
      now = t
    }
  }
}

/** 取最后一次广播的状态 */
function lastStatus(h: Harness): BtTrackerStatus {
  assert.ok(h.statuses.length > 0, '应至少广播一次状态')
  return h.statuses[h.statuses.length - 1]
}

// ========== ① 成功路径 ==========

test('集成 · 成功路径:整表替换(远端合并表,绝不含内置表条目)+ 落盘 + 追补', async () => {
  const h = createHarness({ table: allSourcesOk() })

  await h.service.maybeRefresh()

  // 拉取前跟随代理三档(D12),且首个请求打的是 jsDelivr 主源
  assert.deepEqual(h.http.proxyCalls, ['http://127.0.0.1:7890'])
  assert.equal(h.http.urls[0], BT_TRACKER_SOURCES[0].best)
  // 第一组即合格 → 不再试第二组(堆叠语义:任一组拿到合格表即停)
  assert.equal(h.http.urls.length, 2)

  // ⭐ 守门断言:changeGlobalOption 收到的是**远端合并表**
  assert.equal(h.rpc.globalCalls.length, 1)
  const csv = h.rpc.globalCalls[0]['bt-tracker']
  const pushed = csv.split(',')
  assert.equal(pushed.length, EXPECTED_MERGED)
  // 逐项断言不含内置表独有条目 —— 远端为准整表替换,内置**不参与合并**(D6)
  assert.ok(!pushed.includes(BUILTIN_ONLY), '生效表不得含内置表独有条目')
  for (const entry of pushed) {
    assert.ok(
      !DEFAULT_BT_TRACKERS.includes(entry),
      `生效表混入了内置表条目(说明发生了合并):${entry}`
    )
  }
  // best 在前、best_ip 在后;跨源重复只留首现
  assert.equal(pushed[0], 'udp://remote-best-0.example:6969/announce')
  assert.equal(pushed[12], 'udp://10.0.0.0:6969/announce')

  // ⭐ 追补:只发给 **torrent 且有 gid** 的任务;直链任务与无 gid 的 torrent 都没发
  assert.deepEqual(
    h.rpc.optionCalls.map((c) => c.gid),
    ['gid-t1', 'gid-t2']
  )
  assert.equal(h.rpc.optionCalls[0].options['bt-tracker'], csv)

  // 落盘:三字段齐备且自包含(表与时间戳同一次写)
  assert.equal(h.fs.writes, 1)
  const saved = JSON.parse(h.fs.files.get(CACHE_PATH)!)
  assert.equal(saved.updatedAt, T0)
  assert.deepEqual(saved.sourceUrls, [BT_TRACKER_SOURCES[0].best, BT_TRACKER_SOURCES[0].bestIp])
  assert.equal(saved.trackers.length, EXPECTED_MERGED)

  // 生效表回写 + 状态如实
  assert.deepEqual(h.applied, [saved.trackers])
  const s = lastStatus(h)
  assert.equal(s.state, 'ok')
  assert.equal(s.usingBuiltin, false)
  assert.equal(s.count, EXPECTED_MERGED)
  assert.equal(s.updatedAt, T0)
  assert.equal(s.lastError, null)
  assert.equal(s.busy, false)
})

// ========== ② 失败路径 ==========

test('集成 · 失败路径:两源全抛 → 不抛 / 零写盘 / 零 push / 生效表仍为内置 47 条', async () => {
  const h = createHarness({ table: allSourcesFail() })

  // ⭐ 守门断言:await 不 reject
  await h.service.maybeRefresh()

  assert.equal(h.http.urls.length, 4, '两组四个文件都试过')
  assert.equal(h.fs.writes, 0, '失败绝不写盘')
  assert.equal(h.rpc.globalCalls.length, 0, '失败绝不 push')
  assert.equal(h.rpc.optionCalls.length, 0)
  assert.equal(h.applied.length, 0)

  const s = lastStatus(h)
  assert.equal(s.state, 'failed')
  assert.equal(s.usingBuiltin, true)
  assert.equal(s.count, DEFAULT_BT_TRACKERS.length)
  assert.equal(s.count, 47, '生效表退回内置 47 条')
  assert.ok(s.lastError && s.lastError.length > 0, 'lastError 非空(诚实短原因)')
  assert.ok(
    h.logs.some((l) => l.startsWith('[bt-tracker] fetch failed: ')),
    '#1/#2 每个源各记一条 fetch failed'
  )
  assert.ok(
    h.logs.some((l) => l.includes('all sources failed, keep current list (47 entries, builtin=true)')),
    '#3 记 all sources failed 并如实报当前生效表'
  )
})

// ========== ③ 条数不足 ==========

test('集成 · 合并后 9 条(<10)→ 判失败:零写盘、零 push、updatedAt 不变', async () => {
  const nine = Array.from(
    { length: 9 },
    (_, i) => `udp://too-few-${i}.example:6969/announce`
  ).join('\n')
  const table: Record<string, string | Error> = {
    [BT_TRACKER_SOURCES[0].best]: nine,
    [BT_TRACKER_SOURCES[0].bestIp]: '',
    [BT_TRACKER_SOURCES[1].best]: nine,
    [BT_TRACKER_SOURCES[1].bestIp]: ''
  }
  const h = createHarness({ table })

  await h.service.maybeRefresh()

  assert.equal(h.fs.writes, 0)
  assert.equal(h.rpc.globalCalls.length, 0)
  assert.equal(h.rpc.optionCalls.length, 0)
  const s = lastStatus(h)
  assert.equal(s.state, 'failed')
  assert.equal(s.updatedAt, 0, 'updatedAt 不更新(否则被 12h 节流锁死)')
  assert.equal(s.count, 47)
  assert.ok(
    h.logs.some((l) => l === '[bt-tracker] merged 9 entries < min 10, discard'),
    '#6 记条数不足'
  )
  assert.ok(
    h.logs.some((l) => l.startsWith('[bt-tracker] source empty: ')),
    '#4 空内容源单独记日志、不单独判失败'
  )
})

// ========== ④ 写盘失败(§4.5 #7)==========

test('集成 · 写盘失败 → 仍 push,且 updatedAt 不更新', async () => {
  const h = createHarness({ table: allSourcesOk() })
  h.fs.failWrite = true

  await h.service.maybeRefresh()

  assert.equal(h.fs.writes, 0)
  assert.equal(h.rpc.globalCalls.length, 1, '写盘失败不放弃本次收益,仍 push')
  assert.equal(h.applied.length, 1)
  const s = lastStatus(h)
  assert.equal(s.state, 'ok')
  assert.equal(s.count, EXPECTED_MERGED)
  assert.equal(s.updatedAt, 0, '写盘失败 → updatedAt 不更新(下次重试写盘)')
  assert.ok(s.lastError && s.lastError.includes('未能保存到磁盘'), '状态行如实说明重启后会回退')
  assert.ok(h.logs.some((l) => l.startsWith('[bt-tracker] persist failed: ')))
})

// ========== ⑤ 追补单条失败(§4.5 #9)==========

test('集成 · 追补单条失败 → 其余仍下发、整体不抛、failed 计数如实', async () => {
  const h = createHarness({ table: allSourcesOk() })
  h.rpc.failGids.add('gid-t1')

  await h.service.maybeRefresh()

  assert.deepEqual(
    h.rpc.optionCalls.map((c) => c.gid),
    ['gid-t2'],
    '失败的 gid-t1 不牵连 gid-t2'
  )
  const s = lastStatus(h)
  assert.equal(s.state, 'ok', '追补失败不影响整体成功判定')
  assert.ok(
    h.logs.some((l) => l.includes('patched=1, failed=1')),
    '计数如实记入日志(追补细节不进状态行,§4.6)'
  )
})

test('集成 · changeGlobalOption 失败(§4.5 #8)→ 仍继续追补,状态如实附注', async () => {
  const h = createHarness({ table: allSourcesOk() })
  h.rpc.failGlobal = true

  await h.service.maybeRefresh()

  assert.equal(h.rpc.globalCalls.length, 0)
  assert.deepEqual(
    h.rpc.optionCalls.map((c) => c.gid),
    ['gid-t1', 'gid-t2'],
    '全局值失败不中断追补(两者独立)'
  )
  assert.equal(h.fs.writes, 1, '表仍已落盘,下次启动经 pull 生效')
  const s = lastStatus(h)
  assert.equal(s.state, 'ok')
  assert.ok(s.lastError && s.lastError.includes('重启'), '状态行如实说明需重启才对新任务生效')
})

// ========== ⑥ 节流(12h / 30min)==========

test('集成 · 12h 内零 HTTP;30min 失败退避内零 HTTP', async () => {
  // 缓存 1 小时前刚成功 → 12h 节流内
  const fresh = JSON.stringify({
    updatedAt: T0 - 60 * 60 * 1000,
    sourceUrls: ['https://fake/best.txt'],
    trackers: Array.from({ length: 20 }, (_, i) => `udp://cached-${i}.example:6969/announce`)
  })
  const h = createHarness({ table: allSourcesOk(), seedFiles: { [CACHE_PATH]: fresh } })

  await h.service.maybeRefresh()
  assert.equal(h.http.urls.length, 0, '12h 节流内零外联')
  assert.equal(h.fs.writes, 0)

  // 30min 失败退避:先让一次拉取失败,再在 10 分钟后重试
  const h2 = createHarness({ table: allSourcesFail() })
  await h2.service.maybeRefresh()
  const afterFirst = h2.http.urls.length
  assert.equal(afterFirst, 4)
  h2.setNow(T0 + 10 * 60 * 1000)
  await h2.service.maybeRefresh()
  assert.equal(h2.http.urls.length, afterFirst, '30min 退避内零 HTTP')
  // 退避窗口过后可重试(保证「今天网络恢复今天就能拉到」)
  h2.setNow(T0 + 31 * 60 * 1000)
  await h2.service.maybeRefresh()
  assert.equal(h2.http.urls.length, afterFirst + 4, '退避过期后重试')
})

// ========== ⑦ 手动通道 ==========

test('集成 · updateNow() 无视节流与开关,必发 HTTP', async () => {
  const fresh = JSON.stringify({
    updatedAt: T0 - 60 * 1000, // 1 分钟前刚更新过
    sourceUrls: ['https://fake/best.txt'],
    trackers: ['udp://cached-0.example:6969/announce']
  })
  const h = createHarness({
    table: allSourcesOk(),
    seedFiles: { [CACHE_PATH]: fresh },
    enabled: false // 开关关闭
  })

  const status = await h.service.updateNow()

  assert.equal(h.http.urls.length, 2, '手动路径无视 12h 节流与开关,照常拉取')
  assert.equal(h.rpc.globalCalls.length, 1)
  assert.equal(h.fs.writes, 1)
  assert.equal(status.count, EXPECTED_MERGED)
})

// ========== ⑧ 开关关闭 ==========

test('集成 · 开关关闭 → maybeRefresh 零 HTTP、零写盘、零 push', async () => {
  const h = createHarness({ table: allSourcesOk(), enabled: false })

  await h.service.maybeRefresh()

  assert.equal(h.http.urls.length, 0, '零外联')
  assert.equal(h.http.proxyCalls.length, 0)
  assert.equal(h.fs.writes, 0)
  assert.equal(h.rpc.globalCalls.length, 0)
  assert.equal(h.logs.length, 0, '#10 不记日志(无事发生)')
  const s = await h.service.getStatus()
  assert.equal(s.state, 'disabled')
  assert.equal(s.usingBuiltin, true)
  assert.equal(s.count, 47)
})

// ========== ⑨ 缓存损坏 ==========

test('集成 · btTrackers.json 损坏 → read() 回退默认不抛,生效表 = 内置 47 条', async () => {
  const h = createHarness({
    table: allSourcesFail(),
    seedFiles: { [CACHE_PATH]: '{ 这不是 JSON' }
  })

  const before = await h.service.getStatus()
  assert.equal(before.usingBuiltin, true)
  assert.equal(before.count, 47)
  assert.equal(before.state, 'never')

  // 损坏文件不阻断后续链路(拉取失败也只是退内置,不抛)
  await h.service.maybeRefresh()
  assert.equal(lastStatus(h).count, 47)

  // 结构非法(字段类型错)同样回退
  const h2 = createHarness({
    table: allSourcesFail(),
    seedFiles: { [CACHE_PATH]: JSON.stringify({ updatedAt: 'x', sourceUrls: [], trackers: [1] }) }
  })
  const s2 = await h2.service.getStatus()
  assert.equal(s2.count, 47)
  assert.equal(s2.updatedAt, 0)
})
