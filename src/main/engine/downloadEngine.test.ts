import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'

import { DownloadEngine } from './downloadEngine'
import type { DownloadProgress, ProxyResolved } from '../../shared/ipc'

test('DownloadEngine can start and stop', async () => {
  // 此测试需要真实 aria2c 二进制，跳过（集成测试）
  // 仅验证类型和接口
  const engine = new DownloadEngine(
    {
      aria2ProcessDeps: { spawn, net, crypto }
    },
    {
      aria2cPath: '/path/to/aria2c',
      defaultDir: '/tmp'
    }
  )

  assert.ok(engine)
  assert.equal(typeof engine.start, 'function')
  assert.equal(typeof engine.stop, 'function')
  assert.equal(typeof engine.addUri, 'function')
  assert.equal(typeof engine.pause, 'function')
  assert.equal(typeof engine.resume, 'function')
  assert.equal(typeof engine.remove, 'function')
  assert.equal(typeof engine.list, 'function')
  assert.equal(typeof engine.onProgress, 'function')
})

test('DownloadEngine list returns empty array initially', () => {
  const engine = new DownloadEngine(
    {
      aria2ProcessDeps: { spawn, net, crypto }
    },
    {
      aria2cPath: '/path/to/aria2c',
      defaultDir: '/tmp'
    }
  )

  const tasks = engine.list()
  assert.deepEqual(tasks, [])
})

test('DownloadEngine onProgress returns unsubscribe function', () => {
  const engine = new DownloadEngine(
    {
      aria2ProcessDeps: { spawn, net, crypto }
    },
    {
      aria2cPath: '/path/to/aria2c',
      defaultDir: '/tmp'
    }
  )

  const unsubscribe = engine.onProgress(() => {
    // noop
  })

  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
})

// ============ 代理注入(Task 7 · spec §4.1:addUri options 注入任务级 all-proxy)============

interface CapturedAddUri {
  urls: string[]
  options: Record<string, unknown>
}

/**
 * 构造一个注入「捕获式 fake rpcClient」的引擎,免真 aria2c / 免 start:
 * 直接替换私有 rpcClient 捕获 addUri 的 options,断言 all-proxy 注入。
 * addUri 会启动进度轮询定时器,故 pollInterval 设极大且测试末 cleanup 调私有 stopPolling 清理。
 */
function makeCaptureEngine(getProxy?: () => ProxyResolved): {
  engine: DownloadEngine
  captured: CapturedAddUri[]
  cleanup: () => void
} {
  const captured: CapturedAddUri[] = []
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto }, getProxy },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp', pollInterval: 1_000_000 }
  )
  const internal = engine as unknown as {
    rpcClient: { addUri(urls: string[], options: Record<string, unknown>): Promise<string> }
    stopPolling(): void
  }
  internal.rpcClient = {
    async addUri(urls, options) {
      captured.push({ urls, options })
      return `gid_${captured.length}`
    }
  }
  return { engine, captured, cleanup: () => internal.stopPolling() }
}

test('DownloadEngine.addUri injects all-proxy from getProxy (manual → 用户值)', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine(() => ({
    mode: 'manual',
    effectiveUrl: 'http://127.0.0.1:7890',
    systemDetected: null
  }))
  try {
    await engine.addUri({ url: 'http://x', dir: '/d' })
    assert.equal(captured[0].options['all-proxy'], 'http://127.0.0.1:7890')
  } finally {
    cleanup()
  }
})

test('DownloadEngine.addUri injects all-proxy "" for direct (effectiveUrl null,显式关闭)', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine(() => ({
    mode: 'direct',
    effectiveUrl: null,
    systemDetected: null
  }))
  try {
    await engine.addUri({ url: 'http://x', dir: '/d' })
    assert.equal(
      captured[0].options['all-proxy'],
      '',
      'direct → all-proxy 空串(杜绝继承 aria2 进程级 / 环境 HTTP_PROXY)'
    )
  } finally {
    cleanup()
  }
})

test('DownloadEngine.addUri sets all-proxy "" even without getProxy injected (合规默认关闭)', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine()
  try {
    await engine.addUri({ url: 'http://x', dir: '/d' })
    assert.equal(captured[0].options['all-proxy'], '')
  } finally {
    cleanup()
  }
})

test('DownloadEngine.addUri reads current proxy each call (切档即时生效)', async () => {
  let current: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }
  const { engine, captured, cleanup } = makeCaptureEngine(() => current)
  try {
    await engine.addUri({ url: 'http://a', dir: '/d' })
    assert.equal(captured[0].options['all-proxy'], '', '初始 direct → 空串')

    // 切档:回调返回值变更 → 下一次 addUri 实时读到新值
    current = { mode: 'manual', effectiveUrl: 'http://127.0.0.1:7890', systemDetected: null }
    await engine.addUri({ url: 'http://b', dir: '/d' })
    assert.equal(
      captured[1].options['all-proxy'],
      'http://127.0.0.1:7890',
      '切档后下一次 addUri 读到新值'
    )
  } finally {
    cleanup()
  }
})

test('DownloadEngine.addUri preserves dir / out alongside all-proxy', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine(() => ({
    mode: 'manual',
    effectiveUrl: 'http://127.0.0.1:7890',
    systemDetected: null
  }))
  try {
    await engine.addUri({ url: 'http://x', dir: '/d', filename: 'f.bin' })
    assert.equal(captured[0].options.dir, '/d')
    assert.equal(captured[0].options.out, 'f.bin')
    assert.equal(captured[0].options['all-proxy'], 'http://127.0.0.1:7890')
  } finally {
    cleanup()
  }
})

// ============ 全局 / 单任务限速(Task 2 · spec §2.2 / §2.3:changeGlobalOption / changeOption 动态即时)============

interface CapturedLimit {
  method: 'global' | 'task'
  gid?: string
  options: Record<string, string>
}

/**
 * 构造注入「捕获式 fake rpcClient」的引擎(带 addUri + changeGlobalOption + changeOption):
 * addUri 填 idToTask + gidToId(gid=`gid_N`),供 setTaskLimit 按 id → gid 路由;断言限速选项经对应 RPC 下发。
 * v1.0 Task 8 · #100:可选注入 `getSpeedLimit`(当前全局值),既有调用不传 = 行为不变。
 */
