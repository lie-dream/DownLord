/// <reference types="node" />

/**
 * 「浏览器扩展」页组件测试(v0.4 Task 5 · spec §7.1 的 U-33 / U-34)。
 *
 * **U-33 是四条否定断言**(本页不含端口输入框 / 配对码 / 嗅探开关 / 域名例外表编辑器),
 * 而「查不到」是最容易假绿的一类判据 —— pattern 写错、选择器拼错、query 本身就恒空,
 * 结果都长得跟「真的没有」一模一样。故**每条各配一条正向对照**:同一个 query 用在
 * `ExtensionChannelSettings` 上必须命中,证明它确实能查到东西。
 * ⚠️ 其中「嗅探开关」那条的对照**语义不同、必须说清**:嗅探开关在**设置页也不存在**
 *    (真源在扩展侧 `storage.local`,DownLord 两处都不显示),故它的对照证明的是
 *    「`[role=switch]` 这个 query 在本库里确实查得到开关」,**不是**「嗅探开关在设置页有」。
 *
 * **U-34 = 接管四态文案与设置页逐字相同**,两道保证:
 * ① 结构上 —— 两个组件都从 `../lib/extensionView` 的 `takeoverStateText` / `PAUSE_PRESETS` 取,
 *    本页没有第二份文案可漂移;
 * ② 测试上 —— 同一份 (takeover, status) 分别渲染两个组件,取「临时暂停」行的文案**逐字比对**,
 *    并同时钉死具体措辞(只比对不钉死,两处一起改错也照样绿)。
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DownLordApi,
  ExtensionChannelConfig,
  ExtensionChannelStatus,
  ExtensionSideloadInfo,
  TakeoverPausePatch,
  TakeoverSettingsView
} from '../../../shared/ipc'
import { Ctx as ToastCtx } from '../state/toastStore'
import ExtensionChannelSettings from './ExtensionChannelSettings'
import ExtensionPage from './ExtensionPage'

/** 64 位小写 hex,与主进程 generateToken 同形;本页**永远不该**出现它(压根没调 getExtensionChannelConfig) */
const TOKEN = 'a1b2c3d4'.repeat(8)

let toasts: string[] = []
let navs: string[] = []

afterEach(() => {
  cleanup()
  toasts = []
  navs = []
})

function status(over: Partial<ExtensionChannelStatus> = {}): ExtensionChannelStatus {
  return {
    enabled: true,
    service: 'listening',
    port: 52330,
    lastError: null,
    link: 'unpaired',
    lastHandshakeAt: null,
    ...over
  }
}

function takeoverView(over: Partial<TakeoverSettingsView> = {}): TakeoverSettingsView {
  return { enabled: true, pausedUntil: null, paused: false, excludedDomains: [], ...over }
}

interface Captures {
  pausePatches: TakeoverPausePatch[]
  unsubscribed: number
  takeoverUnsubscribed: number
  push: ((s: ExtensionChannelStatus) => void) | null
  pushTakeover: ((t: TakeoverSettingsView) => void) | null
}

/**
 * 桩语义贴主进程:读回快照、写后回**写后快照**(绝对到期时刻用真实时钟算,与主进程 `now + minutes` 同构)。
 * 一份桩同时喂两个组件 —— U-33 的正向对照要在**同一条件下**渲染设置页,不能各喂各的。
 */
