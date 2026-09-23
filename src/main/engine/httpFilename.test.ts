import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import type { AddUriInput, DownloadProgress, ProxyResolved } from '../../shared/ipc'
import { DownloadEngine } from './downloadEngine'
import { CompositeDownloadEngine, type ManagedTaskEngine } from './compositeEngine'
import { RpcClient } from './rpcClient'
import type { Aria2ProgressStatus } from './rpcCodec'

type FilenameInput = Pick<AddUriInput, 'url' | 'dir' | 'headers'>
type Resolver = (input: FilenameInput) => Promise<string | null>
type ProbeRpc = Pick<
  RpcClient,
  'addUri' | 'addTorrent' | 'tellStatus' | 'tellActive' | 'forceRemove'
> & {
  removeDownloadResult(gid: string): Promise<void>
}
interface RpcCall {
  method: string
  params: unknown[]
}
interface EngineInternals {
  rpcClient: ProbeRpc | null
  idToTask: Map<string, { filename?: string }>
  gidToId: Map<string, string>
  pollTimer: NodeJS.Timeout | null
  pollProgress(): Promise<void>
  resubmitUnfinishedTasks(): Promise<void>
  stopPolling(): void
}
interface Fixture {
  engine: DownloadEngine
  internal: EngineInternals
  rpc: ProbeRpc
  behavior: Partial<ProbeRpc>
  calls: RpcCall[]
  frames: DownloadProgress[]
}

const INPUT: FilenameInput = { url: 'https://example.test/entry', dir: 'D:/downloads' }

function nativeStatus(gid: string, status: string, path?: string): Aria2ProgressStatus {
  return {
    gid,
    status,
    totalLength: '262144',
    completedLength: status === 'complete' ? '262144' : '128',
    downloadSpeed: '0',
    connections: '1',
    ...(path === undefined ? {} : { files: [{ path, length: '262144' }] })
  }
}

// Only the native RPC boundary is substituted; real mapping, polling, cache and resubmit code run.
function fixture(t: TestContext, timeoutMs = 250, getProxy?: () => ProxyResolved): Fixture {
  const calls: RpcCall[] = []
  const behavior: Partial<ProbeRpc> = {}
  let sequence = 0
  const rpc: ProbeRpc = {
    async addUri(urls, options) {
      calls.push({ method: 'addUri', params: [urls, options] })
      return behavior.addUri ? behavior.addUri(urls, options) : 'gid-' + ++sequence
    },
    async addTorrent(content, urls, options) {
      calls.push({ method: 'addTorrent', params: [content, urls, options] })
      return behavior.addTorrent ? behavior.addTorrent(content, urls, options) : 'gid-' + ++sequence
    },
    async tellStatus(gid, keys) {
      calls.push({ method: 'tellStatus', params: [gid, keys] })
      return behavior.tellStatus
        ? behavior.tellStatus(gid, keys)
        : nativeStatus(gid, 'complete', INPUT.dir + '/native.bin')
    },
    async tellActive(keys) {
      calls.push({ method: 'tellActive', params: [keys] })
      return behavior.tellActive ? behavior.tellActive(keys) : []
    },
    async forceRemove(gid) {
      calls.push({ method: 'forceRemove', params: [gid] })
      await behavior.forceRemove?.(gid)
    },
    async removeDownloadResult(gid) {
      calls.push({ method: 'removeDownloadResult', params: [gid] })
      await behavior.removeDownloadResult?.(gid)
    }
  }
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto }, getProxy },
    {
      aria2cPath: '/unused/aria2c',
      defaultDir: INPUT.dir,
      pollInterval: 1_000_000,
      httpFilenameProbeTimeoutMs: timeoutMs
    }
  )
  const internal = engine as unknown as EngineInternals
  internal.rpcClient = rpc
  const frames: DownloadProgress[] = []
  const off = engine.onProgress((p) => frames.push(p))
  t.after(() => {
    off()
    internal.stopPolling()
  })
  return { engine, internal, rpc, behavior, calls, frames }
}

function cleanupCalls(calls: RpcCall[]): RpcCall[] {
  return calls.filter((c) => c.method === 'forceRemove' || c.method === 'removeDownloadResult')
}

async function resolve(
  engine: DownloadEngine | CompositeDownloadEngine,
  input = INPUT
): Promise<string | null> {
  assert.equal(typeof engine.resolveHttpFilename, 'function', 'M-011 native filename preflight API')
  return engine.resolveHttpFilename(input)
}