function makeLimitCaptureEngine(getSpeedLimit?: () => number): {
  engine: DownloadEngine
  limits: CapturedLimit[]
  cleanup: () => void
} {
  const limits: CapturedLimit[] = []
  let n = 0
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto }, getSpeedLimit },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp', pollInterval: 1_000_000 }
  )
  const internal = engine as unknown as {
    rpcClient: {
      addUri(urls: string[], options: Record<string, unknown>): Promise<string>
      changeGlobalOption(options: Record<string, string>): Promise<void>
      changeOption(gid: string, options: Record<string, string>): Promise<void>
    }
    stopPolling(): void
  }
  internal.rpcClient = {
    async addUri() {
      return `gid_${++n}`
    },
    async changeGlobalOption(options) {
      limits.push({ method: 'global', options })
    },
    async changeOption(gid, options) {
      limits.push({ method: 'task', gid, options })
    }
  }
  return { engine, limits, cleanup: () => internal.stopPolling() }
}

// v1.0 Task 8 · #100(C6):全局限速改为 max-download-limit 全局默认(每任务默认上限);本用例无任务 → 追补零次
test('DownloadEngine.setGlobalLimit → changeGlobalOption({max-download-limit})(全局 = 每任务默认上限)', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  try {
    await engine.setGlobalLimit(500)
    assert.deepEqual(limits, [{ method: 'global', options: { 'max-download-limit': '500K' } }])
    await engine.setGlobalLimit(0) // 全局默认不限
    assert.deepEqual(limits[1], {
      method: 'global',
      options: { 'max-download-limit': '0' }
    })
  } finally {
    cleanup()
  }
})

test('DownloadEngine.setTaskLimit → changeOption(gid, {max-download-limit})(按 id → gid 路由)', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  try {
    const id = await engine.addUri({ url: 'http://x', dir: '/d' }) // 填 idToTask(gid=gid_1)
    await engine.setTaskLimit(id, 256)
    assert.deepEqual(limits, [
      { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '256K' } }
    ])
  } finally {
    cleanup()
  }
})

test('DownloadEngine.setTaskLimit 未知 id(无 gid)→ 不下发 RPC、不抛', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  try {
    await engine.setTaskLimit('nonexistent', 256)
    assert.equal(limits.length, 0, '无对应任务 → 不调 changeOption')
  } finally {
    cleanup()
  }
})

// v1.0 Task 8 · #100(C7):null 现在下发**当前全局值**(getSpeedLimit);本用例未注入 → 全局缺省 0 → '0',
// 与「本任务不限」的 '0' 恰好同值,是正确退化不是「两态等价」(那是 overall 总量上限时代的语义,已撤)。
test("T8-A05(b) DownloadEngine.setTaskLimit:未注入 getSpeedLimit 时 null → '0'(全局缺省 0 = 不限);0 → '0'", async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  try {
    const id = await engine.addUri({ url: 'http://x', dir: '/d' })
    await engine.setTaskLimit(id, null) // 「跟随全局」→ 下发当前全局值(未注入 = 0)
    await engine.setTaskLimit(id, 0) // 「本任务不限」→ 0
    // 未注入 getSpeedLimit 时两次下发的值恰好都是 '0';注入时 null 下发全局值,见 T8-A05(a)
    assert.deepEqual(limits, [
      { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '0' } },
      { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '0' } }
    ])
  } finally {
    cleanup()
  }
})

test('DownloadEngine.setGlobalLimit rpcClient 未就绪(null)→ 不抛(启动前调用)', async () => {
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp' }
  )
  // rpcClient 为 null(未 start)→ setGlobalLimit / setTaskLimit 静默 no-op,不抛
  await engine.setGlobalLimit(500)
  await engine.setTaskLimit('x', 256)
  assert.ok(true, 'rpcClient null 时限速调用不抛')
})

// ============ v1.0 Task 8 · #100:全局 = 每任务默认上限(setGlobalLimit 追补 / setTaskLimit 三态 / 崩溃现场)============

test('T8-A04 setGlobalLimit 追补筛选:跟随者 A 追补一次、覆盖者 B 不动、completed 跟随者 C 不动;global 在前', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  const internal = engine as unknown as { idToTask: Map<string, { status: string }> }
  try {
    await engine.addUri({ url: 'http://a', dir: '/d' }) // gid_1:A,跟随全局
    const idB = await engine.addUri({ url: 'http://b', dir: '/d' }) // gid_2:B,覆盖 2048
    const idC = await engine.addUri({ url: 'http://c', dir: '/d' }) // gid_3:C,跟随但已完成
    await engine.setTaskLimit(idB, 2048)
    internal.idToTask.get(idC)!.status = 'completed'
    limits.length = 0

    await engine.setGlobalLimit(500)

    assert.deepEqual(
      limits,
      [
        { method: 'global', options: { 'max-download-limit': '500K' } },
        { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '500K' } }
      ],
      '恰两条:changeGlobalOption 一次 + 仅 gid_A 一次;无 gid_B(覆盖任务不动)、无 gid_C(completed 不可改选项)'
    )
  } finally {
    cleanup()
  }
})

test("T8-A05(a) setTaskLimit(id, null) 下发注入的当前全局值(getSpeedLimit=500 → '500K'),恰一次", async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine(() => 500)
  try {
    const id = await engine.addUri({ url: 'http://x', dir: '/d' })
    await engine.setTaskLimit(id, null)
    assert.deepEqual(
      limits,
      [{ method: 'task', gid: 'gid_1', options: { 'max-download-limit': '500K' } }],
      'null = 跟随全局 → 下发当前全局值,不是 0(否则「跟随全局」会变成「不限」)'
    )
  } finally {
    cleanup()
  }
})

