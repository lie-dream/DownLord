/**
 * 接管编排单测(v0.4 Task 4 · spec §7.1 X-05)—— **黑洞红线的机器守卫**。
 *
 * 注入 fake adapter:不起服务、不碰真 `chrome`。断言的核心只有一句 ——
 * **没拿到 `taken:true` 就一次都不许调 `cancel`**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type {
  BrowserAdapter,
  CreatedDownload,
  PostJsonInput,
  PostJsonResult
} from '../adapter/browserAdapter'
import { PAIRING_KEY } from '../channel/handshakeClient'
import { handleDownloadCreated } from './takeoverClient'

/** 固定「此刻」与对应的 ISO 串 —— 不读真实时钟,新鲜度判据全靠注入 */
const NOW_MS = Date.parse('2026-08-02T15:04:05.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

interface FakeAdapter {
  adapter: BrowserAdapter
  calls: {
    posts: PostJsonInput[]
    cancels: number[]
    erases: number[]
    writes: string[]
  }
}

function okText(taken: boolean): string {
  return JSON.stringify({ ok: true, protocolVersion: 3, payload: { taken } })
}

function makeAdapter(options: {
  paired?: boolean
  respond?: () => Promise<PostJsonResult>
}): FakeAdapter {
  const calls = {
    posts: [] as PostJsonInput[],
    cancels: [] as number[],
    erases: [] as number[],
    writes: [] as string[]
  }
  const store = new Map<string, unknown>()
  if (options.paired !== false) store.set(PAIRING_KEY, { token: 'a'.repeat(64), port: 52330 })

  const adapter: BrowserAdapter = {
    storage: {
      get<T>(key: string): Promise<T | undefined> {
        return Promise.resolve(store.get(key) as T | undefined)
      },
      set(key: string): Promise<void> {
        calls.writes.push(key)
        return Promise.resolve()
      },
      remove(key: string): Promise<void> {
        calls.writes.push(key)
        return Promise.resolve()
      },
      onChanged: (): void => {}
    },
    runtime: {
      getVersion: (): string => '0.4.0',
      getId: (): string => 'ext-id',
      onInstalled: (): void => {},
      onStartup: (): void => {},
      onMessage: (): void => {},
      sendMessage: (): Promise<unknown> => Promise.resolve(undefined),
      getUserAgent: (): string => 'UA/1.0'
    },
    net: {
      postJson(input: PostJsonInput): Promise<PostJsonResult> {
        calls.posts.push(input)
        return (
          options.respond ??
          ((): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(false) }))
        )()
      }
    },
    downloads: {
      onCreated: (): void => {},
      cancel(id: number): Promise<void> {
        calls.cancels.push(id)
        return Promise.resolve()
      },
      eraseCanceled(id: number): Promise<void> {
        calls.erases.push(id)
        return Promise.resolve()
      }
    },
    // v0.4 Task 5 的三块 —— 与下载接管无关,调到即视为出错
    session: {
      get: (): Promise<undefined> => Promise.reject(new Error('本文件不该读嗅探桶')),
      set: (): Promise<void> => Promise.reject(new Error('本文件不该写嗅探桶')),
      remove: (): Promise<void> => Promise.reject(new Error('本文件不该删嗅探桶')),
      keys: (): Promise<string[]> => Promise.reject(new Error('本文件不该枚举会话存储'))
    },
    webRequest: { onHeadersReceived: (): void => {} },
    tabs: {
      queryActiveId: (): Promise<number | undefined> =>
        Promise.reject(new Error('本文件不该读标签页')),
      queryActiveUrl: (): Promise<string | undefined> =>
        Promise.reject(new Error('本文件不该读标签页地址')),
      reloadBypassingCache: (): Promise<void> => Promise.reject(new Error('本文件不该刷新标签页')),
      onRemoved: (): void => {}
    },
    cookies: {
      getAll: (): Promise<never> => Promise.reject(new Error('本文件不该读 cookie'))
    }
  }

  return { adapter, calls }
}

function item(overrides: Partial<CreatedDownload> = {}): CreatedDownload {
  return {
    id: 42,
    url: 'https://dl.example.com/setup.exe',
    referrer: '',
    danger: 'safe',
    totalBytes: 1024,
    state: 'in_progress',
    startTime: NOW_ISO,
    ...overrides
  }
}

test('X-05: taken:true → 恰好 cancel 一次,参数就是 item.id', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(true) })
  })

  await handleDownloadCreated(fake.adapter, item({ id: 99 }), NOW_MS)

  assert.deepStrictEqual(fake.calls.cancels, [99])
})

test('#52: taken:true → cancel 之后还要抹掉那条残留的「已取消」记录', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(true) })
  })

  await handleDownloadCreated(fake.adapter, item({ id: 99 }), NOW_MS)

  // Step 0 实测⑤ 的「下载项自然消失」在真机被推翻:cancel 成功的记录**一律残留**
  // (Edge 151,5 组延迟组合 5/5 全中 `interrupted` / `USER_CANCELED`)。
  // 删掉 takeoverClient 里那行 `eraseCanceled` → 这一条变红。
  assert.deepStrictEqual(fake.calls.erases, [99])
})

