/**
 * chromeAdapter 单测(v0.4 Task 2 · spec §8.1)。
 *
 * Node 环境没有 `chrome` 全局 —— 注入式适配层正是为此:测的是 `createChromeAdapter(api)`,
 * 注入一份最小 fake,不碰 `createDefaultAdapter()`(那个才读全局)。
 *
 * fake 走 `as unknown as ChromeApiSubset`:`LocalStorageArea` 的 `get/set/remove`
 * 是多重载 + 泛型签名,对象字面量满足不了「每一条重载都可赋值」,而本测试只需要真正被调用的那一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserNet, PostJsonInput, PostJsonResult } from './browserAdapter'
import { createChromeAdapter, type ChromeApiSubset } from './chromeAdapter'

/** 本文件测的是 chrome 侧,`net` 只是个占位 —— 它自己的行为由 `fetchNet.test.ts` 断言 */
const stubNet: BrowserNet = {
  postJson(_input: PostJsonInput): Promise<PostJsonResult> {
    return Promise.reject(new Error('stub net:本文件不该发请求'))
  }
}

/** 注入的 UA —— 真实值读自浏览器全局,那一行只在 `createDefaultAdapter()` 里 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FakeBrowser/1.0'

/** 下载事件真实投递的 `DownloadItem`(比 `CreatedDownload` 宽得多) */
interface FakeDownloadItem {
  id: number
  url: string
  finalUrl: string
  filename: string
  referrer: string
  danger: string
  totalBytes: number
  state: string
  startTime: string
  byExtensionId?: string
}

/** 一次 `onHeadersReceived` 真实投递的 details(比 `SniffedResponse` 宽得多) */
interface FakeHeadersDetails {
  tabId: number
  url: string
  statusCode: number
  /** 真实事件里可能**没有**这个字段(未传 `'responseHeaders'` 时) */
  responseHeaders?: { name: string; value?: string }[]
  /** 刻意留着 —— 断言适配层**不**把它带出去 */
  initiator?: string
}

/** 真实 `cookies.getAll` 返回的 Cookie(比 `BrowserCookie` 宽:多 hostOnly / session / sameSite / storeId) */
interface FakeCookie {
  name: string
  value: string
  domain: string
  path: string
  expirationDate?: number
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean
  session: boolean
  sameSite: string
  storeId: string
}

interface FakeApi {
  api: ChromeApiSubset
  store: Map<string, unknown>
  calls: {
    getKeys: string[]
    setItems: Record<string, unknown>[]
    removeKeys: string[]
    sent: unknown[]
    canceled: number[]
    /** `downloads.erase` 收到的 query 原样 —— 断言 `state` 条件在不在(#52 红线) */
    erased: unknown[]
    /** v0.4 Task 5:`storage.session.get` 收到的 key(`null` = 取全量) */
    sessionGetKeys: (string | null)[]
    /** v0.4 Task 5:`onHeadersReceived.addListener` 的第 2、3 个参数 */
    headersArgs: { filter: unknown; extraInfoSpec: unknown }[]
    tabQueries: unknown[]
    reloaded: { tabId: number; properties: unknown }[]
    cookieQueries: unknown[]
  }
  fireInstalled: (reason: string) => void
  fireStartup: () => void
  /** 模拟浏览器投递一条消息:返回 [监听器返回值, sendResponse 收到的应答] */
  fireMessage: (message: unknown) => { returned: unknown; response: Promise<unknown> }
  fireDownloadCreated: (item: FakeDownloadItem) => void
  fireHeadersReceived: (details: FakeHeadersDetails) => unknown
  fireTabRemoved: (tabId: number) => void
  fireStorageChanged: (changes: Record<string, unknown>, areaName: string) => void
}

