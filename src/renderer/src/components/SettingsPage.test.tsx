/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  AppSettings,
  AppSettingsPatch,
  BtTrackerStatus,
  CategoryConfig,
  DownLordApi,
  InboundDiagnosis,
  InboundReachability,
  ThemeMode,
  UpdateStatus
} from '../../../shared/ipc'
import SettingsPage from './SettingsPage'
import { ThemeProvider } from '../state/ThemeContext'
import { TasksProvider } from '../state/TasksContext'
import { ToastProvider } from '../state/ToastContext'

afterEach(cleanup)

const SETTINGS: AppSettings = {
  defaultDir: 'D:/Downloads/DownLord',
  maxConcurrent: 3,
  maxOverallLimitKBps: 0,
  useAria2cForVideo: true,
  video: { defaultHeight: null, defaultAudioOnly: false },
  themeMode: 'system',
  clipboardWatch: false,
  autoUpdateYtDlp: true,
  autoUpdateApp: true,
  btSeedEnabled: false,
  btSeedRatio: 1.0,
  btSeedTimeMin: 60,
  btMaxPeers: 0,
  btAutoUpdateTrackers: true
}

// 6 类(含 other):用于验证设置页过滤掉 other,只渲染 5 个具体类
const CATEGORIES: CategoryConfig[] = [
  {
    key: 'video',
    displayName: '视频',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'webm'],
    savePath: 'D:/DL/Videos',
    isCustom: false
  },
  {
    key: 'audio',
    displayName: '音频',
    extensions: ['mp3', 'flac', 'wav'],
    savePath: 'D:/DL/Music',
    isCustom: false
  },
  {
    key: 'archive',
    displayName: '压缩包',
    extensions: ['zip', 'rar', '7z'],
    savePath: 'D:/DL/Archives',
    isCustom: false
  },
  {
    key: 'document',
    displayName: '文档',
    extensions: ['pdf', 'docx'],
    savePath: 'D:/DL/Documents',
    isCustom: false
  },
  {
    key: 'program',
    displayName: '程序',
    extensions: ['exe', 'msi'],
    savePath: 'D:/DL/Programs',
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: 'D:/DL', isCustom: false }
]

interface Captures {
  settingsPatches: AppSettingsPatch[]
  categoryUpdates: { key: string; patch: unknown }[]
  themeSets: ThemeMode[]
  /** 更新 IPC 调用计数(纯触发,业务在主进程 §7.2) */
  updateCalls: string[]
  /** 捕获的 onUpdateStatus 回调:测试据此手动派发广播,驱动进度 / 阶段 */
  updateStatusCb: ((s: UpdateStatus) => void) | null
  /** 桩内累积的「主进程」全量设置(逐字段合并后);连点用例据此断言两次改动都保留 */
  merged: AppSettings | null
  /** BT tracker / 入站诊断 IPC 调用计数(纯转发,判定全在主进程 §7.2) */
  btCalls: string[]
}

/** 默认 tracker 状态桩:从未拉取 → 生效表 = 内置 47 条(与主进程 statusOf 口径一致) */
const TRACKER_NEVER: BtTrackerStatus = {
  state: 'never',
  updatedAt: 0,
  count: 47,
  usingBuiltin: true,
  lastError: null,
  busy: false
}

/** 入站诊断桩(单因子;UI 只渲染汇总三态,factors 供 v0.5 扩写) */
function diagnosis(state: InboundReachability): InboundDiagnosis {
  return {
    state,
    factors: [
      {
        id: 'publicIPv6',
        label: '公网 IPv6',
        verdict: state === 'likely' ? 'supports' : state === 'unlikely' ? 'against' : 'unknown',
        detail: 'stub'
      }
    ],
    checkedAt: 1_753_000_000_000
  }
}

function setupApi(over: Partial<DownLordApi> = {}, base: AppSettings = SETTINGS): Captures {
  const caps: Captures = {
    settingsPatches: [],
    categoryUpdates: [],
    themeSets: [],
    updateCalls: [],
    updateStatusCb: null,
    merged: null,
    btCalls: []
  }
  const api = {
    getVersion: async (): Promise<string> => '0.1.0',
    openThirdPartyNotices: async (): Promise<string> => '',
    getDownloadDir: async (): Promise<string> => 'D:/Downloads/DownLord',
    minimize: (): void => {},
    toggleMaximize: (): void => {},
    close: (): void => {},
    setTheme: async (mode: ThemeMode) => {
      caps.themeSets.push(mode)
      return mode === 'dark' ? 'dark' : 'light'
    },
    onThemeChanged: (): (() => void) => () => {},
    selectDirectory: async (): Promise<string | null> => null,
    selectFile: async (): Promise<string | null> => null,
    openPath: async (): Promise<string> => '',
    showItemInFolder: async (): Promise<string> => '',
    addTask: async (): Promise<string> => 'id',
    pauseTask: async (): Promise<void> => {},
    resumeTask: async (): Promise<void> => {},
    removeTask: async (): Promise<void> => {},
    retryTask: async (): Promise<void> => {},
    listTasks: async () => [],
    onTaskProgress: (): (() => void) => () => {},
    onTaskAdded: (): (() => void) => () => {},
    getResolved: async () => null,
    selectFormat: async (): Promise<void> => {},
    submitBatch: async (): Promise<void> => {},
    applyTorrentSelection: async (): Promise<void> => {},
    stopSeeding: async (): Promise<void> => {},
    listCategories: async (): Promise<CategoryConfig[]> => CATEGORIES,
    updateCategory: async (key: string, patch: unknown): Promise<void> => {
      caps.categoryUpdates.push({ key, patch })
    },
    getProxyConfig: async () => ({ mode: 'system', manualUrl: null }),
    setProxyConfig: async () => ({ mode: 'system', label: 'x', dot: 'off', effectiveUrl: null }),
    getProxyStatus: async () => ({ mode: 'system', label: 'x', dot: 'off', effectiveUrl: null }),
    onProxyStatusChanged: (): (() => void) => () => {},
    onClipboardLink: (): (() => void) => () => {},
    getSettings: async (): Promise<AppSettings> => base,
    // 桩语义 = 主进程 mergeSettings / mergeVideoPrefs 的**逐字段合并**(v0.3 Task 4 审计#10):
    // video 只覆盖补丁携带的子字段,不整包替换 —— 整包替换的旧桩会掩盖「连点丢改」这类缺陷。
    setSettings: async (patch: AppSettingsPatch): Promise<AppSettings> => {
      caps.settingsPatches.push(patch)
      const current = caps.merged ?? base
      caps.merged = { ...current, ...patch, video: { ...current.video, ...(patch.video ?? {}) } }
      return caps.merged
    },
    getEngineVersions: async () => ({ aria2: '1.37', ytdlp: '2026.06', ffmpeg: '7.0' }),
    searchHistory: async () => [],
    getHistoryStats: async () => ({
      total: { count: 0, totalBytes: 0 },
      today: { count: 0, totalBytes: 0 },
      week: { count: 0, totalBytes: 0 },
      month: { count: 0, totalBytes: 0 },
      byCategory: []
    }),
    // v0.2 Task 6 更新(纯触发 + 订阅;检查 / 下载 / 校验 / 替换全在主进程,渲染只 invoke + 订阅广播)
    checkYtDlpUpdate: async () => {
      caps.updateCalls.push('checkYtDlpUpdate')
      return {
        target: 'ytdlp' as const,
        currentVersion: '2026.06',
        latestVersion: '2026.06',
        hasUpdate: false
      }
    },
    runYtDlpUpdate: async (): Promise<void> => {
      caps.updateCalls.push('runYtDlpUpdate')
    },
    checkAppUpdate: async () => {
      caps.updateCalls.push('checkAppUpdate')
      return {
        target: 'app' as const,
        currentVersion: '0.1.0',
        latestVersion: null,
        hasUpdate: false
      }
    },
    downloadAppUpdate: async (): Promise<void> => {
      caps.updateCalls.push('downloadAppUpdate')
    },
    quitAndInstallApp: async (): Promise<void> => {
      caps.updateCalls.push('quitAndInstallApp')
    },
    onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      caps.updateStatusCb = cb
      return () => {
        caps.updateStatusCb = null
      }
    },
    // v0.4 Task 1 BT:tracker 状态 / 入站诊断(渲染层只 invoke + 订阅,判定全在主进程 §7.2)
    getBtTrackerStatus: async (): Promise<BtTrackerStatus> => {
      caps.btCalls.push('getBtTrackerStatus')
      return TRACKER_NEVER
    },
    updateBtTrackersNow: async (): Promise<BtTrackerStatus> => {
      caps.btCalls.push('updateBtTrackersNow')
      return TRACKER_NEVER
    },
    getBtInboundDiagnosis: async (): Promise<InboundDiagnosis> => {
      caps.btCalls.push('getBtInboundDiagnosis')
      return diagnosis('unknown')
    },
    onBtTrackerStatusChanged: (): (() => void) => () => {},
    onBtInboundChanged: (): (() => void) => () => {},
    // v0.4 Task 3 本地通道:设置页「浏览器扩展」分组(<ExtensionChannelSettings/>)挂载即读这三条 +
    // 订阅状态广播。本文件只需满足契约让分组能渲染;分组自身的行为断言在 ExtensionChannelSettings.test.tsx。
    getExtensionChannelConfig: async () => ({ enabled: false, port: 52330, token: 'a'.repeat(64) }),
    setExtensionChannelConfig: async () => ({
      enabled: false,
      service: 'stopped' as const,
      port: 52330,
      lastError: null,
      link: 'unpaired' as const,
      lastHandshakeAt: null
    }),
    regenerateExtensionToken: async () => ({ enabled: false, port: 52330, token: 'b'.repeat(64) }),
    getExtensionChannelStatus: async () => ({
      enabled: false,
      service: 'stopped' as const,
      port: 52330,
      lastError: null,
      link: 'unpaired' as const,
      lastHandshakeAt: null
    }),
    getExtensionSideloadInfo: async () => ({ dir: 'D:/DownLord/extension/dist', exists: true }),
    onExtensionChannelStatusChanged: (): (() => void) => () => {},
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  return caps
}

