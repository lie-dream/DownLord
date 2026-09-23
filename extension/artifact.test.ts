/**
 * 产物级**运行时**断言(v0.4 Task 3 · spec §7.3 · `docs/TODO.md` **#47**)。
 *
 * 与 `build.test.ts`(静态形态)平级、同一测试根;区别在于本文件**真把 `extension/dist/sw.js` 跑起来** ——
 * 既有单测测的是源码里的纯函数,这里测的是 **esbuild 产出的那个文件在类浏览器环境里的行为**。
 * 守的是一类「门禁抓不到、装上才发现」的问题:
 *   - 有人给 esbuild 加 `format:'esm'` → `sw.js` 带顶层 `import` → MV3 注册失败(**R1**);
 *   - 唤醒计数改回模块级变量 / 忘了 await → 状态没落 storage(**R2**,约定 L1 的自动化等价物);
 *   - popup 里塞了内联 `<script>` → MV3 CSP 拦掉 → popup 白板(**R3**);
 *   - 已配对却没真发出那条握手请求(**R4**,P1 的自动化等价物)。
 *
 * 产物缺失时**显式失败并提示先跑 `npm run build`**(与 `build.test.ts` 同一风格)——
 * **测试不该有副作用**,不在这里偷偷触发构建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const extensionDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(extensionDir, 'dist')

const MISSING_HINT =
  '扩展产物不存在或不完整。先跑 `npm run build`(或 `node scripts/build-extension.mjs`)再跑测试。'

function readDistFile(relativePath: string): string {
  const fullPath = join(distDir, relativePath)
  assert.ok(existsSync(fullPath), `缺少产物 extension/dist/${relativePath} —— ${MISSING_HINT}`)
  return readFileSync(fullPath, 'utf8')
}

// ── R1:sw.js 的可执行形态 ─────────────────────────────────────────────────

/**
 * 先剥块注释、再剥行注释。
 *
 * ⚠️ 行注释只剥**整行都是注释**的那种(行首起、允许缩进):若把「双斜杠到行尾」一律剥掉,
 * 代码里的 `http://127.0.0.1:...` 会被从中间腰斩,断言就在测一份被自己改坏的文本。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

test('R1: dist/sw.js 无顶层 import / export 且为 IIFE 包裹(MV3 classic script 的硬要求)', () => {
  const source = stripComments(readDistFile('sw.js'))

  assert.equal(
    /^\s*(import|export)\b/m.test(source),
    false,
    'sw.js 出现顶层 import / export —— manifest 未声明 "type":"module",MV3 会**注册失败**(多半是 esbuild 的 format 被改成了 esm)'
  )

  const trimmed = source.trim()
  assert.ok(trimmed.startsWith('('), `sw.js 应以 IIFE 开头,实际以 ${trimmed.slice(0, 24)} 开头`)
  assert.match(trimmed, /\)\(\);?\s*$/, 'sw.js 应以 IIFE 调用收尾')
})

// ── R2 / R4:把产物真跑起来 ────────────────────────────────────────────────

interface FetchCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string }
}

interface SwRun {
  /** fake chrome.storage.local 的底账 */
  storage: Map<string, unknown>
  /** fake chrome.storage.session 的底账(v0.4 Task 5 的嗅探桶落在这里) */
  session: Map<string, unknown>
  fetchCalls: FetchCall[]
  consoleErrors: unknown[][]
  /** 六类监听器各注册了几个 —— 顶层同步注册(约定 L2)的可核验形式 */
  listenerCounts: {
    installed: number
    startup: number
    message: number
    downloadCreated: number
    headersReceived: number
    tabRemoved: number
  }
  /** `webRequest.onHeadersReceived.addListener` 收到的第 2、3 个参数(过滤器与 extraInfoSpec) */
  headersListenerArgs: { filter: unknown; extraInfoSpec: unknown } | undefined
  canceled: number[]
  fireInstalled: (reason: string) => void
  fireStartup: () => void
  fireDownloadCreated: (item: Record<string, unknown>) => void
  fireHeadersReceived: (details: Record<string, unknown>) => void
  fireStorageChanged: (changes: Record<string, unknown>, areaName: string) => void
}