function setupApi(
  init: { status?: ExtensionChannelStatus; takeover?: TakeoverSettingsView } = {},
  over: Partial<DownLordApi> = {}
): Captures {
  const caps: Captures = {
    pausePatches: [],
    unsubscribed: 0,
    takeoverUnsubscribed: 0,
    push: null,
    pushTakeover: null
  }
  const current = init.status ?? status()
  let tk = init.takeover ?? takeoverView()
  const api = {
    // —— 本页用到的两条(只读镜像) ——
    getExtensionChannelStatus: async (): Promise<ExtensionChannelStatus> => current,
    onExtensionChannelStatusChanged: (cb: (s: ExtensionChannelStatus) => void): (() => void) => {
      caps.push = cb
      return () => {
        caps.unsubscribed += 1
        caps.push = null
      }
    },
    // —— 本页用到的三条(接管,可切换) ——
    getTakeoverConfig: async (): Promise<TakeoverSettingsView> => tk,
    setTakeoverPause: async (patch: TakeoverPausePatch): Promise<TakeoverSettingsView> => {
      caps.pausePatches.push(patch)
      const until = patch.minutes === null ? null : Date.now() + patch.minutes * 60_000
      tk = { ...tk, pausedUntil: until, paused: until !== null }
      return tk
    },
    onTakeoverConfigChanged: (cb: (t: TakeoverSettingsView) => void): (() => void) => {
      caps.pushTakeover = cb
      return () => {
        caps.takeoverUnsubscribed += 1
        caps.pushTakeover = null
      }
    },
    // —— 只为 U-33 的正向对照(设置页要读这三条才渲染得出端口 / 配对码 / 引导) ——
    getExtensionChannelConfig: async (): Promise<ExtensionChannelConfig> => ({
      enabled: current.enabled,
      port: current.port,
      token: TOKEN
    }),
    getExtensionSideloadInfo: async (): Promise<ExtensionSideloadInfo> => ({
      dir: 'D:/DownLord/extension/dist',
      exists: true
    }),
    setTakeoverConfig: async (): Promise<TakeoverSettingsView> => tk,
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  return caps
}

/** 渲染本页(需 ToastProvider:三档暂停的反馈走 toast,与设置页同一先例) */
function renderPage(): HTMLElement {
  const { container } = render(
    <ToastCtx.Provider value={{ showToast: (text: string) => toasts.push(text) }}>
      <ExtensionPage onNavChange={(k) => navs.push(k)} />
    </ToastCtx.Provider>
  )
  return container
}

/** 渲染设置页扩展分组 —— U-33 的正向对照 / U-34 的比对对象 */
function renderSettings(): HTMLElement {
  const { container } = render(
    <ToastCtx.Provider value={{ showToast: (text: string) => toasts.push(text) }}>
      <ExtensionChannelSettings />
    </ToastCtx.Provider>
  )
  return container
}

/** 取「临时暂停」那一行的状态文案 —— 两个组件结构同构,故同一个取法两处通用 */
function takeoverLine(root: HTMLElement): string {
  const row = Array.from(root.querySelectorAll('.set-row')).find(
    (r) => r.querySelector('.sr-title')?.textContent === '临时暂停'
  )
  return row?.querySelector('.sr-desc')?.textContent ?? ''
}

// ---------------- ① 连接状态:只读镜像 ----------------

test('① 两行连接状态回显主进程结论(服务态 + 扩展态,各占一行不合并)', async () => {
  setupApi({ status: status({ service: 'listening', port: 52330, link: 'idle_pending' }) })
  const root = renderPage()
  await waitFor(() => {
    // 每行 = 浅色标签 + 主色值(2026-08-11 手测后的层级),文案本身逐字不变
    const lines = Array.from(root.querySelectorAll('.ep-stat')).map((e) => e.textContent)
    assert.deepEqual(lines, ['本地通道:监听中 · 127.0.0.1:52330', '浏览器扩展:待活动'])
  })
  // 值与标签分处两个层级:值必须落在 .ep-v(主文本色),否则整块又会糊成一片浅字
  const values = Array.from(root.querySelectorAll('.ep-stat .ep-v')).map((e) => e.textContent)
  assert.deepEqual(values, ['监听中 · 127.0.0.1:52330', '待活动'])
})

test('★ ① 每个状态行都有行首图标(空 .sr-icon 占位读不出信息,2026-08-11 手测)', async () => {
  setupApi()
  const root = renderPage()
  await waitFor(() => assert.ok(root.querySelector('.ep-stat')))
  // 三块的状态行各一枚图标:本地通道 / 浏览器扩展 / 临时暂停 / 网页嗅探
  assert.equal(root.querySelectorAll('.set-row .sr-icon svg').length, 4)
})

test('① 第三态是「待活动」,**绝不出现「断开」**(与设置页同一措辞纪律)', async () => {
  setupApi({ status: status({ link: 'idle_pending' }) })
  const root = renderPage()
  await waitFor(() => assert.ok(root.textContent?.includes('待活动')))
  assert.equal(root.textContent?.includes('断开'), false)
})

test('① 状态广播推过来当场跟上(只读镜像 = 以主进程为准,不缓存自己的判断)', async () => {
  const caps = setupApi({ status: status({ service: 'stopped', link: 'unpaired' }) })
  const root = renderPage()
  await waitFor(() => assert.ok(root.textContent?.includes('本地通道:已关闭')))
  caps.push?.(status({ service: 'listening', port: 52331, link: 'connected', lastHandshakeAt: 1 }))
  await waitFor(() => assert.ok(root.textContent?.includes('本地通道:监听中 · 127.0.0.1:52331')))
  assert.ok(root.textContent?.includes('浏览器扩展:已连接'))
})

test('①「前往设置页配置」→ onNavChange(settings)(本页唯一的改配置出口)', async () => {
  setupApi()
  renderPage()
  fireEvent.click(await screen.findByText('前往设置页配置'))
  assert.deepEqual(navs, ['settings'])
})

test('卸载即退订两条订阅(状态广播 + 接管配置广播)', async () => {
  const caps = setupApi()
  const { unmount } = render(
    <ToastCtx.Provider value={{ showToast: () => {} }}>
      <ExtensionPage onNavChange={() => {}} />
    </ToastCtx.Provider>
  )
  await waitFor(() => assert.ok(caps.push !== null && caps.pushTakeover !== null))
  unmount()
  assert.equal(caps.unsubscribed, 1)
  assert.equal(caps.takeoverUnsubscribed, 1)
})

test('★ IPC 缺失时 window.api.xxx() 是**同步抛**:本页不白屏,渲染兜底态', async () => {
  // 只留订阅两条(返回取消函数),把两个读取方法拿掉 → 调用即 TypeError(不是 rejected promise)
  Object.defineProperty(window, 'api', {
    value: {
      onExtensionChannelStatusChanged: () => () => {},
      onTakeoverConfigChanged: () => () => {}
    } as unknown as DownLordApi,
    configurable: true
  })
  const root = renderPage()
  // 兜底:通道默认关 → 服务态「已关闭」;接管默认开 + 通道没监听 → 「本地通道未启动 · 接管不会发生」
  assert.ok(root.textContent?.includes('本地通道:已关闭'))
  assert.equal(takeoverLine(root), '本地通道未启动 · 接管不会发生')
})

// ---------------- ★ U-33:四条否定断言,各配一条正向对照 ----------------

test('★ U-33-a 本页**没有**端口输入框(对照:设置页里查得到)', async () => {
  setupApi()
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(settings.querySelector('[aria-label="本地通道端口"]')))
  assert.equal(page.querySelector('[aria-label="本地通道端口"]'), null)
  // 顺带:本页一个 <input> 都没有(只读镜像不接受任何输入)
  assert.equal(page.querySelectorAll('input').length, 0)
})