for (const [source, path] of [
  ['302', 'D:/downloads/final.bin'],
  ['Content-Disposition', 'D:/downloads/report final.pdf'],
  ['reserved name (main owns sanitizing)', 'D:/downloads/CON']
]) {
  test('M011 probe returns complete native ' + source + ' path verbatim', async (t) => {
    const f = fixture(t)
    f.behavior.tellStatus = async (gid) => nativeStatus(gid, 'complete', path)
    assert.equal(await resolve(f.engine), path)
    assert.deepEqual(cleanupCalls(f.calls), [{ method: 'removeDownloadResult', params: ['gid-1'] }])
    const keys = f.calls.find((c) => c.method === 'tellStatus')!.params[1] as string[]
    assert.ok(keys.includes('status') && keys.includes('files'))
    assert.deepEqual(f.engine.list(), [])
    assert.deepEqual(f.frames, [])
    assert.equal(f.internal.pollTimer, null)
  })
}

test('M011 probe uses no out, finite native limits, current proxy and dedicated header whitelist', async (t) => {
  const f = fixture(t, 250, () => ({
    mode: 'manual',
    effectiveUrl: 'http://127.0.0.1:7890',
    systemDetected: null
  }))
  await resolve(f.engine, {
    ...INPUT,
    headers: {
      Referer: 'https://origin.test/page',
      'User-Agent': 'probe-agent',
      Cookie: 'must-not-forward',
      Authorization: 'must-not-forward',
      'X-Extra': 'must-not-forward'
    }
  })
  const add = f.calls.find((c) => c.method === 'addUri')!
  assert.deepEqual(add.params[0], [INPUT.url])
  const options = add.params[1] as Record<string, unknown>
  assert.equal(options.dir, INPUT.dir)
  assert.equal(options['dry-run'], 'true')
  assert.equal(options['continue'], 'false')
  assert.equal(options['auto-file-renaming'], 'true')
  assert.equal(options['allow-overwrite'], 'false')
  assert.equal(options['all-proxy'], 'http://127.0.0.1:7890')
  assert.equal(options.referer, 'https://origin.test/page')
  assert.equal(options['user-agent'], 'probe-agent')
  for (const key of ['out', 'header', 'Cookie', 'Authorization', 'X-Extra']) {
    assert.equal(Object.hasOwn(options, key), false, key + ' must not escape the probe boundary')
  }
  for (const key of ['connect-timeout', 'timeout', 'max-tries']) {
    assert.ok(Number(options[key]) > 0 && Number(options[key]) <= 10, key + ' must be bounded')
  }
  assert.equal(options['max-tries'], '1')
})

test('M011 probe reads proxy each call; defaults explicitly disable proxy and add no headers', async (t) => {
  let proxy: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }
  const f = fixture(t, 250, () => proxy)
  await resolve(f.engine)
  proxy = { mode: 'manual', effectiveUrl: 'http://127.0.0.1:7891', systemDetected: null }
  await resolve(f.engine)
  const options = f.calls
    .filter((c) => c.method === 'addUri')
    .map((c) => c.params[1] as Record<string, unknown>)
  assert.deepEqual(
    options.map((o) => o['all-proxy']),
    ['', proxy.effectiveUrl]
  )
  assert.ok(
    options.every(
      (o) =>
        !Object.hasOwn(o, 'header') &&
        !Object.hasOwn(o, 'referer') &&
        !Object.hasOwn(o, 'user-agent')
    )
  )
})

test('M011 dry-run gid never maps to a business task or emits its logical complete bytes', async (t) => {
  const f = fixture(t)
  const businessId = await f.engine.addUri({ ...INPUT, filename: 'chosen.bin' })
  await resolve(f.engine)
  f.behavior.tellActive = async () => [
    nativeStatus('gid-1', 'active', INPUT.dir + '/chosen.bin'),
    nativeStatus('gid-2', 'complete', INPUT.dir + '/native.bin')
  ]
  await f.internal.pollProgress()
  assert.equal(f.internal.idToTask.size, 1)
  assert.deepEqual([...f.internal.gidToId], [['gid-1', businessId]])
  assert.equal(f.frames.length, 1)
  assert.equal(f.frames[0].id, businessId)
  assert.equal(f.frames[0].status, 'downloading')
  assert.deepEqual(cleanupCalls(f.calls), [{ method: 'removeDownloadResult', params: ['gid-2'] }])
  assert.deepEqual(f.calls[0].params, [
    [INPUT.url],
    { dir: INPUT.dir, 'all-proxy': '', out: 'chosen.bin' }
  ])
})