/** 让所有已就绪的微任务与本轮宏任务跑完 —— 否则读到的是「写入前」的状态 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 在 `node:vm` 里用 fake `chrome` + fake `fetch` + fake `navigator` 跑一遍 `dist/sw.js`。
 *
 * 产物是 IIFE,`runInContext` 一执行就完成了「模块顶层同步注册监听器」这一步 ——
 * 于是返回后即可数监听器、再手动投事件。
 *
 * ⚠️ `navigator` 必须给:v0.4 Task 4 起 `createDefaultAdapter()` 会读 `navigator.userAgent`
 * (真实 MV3 sw 里 `WorkerNavigator` 有这个属性)。沙箱缺它,产物在顶层就抛 ReferenceError ——
 * 这正是本文件「跑真产物」相较纯单测多抓到的那类问题。
 */
function runServiceWorker(
  seed: [string, unknown][] = [],
  sessionSeed: [string, unknown][] = []
): SwRun {
  const storage = new Map<string, unknown>(seed)
  const session = new Map<string, unknown>(sessionSeed)
  const fetchCalls: FetchCall[] = []
  const consoleErrors: unknown[][] = []
  const canceled: number[] = []

  type InstalledListener = (details: { reason: string }) => void
  type CreatedListener = (item: Record<string, unknown>) => void
  type HeadersListener = (details: Record<string, unknown>) => void
  type ChangedListener = (changes: Record<string, unknown>, areaName: string) => void
  const installed: InstalledListener[] = []
  const startup: (() => void)[] = []
  const message: unknown[] = []
  const downloadCreated: CreatedListener[] = []
  const headersReceived: HeadersListener[] = []
  const tabRemoved: ((tabId: number) => void)[] = []
  const storageChanged: ChangedListener[] = []
  let headersListenerArgs: { filter: unknown; extraInfoSpec: unknown } | undefined

  /** local / session 两个区共用同一套读写语义,只是底账不同 */
  const area = (
    store: Map<string, unknown>
  ): {
    get: (key: string | null) => Promise<Record<string, unknown>>
    set: (items: Record<string, unknown>) => Promise<void>
    remove: (key: string) => Promise<void>
  } => ({
    get: (key: string | null): Promise<Record<string, unknown>> => {
      // `get(null)` 是取全量的原生写法 —— 适配层的 `keys()` 靠它
      if (key === null) return Promise.resolve(Object.fromEntries(store))
      return Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {})
    },
    set: (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) store.set(k, v)
      return Promise.resolve()
    },
    remove: (key: string): Promise<void> => {
      store.delete(key)
      return Promise.resolve()
    }
  })

  const chrome = {
    storage: {
      local: area(storage),
      session: area(session),
      onChanged: {
        addListener: (listener: ChangedListener): void => {
          storageChanged.push(listener)
        }
      }
    },
    runtime: {
      getManifest: (): { version: string } => ({ version: '0.0.0-artifact-test' }),
      id: 'artifacttestidaaaaaaaaaaaaaaaaaa',
      onInstalled: {
        addListener: (listener: InstalledListener): void => {
          installed.push(listener)
        }
      },
      onStartup: {
        addListener: (listener: () => void): void => {
          startup.push(listener)
        }
      },
      onMessage: {
        addListener: (listener: unknown): void => {
          message.push(listener)
        }
      },
      sendMessage: (): Promise<unknown> => Promise.resolve(undefined)
    },
    downloads: {
      onCreated: {
        addListener: (listener: CreatedListener): void => {
          downloadCreated.push(listener)
        }
      },
      cancel: (id: number): Promise<void> => {
        canceled.push(id)
        return Promise.resolve()
      }
    },
    webRequest: {
      onHeadersReceived: {
        addListener: (listener: HeadersListener, filter: unknown, extraInfoSpec: unknown): void => {
          headersReceived.push(listener)
          headersListenerArgs = { filter, extraInfoSpec }
        }
      }
    },
    tabs: {
      query: (): Promise<unknown[]> => Promise.resolve([]),
      reload: (): Promise<void> => Promise.resolve(),
      onRemoved: {
        addListener: (listener: (tabId: number) => void): void => {
          tabRemoved.push(listener)
        }
      }
    }
  }

  const fakeFetch = (url: string, init: FetchCall['init']): Promise<unknown> => {
    fetchCalls.push({ url, init })
    return Promise.resolve({
      status: 200,
      text: (): Promise<string> =>
        Promise.resolve(
          JSON.stringify({ ok: true, protocolVersion: 3, payload: { appVersion: '0.0.0-test' } })
        )
    })
  }

  const context = createContext({
    chrome,
    fetch: fakeFetch,
    // 真实 MV3 sw 里是 WorkerNavigator;这里只需 userAgent 一项
    navigator: { userAgent: 'Mozilla/5.0 ArtifactTest/1.0' },
    // ⚠️ `URL` 是**宿主环境提供的全局**,不是 JS 内置 —— `createContext` 造出来的新 realm 里没有它。
    //    v0.4 Task 5 起嗅探判定用 `new URL(...)` 取 pathname,沙箱缺它会让每条资源都被判成
    //    「URL 解析失败 → ignore」并**静默**采不到东西。真实 sw 里 `URL` 一定在。
    //    (与 `navigator` 同一类问题,也同样是「跑真产物」相较纯单测多抓到的那一类。)
    URL,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console: {
      log: (): void => {},
      warn: (): void => {},
      error: (...args: unknown[]): void => {
        consoleErrors.push(args)
      }
    }
  })

  runInContext(readDistFile('sw.js'), context, { filename: 'extension/dist/sw.js' })

  return {
    storage,
    session,
    fetchCalls,
    consoleErrors,
    canceled,
    headersListenerArgs,
    listenerCounts: {
      installed: installed.length,
      startup: startup.length,
      message: message.length,
      downloadCreated: downloadCreated.length,
      headersReceived: headersReceived.length,
      tabRemoved: tabRemoved.length
    },
    fireInstalled: (reason: string): void => {
      for (const listener of installed) listener({ reason })
    },
    fireStartup: (): void => {
      for (const listener of startup) listener()
    },
    fireDownloadCreated: (item: Record<string, unknown>): void => {
      for (const listener of downloadCreated) listener(item)
    },
    fireHeadersReceived: (details: Record<string, unknown>): void => {
      for (const listener of headersReceived) listener(details)
    },
    fireStorageChanged: (changes: Record<string, unknown>, areaName: string): void => {
      for (const listener of storageChanged) listener(changes, areaName)
    }
  }
}