function makeFakeApi(
  options: {
    manifestVersion?: string
    id?: string
    tabs?: { id?: number; url?: string }[]
    cookies?: FakeCookie[]
  } = {}
): FakeApi {
  const store = new Map<string, unknown>()
  const sessionStore = new Map<string, unknown>()
  const calls = {
    getKeys: [] as string[],
    setItems: [] as Record<string, unknown>[],
    removeKeys: [] as string[],
    sent: [] as unknown[],
    canceled: [] as number[],
    erased: [] as unknown[],
    sessionGetKeys: [] as (string | null)[],
    headersArgs: [] as { filter: unknown; extraInfoSpec: unknown }[],
    tabQueries: [] as unknown[],
    reloaded: [] as { tabId: number; properties: unknown }[],
    /** v0.4 Task 6:`cookies.getAll` 收到的入参原样 —— 断言**只传了 url** */
    cookieQueries: [] as unknown[]
  }
  const installedListeners: ((details: { reason: string }) => void)[] = []
  const startupListeners: (() => void)[] = []
  const messageListeners: ((
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void
  ) => unknown)[] = []
  const createdListeners: ((item: FakeDownloadItem) => void)[] = []
  const headersListeners: ((details: FakeHeadersDetails) => unknown)[] = []
  const tabRemovedListeners: ((tabId: number, info: unknown) => void)[] = []
  const changedListeners: ((changes: Record<string, unknown>, areaName: string) => void)[] = []

  const raw = {
    storage: {
      local: {
        get(key: string): Promise<Record<string, unknown>> {
          calls.getKeys.push(key)
          // 真实 storage 的语义:未命中时返回的对象里**根本没有**这个 key
          return Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {})
        },
        set(items: Record<string, unknown>): Promise<void> {
          calls.setItems.push(items)
          for (const [k, v] of Object.entries(items)) store.set(k, v)
          return Promise.resolve()
        },
        remove(key: string): Promise<void> {
          calls.removeKeys.push(key)
          store.delete(key)
          return Promise.resolve()
        }
      },
      session: {
        get(key: string | null): Promise<Record<string, unknown>> {
          calls.sessionGetKeys.push(key)
          // `get(null)` 是取全量的原生写法(适配层的 keys() 靠它)
          if (key === null) return Promise.resolve(Object.fromEntries(sessionStore))
          return Promise.resolve(sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {})
        },
        set(items: Record<string, unknown>): Promise<void> {
          for (const [k, v] of Object.entries(items)) sessionStore.set(k, v)
          return Promise.resolve()
        },
        remove(key: string): Promise<void> {
          sessionStore.delete(key)
          return Promise.resolve()
        }
      },
      onChanged: {
        addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void {
          changedListeners.push(listener)
        }
      }
    },
    runtime: {
      getManifest: (): { version: string } => ({ version: options.manifestVersion ?? '0.3.0' }),
      id: options.id ?? 'joomlppocobhkaeinpcmkkbphnjmjiei',
      onInstalled: {
        addListener(listener: (details: { reason: string }) => void): void {
          installedListeners.push(listener)
        }
      },
      onStartup: {
        addListener(listener: () => void): void {
          startupListeners.push(listener)
        }
      },
      onMessage: {
        addListener(
          listener: (
            message: unknown,
            sender: unknown,
            sendResponse: (response?: unknown) => void
          ) => unknown
        ): void {
          messageListeners.push(listener)
        }
      },
      sendMessage(message: unknown): Promise<unknown> {
        calls.sent.push(message)
        return Promise.resolve({ echo: message })
      }
    },
    downloads: {
      onCreated: {
        addListener(listener: (item: FakeDownloadItem) => void): void {
          createdListeners.push(listener)
        }
      },
      cancel(id: number): Promise<void> {
        calls.canceled.push(id)
        return Promise.resolve()
      },
      erase(query: unknown): Promise<number[]> {
        calls.erased.push(query)
        return Promise.resolve([])
      }
    },
    webRequest: {
      onHeadersReceived: {
        addListener(
          listener: (details: FakeHeadersDetails) => unknown,
          filter: unknown,
          extraInfoSpec: unknown
        ): void {
          headersListeners.push(listener)
          calls.headersArgs.push({ filter, extraInfoSpec })
        }
      }
    },
    tabs: {
      query(queryInfo: unknown): Promise<{ id?: number; url?: string }[]> {
        calls.tabQueries.push(queryInfo)
        return Promise.resolve(options.tabs ?? [])
      },
      reload(tabId: number, properties?: unknown): Promise<void> {
        calls.reloaded.push({ tabId, properties })
        return Promise.resolve()
      },
      onRemoved: {
        addListener(listener: (tabId: number, info: unknown) => void): void {
          tabRemovedListeners.push(listener)
        }
      }
    },
    cookies: {
      getAll(details: unknown): Promise<FakeCookie[]> {
        calls.cookieQueries.push(details)
        return Promise.resolve(options.cookies ?? [])
      }
    }
  }

  return {
    api: raw as unknown as ChromeApiSubset,
    store,
    calls,
    fireInstalled: (reason: string): void => {
      for (const l of installedListeners) l({ reason })
    },
    fireStartup: (): void => {
      for (const l of startupListeners) l()
    },
    fireMessage: (message: unknown): { returned: unknown; response: Promise<unknown> } => {
      let settle: (value: unknown) => void = () => {}
      const response = new Promise<unknown>((resolve) => {
        settle = resolve
      })
      const returned = messageListeners[0]?.(message, { id: 'sender' }, settle)
      return { returned, response }
    },
    fireDownloadCreated: (item: FakeDownloadItem): void => {
      for (const l of createdListeners) l(item)
    },
    fireHeadersReceived: (details: FakeHeadersDetails): unknown => {
      let last: unknown
      for (const l of headersListeners) last = l(details)
      return last
    },
    fireTabRemoved: (tabId: number): void => {
      for (const l of tabRemovedListeners) l(tabId, { windowId: 1, isWindowClosing: false })
    },
    fireStorageChanged: (changes: Record<string, unknown>, areaName: string): void => {
      for (const l of changedListeners) l(changes, areaName)
    }
  }
}