test("T8-A06 setTaskLimit 三态下发:0 → '0'(本任务不限)、300 → '300K';未知 id 零 RPC、不抛、不建条目", async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine(() => 500)
  const internal = engine as unknown as { idToTask: Map<string, unknown> }
  try {
    const id = await engine.addUri({ url: 'http://x', dir: '/d' })
    await engine.setTaskLimit(id, 0)
    await engine.setTaskLimit(id, 300)
    const sizeBefore = internal.idToTask.size
    await engine.setTaskLimit('nonexistent', 300)
    assert.deepEqual(limits, [
      { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '0' } },
      { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '300K' } }
    ])
    assert.equal(internal.idToTask.size, sizeBefore, '未知 id 不新建内存条目')
  } finally {
    cleanup()
  }
})

test("T8-A09 setGlobalLimit 追补单条抛错不牵连其余:gid_2 抛错,gid_1 / gid_3 仍各收到 '500K',调用方不抛", async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  const internal = engine as unknown as {
    rpcClient: { changeOption(gid: string, options: Record<string, string>): Promise<void> }
  }
  try {
    for (const url of ['http://a', 'http://b', 'http://c']) {
      await engine.addUri({ url, dir: '/d' }) // gid_1 / gid_2 / gid_3,均跟随全局
    }
    const capture = internal.rpcClient.changeOption
    internal.rpcClient.changeOption = async (gid, options) => {
      await capture(gid, options) // 仍捕获,证明「调了但抛」
      if (gid === 'gid_2') throw new Error('GID gid_2 is not found')
    }

    await engine.setGlobalLimit(500) // 不抛即通过(单条失败只记日志)

    assert.deepEqual(
      limits,
      [
        { method: 'global', options: { 'max-download-limit': '500K' } },
        { method: 'task', gid: 'gid_1', options: { 'max-download-limit': '500K' } },
        { method: 'task', gid: 'gid_2', options: { 'max-download-limit': '500K' } },
        { method: 'task', gid: 'gid_3', options: { 'max-download-limit': '500K' } }
      ],
      'gid_2 的调用被捕获但抛错;gid_3 仍被追补(单条失败不牵连其余)'
    )
  } finally {
    cleanup()
  }
})

test('T8-A10 崩溃现场(gidToId 已清空)只 changeGlobalOption、零 changeOption;重提后新 gid 收到追补', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  const internal = engine as unknown as {
    gidToId: Map<string, string>
    resubmitUnfinishedTasks(): Promise<void>
  }
  try {
    await engine.addUri({ url: 'http://a', dir: '/d' }) // gid_1
    await engine.addUri({ url: 'http://b', dir: '/d' }) // gid_2
    internal.gidToId.clear() // 与 handleCrash 同一动作:旧 gid 全部失效(task.gid 仍是陈旧值)

    await engine.setGlobalLimit(500)
    assert.deepEqual(
      limits,
      [{ method: 'global', options: { 'max-download-limit': '500K' } }],
      '条件 ③′:gid 不在 gidToId(陈旧 gid)→ 不追补,不打注定失败的 RPC'
    )

    limits.length = 0
    await internal.resubmitUnfinishedTasks() // 新 gid gid_3 / gid_4,gidToId 重建
    await engine.setGlobalLimit(600)
    assert.deepEqual(limits, [
      { method: 'global', options: { 'max-download-limit': '600K' } },
      { method: 'task', gid: 'gid_3', options: { 'max-download-limit': '600K' } },
      { method: 'task', gid: 'gid_4', options: { 'max-download-limit': '600K' } }
    ])
  } finally {
    cleanup()
  }
})

test('T8-A07 崩溃重提补发:覆盖任务 B(0)在新 gid 上 changeOption 恰一次(不走 addUri 选项);跟随任务 A 零补发', async () => {
  const { engine, limits, cleanup } = makeLimitCaptureEngine()
  const internal = engine as unknown as {
    rpcClient: { addUri(urls: string[], options: Record<string, unknown>): Promise<string> }
    idToTask: Map<string, { gid?: string }>
    resubmitUnfinishedTasks(): Promise<void>
  }
  const addUriCalls: Array<{ urls: string[]; options: Record<string, unknown> }> = []
  const origAddUri = internal.rpcClient.addUri
  internal.rpcClient.addUri = async (urls, options) => {
    addUriCalls.push({ urls, options })
    return origAddUri(urls, options)
  }
  try {
    await engine.addUri({ url: 'http://a', dir: '/d' }) // gid_1:A,跟随全局
    const idB = await engine.addUri({ url: 'http://b', dir: '/d' }) // gid_2:B
    await engine.setTaskLimit(idB, 0) // B 覆盖:本任务不限
    limits.length = 0
    addUriCalls.length = 0

    await internal.resubmitUnfinishedTasks()

    assert.equal(addUriCalls.length, 2, '两任务各重提一次(新 gid gid_3 / gid_4)')
    for (const c of addUriCalls) {
      assert.equal(
        'max-download-limit' in c.options,
        false,
        '补发走 changeOption,不把 max-download-limit 塞进 addUri 选项'
      )
    }
    assert.equal(internal.idToTask.get(idB)?.gid, 'gid_4', 'B 的新 gid')
    assert.deepEqual(
      limits,
      [{ method: 'task', gid: 'gid_4', options: { 'max-download-limit': '0' } }],
      '恰一次 changeOption,发到 B 的新 gid;A(跟随全局)零补发'
    )
  } finally {
    cleanup()
  }
})

test('DownloadEngine.resume 重启进度轮询(pause 停表后恢复不再假死,真机 2026-07-09 A4)', async () => {
  const { engine, cleanup } = makeCaptureEngine()
  const internal = engine as unknown as {
    rpcClient: Record<string, unknown>
    pollTimer: NodeJS.Timeout | null
    checkStopPolling(): void
  }
  // 补 forcePause/unpause 桩(捕获式 fake rpcClient 仅带 addUri;pause 走 forcePause,真机修订四)
  internal.rpcClient.forcePause = async () => {}
  internal.rpcClient.unpause = async () => {}

  const id = await engine.addUri({ url: 'http://example.com/f.bin', dir: '/tmp' })
  assert.ok(internal.pollTimer, 'addUri 后轮询已启动')

  await engine.pause(id)
  internal.checkStopPolling() // 轮询周期内由 pollProgress 触发;测试直接调等价路径
  assert.equal(internal.pollTimer, null, 'pause 后无活动任务 → 停表')

  await engine.resume(id)
  assert.ok(internal.pollTimer, 'resume 后轮询必须重启(否则进度 / 完成事件永不再来)')
  cleanup()
})

