/**
 * 接管集成测试(I-01 / I-02 / I-10 / I-12;v0.4 Task 4 · spec §7.2)。
 *
 * 沿用 Task 3 §6.4 的做法:起**本机回环服务**(`port: 0` 让 OS 分配)+ 注入 fake 窗口 / fake 时钟 /
 * 记录式 `addTask`。**不依赖真实网络、真实引擎、真实 `BrowserWindow`**。
 *
 * ⚠️ spec 的 I-01 写「fake 引擎 `addUriCalls.length === 0`」——本文件断言的是**更靠前的同一判据**:
 *    `addTask` 调用数为 0。接管路径与引擎之间隔着整条既有 `addTask` 全链路,`addTask` 没被调用
 *    就不可能有 `addUri`;而注入 `addTask` 让本测试免于拖进 SQLite 与引擎(它们由既有测试覆盖)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer } from 'node:net'
import { request as httpRequest } from 'node:http'

import { ExtensionChannelService } from '../extensionChannel/extensionChannelService'
import { nodeHttpFactory } from '../extensionChannel/nodeHttpFactory'
import { validateChannelPort } from '../extensionChannel/portValidation'
import type { ChannelLogger } from '../extensionChannel/channelServer'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import { IpcChannel, type AddTaskInput, type TakeoverBatch, type TakeoverSettingsView } from '../../shared/ipc'
import { TakeoverService, type TakeoverWindowHandle } from './takeoverService'
import { createTakeoverConfigStore, cloneDefaultTakeoverConfig } from './takeoverConfig'

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const CONFIG_PATH = 'C:/userData/config/extensionChannel.json'
const TAKEOVER_CONFIG_PATH = 'C:/userData/config/takeover.json'
const T0 = 1_700_000_000_000

const INTENT_URL = 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe?sign=SECRETSIGN123&t=1754'
const INTENT_REFERRER = 'https://uu.163.com/session?sid=SECRETSESSION456'
const INTENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

/** 一条真实的 `download.intent` 信封 */
function intentBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'download.intent',
    protocolVersion: 3,
    payload: {
      url: INTENT_URL,
      referrer: INTENT_REFERRER,
      danger: 'safe',
      totalBytes: 192_000_000,
      userAgent: INTENT_UA,
      ...overrides
    }
  })
}

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

/** 记录式假窗口。**行为按 `TakeoverWindowHandle` 的契约实现**(尤其 `showOnce` 只生效一次) */
interface FakeWindow extends TakeoverWindowHandle {
  sent: { channel: string; payload: unknown }[]
  shownTimes: number
  closedTimes: number
  /** 最后一次 setContentHeight 的值(态 A 300 / 态 B 按条数 / 态 C 330) */
  contentHeight: number
  fireClosed(): void
}

function makeFakeWindow(id = 101): FakeWindow {
  const closedCallbacks: (() => void)[] = []
  let destroyed = false
  const win: FakeWindow = {
    sent: [],
    shownTimes: 0,
    closedTimes: 0,
    contentHeight: 300,
    send: (channel, payload) => void win.sent.push({ channel, payload }),
    // 契约:「首次呈现 show + focus 一次,已可见则 no-op」——真实现的 `shown` 闭包同形
    showOnce: () => void (win.shownTimes === 0 && (win.shownTimes = 1)),
    setContentHeight: (h) => void (win.contentHeight = h),
    close: () => {
      win.closedTimes += 1
      destroyed = true
      for (const cb of closedCallbacks) cb()
    },
    isDestroyed: () => destroyed,
    webContentsId: () => (destroyed ? null : id),
    onClosed: (cb) => void closedCallbacks.push(cb),
    fireClosed: () => {
      destroyed = true
      for (const cb of closedCallbacks) cb()
    }
  }
  return win
}