test('R2: fake chrome 跑 dist/sw.js → onInstalled → 计数落到 storage(约定 L1 的自动化等价物)', async () => {
  const run = runServiceWorker()

  // 约定 L2:监听器在模块顶层同步注册 —— 产物一执行完就已经在场,不等任何 await
  assert.equal(run.listenerCounts.installed, 1, 'onInstalled 监听器应在顶层同步注册')
  assert.equal(run.listenerCounts.startup, 1, 'onStartup 监听器应在顶层同步注册')
  assert.equal(run.listenerCounts.message, 1, 'onMessage 监听器应在顶层同步注册(Task 3 新增)')
  assert.equal(
    run.listenerCounts.downloadCreated,
    1,
    'downloads.onCreated 监听器应在顶层同步注册(Task 4 新增的第四条唤醒路径)'
  )
  assert.equal(
    run.listenerCounts.headersReceived,
    1,
    'webRequest.onHeadersReceived 监听器应在顶层同步注册(Task 5 新增的第五条)'
  )
  assert.equal(
    run.listenerCounts.tabRemoved,
    1,
    'tabs.onRemoved 监听器应在顶层同步注册(Task 5 新增的第六条)'
  )

  run.fireInstalled('install')
  await tick()

  // ⚠️ 用 deepEqual 而非 deepStrictEqual:vm 里造的对象来自另一个 realm,原型不同名不同物
  const state = run.storage.get('downlord:wakeState') as { count?: number; lastEvent?: string }
  assert.equal(state?.count, 1, '计数没落到 storage —— 状态多半又回到了模块级变量(违反 L1)')
  assert.equal(state?.lastEvent, 'install')

  // 未配对 → 不试探、不用默认 token 打一枪
  assert.deepEqual(run.fetchCalls, [], '未配对时不该发出任何请求')
  assert.deepEqual(run.consoleErrors, [], 'sw 顶层不该有未处理错误')
})