// ============ 引擎复活单飞(2026-07-11 真机 R6:崩溃恢复失败后重试须能拉起引擎) ============

interface ReviveInternal {
  child: { exitCode: number | null; signalCode: string | null } | null
  rpcClient: unknown
  startAria2Internal(): Promise<void>
  stopPolling(): void
}

test('addUri 复活缝:崩溃恢复失败(死进程)后 addUri 先重启引擎再提交;进程在跑不重复重启', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine()
  const internal = engine as unknown as ReviveInternal
  const aliveRpc = internal.rpcClient // makeCaptureEngine 注入的捕获式 fake
  let revives = 0
  internal.startAria2Internal = async () => {
    revives++
    internal.child = { exitCode: null, signalCode: null } // 重启成功:进程转在跑
    internal.rpcClient = aliveRpc
  }
  try {
    // 现场:崩溃自动恢复失败 → child 停在死进程(exitCode 非 null),rpcClient 指旧实例
    internal.child = { exitCode: 1, signalCode: null }

    await engine.addUri({ url: 'http://x/a', dir: '/d' })
    assert.equal(revives, 1, '死进程 → 先重启一次(修复前:永远失败在死 RPC 上)')
    assert.equal(captured.length, 1, '重启后照常提交任务')

    await engine.addUri({ url: 'http://x/b', dir: '/d' })
    assert.equal(revives, 1, '进程在跑 → 不重复重启(零开销路径)')
    assert.equal(captured.length, 2)
  } finally {
    cleanup()
  }
})

test('addUri 复活缝:并发 addUri 单飞共享同一次重启(不双起 aria2)', async () => {
  const { engine, captured, cleanup } = makeCaptureEngine()
  const internal = engine as unknown as ReviveInternal
  const aliveRpc = internal.rpcClient
  let revives = 0
  let release!: () => void
  internal.startAria2Internal = async () => {
    revives++
    await new Promise<void>((resolve) => {
      release = resolve // 挂起:模拟真实 spawn + RPC 就绪耗时,让第二个 addUri 赶上窗口
    })
    internal.child = { exitCode: null, signalCode: null }
    internal.rpcClient = aliveRpc
  }
  try {
    internal.child = { exitCode: 1, signalCode: null }
    const a = engine.addUri({ url: 'http://x/a', dir: '/d' })
    const b = engine.addUri({ url: 'http://x/b', dir: '/d' })
    await new Promise((resolve) => setTimeout(resolve, 0)) // 两个 addUri 均已进入等待复活
    release()
    await Promise.all([a, b])
    assert.equal(revives, 1, '并发 addUri 共享 in-flight 重启,只起一个 aria2')
    assert.equal(captured.length, 2, '放行后双双提交成功')
  } finally {
    cleanup()
  }
})

test('addUri 复活缝:从未启动(child=null)不自动拉起,保持「DownloadEngine 未启动」原语义', async () => {
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp' }
  )
  let revives = 0
  ;(engine as unknown as ReviveInternal).startAria2Internal = async () => {
    revives++
  }
  await assert.rejects(engine.addUri({ url: 'http://x', dir: '/d' }), /未启动/)
  assert.equal(revives, 0, '未启动 ≠ 死进程:不触发自动启动')
})

// ============ BT 接线(v0.3 Task 1 · spec §4 / §5.3:magnet/addTorrent 分支 + followedBy 转移) ============

interface BtRpcCalls {
  addUri: Array<{ urls: string[]; options: Record<string, unknown> }>
  addTorrent: Array<{ torrent: string; uris: string[]; options: Record<string, unknown> }>
  tellStatus: Array<{ gid: string; keys?: string[] }>
  changeOption: Array<{ gid: string; options: Record<string, string> }>
}

/**
 * BT 用捕获式 fake rpcClient:addUri / addTorrent 记参返 gid;tellActive / tellStatus 由测试
 * 逐轮配置返回值,直接调私有 pollProgress 驱动(不真起定时器 / aria2c)。
 */
function makeBtEngine(): {
  engine: DownloadEngine
  calls: BtRpcCalls
  frames: DownloadProgress[]
  setActive: (statuses: unknown[]) => void
  setStatus: (gid: string, status: unknown) => void
  poll: () => Promise<void>
  internalTask: (id: string) => { gid?: string; metaGid?: string; status: string } | undefined
  cleanup: () => void
} {
  const calls: BtRpcCalls = { addUri: [], addTorrent: [], tellStatus: [], changeOption: [] }
  let active: unknown[] = []
  const statusByGid = new Map<string, unknown>()
  let gidCounter = 0
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp', pollInterval: 1_000_000 }
  )
  const internal = engine as unknown as {
    rpcClient: unknown
    idToTask: Map<string, { gid?: string; metaGid?: string; status: string }>
    pollProgress(): Promise<void>
    stopPolling(): void
  }
  internal.rpcClient = {
    async addUri(urls: string[], options: Record<string, unknown>) {
      calls.addUri.push({ urls, options })
      return `gid_${++gidCounter}`
    },
    async addTorrent(torrent: string, uris: string[], options: Record<string, unknown>) {
      calls.addTorrent.push({ torrent, uris, options })
      return `gid_${++gidCounter}`
    },
    async tellActive() {
      return active
    },
    async tellStatus(gid: string, keys?: string[]) {
      calls.tellStatus.push({ gid, keys })
      const status = statusByGid.get(gid)
      if (!status) throw new Error(`GID ${gid} is not found`)
      return status
    },
    async changeOption(gid: string, options: Record<string, string>) {
      calls.changeOption.push({ gid, options })
    }
  }
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))
  return {
    engine,
    calls,
    frames,
    setActive: (statuses) => {
      active = statuses
    },
    setStatus: (gid, status) => statusByGid.set(gid, status),
    poll: () => internal.pollProgress(),
    internalTask: (id) => internal.idToTask.get(id),
    cleanup: () => internal.stopPolling()
  }
}

const MAGNET = 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01'

