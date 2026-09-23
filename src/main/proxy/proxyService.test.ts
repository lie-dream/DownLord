/**
 * ProxyService 集成单测(Task 7 · spec §6 / §8.2)。
 *
 * 注入 fake `SystemProxyReader` + 内存 `ProxyStoreFs`,不碰真实 Electron session / FS:
 * 验证 startup 读 proxy.json + system 档读系统代理 + 同步 getResolved 的三档 × (读到 / 未读到 / 读失败) 矩阵。
 * Phase 3 追加(文件末尾):setConfig 三档 → getStatus 的 label/dot(spec §5.1)+ 非法 manual 不落盘 + warn +
 * 探测目标 / 次数(注入 fake probe)+ set 后广播(注入 fake onStatusChanged)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ProxyService } from './proxyService'
import type { ProxyStoreFs } from './proxyStore'
import type { SystemProxyReader } from './systemProxy'
import type { ProxyStatus } from '../../shared/ipc'

const PATH = '/userdata/config/proxy.json'

/** 内存 fs(实现 ProxyStoreFs 原子写最小面),暴露 files 供断言回退修复落盘 */
function memStore(initial?: Record<string, string>): ProxyStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    files,
    async readFile(path) {
      const v = files.get(path)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeFile(path, data) {
      files.set(path, data)
    },
    async rename(oldPath, newPath) {
      const v = files.get(oldPath)
      if (v === undefined) throw new Error('ENOENT')
      files.set(newPath, v)
      files.delete(oldPath)
    },
    async mkdir() {
      /* fake FS:目录树是内存 Map,无需真实建目录 */
    }
  }
}

/** fake 系统代理读:返回预设 resolveProxy 串,或抛错模拟 session 未就绪 */
function fakeReader(value: string | Error): SystemProxyReader {
  return {
    async read() {
      if (value instanceof Error) throw value
      return value
    }
  }
}

test('ProxyService.init system + 读到系统代理 → getResolved 全字段正确', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 127.0.0.1:7890'),
    store,
    configPath: PATH
  })
  await svc.init()
  const r = svc.getResolved()
  assert.equal(r.mode, 'system')
  assert.equal(r.effectiveUrl, 'http://127.0.0.1:7890')
  assert.equal(
    r.systemDetected,
    'http://127.0.0.1:7890',
    'system 档下发实读系统代理供状态栏诚实显示'
  )
})

test('ProxyService.init system + 系统 DIRECT → effectiveUrl / systemDetected null', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({ systemProxyReader: fakeReader('DIRECT'), store, configPath: PATH })
  await svc.init()
  const r = svc.getResolved()
  assert.equal(r.effectiveUrl, null)
  assert.equal(r.systemDetected, null)
})

test('ProxyService.init system + 读系统代理抛错 → 诚实回退 null(不崩)', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({
    systemProxyReader: fakeReader(new Error('session 未就绪')),
    store,
    configPath: PATH
  })
  await svc.init() // 读失败不抛
  const r = svc.getResolved()
  assert.equal(r.effectiveUrl, null, '读失败按系统未设代理回退(直连)')
  assert.equal(r.systemDetected, null)
})

test('ProxyService.init manual(合法)→ effectiveUrl 用户值,不读系统代理', async () => {
  let readCount = 0
  const reader: SystemProxyReader = {
    async read() {
      readCount++
      return 'PROXY 9.9.9.9:9'
    }
  }
  const store = memStore({
    [PATH]: JSON.stringify({ mode: 'manual', manualUrl: 'socks5://127.0.0.1:7891' })
  })
  const svc = new ProxyService({ systemProxyReader: reader, store, configPath: PATH })
  await svc.init()
  const r = svc.getResolved()
  assert.equal(r.mode, 'manual')
  assert.equal(r.effectiveUrl, 'socks5://127.0.0.1:7891')
  assert.equal(r.systemDetected, null, 'manual 档不下发 systemDetected')
  assert.equal(readCount, 0, 'manual 档不读系统代理')
})

