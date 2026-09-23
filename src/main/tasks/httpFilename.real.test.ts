/** M-011: opt-in real aria2 → native filename → sanitize → explicit out → SQLite. */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { DownloadProgress, DuplicateConflict, TaskProgress, Task } from '../../shared/ipc'
import type { AppDatabase } from '../db/connection'
import type { TaskManager } from './taskManager'
import { DownloadEngine } from '../engine/downloadEngine'
import { canLoadSqlite } from '../../../tests/helpers/sqlite'

const REAL = process.env.DOWNLORD_REAL_ENGINE === '1'
const SQLITE_OK = canLoadSqlite()
if (REAL && !SQLITE_OK) throw new Error('M-011 real engine tests require node:sqlite')
const REAL_OPTIONS = { skip: !REAL, timeout: 60_000 }
const ARIA2 = resolve(__dirname, '../../..', 'resources/bin/aria2c.exe')
const BODY = Buffer.from('M-011 real HTTP payload\n'.repeat(8192))
const SLOW_BODY = Buffer.alloc(8 * 1024 * 1024, 0x41)
const sha = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex')

interface Route {
  redirect?: string
  filename?: string
  denyHead?: boolean
  slow?: boolean
  warmPrefix?: number
  holdBody?: boolean
  body?: Buffer
}
interface RequestRecord {
  path: string
  method: string
  range?: string
  bytes: number
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const until = Date.now() + 25_000
  while (!check()) {
    assert.ok(Date.now() < until, 'timed out: ' + description)
    await delay(25)
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()))
    })
  }
}

interface RealFilenameHarness {
  root: string
  downloadDir: string
  probeDir: string
  base: string
  routes: Map<string, Route>
  requests: RequestRecord[]
  conflicts: DuplicateConflict[]
  frames: TaskProgress[]
  engineFrames: DownloadProgress[]
  complete(id: string): Promise<void>
  readonly engine: DownloadEngine
  readonly manager: TaskManager
  rows(): Task[]
  read(id: string): Task | null
  restart(afterStop?: () => void): Promise<number>
}