test('BT addUri(magnet):走 rpc addUri([magnet]) 并叠加原生 BT 选项 + 代理(spec §4.2)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  try {
    await engine.addUri({ url: MAGNET, dir: '/d/Torrents', torrent: { source: 'magnet' } })
    assert.equal(calls.addUri.length, 1)
    assert.deepEqual(calls.addUri[0].urls, [MAGNET])
    const options = calls.addUri[0].options
    assert.equal(options.dir, '/d/Torrents')
    assert.equal(options['follow-torrent'], 'true', '磁力元数据完成后自动跟进(followedBy 前提)')
    assert.equal(options['seed-time'], '0', '下载完即停做种(诚实,PRD §4.4)')
    assert.equal(options['bt-save-metadata'], 'true')
    assert.equal(options['all-proxy'], '', '未注入 getProxy → 显式空串关闭(合规)')
    assert.equal('select-file' in options, false, 'Task 1 整包,不传 select-file')
    assert.equal('bt-metadata-only' in options, false)
  } finally {
    cleanup()
  }
})

test('BT addUri(.torrent file):走 rpc addTorrent(base64, [], options)(spec §4.1)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  try {
    await engine.addUri({
      url: '',
      dir: '/d/Torrents',
      torrent: { source: 'file', content: 'dG9ycmVudA==' }
    })
    assert.equal(calls.addTorrent.length, 1)
    assert.equal(calls.addTorrent[0].torrent, 'dG9ycmVudA==')
    assert.deepEqual(calls.addTorrent[0].uris, [])
    assert.equal(calls.addTorrent[0].options['seed-time'], '0')
    assert.equal(calls.addUri.length, 0, 'file 不走 addUri')
  } finally {
    cleanup()
  }
})

test('BT followedBy 转移:metaGid 离场 → gid 重映射 realGid + 发 torrentInfo,进度归属同一 id(spec §5.3)', async () => {
  const { engine, frames, setActive, setStatus, poll, internalTask, cleanup } = makeBtEngine()
  try {
    const id = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet' }
    })
    // 第一轮:元数据 gid_1 活动中(普通帧)
    setActive([
      {
        gid: 'gid_1',
        status: 'active',
        totalLength: '9000',
        completedLength: '100',
        downloadSpeed: '5',
        connections: '2'
      }
    ])
    await poll()
    assert.equal(frames.at(-1)?.id, id, '元数据帧归属同一内部 id')
    assert.equal(frames.at(-1)?.torrentInfo, undefined, '元数据阶段不带 torrentInfo')

    // 第二轮:gid_1 离场,followedBy 指向真实下载 gid_real
    setActive([])
    setStatus('gid_1', {
      gid: 'gid_1',
      status: 'complete',
      followedBy: ['gid_real'],
      totalLength: '9000',
      completedLength: '9000',
      downloadSpeed: '0',
      connections: '0'
    })
    setStatus('gid_real', {
      gid: 'gid_real',
      status: 'active',
      totalLength: '1000000',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '3',
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
      bittorrent: { info: { name: 'My Torrent' } },
      files: [
        { path: '/d/Torrents/My Torrent/a.mkv', length: '900000' },
        { path: '/d/Torrents/My Torrent/b.txt', length: '100000' }
      ]
    })
    await poll()

    const infoFrame = frames.find((f) => f.torrentInfo)
    assert.ok(infoFrame, '转移后应发一帧 torrentInfo')
    assert.equal(infoFrame?.id, id, 'torrentInfo 帧仍归属同一内部 id(不误判完成)')
    assert.equal(infoFrame?.torrentInfo?.name, 'My Torrent')
    assert.equal(infoFrame?.torrentInfo?.totalBytes, 1000000)
    assert.deepEqual(
      infoFrame?.torrentInfo?.files.map((f) => f.path),
      ['My Torrent/a.mkv', 'My Torrent/b.txt'],
      'files.path 剥去 dir 前缀 → 种子内相对路径'
    )
    assert.equal(
      infoFrame?.torrentInfo?.files.every((f) => f.selected),
      true,
      'Task 1 整包全选'
    )
    assert.equal(
      frames.some((f) => f.status === 'completed'),
      false,
      '元数据完成≠任务完成(不误走 checkFinalStatus)'
    )
    const task = internalTask(id)
    assert.equal(task?.gid, 'gid_real', 'gid 已重映射到真实下载 gid')
    assert.equal(task?.metaGid, undefined, 'metaGid 已清空')

    // 第三轮:realGid 离场且 complete → 正常终态归属同一 id
    setStatus('gid_real', {
      gid: 'gid_real',
      status: 'complete',
      totalLength: '1000000',
      completedLength: '1000000',
      downloadSpeed: '0',
      connections: '0'
    })
    await poll()
    assert.equal(frames.at(-1)?.status, 'completed', 'realGid 完成走既有 checkFinalStatus')
    assert.equal(frames.at(-1)?.id, id, '终态仍归属同一内部 id')
  } finally {
    cleanup()
  }
})

test('BT .torrent 无元数据阶段:活动期兜底从 tellStatus.bittorrent 发首帧 torrentInfo(spec §5.2)', async () => {
  const { engine, frames, setActive, setStatus, poll, cleanup } = makeBtEngine()
  try {
    const id = await engine.addUri({
      url: '',
      dir: '/d/Torrents',
      torrent: { source: 'file', content: 'dG9ycmVudA==' }
    })
    setActive([
      {
        gid: 'gid_1',
        status: 'active',
        totalLength: '500',
        completedLength: '10',
        downloadSpeed: '5',
        connections: '2'
      }
    ])
    setStatus('gid_1', {
      gid: 'gid_1',
      status: 'active',
      totalLength: '500',
      completedLength: '10',
      downloadSpeed: '5',
      connections: '2',
      infoHash: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',
      bittorrent: { info: { name: 'Local Seed' } },
      files: [{ path: '/d/Torrents/Local Seed', length: '500' }]
    })
    await poll()
    const infoFrame = frames.find((f) => f.torrentInfo)
    assert.ok(infoFrame, '.torrent 直得真实 gid → 兜底发 torrentInfo')
    assert.equal(infoFrame?.id, id)
    assert.equal(infoFrame?.torrentInfo?.name, 'Local Seed')

    // 再轮询:torrentInfoEmitted 后不重复发
    await poll()
    assert.equal(frames.filter((f) => f.torrentInfo).length, 1, 'torrentInfo 只发一次')
  } finally {
    cleanup()
  }
})