test('R4: 已配对时 sw 冷启动会真发出一次握手(P1 的自动化等价物)', async () => {
  const token = 'b'.repeat(64)
  const run = runServiceWorker([['downlord:pairing', { token, port: 52341 }]])

  run.fireStartup()
  await tick()

  assert.equal(run.fetchCalls.length, 1, '已配对时冷启动应恰好握手一次')
  assert.equal(run.fetchCalls[0]?.url, 'http://127.0.0.1:52341/channel')
  assert.equal(run.fetchCalls[0]?.init.method, 'POST')
  assert.equal(run.fetchCalls[0]?.init.headers?.['X-DownLord-Token'], token)

  // 结果也要落 storage,否则下次冷启动 popup 什么都看不到
  const last = run.storage.get('downlord:lastHandshake') as { reason?: string }
  assert.equal(last?.reason, 'ok')

  const state = run.storage.get('downlord:wakeState') as { lastEvent?: string }
  assert.equal(state?.lastEvent, 'startup')
})

test('R5: 真产物跑接管路径 —— 未配对不上报;应答不是 taken:true 就绝不取消(黑洞红线)', async () => {
  const item = {
    id: 77,
    url: 'https://dl.example.com/setup.exe?token=secret',
    finalUrl: 'https://mirror.example.com/setup.exe?sig=x',
    filename: '',
    referrer: 'https://page.example.com/',
    danger: 'safe',
    totalBytes: 1024,
    // ★ `state` / `startTime` 必须是「此刻真的在下」的形状 —— 真产物里有一道粗筛专挡
    //   浏览器启动时重放的下载历史(X-07,2026-08-02 真机暴露)。这里用真实 `Date.now()`,
    //   因为跑的是**真 sw**,它内部读的是自己的时钟。
    state: 'in_progress',
    startTime: new Date().toISOString()
  }

  // ① 未配对:不试探、不上报,更不取消
  const unpaired = runServiceWorker()
  unpaired.fireDownloadCreated(item)
  await tick()
  assert.deepEqual(unpaired.fetchCalls, [], '未配对时不该发出任何请求')
  assert.deepEqual(unpaired.canceled, [], '未配对时不该取消任何下载')

  // ② 已配对但对端回的是握手形状的 ack(payload 里没有 taken)——
  //    「看不懂的应答」必须降级到最安全的一侧:上报了,但**不取消**
  const paired = runServiceWorker([['downlord:pairing', { token: 'c'.repeat(64), port: 52342 }]])
  paired.fireDownloadCreated(item)
  await tick()

  assert.equal(paired.fetchCalls.length, 1, '已配对时应上报一次 intent')
  assert.equal(paired.fetchCalls[0]?.url, 'http://127.0.0.1:52342/channel')
  const envelope = JSON.parse(String(paired.fetchCalls[0]?.init.body)) as {
    type?: string
    payload?: Record<string, unknown>
  }
  assert.equal(envelope.type, 'download.intent')
  // 载荷在真产物上同样不含 dir / filename(X-02 的产物级复核)
  assert.deepEqual(Object.keys(envelope.payload ?? {}).sort(), [
    'danger',
    'referrer',
    'totalBytes',
    'url',
    'userAgent'
  ])
  assert.deepEqual(paired.canceled, [], '没拿到 taken:true 就绝不能取消原生下载')
  assert.deepEqual(paired.consoleErrors, [], 'sw 顶层不该有未处理错误')
})

// ── R3:popup.html 的可加载形态 ────────────────────────────────────────────
test('R3: dist/popup.html 剥掉 HTML 注释后无内联 <script>(MV3 CSP 会拦掉,popup 会白板)', () => {
  // ⚠️ 必须**先剥注释再匹配**:文件头注释里就写着字面的 script 标签,不剥会当场误报
  const html = readDistFile('popup.html').replace(/<!--[\s\S]*?-->/g, '')
  const tags = html.match(/<script\b[^>]*>/g) ?? []

  assert.ok(tags.length > 0, 'popup.html 应至少外链一个脚本(否则 popup 是死的)')
  for (const tag of tags) {
    assert.match(tag, /\ssrc=/, `内联脚本会被 MV3 的 CSP 拦掉:${tag}`)
  }
})