for (const state of ['error', 'removed']) {
  test(
    'M011 probe ' + state + ' returns null and only clears its own terminal result',
    async (t) => {
      const f = fixture(t)
      f.behavior.tellStatus = async (gid) => ({
        ...nativeStatus(gid, state, INPUT.dir + '/not-accepted.bin'),
        errorCode: '1'
      })
      assert.equal(await resolve(f.engine), null)
      assert.deepEqual(cleanupCalls(f.calls), [
        { method: 'removeDownloadResult', params: ['gid-1'] }
      ])
      assert.deepEqual(f.frames, [])
      await f.engine.addUri({ ...INPUT, filename: 'fallback.bin' })
      assert.deepEqual(f.calls.filter((c) => c.method === 'addUri')[1].params, [
        [INPUT.url],
        { dir: INPUT.dir, 'all-proxy': '', out: 'fallback.bin' }
      ])
    }
  )
}

for (const path of [undefined, '', '   ']) {
  test('M011 complete without a nonempty first path returns null: ' + String(path), async (t) => {
    const f = fixture(t)
    f.behavior.tellStatus = async (gid) => nativeStatus(gid, 'complete', path)
    assert.equal(await resolve(f.engine), null)
    assert.deepEqual(cleanupCalls(f.calls), [{ method: 'removeDownloadResult', params: ['gid-1'] }])
  })
}

test('M011 only accepts files[0], not a later path', async (t) => {
  const f = fixture(t)
  f.behavior.tellStatus = async (gid) => ({
    ...nativeStatus(gid, 'complete'),
    files: [{}, { path: '/not-first.bin' }]
  })
  assert.equal(await resolve(f.engine), null)
})

test('M011 addUri rejection has no owned gid to clean and does not block a later GET', async (t) => {
  const f = fixture(t)
  f.behavior.addUri = async (_urls, options) => {
    if (options?.['dry-run'] === 'true') throw new Error('native HEAD unavailable')
    return 'real-gid'
  }
  assert.equal(await resolve(f.engine), null)
  assert.deepEqual(cleanupCalls(f.calls), [])
  assert.ok(await f.engine.addUri({ ...INPUT, filename: 'fallback.bin' }))
  assert.deepEqual(f.frames, [])
})

test('M011 tellStatus rejection force-removes only its probe before removing its result', async (t) => {
  const f = fixture(t)
  f.behavior.tellStatus = async () => {
    throw new Error('RPC unavailable')
  }
  assert.equal(await resolve(f.engine), null)
  assert.deepEqual(cleanupCalls(f.calls), [
    { method: 'forceRemove', params: ['gid-1'] },
    { method: 'removeDownloadResult', params: ['gid-1'] }
  ])
})

for (const state of ['waiting', 'active', 'paused']) {
  test(
    'M011 ' + state + ' probe has a deadline (queueing is included)',
    { timeout: 2000 },
    async (t) => {
      const f = fixture(t, 30)
      f.behavior.tellStatus = async (gid) =>
        nativeStatus(gid, state, INPUT.dir + '/not-complete.bin')
      const started = Date.now()
      assert.equal(await resolve(f.engine), null)
      assert.ok(Date.now() - started < 750)
      assert.deepEqual(cleanupCalls(f.calls), [
        { method: 'forceRemove', params: ['gid-1'] },
        { method: 'removeDownloadResult', params: ['gid-1'] }
      ])
    }
  )
}

test('M011 stalled tellStatus cannot defeat the probe deadline', { timeout: 2000 }, async (t) => {
  const f = fixture(t, 30)
  f.behavior.tellStatus = () => new Promise(() => undefined)
  assert.equal(await resolve(f.engine), null)
  assert.deepEqual(cleanupCalls(f.calls), [
    { method: 'forceRemove', params: ['gid-1'] },
    { method: 'removeDownloadResult', params: ['gid-1'] }
  ])
})