test('storage.get: 未命中返回 undefined(不兜默认值,约定 L5)', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  assert.equal(await adapter.storage.get('never-written'), undefined)
  assert.deepEqual(fake.calls.getKeys, ['never-written'])
})

test('storage: set → get 往返保形;get 只取自己那个 key', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.storage.set('a', { count: 3, lastEvent: 'startup' })
  await adapter.storage.set('b', 'other')

  assert.deepEqual(await adapter.storage.get('a'), { count: 3, lastEvent: 'startup' })
  assert.equal(await adapter.storage.get('b'), 'other')
  // set 传给浏览器的形状是 { [key]: value } 单键对象,不是整包覆写
  assert.deepEqual(fake.calls.setItems, [{ a: { count: 3, lastEvent: 'startup' } }, { b: 'other' }])
})

test('storage.set: 值为 undefined / null / false 时不被误当作「未命中」', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.storage.set('nul', null)
  await adapter.storage.set('fls', false)
  await adapter.storage.set('zero', 0)

  assert.equal(await adapter.storage.get('nul'), null)
  assert.equal(await adapter.storage.get('fls'), false)
  assert.equal(await adapter.storage.get('zero'), 0)
})

test('storage.remove: 删后再读回 undefined', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.storage.set('k', 1)
  await adapter.storage.remove('k')

  assert.equal(await adapter.storage.get('k'), undefined)
  assert.deepEqual(fake.calls.removeKeys, ['k'])
})

test('runtime: getVersion 取 manifest.version;getId 取 runtime.id', () => {
  const fake = makeFakeApi({ manifestVersion: '1.2.3', id: 'abcdef' })
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  assert.equal(adapter.runtime.getVersion(), '1.2.3')
  assert.equal(adapter.runtime.getId(), 'abcdef')
})

