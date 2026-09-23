/**
 * 零覆盖清单 C 类(preload 三件):`index.ts` / `mainApi.ts` / `takeoverApi.ts` 的替身测
 * —— v1.0 Task 1 Phase 2 后半。
 *
 * 与 `src/main/ipc/registration.test.ts` 同一手法(劫持 `'electron'` → 替身),只是这次劫的是
 * 渲染侧那三个面:`ipcRenderer` / `contextBridge`。
 *
 * 🔴 **本文件刻意不抄一张「方法 → 通道名」对照表。** 抄表只能证明「我抄对了」;
 * 真正要守的是三条**不用抄表也成立**的性质:
 *   ① **没有哪个方法是空转的** —— 逐个调用 `api` 的全部方法,每次都必须产生一次 ipcRenderer 交互。
 *      漏写 `return ipcRenderer.invoke(...)` 的方法在 typecheck 下照样过(返回 `Promise<void>` 的那些尤其),
 *      而界面上就是一个按下去毫无反应的按钮。
 *   ② **通道名必须来自 `IpcChannel` 常量集** —— 手写字面量拼错一个字符,主进程那侧永远收不到。
 *      判据用 `Object.values(IpcChannel)` 做集合校验,不需要我逐条抄。
 *   ③ **`on*` 订阅返回的函数必须真的退订** —— 不退订就是重复回调 + 泄漏,而它「看起来能用」。
 *
 * 另外钉住 `index.ts` 的**分支即边界**:小窗口标记在场时只 expose `takeoverApi`,不在场时只 expose `api`。
 * 「拿不到另一半」不是靠约定,是靠这里只 expose 一个对象(spec §7.2)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'path'

import { IpcChannel, TAKEOVER_WINDOW_ARG, type DownLordApi } from '../shared/ipc'
import { ipcRenderer, recorder, resetElectronStub } from '../../tests/helpers/electronStub'

const requireCjs = createRequire(import.meta.url)
const STUB_PATH = resolve(__dirname, '../../tests/helpers/electronStub.ts')
const CHANNELS = new Set<string>(Object.values(IpcChannel))

interface ResolverHost {
  _resolveFilename(request: string, ...rest: unknown[]): string
}

async function withElectronStub<T>(fn: () => Promise<T>): Promise<T> {
  const moduleApi = requireCjs('module') as unknown as ResolverHost
  const original = moduleApi._resolveFilename
  moduleApi._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === 'electron') return STUB_PATH
    return original.call(this, request, ...rest)
  }
  try {
    resetElectronStub()
    return await fn()
  } finally {
    moduleApi._resolveFilename = original
  }
}

/** 每个方法都得能被无脑调一次:按 arity 塞占位实参,回调位塞函数 */
function callWithPlaceholders(fn: (...a: unknown[]) => unknown): unknown {
  const args: unknown[] = []
  for (let i = 0; i < fn.length; i++) {
    args.push(() => {})
  }
  return fn(...args)
}

/** 一次调用产生的 ipcRenderer 交互总数 */
function interactions(): number {
  return recorder.invokes.length + recorder.sends.length + recorder.rendererListeners.length
}

// ==================== mainApi ====================

test('PRELOAD-1 mainApi:每个方法都真的转发到 ipcRenderer,没有一个是空转的', async () => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    const names = Object.keys(api) as Array<keyof typeof api>
    assert.ok(names.length >= 60, `方法数应在 60 上下,实得 ${names.length}(少了说明搬漏了)`)

    const silent: string[] = []
    for (const name of names) {
      const before = interactions()
      const fn = api[name] as unknown
      assert.equal(typeof fn, 'function', `${String(name)} 必须是函数`)
      const ret = callWithPlaceholders(fn as (...a: unknown[]) => unknown)
      // 返回 Promise 的把 rejection 吃掉:替身回 undefined,下游解构可能抛,那不是本条要验的事
      if (ret instanceof Promise) ret.catch(() => {})
      if (interactions() === before) silent.push(String(name))
    }
    assert.deepEqual(
      silent,
      [],
      '这些方法调用后一次 ipcRenderer 交互都没有 —— 即「按钮按下去毫无反应」的形状'
    )
  })
})

test('PRELOAD-2 mainApi:用到的每个通道名都出自 IpcChannel 常量集(拼错一个字符就在这里红)', async () => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    for (const name of Object.keys(api)) {
      const ret = callWithPlaceholders(api[name as keyof typeof api] as (...a: unknown[]) => unknown)
      if (ret instanceof Promise) ret.catch(() => {})
    }
    const used = [
      ...recorder.invokes.map((i) => i.channel),
      ...recorder.sends.map((s) => s.channel),
      ...recorder.rendererListeners.map((l) => l.channel)
    ]
    assert.ok(used.length > 0, '正向对照:确实记录到了通道(否则下面的集合校验恒真)')
    const strays = [...new Set(used)].filter((c) => !CHANNELS.has(c))
    assert.deepEqual(strays, [], '出现了不在 IpcChannel 里的通道名 —— 主进程那侧永远收不到')
  })
})

test('PRELOAD-3 mainApi:on* 订阅返回的函数会真的 removeListener(不退订 = 重复回调 + 泄漏)', async () => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    const subscribers = Object.keys(api).filter((n) => n.startsWith('on'))
    assert.ok(subscribers.length > 0, '正向对照:确实存在 on* 订阅方法')

    for (const name of subscribers) {
      recorder.rendererListeners.length = 0
      const unsubscribe = (api[name as keyof typeof api] as (cb: unknown) => unknown)(() => {})
      const added = recorder.rendererListeners.filter((l) => l.op === 'on')
      assert.equal(added.length, 1, `${name} 应注册恰好一个监听器`)
      assert.equal(typeof unsubscribe, 'function', `${name} 必须返回退订函数`)
      ;(unsubscribe as () => void)()
      const removed = recorder.rendererListeners.filter((l) => l.op === 'removeListener')
      assert.equal(removed.length, 1, `${name} 的退订函数必须调 removeListener`)
      assert.equal(removed[0].channel, added[0].channel, `${name} 退订的通道要和订阅的一致`)
    }
  })
})

