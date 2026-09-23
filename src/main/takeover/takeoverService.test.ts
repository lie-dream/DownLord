/**
 * `TakeoverService` 的嗅探转交单测(U-30~U-32;v0.4 Task 5 · spec §4.2 / §4.4 / §7.1)。
 *
 * 全部注入 fake(时钟 / 定时器 / 窗口 / `addTask` / logger),**不起服务、不建真 `BrowserWindow`、
 * 不碰 SQLite** —— 端到端那半在 `sniffTakeover.integration.test.ts`。
 *
 * ★ **U-30 的形式是「同一测试文件内对照」**:同一份配置下,`handleSniffSelected` 与
 *   `handleIntent` 各打一次,断言**两者结论相反**。只断言嗅探恒 `taken:true` 是不够的 ——
 *   那样即使有人把 `decideTakeover` 整个删掉(两条路径都不判了),用例照样绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { DownloadIntent, SniffAddSelected } from '../../shared/extensionProtocol'
import { TakeoverService, type PendingIntent, type TakeoverWindowHandle } from './takeoverService'
import { cloneDefaultTakeoverConfig, type TakeoverConfig } from './takeoverConfig'
import type { AddTaskInput, CookieSource, TakeoverBatch } from '../../shared/ipc'

const T0 = 1_700_000_000_000

const M3U8 = 'https://cdn.example.com/hls/index.m3u8?token=abc'
const MP4 = 'https://cdn.example.com/v/movie.mp4'
const M4S = 'https://cdn.example.com/hls/seg-1.m4s'
const EXE = 'https://cdn.example.com/dl/setup.exe'
const REFERRER = 'https://page.example.com'
const UA = 'Mozilla/5.0 Chrome/131.0.0.0'

function sniff(overrides: Partial<SniffAddSelected> = {}): SniffAddSelected {
  return {
    url: M3U8,
    contentType: 'application/vnd.apple.mpegurl',
    referrer: REFERRER,
    userAgent: UA,
    totalBytes: -1,
    ...overrides
  }
}

function intent(overrides: Partial<DownloadIntent> = {}): DownloadIntent {
  return {
    url: EXE,
    referrer: REFERRER,
    danger: 'safe',
    totalBytes: 1000,
    userAgent: UA,
    ...overrides
  }
}

interface FakeWindow extends TakeoverWindowHandle {
  sent: { channel: string; payload: unknown }[]
}

function makeWindow(): FakeWindow {
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

interface Fixture {
  service: TakeoverService
  windows: FakeWindow[]
  addTaskCalls: AddTaskInput[]
  logs: string[]
  advance(ms: number): void
  flushTimers(): void
  /** 走完「聚合 → 呈现」并回当前批 */
  present(): TakeoverBatch
}

/** 第四档相关的可注入项(v0.4 Task 6;缺省 = 未选第四档 + 持有层为空 = **零外泄默认**) */
interface CookieOpts {
  cookieSource?: CookieSource
  borrowedHosts?: string[]
}

function makeService(config: Partial<TakeoverConfig> = {}, cookie: CookieOpts = {}): Fixture {
  let now = T0
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  const windows: FakeWindow[] = []
  const addTaskCalls: AddTaskInput[] = []
  const logs: string[] = []
  const merged: TakeoverConfig = { ...cloneDefaultTakeoverConfig(), ...config }

  const service = new TakeoverService({
    now: () => now,
    configStore: { read: async () => merged, write: async () => {} },
    onConfigChanged: () => {},
    scheduleTick: (delayMs, fn) => {
      const timer = { at: now + delayMs, fn, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    createWindow: () => {
      const win = makeWindow()
      windows.push(win)
      return win
    },
    isAppReady: () => true,
    hasMainWindow: () => true,
    addTask: async (input) => {
      addTaskCalls.push(input)
      return `task_${addTaskCalls.length}`
    },
    onTaskCreated: () => {},
    onDuplicate: () => () => {},
    resolveDuplicate: async () => {},
    suggestFilename: (url) => url.split('/').pop()?.split('?')[0] ?? 'download',
    getResolvedTheme: () => 'dark',
    getCookieSource: () => cookie.cookieSource ?? 'none',
    getBorrowedCookieHosts: () => cookie.borrowedHosts ?? [],
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m)
    }
  })

  const flushTimers = (): void => {
    for (const timer of [...timers]) {
      if (timer.cancelled || timer.at > now) continue
      timer.cancelled = true
      timer.fn()
    }
  }

  return {
    service,
    windows,
    addTaskCalls,
    logs,
    advance: (ms) => void (now += ms),
    flushTimers,
    present: () => {
      flushTimers()
      service.onRendererReady()
      now += 500
      flushTimers()
      return windows[0].sent[0].payload as TakeoverBatch
    }
  }
}