test('runtime.onInstalled: reason 归一为三值(chrome 特有取值折叠成 other)', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: string[] = []
  adapter.runtime.onInstalled((reason) => seen.push(reason))

  fake.fireInstalled('install')
  fake.fireInstalled('update')
  fake.fireInstalled('chrome_update')
  fake.fireInstalled('shared_module_update')
  fake.fireInstalled('something_new_from_a_future_browser')

  assert.deepEqual(seen, ['install', 'update', 'other', 'other', 'other'])
})

test('runtime.onStartup: 事件透传', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  let fired = 0
  adapter.runtime.onStartup(() => {
    fired += 1
  })

  fake.fireStartup()
  fake.fireStartup()

  assert.equal(fired, 2)
})

test('runtime.onMessage: 同步返回 true(保持通道开放),异步结果经 sendResponse 回去(L4)', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  adapter.runtime.onMessage(async (message: unknown): Promise<unknown> => {
    await Promise.resolve()
    return { got: message }
  })

  const fired = fake.fireMessage({ kind: 'downlord:sync' })

  // ★ 这个 true 就是 L4 在消息路径上的兑现:少了它,浏览器会在我们 sendResponse 之前关掉通道
  assert.equal(fired.returned, true, 'Chrome 的 onMessage 必须同步 return true')
  assert.deepEqual(await fired.response, { got: { kind: 'downlord:sync' } })
})

test('runtime.onMessage: listener 抛错时仍然应答 —— 不让 popup 干等', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  adapter.runtime.onMessage((): Promise<unknown> => Promise.reject(new Error('boom')))

  const fired = fake.fireMessage({ kind: 'downlord:sync' })

  assert.equal(fired.returned, true)
  const response = (await fired.response) as { error?: string }
  assert.match(String(response.error), /boom/)
})

test('runtime.sendMessage: 透传消息并把应答交回', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  const reply = await adapter.runtime.sendMessage({ kind: 'downlord:sync' })

  assert.deepEqual(fake.calls.sent, [{ kind: 'downlord:sync' }])
  assert.deepEqual(reply, { echo: { kind: 'downlord:sync' } })
})

// ── v0.4 Task 4:第四块适配 ────────────────────────────────────────────────

test('runtime.getUserAgent: 回注入值(真实值读自浏览器全局,只在 createDefaultAdapter 里)', () => {
  const adapter = createChromeAdapter(makeFakeApi().api, stubNet, UA)

  assert.equal(adapter.runtime.getUserAgent(), UA)
})

test('downloads.onCreated: ★ DownloadItem 当场收窄成八字段 —— filename / finalUrl 拿不到', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: Record<string, unknown>[] = []
  adapter.downloads.onCreated((item) => seen.push(item as unknown as Record<string, unknown>))

  fake.fireDownloadCreated({
    id: 12,
    url: 'https://dl.example.com/setup.exe?token=secret',
    finalUrl: 'https://mirror-3.example.com/setup.exe?sig=EXPIRES',
    filename: '', // 实测③:onCreated 时刻是空串
    referrer: 'https://page.example.com/',
    danger: 'safe',
    totalBytes: 191_234_567,
    state: 'in_progress',
    startTime: '2026-08-02T15:04:05.000Z'
  })

  assert.equal(seen.length, 1)
  // ★ `state` / `startTime` 自 2026-08-02 起**必须**在收窄形状里:浏览器启动会为下载历史
  //   逐条重放 onCreated,这两个字段是把它们挡在上报之前的唯一依据(X-07)。
  //   `filename` / `finalUrl` 仍然拿不到 —— 收窄依旧是真的,只是窗口开大了两格。
  assert.deepStrictEqual(seen[0], {
    id: 12,
    url: 'https://dl.example.com/setup.exe?token=secret',
    referrer: 'https://page.example.com/',
    danger: 'safe',
    totalBytes: 191_234_567,
    state: 'in_progress',
    startTime: '2026-08-02T15:04:05.000Z',
    byExtensionId: undefined
  })
})