test('BT 崩溃重提:magnet re-addUri / file re-addTorrent,带 BT 选项与代理(spec §6.2)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  const internal = engine as unknown as { resubmitUnfinishedTasks(): Promise<void> }
  try {
    await engine.addUri({ url: MAGNET, dir: '/d/Torrents', torrent: { source: 'magnet' } })
    await engine.addUri({
      url: '',
      dir: '/d/Torrents',
      torrent: { source: 'file', content: 'QUJD' }
    })
    calls.addUri.length = 0
    calls.addTorrent.length = 0

    await internal.resubmitUnfinishedTasks()

    assert.equal(calls.addUri.length, 1, 'magnet 重提走 addUri')
    assert.deepEqual(calls.addUri[0].urls, [MAGNET])
    assert.equal(calls.addUri[0].options['follow-torrent'], 'true')
    assert.equal(calls.addTorrent.length, 1, 'file 重提走 addTorrent(内存 base64)')
    assert.equal(calls.addTorrent[0].torrent, 'QUJD')
    assert.equal(calls.addTorrent[0].options['all-proxy'], '', '重提同样注入代理(空串显式关闭)')
  } finally {
    cleanup()
  }
})

test('T8-A08 followedBy 转移后补发:覆盖任务(300)对 realGid changeOption 恰一次;跟随任务的 realGid2 零补发', async () => {
  const { engine, calls, setActive, setStatus, poll, internalTask, cleanup } = makeBtEngine()
  try {
    const idOverride = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet' }
    }) // metaGid gid_1
    const idFollow = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet' }
    }) // metaGid gid_2
    await engine.setTaskLimit(idOverride, 300) // 此时下发到元数据 gid_1
    assert.deepEqual(calls.changeOption, [
      { gid: 'gid_1', options: { 'max-download-limit': '300K' } }
    ])

    // 两条元数据 gid 同时离场,各自 followedBy 指向真实下载 gid
    setActive([])
    const meta = (gid: string, real: string): Record<string, unknown> => ({
      gid,
      status: 'complete',
      followedBy: [real],
      totalLength: '9000',
      completedLength: '9000',
      downloadSpeed: '0',
      connections: '0'
    })
    const real = (gid: string): Record<string, unknown> => ({
      gid,
      status: 'active',
      totalLength: '1000',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '1',
      bittorrent: { info: { name: 'T' } },
      files: []
    })
    setStatus('gid_1', meta('gid_1', 'gid_real'))
    setStatus('gid_2', meta('gid_2', 'gid_real2'))
    setStatus('gid_real', real('gid_real'))
    setStatus('gid_real2', real('gid_real2'))
    await poll()

    assert.equal(internalTask(idOverride)?.gid, 'gid_real', '覆盖任务已转移到 realGid')
    assert.equal(internalTask(idFollow)?.gid, 'gid_real2', '跟随任务已转移到 realGid2')
    assert.deepEqual(
      calls.changeOption.filter((c) => c.gid === 'gid_real'),
      [{ gid: 'gid_real', options: { 'max-download-limit': '300K' } }],
      '覆盖任务对 realGid 幂等补发恰一次'
    )
    assert.equal(
      calls.changeOption.some((c) => c.gid === 'gid_real2'),
      false,
      '跟随全局的任务不补发(靠全局默认继承)'
    )
    assert.equal(calls.changeOption.length, 2, '总计:setTaskLimit 到 gid_1 一次 + realGid 补发一次')
  } finally {
    cleanup()
  }
})

// ============ BT 文件选择(v0.3 Task 2 · spec §5:await 暂停 + changeOption(select-file) + selectFile 重建)============

test('BT addUri(magnet, awaitSelection):叠加 pause-metadata=true(元数据后暂停待选,§5.1)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  try {
    await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', awaitSelection: true }
    })
    const options = calls.addUri[0].options
    assert.equal(options['pause-metadata'], 'true', 'magnet await → pause-metadata=true')
    assert.equal('pause' in options, false, 'magnet 不用 pause(用 pause-metadata)')
    assert.equal('select-file' in options, false, '待选前不带 select-file')
  } finally {
    cleanup()
  }
})

test('BT addUri(.torrent, awaitSelection):叠加 pause=true(无元数据阶段,addTorrent 即暂停,§5.1)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  try {
    await engine.addUri({
      url: '',
      dir: '/d/Torrents',
      torrent: { source: 'file', content: 'QUJD', awaitSelection: true }
    })
    const options = calls.addTorrent[0].options
    assert.equal(options.pause, 'true', '.torrent await → pause=true')
    assert.equal('pause-metadata' in options, false, '.torrent 不用 pause-metadata')
  } finally {
    cleanup()
  }
})

test('BT addUri(selectFile):已定型重建带 --select-file(出队/恢复,§4.3)', async () => {
  const { engine, calls, cleanup } = makeBtEngine()
  try {
    await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', selectFile: '1,3-5' }
    })
    assert.equal(calls.addUri[0].options['select-file'], '1,3-5', '带 select-file 直下选中')
    assert.equal('pause-metadata' in calls.addUri[0].options, false, '已定型不再暂停待选')
  } finally {
    cleanup()
  }
})

test('applyTorrentSelection:arg 非空 → changeOption(realGid, {select-file});存 InternalTask.selectFile', async () => {
  const { engine, calls, internalTask, cleanup } = makeBtEngine()
  try {
    const id = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', awaitSelection: true }
    })
    // gid = gid_1(magnet metaGid;此测试直接用 addUri 返回的 gid,changeOption 按当前 task.gid 下发)
    await engine.applyTorrentSelection(id, '1,3')
    assert.deepEqual(
      calls.changeOption,
      [{ gid: 'gid_1', options: { 'select-file': '1,3', 'bt-remove-unselected-file': 'true' } }],
      'arg 非空 → 暂停态下发 select-file + 完成删未选(2026-07-25 修订三)'
    )
    assert.equal(
      (internalTask(id) as unknown as { selectFile?: string })?.selectFile,
      '1,3',
      '存 InternalTask.selectFile(崩溃重提复原)'
    )
  } finally {
    cleanup()
  }
})