interface Harness {
  takeover: TakeoverService
  channel: ExtensionChannelService
  port: number
  token: string
  addTaskCalls: AddTaskInput[]
  windows: FakeWindow[]
  createdCount: () => number
  logs: string[]
  taskAddedBroadcasts: { count: number }
  /** 每次接管配置广播的快照(设置页 / popup 两个写入口都必须推) */
  configBroadcasts: TakeoverSettingsView[]
  /** 落盘内容(内存 fake fs;I-08 直接读 `takeover.json` 断言键集合) */
  files: Map<string, string>
  /** 跑掉所有到期的定时器(手动时钟:先 `advance` 再 `flush`) */
  flushTimers(): void
  advance(ms: number): void
  now(): number
  stop(): Promise<void>
}

async function makeHarness(
  options: { createWindowThrows?: boolean; addTaskId?: () => string } = {}
): Promise<Harness> {
  let now = T0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const addTaskCalls: AddTaskInput[] = []
  const windows: FakeWindow[] = []
  const logs: string[] = []
  /** 「主进程侧建了任务,主窗口去重拉」广播的次数(2026-08-02 真机修复的机器守卫) */
  const taskAddedBroadcasts = { count: 0 }
  const logger: ChannelLogger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m)
  }
  let idSeq = 0

  // 内存 fake fs:通道配置与接管配置共用一份(两者本来就同目录),便于 I-08 直接读落盘内容
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
  /** 每次配置广播的快照(设置页 / popup 两个写入口都要推,机器守卫在此) */
  const configBroadcasts: TakeoverSettingsView[] = []

  const takeover = new TakeoverService({
    now: () => now,
    configStore: createTakeoverConfigStore(TAKEOVER_CONFIG_PATH, store),
    onConfigChanged: (view) => void configBroadcasts.push(view),
    scheduleTick: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    createWindow: () => {
      if (options.createWindowThrows) throw new Error('BrowserWindow 建不出来(注入)')
      const win = makeFakeWindow(101 + windows.length)
      windows.push(win)
      return win
    },
    isAppReady: () => true,
    hasMainWindow: () => true,
    addTask: async (input) => {
      addTaskCalls.push(input)
      return options.addTaskId?.() ?? `task_${++idSeq}`
    },
    onTaskCreated: () => void (taskAddedBroadcasts.count += 1),
    onDuplicate: () => () => {},
    resolveDuplicate: async () => {},
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

  return {
    takeover,
    channel,
    port,
    token: channel.getConfig().token,
    addTaskCalls,
    windows,
    createdCount: () => windows.length,
    logs,
    taskAddedBroadcasts,
    configBroadcasts,
    files,
    advance: (ms) => void (now += ms),
    now: () => now,
    flushTimers: () => {
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.at > now) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    stop: async () => {
      takeover.stop()
      await channel.stop()
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

test('I-01 受理即回:响应到达时**任务尚未创建、窗口尚未创建**;500ms 后才收到 present', async () => {
  const h = await makeHarness()
  try {
    const reply = await post(h.port, h.token, intentBody())

    // ① 应答 —— **只有 taken 一个字段**(不带 reason,§2.4 第一层)
    assert.equal(reply.status, 200)
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: true,
      protocolVersion: 3,
      payload: { taken: true }
    })

    // ★ ② 受理即回的机器判据:应答已经到手,而任务一个都没建
    assert.equal(h.addTaskCalls.length, 0, '★ 响应到达时任务必须尚未创建(受理 ≠ 已建任务)')
    assert.equal(h.createdCount(), 0, '窗口也还没建 —— 弹窗在应答之后异步进行')

    // ③ 预热(0ms)→ 窗口建出来但**还没内容、还没 show**
    h.flushTimers()
    assert.equal(h.createdCount(), 1)
    assert.equal(h.windows[0].sent.length, 0)
    assert.equal(h.windows[0].shownTimes, 0)

    // ④ 渲染层就绪(未到 500ms,仍不推)
    h.takeover.onRendererReady()
    assert.equal(h.windows[0].sent.length, 0)

    // ⑤ 推进 500ms + 跑 tick → 这时才收到 present,且带着已解析主题
    h.advance(500)
    h.flushTimers()
    assert.equal(h.windows[0].sent.length, 1)
    assert.equal(h.windows[0].sent[0].channel, IpcChannel.TakeoverPresent)
    const batch = h.windows[0].sent[0].payload as TakeoverBatch
    assert.equal(batch.items.length, 1)
    assert.equal(batch.items[0].host, 'uu.gdl.netease.com')
    assert.equal(batch.items[0].filename, 'UU-6.15.1.exe')
    assert.equal(batch.items[0].totalBytes, 192_000_000)
    assert.equal(batch.theme, 'dark')
    // 先送内容再 show —— 窗口带着内容出现
    assert.equal(h.windows[0].shownTimes, 1)
  } finally {
    await h.stop()
  }
})

test('I-02 用户确认 → addTask 参数逐字段正确(kind / source / filename / dir sentinel)', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(500)
    h.flushTimers()

    const batch = h.windows[0].sent[0].payload as TakeoverBatch
    h.takeover.onSubmit({
      items: [{ id: batch.items[0].id, filename: '我改过的名字.exe' }],
      dir: 'D:\\Downloads' // = pickedDir ?? defaultDir 的 sentinel
    })
    await new Promise((r) => setImmediate(r))

    assert.equal(h.addTaskCalls.length, 1)
    assert.deepStrictEqual(h.addTaskCalls[0], {
      kind: 'http',
      source: INTENT_URL, // ★ 原始 url,不是 finalUrl、不是被截断的东西
      filename: '我改过的名字.exe',
      dir: 'D:\\Downloads',
      // ★ Phase 3(spec §6.2 白名单第②层):**恰好两键,不多不少** ——
      //   `Cookie` / `Authorization` 之类在协议层就不存在(第①层),这里再兜一次
      headers: { Referer: INTENT_REFERRER, 'User-Agent': INTENT_UA }
    })
    assert.deepStrictEqual(Object.keys(h.addTaskCalls[0].headers ?? {}).sort(), [
      'Referer',
      'User-Agent'
    ])
    assert.deepStrictEqual(Object.keys(h.addTaskCalls[0]).sort(), [
      'dir',
      'filename',
      'headers',
      'kind',
      'source'
    ])
    // 缓冲空 → 关窗
    assert.equal(h.windows[0].closedTimes, 1)
    // ★ 2026-08-02 真机修复:主进程侧建的任务必须广播一次「去重拉」,
    //   否则主列表要等到完成帧才突然冒出一条已下完的记录
    assert.equal(h.taskAddedBroadcasts.count, 1)
  } finally {
    await h.stop()
  }
})