test('downloads.onCreated: byExtensionId 原样透出(只记事实,不据此决策)', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: { byExtensionId?: string }[] = []
  adapter.downloads.onCreated((item) => seen.push(item))

  fake.fireDownloadCreated({
    id: 1,
    url: 'https://x.com/a.zip',
    finalUrl: 'https://x.com/a.zip',
    filename: '',
    referrer: '',
    danger: 'safe',
    totalBytes: -1,
    state: 'in_progress',
    startTime: '2026-08-02T15:04:05.000Z',
    byExtensionId: 'other-extension-id'
  })

  assert.equal(seen[0]?.byExtensionId, 'other-extension-id')
})

test('downloads.cancel: 透传 id', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.downloads.cancel(99)
  await adapter.downloads.cancel(100)

  assert.deepEqual(fake.calls.canceled, [99, 100])
})

test('downloads.eraseCanceled: ★ query 必须带 state:interrupted —— 已完成项的记录一个都不许抹(#52 红线)', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.downloads.eraseCanceled(77)

  // 去掉 `state` 这一项,或换成别的取值,这一条当场变红。
  //
  // 为什么是红线而不是优化(2026-08-04 Edge 151 四轮取证):
  //   ① `erase` **只删记录、不删文件** —— erase 一条 complete 记录后 search 返回 0 行,
  //      而文件仍在盘上(取证 C / H2 各证一次);
  //   ② `cancel` 打在**已下完**的项目上是**静默无效**的(lastError=null、state 仍 complete、
  //      文件已落在浏览器下载目录,取证 A)。
  //   两条叠起来:漏掉 state 条件 → 唯一能让用户知道「浏览器那边也有一份」的线索被悄悄抹掉,
  //   而那份文件还删不掉。带上它,同一次调用打在 complete 记录上只会返回 `ids: []`(取证 I1)。
  assert.deepStrictEqual(fake.calls.erased, [{ id: 77, state: 'interrupted' }])
})

// ── v0.4 Task 5:session 存储 / 变更订阅 / webRequest / tabs ────────────────

test('session: set → get 往返保形;与 local 是两个互不相干的区', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.session.set('sniff:7', { items: [1, 2] })
  await adapter.storage.set('sniff:7', { items: ['local'] })

  assert.deepEqual(await adapter.session.get('sniff:7'), { items: [1, 2] })
  assert.deepEqual(await adapter.storage.get('sniff:7'), { items: ['local'] })
  assert.equal(await adapter.session.get('never-written'), undefined)
})

test('session.keys: 用 get(null) 取全量键名(清空全部 sniff:* 靠它)', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.session.set('sniff:1', 1)
  await adapter.session.set('sniff:2', 2)
  await adapter.session.set('other', 3)

  assert.deepEqual((await adapter.session.keys()).sort(), ['other', 'sniff:1', 'sniff:2'])
  assert.ok(fake.calls.sessionGetKeys.includes(null), 'keys() 应当走 get(null) 取全量')
})

test('session.remove: 删后再读回 undefined', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.session.set('sniff:1', 1)
  await adapter.session.remove('sniff:1')

  assert.equal(await adapter.session.get('sniff:1'), undefined)
})

test('storage.onChanged: 只报 key 名、只认 local 区', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: string[][] = []
  adapter.storage.onChanged((keys) => seen.push(keys))

  fake.fireStorageChanged({ 'downlord:sniffEnabled': { newValue: true } }, 'local')
  fake.fireStorageChanged({ 'sniff:7': { newValue: {} } }, 'session')
  fake.fireStorageChanged({ x: { newValue: 1 } }, 'sync')

  // 只报 key 名:新旧值一个都不往业务代码里递(少一个能顺手读到别的键内容的通路)
  assert.deepEqual(seen, [['downlord:sniffEnabled']])
})