function renderPage(initialSectionId?: string): void {
  render(
    <ToastProvider>
      <ThemeProvider>
        {() => (
          <TasksProvider>
            <SettingsPage initialSectionId={initialSectionId} />
          </TasksProvider>
        )}
      </ThemeProvider>
    </ToastProvider>
  )
}

const groupTitle = (t: string): HTMLElement => screen.getByText(t, { selector: '.sg-title' })

// ---- 分区导航:jsdom 缺 IntersectionObserver / scrollIntoView,按需 mock(纯 UI 验证) ----
type IOEntry = { isIntersecting: boolean; target: Element }
class MockIO {
  static instances: MockIO[] = []
  cb: (entries: IOEntry[]) => void
  observed: Element[] = []
  constructor(cb: (entries: IOEntry[]) => void) {
    this.cb = cb
    MockIO.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {
    /* mock:IntersectionObserver 接口占位,测试不需实现 */
  }
  disconnect(): void {
    /* mock:IntersectionObserver 接口占位,测试不需实现 */
  }
  // 测试触发:指定 id 的分组进入视野 → 高亮对应子导航
  fire(id: string): void {
    const target = this.observed.find((el) => el.id === id)
    if (target) this.cb([{ isIntersecting: true, target }])
  }
}

test('分区导航 9 项渲染(外观 / 通用 / 下载 / 分类与保存位置 / 代理 / 浏览器扩展 / 视频 / BT · 磁力 / 关于)', async () => {
  setupApi()
  renderPage()
  await screen.findByText('外观', { selector: '.sg-title' })
  const items = Array.from(document.querySelectorAll('.set-nav-item'))
  assert.equal(items.length, 9)
  // 「浏览器扩展」紧邻「代理」之后(通信类设置相邻;v0.4 Task 3 · spec §4.1)
  assert.deepEqual(
    items.map((n) => n.textContent),
    [
      '外观',
      '通用',
      '下载',
      '分类与保存位置',
      '代理',
      '浏览器扩展',
      '视频',
      'BT · 磁力',
      '关于'
    ]
  )
})

test('「浏览器扩展」分组挂在 #set-extension 锚点上,位于代理与视频之间(v0.4 Task 3)', async () => {
  setupApi()
  renderPage()
  assert.ok(await screen.findByText('浏览器扩展', { selector: '.sg-title' }))
  const anchors = Array.from(document.querySelectorAll('.set-anchor')).map((n) => n.id)
  assert.deepEqual(anchors.slice(4, 7), ['set-proxy', 'set-extension', 'set-video'])
  // 分组内五块中的三块标题(其余行为断言在 ExtensionChannelSettings.test.tsx)
  assert.ok(screen.getByText('启用本地通道', { selector: '.sr-title' }))
  assert.ok(screen.getByText('配对码', { selector: '.sr-title' }))
  assert.ok(screen.getByText('安装浏览器扩展', { selector: '.sr-title' }))
})

test('点击子导航项 → 在对应分组上调用 scrollIntoView(平滑滚动)', async () => {  setupApi()
  const calls: string[] = []
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: (...a: unknown[]) => void
  }
  const prev = proto.scrollIntoView
  proto.scrollIntoView = function (this: HTMLElement): void {
    calls.push(this.id)
  }
  try {
    renderPage()
    const videoNav = await screen.findByText('视频', { selector: '.set-nav-item' })
    fireEvent.click(videoNav)
    assert.ok(calls.includes('set-video'), 'scrollIntoView 应在 #set-video 上调用')
  } finally {
    proto.scrollIntoView = prev
  }
})

// v0.4 Task 5(2026-08-11 手测提出):从「浏览器扩展」页跳过来要**直达扩展分组**,
// 否则停在设置页最顶部,与用户自己点左下角「设置」没区别 —— 那个按钮就白按了。
test('★ initialSectionId → 挂载即滚到该分组并高亮(缺省则不滚,左导航进设置页仍落顶部)', async () => {
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: (...a: unknown[]) => void
  }
  const prev = proto.scrollIntoView
  const calls: string[] = []
  proto.scrollIntoView = function (this: HTMLElement): void {
    calls.push(this.id)
  }
  try {
    setupApi()
    renderPage('set-extension')
    await waitFor(() => assert.ok(calls.includes('set-extension')))
    const active = document.querySelector('.set-nav-item.active')
    assert.equal(active?.textContent, '浏览器扩展')
    cleanup()

    // 正向对照:同一 stub 下不传 initialSectionId → 一次滚动都不该发生(证明上面的命中不是恒真)
    calls.length = 0
    setupApi()
    renderPage()
    await screen.findAllByText('外观')
    assert.deepEqual(calls, [])
    assert.equal(document.querySelector('.set-nav-item.active')?.textContent, '外观')
  } finally {
    proto.scrollIntoView = prev
  }
})

test('点击末尾子导航项 → 立即高亮该项(IO 触发不到末尾区也正确,点视频/关于结果不同)', async () => {
  setupApi()
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: (...a: unknown[]) => void
  }
  const prev = proto.scrollIntoView
  proto.scrollIntoView = function (): void {
    /* jsdom 无 scrollIntoView,stub 空实现 */
  }
  try {
    renderPage()
    const aboutNav = await screen.findByText('关于', { selector: '.set-nav-item' })
    fireEvent.click(aboutNav)
    assert.ok(aboutNav.classList.contains('active'), '点击「关于」立即高亮(不靠 IO)')

    const videoNav = screen.getByText('视频', { selector: '.set-nav-item' })
    fireEvent.click(videoNav)
    assert.ok(videoNav.classList.contains('active'), '点击「视频」立即高亮')
    assert.equal(
      aboutNav.classList.contains('active'),
      false,
      '切到视频后「关于」不再高亮(末尾两项点击结果不同,修复 G4.2)'
    )
  } finally {
    proto.scrollIntoView = prev
  }
})

test('点击后 smooth 滚动期间途经分组不抢高亮(点击锁防闪现)', async () => {
  setupApi()
  const prevIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIO
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: (...a: unknown[]) => void
  }
  const prevScroll = proto.scrollIntoView
  proto.scrollIntoView = function (): void {
    /* jsdom 无 scrollIntoView,stub 空实现 */
  }
  try {
    renderPage()
    const proxyNav = await screen.findByText('代理', { selector: '.set-nav-item' })
    fireEvent.click(proxyNav)
    assert.ok(proxyNav.classList.contains('active'), '点击「代理」立即高亮')
    // 模拟 smooth 滚动途经「下载」分组进入视野 → 被点击锁忽略,高亮不跳到下载
    const io = MockIO.instances.at(-1)
    act(() => io!.fire('set-download'))
    assert.ok(proxyNav.classList.contains('active'), '途经分组进入视野时高亮仍是「代理」(防闪现)')
    assert.equal(
      screen.getByText('下载', { selector: '.set-nav-item' }).classList.contains('active'),
      false,
      '途经的「下载」不被高亮'
    )
  } finally {
    proto.scrollIntoView = prevScroll
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = prevIO
    MockIO.instances.length = 0
  }
})

test('IntersectionObserver 高亮当前区(滚动到视频区 → 子导航视频项 active,外观不再 active)', async () => {
  setupApi()
  const prevIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIO
  try {
    renderPage()
    await screen.findByText('外观', { selector: '.sg-title' })
    const io = MockIO.instances.at(-1)
    assert.ok(io, '组件应已构造 IntersectionObserver')
    act(() => io!.fire('set-video'))
    assert.ok(
      screen.getByText('视频', { selector: '.set-nav-item' }).classList.contains('active'),
      '视频子导航应高亮'
    )
    assert.equal(
      screen.getByText('外观', { selector: '.set-nav-item' }).classList.contains('active'),
      false,
      '滚动后初始项不再高亮'
    )
  } finally {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = prevIO
    MockIO.instances.length = 0
  }
})

test('★ 同一批 entries 多个分组同时在视野内 → 高亮取最靠上的那个(初次进入停在「外观」而非「通用」)', async () => {
  // 2026-07-31 手测发现:刚打开设置页时「外观」「通用」都落在触发带内,旧实现逐条 setActiveId
  // 让**数组最后一条**赢,高亮停在「通用」。修法是按 SECTIONS 顺序取最靠上的那个。
  setupApi()
  const prevIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIO
  try {
    renderPage()
    await screen.findByText('外观', { selector: '.sg-title' })
    const io = MockIO.instances.at(-1)
    const target = (id: string): Element => document.querySelector(`#${id}`) as Element
    // 故意把「通用」放在数组后面 —— 旧实现会让它赢
    act(() =>
      io!.cb([
        { isIntersecting: true, target: target('set-appearance') },
        { isIntersecting: true, target: target('set-general') }
      ])
    )
    assert.ok(
      screen.getByText('外观', { selector: '.set-nav-item' }).classList.contains('active'),
      '同时可见时高亮应是最靠上的「外观」'
    )
    assert.equal(
      screen.getByText('通用', { selector: '.set-nav-item' }).classList.contains('active'),
      false,
      '「通用」不得抢走高亮'
    )
  } finally {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = prevIO
    MockIO.instances.length = 0
  }
})

test('六分组标题渲染(外观 / 下载 / 分类与保存位置 / 代理 / 视频 / 关于)', async () => {
  setupApi()
  renderPage()
  assert.ok(await screen.findByText('外观', { selector: '.sg-title' }))
  for (const t of ['下载', '分类与保存位置', '代理', '视频', '关于']) {
    assert.ok(groupTitle(t), `缺分组:${t}`)
  }
})