test('I-02 用户点「取消」→ 零任务、窗口关闭(不是黑洞:用户知情的放弃)', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(500)
    h.flushTimers()

    h.takeover.onDismiss()
    assert.equal(h.addTaskCalls.length, 0)
    assert.equal(h.windows[0].closedTimes, 1)
    // 什么都没建 → 不广播(免得主窗口白白重拉一次)
    assert.equal(h.taskAddedBroadcasts.count, 0)
  } finally {
    await h.stop()
  }
})

test('I-10 日志红线:任何一行都不含完整 URL / referrer 值 / UA 全串 / token', async () => {
  const h = await makeHarness()
  try {
    // 通过路径
    await post(h.port, h.token, intentBody())
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(500)
    h.flushTimers()
    // 拒绝路径(danger 非 safe)
    await post(h.port, h.token, intentBody({ danger: 'uncommon' }))

    const joined = h.logs.join('\n')
    assert.ok(h.logs.length > 0, '至少应有受理 / 拒绝 / 监听几行')
    assert.equal(joined.includes(INTENT_URL), false, '★ 完整 URL(含查询串)不许进日志')
    assert.equal(joined.includes('SECRETSIGN123'), false, '★ 查询串里的签名不许进日志')
    assert.equal(joined.includes(INTENT_REFERRER), false, '★ referrer 完整值不许进日志')
    assert.equal(joined.includes('SECRETSESSION456'), false, '★ referrer 里的会话不许进日志')
    assert.equal(joined.includes(INTENT_UA), false, '★ UA 全串不许进日志')
    assert.equal(joined.includes(h.token), false, '★ token 一个字符都不许进日志')
    // 反向对照:host 与决策**应该**记(否则这条断言恒绿,等于什么都没测)
    assert.ok(joined.includes('uu.gdl.netease.com'), 'host 是排障必需,应如实记')
    assert.ok(joined.includes('不接管(danger)'), '拒绝原因码应进日志(只进日志,不进应答)')
  } finally {
    await h.stop()
  }
})