test('★ U-33-b 本页**没有**配对码(值与三个按钮都没有;对照:设置页里查得到)', async () => {
  setupApi()
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(settings.querySelector('[aria-label="配对码"]')))
  assert.equal(page.querySelector('[aria-label="配对码"]'), null)
  // 明文 token 更不可能出现 —— 本页压根没调 getExtensionChannelConfig(接口形状上就拿不到)
  assert.equal(page.textContent?.includes(TOKEN), false)
  // 「显示 / 复制 / 重新生成」三个按钮:本页无,设置页有(逐个配对照)
  const labels = ['显示', '复制', '重新生成']
  const btnTexts = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll('button')).map((b) => b.textContent ?? '')
  for (const l of labels) {
    assert.equal(btnTexts(page).includes(l), false, `本页不该有「${l}」按钮`)
    assert.ok(btnTexts(settings).includes(l), `对照:设置页应有「${l}」按钮`)
  }
  // ⚠️ 断言的是**控件与 token 值**,不是「配对码」这三个字 ——
  //    本页 ① 区那句「端口、配对码与本地通道开关都在设置页里改」是**指路**,正是它该说的话。
})

test('★ U-33-c 本页**没有嗅探开关**(一个开关都没有;对照:该 query 在设置页确实查得到开关)', async () => {
  setupApi()
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(settings.querySelectorAll('[role="switch"]').length > 0))
  // 本页一个 role=switch 都没有 —— 嗅探开关真源在扩展侧,接管总开关只在设置页
  assert.equal(page.querySelectorAll('[role="switch"]').length, 0)
  // ⚠️ 对照的语义与其余三条不同:**嗅探开关在设置页也不存在**(DownLord 两处都不显示它),
  //    这里的对照只证明「[role=switch] 这个 query 在本库里查得到开关」,故 pattern 没写错。
  assert.equal(
    Array.from(settings.querySelectorAll('[role="switch"]'))
      .map((e) => e.getAttribute('aria-label'))
      .includes('网页嗅探'),
    false,
    '嗅探开关在设置页同样不该存在(真源在扩展侧)'
  )
})