// ---- 通用组:剪贴板监控开关(spec §6/§9.4)----

test('通用组:剪贴板监控开关默认关(aria-checked=false)+ 诚实文案(不上传/不保存/不记录)', async () => {
  setupApi()
  renderPage()
  const sw = (await screen.findByLabelText('剪贴板监控')) as HTMLElement
  assert.equal(sw.getAttribute('aria-checked'), 'false', '默认关(clipboardWatch=false)')
  // 隐私诚实文案(spec §6.3):明示不上传 / 不保存 / 不记录 + 仅运行时
  assert.ok(screen.getByText(/不上传、不保存、不记录/))
  assert.ok(screen.getByText(/仅在应用运行时生效/))
})

test('通用组:点剪贴板监控开关 → setSettings({clipboardWatch:true})', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByLabelText('剪贴板监控'))
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { clipboardWatch: true }))
})

test('下载并发滑块改值 → 实时显示 + 松手提交 setSettings({maxConcurrent})', async () => {
  const caps = setupApi()
  renderPage()
  const slider = (await screen.findByLabelText('最大同时下载数')) as HTMLInputElement
  fireEvent.change(slider, { target: { value: '7' } })
  assert.equal(slider.value, '7') // 实时显示
  fireEvent.mouseUp(slider) // 松手才提交
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxConcurrent: 7 }))
})

test('下载默认目录浏览 → selectDirectory → setSettings({defaultDir})', async () => {
  const caps = setupApi({ selectDirectory: async () => 'E:/NewDir' })
  renderPage()
  const row = (await screen.findByText('默认保存位置')).closest('.set-row') as HTMLElement
  fireEvent.click(within(row).getByText('浏览'))
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { defaultDir: 'E:/NewDir' }))
})

// ---- 下载:全局限速(spec §5.1)----

test('全局限速回显:kbps=0 → 空 + 占位「不限速」', async () => {
  setupApi()
  renderPage()
  const input = (await screen.findByLabelText('下载限速')) as HTMLInputElement
  assert.equal(input.value, '', '0 → 空')
  assert.equal(input.placeholder, '不限速')
})

test('全局限速回显:kbps=2048 → 默认 MB/s 显 2', async () => {
  const withLimit: AppSettings = { ...SETTINGS, maxOverallLimitKBps: 2048 }
  setupApi({}, withLimit)
  renderPage()
  // getSettings 异步回填后本地态更新(初始默认 0 → 空,加载后 2048 → 2);等回显稳定
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText('下载限速') as HTMLInputElement).value,
      '2',
      '2048 KB/s → 2 MB/s'
    )
  )
})

test('全局限速输入 2 MB/s + 失焦 → setSettings({maxOverallLimitKBps:2048})', async () => {
  const caps = setupApi()
  renderPage()
  const input = (await screen.findByLabelText('下载限速')) as HTMLInputElement
  fireEvent.change(input, { target: { value: '2' } })
  fireEvent.blur(input)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxOverallLimitKBps: 2048 }))
})

test('全局限速切单位 KB/s → 输入 500 + 回车 → setSettings({maxOverallLimitKBps:500})', async () => {
  const caps = setupApi()
  renderPage()
  const unit = (await screen.findByLabelText('限速单位')) as HTMLSelectElement
  fireEvent.change(unit, { target: { value: 'KB' } })
  const input = (await screen.findByLabelText('下载限速')) as HTMLInputElement
  fireEvent.change(input, { target: { value: '500' } })
  input.focus() // C9(2026-09-18):F2 后 Enter 经失焦提交;jsdom 里未聚焦元素的 blur() 不发事件
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxOverallLimitKBps: 500 }))
})

test('全局限速空输入 → setSettings({maxOverallLimitKBps:0})(不限速)', async () => {
  const withLimit: AppSettings = { ...SETTINGS, maxOverallLimitKBps: 2048 }
  const caps = setupApi({}, withLimit)
  renderPage()
  // 先等加载值(2048→2)回填,再清空,确保 commitLimit 与已加载的 2048 比较后确有变化
  await waitFor(() =>
    assert.equal((screen.getByLabelText('下载限速') as HTMLInputElement).value, '2')
  )
  const input = screen.getByLabelText('下载限速') as HTMLInputElement
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.blur(input)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxOverallLimitKBps: 0 }))
})

// ---- 2026-09-18 Task 8 实机卡口附带发现(限速设计 §5.4.1;F1 显示换算 / F2 Enter 失焦)----

test('T8-A14 全局限速 Enter → 焦点离开输入框且恰提交一次(2026-09-18 实机卡口:零反馈曾被读成「Enter 无效」)', async () => {
  const caps = setupApi()
  renderPage()
  const input = (await screen.findByLabelText('下载限速')) as HTMLInputElement
  input.focus()
  assert.equal(document.activeElement, input, '前提:真实按键时输入框必然持有焦点')
  fireEvent.change(input, { target: { value: '2' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  assert.notEqual(document.activeElement, input, 'Enter 后焦点离开输入框 = 可见反馈')
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxOverallLimitKBps: 2048 }))
  assert.equal(caps.settingsPatches.length, 1, '经 onBlur 提交恰一次,不重复 patch')
})

test('T8-A15 全局限速回显:MB/s 取能无损换算回同一 KB/s 的最短小数 —— 10 → 0.01(不是 0.0)、1500 → 1.465', async () => {
  setupApi({}, { ...SETTINGS, maxOverallLimitKBps: 10 })
  renderPage()
  await waitFor(() =>
    assert.equal((screen.getByLabelText('下载限速') as HTMLInputElement).value, '0.01')
  )
  cleanup()
  setupApi({}, { ...SETTINGS, maxOverallLimitKBps: 1500 })
  renderPage()
  await waitFor(() =>
    assert.equal((screen.getByLabelText('下载限速') as HTMLInputElement).value, '1.465')
  )
})

test('T8-A16 全局限速 KB/s 10 提交后切 MB/s → 显示 0.01;再失焦零 patch(不会被静默改成 0 = 不限速)', async () => {
  const caps = setupApi()
  renderPage()
  const unit = (await screen.findByLabelText('限速单位')) as HTMLSelectElement
  fireEvent.change(unit, { target: { value: 'KB' } })
  const input = screen.getByLabelText('下载限速') as HTMLInputElement
  fireEvent.change(input, { target: { value: '10' } })
  fireEvent.blur(input)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { maxOverallLimitKBps: 10 }))
  await waitFor(() => assert.equal(input.value, '10'))
  fireEvent.change(unit, { target: { value: 'MB' } })
  assert.equal(input.value, '0.01', '切单位后按新单位回显,且能换算回 10')
  fireEvent.blur(input)
  assert.equal(caps.settingsPatches.length, 1, '失焦后不得再 patch(旧实现显示 0.0 → 失焦提交 0)')
})

// ---- 视频组:单字段补丁(v0.3 Task 4 审计#10)----
// 各 video 控件只发**被改的那个子字段**(不带 stale 兄弟字段),主进程逐字段合并 → 连点互不覆盖。

test('视频默认清晰度选 1080P → setSettings({video:{defaultHeight:1080}})(只含被改键)', async () => {
  const caps = setupApi()
  renderPage()
  const sel = (await screen.findByLabelText('默认清晰度')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: '1080' } })
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), { video: { defaultHeight: 1080 } })
  )
})

test('视频默认提取音频开关 → setSettings({video:{defaultAudioOnly:true}})(只含被改键)', async () => {
  const caps = setupApi()
  renderPage()
  const sw = await screen.findByLabelText('默认提取音频')
  fireEvent.click(sw)
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), { video: { defaultAudioOnly: true } })
  )
})

test('快速连点两个 video 项(提取音频 + 默认字幕)→ 两次改动都保留(审计#10 根治)', async () => {
  const caps = setupApi()
  renderPage()
  const audio = await screen.findByLabelText('默认提取音频')
  const subtitle = await screen.findByLabelText('默认下载字幕')
  // 连点:第二个 handler 闭包仍持有改动前的 video 快照 —— 整包 spread 补丁会把第一次改动覆盖回去
  fireEvent.click(audio)
  fireEvent.click(subtitle)
  await waitFor(() => assert.equal(caps.settingsPatches.length, 2))
  assert.deepEqual(caps.settingsPatches[0], { video: { defaultAudioOnly: true } }, '① 只发音频键')
  assert.deepEqual(
    caps.settingsPatches[1],
    { video: { subtitle: { langs: ['zh-Hans'], format: 'srt', includeAuto: false } } },
    '② 只发字幕键(不带 stale defaultAudioOnly:false)'
  )
  assert.equal(caps.merged?.video.defaultAudioOnly, true, '第一次改动未被第二次回退')
  assert.deepEqual(caps.merged?.video.subtitle?.langs, ['zh-Hans'], '第二次改动生效')
})

// ---- 视频组:aria2c 加速开关(spec §5.2)----

test('aria2c 加速开关(默认开)→ 点关 setSettings({useAria2cForVideo:false})', async () => {
  const caps = setupApi()
  renderPage()
  const sw = (await screen.findByLabelText('用 aria2c 加速视频下载')) as HTMLElement
  assert.equal(sw.getAttribute('aria-checked'), 'true', '默认开(useAria2cForVideo=true)')
  fireEvent.click(sw)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { useAria2cForVideo: false }))
})

// ---- 视频组:Cookie 来源(spec §5.2)----
test('Cookie 来源选「从浏览器」→ setSettings 补 cookie(browser 默认 chrome)+ 出现浏览器子行', async () => {
  const caps = setupApi()
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'browser' } })
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        cookie: { source: 'browser', browser: 'chrome', profile: null, file: null }
      }
    })
  )
  // 浏览器子行出现(设置回写后 video.cookie.source='browser')
  const browserSel = (await screen.findByLabelText('Cookie 浏览器')) as HTMLSelectElement
  fireEvent.change(browserSel, { target: { value: 'firefox' } })
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        cookie: { source: 'browser', browser: 'firefox', profile: null, file: null }
      }
    })
  )
})