test('applyTorrentSelection:arg=null(全选)→ 不下发 changeOption(aria2 默认全下,§4.2)', async () => {
  const { engine, calls, internalTask, cleanup } = makeBtEngine()
  try {
    const id = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', awaitSelection: true }
    })
    await engine.applyTorrentSelection(id, null)
    assert.equal(calls.changeOption.length, 0, '全选不调 changeOption(整包零回归)')
    assert.equal(
      (internalTask(id) as unknown as { selectFile?: string })?.selectFile,
      undefined,
      '全选 → selectFile 清为 undefined'
    )
  } finally {
    cleanup()
  }
})

test('BT await 转移:magnet await → followedBy 转移后内部置 paused(与 pause-metadata 实况一致)+ 发 torrentInfo(§5.1)', async () => {
  const { engine, frames, setActive, setStatus, poll, internalTask, cleanup } = makeBtEngine()
  try {
    const id = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', awaitSelection: true }
    })
    // 第一轮:元数据 gid_1 活动中
    setActive([
      {
        gid: 'gid_1',
        status: 'active',
        totalLength: '9000',
        completedLength: '100',
        downloadSpeed: '5',
        connections: '2'
      }
    ])
    await poll()

    // 第二轮:gid_1 离场,followedBy 指向 realGid;realGid 以暂停态存在(pause-metadata)
    setActive([])
    setStatus('gid_1', {
      gid: 'gid_1',
      status: 'complete',
      followedBy: ['gid_real'],
      totalLength: '9000',
      completedLength: '9000',
      downloadSpeed: '0',
      connections: '0'
    })
    setStatus('gid_real', {
      gid: 'gid_real',
      status: 'paused',
      totalLength: '1000000',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '0',
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
      bittorrent: { info: { name: 'Await Torrent' } },
      files: [
        { path: '/d/Torrents/Await Torrent/a.mkv', length: '600000' },
        { path: '/d/Torrents/Await Torrent/b.mkv', length: '300000' },
        { path: '/d/Torrents/Await Torrent/c.nfo', length: '100000' }
      ]
    })
    await poll()

    const infoFrame = frames.find((f) => f.torrentInfo)
    assert.ok(infoFrame, 'await 元数据完成后仍发 torrentInfo(供 TaskManager 进 awaiting_selection)')
    assert.equal(infoFrame?.torrentInfo?.name, 'Await Torrent')
    assert.equal(infoFrame?.torrentInfo?.files.length, 3, '多文件清单')
    assert.equal(
      internalTask(id)?.status,
      'paused',
      'await 模式:内部标记 paused(不误判 downloading)'
    )

    // 后续轮询:realGid 暂停不在 tellActive,不误判完成、torrentInfo 不重发
    await poll()
    assert.equal(frames.filter((f) => f.torrentInfo).length, 1, 'torrentInfo 只发一次')
    assert.equal(
      frames.some((f) => f.status === 'completed'),
      false,
      '暂停待选态不误判完成'
    )
  } finally {
    cleanup()
  }
})

test('resubmitUnfinishedTasks:待选中(awaitSelection)重提复原 pause-metadata;已定型(selectFile)重提带 select-file(§5.3)', async () => {
  const { engine, calls, internalTask, cleanup } = makeBtEngine()
  const internal = engine as unknown as { resubmitUnfinishedTasks(): Promise<void> }
  try {
    // 任务 A:待选中 magnet(awaitSelection)
    const idA = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet', awaitSelection: true }
    })
    // 任务 B:已定型 magnet(选定后经 applyTorrentSelection 存了 selectFile)
    const idB = await engine.addUri({
      url: MAGNET,
      dir: '/d/Torrents',
      torrent: { source: 'magnet' }
    })
    await engine.applyTorrentSelection(idB, '2,4')
    calls.addUri.length = 0

    await internal.resubmitUnfinishedTasks()

    const reA = calls.addUri.find((c) => c.options['pause-metadata'] === 'true')
    assert.ok(reA, 'A(待选中)重提复原 pause-metadata=true(再暂停待选)')
    assert.equal('select-file' in (reA?.options ?? {}), false, 'A 未定型 → 不带 select-file')
    const reB = calls.addUri.find((c) => c.options['select-file'] === '2,4')
    assert.ok(reB, 'B(已定型)重提带 select-file=2,4')
    assert.equal('pause-metadata' in (reB?.options ?? {}), false, 'B 已定型 → 不再暂停待选')

    // await 模式 A 重提后内部保持 paused(待选)
    assert.equal(internalTask(idA)?.status, 'paused', 'A 待选中重提 → 内部 paused')
  } finally {
    cleanup()
  }
})

// ============ 做种档注入 + 停止做种 + 做种派生位(v0.3 Task 3 · spec §2 / §4 / §7)============

/** 做种用捕获式 fake rpcClient:addUri 记参返 gid;forcePause 记调用;tellActive 逐轮配置;直接调私有 pollProgress 驱动 */
function makeSeedEngine(
  getSeedConfig?: () => { enabled: boolean; ratio: number; timeMin: number; maxPeers?: number }
): {
  engine: DownloadEngine
  calls: {
    addUri: Array<{ urls: string[]; options: Record<string, unknown> }>
    forcePause: string[]
  }
  gidToId: Map<string, string>
  internalTask: (id: string) => { gid?: string; status: string } | undefined
  setActive: (statuses: unknown[]) => void
  poll: () => Promise<void>
  frames: DownloadProgress[]
  cleanup: () => void
} {
  const calls = {
    addUri: [] as Array<{ urls: string[]; options: Record<string, unknown> }>,
    forcePause: [] as string[]
  }
  let active: unknown[] = []
  let gidCounter = 0
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto }, getSeedConfig },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp', pollInterval: 1_000_000 }
  )
  const internal = engine as unknown as {
    rpcClient: unknown
    idToTask: Map<string, { gid?: string; status: string }>
    gidToId: Map<string, string>
    pollProgress(): Promise<void>
    stopPolling(): void
  }
  internal.rpcClient = {
    async addUri(urls: string[], options: Record<string, unknown>) {
      calls.addUri.push({ urls, options })
      return `gid_${++gidCounter}`
    },
    async forcePause(gid: string) {
      calls.forcePause.push(gid)
    },
    async tellActive() {
      return active
    }
  }
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))
  return {
    engine,
    calls,
    gidToId: internal.gidToId,
    internalTask: (id) => internal.idToTask.get(id),
    setActive: (s) => {
      active = s
    },
    poll: () => internal.pollProgress(),
    frames,
    cleanup: () => internal.stopPolling()
  }
}