/** 起一个已 `init()` + `start()` 的服务 */
async function started(
  config: Partial<TakeoverConfig> = {},
  cookie: CookieOpts = {}
): Promise<Fixture> {
  const f = makeService(config, cookie)
  await f.service.init()
  f.service.start()
  return f
}

// ── U-30 跳过四道:同一配置下,嗅探受理而接管拒绝 ─────────────────────────────

/** 四道中的三道各自能被配置触发(第四道 `danger` 嗅探路径根本没有,单列在下面) */
const SKIPPED_GATES: { label: string; config: Partial<TakeoverConfig> }[] = [
  { label: 'enabled=false(接管总开关关掉 ≠ 不想用嗅探,是两个功能)', config: { enabled: false } },
  {
    label: 'pausedUntil 在未来(暂停=交回浏览器,可 m3u8 浏览器根本下不了)',
    config: { pausedUntil: T0 + 60 * 60_000 }
  },
  {
    label: 'host 在域名例外表(用户主动点 > 域名例外)',
    config: { excludedDomains: ['cdn.example.com'] }
  }
]

for (const gate of SKIPPED_GATES) {
  test(`U-30 ★ 跳过四道 —— ${gate.label}`, async () => {
    const f = await started(gate.config)

    // ★ 同一份配置、同一个 host,两条路径打一次:结论必须**相反**
    const sniffed = f.service.handleSniffSelected(sniff({ url: MP4, contentType: 'video/mp4' }))
    const taken = f.service.handleIntent(intent({ url: MP4 }))

    assert.deepStrictEqual(sniffed, { taken: true }, '★ 嗅探路径跳过这一道 → 受理')
    assert.deepStrictEqual(taken, { taken: false }, '★ 接管路径仍被这一道拦下 —— 对照组')
  })
}

test('U-30 附:三道同时命中,嗅探照样受理(不是「只跳过其中一道」)', async () => {
  const f = await started({
    enabled: false,
    pausedUntil: T0 + 60 * 60_000,
    excludedDomains: ['cdn.example.com']
  })
  assert.deepStrictEqual(f.service.handleSniffSelected(sniff()), { taken: true })
  assert.deepStrictEqual(f.service.handleIntent(intent({ url: MP4 })), { taken: false })
})

test('U-30 附:第四道 danger —— 嗅探载荷根本没有这个字段,不可能被它拦', async () => {
  const f = await started()
  // 接管路径:danger 非 safe → 拒
  assert.deepStrictEqual(f.service.handleIntent(intent({ danger: 'uncommon' })), { taken: false })
  // 嗅探路径:`normalizeSniffIntent` 产出的 danger 恒为空串,而这一道**根本不跑**
  assert.deepStrictEqual(f.service.handleSniffSelected(sniff()), { taken: true })
})

test('U-30 附:生命周期守卫与 canPresent **不在跳过之列**(它们防的是黑洞,不是「抢不抢」)', async () => {
  // ① stop() 后:接了也没人管
  const stopped = await started()
  stopped.service.stop()
  assert.deepStrictEqual(stopped.service.handleSniffSelected(sniff()), { taken: false })

  // ② 主窗口已关(= 应用正在退出)→ canPresent 第③条
  const f = makeService()
  const noMain = new TakeoverService({
    now: () => T0,
    configStore: { read: async () => cloneDefaultTakeoverConfig(), write: async () => {} },
    onConfigChanged: () => {},
    scheduleTick: () => () => {},
    createWindow: () => makeWindow(),
    isAppReady: () => true,
    hasMainWindow: () => false,
    addTask: async () => 'x',
    onTaskCreated: () => {},
    onDuplicate: () => () => {},
    resolveDuplicate: async () => {},
    suggestFilename: () => 'x',
    getResolvedTheme: () => 'light',
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  })
  noMain.start()
  assert.deepStrictEqual(noMain.handleSniffSelected(sniff()), { taken: false })
  void f
})

// ── U-31 segment / unknown 不受理 + 日志红线 ─────────────────────────────────