async function harness(t: TestContext): Promise<RealFilenameHarness> {
  const root = await mkdtemp(join(tmpdir(), 'downlord-m011-real-'))
  const ownedRoot = await realpath(root)
  const tempRoot = await realpath(tmpdir())
  assert.equal(dirname(ownedRoot), tempRoot, 'only delete our freshly allocated temp child')
  assert.ok(basename(ownedRoot).startsWith('downlord-m011-real-'))
  const downloadDir = join(root, 'downloads')
  const probeDir = join(root, 'probe-only')
  const dbPath = join(root, 'history.db')
  const routes = new Map<string, Route>()
  const requests: RequestRecord[] = []
  const conflicts: DuplicateConflict[] = []
  const frames: TaskProgress[] = []
  const engineFrames: DownloadProgress[] = []
  let engine: DownloadEngine | undefined
  let manager: TaskManager | undefined
  let db: AppDatabase | undefined
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const record: RequestRecord = {
      path,
      method: req.method ?? 'GET',
      range: req.headers.range,
      bytes: 0
    }
    requests.push(record)
    const route = routes.get(path)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    if (route.redirect) {
      res.writeHead(302, { Location: route.redirect })
      res.end()
      return
    }
    if (route.denyHead && req.method === 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const body = route.body ?? BODY
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    if (start > end) {
      res.writeHead(416)
      res.end()
      return
    }
    res.statusCode = range ? 206 : 200
    res.setHeader('Content-Length', end - start + 1)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'bytes')
    if (range) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + body.length)
    if (route.filename)
      res.setHeader('Content-Disposition', 'attachment; filename="' + route.filename + '"')
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    if (!route.slow) {
      record.bytes = end - start + 1
      res.end(body.subarray(start, end + 1))
      return
    }
    let offset = start
    if (start === 0 && route.warmPrefix && !route.holdBody) {
      const next = Math.min(route.warmPrefix, end + 1)
      res.write(body.subarray(0, next))
      record.bytes += next
      offset = next
    }
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer)
        return
      }
      if (route.holdBody) return
      const next = Math.min(offset + 32 * 1024, end + 1)
      res.write(body.subarray(offset, next))
      record.bytes += next - offset
      offset = next
      if (offset > end) {
        clearInterval(timer)
        res.end()
      }
    }, 50)
    res.once('close', () => clearInterval(timer))
  })
  t.after(async () => {
    try {
      await manager?.stop()
      await engine?.stop()
    } finally {
      await closeServer(server)
      db?.close()
      // Verify the resolved absolute target again immediately before recursive cleanup.
      assert.equal(await realpath(root), ownedRoot)
      assert.equal(dirname(ownedRoot), tempRoot)
      await rm(ownedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
  await mkdir(downloadDir)
  await mkdir(probeDir)
  const { stdout } = await promisify(execFile)(ARIA2, ['--version'], {
    windowsHide: true,
    timeout: 5000
  })
  assert.match(stdout, /^aria2 version /)
  t.diagnostic(stdout.split(/\r?\n/)[0])
  // Same-process target: await listen before address(), and never block its event loop with spawnSync.
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string' && address.port > 0)
  const base = 'http://127.0.0.1:' + address.port
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { listTasks, getTask } = await import('../db/taskDao')
  const { TaskManager } = await import('./taskManager')
  const start = async (): Promise<void> => {
    db = initDatabase(dbPath)
    seedDefaultCategories(db)
    engine = new DownloadEngine(
      {
        aria2ProcessDeps: { spawn, net, crypto },
        getProxy: () => ({ mode: 'direct', effectiveUrl: null, systemDetected: null })
      },
      {
        aria2cPath: ARIA2,
        defaultDir: downloadDir,
        pollInterval: 50,
        dhtFilePath: join(root, 'dht.dat'),
        dhtFilePath6: join(root, 'dht6.dat')
      }
    )
    engine.onProgress((p) => engineFrames.push(p))
    await engine.start()
    manager = new TaskManager(
      {
        engine,
        initDatabase: () => db!,
        trashItem: async () => {
          throw new Error('No implicit trash is allowed in this real test')
        }
      },
      { dbPath, defaultDir: downloadDir, maxConcurrent: 3 }
    )
    manager.onProgress((p) => frames.push(p))
    manager.onDuplicate((c) => conflicts.push(c))
    await manager.start()
  }
  await start()
  const complete = async (id: string): Promise<void> => {
    await waitFor(
      () => {
        const task = manager!.getTask(id)
        assert.notEqual(task?.status, 'error', task?.error ?? 'unexpected error')
        return task?.status === 'completed'
      },
      'task ' + id + ' completed'
    )
  }
  return {
    root,
    downloadDir,
    probeDir,
    base,
    routes,
    requests,
    conflicts,
    frames,
    engineFrames,
    complete,
    get engine() {
      return engine!
    },
    get manager() {
      return manager!
    },
    rows: () => listTasks(db!),
    read: (id: string) => getTask(db!, id),
    async restart(afterStop?: () => void) {
      await manager!.stop()
      await engine!.stop()
      db!.close()
      db = undefined
      afterStop?.()
      const requestMark = requests.length
      await start()
      return requestMark
    }
  }
}

test(
  'M-011 real: 302/CD/设备名 → native probe 零落盘 → 清洗/分类/显式 out + 真内容',
  REAL_OPTIONS,
  async (t) => {
    const h = await harness(t)
    h.routes.set('/redirect-to', { redirect: '/image/png' })
    h.routes.set('/image/png', {})
    h.routes.set('/archive', { redirect: '/package.zip' })
    h.routes.set('/package.zip', {})
    h.routes.set('/disposition', { filename: 'report final.pdf' })
    h.routes.set('/device', { filename: 'CON' })
    const cases = [
      ['/redirect-to', 'png', 'png', '', 'other'],
      ['/archive', 'package.zip', 'package.zip', 'Archives', 'archive'],
      ['/disposition', 'report final.pdf', 'report final.pdf', 'Documents', 'document'],
      ['/device', 'CON', '_CON', '', 'other']
    ] as const
    for (const [source, nativeName, cleanName, subdir, category] of cases) {
      const beforeFrames = h.engineFrames.length
      const native = await h.engine.resolveHttpFilename({ url: h.base + source, dir: h.probeDir })
      assert.ok(native)
      assert.equal(basename(native), nativeName)
      assert.deepEqual(await readdir(h.probeDir), [], 'native HEAD preflight wrote no files')
      assert.equal(h.engineFrames.length, beforeFrames, 'probe emits no business progress')
      const beforeRows = h.rows().length
      assert.equal(h.engine.list().length, beforeRows, 'probe is absent from engine business list')
      const id = await h.manager.addTask({ kind: 'http', source: h.base + source })
      await h.complete(id)
      const expectedPath = join(h.downloadDir, subdir, cleanName)
      assert.equal(h.read(id)?.filename, cleanName)
      assert.equal(resolve(h.read(id)!.savePath), resolve(expectedPath))
      assert.equal(h.read(id)?.category, category)
      assert.equal(sha(await readFile(expectedPath)), sha(BODY))
      assert.equal(h.rows().length, beforeRows + 1)
      assert.equal(
        h.engine.list().at(-1)?.filename,
        cleanName,
        'formal task keeps explicit sanitized out'
      )
      assert.ok(
        h.frames.some(
          (p) => p.id === id && p.filename === cleanName && p.savePath === h.read(id)?.savePath
        )
      )
      assert.ok(
        h.frames.every((p) => h.rows().some((row) => row.id === p.id)),
        'no synthetic probe history'
      )
    }
    assert.ok(
      h.requests.some((r) => r.method === 'GET' && r.bytes > 0),
      'positive body-transfer control'
    )
    assert.ok(h.requests.filter((r) => r.method === 'HEAD').every((r) => r.bytes === 0))
    assert.equal(existsSync(join(h.downloadDir, 'redirect-to')), false)
    assert.equal(existsSync(join(h.downloadDir, 'CON')), false)
  }
)

test('M-011 real: HEAD 不支持时 GET 兜底;显式名称优先且无探测', REAL_OPTIONS, async (t) => {
  const h = await harness(t)
  h.routes.set('/fallback.zip', { denyHead: true })
  h.routes.set('/explicit', { filename: 'server.pdf' })
  const fallback = await h.manager.addTask({ kind: 'http', source: h.base + '/fallback.zip' })
  await h.complete(fallback)
  assert.equal(h.read(fallback)?.filename, 'fallback.zip')
  assert.equal(sha(await readFile(h.read(fallback)!.savePath)), sha(BODY))
  assert.ok(h.requests.some((r) => r.path === '/fallback.zip' && r.method === 'HEAD'))
  assert.ok(h.requests.some((r) => r.path === '/fallback.zip' && r.method === 'GET'))
  const explicit = await h.manager.addTask({
    kind: 'http',
    source: h.base + '/explicit',
    filename: 'mine?.zip'
  })
  await h.complete(explicit)
  assert.equal(h.read(explicit)?.filename, 'mine_.zip')
  assert.equal(h.requests.filter((r) => r.path === '/explicit' && r.method === 'HEAD').length, 0)
  assert.equal(sha(await readFile(h.read(explicit)!.savePath)), sha(BODY))
})

test(
  'M-011 real: 另一来源的有效 data/control 保持原样;rename 与 control-only 避让',
  REAL_OPTIONS,
  async (t) => {
    const h = await harness(t)
    const shared = join(h.downloadDir, 'shared')
    await mkdir(shared)
    h.routes.set('/old', { slow: true, body: SLOW_BODY })
    h.routes.set('/new', { filename: 'shared.bin' })
    h.routes.set('/orphan', { filename: 'orphan.bin' })
    // A genuine foreign partial/control pair: owned only by raw aria2, not by this TaskManager/DB.
    const oldId = await h.engine.addUri({
      url: h.base + '/old',
      dir: shared,
      filename: 'shared.bin'
    })
    await waitFor(
      () =>
        h.engineFrames.some(
          (p) => p.id === oldId && p.downloadedBytes > 512 * 1024 && p.status !== 'completed'
        ),
      'native partial bytes'
    )
    await h.engine.pause(oldId)
    await h.restart()
    const oldPath = join(shared, 'shared.bin')
    const oldData = await readFile(oldPath)
    const oldControl = await readFile(oldPath + '.aria2')
    assert.notEqual(sha(oldData), sha(SLOW_BODY), 'old download is genuinely incomplete')
    const id = await h.manager.addTask({ kind: 'http', source: h.base + '/new', dir: shared })
    assert.equal(h.conflicts.at(-1)?.conflictId, id)
    assert.equal(h.read(id), null)
    assert.equal(h.requests.filter((r) => r.path === '/new' && r.method === 'GET').length, 0)
    await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
    await h.complete(id)
    assert.equal(h.read(id)?.filename, 'shared (1).bin')
    assert.equal(sha(await readFile(h.read(id)!.savePath)), sha(BODY))
    assert.deepEqual(await readFile(oldPath), oldData)
    assert.deepEqual(await readFile(oldPath + '.aria2'), oldControl)
    const orphanControl = join(shared, 'orphan.bin.aria2')
    await copyFile(oldPath + '.aria2', orphanControl)
    const orphan = await h.manager.addTask({
      kind: 'http',
      source: h.base + '/orphan',
      dir: shared
    })
    await h.complete(orphan)
    assert.equal(h.read(orphan)?.filename, 'orphan (1).bin')
    assert.equal(existsSync(join(shared, 'orphan.bin')), false)
    assert.deepEqual(await readFile(orphanControl), oldControl)
    assert.equal(sha(await readFile(h.read(orphan)!.savePath)), sha(BODY))
  }
)

test(
  'M-011 real: 中途关闭并重开 DB/引擎后续传真实文件名,不重探测也不混内容',
  REAL_OPTIONS,
  async (t) => {
    const h = await harness(t)
    const route: Route = {
      filename: 'recovered.zip',
      slow: true,
      warmPrefix: 2 * 1024 * 1024,
      body: SLOW_BODY
    }
    h.routes.set('/recover', route)
    const id = await h.manager.addTask({ kind: 'http', source: h.base + '/recover' })
    await waitFor(() => {
      const task = h.manager.getTask(id)
      assert.notEqual(task?.status, 'error', task?.error ?? 'unexpected error')
      return task?.status === 'downloading' && task.downloadedBytes > 1024 * 1024
    }, 'partial task observed before restart')
    const before = h.read(id)!
    assert.equal(before.filename, 'recovered.zip')
    const heads = h.requests.filter((r) => r.method === 'HEAD').length
    // Freeze the remaining response while graceful shutdown runs; otherwise parallel 1 MiB
    // segments can all complete during shutdown, leaving no incomplete control file to resume.
    route.holdBody = true
    const requestMark = await h.restart(() => {
      t.diagnostic(
        JSON.stringify({
          beforeRestart: before,
          requestsAtShutdown: h.requests,
          lastFrames: h.engineFrames.slice(-3),
          fileExists: existsSync(before.savePath)
        })
      )
      assert.ok(
        existsSync(before.savePath + '.aria2'),
        'native incomplete control exists before restart'
      )
      route.filename = 'do-not-retake.zip'
      route.slow = false
      route.holdBody = false
    })
    await h.complete(id)
    assert.equal(h.rows().length, 1)
    assert.equal(h.read(id)?.filename, before.filename)
    assert.equal(h.read(id)?.savePath, before.savePath)
    assert.equal(
      h.requests.filter((r) => r.method === 'HEAD').length,
      heads,
      'restart must not probe again'
    )
    t.diagnostic(JSON.stringify({ resumedRequests: h.requests.slice(requestMark) }))
    assert.ok(
      h.requests
        .slice(requestMark)
        .some((r) => r.method === 'GET' && /^bytes=[1-9]\d*-/.test(r.range ?? '')),
      'positive ranged-resume evidence'
    )
    assert.equal(
      sha(await readFile(before.savePath)),
      sha(SLOW_BODY),
      'full SHA-256 matches the original payload'
    )
    assert.equal(existsSync(join(dirname(before.savePath), 'do-not-retake.zip')), false)
  }
)