test('★ U-33-d 本页**没有**域名例外表编辑器(对照:设置页里查得到)', async () => {
  setupApi({ takeover: takeoverView({ excludedDomains: ['pan.example.com'] }) })
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(settings.querySelector('[aria-label="添加不接管的域名"]')))
  assert.equal(page.querySelector('[aria-label="添加不接管的域名"]'), null)
  // 标题、chip、删除按钮一并不存在(编辑器整块不在这一页,不只是输入框不在)
  assert.equal(page.textContent?.includes('不接管这些域名'), false)
  assert.ok(settings.textContent?.includes('不接管这些域名'))
  assert.equal(page.textContent?.includes('pan.example.com'), false)
  assert.ok(settings.textContent?.includes('pan.example.com'))
  assert.equal(page.querySelector('.ext-chip'), null)
  assert.ok(settings.querySelector('.ext-chip'))
})

// ---------------- ★ U-34:接管四态文案与设置页逐字相同 ----------------

const FOUR_STATES: { name: string; takeover: TakeoverSettingsView; st: ExtensionChannelStatus }[] = [
  { name: '已关闭', takeover: takeoverView({ enabled: false }), st: status({ service: 'listening' }) },
  {
    name: '本地通道未启动 · 接管不会发生',
    takeover: takeoverView(),
    st: status({ service: 'stopped' })
  },
  { name: '接管中', takeover: takeoverView(), st: status({ service: 'listening' }) }
]

for (const c of FOUR_STATES) {
  test(`★ U-34 四态之「${c.name}」:本页与设置页逐字相同`, async () => {
    setupApi({ status: c.st, takeover: c.takeover })
    const page = renderPage()
    const settings = renderSettings()
    await waitFor(() => {
      assert.notEqual(takeoverLine(page), '')
      assert.notEqual(takeoverLine(settings), '')
    })
    // ① 两处逐字相同(同源保证);② 同时钉死措辞(只比对不钉死,两处一起改错也照样绿)
    assert.equal(takeoverLine(page), takeoverLine(settings))
    assert.equal(takeoverLine(page), c.name)
  })
}

test('★ U-34 四态之「已暂停 · 剩余 N 分钟(至 HH:MM)」:本页与设置页逐字相同', async () => {
  // 绝对到期时刻取自同一个值 → 两处算出的剩余分钟与钟点必须一致
  const until = Date.now() + 60 * 60_000
  setupApi({
    status: status({ service: 'listening' }),
    takeover: takeoverView({ paused: true, pausedUntil: until })
  })
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(takeoverLine(page).startsWith('已暂停')))
  await waitFor(() => assert.ok(takeoverLine(settings).startsWith('已暂停')))
  assert.equal(takeoverLine(page), takeoverLine(settings))
  // 钉死措辞(括号是全角,与 clockText 的输出一致);只比对两处不钉死措辞,两处一起改错也照样绿
  const d = new Date(until)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.equal(takeoverLine(page), `已暂停 · 剩余 60 分钟(至 ${hhmm})`)
})