test('ProxyService.init manual(非法地址)→ effectiveUrl null', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'manual', manualUrl: 'not-a-proxy' }) })
  const svc = new ProxyService({ systemProxyReader: fakeReader('DIRECT'), store, configPath: PATH })
  await svc.init()
  assert.equal(svc.getResolved().effectiveUrl, null)
})

test('ProxyService.init direct → effectiveUrl null,不读系统代理', async () => {
  let readCount = 0
  const reader: SystemProxyReader = {
    async read() {
      readCount++
      return 'PROXY 9.9.9.9:9'
    }
  }
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'direct', manualUrl: null }) })
  const svc = new ProxyService({ systemProxyReader: reader, store, configPath: PATH })
  await svc.init()
  assert.equal(svc.getResolved().effectiveUrl, null)
  assert.equal(readCount, 0)
})

test('ProxyService.init 缺失 proxy.json → 回退默认(system)读系统代理并重写修复', async () => {
  const store = memStore() // 空:无 proxy.json
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 127.0.0.1:7890'),
    store,
    configPath: PATH
  })
  await svc.init()
  const r = svc.getResolved()
  assert.equal(r.mode, 'system', '缺失 → 默认 system')
  assert.equal(r.effectiveUrl, 'http://127.0.0.1:7890')
  assert.ok(store.files.has(PATH), '缺失/损坏回退后重写修复 proxy.json')
})

test('ProxyService.getResolved 同步可重复调用,返回当前缓存', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 127.0.0.1:7890'),
    store,
    configPath: PATH
  })
  await svc.init()
  assert.deepEqual(svc.getResolved(), svc.getResolved())
})

// ── Phase 3:setConfig / getStatus / 连通探测 / 广播 ───────────────────────────

/** fake 探测:记录每次 (host, port),返回预设结果(true=通 / false=不通) */
function fakeProbe(result: boolean): {
  fn: (host: string, port: number) => Promise<boolean>
  calls: Array<{ host: string; port: number }>
} {
  const calls: Array<{ host: string; port: number }> = []
  return {
    fn: async (host, port) => {
      calls.push({ host, port })
      return result
    },
    calls
  }
}

test('Phase3 setConfig system + 读到代理 + 探测通 → 跟随系统(已连接)/ok,只探代理端口 1 次 + 广播', async () => {
  const store = memStore()
  const pr = fakeProbe(true)
  const broadcasts: ProxyStatus[] = []
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 127.0.0.1:7890'),
    store,
    configPath: PATH,
    probe: pr.fn,
    onStatusChanged: (s) => broadcasts.push(s)
  })
  const status = await svc.setConfig({ mode: 'system', manualUrl: null })
  assert.equal(status.label, '跟随系统(已连接)')
  assert.equal(status.dot, 'ok')
  assert.equal(status.effectiveUrl, 'http://127.0.0.1:7890')
  assert.deepEqual(pr.calls, [{ host: '127.0.0.1', port: 7890 }], '只对代理端口本身探测一次')
  assert.deepEqual(broadcasts, [status], 'set 后广播一次最新状态')
})

test('Phase3 setConfig manual 合法 + 探测通 → 手动代理(已连接)/ok + 落盘 + 探测目标正确', async () => {
  const store = memStore()
  const pr = fakeProbe(true)
  const svc = new ProxyService({
    systemProxyReader: fakeReader('DIRECT'),
    store,
    configPath: PATH,
    probe: pr.fn
  })
  const status = await svc.setConfig({ mode: 'manual', manualUrl: 'http://127.0.0.1:7890' })
  assert.equal(status.label, '手动代理(已连接)')
  assert.equal(status.dot, 'ok')
  assert.deepEqual(pr.calls, [{ host: '127.0.0.1', port: 7890 }])
  assert.ok(store.files.has(PATH), '合法 manual 落盘')
  assert.deepEqual(JSON.parse(store.files.get(PATH) as string), {
    mode: 'manual',
    manualUrl: 'http://127.0.0.1:7890'
  })
})