test(
  'M011 stalled addUri times out; its late gid is cleaned on the original RPC, not a replacement',
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t, 30)
    let finishAdd!: (gid: string) => void
    f.behavior.addUri = () =>
      new Promise((resolve) => {
        finishAdd = resolve
      })
    assert.equal(await resolve(f.engine), null)
    assert.deepEqual(cleanupCalls(f.calls), [])
    const replacement = fixture(t)
    f.internal.rpcClient = replacement.rpc
    finishAdd('late-probe')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(cleanupCalls(f.calls), [
      { method: 'forceRemove', params: ['late-probe'] },
      { method: 'removeDownloadResult', params: ['late-probe'] }
    ])
    assert.deepEqual(replacement.calls, [])
    assert.deepEqual(f.engine.list(), [])
    assert.deepEqual(f.frames, [])
  }
)

test('M011 RPC replacement during polling cancels resolution and cleans only the old instance', async (t) => {
  const f = fixture(t)
  const replacement = fixture(t)
  f.behavior.tellStatus = async (gid) => {
    f.internal.rpcClient = replacement.rpc
    return nativeStatus(gid, 'active', INPUT.dir + '/old.bin')
  }
  assert.equal(await resolve(f.engine), null)
  assert.deepEqual(cleanupCalls(f.calls), [
    { method: 'forceRemove', params: ['gid-1'] },
    { method: 'removeDownloadResult', params: ['gid-1'] }
  ])
  assert.deepEqual(replacement.calls, [])
})

test('M011 cleanup rejection cannot turn a valid path into a rejected add-task operation', async (t) => {
  const f = fixture(t)
  f.behavior.removeDownloadResult = async () => {
    throw new Error('already removed')
  }
  assert.equal(await resolve(f.engine), INPUT.dir + '/native.bin')
})

test(
  'M011 stalled cleanup is also bounded and both single-gid removals are attempted',
  { timeout: 2000 },
  async (t) => {
    const f = fixture(t, 30)
    f.behavior.tellStatus = async (gid) => nativeStatus(gid, 'waiting')
    f.behavior.forceRemove = () => new Promise(() => undefined)
    f.behavior.removeDownloadResult = () => new Promise(() => undefined)
    const started = Date.now()
    assert.equal(await resolve(f.engine), null)
    assert.ok(Date.now() - started < 750)
    assert.deepEqual(cleanupCalls(f.calls), [
      { method: 'forceRemove', params: ['gid-1'] },
      { method: 'removeDownloadResult', params: ['gid-1'] }
    ])
  }
)

test('M011 an unstarted engine resolves null without starting processes', async (t) => {
  const f = fixture(t)
  f.internal.rpcClient = null
  assert.equal(await resolve(f.engine), null)
  assert.deepEqual(f.calls, [])
})

test('M011 HTTP path-only changes emit once and crash resubmit uses the latest actual basename', async (t) => {
  const f = fixture(t)
  const id = await f.engine.addUri({ ...INPUT, filename: 'chosen.bin' })
  let path = 'D:/downloads/chosen.bin'
  f.behavior.tellActive = async () => [nativeStatus('gid-1', 'active', path)]
  await f.internal.pollProgress()
  path = 'D:/downloads/chosen.1.bin'
  await f.internal.pollProgress()
  await f.internal.pollProgress()
  assert.deepEqual(
    f.frames.map((p) => p.savePath),
    ['D:/downloads/chosen.bin', path]
  )
  assert.equal(f.engine.list()[0].filename, 'chosen.1.bin')
  assert.equal(f.internal.idToTask.get(id)?.filename, 'chosen.1.bin')
  const keys = f.calls.find((c) => c.method === 'tellActive')!.params[0] as string[]
  assert.ok(keys.includes('files'))
  await f.internal.resubmitUnfinishedTasks()
  assert.deepEqual(f.calls.filter((c) => c.method === 'addUri')[1].params, [
    [INPUT.url],
    { dir: INPUT.dir, 'all-proxy': '', out: 'chosen.1.bin' }
  ])
})

test('M011 HTTP final tellStatus frame reports actual path and keeps the exact basename (no second sanitize)', async (t) => {
  const f = fixture(t)
  const id = await f.engine.addUri({ ...INPUT, filename: '_CON.bin' })
  const path = 'D:\\downloads\\CON. '
  f.behavior.tellStatus = async (gid) => nativeStatus(gid, 'complete', path)
  await f.internal.pollProgress()
  assert.equal(f.frames[0].status, 'completed')
  assert.equal(f.frames[0].savePath, path)
  assert.equal(f.internal.idToTask.get(id)?.filename, 'CON. ')
  const keys = f.calls.find((c) => c.method === 'tellStatus')!.params[1] as string[]
  assert.ok(keys.includes('files'))
})

