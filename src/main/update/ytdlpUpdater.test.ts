import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { YtdlpUpdater, type UpdaterFs } from './ytdlpUpdater'
import { computeSha256 } from './ytdlpUpdate'
import { downloadYtDlpPath, pendingYtDlpPath } from './paths'
import { MIN_VALID_YTDLP_BYTES } from '../binaries/ensureWritable'
import type { UpdateHttpClient, DownloadProgress } from './updateHttp'
import type { UpdateStateStore, UpdateState } from './updateStateStore'
import { DEFAULT_UPDATE_STATE } from './updateStateStore'
import type { ProxyResolved, UpdateStatus } from '../../shared/ipc'

const TARGET = 'C:/ud/bin/yt-dlp.exe'
const DOWNLOAD = downloadYtDlpPath(TARGET)
const PENDING = pendingYtDlpPath(TARGET)

const FILE = Buffer.from('fake-yt-dlp-binary-content-'.repeat(4))
const HASH = computeSha256(FILE)
const SUMS = `${HASH}  yt-dlp.exe\n0000  other\n`

function releaseJson(tag: string): unknown {
  return {
    tag_name: tag,
    assets: [
      { name: 'yt-dlp.exe', browser_download_url: 'https://x/yt-dlp.exe', size: 30_000_000 },
      { name: 'SHA2-256SUMS', browser_download_url: 'https://x/SHA2-256SUMS', size: 4096 }
    ]
  }
}

interface FakeHttpOpts {
  json?: unknown
  sumsText?: string
  getJsonError?: Error
}
function createFakeHttp(opts: FakeHttpOpts = {}): UpdateHttpClient & {
  configureCalls: Array<string | null>
} {
  return {
    configureCalls: [],
    async configureProxy(effectiveUrl: string | null): Promise<void> {
      this.configureCalls.push(effectiveUrl)
    },
    async getJson(): Promise<unknown> {
      if (opts.getJsonError) throw opts.getJsonError
      return opts.json ?? releaseJson('2026.06.10')
    },
    async getText(): Promise<string> {
      return opts.sumsText ?? SUMS
    },
    async downloadToFile(
      _url: string,
      _dest: string,
      onProgress?: (p: DownloadProgress) => void
    ): Promise<void> {
      onProgress?.({ received: 50, total: 100 })
      onProgress?.({ received: 100, total: 100 })
    }
  }
}

interface FakeFsOpts {
  size?: number
  renameErrors?: Record<string, Error>
}
function createFakeFs(opts: FakeFsOpts = {}): UpdaterFs & {
  renames: Array<[string, string]>
  unlinks: string[]
} {
  const renameErrors = opts.renameErrors ?? {}
  return {
    renames: [],
    unlinks: [],
    statSync(): { size: number } {
      return { size: opts.size ?? MIN_VALID_YTDLP_BYTES }
    },
    async readFile(): Promise<Buffer> {
      return FILE
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      this.renames.push([oldPath, newPath])
      const err = renameErrors[newPath]
      if (err) throw err
    },
    async unlink(path: string): Promise<void> {
      this.unlinks.push(path)
    }
  }
}