test('Cookie 来源选「从 Cookie 文件」→ 选文件回填路径(window.api.selectFile)', async () => {
  const caps = setupApi({ selectFile: async () => 'D:/exports/cookies.txt' })
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'file' } })
  // 文件子行按钮出现 → 点击调 selectFile 回填路径
  fireEvent.click(await screen.findByText(/选择 Cookie 文件/))
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        cookie: { source: 'file', browser: null, profile: null, file: 'D:/exports/cookies.txt' }
      }
    })
  )
  // 回显路径(末段可辨)
  assert.ok(screen.getByText(/cookies\.txt/))
})

// ---- 视频组:默认下载字幕(spec §5.2)----

test('默认下载字幕开关 → setSettings 补 subtitle(langs=[zh-Hans]);再选英文追加语言', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByLabelText('默认下载字幕'))
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        subtitle: { langs: ['zh-Hans'], format: 'srt', includeAuto: false }
      }
    })
  )
  // 开启后出现常用语言 chip → 追加英文
  fireEvent.click(await screen.findByText('英文'))
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        subtitle: { langs: ['zh-Hans', 'en'], format: 'srt', includeAuto: false }
      }
    })
  )
})

test('默认字幕:格式选 VTT + 含自动生成开 → 分别落 setSettings', async () => {
  // 初始已开字幕(langs 非空)以直接显示格式 / 自动生成控件
  const withSub: AppSettings = {
    ...SETTINGS,
    video: {
      defaultHeight: null,
      defaultAudioOnly: false,
      subtitle: { langs: ['zh-Hans'], format: 'srt', includeAuto: false }
    }
  }
  const caps = setupApi({}, withSub)
  renderPage()
  const fmt = (await screen.findByLabelText('默认字幕格式')) as HTMLSelectElement
  fireEvent.change(fmt, { target: { value: 'vtt' } })
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        subtitle: { langs: ['zh-Hans'], format: 'vtt', includeAuto: false }
      }
    })
  )
  fireEvent.click(screen.getByLabelText('默认含自动生成字幕'))
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), {
      video: {
        subtitle: { langs: ['zh-Hans'], format: 'vtt', includeAuto: true }
      }
    })
  )
})

// ---- 关于组:自动更新体系(v0.2 Task 6;纯 UI 展示 + 触发,§7.2)----

test('关于显示版本 / 内核版本 + 未签名诚实小字', async () => {
  setupApi()
  renderPage()
  assert.ok(await screen.findByText('DownLord v0.1.0'))
  assert.ok(screen.getByText(/aria2 1\.37 · yt-dlp 2026\.06 · ffmpeg 7\.0/))
  // 诚实(PRD §4.4):未签名 SmartScreen 如实说明,不隐瞒
  assert.ok(screen.getByText(/未做代码签名/))
  assert.ok(screen.getByText(/未知发布者/))
})

async function thirdPartyNoticesButton(): Promise<HTMLElement> {
  await screen.findByText('DownLord v0.1.0')
  const button = screen.queryByRole('button', { name: '第三方许可与声明' })
  assert.ok(button, '关于页应提供「第三方许可与声明」按钮')
  return button
}

test('NOTICES-ui 关于页最小入口只在点击时无参数调用专用 API,成功不显示错误', async () => {
  const calls: unknown[][] = []
  const caps = setupApi({
    openThirdPartyNotices: async (...args: unknown[]) => {
      calls.push(args)
      return ''
    },
    openPath: async () => assert.fail('renderer 不应计算路径或调用通用 openPath')
  })
  renderPage()
  const button = await thirdPartyNoticesButton()
  assert.equal(button.closest('section')?.id, 'set-about')
  assert.ok(button.classList.contains('btn'))
  assert.ok(button.classList.contains('btn-default'), '沿用现有按钮样式')
  assert.deepEqual(calls, [], '挂载不自动打开文档')
  await act(async () => fireEvent.click(button))
  assert.deepEqual(calls, [[]], '纯意图,没有路径 / URL / 其他载荷')
  assert.equal(document.querySelector('.toast'), null)
  assert.ok(screen.getByText(/aria2 1\.37 · yt-dlp 2026\.06 · ffmpeg 7\.0/))
  assert.deepEqual(caps.updateCalls, [], '声明入口不触发更新')
})

for (const message of [
  '第三方许可与声明文件不存在，请检查应用文件是否完整。',
  '打开第三方许可与声明失败：Windows 找不到关联程序',
  '打开第三方许可与声明失败：系统拒绝访问'
]) {
  test(`NOTICES-ui main 返回的失败确实可见:${message}`, async () => {
    setupApi({ openThirdPartyNotices: async () => message })
    renderPage()
    const button = await thirdPartyNoticesButton()
    await act(async () => fireEvent.click(button))
    assert.ok(await screen.findByText(message, { selector: '.toast' }))
  })
}

for (const [label, failure, detail] of [
  ['Error', new Error('IPC 通道已关闭'), 'IPC 通道已关闭'],
  ['字符串', 'IPC 不可用', 'IPC 不可用'],
  ['无原因', undefined, '未知错误，请重试。']
] as const) {
  test(`NOTICES-ui IPC rejection(${label})也显示可见错误,不成为未处理异常`, async () => {
    setupApi({
      openThirdPartyNotices: async () => {
        throw failure
      }
    })
    renderPage()
    const button = await thirdPartyNoticesButton()
    await act(async () => fireEvent.click(button))
    assert.ok(
      await screen.findByText(`打开第三方许可与声明失败：${detail}`, { selector: '.toast' })
    )
  })
}

test('yt-dlp 行未检查时只显「当前 X」,不显「最新 —」(U1 文案修复)', async () => {
  setupApi()
  renderPage()
  const ytRow = (await screen.findByText('yt-dlp 组件更新', { selector: '.sr-title' })).closest(
    '.set-row'
  ) as HTMLElement
  const desc = ytRow.querySelector('.sr-desc') as HTMLElement
  assert.equal(desc.textContent, '当前 2026.06', '未检查 → 只显当前,无「· 最新 —」')
})

test('yt-dlp applied 后「当前」刷新为新版(U4:消除「已更新至 X 但当前仍 Y」矛盾)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查 yt-dlp 更新')
  const ytRow = (): HTMLElement =>
    screen
      .getByText('yt-dlp 组件更新', { selector: '.sr-title' })
      .closest('.set-row') as HTMLElement
  // 初始当前 2026.06(getEngineVersions 桩)
  assert.equal((ytRow().querySelector('.sr-desc') as HTMLElement).textContent, '当前 2026.06')
  // applied 广播 → 当前刷新为新版 2026.06.10(不再显示旧版)
  act(() =>
    caps.updateStatusCb!({
      target: 'ytdlp',
      phase: 'applied',
      currentVersion: '2026.06',
      latestVersion: '2026.06.10',
      message: 'yt-dlp 已更新至 2026.06.10'
    })
  )
  assert.equal(
    (ytRow().querySelector('.sr-desc') as HTMLElement).textContent,
    '当前 2026.06.10 · 最新 2026.06.10',
    'applied 后「当前」= 新版(不再是 2026.06)'
  )
})

test('两自动更新开关默认开(aria-checked=true)+ 点关落 setSettings', async () => {
  const caps = setupApi()
  renderPage()
  const ytSw = (await screen.findByLabelText('自动更新 yt-dlp 组件')) as HTMLElement
  const appSw = (await screen.findByLabelText('自动检查应用更新')) as HTMLElement
  assert.equal(ytSw.getAttribute('aria-checked'), 'true', 'autoUpdateYtDlp 默认开')
  assert.equal(appSw.getAttribute('aria-checked'), 'true', 'autoUpdateApp 默认开')
  fireEvent.click(ytSw)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { autoUpdateYtDlp: false }))
  fireEvent.click(appSw)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { autoUpdateApp: false }))
})

test('点「检查 yt-dlp 更新」→ 触发 runYtDlpUpdate(纯触发,业务在主进程)', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByText('检查 yt-dlp 更新'))
  await waitFor(() => assert.ok(caps.updateCalls.includes('runYtDlpUpdate')))
})

test('onUpdateStatus 驱动 yt-dlp:checking→downloading(进度条)→applied(toast 告知,不静默)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查 yt-dlp 更新')
  const cb = caps.updateStatusCb!
  assert.ok(cb, '组件应订阅 onUpdateStatus')

  // downloading 50% → 出现进度条(复用 .bar,span 宽度 = 百分比)
  act(() =>
    cb({
      target: 'ytdlp',
      phase: 'downloading',
      percent: 50,
      currentVersion: '2026.06.09',
      latestVersion: '2026.06.10'
    })
  )
  const bar = document.querySelector('.bar > span') as HTMLElement | null
  assert.ok(bar, 'downloading 阶段渲染进度条')
  assert.equal(bar!.style.width, '50%', '进度条宽度 = percent')

  // applied → toast 诚实告知(非静默替换);message 同时显示在状态行,故仅断言 toast
  act(() =>
    cb({
      target: 'ytdlp',
      phase: 'applied',
      currentVersion: '2026.06.09',
      latestVersion: '2026.06.10',
      message: 'yt-dlp 已更新至 2026.06.10'
    })
  )
  assert.ok(await screen.findByText(/已更新至 2026\.06\.10/, { selector: '.toast' }))
})

test('onUpdateStatus 驱动 yt-dlp:verifying → indeterminate 进度条(.bar.indet)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查 yt-dlp 更新')
  act(() =>
    caps.updateStatusCb!({
      target: 'ytdlp',
      phase: 'verifying',
      currentVersion: '2026.06.09',
      latestVersion: '2026.06.10'
    })
  )
  assert.ok(document.querySelector('.bar.indet'), 'verifying 阶段用 indeterminate 进度条')
})

