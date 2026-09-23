/**
 * 嗅探转交的端到端集成测试(I-03~I-07 / I-10;v0.4 Task 5 · spec §7.2)。
 *
 * **两个既有夹具的合体**,故这条链路一处都不被旁路:
 * - 真回环 HTTP 通道(仿 `takeover.integration.test.ts`):三闸鉴权 → 版本协商 → type 分发 →
 *   payload 形状守卫 → `handleSniffSelected`。「走完整通道」是 I-03 的字面要求。
 * - 真 SQLite `TaskManager` + FakeEngine(仿 `takeoverDuplicate.integration.test.ts`):
 *   `addTask` 全链路零旁路,`addUriCalls` 能看到最终提交给引擎的载荷。
 *
 * ⚠️ FakeEngine 只看得到 `AddUriInput`;「aria2 专用选项」那一步在 `downloadEngine.ts` 里由纯函数
 *    `toAria2HeaderOptions` 完成(它自己有单测)。故 I-04 断言**两段**:入参 headers 恰两键,
 *    且把它喂给那个纯函数得到的恰是 `referer` / `user-agent` 两个专用选项 —— **不假装 fake 引擎
 *    真的起了 aria2**。yt-dlp 侧同理(`toYtdlpHeaderArgs`)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { AddTaskInput, AddUriInput, DownloadProgress, TakeoverBatch } from '../../shared/ipc'
import type { TaskEngine } from '../tasks/taskManager'
import { ExtensionChannelService } from '../extensionChannel/extensionChannelService'
import { nodeHttpFactory } from '../extensionChannel/nodeHttpFactory'
import { validateChannelPort } from '../extensionChannel/portValidation'
import type { ChannelLogger } from '../extensionChannel/channelServer'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import { toAria2HeaderOptions } from '../engine/aria2Headers'
import { toYtdlpHeaderArgs } from '../video/ytdlpHeaders'
import { TakeoverService, type TakeoverWindowHandle } from './takeoverService'
import { createTakeoverConfigStore } from './takeoverConfig'

// ==================== 原生模块能力探测(同步、不静态加载)====================

const requireForProbe = createRequire(import.meta.url)

function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (p: string) => { close(): void }
    }
    const probe = new DatabaseSync(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
}

const SQLITE_OK = canLoadSqlite()

if (!SQLITE_OK) {
  const msg = `[sniffTakeover.integration] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.warn(`${msg} 本次跳过。`)
}

// ==================== 常量 ====================

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const CONFIG_PATH = 'C:/userData/config/extensionChannel.json'
const TAKEOVER_CONFIG_PATH = 'C:/userData/config/takeover.json'
const T0 = 1_700_000_000_000

const M3U8_URL = 'https://cdn.example.com/hls/index.m3u8?token=SECRETTOKEN789'
const MP4_URL = 'https://cdn.example.com/v/movie.mp4?sign=SECRETSIGN123'
const M4S_URL = 'https://cdn.example.com/hls/seg-000123.m4s'
const REFERRER = 'https://page.example.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'

/** 一条 `sniff.addSelected` 信封 */
function sniffBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'sniff.addSelected',
    protocolVersion: 3,
    payload: {
      url: M3U8_URL,
      contentType: 'application/vnd.apple.mpegurl',
      referrer: REFERRER,
      userAgent: UA,
      totalBytes: -1,
      ...overrides
    }
  })
}

/** 一条 `download.intent` 信封(I-06 的接管路径回归用) */
function intentBody(): string {
  return JSON.stringify({
    type: 'download.intent',
    protocolVersion: 3,
    payload: {
      url: 'https://dl.example.com/setup.exe',
      referrer: REFERRER,
      danger: 'safe',
      totalBytes: 1000,
      userAgent: UA
    }
  })
}

// ==================== fake ====================

class FakeEngine implements TaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  private counter = 0

  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    return `eng_${++this.counter}`
  }
  async pause(): Promise<void> {
    // 本夹具不校验暂停 / 恢复 / 删除语义:空实现即满足 TaskEngine 契约
  }
  async resume(): Promise<void> {
    // 同 pause
  }
  async remove(): Promise<void> {
    // 同 pause
  }
  onProgress(_cb: (progress: DownloadProgress) => void): () => void {
    return () => {}
  }
}