/** captureVersionOutput 兼容的 fake spawn:立即回吐 `--version` 输出后 close */
function fakeSpawn(versionOutput: string | null): typeof import('child_process').spawn {
  return ((..._args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = (): void => {}
    setImmediate(() => {
      if (versionOutput !== null) child.stdout.emit('data', Buffer.from(versionOutput))
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof import('child_process').spawn
}

function createFakeStore(initial: UpdateState = { ...DEFAULT_UPDATE_STATE }): UpdateStateStore & {
  state: UpdateState
} {
  return {
    state: { ...initial },
    async read(): Promise<UpdateState> {
      return this.state
    },
    async write(s: UpdateState): Promise<void> {
      this.state = s
    }
  }
}

interface HarnessOpts {
  currentVersion?: string
  http?: ReturnType<typeof createFakeHttp>
  fs?: ReturnType<typeof createFakeFs>
  spawnOutput?: string | null
  hasActiveYtDlp?: boolean
  proxyUrl?: string | null
  store?: ReturnType<typeof createFakeStore>
}
function createUpdater(opts: HarnessOpts = {}): {
  updater: YtdlpUpdater
  statuses: UpdateStatus[]
  http: ReturnType<typeof createFakeHttp>
  fs: ReturnType<typeof createFakeFs>
  store: ReturnType<typeof createFakeStore>
  applied: string[]
} {
  const statuses: UpdateStatus[] = []
  const applied: string[] = []
  const http = opts.http ?? createFakeHttp()
  const fs = opts.fs ?? createFakeFs()
  const store = opts.store ?? createFakeStore()
  const proxy: ProxyResolved = {
    mode: 'manual',
    effectiveUrl: opts.proxyUrl ?? 'http://127.0.0.1:7890',
    systemDetected: null
  }
  const updater = new YtdlpUpdater({
    http,
    fs,
    spawn: fakeSpawn(opts.spawnOutput === undefined ? '2026.06.10\n' : opts.spawnOutput),
    getProxy: () => proxy,
    getCurrentVersion: () => opts.currentVersion ?? '2026.06.09',
    hasActiveYtDlp: () => opts.hasActiveYtDlp ?? false,
    writableYtDlpPath: TARGET,
    stateStore: store,
    onStatus: (s) => statuses.push(s),
    onApplied: (v) => applied.push(v),
    now: () => 1_700_000_000_000,
    probeTimeoutMs: 500
  })
  return { updater, statuses, http, fs, store, applied }
}

const phases = (statuses: UpdateStatus[]): string[] => statuses.map((s) => s.phase)

// ==================== check()(spec §2.1)====================

test('check 有更新:configureProxy(代理)→ hasUpdate + 写节流缓存', async () => {
  const h = createUpdater({ currentVersion: '2026.06.09' })
  const r = await h.updater.check()
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latestVersion, '2026.06.10')
  assert.deepEqual(h.http.configureCalls, ['http://127.0.0.1:7890'], '检查前走代理')
  assert.equal(h.store.state.lastYtDlpLatest, '2026.06.10', '写节流缓存 latest')
  assert.equal(h.store.state.lastYtDlpCheckAt, 1_700_000_000_000)
  assert.ok(phases(h.statuses).includes('available'))
})

test('check 已最新 → hasUpdate false + up-to-date', async () => {
  const h = createUpdater({ currentVersion: '2026.06.10' })
  const r = await h.updater.check()
  assert.equal(r.hasUpdate, false)
  assert.ok(phases(h.statuses).includes('up-to-date'))
})

test('check 网络失败 → 诚实回退(latest=null + error),不抛', async () => {
  const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
  const h = createUpdater({ http: createFakeHttp({ getJsonError: err }) })
  const r = await h.updater.check()
  assert.equal(r.latestVersion, null)
  assert.equal(r.hasUpdate, false)
  assert.match(r.error ?? '', /GitHub|更新服务器/)
  assert.ok(phases(h.statuses).includes('error'))
})

// ==================== run() 替换(spec §2.3 / §2.4)====================

test('run 空闲 → 三重校验通过 → rename 覆盖可写副本(applied)', async () => {
  const h = createUpdater({ hasActiveYtDlp: false })
  await h.updater.run()
  assert.deepEqual(h.fs.renames, [[DOWNLOAD, TARGET]], '临时文件 rename 覆盖可写副本')
  assert.equal(h.fs.unlinks.length, 0, '成功不清理(已 rename 消失)')
  assert.ok(phases(h.statuses).includes('applied'))
  const applied = h.statuses.find((s) => s.phase === 'applied')
  assert.match(applied?.message ?? '', /已更新至 2026\.06\.10/)
})

test('run 有视频任务占用 → 降级 pending(不 kill 进程)', async () => {
  const h = createUpdater({ hasActiveYtDlp: true })
  await h.updater.run()
  assert.deepEqual(h.fs.renames, [[DOWNLOAD, PENDING]], '暂存 pending,不覆盖 yt-dlp.exe')
  assert.ok(phases(h.statuses).includes('pending-restart'))
})

test('run applied → onApplied(latestVersion) 刷新当前版本源(U4:避免下次检查重复下载)', async () => {
  const h = createUpdater({ currentVersion: '2026.06.09', hasActiveYtDlp: false })
  await h.updater.run()
  assert.ok(phases(h.statuses).includes('applied'))
  assert.deepEqual(
    h.applied,
    ['2026.06.10'],
    'applied 后回调新版本(供刷新 engineVersionsCache.ytdlp)'
  )
})

test('run 降级 pending(占用)→ 不调 onApplied(未真正生效,U4)', async () => {
  const h = createUpdater({ hasActiveYtDlp: true })
  await h.updater.run()
  assert.equal(h.applied.length, 0, 'pending 尚未生效 → 不刷新当前版本(下次启动 probeVersion 校正)')
})

test('run rename 抛 EBUSY(文件锁)→ 降级 pending', async () => {
  const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
  const fs = createFakeFs({ renameErrors: { [TARGET]: busy } })
  const h = createUpdater({ hasActiveYtDlp: false, fs })
  await h.updater.run()
  assert.deepEqual(
    h.fs.renames,
    [
      [DOWNLOAD, TARGET],
      [DOWNLOAD, PENDING]
    ],
    'target rename 失败后降级 pending'
  )
  assert.ok(phases(h.statuses).includes('pending-restart'))
})

// ==================== run() 三重校验失败(保留旧版 + 清理临时)====================

test('run size < 阈值 → verify 失败 → 清理临时 + error(保留旧版)', async () => {
  const fs = createFakeFs({ size: 12 }) // 占位大小,< MIN_VALID_YTDLP_BYTES
  const h = createUpdater({ fs })
  await h.updater.run()
  assert.equal(h.fs.renames.length, 0, '校验未过不替换,旧版原样')
  assert.deepEqual(h.fs.unlinks, [DOWNLOAD], '清理下载临时文件')
  assert.ok(phases(h.statuses).includes('error'))
})

test('run SHA256 不匹配 → verify 失败 → 清理 + error', async () => {
  const h = createUpdater({ http: createFakeHttp({ sumsText: `${'0'.repeat(64)}  yt-dlp.exe\n` }) })
  await h.updater.run()
  assert.equal(h.fs.renames.length, 0)
  assert.deepEqual(h.fs.unlinks, [DOWNLOAD])
  const errStatus = h.statuses.find((s) => s.phase === 'error')
  assert.match(errStatus?.error ?? '', /校验失败/)
})

test('run --version != tag → 可执行性校验失败 → 清理 + error', async () => {
  const h = createUpdater({ spawnOutput: '2020.01.01\n' }) // 探测版本与 tag 不符
  await h.updater.run()
  assert.equal(h.fs.renames.length, 0)
  assert.deepEqual(h.fs.unlinks, [DOWNLOAD])
  assert.ok(phases(h.statuses).includes('error'))
})

test('run --version 无输出(损坏)→ 校验失败 → 清理 + error', async () => {
  const h = createUpdater({ spawnOutput: null })
  await h.updater.run()
  assert.equal(h.fs.renames.length, 0)
  assert.deepEqual(h.fs.unlinks, [DOWNLOAD])
})

test('run 已最新 → 不下载不替换(up-to-date)', async () => {
  const h = createUpdater({ currentVersion: '2026.06.10' })
  await h.updater.run()
  assert.equal(h.fs.renames.length, 0)
  assert.ok(phases(h.statuses).includes('up-to-date'))
})

// ==================== shouldCheckNow 节流(spec §2.5)====================

test('shouldCheckNow:距上次 <24h → false;≥24h → true', async () => {
  const recent = createFakeStore({
    ...DEFAULT_UPDATE_STATE,
    lastYtDlpCheckAt: 1_700_000_000_000 - 1000
  })
  const h1 = createUpdater({ store: recent })
  assert.equal(await h1.updater.shouldCheckNow(), false, '刚检查过 → 跳过')

  const old = createFakeStore({ ...DEFAULT_UPDATE_STATE, lastYtDlpCheckAt: 0 })
  const h2 = createUpdater({ store: old })
  assert.equal(await h2.updater.shouldCheckNow(), true, '从未 / 超窗 → 执行')
})