test('onUpdateStatus 驱动 yt-dlp:pending-restart → toast 告知将下次启动生效(占用不 kill)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查 yt-dlp 更新')
  act(() =>
    caps.updateStatusCb!({
      target: 'ytdlp',
      phase: 'pending-restart',
      currentVersion: '2026.06.09',
      latestVersion: '2026.06.10',
      message: 'yt-dlp 更新已就绪,将在下次启动生效'
    })
  )
  assert.ok(await screen.findByText(/将在下次启动生效/, { selector: '.toast' }))
})

test('点「检查应用更新」→ 触发 checkAppUpdate(不自动下载)', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByText('检查应用更新'))
  await waitFor(() => assert.ok(caps.updateCalls.includes('checkAppUpdate')))
})

test('应用更新不静默:available →[下载]→ downloading(进度)→ ready →[重启安装]', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查应用更新')
  const cb = caps.updateStatusCb!
  // 「应用更新」行(作用域,避开左导航 / 分组标题同名「下载」)
  const appRow = (): HTMLElement =>
    screen.getByText('应用更新', { selector: '.sr-title' }).closest('.set-row') as HTMLElement

  // available → 显新版本 + 出现「下载」按钮(不自动下载,§4.4)
  act(() =>
    cb({ target: 'app', phase: 'available', currentVersion: '0.1.0', latestVersion: '0.2.0' })
  )
  assert.ok(screen.getByText(/有新版本 0\.2\.0/))
  fireEvent.click(within(appRow()).getByText('下载'))
  await waitFor(() => assert.ok(caps.updateCalls.includes('downloadAppUpdate')))

  // downloading → 进度条
  act(() =>
    cb({
      target: 'app',
      phase: 'downloading',
      percent: 30,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0'
    })
  )
  const bar = document.querySelector('.bar > span') as HTMLElement | null
  assert.equal(bar?.style.width, '30%', '应用下载进度条')

  // ready → 「重启安装」(btn-primary),点击触发 quitAndInstall(用户确认,非静默)
  act(() => cb({ target: 'app', phase: 'ready', currentVersion: '0.1.0', latestVersion: '0.2.0' }))
  const restart = within(appRow()).getByText('重启安装')
  assert.ok(restart.classList.contains('btn-primary'), '重启安装用主色强调')
  fireEvent.click(restart)
  await waitFor(() => assert.ok(caps.updateCalls.includes('quitAndInstallApp')))
})

test('onUpdateStatus 驱动应用检查:up-to-date → toast「已是最新」', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('检查应用更新')
  act(() =>
    caps.updateStatusCb!({
      target: 'app',
      phase: 'up-to-date',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0'
    })
  )
  assert.ok(await screen.findByText(/当前已是最新版本/))
})

test('外观主题选「深色」→ setTheme(dark) + 持久化 setSettings({themeMode:dark})', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByText('深色'))
  await waitFor(() => assert.equal(caps.themeSets.at(-1), 'dark'))
  await waitFor(() => assert.ok(caps.settingsPatches.some((p) => p.themeMode === 'dark')))
})

test('分类组渲染 5 个具体类(过滤 other);改目录 → updateCategory(key,{savePath})', async () => {
  const caps = setupApi({ selectDirectory: async () => 'E:/Movies' })
  renderPage()
  // 5 个具体类渲染(displayName);other 不渲染
  await screen.findByText('压缩包', { selector: '.sr-title' })
  for (const name of ['视频', '音频', '压缩包', '文档', '程序']) {
    assert.ok(screen.getByText(name, { selector: '.sr-title' }), `缺类别行:${name}`)
  }
  assert.equal(screen.queryByText('其他'), null, 'other 应被过滤')
  // 扩展名标签编辑器(.chip + 删除 ×),非只读文案
  assert.ok(screen.getByLabelText('删除 mp4'), '视频类 mp4 扩展名以可删 .chip 标签渲染')
  // 改视频类目录
  const videoRow = screen
    .getByText('视频', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  fireEvent.click(within(videoRow).getByText('浏览'))
  await waitFor(() =>
    assert.deepEqual(caps.categoryUpdates.at(-1), {
      key: 'video',
      patch: { savePath: 'E:/Movies' }
    })
  )
})

test('改默认目录 → 重拉 category:list 刷新分类组显示(跟随类真实目录依默认目录重算)', async () => {
  let listCalls = 0
  const caps = setupApi({
    selectDirectory: async () => 'E:/NewRoot',
    listCategories: async () => {
      listCalls++
      return CATEGORIES
    }
  })
  renderPage()
  await screen.findByText('外观', { selector: '.sg-title' })
  const before = listCalls // 挂载已拉一次(TasksProvider loadCategories)
  const row = (await screen.findByText('默认保存位置')).closest('.set-row') as HTMLElement
  fireEvent.click(within(row).getByText('浏览'))
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { defaultDir: 'E:/NewRoot' }))
  // 改默认目录后 patch() 调 reloadCategories → 再次 listCategories(刷新分类组,否则显示滞后于落盘)
  await waitFor(() => assert.ok(listCalls > before, '改默认目录后重拉 category:list'))
})

test('分类组:自定义类(isCustom)显「自定义」标签 + 真实目录 + 「重置为默认」→ updateCategory(key,{savePath:""})', async () => {
  const customCats: CategoryConfig[] = CATEGORIES.map((c) =>
    c.key === 'video' ? { ...c, savePath: 'E:/Movies', isCustom: true } : c
  )
  const caps = setupApi({ listCategories: async () => customCats })
  renderPage()
  await screen.findByText('视频', { selector: '.sr-title' })
  // 自定义标签 + 显真实目录
  assert.ok(screen.getByText('自定义', { selector: '.cat-tag' }))
  assert.ok(screen.getByDisplayValue('E:/Movies'))
  // 「重置为默认」→ updateCategory(savePath:'')(回「跟随」)
  const videoRow = screen
    .getByText('视频', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  fireEvent.click(within(videoRow).getByText('重置为默认'))
  await waitFor(() =>
    assert.deepEqual(caps.categoryUpdates.at(-1), { key: 'video', patch: { savePath: '' } })
  )
})

test('分类组:跟随类(isCustom=false)无「自定义」标签 / 无「重置为默认」', async () => {
  setupApi()
  renderPage()
  await screen.findByText('视频', { selector: '.sr-title' })
  assert.equal(screen.queryByText('自定义', { selector: '.cat-tag' }), null)
  assert.equal(screen.queryByText('重置为默认'), null)
})

// ---- 扩展名在线编辑(spec §5)----

test('扩展名删除:点击 × → updateCategory(key,{extensions 去该项})', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('音频', { selector: '.sr-title' })
  fireEvent.click(screen.getByLabelText('删除 wav'))
  await waitFor(() =>
    assert.deepEqual(caps.categoryUpdates.at(-1), {
      key: 'audio',
      patch: { extensions: ['mp3', 'flac'] }
    })
  )
})

test('扩展名新增(无冲突):输入 + Enter → updateCategory(key,{extensions 追加,规范化})', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('视频', { selector: '.sr-title' })
  const videoRow = screen
    .getByText('视频', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  const input = within(videoRow).getByLabelText('添加扩展名') as HTMLInputElement
  // 大写 + 前导点 → 渲染层轻量规范化为 rmvb(权威规范化仍在主进程)
  fireEvent.change(input, { target: { value: '.RMVB' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    assert.deepEqual(caps.categoryUpdates.at(-1), {
      key: 'video',
      patch: { extensions: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'webm', 'rmvb'] }
    })
  )
})

test('扩展名新增已在本类 → no-op(不调 updateCategory)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('视频', { selector: '.sr-title' })
  const videoRow = screen
    .getByText('视频', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  const input = within(videoRow).getByLabelText('添加扩展名') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'mp4' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await Promise.resolve()
  assert.equal(caps.categoryUpdates.length, 0, '重复扩展名不触发落库')
})

test('扩展名冲突 → 弹确认;确认 → 迁移(旧类移除 + 新类加入两次 updateCategory)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('文档', { selector: '.sr-title' })
  // 把视频类的 mp4 加到「文档」类 → 冲突
  const docRow = screen
    .getByText('文档', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  const input = within(docRow).getByLabelText('添加扩展名') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'mp4' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  // 弹确认(文案含来源类「视频」与目标类「文档」)
  await screen.findByText(/当前属于「视频」类,改归「文档」类/)
  assert.equal(caps.categoryUpdates.length, 0, '确认前不落库')
  fireEvent.click(screen.getByText('改归「文档」'))
  // 迁移 = 旧类移除 mp4 + 新类加入 mp4(两次 updateCategory)
  await waitFor(() => assert.equal(caps.categoryUpdates.length, 2))
  assert.deepEqual(caps.categoryUpdates[0], {
    key: 'video',
    patch: { extensions: ['mkv', 'avi', 'mov', 'flv', 'webm'] }
  })
  assert.deepEqual(caps.categoryUpdates[1], {
    key: 'document',
    patch: { extensions: ['pdf', 'docx', 'mp4'] }
  })
})

test('扩展名冲突 → 取消 → no-op(不调 updateCategory)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('文档', { selector: '.sr-title' })
  const docRow = screen
    .getByText('文档', { selector: '.sr-title' })
    .closest('.set-row') as HTMLElement
  const input = within(docRow).getByLabelText('添加扩展名') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'mp4' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByText(/当前属于「视频」类/)
  fireEvent.click(screen.getByText('取消'))
  await waitFor(() => assert.equal(screen.queryByText(/当前属于「视频」类/), null))
  assert.equal(caps.categoryUpdates.length, 0, '取消 → 零落库')
})

// ---- BT · 磁力组(v0.3 Task 3;做种开关 + ratio/time/maxPeers + 诚实措辞 §2.5)----