test('★ byExtensionId 只在日志里出现(手测 M15 的机器守卫);决策层依旧拿不到它', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody({ byExtensionId: 'abcdefghijklmnopabcdefghijklmnop' }))
    const joined = h.logs.join('\n')

    // 「只记事实」这一半:协议传了它,日志就该留下,否则「哪个扩展发起的」在排障时无从查起
    assert.ok(joined.includes('byExt=abcdefghijklmnopabcdefghijklmnop'), 'byExtensionId 应如实进日志')
    // 「不据此决策」那一半仍由 `normalizeIntent` 的返回形状钉死 —— 这里顺带反向对照:
    // 日志红线一条都没松(完整 URL / 签名 / referrer / UA / token 依旧不许进)
    assert.equal(joined.includes(INTENT_URL), false, '★ 加了 byExt 不等于日志红线可以松')
    assert.equal(joined.includes(INTENT_UA), false, '★ UA 全串依旧不许进日志')
  } finally {
    await h.stop()
  }
})

test('★ 没有 byExtensionId(用户自己点的下载)→ 日志里不出现 byExt= 这一段', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())

    // 反向对照:上一条若写成无条件拼接,这一条会看到 `byExt=undefined`
    assert.equal(h.logs.join('\n').includes('byExt='), false)
  } finally {
    await h.stop()
  }
})

test('I-12 熔断:createWindow 抛错 → 记 error 并丢弃已受理条目;此后所有 intent 恒 taken:false', async () => {  const h = await makeHarness({ createWindowThrows: true })
  try {
    // ⚠️ 如实标注:**首条**仍回 `taken:true` —— 「受理即回」要求应答不等窗口,
    //    而「建窗会不会抛」只有真去建才知道。故首批在预热时被熔断丢弃并记 error(不静默)。
    const first = await post(h.port, h.token, intentBody())
    assert.deepStrictEqual(JSON.parse(first.body).payload, { taken: true })

    h.flushTimers() // 预热 → 建窗抛错 → 熔断
    assert.ok(
      h.logs.some((l) => l.includes('创建确认窗口失败')),
      '建窗失败必须记一条 error'
    )
    assert.ok(
      h.logs.some((l) => l.includes('无法确认')),
      '已受理却弹不出来的条目必须如实记,不静默积压'
    )

    // ★ 此后恒 false(canPresent 第②条),且不再尝试建窗
    for (let i = 0; i < 3; i++) {
      const reply = await post(h.port, h.token, intentBody())
      assert.deepStrictEqual(JSON.parse(reply.body).payload, { taken: false })
    }
    assert.equal(h.addTaskCalls.length, 0)
  } finally {
    await h.stop()
  }
})