test('M011 absent HTTP files keep the submitted filename and legacy progress shape', async (t) => {
  const f = fixture(t)
  await f.engine.addUri({ ...INPUT, filename: 'chosen.bin' })
  f.behavior.tellActive = async () => [nativeStatus('gid-1', 'active')]
  await f.internal.pollProgress()
  assert.equal(Object.hasOwn(f.frames[0], 'savePath'), false)
  assert.equal(f.engine.list()[0].filename, 'chosen.bin')
})

test('M011 BT files remain metadata, never HTTP savePath or HTTP recovery filename', async (t) => {
  const f = fixture(t)
  await f.engine.addUri({ ...INPUT, torrent: { source: 'file', content: 'base64-torrent' } })
  const raw = {
    ...nativeStatus('gid-1', 'active', INPUT.dir + '/Seed/data.bin'),
    bittorrent: { info: { name: 'Seed' } },
    infoHash: 'bt-hash'
  }
  f.behavior.tellActive = async () => [raw]
  f.behavior.tellStatus = async () => raw
  await f.internal.pollProgress()
  assert.ok(f.frames.length >= 2)
  assert.ok(f.frames.every((p) => !Object.hasOwn(p, 'savePath')))
  assert.equal(f.engine.list()[0].filename, undefined)
  assert.deepEqual(f.frames.find((p) => p.torrentInfo)?.torrentInfo, {
    name: 'Seed',
    infoHash: 'bt-hash',
    totalBytes: 262144,
    files: [{ path: 'Seed/data.bin', length: 262144, selected: true }]
  })
  f.behavior.tellActive = async () => []
  f.behavior.tellStatus = async (gid) => nativeStatus(gid, 'complete', INPUT.dir + '/Seed/data.bin')
  await f.internal.pollProgress()
  assert.equal(f.frames.at(-1)?.status, 'completed')
  assert.ok(f.frames.every((p) => !Object.hasOwn(p, 'savePath')))
})

test('M011 RpcClient.removeDownloadResult wraps the private call with exactly one gid', async () => {
  const requests: unknown[] = []
  const rpc = new RpcClient(
    {
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        requests.push(request)
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'OK' }), {
          status: 200
        })
      }) as typeof fetch
    },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )
  assert.equal(typeof rpc.removeDownloadResult, 'function')
  assert.equal(await rpc.removeDownloadResult('owned-probe'), undefined)
  assert.deepEqual(requests, [
    {
      jsonrpc: '2.0',
      id: '1',
      method: 'aria2.removeDownloadResult',
      params: ['token:test-secret', 'owned-probe']
    }
  ])
})

function backend(
  resolveHttpFilename?: Resolver
): ManagedTaskEngine & { resolveHttpFilename?: Resolver } {
  const noop = async (): Promise<void> => undefined
  return {
    start: noop,
    stop: noop,
    addUri: async () => 'business-id',
    pause: noop,
    resume: noop,
    remove: noop,
    onProgress: () => () => undefined,
    resolveHttpFilename
  }
}

test('M011 Composite delegates filename resolution only to HTTP and never registers a route', async () => {
  const inputs: FilenameInput[] = []
  const http = backend(async (input) => {
    inputs.push(input)
    return 'D:/downloads/native.bin'
  })
  const video = backend(async () => {
    assert.fail('video must not receive HTTP preflight')
  })
  const engine = new CompositeDownloadEngine(http, video)
  assert.equal(await resolve(engine), 'D:/downloads/native.bin')
  assert.deepEqual(inputs, [INPUT])
  assert.equal((engine as unknown as { route: Map<string, unknown> }).route.size, 0)
  assert.equal(await engine.addUri({ ...INPUT, filename: 'chosen.bin' }), 'business-id')
  await engine.pause('business-id')
})

test('M011 Composite missing HTTP resolver returns null even when video implements it', async () => {
  const engine = new CompositeDownloadEngine(
    backend(),
    backend(async () => assert.fail('no video fallback'))
  )
  assert.equal(await resolve(engine), null)
  assert.equal((engine as unknown as { route: Map<string, unknown> }).route.size, 0)
})