interface FakeWindow extends TakeoverWindowHandle {
  sent: { channel: string; payload: unknown }[]
}

function makeFakeWindow(): FakeWindow {
  let destroyed = false
  const win: FakeWindow = {
    sent: [],
    send: (channel, payload) => void win.sent.push({ channel, payload }),
    showOnce: () => {},
    setContentHeight: () => {},
    close: () => void (destroyed = true),
    isDestroyed: () => destroyed,
    webContentsId: () => (destroyed ? null : 101),
    onClosed: () => {}
  }
  return win
}

// ==================== HTTP 助手 ====================

interface HttpReply {
  status: number
  body: string
}

function post(port: number, token: string, body: string): Promise<HttpReply> {
  return new Promise<HttpReply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/channel',
        headers: {
          'Content-Type': 'application/json',
          'X-DownLord-Token': token,
          Origin: ORIGIN,
          'Content-Length': String(Buffer.byteLength(body))
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('请求超时')))
    req.write(body)
    req.end()
  })
}

async function pickFreePort(): Promise<number> {
  // OS 分配的临时端口可能落在通道端口校验拒绝的 BT / DHT 保留段 52301–52320
  //(validateChannelPort → reserved_bt,setConfig 不起服务;真 CI 的 runner 2026-09-23 撞到过),
  // 故只接受能通过校验的端口,连续 64 次都不行才放弃。
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createNetServer()
      s.on('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const picked = typeof addr === 'object' && addr !== null ? addr.port : 0
        s.close(() => resolve(picked))
      })
    })
    if (validateChannelPort(port).ok) return port
  }
  throw new Error('pickFreePort: 64 次取到的临时端口都被 validateChannelPort 拒绝')
}

// ==================== 夹具 ====================

interface SqliteDb {
  prepare(sql: string): { get(): unknown; all(): unknown[]; run(): unknown }
  close(): void
}

/** `videoResolver.resolve` 每次被调用时收到的三个参数(改动 #6 的端到端凭证) */
interface ResolveCall {
  url: string
  headers?: Record<string, string>
}