test('U-31 ★ segment / unknown → taken:false,且日志只含 host 与原因码', async () => {
  const f = await started()

  assert.deepStrictEqual(f.service.handleSniffSelected(sniff({ url: M4S, contentType: '' })), {
    taken: false
  })
  assert.deepStrictEqual(
    f.service.handleSniffSelected(sniff({ url: 'https://cdn.example.com/x', contentType: 'video/mp2t' })),
    { taken: false }
  )
  assert.deepStrictEqual(
    f.service.handleSniffSelected(
      sniff({ url: 'https://example.com/page', contentType: 'text/html' })
    ),
    { taken: false }
  )
  // 非法 URL → invalid_url(host 都解析不出,连 host 都不记)
  assert.deepStrictEqual(f.service.handleSniffSelected(sniff({ url: 'not a url' })), {
    taken: false
  })

  f.advance(1000)
  f.flushTimers()
  assert.equal(f.windows.length, 0, '★ 一个确认窗口都不该建')
  assert.equal(f.addTaskCalls.length, 0, '★ 一条任务都不该建')

  // ★ 日志红线:只有 host + 原因码,**没有完整 URL / query token / referrer / UA**
  const joined = f.logs.join('\n')
  assert.equal(joined.includes(M4S), false, '★ 完整 URL 不许进日志')
  assert.equal(joined.includes('token=abc'), false, '★ query 串不许进日志')
  assert.equal(joined.includes(REFERRER), false, '★ referrer 完整值不许进日志')
  assert.equal(joined.includes(UA), false, '★ UA 全串不许进日志')
  // 反向对照:host 与原因码**应该**记(否则以上断言恒绿)
  assert.ok(joined.includes('cdn.example.com'))
  assert.ok(joined.includes('不接管(sniff_segment)'))
  assert.ok(joined.includes('不接管(sniff_unknown)'))
  assert.ok(joined.includes('不接管(invalid_url)'))
})

// ── U-32 PendingIntent.kind ─────────────────────────────────────────────────

test('U-32 ★ PendingIntent.kind:接管路径恒 http;嗅探路径按 classifySniffed', async () => {
  // ① 接管路径 —— **显式字面量**,与载荷内容无关(哪怕 URL 长得像视频流)
  const t = await started()
  t.service.handleIntent(intent({ url: M3U8 }))
  const takeoverBatch = t.present()
  assert.equal(takeoverBatch.items[0].kind, 'http', '★ 接管恒 http,即使 URL 是 m3u8')

  // ② 嗅探路径 —— 流媒体清单 → video
  const v = await started()
  v.service.handleSniffSelected(sniff())
  assert.equal(v.present().items[0].kind, 'video')

  // ③ 嗅探路径 —— 媒体文件 → http
  const m = await started()
  m.service.handleSniffSelected(sniff({ url: MP4, contentType: 'application/octet-stream' }))
  assert.equal(m.present().items[0].kind, 'http')
})

test('U-32 附:`kind` 传到 addTask,且**不多带别的字段**(addTask 本体一字不改)', async () => {
  const f = await started()
  f.service.handleSniffSelected(sniff())
  const batch = f.present()
  f.service.onSubmit({ items: [{ id: batch.items[0].id, filename: '' }], dir: 'D:\\dl' })
  await new Promise((r) => setImmediate(r))

  assert.equal(f.addTaskCalls.length, 1)
  assert.deepStrictEqual(f.addTaskCalls[0], {
    kind: 'video',
    source: M3U8,
    filename: undefined,
    dir: 'D:\\dl',
    headers: { Referer: REFERRER, 'User-Agent': UA }
  })
  assert.deepStrictEqual(Object.keys(f.addTaskCalls[0]).sort(), [
    'dir',
    'filename',
    'headers',
    'kind',
    'source'
  ])
})

test('★ PendingIntent 的类型层守卫:kind 只有 http / video 两种(没有第三种 kind)', () => {
  // torrent 不在其中 —— 嗅探不是 BT 入口,接管也只建直链任务。
  // 这条是**编译期**断言:多一个取值会让下面这行类型不兼容。
  const kinds: PendingIntent['kind'][] = ['http', 'video']
  assert.deepStrictEqual(kinds, ['http', 'video'])
})

// ── v0.4 Task 6:handleVideoIntent + needCookieFor + cookieHosts ─────────────

const PAGE = 'https://www.example.com/video/BV1x'