test('canPresent ③:主窗口已关(应用正在退出)→ 不接管,浏览器照常下', async () => {
  const h = await makeHarness()
  try {
    // 直接改注入的判据比造一个假 BrowserWindow 更贴近判据本身
    const closed = new TakeoverService({
      now: () => T0,
      configStore: { read: async () => cloneDefaultTakeoverConfig(), write: async () => {} },
      onConfigChanged: () => {},
      scheduleTick: () => () => {},
      createWindow: () => makeFakeWindow(),
      isAppReady: () => true,
      hasMainWindow: () => false, // ← 主窗口已关
      addTask: async () => 'x',
      onTaskCreated: () => {},
      onDuplicate: () => () => {},
      resolveDuplicate: async () => {},
      suggestFilename: () => 'x.exe',
      getResolvedTheme: () => 'light',
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    })
    closed.start()
    assert.deepEqual(
      closed.handleIntent({
        url: INTENT_URL,
        referrer: '',
        danger: 'safe',
        totalBytes: 1,
        userAgent: ''
      }),
      { taken: false }
    )
  } finally {
    await h.stop()
  }
})

test('连点两条(同一 500ms 窗口)→ 只弹一个窗口、**一批两条**(态 B),一条都不丢', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())
    h.advance(100)
    await post(h.port, h.token, intentBody({ url: 'https://a.com/second.zip' }))
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(400) // 距首条恰好 500ms
    h.flushTimers()

    assert.equal(h.createdCount(), 1, '★ 屏幕上永远只有一个确认窗口')
    assert.equal(h.windows[0].sent.length, 1, '★ 态 B:一次 present 送整批,不再逐条换内容')
    const batch = h.windows[0].sent[0].payload as TakeoverBatch
    assert.equal(batch.items.length, 2, '两条在同一批里')
    assert.deepEqual(
      batch.items.map((i) => i.filename),
      ['UU-6.15.1.exe', 'second.zip'],
      '顺序 = 到达顺序'
    )
    // 高度按条数走(268 + 2×44),不是态 A 的 300
    assert.equal(h.windows[0].contentHeight, 268 + 2 * 44)

    // 一次提交两条 → 两个任务;窗口随即关闭(缓冲已空)
    h.takeover.onSubmit({
      items: batch.items.map((i) => ({ id: i.id, filename: i.filename })),
      dir: 'D:\\dl'
    })
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      h.addTaskCalls.map((c) => c.filename),
      ['UU-6.15.1.exe', 'second.zip']
    )
    assert.equal(h.windows[0].shownTimes, 1, '用户只被抢焦一次')
    assert.equal(h.windows[0].closedTimes, 1, '两条都处理完 → 关窗')
  } finally {
    await h.stop()
  }
})

test('态 B 逐条移除:提交载荷里没有的条目不建任务(移除 = 这次不下,不是取消浏览器下载)', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())
    h.advance(100)
    await post(h.port, h.token, intentBody({ url: 'https://a.com/second.zip' }))
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(400)
    h.flushTimers()

    const batch = h.windows[0].sent[0].payload as TakeoverBatch
    // 用户在列表里点掉了第一条的 ×
    h.takeover.onSubmit({
      items: [{ id: batch.items[1].id, filename: 'second.zip' }],
      dir: 'D:\\dl'
    })
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      h.addTaskCalls.map((c) => c.filename),
      ['second.zip'],
      '被移除的那条不建任务'
    )
  } finally {
    await h.stop()
  }
})

test('窗口被用户关掉(非取消)→ 缓冲非空则立刻重开一个,不静默积压', async () => {
  const h = await makeHarness()
  try {
    await post(h.port, h.token, intentBody())
    h.flushTimers()
    h.takeover.onRendererReady()
    h.advance(500)
    h.flushTimers()

    // 呈现中又来一条 → 只攒
    h.advance(50)
    await post(h.port, h.token, intentBody({ url: 'https://a.com/next.zip' }))
    assert.equal(h.createdCount(), 1)

    // 用户直接关窗(不点取消)
    h.windows[0].fireClosed()
    assert.equal(h.createdCount(), 2, '缓冲非空 → 立刻重开一个')
    h.takeover.onRendererReady()
    const batch = h.windows[1].sent[0].payload as TakeoverBatch
    assert.equal(batch.items[0].filename, 'next.zip')
  } finally {
    await h.stop()
  }
})