interface Harness {
  takeover: TakeoverService
  engine: FakeEngine
  addTaskCalls: AddTaskInput[]
  resolveCalls: ResolveCall[]
  windows: FakeWindow[]
  port: number
  token: string
  logs: string[]
  schemaVersion(): number
  tasksColumns(): string[]
  taskCount(): number
  /** 走完「500ms 聚合 → 呈现」并回当前批 */
  present(): TakeoverBatch
  advance(ms: number): void
  cleanup(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-sniff-'))
  const dbPath = path.join(dir, 'downlord.db')

  const { TaskManager } = await import('../tasks/taskManager')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { listTasks } = await import('../db/taskDao')

  const db = initDatabase(dbPath)
  seedDefaultCategories(db)
  const rawDb = db as unknown as SqliteDb

  const engine = new FakeEngine()
  const resolveCalls: ResolveCall[] = []
  const manager = new TaskManager(
    {
      engine,
      // 解析记下入参后永远挂着:本夹具关心的是「headers 有没有到解析这一步」(改动 #6),
      // 解析结果本身由 `videoResolver` 自己的测试覆盖
      videoResolver: {
        resolve: (url: string, _signal?: AbortSignal, headers?: Record<string, string>) => {
          resolveCalls.push({ url, headers })
          return new Promise(() => {})
        }
      } as never,
      initDatabase: () => db,
      ensureDir: () => {},
      existsSync: () => false,
      readDir: () => [],
      trashItem: async () => {}
    },
    { dbPath, defaultDir: dir, maxConcurrent: 3 }
  )
  await manager.start()

  let now = T0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const windows: FakeWindow[] = []
  const logs: string[] = []
  const addTaskCalls: AddTaskInput[] = []
  const logger: ChannelLogger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m)
  }

  const files = new Map<string, string>()
  const store: JsonConfigStoreFs = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return files.get(p)!
    },
    writeFile: async (p, d) => void files.set(p, d),
    rename: async (from, to) => {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    mkdir: async () => {}
  }

  const takeover = new TakeoverService({
    now: () => now,
    configStore: createTakeoverConfigStore(TAKEOVER_CONFIG_PATH, store),
    onConfigChanged: () => {},
    scheduleTick: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    createWindow: () => {
      const win = makeFakeWindow()
      windows.push(win)
      return win
    },
    isAppReady: () => true,
    hasMainWindow: () => true,
    addTask: (input) => {
      addTaskCalls.push(input)
      return manager.addTask(input)
    },
    onTaskCreated: () => {},
    onDuplicate: (cb) => manager.onDuplicate(cb),
    resolveDuplicate: (res) => manager.resolveDuplicate(res),
    suggestFilename: (url) => url.split('/').pop()?.split('?')[0] ?? 'download',
    getResolvedTheme: () => 'dark',
    logger
  })
  await takeover.init()
  takeover.start()

  const channel = new ExtensionChannelService({
    httpFactory: nodeHttpFactory,
    store,
    configPath: CONFIG_PATH,
    generateToken: () => 'a'.repeat(64),
    now: () => Date.now(),
    appVersion: '0.4.0-test',
    logger,
    sideload: {
      isPackaged: false,
      resourcesPath: 'C:/electron/resources',
      appPath: 'D:/Projects/DownLord',
      existsSync: () => true
    },
    takeover: {
      handleIntent: (intent) => takeover.handleIntent(intent),
      handleSniffSelected: (payload) => takeover.handleSniffSelected(payload),
      handleVideoIntent: (payload) => takeover.handleVideoIntent(payload),
      getConfigView: () => takeover.getConfigView(),
      setPause: (payload) => void takeover.setPause(payload)
    }
  })

  const port = await pickFreePort()
  await channel.init()
  const channelStatus = await channel.setConfig({ enabled: true, port })
  assert.equal(
    channelStatus.service,
    'listening',
    `前置:通道必须真的起来了(port ${port},lastError ${channelStatus.lastError})`
  )

  const flushTimers = (): void => {
    for (const timer of [...timers]) {
      if (timer.cancelled || timer.at > now) continue
      timer.cancelled = true
      timer.fn()
    }
  }

  return {
    takeover,
    engine,
    addTaskCalls,
    resolveCalls,
    windows,
    port,
    token: channel.getConfig().token,
    logs,
    schemaVersion: () =>
      (rawDb.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
    tasksColumns: () =>
      (rawDb.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
    taskCount: () => listTasks(db as never).length,
    advance: (ms) => void (now += ms),
    present: () => {
      flushTimers() // 预热建窗
      takeover.onRendererReady()
      now += 500
      flushTimers()
      return windows[0].sent[0].payload as TakeoverBatch
    },
    cleanup: async () => {
      takeover.stop()
      await channel.stop()
      try {
        db.close()
      } catch {
        /* 忽略 */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 提交当前批(全部条目、跟随落点),等异步建任务落定 */
async function submitAll(h: Harness, batch: TakeoverBatch, dir = 'D:\\Downloads'): Promise<void> {
  h.takeover.onSubmit({
    items: batch.items.map((i) => ({ id: i.id, filename: i.filename })),
    dir
  })
  await flush()
  await flush()
}

// ─────────────────────────────────────────────────────────────────────────────

test('I-03 m3u8 走完整通道 → 建成 kind=video 的任务,headers 恰为两键', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    const reply = await post(h.port, h.token, sniffBody())
    // ★ 受理即回:应答只有 taken(不带 reason)
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: true,
      protocolVersion: 3,
      payload: { taken: true }
    })

    const batch = h.present()
    assert.equal(batch.items.length, 1)
    assert.equal(batch.items[0].kind, 'video', '★ m3u8 → classifySniffed 判 video')

    await submitAll(h, batch)

    // ★ addTask 被调用且 kind === 'video',headers 恰两键(Cookie / Authorization 在协议层就不存在)
    assert.equal(h.addTaskCalls.length, 1)
    assert.equal(h.addTaskCalls[0].kind, 'video')
    assert.equal(h.addTaskCalls[0].source, M3U8_URL, '★ 原始 URL 原样,不剥 query')
    assert.deepStrictEqual(h.addTaskCalls[0].headers, { Referer: REFERRER, 'User-Agent': UA })
    assert.deepStrictEqual(Object.keys(h.addTaskCalls[0].headers ?? {}).sort(), [
      'Referer',
      'User-Agent'
    ])
    assert.equal(h.taskCount(), 1, '真的插库了(走既有 addTask 全链路)')

    // ⚠️ **video 任务此刻不会到引擎** —— 它先进 `resolving`,出队要等 `applySelection`
    //    (spec §1.1 五段链路)。故这里断言的是**更靠前也更关键**的那一步:
    assert.equal(h.engine.addUriCalls.length, 0, 'video 任务在解析完成前不出队,这是既有行为')

    // ★ 改动 #6 的端到端凭证:headers 真的到了**解析**这一步
    //   (防盗链站点在 yt-dlp 拉 m3u8 清单那一步就会 403,只补下载是修不好的)
    assert.equal(h.resolveCalls.length, 1, '视频任务应触发一次解析')
    assert.equal(h.resolveCalls[0].url, M3U8_URL)
    assert.deepStrictEqual(h.resolveCalls[0].headers, { Referer: REFERRER, 'User-Agent': UA })
    // ★ 这份 headers 到 yt-dlp 就是两个专用选项(**不用 --add-header**)
    assert.deepStrictEqual(toYtdlpHeaderArgs(h.resolveCalls[0].headers), [
      '--referer',
      REFERRER,
      '--user-agent',
      UA
    ])
  } finally {
    await h.cleanup()
  }
})

test(
  'I-04 mp4 + application/octet-stream → kind=http,下发 aria2 referer / user-agent 专用选项',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness()
    try {
      await post(
        h.port,
        h.token,
        sniffBody({ url: MP4_URL, contentType: 'application/octet-stream', totalBytes: 88_000_000 })
      )
      const batch = h.present()
      // ★ 这一条正是「③层扩展名分支」的端到端体现:contentType 判不出,靠 `.mp4` 命中
      assert.equal(batch.items[0].kind, 'http')
      assert.equal(batch.items[0].totalBytes, 88_000_000)

      await submitAll(h, batch)

      assert.equal(h.engine.addUriCalls.length, 1)
      const input = h.engine.addUriCalls[0]
      assert.equal(input.video, undefined, 'http 任务不带 video 载荷 → 路由到 aria2')
      assert.deepStrictEqual(input.headers, { Referer: REFERRER, 'User-Agent': UA })
      // ★ 到 aria2 就是两个**专用选项**(刻意不用 `header`,那是任意头的入口)
      assert.deepStrictEqual(toAria2HeaderOptions(input.headers), {
        referer: REFERRER,
        'user-agent': UA
      })
    } finally {
      await h.cleanup()
    }
  }
)