test('#52: ★ 没接管就一次 erase 都不许有 —— erase 是接管成功的收尾,不是清扫工具', async () => {
  for (const [label, respond] of [
    [
      'taken:false',
      (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(false) })
    ],
    ['通道不通', (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))]
  ] as [string, () => Promise<PostJsonResult>][]) {
    const fake = makeAdapter({ respond })
    await handleDownloadCreated(fake.adapter, item(), NOW_MS)

    // 浏览器还在下这个文件,抹它的记录等于让一个**正在进行**的下载从用户眼前消失。
    assert.deepStrictEqual(fake.calls.erases, [], `不该 erase:${label}`)
  }
})

test('X-05: ★ 通道不通(postJson 抛错)→ cancel 零次调用(黑洞红线)', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))
  })

  await handleDownloadCreated(fake.adapter, item(), NOW_MS)

  // 把 takeoverClient 的 catch 分支 `taken = false` 改成 `true` → 这一条当场变红(RP-4)。
  // 「DownLord 未运行 / 通道不通」时**取消了浏览器下载却没人接住** = 黑洞,这是本 Task 的头号红线。
  assert.deepStrictEqual(fake.calls.cancels, [], '没拿到 taken:true 就绝不能取消')
})

test('X-05: 六种「不接管」在这里是同一条路径 —— 逐一断言 cancel 零次', async () => {
  const responses: [string, () => Promise<PostJsonResult>][] = [
    // 暂停中 / 规则不接管 / DownLord 决定不接管 —— 应答形状完全一样,扩展根本分不出来
    [
      'taken:false',
      (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(false) })
    ],
    // DownLord 未运行 / 通道不通
    ['连接被拒', (): Promise<PostJsonResult> => Promise.reject(new Error('ECONNREFUSED'))],
    ['超时中止', (): Promise<PostJsonResult> => Promise.reject(new Error('TimeoutError'))],
    // token 失效
    ['401', (): Promise<PostJsonResult> => Promise.resolve({ status: 401, text: '{"ok":false}' })],
    // 协议版本不一致
    [
      '409',
      (): Promise<PostJsonResult> =>
        Promise.resolve({ status: 409, text: '{"ok":false,"reason":"protocol_mismatch"}' })
    ],
    // 端口上是别的程序
    ['非协议应答', (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: 'hello' })]
  ]

  for (const [label, respond] of responses) {
    const fake = makeAdapter({ respond })
    await handleDownloadCreated(fake.adapter, item(), NOW_MS)
    assert.deepStrictEqual(fake.calls.cancels, [], `应不取消:${label}`)
  }
})

test('X-05: 未配对 → postJson 零次调用(约定 L5:不试探、不用默认 token 打一枪)', async () => {
  const fake = makeAdapter({ paired: false })

  await handleDownloadCreated(fake.adapter, item(), NOW_MS)

  assert.deepStrictEqual(fake.calls.posts, [])
  assert.deepStrictEqual(fake.calls.cancels, [])
})

test('X-05: 粗筛掉的 scheme → 既不上报也不取消(零介入)', async () => {
  const fake = makeAdapter({})

  await handleDownloadCreated(fake.adapter, item({ url: 'blob:https://x.com/9f4b' }), NOW_MS)

  assert.deepStrictEqual(fake.calls.posts, [])
  assert.deepStrictEqual(fake.calls.cancels, [])
})

test('X-05: 接管路径不写任何 storage(约定 L1:无状态的一次性请求)', async () => {
  const fake = makeAdapter({
    respond: (): Promise<PostJsonResult> => Promise.resolve({ status: 200, text: okText(true) })
  })

  await handleDownloadCreated(fake.adapter, item(), NOW_MS)

  assert.deepStrictEqual(fake.calls.writes, [])
})

test('X-07: 浏览器启动重放的历史下载 → postJson 零次、cancel 零次(2026-08-02 真机暴露)', async () => {
  const replays: [string, Partial<CreatedDownload>][] = [
    ['已完成的历史记录', { state: 'complete' }],
    ['中断的历史记录', { state: 'interrupted' }],
    [
      '被恢复但 startTime 是六小时前',
      {
        state: 'in_progress',
        startTime: new Date(NOW_MS - 6 * 60 * 60 * 1000).toISOString()
      }
    ]
  ]

  for (const [label, overrides] of replays) {
    const fake = makeAdapter({})
    await handleDownloadCreated(fake.adapter, item(overrides), NOW_MS)
    // 一条都不许上报:重启浏览器时这会是几十条,每条都会变成一个确认框
    assert.deepStrictEqual(fake.calls.posts, [], `不该上报:${label}`)
    assert.deepStrictEqual(fake.calls.cancels, [], `不该取消:${label}`)
  }
})