test('★ U-34 三档时长逐字相同,且**恰好三档纯时间**(无「直到关闭浏览器」/「永久暂停」)', async () => {
  setupApi()
  const page = renderPage()
  const settings = renderSettings()
  await waitFor(() => assert.ok(screen.getAllByText('15 分钟').length >= 2))
  const presetTexts = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll('button'))
      .map((b) => b.textContent ?? '')
      .filter((t) => /分钟|小时/.test(t))
  assert.deepEqual(presetTexts(page), ['15 分钟', '1 小时', '4 小时'])
  assert.deepEqual(presetTexts(page), presetTexts(settings))
  assert.equal(page.textContent?.includes('直到关闭浏览器'), false)
  assert.equal(page.textContent?.includes('永久暂停'), false)
})

// ---------------- ② 接管:可切换(真源在主进程) ----------------

test('② 点「1 小时」→ 上报 {minutes:60};状态改显「已暂停」;三档换成「恢复接管」', async () => {
  const caps = setupApi()
  const root = renderPage()
  fireEvent.click(await screen.findByText('1 小时'))
  await waitFor(() => assert.ok(takeoverLine(root).startsWith('已暂停 · 剩余 60 分钟')))
  assert.deepEqual(caps.pausePatches, [{ minutes: 60 }])
  assert.ok(screen.getByText('恢复接管'))
  assert.equal(screen.queryByText('15 分钟'), null)
  assert.deepEqual(toasts, ['已暂停接管 60 分钟'])
})

test('② 暂停中点「恢复接管」→ 上报 {minutes:null},三档回来', async () => {
  const caps = setupApi({
    takeover: takeoverView({ paused: true, pausedUntil: Date.now() + 15 * 60_000 })
  })
  renderPage()
  fireEvent.click(await screen.findByText('恢复接管'))
  await waitFor(() => assert.ok(screen.getByText('15 分钟')))
  assert.deepEqual(caps.pausePatches, [{ minutes: null }])
  assert.deepEqual(toasts, ['已恢复接管'])
})

test('② 接管已关闭:三档禁用 + 如实指路(总开关与域名例外表都在设置页)', async () => {
  setupApi({ takeover: takeoverView({ enabled: false }) })
  const root = renderPage()
  await waitFor(() => assert.equal(takeoverLine(root), '已关闭'))
  const preset = screen.getByText('15 分钟') as HTMLButtonElement
  assert.equal(preset.disabled, true)
  assert.ok(root.textContent?.includes('接管总开关与「不接管这些域名」都在设置页里改。'))
})

test('★ ② 别处(设置页 / popup 遥控器)写了真源 → 广播推过来,本页当场跟上', async () => {
  const caps = setupApi()
  const root = renderPage()
  await waitFor(() => assert.equal(takeoverLine(root), '接管中'))
  caps.pushTakeover?.(takeoverView({ paused: true, pausedUntil: Date.now() + 4 * 60 * 60_000 }))
  await waitFor(() => assert.ok(takeoverLine(root).startsWith('已暂停 · 剩余 240 分钟')))
})

// ---------------- ③ 嗅探区:引导 + 隐私三句,无列表无开关 ----------------

test('③ 引导语指向扩展 popup(本页不放资源列表 —— 主进程根本没有这份数据)', async () => {
  setupApi()
  const root = renderPage()
  assert.ok(
    root.textContent?.includes(
      '嗅探到的资源在扩展 popup 里查看 —— 点浏览器工具栏上的 DownLord 图标。'
    )
  )
  assert.ok(
    root.textContent?.includes(
      '嗅探开关在 popup 里,默认关闭 —— 它的状态由扩展自己保存,DownLord 这边看不到。'
    )
  )
})

test('★ ③ 隐私说明完整版三句逐字出现,且与设置页**同一份**', async () => {
  setupApi()
  const page = renderPage()
  const settings = renderSettings()
  const NOTE =
    '本扩展不注入页面脚本,只读取网络请求的地址与响应头。嗅探结果不上传、不保存,关闭浏览器即清除。'
  assert.ok(page.textContent?.includes(NOTE))
  await waitFor(() => assert.ok(settings.textContent?.includes(NOTE)))
})