test('U-C1 ★ handleVideoIntent 与 handleSniffSelected 共用编排、只差两处:kind 恒 video 且不过四层分流', async () => {
  // 同一份配置下,接管路径被四道拒、甲路径受理 —— 与 U-30 同一形式的对照:
  // 只断言甲路径恒 taken 是不够的(有人把 decideTakeover 删掉,那样也绿)。
  const f = await started({ enabled: false })

  const video = f.service.handleVideoIntent({ pageUrl: PAGE, userAgent: UA })
  const taken = f.service.handleIntent(intent())
  assert.equal(video.taken, true, '甲路径:用户主动点的,跳过接管四道')
  assert.equal(taken.taken, false, '接管路径:同一配置下被 enabled=false 拒')

  // ★ kind 恒 'video' —— 页面 URL 既不像 m3u8 也不像 mp4,`classifySniffed` 会判 unknown 并拒;
  //   走到这里说明它**根本没被调用**(这正是与丙路径的第二处差异)。
  const batch = f.present()
  assert.equal(batch.items.length, 1)
  assert.equal(batch.items[0].kind, 'video')
  assert.equal(batch.items[0].host, 'www.example.com')
})

test('U-C1: handleVideoIntent 的 pageUrl 非法 / 非 http(s) → 不受理,handler 不建窗', async () => {
  const f = await started()
  for (const pageUrl of ['', 'not a url', 'chrome://settings', 'file:///C:/x.mp4']) {
    assert.deepStrictEqual(
      f.service.handleVideoIntent({ pageUrl }),
      { taken: false },
      `应拒:${pageUrl}`
    )
  }
  assert.equal(f.windows.length, 0, '未受理就不该建窗')
})

test('N3/I-C6 ★ needCookieFor 的三条判据:第四档才写、上界、handleIntent 恒不写', async () => {
  // ① 第四档 + 受理 → 写该键,甲路径上界 1(只有 pageUrl 一个 URL)
  const ext = await started({}, { cookieSource: 'extension' })
  const video = ext.service.handleVideoIntent({ pageUrl: PAGE })
  assert.deepStrictEqual(video, { taken: true, needCookieFor: ['www.example.com'] })

  // ② 丙路径上界 2(媒体 URL host + Referer host,去重保序)
  const sniffed = ext.service.handleSniffSelected(sniff())
  assert.deepStrictEqual(sniffed, {
    taken: true,
    needCookieFor: ['cdn.example.com', 'page.example.com']
  })

  // ③ 🔴 接管直链恒**不写该键** ——「直链带 cookie 本版不做」是协议形状的后果:
  //    `handleIntent` 根本不调 `takenAck`,不是靠某个 `if` 判掉的。
  const direct = ext.service.handleIntent(intent())
  assert.deepStrictEqual(direct, { taken: true })
  assert.equal('needCookieFor' in direct, false, '★ download.intent 的应答永不含 needCookieFor')

  // ④ 没选第四档 = 零外泄:**连键都不存在**,不是给个空数组
  const none = await started({}, { cookieSource: 'browser' })
  const off = none.service.handleVideoIntent({ pageUrl: PAGE })
  assert.deepStrictEqual(off, { taken: true })
  assert.equal('needCookieFor' in off, false)
})

test('U-C2 ★ cookieHosts 在 present 时刻实读,且只报持有层真有的那些', async () => {
  // 受理时持有层还是空的(cookie 在受理之后、用户点确认之前才到)——
  // 这里用一个「受理后才填上」的可变数组模拟那段人类时间。
  const held: string[] = []
  const f = await started({}, { cookieSource: 'extension', borrowedHosts: held })

  f.service.handleVideoIntent({ pageUrl: PAGE })
  held.push('www.example.com') // ← ③④ 与 ⑤⑥ 并行:offer 在窗口就绪前到达

  const batch = f.present()
  assert.deepStrictEqual(batch.items[0].cookieHosts, ['www.example.com'])
})

test('U-C2: 点了名但没借到 → 不写该键(少一行是「未报」,谎报才是错)', async () => {
  const f = await started({}, { cookieSource: 'extension', borrowedHosts: ['other.com'] })
  f.service.handleVideoIntent({ pageUrl: PAGE })
  const batch = f.present()
  assert.equal('cookieHosts' in batch.items[0], false)
})

test('U-C2 ★ kind:http 恒无 cookieHosts —— 直链走 aria2 不带登录态,说了就是谎报', async () => {
  const f = await started({}, { cookieSource: 'extension', borrowedHosts: ['cdn.example.com'] })
  // 接管路径(恒 http)+ 嗅探到的 mp4 直链(classifySniffed 判 http)各一条
  f.service.handleIntent(intent({ url: 'https://cdn.example.com/dl/setup.exe' }))
  const batch = f.present()
  assert.equal(batch.items[0].kind, 'http')
  assert.equal('cookieHosts' in batch.items[0], false)
})