test('NOTICES-preload 无参数 invoke 专用通道,Promise<string> 原样返回成功或错误', async (t) => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    assert.equal(typeof api.openThirdPartyNotices, 'function')
    assert.equal(IpcChannel.AppOpenThirdPartyNotices, 'app:openThirdPartyNotices')
    let response = ''
    const invoke = t.mock.method(ipcRenderer, 'invoke', async () => response)
    for (const expected of ['', '第三方声明文件不存在', 'Windows 找不到关联程序']) {
      response = expected
      const result: Promise<string> = api.openThirdPartyNotices()
      assert.ok(result instanceof Promise)
      assert.equal(await result, expected, '不吞掉 main 的错误串')
    }
    assert.deepEqual(
      invoke.mock.calls.map((call) => call.arguments),
      Array.from({ length: 3 }, () => [IpcChannel.AppOpenThirdPartyNotices]),
      '每次仅发通道名,不附路径 / URL / undefined 等载荷'
    )
  })
})

test('NOTICES-preload IPC rejection 原样交给 renderer,不能变成成功空串', async (t) => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    assert.equal(typeof api.openThirdPartyNotices, 'function')
    const failure = new Error('IPC 通道已关闭')
    t.mock.method(ipcRenderer, 'invoke', async () => {
      throw failure
    })
    await assert.rejects(api.openThirdPartyNotices(), (error) => error === failure)
  })
})

// ==================== takeoverApi ====================

test('PRELOAD-4 takeoverApi:面窄得多,但同样每个方法都转发、通道名同样出自常量集', async () => {
  await withElectronStub(async () => {
    const { takeoverApi } = await import('./takeoverApi')
    const names = Object.keys(takeoverApi)
    assert.ok(names.length > 0)
    assert.ok(
      names.length < 20,
      `接管小窗口的面必须**窄** —— 实得 ${names.length} 条,数字漂上去就是边界在漏`
    )

    const silent: string[] = []
    for (const name of names) {
      const before = interactions()
      const ret = callWithPlaceholders(
        takeoverApi[name as keyof typeof takeoverApi] as (...a: unknown[]) => unknown
      )
      if (ret instanceof Promise) ret.catch(() => {})
      if (interactions() === before) silent.push(name)
    }
    assert.deepEqual(silent, [])

    const used = [
      ...recorder.invokes.map((i) => i.channel),
      ...recorder.sends.map((s) => s.channel),
      ...recorder.rendererListeners.map((l) => l.channel)
    ]
    assert.deepEqual(
      used.filter((c) => !CHANNELS.has(c)),
      []
    )
  })
})

test('PRELOAD-5 两个面互不重叠地覆盖各自职责:takeoverApi 不含 addTask 这类主窗口能力', async () => {
  await withElectronStub(async () => {
    const { api } = await import('./mainApi')
    const { takeoverApi } = await import('./takeoverApi')
    const mainOnly = ['addTask', 'removeTask', 'listTasks', 'setSettings', 'openThirdPartyNotices']
    for (const name of mainOnly) {
      assert.ok(name in api, `正向对照:${name} 确实在主窗口的面上`)
      assert.equal(
        name in takeoverApi,
        false,
        `${name} 不该出现在接管小窗口的面上(§7.2 接口形状即职责边界)`
      )
    }
  })
})

// ==================== preload 入口:分支即边界 ====================

/** `index.ts` 顶层就执行,故每次换 argv 都必须清模块缓存重新加载 */
async function loadPreloadEntry(argvExtra: string[]): Promise<void> {
  const savedArgv = process.argv
  process.argv = [...savedArgv, ...argvExtra]
  try {
    const entry = requireCjs.resolve('./index.ts')
    delete requireCjs.cache[entry]
    delete requireCjs.cache[requireCjs.resolve('./mainApi.ts')]
    delete requireCjs.cache[requireCjs.resolve('./takeoverApi.ts')]
    requireCjs(entry)
  } finally {
    process.argv = savedArgv
  }
}

test('PRELOAD-6 preload 入口:带接管标记 → 只 expose takeoverApi;不带 → 只 expose api', async () => {
  await withElectronStub(async () => {
    // contextIsolation 在本项目恒为 true;测试运行时没有这个属性,补上以走正常路径
    const had = 'contextIsolated' in process
    if (!had) {
      Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
    }
    try {
      await loadPreloadEntry([TAKEOVER_WINDOW_ARG])
      assert.deepEqual(
        recorder.exposed.map((e) => e.key),
        ['takeoverApi'],
        '小窗口只该拿到 takeoverApi —— 多 expose 一个就等于把主窗口的 62 条能力交给了确认框'
      )

      recorder.exposed.length = 0
      await loadPreloadEntry([])
      assert.deepEqual(
        recorder.exposed.map((e) => e.key),
        ['api'],
        '主窗口只该拿到 api'
      )
      const exposedApi = recorder.exposed[0].value as DownLordApi
      assert.equal(typeof exposedApi.openThirdPartyNotices, 'function', '入口真实暴露专用方法')
    } finally {
      if (!had) {
        Reflect.deleteProperty(process, 'contextIsolated')
      }
    }
  })
})