test('webRequest.onHeadersReceived: 观察型 —— extraInfoSpec 恰好 ["responseHeaders"],回调无返回值', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  adapter.webRequest.onHeadersReceived((): void => {}, { urls: ['<all_urls>'] })

  assert.deepStrictEqual(fake.calls.headersArgs, [
    { filter: { urls: ['<all_urls>'] }, extraInfoSpec: ['responseHeaders'] }
  ])
  // 'blocking' / 'extraHeaders' 一旦出现,监听器就从「观察」变成了「有权改动请求」
  assert.equal(
    fake.fireHeadersReceived({ tabId: 1, url: 'https://x/a.m3u8', statusCode: 200 }),
    undefined,
    '回调必须无返回值,否则浏览器会按 blocking 语义解读它'
  )
})

test('webRequest.onHeadersReceived: details 收窄到四字段 —— 只递 tabId / url / initiator / 响应头', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: unknown[] = []
  adapter.webRequest.onHeadersReceived((details) => seen.push(details), { urls: ['<all_urls>'] })

  fake.fireHeadersReceived({
    tabId: 5,
    url: 'https://x.example/index.m3u8',
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/x-mpegURL' }],
    initiator: 'https://page.example.com'
  })

  // ★ `initiator` 是 Phase 2 收进来的第四个字段(它是 referrer 的唯一来源:popup 里点下载那一刻,
  //   details 早已不存在)。**取值是 origin 级**,「不记 referrer 完整值」由取值形态保证。
  assert.deepEqual(seen, [
    {
      tabId: 5,
      url: 'https://x.example/index.m3u8',
      initiator: 'https://page.example.com',
      responseHeaders: [{ name: 'Content-Type', value: 'application/x-mpegURL' }]
    }
  ])
})

test('webRequest.onHeadersReceived: 浏览器没给 initiator 时兜成空串(不引入第二个「没有」)', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: { initiator: string }[] = []
  adapter.webRequest.onHeadersReceived((d) => seen.push(d), { urls: ['<all_urls>'] })

  fake.fireHeadersReceived({ tabId: 5, url: 'https://x/a.m3u8', statusCode: 200 })

  assert.equal(seen[0]?.initiator, '')
})

test('webRequest.onHeadersReceived: 浏览器没给 responseHeaders 时兜成空数组(不崩)', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: { responseHeaders: readonly unknown[] }[] = []
  adapter.webRequest.onHeadersReceived((d) => seen.push(d), { urls: ['<all_urls>'] })

  fake.fireHeadersReceived({ tabId: 5, url: 'https://x/a.m3u8', statusCode: 304 })

  assert.deepEqual(seen[0]?.responseHeaders, [])
})

test('tabs.queryActiveId: 只取当前窗口活动页的 id,取不到给 undefined', async () => {
  const withTab = makeFakeApi({ tabs: [{ id: 12 }] })
  assert.equal(await createChromeAdapter(withTab.api, stubNet, UA).tabs.queryActiveId(), 12)
  assert.deepEqual(withTab.calls.tabQueries, [{ active: true, currentWindow: true }])

  const noTab = makeFakeApi({ tabs: [] })
  assert.equal(await createChromeAdapter(noTab.api, stubNet, UA).tabs.queryActiveId(), undefined)
})

test('tabs.onRemoved: 只把 tabId 交出去(removeInfo 不外泄)', () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)
  const seen: unknown[] = []
  adapter.tabs.onRemoved((tabId) => seen.push(tabId))

  fake.fireTabRemoved(31)

  assert.deepEqual(seen, [31])
})