test('BT 分组渲染 + 做种开关默认关(aria-checked=false)+ 诚实文案(无「加速他人/私有网络/保证上传/P2SP」)', async () => {
  setupApi()
  renderPage()
  assert.ok(await screen.findByText('BT · 磁力', { selector: '.sg-title' }))
  const sw = screen.getByLabelText('下载完成后做种') as HTMLElement
  assert.equal(sw.getAttribute('aria-checked'), 'false', 'btSeedEnabled 默认关')
  // 诚实措辞:能说的
  assert.ok(screen.getByText(/分享给正在下载同一种子的其他用户/))
  assert.ok(screen.getByText(/默认关闭——下载完即停止上传/))
  assert.ok(screen.getByText(/做种是自愿的/))
  assert.ok(screen.getByText(/通过 aria2 原生做种能力实现/))
  // 红线:不能出现的措辞
  const body = document.body.textContent ?? ''
  for (const forbidden of ['加速他人', '私有网络', '私有加速', '保证上传', '一定上传', 'P2SP']) {
    assert.equal(body.includes(forbidden), false, `BT 分组不得出现「${forbidden}」`)
  }
})

test('BT 做种开关 → setSettings({btSeedEnabled:true})', async () => {
  const caps = setupApi()
  renderPage()
  fireEvent.click(await screen.findByLabelText('下载完成后做种'))
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { btSeedEnabled: true }))
})

test('BT 分享率上限:改值 + 失焦 → setSettings({btSeedRatio})', async () => {
  const on: AppSettings = { ...SETTINGS, btSeedEnabled: true }
  const caps = setupApi({}, on)
  renderPage()
  const input = (await screen.findByLabelText('分享率上限')) as HTMLInputElement
  await waitFor(() => assert.equal(input.value, '1'))
  fireEvent.change(input, { target: { value: '2.5' } })
  fireEvent.blur(input)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { btSeedRatio: 2.5 }))
})

test('BT 做种时间上限:改值 + 回车 → setSettings({btSeedTimeMin})', async () => {
  const on: AppSettings = { ...SETTINGS, btSeedEnabled: true }
  const caps = setupApi({}, on)
  renderPage()
  const input = (await screen.findByLabelText('做种时间上限(分钟)')) as HTMLInputElement
  input.focus() // C10(2026-09-18):BtNumRow 同 F2,Enter 经失焦提交;未聚焦元素的 blur() 不发事件
  fireEvent.change(input, { target: { value: '120' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { btSeedTimeMin: 120 }))
})

test('BT 最大连接数:空输入 → setSettings({btMaxPeers:0})(跟随默认)', async () => {
  const on: AppSettings = { ...SETTINGS, btSeedEnabled: true, btMaxPeers: 200 }
  const caps = setupApi({}, on)
  renderPage()
  const input = (await screen.findByLabelText('最大连接数(可选)')) as HTMLInputElement
  await waitFor(() => assert.equal(input.value, '200'))
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.blur(input)
  await waitFor(() => assert.deepEqual(caps.settingsPatches.at(-1), { btMaxPeers: 0 }))
})

test('BT 未开做种:ratio/time/maxPeers 输入禁用(视觉弱化,克制)', async () => {
  setupApi() // btSeedEnabled 默认 false
  renderPage()
  const ratio = (await screen.findByLabelText('分享率上限')) as HTMLInputElement
  assert.equal(ratio.disabled, true, '未开做种时分享率输入禁用')
  assert.equal((screen.getByLabelText('做种时间上限(分钟)') as HTMLInputElement).disabled, true)
  assert.equal((screen.getByLabelText('最大连接数(可选)') as HTMLInputElement).disabled, true)
})

// ---- BT 分组三行(v0.4 Task 1;tracker 自动更新开关 + 状态行四态 + 入站诊断三态)----

/** 以指定 tracker 状态渲染设置页,返回状态行(.set-row)供断言 */
async function renderWithTracker(st: BtTrackerStatus): Promise<HTMLElement> {
  setupApi({ getBtTrackerStatus: async (): Promise<BtTrackerStatus> => st })
  renderPage()
  const title = await screen.findByText('tracker 列表', { selector: '.sr-title' })
  return title.closest('.set-row') as HTMLElement
}

test('tracker 状态行 · never:「尚未更新 · 当前使用内置列表(47 条)」', async () => {
  const row = await renderWithTracker(TRACKER_NEVER)
  await waitFor(() =>
    assert.ok(within(row).getByText('尚未更新 · 当前使用内置列表(47 条)', { selector: '.sr-desc' }))
  )
})

test('tracker 状态行 · ok:「上次更新 MM-DD HH:mm · N 条」', async () => {
  const ts = new Date(2026, 6, 29, 10, 22).getTime() // 本地时区 07-29 10:22
  const row = await renderWithTracker({
    state: 'ok',
    updatedAt: ts,
    count: 52,
    usingBuiltin: false,
    lastError: null,
    busy: false
  })
  await waitFor(() =>
    assert.ok(within(row).getByText('上次更新 07-29 10:22 · 52 条', { selector: '.sr-desc' }))
  )
})

test('tracker 状态行 · failed(从未成功过):失败原因 + 当前使用内置列表', async () => {
  const row = await renderWithTracker({
    state: 'failed',
    updatedAt: 0,
    count: 47,
    usingBuiltin: true,
    lastError: '网络不可达',
    busy: false
  })
  await waitFor(() =>
    assert.ok(
      within(row).getByText('上次更新失败(网络不可达)· 当前使用内置列表(47 条)', {
        selector: '.sr-desc'
      })
    )
  )
})

test('tracker 状态行 · failed(曾成功过):末句为「当前使用上次拉取的 N 条」', async () => {
  const row = await renderWithTracker({
    state: 'failed',
    updatedAt: new Date(2026, 6, 28, 9, 5).getTime(),
    count: 52,
    usingBuiltin: false,
    lastError: '远端列表条目过少',
    busy: false
  })
  await waitFor(() =>
    assert.ok(
      within(row).getByText('上次更新失败(远端列表条目过少)· 当前使用上次拉取的 52 条', {
        selector: '.sr-desc'
      })
    )
  )
})

test('tracker 状态行 · disabled:「自动更新已关闭 · 当前使用内置列表(47 条)」', async () => {
  const row = await renderWithTracker({
    state: 'disabled',
    updatedAt: 0,
    count: 47,
    usingBuiltin: true,
    lastError: null,
    busy: false
  })
  await waitFor(() =>
    assert.ok(
      within(row).getByText('自动更新已关闭 · 当前使用内置列表(47 条)', { selector: '.sr-desc' })
    )
  )
})

test('入站诊断行 · likely:检测到公网 IPv6 + 「还取决于路由器与系统防火墙」限定(不承诺打通)', async () => {
  setupApi({ getBtInboundDiagnosis: async (): Promise<InboundDiagnosis> => diagnosis('likely') })
  renderPage()
  const note = await screen.findByText(/检测到公网 IPv6 地址/, { selector: '.sr-desc.up-note' })
  assert.match(note.textContent ?? '', /还取决于路由器与系统防火墙是否放行/)
  assert.match(note.textContent ?? '', /只检测,不修改任何网络设置/)
  // 只读诊断行:无标题 / 无控件(结构上与可改项区分,DESIGN §3);
  // sr-icon 位是**空占位**(对齐同卡片其余行的文字左边缘,2026-07-29 手测 C1),**不得放图标内容**
  const row = note.closest('.set-row') as HTMLElement
  const icon = row.querySelector('.sr-icon')
  assert.ok(icon, '诊断行保留 sr-icon 空占位(否则文字比同卡片其余行左移 34px)')
  assert.equal(icon.childNodes.length, 0, 'sr-icon 占位必须为空 —— 只对齐,不放图标')
  assert.equal(icon.textContent, '', 'sr-icon 占位无文本')
  assert.equal(row.querySelector('.sr-title'), null, '诊断行无 sr-title')
  assert.equal(row.querySelector('.sr-control'), null, '诊断行无 sr-control')
})

test('入站诊断行 · unlikely:未检测到公网 IPv6,如实说明上传可能长期为 0', async () => {
  setupApi({ getBtInboundDiagnosis: async (): Promise<InboundDiagnosis> => diagnosis('unlikely') })
  renderPage()
  const note = await screen.findByText(/未检测到公网 IPv6 地址/, { selector: '.sr-desc.up-note' })
  assert.match(note.textContent ?? '', /做种上传速度可能长期为 0/)
  assert.match(note.textContent ?? '', /这由所在网络决定,应用层无法改变/)
})

test('入站诊断行 · unknown:读不到网络接口 → 如实说无法判断(不猜)', async () => {
  setupApi({ getBtInboundDiagnosis: async (): Promise<InboundDiagnosis> => diagnosis('unknown') })
  renderPage()
  assert.ok(
    await screen.findByText('入站可达:未能读取本机网络接口,无法判断。', {
      selector: '.sr-desc.up-note'
    })
  )
})

test('点「立即更新」→ 调 window.api.updateBtTrackersNow,成功也 toast(手动路径成败都反馈)', async () => {
  let called = 0
  setupApi({
    updateBtTrackersNow: async (): Promise<BtTrackerStatus> => {
      called += 1
      return {
        state: 'ok',
        updatedAt: new Date(2026, 6, 29, 10, 22).getTime(),
        count: 52,
        usingBuiltin: false,
        lastError: null,
        busy: false
      }
    }
  })
  renderPage()
  fireEvent.click(await screen.findByText('立即更新'))
  await waitFor(() => assert.equal(called, 1, '「立即更新」经 IPC 触发主进程手动路径'))
  assert.ok(await screen.findByText(/tracker 列表已更新 · 52 条/, { selector: '.toast' }))
})

test('「立即更新」失败 → 同样 toast(如实报原因,不静默)', async () => {
  setupApi({
    updateBtTrackersNow: async (): Promise<BtTrackerStatus> => ({
      state: 'failed',
      updatedAt: 0,
      count: 47,
      usingBuiltin: true,
      lastError: '网络不可达',
      busy: false
    })
  })
  renderPage()
  fireEvent.click(await screen.findByText('立即更新'))
  const toast = await screen.findByText(/tracker 列表更新失败/, { selector: '.toast' })
  assert.match(toast.textContent ?? '', /网络不可达/, 'toast 如实带出失败原因')
})

test('拉取中(busy)→ 按钮文案「更新中…」且 disabled', async () => {
  setupApi({
    getBtTrackerStatus: async (): Promise<BtTrackerStatus> => ({ ...TRACKER_NEVER, busy: true })
  })
  renderPage()
  const btn = (await screen.findByText('更新中…')) as HTMLButtonElement
  await waitFor(() => assert.equal(btn.disabled, true, 'busy 时「立即更新」禁用'))
  assert.equal(screen.queryByText('立即更新'), null)
})

test('自动更新 tracker 开关:默认开;点击 → setSettings({btAutoUpdateTrackers:false})', async () => {
  const caps = setupApi()
  renderPage()
  const sw = await screen.findByLabelText('自动更新 tracker 列表')
  assert.equal(sw.getAttribute('aria-checked'), 'true', 'btAutoUpdateTrackers 默认开')
  // 描述逐句诚实:只说拉取地址表 + 失败退内置,不说会更快 / 连上更多节点
  assert.ok(
    screen.getByText(
      '添加 BT 任务时,若距上次更新超过 12 小时,从公开列表拉取最新的 tracker 地址。拉取失败会继续使用内置列表。'
    )
  )
  fireEvent.click(sw)
  await waitFor(() =>
    assert.deepEqual(caps.settingsPatches.at(-1), { btAutoUpdateTrackers: false })
  )
})

test('BT 三行文案诚实:无「提速 / 加速 / 保证 / 更多节点 / 一定能」等越界承诺,且不在 BT 组提代理', async () => {
  setupApi({ getBtInboundDiagnosis: async (): Promise<InboundDiagnosis> => diagnosis('likely') })
  renderPage()
  await screen.findByText('tracker 列表', { selector: '.sr-title' })
  const btGroup = screen
    .getByText('BT · 磁力', { selector: '.sg-title' })
    .closest('.set-group') as HTMLElement
  const text = btGroup.textContent ?? ''
  for (const forbidden of [
    '提速',
    '加速',
    '保证',
    '更多节点',
    '上传更快',
    '一定能',
    'P2SP',
    '代理'
  ]) {
    assert.equal(text.includes(forbidden), false, `BT 分组不得出现「${forbidden}」`)
  }
})

// ==================== v0.4 Task 6 Phase 4:Cookie 第四档「从扩展获取」 ====================
// ⚠️ 三条 cookie IPC 一律经 `setupApi` 的 `over` 参数注入 —— **`setupApi` 本体与既有用例
//    逐字节未改**,「既有三档渲染零回归」这条判据才不是自证。
// ⚠️ 下面这条 `import type` 刻意放在文件末尾:只为让本节零改动地追加(本仓 eslint 未启用
//    `import/first`)。`import type` 编译后消失,零运行时。
import type { BorrowedCookieHosts } from '../../../shared/ipc'

/** 第四档所需的三条 IPC 桩;`hosts` 为初始快照,返回捕获盒供断言 */
function cookieStubs(hosts: string[] = []): {
  over: Partial<DownLordApi>
  calls: string[]
  push: (next: string[]) => void
} {
  const calls: string[] = []
  let listener: ((s: BorrowedCookieHosts) => void) | null = null
  const over = {
    getBorrowedCookieHosts: async (): Promise<BorrowedCookieHosts> => {
      calls.push('get')
      return { hosts }
    },
    clearBorrowedCookies: async (): Promise<BorrowedCookieHosts> => {
      calls.push('clear')
      return { hosts: [] }
    },
    onBorrowedCookiesChanged: (cb: (s: BorrowedCookieHosts) => void): (() => void) => {
      calls.push('subscribe')
      listener = cb
      return () => {
        calls.push('unsubscribe')
      }
    }
  } as Partial<DownLordApi>
  return {
    over,
    calls,
    push: (next) => act(() => listener?.({ hosts: next }))
  }
}

/** 已确认过首次说明 + 已选第四档的设置(可见行的常态) */
const SETTINGS_EXT: AppSettings = {
  ...SETTINGS,
  video: {
    defaultHeight: null,
    defaultAudioOnly: false,
    cookie: { source: 'extension', browser: null, profile: null, file: null }
  },
  cookieExtensionNoticeAcked: true
}

test('★ 第四档上架下拉,且顺序为 none → browser → extension → file(高级)', async () => {
  setupApi()
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  assert.deepStrictEqual(
    Array.from(sel.options).map((o) => o.value),
    ['none', 'browser', 'extension', 'file'],
    '档位顺序:第四档排在「从 Cookie 文件(高级)」之前'
  )
  assert.deepStrictEqual(
    Array.from(sel.options).map((o) => o.textContent),
    ['不使用', '从浏览器', '从扩展获取', '从 Cookie 文件(高级)']
  )
})

test('★ 主说明如实交代两档区别,且带「不保证可下载受限内容」(v1.0 Task 3 按 `M-003` 去掉「运行中时」这个时机限定)', async () => {
  setupApi()
  renderPage()
  await screen.findByLabelText('Cookie 来源')
  assert.ok(
    screen.getByText(
      '使用你浏览器中已登录的 Cookie 帮助 yt-dlp 访问需登录的内容,不保证可下载受限内容。「从浏览器」由 yt-dlp 直接读取浏览器的 Cookie 数据库;Chrome / Edge 的新版加密方式使 DownLord 无论浏览器是否运行都读不到(实测 Chrome 152 / Edge 152),Firefox 可以读到(实测 Firefox 154,运行中亦可)。「从扩展获取」则由 DownLord 浏览器扩展在你点击下载时按需提供登录态,不受此限制。'
    )
  )
})

test('★ 首次切到第四档:先弹说明(五条),确认前一个补丁都不发', async () => {
  const { over, calls } = cookieStubs()
  const caps = setupApi(over)
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'extension' } })

  await screen.findByText('从扩展获取 Cookie')
  // 五条逐字(第 4 条是 D7 ② 定死的「取消不清除」)
  assert.ok(
    screen.getByText(
      '你在扩展里点击下载时,DownLord 会点名向扩展请求该站点的 Cookie;未被点名的站点,Cookie 从不离开浏览器。'
    )
  )
  assert.ok(
    screen.getByText(
      '取到的登录态只存在于内存,不写配置文件、不写数据库、不写日志;关闭 DownLord 即消失。'
    )
  )
  assert.ok(
    screen.getByText('每次调用 yt-dlp 会在应用数据目录写一个临时文件供其读取,进程结束即删。')
  )
  assert.ok(
    screen.getByText('取消某个下载不会清除已暂借的登录态——需要时在本页「当前暂借」一行清除。')
  )
  assert.ok(screen.getByText('DownLord 不保证可下载受限内容。'))
  // ★ 确认前**不落档**:零补丁,可见行也不该出现(IPC 一条没发)
  assert.deepStrictEqual(caps.settingsPatches, [])
  assert.deepStrictEqual(calls, [])
})