test('R6: 真产物挡住浏览器启动时重放的下载历史(X-07 的产物级复核)', async () => {
  const paired = runServiceWorker([['downlord:pairing', { token: 'c'.repeat(64), port: 52342 }]])

  // 重启浏览器时 DownloadManager 会为**每一条历史记录**重放 onCreated —— 这里模拟三条
  for (const replay of [
    { state: 'complete', startTime: new Date().toISOString() },
    { state: 'interrupted', startTime: new Date().toISOString() },
    { state: 'in_progress', startTime: new Date(Date.now() - 6 * 3600_000).toISOString() }
  ]) {
    paired.fireDownloadCreated({
      id: 78,
      url: 'https://dl.example.com/old.zip',
      finalUrl: 'https://dl.example.com/old.zip',
      filename: '',
      referrer: '',
      danger: 'safe',
      totalBytes: 1024,
      ...replay
    })
  }
  await tick()

  assert.deepEqual(paired.fetchCalls, [], '历史重放一条都不该上报(否则重启浏览器就是弹窗风暴)')
  assert.deepEqual(paired.canceled, [], '历史重放一条都不该取消')
})

// ── R7:真产物跑嗅探路径(v0.4 Task 5)────────────────────────────────────

const HLS_HEADERS = { 'Content-Type': 'application/x-mpegURL; charset=utf-8' }

function headersEvent(url: string, tabId: number, headers = HLS_HEADERS): Record<string, unknown> {
  return {
    tabId,
    url,
    statusCode: 200,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value }))
  }
}

test('R7: 嗅探监听器是**观察型** —— extraInfoSpec 恰好 ["responseHeaders"],不含 blocking / extraHeaders', () => {
  const run = runServiceWorker()

  // ⚠️ 这两个值是**在 vm 里造出来**的对象 / 数组,原型来自另一个 realm ——
  //    `node:assert/strict` 下 `deepEqual` 就是 `deepStrictEqual`,直接比会因「结构相同但原型不同」而红。
  //    展开成本 realm 的原始值再比:要断言的本来就只是里面那几个字符串。
  const filter = run.headersListenerArgs?.filter as { urls?: string[] } | undefined
  const extraInfoSpec = run.headersListenerArgs?.extraInfoSpec as string[] | undefined

  assert.deepEqual([...(filter?.urls ?? [])], ['<all_urls>'])
  assert.deepEqual(
    [...(extraInfoSpec ?? [])],
    ['responseHeaders'],
    'blocking / extraHeaders 一旦出现,监听器就从「观察」变成了「有权改动请求」'
  )
})

test('R7: 开关关(默认)→ 一条都不采;开关开 → 采得到,且 tabId=-1 的请求永不入桶', async () => {
  // ① 默认关 —— 顶层监听器照样注册了(约定 L2),但回调第一行就早退
  const off = runServiceWorker()
  await tick()
  off.fireHeadersReceived(headersEvent('https://x.example/index.m3u8', 5))
  await tick()
  assert.equal(off.session.size, 0, '开关关着时一个字节都不该落进 storage.session')

  // ② 开关开(冷启动从 storage.local 读到)
  const on = runServiceWorker([['downlord:sniffEnabled', true]])
  await tick()

  // ④「不看自己」的机器保障:tabId === -1 是扩展自身 / 后台请求(含本地通道那些)
  on.fireHeadersReceived(headersEvent('http://127.0.0.1:52330/channel', -1))
  on.fireHeadersReceived(headersEvent('https://x.example/index.m3u8?token=abc', 5))
  await tick()
  await tick()

  const bucket = on.session.get('sniff:5') as { items?: { url?: string; group?: string }[] }
  assert.equal(on.session.has('sniff:-1'), false, 'tabId=-1 的请求绝不该建桶')
  assert.equal(bucket?.items?.length, 1)
  assert.equal(bucket?.items?.[0]?.url, 'https://x.example/index.m3u8?token=abc')
  assert.equal(bucket?.items?.[0]?.group, 'stream')
  assert.deepEqual(on.fetchCalls, [], '嗅探路径不发任何网络请求 —— 结果从不离开浏览器')
  assert.deepEqual(on.consoleErrors, [], 'sw 顶层不该有未处理错误')
})

test('R7: 开关经 storage.onChanged 生效 —— 不必重启 sw', async () => {
  const run = runServiceWorker()
  await tick()

  run.storage.set('downlord:sniffEnabled', true)
  run.fireStorageChanged({ 'downlord:sniffEnabled': { newValue: true } }, 'local')
  await tick()

  run.fireHeadersReceived(headersEvent('https://x.example/a.m3u8', 9))
  await tick()
  await tick()

  assert.equal(run.session.has('sniff:9'), true, '订阅没生效 → 用户开了开关还得重启浏览器')
})