test('tabs.reloadBypassingCache: ★ 必须带 bypassCache —— 普通刷新走缓存就嗅不到(R2 红线)', async () => {
  const fake = makeFakeApi()
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.tabs.reloadBypassingCache(9)

  // 去掉 `bypassCache`,这一条当场变红。
  // 为什么是红线而不是优化(2026-08-09 实测 R2):关掉标签页再打开同一 URL,采到的资源
  // 从 4 条掉到 2 条 —— **缓存命中不触发 onHeadersReceived**,没有响应头就没有嗅探。
  // 普通刷新刷完照样走缓存,「强制刷新本页」那个按钮会变成一个看着有用的摆设。
  assert.deepStrictEqual(fake.calls.reloaded, [{ tabId: 9, properties: { bypassCache: true } }])
})

// ── v0.4 Task 6:标签页地址 + cookie 读取 ──────────────────────────────────

test('tabs.queryActiveUrl: 读得到就原样交出去(仅 <all_urls>、无 tabs 权限即可见,探针 B4)', async () => {
  const fake = makeFakeApi({ tabs: [{ id: 12, url: 'https://www.example.com/watch' }] })
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  assert.equal(await adapter.tabs.queryActiveUrl(), 'https://www.example.com/watch')
  assert.deepEqual(fake.calls.tabQueries, [{ active: true, currentWindow: true }])
})

test('tabs.queryActiveUrl: ★ 受限页被抹成空串 / 没给 / 没有 tab → 一律 undefined(单一「没有」的取值)', async () => {
  // `edge://…` / 新建标签页 / 扩展商店不在 `<all_urls>` 匹配范围内,`url` 恒被抹掉(探针 B4 实测)。
  // 若这里把空串原样交出去,装配点就会拿一个空地址去发 `video.intent` —— 装作拿到了。
  const blanked = makeFakeApi({ tabs: [{ id: 3, url: '' }] })
  assert.equal(await createChromeAdapter(blanked.api, stubNet, UA).tabs.queryActiveUrl(), undefined)

  const missing = makeFakeApi({ tabs: [{ id: 3 }] })
  assert.equal(await createChromeAdapter(missing.api, stubNet, UA).tabs.queryActiveUrl(), undefined)

  const noTab = makeFakeApi({ tabs: [] })
  assert.equal(await createChromeAdapter(noTab.api, stubNet, UA).tabs.queryActiveUrl(), undefined)
})

test('cookies.getAll: ★ 入参只传 url —— 「不带条件一次拖走整个 cookie 库」在形状上就写不出来', async () => {
  const fake = makeFakeApi({ cookies: [] })
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  await adapter.cookies.getAll({ url: 'https://www.example.com/watch' })

  assert.deepStrictEqual(fake.calls.cookieQueries, [{ url: 'https://www.example.com/watch' }])
})

test('cookies.getAll: ★ 返回值当场收窄成七字段 —— hostOnly / session / sameSite / storeId 拿不到', async () => {
  const fake = makeFakeApi({
    cookies: [
      {
        name: 'SESSDATA',
        value: 'abc',
        // 前导点原样往上递:协议里没有 hostOnly,这个点就是它
        domain: '.example.com',
        path: '/',
        expirationDate: 1_800_000_000.5,
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: false,
        sameSite: 'lax',
        storeId: '0'
      }
    ]
  })
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  const [one] = await adapter.cookies.getAll({ url: 'https://www.example.com/watch' })

  assert.deepStrictEqual(one, {
    name: 'SESSDATA',
    value: 'abc',
    domain: '.example.com',
    path: '/',
    expirationDate: 1_800_000_000.5,
    secure: true,
    httpOnly: true
  })
})

test('cookies.getAll: session cookie 没有 expirationDate,原样不给(不编一个出来)', async () => {
  const fake = makeFakeApi({
    cookies: [
      {
        name: 's',
        value: 'v',
        domain: 'example.com',
        path: '/',
        secure: false,
        httpOnly: true,
        hostOnly: true,
        session: true,
        sameSite: 'no_restriction',
        storeId: '0'
      }
    ]
  })
  const adapter = createChromeAdapter(fake.api, stubNet, UA)

  const [one] = await adapter.cookies.getAll({ url: 'http://example.com/' })

  assert.equal(one?.expirationDate, undefined)
})