test('★ 点「我知道了」才落档:档位与已确认标记同一个补丁一起发', async () => {
  const { over } = cookieStubs()
  const caps = setupApi(over)
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'extension' } })
  await screen.findByText('从扩展获取 Cookie')
  fireEvent.click(screen.getByText('我知道了'))

  await waitFor(() => assert.equal(caps.settingsPatches.length, 1))
  assert.deepStrictEqual(caps.settingsPatches[0], {
    video: { cookie: { source: 'extension', browser: null, profile: null, file: null } },
    cookieExtensionNoticeAcked: true
  })
  await waitFor(() => assert.equal(screen.queryByText('从扩展获取 Cookie'), null))
})

test('★ 说明框点「取消」:不落档、不写已确认标记(再切还会弹)', async () => {
  const { over } = cookieStubs()
  const caps = setupApi(over)
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'extension' } })
  const dialog = await screen.findByText('从扩展获取 Cookie')
  const foot = dialog.closest('.dialog')?.querySelector('.dialog-foot') as HTMLElement
  fireEvent.click(within(foot).getByText('取消'))

  await waitFor(() => assert.equal(screen.queryByText('从扩展获取 Cookie'), null))
  assert.deepStrictEqual(caps.settingsPatches, [])
  // 再切一次仍弹(标记没落)
  fireEvent.change(sel, { target: { value: 'extension' } })
  await screen.findByText('从扩展获取 Cookie')
})

test('★ 已确认过 → 再切到第四档不再弹说明,直接落档', async () => {
  const { over } = cookieStubs()
  const caps = setupApi(over, { ...SETTINGS, cookieExtensionNoticeAcked: true })
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'extension' } })

  await waitFor(() => assert.equal(caps.settingsPatches.length, 1))
  assert.deepStrictEqual(caps.settingsPatches[0], {
    video: { cookie: { source: 'extension', browser: null, profile: null, file: null } }
  })
  assert.equal(screen.queryByText('从扩展获取 Cookie'), null)
})

test('★ 可见行(有暂借):列出域名 + 「清除」按钮,与第四档同屏', async () => {
  const { over } = cookieStubs(['bilibili.com', 'youtube.com'])
  setupApi(over, SETTINGS_EXT)
  renderPage()
  await screen.findByText('当前暂借:bilibili.com、youtube.com')
  // D7 ①:必须与档位同屏 —— 两者在同一个「视频」组里
  const videoGroup = groupTitle('视频').closest('.set-group') as HTMLElement
  assert.ok(within(videoGroup).getByLabelText('Cookie 来源'))
  assert.ok(within(videoGroup).getByText('当前暂借:bilibili.com、youtube.com'))
  assert.ok(within(videoGroup).getByText('清除'))
})