test('stop() 后再来的 intent 恒不接管(退出流程中接了也没人管)', async () => {
  const h = await makeHarness()
  try {
    h.takeover.stop()
    const reply = await post(h.port, h.token, intentBody())
    assert.deepStrictEqual(JSON.parse(reply.body).payload, { taken: false })
  } finally {
    await h.stop()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 临时暂停接管 / 域名例外 / 落盘键集合(I-06 / I-07 / I-08;spec §7.2 · plan 4.1)
// ─────────────────────────────────────────────────────────────────────────────

/** 打一条 intent 并取出 `taken`(全程走真通道:三闸 + 分发 + 终裁) */
async function taken(h: Harness, url?: string): Promise<boolean> {
  const reply = await post(h.port, h.token, url === undefined ? intentBody() : intentBody({ url }))
  return (JSON.parse(reply.body) as { payload: { taken: boolean } }).payload.taken
}

test('I-06 暂停:setPause{minutes:60} → 立刻不接管;假时钟推进 61 分钟 → 同一 config 又接管', async () => {
  const h = await makeHarness()
  try {
    assert.equal(await taken(h), true, '前置:默认配置下本来是接管的')

    // 走**真通道**下发 setPause(即 popup 遥控器那条路径),不直接调服务
    const reply = await post(
      h.port,
      h.token,
      JSON.stringify({ type: 'takeover.setPause', protocolVersion: 3, payload: { minutes: 60 } })
    )
    // 应答直接回**写后的快照**(popup 就地更新,不再回读一次);**只有三键**,不含域名例外表
    const view = (JSON.parse(reply.body) as { payload: Record<string, unknown> }).payload
    assert.deepStrictEqual(Object.keys(view).sort(), ['enabled', 'paused', 'pausedUntil'])
    assert.equal(view.paused, true)
    assert.equal(view.pausedUntil, h.now() + 60 * 60_000, '落的是绝对时刻,不是剩余分钟')

    assert.equal(await taken(h), false, '★ 暂停中:立刻不接管')

    // ★ 过期不清零、零定时器:同一份 config,只把时钟推过去
    h.advance(61 * 60_000)
    assert.equal(await taken(h), true, '★ 到期后同一 config 自动恢复接管(现算,无人清零)')
  } finally {
    await h.stop()
  }
})

test('I-06 附:暂停中的拒绝与「未运行」走同一条路径 —— 应答只有 taken、不带 reason', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setPause({ minutes: 15 })
    const reply = await post(h.port, h.token, intentBody())
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: true,
      protocolVersion: 3,
      payload: { taken: false }
    })
    // 原因码只进日志,不进应答
    assert.ok(h.logs.some((l) => l.includes('不接管(paused)')))
  } finally {
    await h.stop()
  }
})

test('I-06 附:setPause{minutes:null} = 恢复接管(pausedUntil 落回 null)', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setPause({ minutes: 240 })
    assert.equal(await taken(h), false)
    const view = h.takeover.setPause({ minutes: null })
    assert.equal(view.pausedUntil, null)
    assert.equal(view.paused, false)
    assert.equal(await taken(h), true)
  } finally {
    await h.stop()
  }
})

test('I-07 域名例外:配置含 example.com → https://dl.example.com/x.zip 的 intent 不接管', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setSettings({ excludedDomains: ['example.com'] })
    assert.equal(await taken(h, 'https://dl.example.com/x.zip'), false, '★ 子域命中后缀匹配')
    assert.equal(await taken(h, 'https://example.com/x.zip'), false, '精确匹配同样命中')
    // **不**命中非后缀的相似域 —— `xa.com` 不是 `a.com` 的子域
    assert.equal(await taken(h, 'https://notexample.com/x.zip'), true)
  } finally {
    await h.stop()
  }
})