test('做种开档:BT addUri 注入 seed-ratio / seed-time(替换 seed-time=0)', async () => {
  const { engine, calls, cleanup } = makeSeedEngine(() => ({
    enabled: true,
    ratio: 1.5,
    timeMin: 120
  }))
  try {
    await engine.addUri({ url: MAGNET, dir: '/d/Torrents', torrent: { source: 'magnet' } })
    const options = calls.addUri[0].options
    assert.equal(options['seed-ratio'], '1.5', '开档注入 seed-ratio')
    assert.equal(options['seed-time'], '120', '开档 timeMin>0 → seed-time')
  } finally {
    cleanup()
  }
})

test('做种关档(未注入 getSeedConfig):BT addUri 缺省 seed-time=0、无 seed-ratio(零回归)', async () => {
  const { engine, calls, cleanup } = makeSeedEngine()
  try {
    await engine.addUri({ url: MAGNET, dir: '/d/Torrents', torrent: { source: 'magnet' } })
    const options = calls.addUri[0].options
    assert.equal(options['seed-time'], '0')
    assert.equal('seed-ratio' in options, false)
  } finally {
    cleanup()
  }
})

test('stopSeeding:forcePause(gid) + 从 gidToId 解绑(pollProgress 离场检测不再误判)', async () => {
  const { engine, calls, gidToId, internalTask, cleanup } = makeSeedEngine(() => ({
    enabled: true,
    ratio: 1,
    timeMin: 60
  }))
  try {
    const id = await engine.addUri({ url: MAGNET, dir: '/d', torrent: { source: 'magnet' } })
    const gid = internalTask(id)!.gid!
    assert.equal(gidToId.has(gid), true, '提交后 gid 已映射')
    await engine.stopSeeding(id)
    assert.deepEqual(
      calls.forcePause,
      [gid],
      'stopSeeding → forcePause(gid)(停上传、保留文件 + .aria2)'
    )
    assert.equal(gidToId.has(gid), false, 'gid 从 gidToId 解绑')
  } finally {
    cleanup()
  }
})

test('做种派生位:BT 帧 100% + active + 开档 → 引擎发帧 seeding:true + 富进度;关档 → 不设 seeding', async () => {
  const on = makeSeedEngine(() => ({ enabled: true, ratio: 1, timeMin: 60 }))
  try {
    const id = await on.engine.addUri({ url: MAGNET, dir: '/d', torrent: { source: 'magnet' } })
    const gid = on.internalTask(id)!.gid!
    on.setActive([
      {
        gid,
        status: 'active',
        totalLength: '1000',
        completedLength: '1000',
        downloadSpeed: '0',
        connections: '10',
        numSeeders: '5',
        uploadSpeed: '2000',
        uploadLength: '3000'
      }
    ])
    await on.poll()
    const f = on.frames.at(-1)
    assert.equal(f?.seeding, true, '100% + active + 开档 → seeding:true')
    assert.equal(f?.numSeeders, 5, '富进度 numSeeders 透传')
    assert.equal(f?.uploadSpeed, 2000)
    assert.equal(f?.uploadLength, 3000)
  } finally {
    on.cleanup()
  }

  const off = makeSeedEngine(() => ({ enabled: false, ratio: 1, timeMin: 60 }))
  try {
    const id = await off.engine.addUri({ url: MAGNET, dir: '/d', torrent: { source: 'magnet' } })
    const gid = off.internalTask(id)!.gid!
    off.setActive([
      {
        gid,
        status: 'active',
        totalLength: '1000',
        completedLength: '1000',
        downloadSpeed: '0',
        connections: '10'
      }
    ])
    await off.poll()
    assert.equal(off.frames.at(-1)?.seeding, undefined, '关档 → 不设 seeding(无闪烁)')
  } finally {
    off.cleanup()
  }
})

// ============ 崩溃风暴超限通知(审计#8 · spec §8:handleCrashStorm 对非终态任务发 error 终态)============

test('handleCrashStorm:崩溃风暴超限 → 非终态任务转 error 终态(不静默假死);completed 不被覆盖', async () => {
  const { engine, cleanup } = makeCaptureEngine()
  const internal = engine as unknown as {
    idToTask: Map<string, { id: string; status: string }>
    handleCrashStorm(msg: string): void
  }
  const events: DownloadProgress[] = []
  engine.onProgress((p) => events.push(p))
  try {
    const id1 = await engine.addUri({ url: 'http://x/a', dir: '/d' }) // 内部 queued
    const id2 = await engine.addUri({ url: 'http://x/b', dir: '/d' })
    internal.idToTask.get(id2)!.status = 'completed' // 模拟已完成:风暴不该覆盖

    internal.handleCrashStorm('aria2c 在 60 秒内崩溃 6 次，已停止自动重启。请检查日志或手动重试。')

    const errs = events.filter((e) => e.status === 'error')
    assert.equal(errs.length, 1, '仅非终态任务(id1)转 error 终态')
    assert.equal(errs[0].id, id1)
    assert.match(errs[0].errorCode ?? '', /停止自动重启|崩溃/, '带崩溃风暴可读文案')
    assert.equal(internal.idToTask.get(id1)!.status, 'error', 'id1 内部状态转 error')
    assert.equal(internal.idToTask.get(id2)!.status, 'completed', 'completed 任务不被覆盖(§7.3)')
  } finally {
    cleanup()
  }
})