test('★ 可见行(无暂借):不隐藏,如实说「当前未暂借任何站点的登录态」', async () => {
  const { over } = cookieStubs([])
  setupApi(over, SETTINGS_EXT)
  renderPage()
  await screen.findByText('当前未暂借任何站点的登录态')
  // 没东西可清 → 不给按钮;但整行仍在(隐藏整行会让用户以为功能坏了)
  assert.equal(screen.queryByText('清除'), null)
  assert.ok(screen.getByText('暂借登录态', { selector: '.sr-title' }))
})

test('★ 「清除」调 cookie:clearBorrowed,并就地更新为未暂借态', async () => {
  const { over, calls } = cookieStubs(['bilibili.com'])
  setupApi(over, SETTINGS_EXT)
  renderPage()
  await screen.findByText('当前暂借:bilibili.com')
  fireEvent.click(screen.getByText('清除'))

  await screen.findByText('当前未暂借任何站点的登录态')
  assert.ok(calls.includes('clear'), '点了清除必须发 cookie:clearBorrowed')
  // 回写后快照恒 {hosts:[]} → 就地更新,不再回读一次
  assert.equal(calls.filter((c) => c === 'get').length, 1)
})

test('★ borrowedChanged 推送:设置页开着时可见行当场更新', async () => {
  const { over, push } = cookieStubs([])
  setupApi(over, SETTINGS_EXT)
  renderPage()
  await screen.findByText('当前未暂借任何站点的登录态')
  push(['bilibili.com'])
  await screen.findByText('当前暂借:bilibili.com')
})

test('★ 既有三档零回归:none / browser / file 下可见行与三条 cookie IPC 一律不出现', async () => {
  const { over, calls } = cookieStubs(['bilibili.com'])
  const caps = setupApi(over)
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement

  // 初始 none
  assert.equal(screen.queryByText('暂借登录态'), null)
  fireEvent.change(sel, { target: { value: 'browser' } })
  await waitFor(() => assert.equal(caps.settingsPatches.length, 1))
  await screen.findByLabelText('Cookie 浏览器')
  assert.equal(screen.queryByText('暂借登录态'), null)

  fireEvent.change(sel, { target: { value: 'file' } })
  await waitFor(() => assert.equal(caps.settingsPatches.length, 2))
  assert.equal(screen.queryByText('暂借登录态'), null)
  // ★ 前三档一条 cookie IPC 都没发(可见行根本没挂载)
  assert.deepStrictEqual(calls, [])
})

test('★ A-5 措辞:视频组不出现任何「承诺可下受限内容」式表述', async () => {
  const { over } = cookieStubs(['bilibili.com'])
  setupApi(over, SETTINGS_EXT)
  renderPage()
  await screen.findByText('当前暂借:bilibili.com')
  const text = (groupTitle('视频').closest('.set-group') as HTMLElement).textContent ?? ''
  for (const forbidden of ['破解', '绕过会员', '翻墙', '一定能下']) {
    assert.equal(text.includes(forbidden), false, `视频组不得出现「${forbidden}」`)
  }
  // 正向对照:诚实的否定式**必须在**(否则这条断言在一个空字符串上也会「通过」)
  assert.ok(text.includes('不保证可下载受限内容'), '诚实文案必须在场')
})

// ==================== v1.0 Task 3 · P2「UI 文案」新增用例 ====================
// 逐字文案真源 = spec §4「如实说清单」;本段全部为**新增**,不改任何既有断言。

test('M-001 关于页不含已被推翻的签名承诺', async () => {
  setupApi()
  renderPage()
  const about = (await screen.findByText(/未知发布者/)).closest('.set-group') as HTMLElement
  const text = about.textContent ?? ''
  // 否定断言:任何「计划在 v…」式的会过期承诺都不得出现
  assert.equal(text.includes('计划在 v'), false, '关于页不得含已被推翻的版本承诺')
  // 正向对照:诚实的 SmartScreen 引导**必须在场**(否则上一条在空字符串上也会「通过」)
  assert.ok(text.includes('未知发布者'), '未签名引导必须在场')
  assert.ok(text.includes('不承诺何时签名'), '改后的如实措辞必须在场')
})

test('M-003 说明句不含「运行中时」这个时机限定', async () => {
  setupApi()
  renderPage()
  await screen.findByLabelText('Cookie 来源')
  const video = (groupTitle('视频').closest('.set-group') as HTMLElement).textContent ?? ''
  // 原文把用户导向一个在两家 Chromium 上实测全部无效的动作(关掉浏览器再试)
  assert.equal(/运行中时[^。]*读取/.test(video), false)
  assert.equal(video.includes('读取时请关闭该浏览器'), false, 'N01–N06 实测:关掉也读不到')
  // 正向对照:确定句与诚实否定式都必须在场
  assert.ok(video.includes('无论浏览器是否运行都读不到'))
  assert.ok(video.includes('不保证可下载受限内容'))
})

test('M-003 七档分两组且逐项带证据级标注', async () => {
  setupApi()
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'browser' } })
  const bsel = (await screen.findByLabelText('Cookie 浏览器')) as HTMLSelectElement

  // ① 七项一个不少 —— 读不到是上游能力边界,不是我们该替用户砍掉的选项
  assert.deepStrictEqual(
    Array.from(bsel.options).map((o) => o.value),
    ['firefox', 'chrome', 'edge', 'brave', 'chromium', 'opera', 'vivaldi']
  )
  // ② 恰好两个 optgroup,Firefox 独占「通常可用」
  const groups = Array.from(bsel.querySelectorAll('optgroup'))
  assert.equal(groups.length, 2)
  assert.deepStrictEqual(
    groups.map((g) => g.getAttribute('label')),
    ['通常可用', '新版通常读不到']
  )
  assert.deepStrictEqual(
    Array.from(groups[0].querySelectorAll('option')).map((o) => o.value),
    ['firefox']
  )
  assert.equal(groups[1].querySelectorAll('option').length, 6)
  // ③ 逐项行内标注:「实测读不到」与「未实测」是两档证据,不得混为一谈
  const label = (v: string): string =>
    Array.from(bsel.options).find((o) => o.value === v)?.textContent ?? ''
  assert.equal(label('firefox'), 'Firefox')
  for (const v of ['chrome', 'edge']) {
    assert.ok(label(v).includes('实测读不到'), `${v} 应标实测结论`)
  }
  for (const v of ['brave', 'chromium', 'opera', 'vivaldi']) {
    assert.ok(label(v).includes('未实测'), `${v} 本版未实测,不得写成实测结论`)
    assert.ok(label(v).includes('预计同样受限'), `${v} 需给出推论依据`)
  }
  // ④ 不写数字:D7 说「5 个」、名单推出「6 个」—— 两个都不成立,写死任一个都是不诚实
  const video = (groupTitle('视频').closest('.set-group') as HTMLElement).textContent ?? ''
  assert.equal(/[56]\s*个浏览器/.test(video), false)
  // ⑤ 去处指向第四档(展开小字不只说成因,还得给出路)
  assert.ok(video.includes('从扩展获取'))
  assert.ok(video.includes('App-Bound Encryption'))
})

test('M-005 默认目录旁说明不回迁', async () => {
  setupApi()
  renderPage()
  const row = (await screen.findByText('默认保存位置')).closest('.set-row') as HTMLElement
  assert.ok(
    within(row).getByText(
      '改默认目录只对之后的任务生效:已下载的文件留在原地不搬,历史里记的仍是原路径。'
    )
  )
})

test('M-012-b 默认目录旁说明「其他」类去向', async () => {
  setupApi()
  renderPage()
  const row = (await screen.findByText('默认保存位置')).closest('.set-row') as HTMLElement
  assert.ok(
    within(row).getByText(
      '未匹配任何类别的文件(「其他」)保存在默认目录,故它不单列在「分类与保存位置」里。'
    )
  )
})

test('M-015 选到非 Netscape 文件当场报错(且判定不在渲染层)', async () => {
  // 桩 = 主进程 SettingsService 的新语义:非 Netscape 格式的 cookie 文件**不落盘**,
  // 回包里 video.cookie.file 仍为 null。渲染层只比「我要的路径 ≠ 回包里的路径」。
  const base: AppSettings = {
    ...SETTINGS,
    video: {
      ...SETTINGS.video,
      cookie: { source: 'file', browser: null, profile: null, file: null }
    }
  }
  const patches: AppSettingsPatch[] = []
  setupApi(
    {
      selectFile: async () => 'D:/pics/cat.jpg',
      setSettings: async (patch: AppSettingsPatch): Promise<AppSettings> => {
        patches.push(patch)
        return base // 主进程拒收 ⇒ file 仍是 null
      }
    },
    base
  )
  renderPage()
  fireEvent.click(await screen.findByText(/选择 Cookie 文件/))
  assert.ok(await screen.findByText('Cookie 文件无效或不存在（需 Netscape cookies.txt 格式）'))
  // 正向对照:渲染层**照样把路径交给了主进程**(没自己拦下来判扩展名)
  assert.deepStrictEqual(patches.at(-1), {
    video: { cookie: { source: 'file', browser: null, profile: null, file: 'D:/pics/cat.jpg' } }
  })
})

test('M-015 主进程收下了 ⇒ 不报错(上一条的反向对照)', async () => {
  setupApi({ selectFile: async () => 'D:/exports/cookies.txt' })
  renderPage()
  const sel = (await screen.findByLabelText('Cookie 来源')) as HTMLSelectElement
  fireEvent.change(sel, { target: { value: 'file' } })
  fireEvent.click(await screen.findByText(/选择 Cookie 文件/))
  await screen.findByText(/cookies\.txt/)
  assert.equal(screen.queryByText(/Cookie 文件无效或不存在/), null)
})