test('Phase3 setConfig manual 合法 + 探测不通 → 手动代理(未响应)/warn,探测含认证忽略账密', async () => {
  const store = memStore()
  const pr = fakeProbe(false)
  const svc = new ProxyService({
    systemProxyReader: fakeReader('DIRECT'),
    store,
    configPath: PATH,
    probe: pr.fn
  })
  const status = await svc.setConfig({ mode: 'manual', manualUrl: 'socks5://u:p@127.0.0.1:1080' })
  assert.equal(status.label, '手动代理(未响应)')
  assert.equal(status.dot, 'warn')
  assert.deepEqual(pr.calls, [{ host: '127.0.0.1', port: 1080 }], '探测只连 host:port,不连账密')
})

test('Phase3 setConfig manual 非法 → 手动代理(地址无效)/warn + 不落盘 + 不探测 + 仍广播', async () => {
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'direct', manualUrl: null }) }) // 旧合法配置
  const pr = fakeProbe(true)
  const broadcasts: ProxyStatus[] = []
  const svc = new ProxyService({
    systemProxyReader: fakeReader('DIRECT'),
    store,
    configPath: PATH,
    probe: pr.fn,
    onStatusChanged: (s) => broadcasts.push(s)
  })
  const status = await svc.setConfig({ mode: 'manual', manualUrl: 'not-a-proxy' })
  assert.equal(status.label, '手动代理(地址无效)')
  assert.equal(status.dot, 'warn')
  assert.equal(status.effectiveUrl, null)
  assert.equal(pr.calls.length, 0, 'effectiveUrl null → 不探测')
  assert.deepEqual(
    JSON.parse(store.files.get(PATH) as string),
    { mode: 'direct', manualUrl: null },
    '非法 manual 不落盘,旧配置不被覆盖'
  )
  assert.equal(broadcasts.length, 1, '非法 manual 仍广播告警态')
  assert.equal(svc.getResolved().mode, 'manual', '运行态即时反映 manual 档(供引擎注入)')
  assert.equal(
    svc.getResolved().effectiveUrl,
    null,
    '非法 manual → effectiveUrl null(引擎侧空串关闭)'
  )
})

test('Phase3 setConfig direct → 直连/off + 不探测 + 落盘', async () => {
  const store = memStore()
  const pr = fakeProbe(true)
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 9.9.9.9:9'),
    store,
    configPath: PATH,
    probe: pr.fn
  })
  const status = await svc.setConfig({ mode: 'direct', manualUrl: null })
  assert.equal(status.label, '直连')
  assert.equal(status.dot, 'off')
  assert.equal(status.effectiveUrl, null)
  assert.equal(pr.calls.length, 0, 'direct 档不探测')
  assert.ok(store.files.has(PATH), 'direct 落盘')
})

test('Phase3 setConfig system 系统未设代理(DIRECT)→ 系统未设/off + 不探测', async () => {
  const store = memStore()
  const pr = fakeProbe(true)
  const svc = new ProxyService({
    systemProxyReader: fakeReader('DIRECT'),
    store,
    configPath: PATH,
    probe: pr.fn
  })
  const status = await svc.setConfig({ mode: 'system', manualUrl: null })
  assert.equal(status.label, '跟随系统(系统未设代理 · 直连)')
  assert.equal(status.dot, 'off')
  assert.equal(status.effectiveUrl, null)
  assert.equal(pr.calls.length, 0, 'system 未读到代理 → 不探测')
})

test('Phase3 getStatus 含一次探测,且非周期(setConfig + getStatus 各探测一次)', async () => {
  const store = memStore()
  const pr = fakeProbe(true)
  const svc = new ProxyService({
    systemProxyReader: fakeReader('PROXY 127.0.0.1:7890'),
    store,
    configPath: PATH,
    probe: pr.fn
  })
  await svc.setConfig({ mode: 'system', manualUrl: null }) // 探测 1 次
  const s = await svc.getStatus() // 再探测 1 次
  assert.equal(pr.calls.length, 2, 'setConfig 与 getStatus 各探测一次(非周期轮询)')
  assert.equal(s.label, '跟随系统(已连接)')
  assert.equal(s.dot, 'ok')
})