test('I-05 ★ 伪造带 .m4s 的载荷 → taken:false,不建任务、不建窗口', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    // 扩展侧已过滤过分片,故这条只可能来自**伪造** —— 主进程这一层是防御层(分片过滤做两遍)
    const reply = await post(h.port, h.token, sniffBody({ url: M4S_URL, contentType: '' }))
    assert.deepStrictEqual(JSON.parse(reply.body).payload, { taken: false })

    // contentType 侧的伪造同样挡住
    const reply2 = await post(
      h.port,
      h.token,
      sniffBody({ url: 'https://cdn.example.com/x', contentType: 'video/mp2t' })
    )
    assert.deepStrictEqual(JSON.parse(reply2.body).payload, { taken: false })

    h.advance(1000)
    assert.equal(h.windows.length, 0, '★ 一个确认窗口都不该建')
    assert.equal(h.taskCount(), 0, '★ 一条任务都不该建')
    assert.equal(h.engine.addUriCalls.length, 0)
    // 原因码只进日志、不进应答
    assert.ok(h.logs.some((l) => l.includes('不接管(sniff_segment)')))
  } finally {
    await h.cleanup()
  }
})

test('I-05 附:判不出的载荷(普通网页)→ sniff_unknown,同样不受理', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    const reply = await post(
      h.port,
      h.token,
      sniffBody({ url: 'https://example.com/page', contentType: 'text/html' })
    )
    assert.deepStrictEqual(JSON.parse(reply.body).payload, { taken: false })
    assert.equal(h.taskCount(), 0)
    assert.ok(h.logs.some((l) => l.includes('不接管(sniff_unknown)')))
  } finally {
    await h.cleanup()
  }
})