test('I-07 附:域名在主进程归一 —— 用户粘一整条 URL 进例外表照样命中', async () => {
  const h = await makeHarness()
  try {
    const view = h.takeover.setSettings({ excludedDomains: ['  HTTPS://DL.Example.com/x.zip?t=1  '] })
    assert.deepStrictEqual(view.excludedDomains, ['dl.example.com'], '结论归主进程,渲染层以回包为准')
    assert.equal(await taken(h, 'https://dl.example.com/y.zip'), false)
  } finally {
    await h.stop()
  }
})

test('★ I-08 落盘 JSON 的键集合**恰好三个** —— 防日后有人顺手塞进连接态 / headers', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setPause({ minutes: 15 })
    h.takeover.setSettings({ enabled: false, excludedDomains: ['a.com'] })
    await h.takeover.flushWrites()

    const raw = h.files.get(TAKEOVER_CONFIG_PATH)
    assert.ok(raw, 'takeover.json 必须已落盘')
    const onDisk = JSON.parse(raw) as Record<string, unknown>
    assert.deepStrictEqual(Object.keys(onDisk).sort(), [
      'enabled',
      'excludedDomains',
      'pausedUntil'
    ])
    assert.equal(onDisk.enabled, false)
    assert.equal(onDisk.pausedUntil, h.now() + 15 * 60_000)
    assert.deepStrictEqual(onDisk.excludedDomains, ['a.com'])
  } finally {
    await h.stop()
  }
})

test('I-08 附:pausedUntil **落盘** —— 重起一个服务读同一份文件,暂停仍在(不是内存态)', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setPause({ minutes: 60 })
    await h.takeover.flushWrites()

    // 模拟「DownLord 重启」:同一份 fake fs、新服务实例
    const reborn = new TakeoverService({
      now: () => h.now(),
      configStore: createTakeoverConfigStore(TAKEOVER_CONFIG_PATH, {
        readFile: async (p) => {
          const v = h.files.get(p)
          if (v === undefined) throw new Error('ENOENT')
          return v
        },
        writeFile: async (p, d) => void h.files.set(p, d),
        rename: async (from, to) => {
          h.files.set(to, h.files.get(from) as string)
          h.files.delete(from)
        },
        mkdir: async () => {}
      }),
      onConfigChanged: () => {},
      scheduleTick: () => () => {},
      createWindow: () => makeFakeWindow(),
      isAppReady: () => true,
      hasMainWindow: () => true,
      addTask: async () => 'x',
      onTaskCreated: () => {},
      onDuplicate: () => () => {},
      resolveDuplicate: async () => {},
      suggestFilename: () => 'x.exe',
      getResolvedTheme: () => 'light',
      logger: { info: () => {}, warn: () => {}, error: () => {} }
    })
    await reborn.init()
    reborn.start()
    assert.equal(reborn.getSettings().paused, true, '★ 重启后暂停仍生效 —— 否则等于违背用户明确表达')
    reborn.stop()
  } finally {
    await h.stop()
  }
})

test('配置变更两个写入口都广播(设置页 / popup 遥控器共用同一份真源)', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setPause({ minutes: 15 })
    h.takeover.setSettings({ enabled: false })
    assert.equal(h.configBroadcasts.length, 2)
    assert.equal(h.configBroadcasts[0].paused, true)
    assert.equal(h.configBroadcasts[1].enabled, false)
    // 广播载荷是**四键**(窗口内的东西,含域名例外表)
    assert.deepStrictEqual(Object.keys(h.configBroadcasts[1]).sort(), [
      'enabled',
      'excludedDomains',
      'paused',
      'pausedUntil'
    ])
  } finally {
    await h.stop()
  }
})

test('总开关关掉 → 一律不接管(与暂停同一条降级路径,原因码 disabled 只进日志)', async () => {
  const h = await makeHarness()
  try {
    h.takeover.setSettings({ enabled: false })
    assert.equal(await taken(h), false)
    assert.ok(h.logs.some((l) => l.includes('不接管(disabled)')))
  } finally {
    await h.stop()
  }
})