// ==================== system 档跟随(2026-07-25 真机修订二 · spec §14.8)====================

/** 可变系统代理 fake:set 换值模拟系统代理变化(如 Clash 开关 / 换端口),reads 计读取次数 */
function mutableReader(
  initial: string
): SystemProxyReader & { set(v: string): void; reads: number } {
  let value = initial
  return {
    reads: 0,
    set(v: string) {
      value = v
    },
    async read() {
      this.reads++
      return value
    }
  }
}

test('pollSystemOnce: system 档系统代理变化 → systemDetected 更新 + 广播一次(真机:跟随系统不更新)', async () => {
  const reader = mutableReader('PROXY 127.0.0.1:7890')
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const statuses: ProxyStatus[] = []
  const svc = new ProxyService({
    systemProxyReader: reader,
    store,
    configPath: PATH,
    onStatusChanged: (s) => statuses.push(s)
  })
  await svc.init()
  assert.equal(svc.getResolved().effectiveUrl, 'http://127.0.0.1:7890')

  reader.set('PROXY 127.0.0.1:7897') // 系统代理换端口
  await svc.pollSystemOnce()
  assert.equal(svc.getResolved().effectiveUrl, 'http://127.0.0.1:7897', '跟随到新系统代理')
  assert.equal(statuses.length, 1, '变化才广播一次')

  await svc.pollSystemOnce() // 无变化
  assert.equal(statuses.length, 1, '无变化静默不广播')
})

test('pollSystemOnce: 系统代理从有到无(DIRECT)同样跟随并广播', async () => {
  const reader = mutableReader('PROXY 127.0.0.1:7890')
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const statuses: ProxyStatus[] = []
  const svc = new ProxyService({
    systemProxyReader: reader,
    store,
    configPath: PATH,
    onStatusChanged: (s) => statuses.push(s)
  })
  await svc.init()

  reader.set('DIRECT') // 用户关掉了系统代理
  await svc.pollSystemOnce()
  assert.equal(svc.getResolved().effectiveUrl, null, '跟随到「系统未设代理」(直连)')
  assert.equal(statuses.length, 1)
})

test('pollSystemOnce: 非 system 档空转(不读系统代理、不广播)', async () => {
  const reader = mutableReader('PROXY 9.9.9.9:9')
  const store = memStore({
    [PATH]: JSON.stringify({ mode: 'manual', manualUrl: 'http://127.0.0.1:7890' })
  })
  const statuses: ProxyStatus[] = []
  const svc = new ProxyService({
    systemProxyReader: reader,
    store,
    configPath: PATH,
    onStatusChanged: (s) => statuses.push(s)
  })
  await svc.init()
  await svc.pollSystemOnce()
  assert.equal(reader.reads, 0, 'manual 档不读系统代理')
  assert.equal(statuses.length, 0, '不广播')
})

test('getStatus: system 档每次先重读系统代理(打开设置页 / 状态栏拉取永远看到当前值)', async () => {
  const reader = mutableReader('PROXY 127.0.0.1:7890')
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({ systemProxyReader: reader, store, configPath: PATH })
  await svc.init()

  reader.set('PROXY 127.0.0.1:7897')
  await svc.getStatus()
  assert.equal(svc.getResolved().effectiveUrl, 'http://127.0.0.1:7897', 'getStatus 顺带刷新缓存')
})

test('startSystemWatch/stop: 幂等注册与清理(不留残留定时器)', async () => {
  const reader = mutableReader('DIRECT')
  const store = memStore({ [PATH]: JSON.stringify({ mode: 'system', manualUrl: null }) })
  const svc = new ProxyService({ systemProxyReader: reader, store, configPath: PATH })
  await svc.init()
  svc.startSystemWatch(60_000)
  svc.startSystemWatch(60_000) // 重复启动:先清旧表,幂等
  svc.stop()
  svc.stop() // 重复停:no-op
})