test(
  'I-06 ★ 接管路径回归:不带 headers 的 download.intent,addTask 入参与改动前逐字段相同',
  { skip: !SQLITE_OK },
  async () => {
    const h = await startHarness()
    try {
      await post(h.port, h.token, intentBody())
      const batch = h.present()
      // ★ 接管路径恒 'http'(显式字面量,不是缺省值)
      assert.equal(batch.items[0].kind, 'http')

      await submitAll(h, batch)

      assert.equal(h.engine.addUriCalls.length, 1)
      const input = h.engine.addUriCalls[0]
      assert.equal(input.url, 'https://dl.example.com/setup.exe')
      assert.equal(input.video, undefined)
      // ★ `PendingIntent.kind` 这个新增字段**不泄漏到 AddUriInput** —— 它只活在主进程编排层
      assert.equal('kind' in input, false, '★ kind 不该出现在 AddUriInput 里')
      assert.deepStrictEqual(Object.keys(input).sort(), ['dir', 'filename', 'headers', 'url'])
    } finally {
      await h.cleanup()
    }
  }
)

test('I-07 ★ 零落库零 schema:跑完两条转交后 schema_version 与流程前同值', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    const before = h.schemaVersion()

    await post(h.port, h.token, sniffBody())
    const first = h.present()
    await submitAll(h, first)

    await post(h.port, h.token, sniffBody({ url: MP4_URL, contentType: 'application/octet-stream' }))
    h.advance(500)
    const second = h.windows[0].sent[1]?.payload as TakeoverBatch | undefined
    if (second) await submitAll(h, second)

    assert.equal(h.schemaVersion(), before, '★ 嗅探不带任何 schema 迁移')
    // ★ tasks 表列清单不含任何 sniff 字段(零落库红线的机器判据)
    const columns = h.tasksColumns()
    assert.equal(
      columns.some((c) => c.toLowerCase().includes('sniff')),
      false,
      `★ tasks 表不该有 sniff 字段,实得列:${columns.join(',')}`
    )
    // 反向对照:列清单确实读到了(否则上面那条恒绿)
    assert.ok(columns.includes('kind') && columns.includes('source'), '反向对照:PRAGMA 确实读到了列')
    // 反向对照:任务是真的建出来了(否则这条断言恒绿,等于什么都没测)
    assert.ok(h.taskCount() > 0, '反向对照:确实建了任务,schema 却没动')
  } finally {
    await h.cleanup()
  }
})

test('I-10 ★ 旧扩展报 protocolVersion:1 → 409 protocol_mismatch,不受理', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    const body = JSON.stringify({
      type: 'sniff.addSelected',
      protocolVersion: 1,
      payload: {
        url: M3U8_URL,
        contentType: 'application/vnd.apple.mpegurl',
        referrer: REFERRER,
        userAgent: UA,
        totalBytes: -1
      }
    })
    const reply = await post(h.port, h.token, body)

    assert.equal(reply.status, 409)
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: false,
      reason: 'protocol_mismatch',
      appProtocolVersion: 3
    })
    h.advance(1000)
    assert.equal(h.windows.length, 0, '版本不符 → 连窗口都不建')
    assert.equal(h.taskCount(), 0)
  } finally {
    await h.cleanup()
  }
})

test('★ 日志红线:嗅探路径的任何一行都不含完整 URL / query 签名 / referrer / UA / token', { skip: !SQLITE_OK }, async () => {
  const h = await startHarness()
  try {
    await post(h.port, h.token, sniffBody()) // 受理路径
    await post(h.port, h.token, sniffBody({ url: M4S_URL, contentType: '' })) // 拒绝路径

    const joined = h.logs.join('\n')
    assert.ok(h.logs.length > 0)
    assert.equal(joined.includes(M3U8_URL), false, '★ 完整 URL 不许进日志')
    assert.equal(joined.includes('SECRETTOKEN789'), false, '★ query 里的 token 不许进日志')
    assert.equal(joined.includes(REFERRER), false, '★ referrer 完整值不许进日志')
    assert.equal(joined.includes(UA), false, '★ UA 全串不许进日志')
    assert.equal(joined.includes(h.token), false, '★ 通道 token 一个字符都不许进日志')
    // 反向对照:host 与结论**应该**记(否则上面几条恒绿,等于什么都没测)
    assert.ok(joined.includes('cdn.example.com'), 'host 是排障必需,应如实记')
    assert.ok(joined.includes('kind=video'), '分流结论是主进程自己的判定,应如实记')
  } finally {
    await h.cleanup()
  }
})
