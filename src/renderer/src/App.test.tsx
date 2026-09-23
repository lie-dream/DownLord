/// <reference types="node" />

import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FluentProvider } from '@fluentui/react-components'

import type {
  DownLordApi,
  BatchPick,
  ClipboardLink,
  DuplicateConflict,
  DuplicateResolution,
  ProxyStatus,
  ResolvedPlaylist,
  ResolvedVideo,
  Task,
  ThemeMode
} from '../../shared/ipc'
import App from './App'
import { lightTheme } from './theme/fluentTheme'
import { ThemeProvider } from './state/ThemeContext'
import { TasksProvider } from './state/TasksContext'
import { ToastProvider } from './state/ToastContext'

afterEach(() => {
  cleanup()
})

function mockApi(overrides: Partial<DownLordApi> = {}): DownLordApi {
  return {
    getVersion: async () => '0.1.0-test',
    openThirdPartyNotices: async () => '',
    getDownloadDir: async () => 'D:/Downloads',
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    setTheme: async () => 'light',
    onThemeChanged: () => () => {},
    selectDirectory: async () => null,
    selectFile: async () => null,
    openPath: async () => '',
    showItemInFolder: async () => '',
    addTask: async () => 'mock-id',
    pauseTask: async () => {},
    resumeTask: async () => {},
    removeTask: async () => {},
    retryTask: async () => {},
    setTaskLimit: async () => {},
    listTasks: async () => [],
    onTaskProgress: () => () => {},
    onTaskAdded: () => () => {},
    onTaskDuplicate: () => () => {},
    resolveDuplicate: async () => {},
    getResolved: async () => null,
    selectFormat: async () => {},
    submitBatch: async () => {},
    applyTorrentSelection: async () => {},
    stopSeeding: async () => {},
    listCategories: async () => [],
    updateCategory: async () => {},
    getProxyConfig: async () => ({ mode: 'system', manualUrl: null }),
    setProxyConfig: async () => ({
      mode: 'system',
      label: '跟随系统(系统未设代理 · 直连)',
      dot: 'off',
      effectiveUrl: null
    }),
    getProxyStatus: async () => ({
      mode: 'system',
      label: '跟随系统(系统未设代理 · 直连)',
      dot: 'off',
      effectiveUrl: null
    }),
    onProxyStatusChanged: () => () => {},
    onClipboardLink: () => () => {},
    getSettings: async () => ({
      defaultDir: '',
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
    }),
    setSettings: async () => ({
      defaultDir: '',
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
    }),
    getEngineVersions: async () => ({ aria2: '0.0.0', ytdlp: '0.0.0', ffmpeg: '0.0.0' }),
    searchHistory: async () => [],
    getHistoryStats: async () => ({
      total: { count: 0, totalBytes: 0 },
      today: { count: 0, totalBytes: 0 },
      week: { count: 0, totalBytes: 0 },
      month: { count: 0, totalBytes: 0 },
      byCategory: []
    }),
    checkYtDlpUpdate: async () => ({
      target: 'ytdlp',
      currentVersion: '2024.01.01',
      latestVersion: '2024.01.01',
      hasUpdate: false
    }),
    runYtDlpUpdate: async () => {},
    checkAppUpdate: async () => ({
      target: 'app',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      hasUpdate: false
    }),
    downloadAppUpdate: async () => {},
    quitAndInstallApp: async () => {},
    onUpdateStatus: () => () => {},
    // v0.4 Task 1 BT tracker / 入站自检(App 层不消费,设置页三行接线留 Step 5;此处仅满足 DownLordApi 契约)
    getBtTrackerStatus: async () => ({
      state: 'never' as const,
      updatedAt: 0,
      count: 47,
      usingBuiltin: true,
      lastError: null,
      busy: false
    }),
    updateBtTrackersNow: async () => ({
      state: 'never' as const,
      updatedAt: 0,
      count: 47,
      usingBuiltin: true,
      lastError: null,
      busy: false
    }),
    getBtInboundDiagnosis: async () => ({
      state: 'unknown' as const,
      factors: [],
      checkedAt: 0
    }),
    onBtTrackerStatusChanged: () => () => {},
    onBtInboundChanged: () => () => {},
    // v0.4 Task 3 本地通道(App 层不消费,设置页「浏览器扩展」分组接线留 Step 5;此处仅满足 DownLordApi 契约)
    getExtensionChannelConfig: async () => ({ enabled: false, port: 52330, token: 'a'.repeat(64) }),
    setExtensionChannelConfig: async () => ({
      enabled: false,
      service: 'stopped' as const,
      port: 52330,
      lastError: null,
      link: 'unpaired' as const,
      lastHandshakeAt: null
    }),
    regenerateExtensionToken: async () => ({
      enabled: false,
      port: 52330,
      token: 'b'.repeat(64)
    }),
    getExtensionChannelStatus: async () => ({
      enabled: false,
      service: 'stopped' as const,
      port: 52330,
      lastError: null,
      link: 'unpaired' as const,
      lastHandshakeAt: null
    }),
    getExtensionSideloadInfo: async () => ({ dir: 'D:/DownLord/extension/dist', exists: false }),
    onExtensionChannelStatusChanged: () => () => {},
    // v0.4 Task 4 Step 6a 接管配置四条(默认桩:接管开着、没暂停、无例外)
    getTakeoverConfig: async () => ({
      enabled: true,
      pausedUntil: null,
      paused: false,
      excludedDomains: []
    }),
    setTakeoverConfig: async () => ({
      enabled: true,
      pausedUntil: null,
      paused: false,
      excludedDomains: []
    }),
    setTakeoverPause: async () => ({
      enabled: true,
      pausedUntil: null,
      paused: false,
      excludedDomains: []
    }),
    onTakeoverConfigChanged: () => () => {},
    // v0.4 Task 6:暂借登录态三条。**载荷只有 host 列表** —— 连 fake 里都没有能装 cookie 值的位置。
    getBorrowedCookieHosts: async () => ({ hosts: [] }),
    clearBorrowedCookies: async () => ({ hosts: [] }),
    onBorrowedCookiesChanged: () => () => {},
    ...overrides
  }
}

function renderApp(api: DownLordApi): void {
  Object.defineProperty(window, 'api', {
    value: api,
    configurable: true
  })

  render(
    <ToastProvider>
      <ThemeProvider>
        {() => (
          <FluentProvider theme={lightTheme}>
            <TasksProvider>
              <App />
            </TasksProvider>
          </FluentProvider>
        )}
      </ThemeProvider>
    </ToastProvider>
  )
}

const mkTask = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  kind: 'http',
  source: 'x',
  status: 'downloading',
  filename: 'movie.mp4',
  savePath: 'C:/movie.mp4',
  category: null,
  totalBytes: 200,
  downloadedBytes: 100,
  speed: 1024,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  ...over
})

test('空 listTasks 渲染空态', async () => {
  renderApp(mockApi())
  assert.ok(await screen.findByText('还没有下载任务'))
})

test('listTasks 返回的任务渲染到列表', async () => {
  renderApp(mockApi({ listTasks: async () => [mkTask({})] }))
  assert.ok(await screen.findByText('movie.mp4'))
})

test('集成冒烟:三态任务渲染 + 左导航过滤', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({ id: 'a', filename: 'dl.bin', status: 'downloading', createdAt: 3 }),
        mkTask({ id: 'b', filename: 'done.zip', status: 'completed', createdAt: 2 }),
        mkTask({
          id: 'c',
          filename: 'broken.iso',
          status: 'error',
          error: '连接超时',
          createdAt: 1
        })
      ]
    })
  )

  // 「全部」:三态任务全部渲染
  assert.ok(await screen.findByText('dl.bin'))
  assert.ok(screen.getByText('done.zip'))
  assert.ok(screen.getByText('broken.iso'))

  // 切「下载中」→ 仅 downloading
  fireEvent.click(screen.getByText('下载中'))
  assert.ok(screen.getByText('dl.bin'))
  assert.equal(screen.queryByText('done.zip'), null)
  assert.equal(screen.queryByText('broken.iso'), null)

  // 切「已完成」→ 仅 completed
  fireEvent.click(screen.getByText('已完成'))
  assert.ok(screen.getByText('done.zip'))
  assert.equal(screen.queryByText('dl.bin'), null)

  // 切「失败」→ 仅 error,并展示可读原因
  fireEvent.click(screen.getByText('失败'))
  assert.ok(screen.getByText('broken.iso'))
  assert.ok(screen.getByText(/连接超时/))
  assert.equal(screen.queryByText('done.zip'), null)
})

test('点添加任务打开对话框', async () => {
  renderApp(mockApi())
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  assert.ok(screen.getByText('添加下载'))
})

test('本会话添加的单视频解析进入 awaiting → 自动弹格式对话框', async () => {
  const mockVideo: ResolvedVideo = {
    kind: 'video',
    id: 'v1',
    title: 'Mock 视频标题',
    durationSec: 215,
    thumbnail: null,
    extractor: 'youtube',
    webpageUrl: 'u',
    formats: [
      {
        formatId: '22',
        ext: 'mp4',
        height: 720,
        fps: 30,
        vcodec: 'avc1',
        acodec: 'mp4a',
        filesize: 100,
        tbr: 1000,
        formatNote: '720p'
      }
    ],
    subtitles: []
  }
  let selected: { id: string; choice: unknown } | null = null
  let added = false
  renderApp(
    mockApi({
      addTask: async () => {
        added = true
        return 'v1'
      },
      listTasks: async () =>
        added
          ? [mkTask({ id: 'v1', kind: 'video', status: 'awaiting_selection', filename: 'mock' })]
          : [],
      getResolved: async () => mockVideo,
      selectFormat: async (id, choice) => {
        selected = { id, choice }
      }
    })
  )

  // 用户主动添加单行视频链接(默认识别为视频)→ 解析进入 awaiting
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  fireEvent.click(screen.getByText('添加'))

  // 自动弹出格式对话框
  assert.ok(await screen.findByText('选择清晰度与格式'))
  assert.ok(screen.getByText('Mock 视频标题'))
  // 开始下载 → selectFormat 收到默认选中格式
  fireEvent.click(screen.getByText('开始下载'))
  await waitFor(() =>
    assert.deepEqual(selected, { id: 'v1', choice: { audioOnly: false, formatId: '22' } })
  )
})

test('本会话添加的 playlist 解析进入 awaiting → 自动弹批量对话框 → 下载选中提交 submitBatch', async () => {
  const mockPlaylist: ResolvedPlaylist = {
    kind: 'playlist',
    title: 'Mock 合集',
    entries: [
      { id: 'a', title: '合集第一集', url: 'https://x/a', durationSec: 60 },
      { id: 'b', title: '合集第二集', url: 'https://x/b', durationSec: 70 }
    ]
  }
  let submitted: { parentId: string; picks: BatchPick[] } | null = null
  let added = false
  renderApp(
    mockApi({
      addTask: async () => {
        added = true
        return 'pl1'
      },
      listTasks: async () =>
        added
          ? [
              mkTask({
                id: 'pl1',
                kind: 'video',
                status: 'awaiting_selection',
                filename: 'mock-pl'
              })
            ]
          : [],
      getResolved: async () => mockPlaylist,
      submitBatch: async (parentId, picks) => {
        submitted = { parentId, picks }
      }
    })
  )

  // 用户主动添加播放列表链接 → 解析进入 awaiting
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/playlist?list=abc' }
  })
  fireEvent.click(screen.getByText('添加'))

  // 自动弹批量对话框(非格式对话框)
  assert.ok(await screen.findByRole('heading', { name: /批量下载/ }))
  assert.ok(screen.getByText(/Mock 合集/))
  assert.ok(screen.getByText('合集第一集'))
  assert.equal(screen.queryByText('选择清晰度与格式'), null, 'playlist 不弹单视频格式对话框')

  // 默认全选 + 最高策略 → 下载选中 → submitBatch 收到归一 picks(各带统一 choice)
  fireEvent.click(screen.getByText(/下载选中/))
  await waitFor(() =>
    assert.deepEqual(submitted, {
      parentId: 'pl1',
      picks: [
        { entryIndex: 0, choice: { audioOnly: false } },
        { entryIndex: 1, choice: { audioOnly: false } }
      ]
    })
  )
})

// v0.3 Task 1 — BT 添加接线:单行 magnet → addTorrent → window.api.addTask({kind:'torrent'})
test('单行 magnet 提交 → window.api.addTask({kind:torrent}) 端到端接线', async () => {
  const added: unknown[] = []
  renderApp(
    mockApi({
      getSettings: async () => ({
        defaultDir: 'D:/DL',
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
      }),
      addTask: async (input) => {
        added.push(input)
        return 'bt1'
      }
    })
  )
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  // 等对话框预填最新 defaultDir(openAdd 内 getSettings)
  await screen.findByDisplayValue('D:/DL')
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:e2e&dn=Show' }
  })
  // 磁力识别卡出现(App 已接 onSubmitTorrent → addTorrent)
  assert.ok(screen.getByText('识别为磁力链接'))
  fireEvent.click(screen.getByText('添加'))
  await waitFor(() =>
    assert.deepEqual(added.at(-1), {
      kind: 'torrent',
      source: 'magnet:?xt=urn:btih:e2e&dn=Show',
      dir: 'D:/DL'
    })
  )
})

test('torrent 任务 resolving → 任务行显「正在获取种子元数据…」(与 video 解析区分)', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({ id: 'bt-r', kind: 'torrent', status: 'resolving', filename: '获取元数据中' })
      ]
    })
  )
  assert.ok(await screen.findByText('正在获取种子元数据…'))
})

// v0.3 Task 2 — BT 文件选择端到端:本会话添加多文件磁力 → 待选自动弹 BtFileDialog → 选部分 → applyTorrentSelection(1-based)
const BT_META = {
  name: 'Show.S01',
  infoHash: 'h1',
  files: [
    { path: 'a.mkv', length: 1000, selected: true },
    { path: 'b.srt', length: 200, selected: true },
    { path: 'c.mkv', length: 3000, selected: true }
  ]
}
const BT_SETTINGS = {
  defaultDir: 'D:/DL',
  maxConcurrent: 3,
  maxOverallLimitKBps: 0,
  useAria2cForVideo: true,
  video: { defaultHeight: null, defaultAudioOnly: false },
  themeMode: 'system' as const,
  clipboardWatch: false,
  autoUpdateYtDlp: true,
  autoUpdateApp: true,
  btSeedEnabled: false,
  btSeedRatio: 1.0,
  btSeedTimeMin: 60,
  btMaxPeers: 0,
  btAutoUpdateTrackers: true
}

test('本会话多文件磁力解析进入 awaiting → 自动弹 BtFileDialog → 选部分 → applyTorrentSelection([1,3])', async () => {
  let added = false
  let applied: { id: string; idx: number[] } | null = null
  renderApp(
    mockApi({
      getSettings: async () => BT_SETTINGS,
      addTask: async () => {
        added = true
        return 'bt1'
      },
      listTasks: async () =>
        added
          ? [
              mkTask({
                id: 'bt1',
                kind: 'torrent',
                status: 'awaiting_selection',
                filename: 'Show.S01',
                torrentMeta: BT_META
              })
            ]
          : [],
      applyTorrentSelection: async (id, idx) => {
        applied = { id, idx }
      }
    })
  )
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  await screen.findByDisplayValue('D:/DL')
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:multi&dn=Show' }
  })
  assert.ok(screen.getByText('识别为磁力链接'))
  fireEvent.click(screen.getByText('添加'))

  // 多文件种子待选 → 自动弹 BtFileDialog(非格式 / 批量对话框)
  assert.ok(await screen.findByText('选择要下载的文件'))
  assert.ok(screen.getByText('Show.S01', { selector: '.bt-name' }), '对话框头部显示种子名')
  assert.equal(screen.queryByText('选择清晰度与格式'), null, 'torrent 不弹视频格式对话框')
  // 取消 b.srt(原 aria2 idx2)→ 剩 a.mkv(idx1)+ c.mkv(idx3)
  fireEvent.click(screen.getByText('b.srt'))
  fireEvent.click(screen.getByText('开始下载'))
  await waitFor(() => assert.deepEqual(applied, { id: 'bt1', idx: [1, 3] }))
})

test('torrent 经进度帧转 awaiting_selection(帧不带 torrentMeta)→ 触发全量重拉 → BtFileDialog 才弹出(回归:meta 不在 TaskProgress)', async () => {
  let metaReady = false
  let push: ((p: import('../../shared/ipc').TaskProgress) => void) | undefined
  renderApp(
    mockApi({
      getSettings: async () => BT_SETTINGS,
      addTask: async () => 'bt2',
      // 进度帧不带 torrentMeta;元数据就绪后 listTasks 才带 meta(模拟主进程 onTorrentInfo 落 torrentMeta)
      listTasks: async () =>
        metaReady
          ? [
              mkTask({
                id: 'bt2',
                kind: 'torrent',
                status: 'awaiting_selection',
                filename: 'Show.S01',
                torrentMeta: BT_META
              })
            ]
          : [
              mkTask({
                id: 'bt2',
                kind: 'torrent',
                status: 'resolving',
                filename: 'Show.S01',
                torrentMeta: null
              })
            ],
      onTaskProgress: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  await screen.findByDisplayValue('D:/DL')
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:frame&dn=Show' }
  })
  fireEvent.click(screen.getByText('添加'))
  // resolving 态(帧未到,meta 未就绪):对话框不弹
  await screen.findByText('正在获取种子元数据…')
  assert.equal(screen.queryByText('选择要下载的文件'), null)
  // 元数据就绪 + 推 awaiting_selection 进度帧(不带 meta)→ flush 触发 refresh 拿回 torrentMeta → 弹窗
  metaReady = true
  act(() =>
    push?.({
      id: 'bt2',
      status: 'awaiting_selection',
      downloadedBytes: 0,
      totalBytes: 100,
      speed: 0
    })
  )
  assert.ok(await screen.findByText('选择要下载的文件'), 'awaiting 帧触发重拉后 BtFileDialog 弹出')
  assert.ok(screen.getByText('Show.S01', { selector: '.bt-name' }))
})

test('重启恢复的 torrent awaiting(非本会话添加)→ 不自动弹 BtFileDialog;点行内「选择文件」才弹', async () => {
  renderApp(
    mockApi({
      getSettings: async () => BT_SETTINGS,
      listTasks: async () => [
        mkTask({
          id: 'rt1',
          kind: 'torrent',
          status: 'awaiting_selection',
          filename: 'restored-bt',
          torrentMeta: BT_META
        })
      ]
    })
  )
  await screen.findByText('restored-bt')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(screen.queryByText('选择要下载的文件'), null, '恢复的种子待选不自动弹')
  // 用户主动点行内「选择文件」→ 打开 BtFileDialog
  fireEvent.click(screen.getByText('选择文件'))
  assert.ok(await screen.findByText('选择要下载的文件'))
})

test('重启恢复的 awaiting 任务(非本会话添加)→ 不自动弹,等用户主动选择(修复①)', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'r1',
          kind: 'video',
          status: 'awaiting_selection',
          filename: 'restored',
          videoMeta: {
            title: '恢复视频',
            selectedFormat: '',
            postProcess: 'none',
            playlistIndex: -1
          }
        })
      ]
    })
  )

  // 任务渲染,但不自动弹任何对话框(恢复任务不在本会话 sessionVideoIds)
  await screen.findByText('restored')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(screen.queryByText('选择清晰度与格式'), null, '恢复的单视频 awaiting 不自动弹')
  assert.equal(screen.queryByText(/批量下载/), null, '恢复任务不自动弹批量对话框')
})

test('类型 chips × 状态 nav 正交:选「视频」+「下载中」→ 仅下载中视频;左导航计数不受 chips 影响', async () => {
  renderApp(
    mockApi({
      listCategories: async () => [
        {
          key: 'video',
          displayName: '视频',
          extensions: ['mp4'],
          savePath: 'D:/DL/Videos',
          isCustom: false
        },
        {
          key: 'audio',
          displayName: '音频',
          extensions: ['mp3'],
          savePath: 'D:/DL/Music',
          isCustom: false
        }
      ],
      listTasks: async () => [
        mkTask({
          id: 'a',
          filename: 'dl-video.mp4',
          status: 'downloading',
          category: 'video',
          createdAt: 4
        }),
        mkTask({
          id: 'b',
          filename: 'dl-audio.mp3',
          status: 'downloading',
          category: 'audio',
          createdAt: 3
        }),
        mkTask({
          id: 'c',
          filename: 'done-video.mp4',
          status: 'completed',
          category: 'video',
          createdAt: 2
        }),
        mkTask({
          id: 'd',
          filename: 'done-audio.mp3',
          status: 'completed',
          category: 'audio',
          createdAt: 1
        })
      ]
    })
  )

  // 「全部」状态 + 「全部」类别:四任务全渲染
  assert.ok(await screen.findByText('dl-video.mp4'))
  assert.ok(screen.getByText('dl-audio.mp3'))
  assert.ok(screen.getByText('done-video.mp4'))
  assert.ok(screen.getByText('done-audio.mp3'))

  // 左导航「下载中」计数 = 2(a/b),与 chips 无关(限定到导航 .text,避开 Toolbar 同名标题)
  const navActiveCount = (): string | null =>
    screen
      .getByText('下载中', { selector: '.nav-item .text' })
      .closest('.nav-item')
      ?.querySelector('.nav-count')?.textContent ?? null
  assert.equal(navActiveCount(), '2')

  // 点「视频」chip(在 .filter-bar 内,区别于左导航视频图标无文案冲突)
  fireEvent.click(screen.getByText('视频'))
  // 仍在「全部」状态 → 两个视频任务(下载中 + 已完成),音频被滤除
  assert.ok(screen.getByText('dl-video.mp4'))
  assert.ok(screen.getByText('done-video.mp4'))
  assert.equal(screen.queryByText('dl-audio.mp3'), null)
  assert.equal(screen.queryByText('done-audio.mp3'), null)
  // 正交(决策 a):左导航「下载中」计数不被 chips 影响,仍 = 2
  assert.equal(navActiveCount(), '2')

  // 再切「下载中」nav → 状态 ∩ 类别:仅下载中的视频(a)
  fireEvent.click(screen.getByText('下载中', { selector: '.nav-item .text' }))
  assert.ok(screen.getByText('dl-video.mp4'))
  assert.equal(screen.queryByText('done-video.mp4'), null)
  assert.equal(screen.queryByText('dl-audio.mp3'), null)
  // 左导航计数依旧基于全部 tasks,不受 nav/chips 选择影响
  assert.equal(navActiveCount(), '2')
})

test('设置屏切换深色主题', async () => {
  const modes: ThemeMode[] = []
  renderApp(
    mockApi({
      setTheme: async (mode) => {
        modes.push(mode)
        return mode === 'dark' ? 'dark' : 'light'
      }
    })
  )

  // 先等挂载主题同步完成(ThemeProvider 挂载读持久化档 → setTheme(system),A4 修复);再切深色,避免人为竞态
  await waitFor(() => assert.ok(modes.includes('system')))

  fireEvent.click(screen.getByText('设置'))
  fireEvent.click(screen.getByText('深色'))

  await waitFor(() => {
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  })
  assert.equal(modes.at(-1), 'dark', '点深色 → setTheme(dark)')
})

test('启动读持久化主题档 dark → 画面同步深色(A4:resolvedTheme 与持久化档一致,不再停留初始 light)', async () => {
  renderApp(
    mockApi({
      getSettings: async () => ({
        defaultDir: '',
        maxConcurrent: 3,
        maxOverallLimitKBps: 0,
        useAria2cForVideo: true,
        video: { defaultHeight: null, defaultAudioOnly: false },
        themeMode: 'dark',
        clipboardWatch: false,
        autoUpdateYtDlp: true,
        autoUpdateApp: true,
        btSeedEnabled: false,
        btSeedRatio: 1.0,
        btSeedTimeMin: 60,
        btMaxPeers: 0,
        btAutoUpdateTrackers: true
      }),
      setTheme: async (mode) => (mode === 'dark' ? 'dark' : 'light')
    })
  )
  // 持久化档为 dark → 挂载主动 setTheme(dark) 拿回 resolved → data-theme=dark(修复前仅设 themeMode,画面停留 light)
  await waitFor(() => assert.equal(document.documentElement.getAttribute('data-theme'), 'dark'))
})

test('添加对话框预填 settings.defaultDir(非系统目录;G 修复:改默认目录后新任务落对处)', async () => {
  renderApp(
    mockApi({
      // 默认 mockApi.getDownloadDir = 'D:/Downloads'(系统目录);settings.defaultDir 为用户改过的目录
      getSettings: async () => ({
        defaultDir: 'D:/MyDownloads',
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
      })
    })
  )
  await screen.findByText('还没有下载任务')
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  // 「保存到」预填 settings.defaultDir(经 getSettings),而非系统目录(getDownloadDir);
  // 修复前 App 用 getDownloadDir → 预填 'D:/Downloads' → 本断言失败
  assert.ok(await screen.findByDisplayValue('D:/MyDownloads'), '对话框预填 settings.defaultDir')
})

test('启动拉取代理状态 → 状态栏显示真实档位文案(App → StatusBar 接线)', async () => {
  renderApp(
    mockApi({
      getProxyStatus: async () => ({
        mode: 'manual',
        label: '手动代理(已连接)',
        dot: 'ok',
        effectiveUrl: 'http://127.0.0.1:7890'
      })
    })
  )
  // App 启动 getProxyStatus → 下发 StatusBar 渲染「代理:<label>」
  assert.ok(await screen.findByText(/已连接/))
})

test('订阅 onProxyStatusChanged → 主进程推送即时刷新状态栏(切档联动)', async () => {
  let push: ((s: ProxyStatus) => void) | undefined
  renderApp(
    mockApi({
      getProxyStatus: async () => ({
        mode: 'system',
        label: '跟随系统(系统未设代理 · 直连)',
        dot: 'off',
        effectiveUrl: null
      }),
      onProxyStatusChanged: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  // 初始:直连
  assert.ok(await screen.findByText(/系统未设代理/))
  // 模拟主进程 setConfig 后广播切到「手动代理(已连接)」→ 状态栏即时更新
  act(() =>
    push?.({
      mode: 'manual',
      label: '手动代理(已连接)',
      dot: 'ok',
      effectiveUrl: 'http://127.0.0.1:7890'
    })
  )
  assert.ok(await screen.findByText(/已连接/))
})

// Task 9.6 — 删除接线:completed 菜单「删除文件」→ removeTask(id, true);中间态行内删除 → removeTask(id, false)
test('completed 更多菜单「删除文件」→ window.api.removeTask(id, true)(→ 回收站)', async () => {
  const calls: Array<[string, boolean | undefined]> = []
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'c1',
          status: 'completed',
          filename: 'done.zip',
          completedAt: 1_700_000_000_000
        })
      ],
      removeTask: async (id, deleteFile) => {
        calls.push([id, deleteFile])
      }
    })
  )
  await screen.findByText('done.zip')
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText(/删除文件/))
  await waitFor(() => assert.deepEqual(calls.at(-1), ['c1', true]))
})

test('中间态(processing)行内删除 → window.api.removeTask(id, false)(后端清残留)', async () => {
  const calls: Array<[string, boolean | undefined]> = []
  renderApp(
    mockApi({
      listTasks: async () => [mkTask({ id: 'p1', status: 'processing', filename: 'merging.mp4' })],
      removeTask: async (id, deleteFile) => {
        calls.push([id, deleteFile])
      }
    })
  )
  await screen.findByText('merging.mp4')
  fireEvent.click(screen.getByTitle('删除'))
  await waitFor(() => assert.deepEqual(calls.at(-1), ['p1', false]))
})

// v0.2 Task 3 — 查重接线:onTaskDuplicate 广播 → 弹 DuplicateDialog;决策 → resolveDuplicate
const HTTP_CONFLICT: DuplicateConflict = {
  conflictId: 'dc1',
  kind: 'http',
  items: [
    {
      index: 0,
      filename: 'pack.zip',
      qualityLabel: null,
      existingDir: 'D:/DL/Archives',
      existingPath: 'D:/DL/Archives/pack.zip',
      existing: 'completed'
    }
  ]
}

test('订阅 onTaskDuplicate → 主进程广播冲突即弹 DuplicateDialog', async () => {
  let push: ((c: DuplicateConflict) => void) | undefined
  renderApp(
    mockApi({
      onTaskDuplicate: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  act(() => push?.(HTTP_CONFLICT))
  assert.ok(await screen.findByText('检测到重复下载'))
  assert.ok(screen.getByText('pack.zip'))
})

test('DuplicateDialog 覆盖 → window.api.resolveDuplicate({overwrite}) + 关闭', async () => {
  let push: ((c: DuplicateConflict) => void) | undefined
  const resolved: DuplicateResolution[] = []
  renderApp(
    mockApi({
      onTaskDuplicate: (cb) => {
        push = cb
        return () => {}
      },
      resolveDuplicate: async (res) => {
        resolved.push(res)
      }
    })
  )
  await screen.findByText('还没有下载任务')
  act(() => push?.(HTTP_CONFLICT))
  await screen.findByText('检测到重复下载')
  fireEvent.click(screen.getByRole('button', { name: '覆盖' }))
  await waitFor(() =>
    assert.deepEqual(resolved.at(-1), { conflictId: 'dc1', decision: 'overwrite' })
  )
  // 决策后出队 → 对话框关闭
  await waitFor(() => assert.equal(screen.queryByText('检测到重复下载'), null))
})

test('DuplicateDialog completed·打开 → openPath(existingPath) + resolveDuplicate({open})', async () => {
  let push: ((c: DuplicateConflict) => void) | undefined
  const opened: string[] = []
  const resolved: DuplicateResolution[] = []
  renderApp(
    mockApi({
      onTaskDuplicate: (cb) => {
        push = cb
        return () => {}
      },
      openPath: async (p) => {
        opened.push(p)
        return ''
      },
      resolveDuplicate: async (res) => {
        resolved.push(res)
      }
    })
  )
  await screen.findByText('还没有下载任务')
  act(() => push?.(HTTP_CONFLICT))
  await screen.findByText('检测到重复下载')
  fireEvent.click(screen.getByRole('button', { name: '已存在 · 打开' }))
  await waitFor(() => assert.deepEqual(opened, ['D:/DL/Archives/pack.zip']))
  await waitFor(() => assert.deepEqual(resolved.at(-1), { conflictId: 'dc1', decision: 'open' }))
})

// v0.2 Task 4 — 剪贴板监控接线:onClipboardLink 广播 → 弹 ClipboardPrompt;「添加」→ AddTaskDialog 预填;addOpen 抑制
test('订阅 onClipboardLink → 主进程广播链接即弹克制提示(不夺焦)', async () => {
  let push: ((link: ClipboardLink) => void) | undefined
  renderApp(
    mockApi({
      onClipboardLink: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  // 初始无提示
  assert.equal(screen.queryByText('检测到可下载链接'), null)
  act(() => push?.({ url: 'https://www.youtube.com/watch?v=abc', kind: 'video' }))
  assert.ok(await screen.findByText('检测到可下载链接'))
  assert.ok(screen.getByText('视频'))
  assert.ok(screen.getByText('https://www.youtube.com/watch?v=abc'))
})

test('剪贴板提示点「添加」→ AddTaskDialog 打开且预填该 URL(复用现有添加流程)', async () => {
  let push: ((link: ClipboardLink) => void) | undefined
  renderApp(
    mockApi({
      onClipboardLink: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  act(() => push?.({ url: 'https://www.youtube.com/watch?v=abc', kind: 'video' }))
  await screen.findByText('检测到可下载链接')
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
  // 添加对话框打开,textarea 预填检测到的 URL(其内部 describeLink 照常识别为视频)
  assert.ok(await screen.findByText('添加下载'))
  const textarea = (await screen.findByPlaceholderText(/粘贴/)) as HTMLTextAreaElement
  assert.equal(textarea.value, 'https://www.youtube.com/watch?v=abc', '预填检测到的 URL')
  // 提示已清空(不再叠加)
  assert.equal(screen.queryByText('检测到可下载链接'), null)
})

test('剪贴板提示点「忽略」→ 提示消失(不打开对话框)', async () => {
  let push: ((link: ClipboardLink) => void) | undefined
  renderApp(
    mockApi({
      onClipboardLink: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  act(() => push?.({ url: 'https://example.com/pack.zip', kind: 'http' }))
  await screen.findByText('检测到可下载链接')
  fireEvent.click(screen.getByRole('button', { name: '忽略' }))
  await waitFor(() => assert.equal(screen.queryByText('检测到可下载链接'), null))
  assert.equal(screen.queryByText('添加下载'), null, '忽略不打开对话框')
})

test('添加对话框开着时抑制剪贴板提示(不叠弹,§5.3)', async () => {
  let push: ((link: ClipboardLink) => void) | undefined
  renderApp(
    mockApi({
      onClipboardLink: (cb) => {
        push = cb
        return () => {}
      }
    })
  )
  await screen.findByText('还没有下载任务')
  // 先打开添加对话框(普通「+」入口)
  fireEvent.click(screen.getAllByRole('button', { name: '添加任务' })[0])
  await screen.findByText('添加下载')
  // 对话框开着时到达剪贴板链接 → 抑制,不弹提示
  act(() => push?.({ url: 'https://www.youtube.com/watch?v=xyz', kind: 'video' }))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(screen.queryByText('检测到可下载链接'), null, 'addOpen 时抑制提示')
})

// v0.2 Task 5 — 历史页导航接入:nav==='history' 渲染 HistoryPage;主列表切走
// (正交链路零回归由上方「类型 chips × 状态 nav 正交」用例守护;历史页筛选为页内独立态,不碰 nav / categoryFilter)
test('点左导航「历史」→ 渲染历史页(HistoryPage);主列表任务切走', async () => {
  renderApp(
    mockApi({ listTasks: async () => [mkTask({ filename: 'inlist.bin', status: 'downloading' })] })
  )
  await screen.findByText('inlist.bin')
  fireEvent.click(screen.getByText('历史'))
  // 历史页搜索框出现(HistoryPage 特征元素;mockApi.searchHistory 返回空 → 历史页空态)
  assert.ok(await screen.findByPlaceholderText('搜索文件名或链接…'))
  // 切到历史页 → 主列表任务不再渲染
  assert.equal(screen.queryByText('inlist.bin'), null)
})

// v0.4 Task 5 — 「浏览器扩展」页导航接入:nav==='extension' 渲染 ExtensionPage;主列表切走。
// 这一条守的是**三元链接上了**(NAV_TITLE 的映射漏了则编译不过,由 Record<NavKey,string> 兜住),
// 以及**「前往设置页配置」直达扩展分组**(2026-08-11 手测:落在设置页顶部等于这个按钮白按)。
test('点左导航「浏览器扩展」→ 渲染扩展页;主列表任务切走;页内跳转直达设置页扩展分组', async () => {
  // jsdom 无 scrollIntoView:记录它落在哪个 section 上(设置页测试同一手法)
  const proto = HTMLElement.prototype as HTMLElement & {
    scrollIntoView?: (...a: unknown[]) => void
  }
  const prev = proto.scrollIntoView
  const scrolled: string[] = []
  proto.scrollIntoView = function (this: HTMLElement): void {
    scrolled.push(this.id)
  }
  try {
    renderApp(
      mockApi({
        listTasks: async () => [mkTask({ filename: 'inlist.bin', status: 'downloading' })]
      })
    )
    await screen.findByText('inlist.bin')
    fireEvent.click(screen.getByText('浏览器扩展'))
    // 扩展页特征元素:三块的分组标题 + 只读镜像唯一的改配置出口
    assert.ok(await screen.findByText('连接状态'))
    assert.ok(screen.getByText('下载接管'))
    assert.ok(screen.getByText('网页嗅探'))
    assert.equal(screen.queryByText('inlist.bin'), null)
    // 点「前往设置页配置」→ 切到设置页,且**滚到扩展分组**(不是停在最顶部)
    fireEvent.click(screen.getByText('前往设置页配置'))
    assert.ok((await screen.findAllByText('外观')).length > 0)
    await waitFor(() => assert.ok(scrolled.includes('set-extension')))
    // 子导航「浏览器扩展」当场高亮(点击意图优先,不等 IntersectionObserver)
    const navItem = document.querySelector('.set-nav-item.active')
    assert.equal(navItem?.textContent, '浏览器扩展')
  } finally {
    proto.scrollIntoView = prev
  }
})

// v0.3 Task 3 — BT 导航激活:点「BT · 磁力」→ 主列表仅 torrent(与类别正交、不破坏现有筛选)
test('点左导航「BT · 磁力」→ 主列表仅 kind===torrent;标题「BT · 磁力」;仍是任务列表分支', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'h',
          filename: 'file.bin',
          kind: 'http',
          status: 'downloading',
          createdAt: 3
        }),
        mkTask({
          id: 't',
          filename: 'movie.torrent',
          kind: 'torrent',
          status: 'downloading',
          createdAt: 2
        }),
        mkTask({ id: 'v', filename: 'clip', kind: 'video', status: 'downloading', createdAt: 1 })
      ]
    })
  )
  await screen.findByText('file.bin')
  fireEvent.click(screen.getByText('BT · 磁力'))
  // 标题切换(Toolbar 标题 + 左导航项同名 → 至少 2 处)+ 仅 torrent 任务
  assert.ok(screen.getAllByText('BT · 磁力').length >= 2)
  assert.ok(screen.getByText('movie.torrent'))
  assert.equal(screen.queryByText('file.bin'), null, 'http 任务被滤除')
  assert.equal(screen.queryByText('clip'), null, 'video 任务被滤除')
})

// v0.3 Task 3 — 做种端到端:torrent completed 收到 seeding 进度帧 → UI 显做种中 + ↑ 上行 + 分享率 + 停止做种 → 点停 → stopSeeding(id)
test('做种端到端:seeding 帧 → 做种中 pill + ↑ 上行 + 分享率;点「停止做种」→ window.api.stopSeeding(id)', async () => {
  let push: ((p: import('../../shared/ipc').TaskProgress) => void) | undefined
  let stoppedId = ''
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'bt-seed',
          kind: 'torrent',
          status: 'completed',
          filename: 'Ubuntu.iso',
          downloadedBytes: 1000,
          totalBytes: 1000
        })
      ],
      onTaskProgress: (cb) => {
        push = cb
        return () => {}
      },
      stopSeeding: async (id) => {
        stoppedId = id
      }
    })
  )
  await screen.findByText('Ubuntu.iso')
  // 主进程广播做种帧(seeding:true + 上行 + uploadLength + 节点)
  act(() =>
    push?.({
      id: 'bt-seed',
      status: 'completed',
      downloadedBytes: 1000,
      totalBytes: 1000,
      speed: 0,
      seeding: true,
      uploadSpeed: 512,
      uploadLength: 1500,
      numSeeders: 4,
      connections: 6
    })
  )
  // 做种中 pill + ↑ 上行 + 分享率 1.50 · N 节点(connections=6)
  await waitFor(() => assert.ok(document.querySelector('.pill.seed')))
  assert.ok(screen.getByText(/分享率 1\.50 · 6 节点/))
  assert.ok(document.querySelector('.t-speed.upload'))
  // 状态栏聚合上行出现(totalUpload=512>0)
  assert.equal(document.querySelectorAll('.statusbar .s-item').length, 4)
  // 点「停止做种」→ 转发 stopSeeding(id)
  fireEvent.click(screen.getByTitle('停止做种'))
  await waitFor(() => assert.equal(stoppedId, 'bt-seed'))
})

// v1.0 Task 7:真实 App / Provider / Toolbar 的有限集成；不启动主进程或下载引擎。
// 沿用 setup 的同一个 JSDOM；Fluent/keyborg 焦点事件需要同 realm 的 Node/CustomEvent。
// 不替换 Provider、不新建 DOM，文件结束后恢复这两个原始全局描述符。
const t7DomGlobals = (['Node', 'CustomEvent'] as const).map((key) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true })
  return { key, descriptor }
})
after(() => {
  for (const { key, descriptor } of t7DomGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const t7Names = (): string[] =>
  Array.from(document.querySelectorAll('.task-list .t-name'), (node) => node.textContent ?? '')

function t7SearchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.ctoolbar input')
  assert.ok(input, '主列表工具栏应保留稳定的输入节点')
  return input
}

const t7Type = (query: string): void => {
  fireEvent.change(t7SearchInput(), { target: { value: query } })
}

const t7Nav = (label: string): void => {
  fireEvent.click(screen.getByText(label, { selector: '.nav-item .text' }))
}

const t7Category = (label: string): void => {
  fireEvent.click(screen.getByText(label, { selector: '.filter-bar .chip' }))
}

const t7Categories = [
  {
    key: 'video',
    displayName: '视频',
    extensions: ['mp4'],
    savePath: 'D:/Demo/Video',
    isCustom: false
  },
  {
    key: 'audio',
    displayName: '音频',
    extensions: ['mp3'],
    savePath: 'D:/Demo/Audio',
    isCustom: false
  }
]

test('T7-A05 App 输入立即按 filename 或 source OR 筛选，双命中只显示一次', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'by-name',
          filename: 'needle-name.mp4',
          source: 'https://demo.test/plain',
          createdAt: 4
        }),
        mkTask({
          id: 'by-source',
          filename: 'source-only.mp4',
          source: 'https://demo.test/needle',
          createdAt: 3
        }),
        mkTask({
          id: 'both',
          filename: 'needle-both.mp4',
          source: 'https://demo.test/needle-both',
          createdAt: 2
        }),
        mkTask({
          id: 'neither',
          filename: 'other.mp4',
          source: 'https://demo.test/other',
          createdAt: 1
        })
      ]
    })
  )
  await screen.findByText('other.mp4')
  const input = t7SearchInput()
  t7Type('needle')
  assert.deepEqual(
    t7Names(),
    ['needle-name.mp4', 'source-only.mp4', 'needle-both.mp4'],
    '输入必须真正连接到 App visibleTasks 的 OR 搜索'
  )
  assert.equal(t7SearchInput(), input, '过滤不重建输入节点')
  t7Type('source-only')
  assert.deepEqual(t7Names(), ['source-only.mp4'])
})

test('T7-A04 App 保留原文并即时匹配 trim、中文、双侧大小写和内部空格', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'cn',
          filename: '中文 Report.MP4',
          source: 'https://case.test/PATH-A',
          createdAt: 2
        }),
        mkTask({
          id: 'space',
          filename: 'double  space.mp4',
          source: 'https://case.test/plain',
          createdAt: 1
        })
      ]
    })
  )
  await screen.findByText('double space.mp4', { exact: false })
  const input = t7SearchInput()
  for (const query of ['  rEpOrT  ', 'path-a', '中文']) {
    t7Type(query)
    assert.equal(input.value, query, '受控原文不能被 trim/小写回写')
    assert.deepEqual(t7Names(), ['中文 Report.MP4'])
  }
  t7Type('double space')
  assert.deepEqual(t7Names(), [], '不折叠内部空格')
  t7Type('double  space')
  assert.deepEqual(t7Names(), ['double  space.mp4'])
  t7Type('   ')
  assert.deepEqual(t7Names(), ['中文 Report.MP4', 'double  space.mp4'])
  assert.equal(input.value, '   ')
  assert.ok(screen.getByTitle('清除搜索（Esc）'), '纯空白原文仍有清除按钮')
})

test('T7-A07 App 的 nav→category→search 三维 AND，null 类别只在全部，BT 仍正交', async () => {
  renderApp(
    mockApi({
      listCategories: async () => t7Categories,
      listTasks: async () => [
        mkTask({
          id: 'active',
          filename: 'needle-active.mp4',
          source: 'https://and.test/a',
          category: 'video',
          createdAt: 8
        }),
        mkTask({
          id: 'miss',
          filename: 'other-active.mp4',
          source: 'https://and.test/b',
          category: 'video',
          createdAt: 7
        }),
        mkTask({
          id: 'done',
          filename: 'needle-completed.mp4',
          source: 'https://and.test/c',
          category: 'video',
          status: 'completed',
          createdAt: 6
        }),
        mkTask({
          id: 'audio',
          filename: 'needle-audio.mp3',
          source: 'https://and.test/d',
          category: 'audio',
          createdAt: 5
        }),
        mkTask({
          id: 'null',
          filename: 'needle-unknown',
          source: 'https://and.test/e',
          category: null,
          createdAt: 4
        }),
        mkTask({
          id: 'bt-video',
          filename: 'needle-bt.mp4',
          source: 'https://and.test/f',
          kind: 'torrent',
          category: 'video',
          createdAt: 3
        }),
        mkTask({
          id: 'bt-audio',
          filename: 'needle-bt.mp3',
          source: 'https://and.test/g',
          kind: 'torrent',
          category: 'audio',
          createdAt: 2
        }),
        mkTask({
          id: 'bt-miss',
          filename: 'other-bt.mp4',
          source: 'https://and.test/h',
          kind: 'torrent',
          category: 'video',
          createdAt: 1
        })
      ]
    })
  )
  await screen.findByText('needle-unknown')
  t7Type('needle')
  t7Nav('下载中')
  t7Category('视频')
  assert.deepEqual(
    t7Names(),
    ['needle-active.mp4', 'needle-bt.mp4'],
    'nav 和 category 必须分别排除已完成视频、活动音频及未归类任务'
  )
  t7Category('全部')
  assert.deepEqual(t7Names(), [
    'needle-active.mp4',
    'needle-audio.mp3',
    'needle-unknown',
    'needle-bt.mp4',
    'needle-bt.mp3'
  ])
  t7Nav('已完成')
  assert.deepEqual(t7Names(), ['needle-completed.mp4'])
  t7Nav('BT · 磁力')
  t7Category('视频')
  assert.deepEqual(t7Names(), ['needle-bt.mp4'])
  assert.equal(t7SearchInput().value, 'needle', '导航和类别切换保留查询')
  t7Category('音频')
  assert.deepEqual(t7Names(), ['needle-bt.mp3'])
})

test('T7-A09 原始集合为空时不伪装成搜索无结果，保留原添加动作', async () => {
  renderApp(mockApi())
  await screen.findByText('还没有下载任务')
  t7Type('missing')
  assert.ok(screen.getByText('还没有下载任务'))
  assert.equal(screen.queryByText('没有搜索结果'), null)
  const empty = document.querySelector<HTMLElement>('.empty')
  assert.ok(empty)
  fireEvent.click(within(empty).getByRole('button', { name: '添加任务' }))
  assert.ok(screen.getByText('添加下载'))
})

test('T7-A09 搜索空态与筛选空态区分；×、空态清除及 Escape 统一保留筛选和回焦点', async () => {
  renderApp(
    mockApi({
      listCategories: async () => t7Categories,
      listTasks: async () => [
        mkTask({ filename: 'loaded.mp4', source: 'https://empty.test/file', category: 'video' })
      ]
    })
  )
  await screen.findByText('loaded.mp4')
  t7Nav('已完成')
  t7Category('音频')
  assert.ok(screen.getByText('当前筛选下没有任务'))
  assert.ok(screen.getByText('试试其他导航或类别，或添加任务。'))
  const input = t7SearchInput()
  const assertCleared = (): void => {
    assert.equal(input.value, '', 'clearSearch 必须真正置空原文')
    assert.equal(document.activeElement, input, '两个清除入口与 Escape 都聚焦输入')
    assert.equal(document.querySelector('.sidebar .nav-item.active .text')?.textContent, '已完成')
    assert.equal(document.querySelector('.filter-bar .chip.active')?.textContent, '音频')
    assert.ok(screen.getByText('当前筛选下没有任务'), '清除不应清掉原来的 nav/category')
  }
  t7Type('needle')
  assert.ok(screen.getByText('没有搜索结果'))
  assert.ok(screen.getByText('当前导航和类别下没有匹配的任务。可更换关键词，或清除搜索。'))
  assert.equal(screen.queryByText('还没有下载任务'), null)
  const inputClear = screen.getByTitle('清除搜索（Esc）')
  inputClear.focus()
  assert.equal(document.activeElement, inputClear, '× 激活前由按钮持焦')
  fireEvent.click(inputClear)
  assertCleared()
  t7Type('needle')
  const empty = document.querySelector<HTMLElement>('.empty')
  assert.ok(empty)
  const emptyClear = within(empty).getByRole('button', { name: '清除搜索' })
  assert.equal(emptyClear.className, 'btn btn-default', '搜索空态清除沿用冻结的默认按钮样式')
  emptyClear.focus()
  assert.equal(document.activeElement, emptyClear, '空态清除激活前由按钮持焦')
  fireEvent.click(emptyClear)
  assertCleared()
  t7Type('needle')
  input.focus()
  fireEvent.keyDown(input, { key: 'Escape' })
  assertCleared()
  t7Type('   ')
  assert.ok(screen.getByText('当前筛选下没有任务'), '纯空白不是有效搜索')
  fireEvent.click(screen.getByTitle('清除搜索（Esc）'))
  assertCleared()
  const filterEmpty = document.querySelector<HTMLElement>('.empty')
  assert.ok(filterEmpty)
  fireEvent.click(within(filterEmpty).getByRole('button', { name: '添加任务' }))
  assert.ok(screen.getByText('添加下载'))
})

test('T7-A10 既有 Provider 进度合并和 onTaskAdded 重拉按当前查询重算，输入不额外 listTasks', async () => {
  let progress: Parameters<DownLordApi['onTaskProgress']>[0] | undefined
  let added: Parameters<DownLordApi['onTaskAdded']>[0] | undefined
  let calls = 0
  let rows = [
    mkTask({
      id: 'rename',
      filename: 'old.mp4',
      source: 'https://updates.test/old',
      category: 'video',
      createdAt: 2
    }),
    mkTask({
      id: 'source',
      filename: 'source.mp4',
      source: 'https://updates.test/plain',
      category: 'video',
      createdAt: 1
    })
  ]
  renderApp(
    mockApi({
      listTasks: async (...args: []) => {
        assert.deepEqual(args, [])
        calls++
        return rows
      },
      listCategories: async () => t7Categories,
      onTaskProgress: (cb) => {
        progress = cb
        return () => {}
      },
      onTaskAdded: (cb) => {
        added = cb
        return () => {}
      }
    })
  )
  await screen.findByText('old.mp4')
  assert.ok(progress)
  assert.ok(added)
  const input = t7SearchInput()
  t7Nav('下载中')
  t7Category('视频')
  t7Type('needle')
  assert.deepEqual(t7Names(), [])
  assert.equal(calls, 1)
  act(() =>
    progress?.({
      id: 'rename',
      status: 'downloading',
      filename: 'needle-renamed.mp4',
      category: 'video',
      downloadedBytes: 120,
      totalBytes: 200,
      speed: 4096
    })
  )
  await waitFor(() => assert.deepEqual(t7Names(), ['needle-renamed.mp4']))
  assert.equal(input.value, 'needle')
  assert.equal(t7SearchInput(), input)
  assert.equal(calls, 1, '普通进度仍走既有 200ms 合并，而非为搜索新增重拉')
  act(() =>
    progress?.({
      id: 'rename',
      status: 'downloading',
      category: 'audio',
      downloadedBytes: 130,
      totalBytes: 200,
      speed: 4096
    })
  )
  await waitFor(() => assert.deepEqual(t7Names(), []))
  rows = [
    mkTask({
      id: 'new',
      filename: 'needle-added.mp4',
      source: 'https://updates.test/new',
      category: 'video',
      createdAt: 3
    }),
    mkTask({
      id: 'source',
      filename: 'source.mp4',
      source: 'https://updates.test/needle',
      category: 'video',
      createdAt: 1
    })
  ]
  act(() => added?.())
  await waitFor(() => assert.deepEqual(t7Names(), ['needle-added.mp4', 'source.mp4']))
  assert.equal(calls, 2, '只由既有 onTaskAdded 触发一次重拉')
  assert.equal(input.value, 'needle')
  t7Type('source')
  assert.deepEqual(t7Names(), ['source.mp4'])
  fireEvent.click(screen.getByTitle('清除搜索（Esc）'))
  assert.deepEqual(
    t7Names(),
    ['needle-added.mp4', 'source.mp4'],
    '已从加载集合移除的任务不会被搜索恢复'
  )
  assert.equal(calls, 2, '输入和清除都不请求主进程')
})

function t7BulkTasks(): Task[] {
  const rows: Task[] = []
  for (const status of ['paused', 'downloading'] as const) {
    rows.push(
      mkTask({
        id: status + '-visible',
        filename: 'needle-' + status + '.mp4',
        source: 'https://bulk.test/visible',
        status,
        kind: 'torrent',
        category: 'video'
      }),
      mkTask({
        id: status + '-search-hidden',
        filename: 'other-' + status + '.mp4',
        source: 'https://bulk.test/search-hidden',
        status,
        kind: 'torrent',
        category: 'video'
      }),
      mkTask({
        id: status + '-category-hidden',
        filename: 'needle-' + status + '.mp3',
        source: 'https://bulk.test/category-hidden',
        status,
        kind: 'torrent',
        category: 'audio'
      }),
      mkTask({
        id: status + '-nav-hidden',
        filename: 'needle-http-' + status + '.mp4',
        source: 'https://bulk.test/nav-hidden',
        status,
        kind: 'http',
        category: 'video'
      })
    )
  }
  for (const status of [
    'queued',
    'resolving',
    'awaiting_selection',
    'processing',
    'completed',
    'error'
  ] as const) {
    rows.push(
      mkTask({
        id: status,
        filename: 'other-' + status + '.bin',
        source: 'https://bulk.test/untouched',
        status
      })
    )
  }
  return rows.map((row, index) => ({ ...row, createdAt: rows.length - index }))
}

for (const action of ['start', 'pause'] as const) {
  test(
    'T7-A11 ' + action + ' 真实 Toolbar→App→Provider 操作全部原始目标 id，隐藏及无结果时仍有效',
    async () => {
      const resumed: string[] = []
      const paused: string[] = []
      renderApp(
        mockApi({
          listTasks: async () => t7BulkTasks(),
          listCategories: async () => t7Categories,
          resumeTask: async (id) => {
            resumed.push(id)
          },
          pauseTask: async (id) => {
            paused.push(id)
          }
        })
      )
      await screen.findByText('needle-paused.mp4')
      t7Nav('BT · 磁力')
      t7Category('视频')
      t7Type('needle')
      assert.deepEqual(t7Names(), ['needle-paused.mp4', 'needle-downloading.mp4'])
      const prefix = action === 'start' ? 'paused' : 'downloading'
      const expected = ['-visible', '-search-hidden', '-category-hidden', '-nav-hidden']
        .map((suffix) => prefix + suffix)
        .sort()
      const actual = action === 'start' ? resumed : paused
      const other = action === 'start' ? paused : resumed
      const label = action === 'start' ? '全部开始' : '全部暂停'
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() =>
        assert.deepEqual(
          [...actual].sort(),
          expected,
          '批量操作必须包含搜索、导航及类别隐藏的全部目标 id'
        )
      )
      assert.deepEqual(other, [], '不调用另一种动作或其它状态')
      actual.length = 0
      t7Type('no-matching-task')
      assert.ok(screen.getByText('没有搜索结果'))
      const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
      assert.equal(button.disabled, false)
      fireEvent.click(button)
      await waitFor(() =>
        assert.deepEqual([...actual].sort(), expected, '无搜索结果仍操作原始集合，而非禁用或缩窄')
      )
      assert.deepEqual(other, [])
    }
  )
}

test('T7-A12 搜索和筛选不改变 App 左导航计数及全局状态栏', async () => {
  renderApp(
    mockApi({
      listCategories: async () => t7Categories,
      listTasks: async () => [
        mkTask({
          id: 'd1',
          filename: 'needle.mp4',
          source: 'https://stats.test/a',
          category: 'video',
          speed: 1024,
          uploadSpeed: 128,
          createdAt: 7
        }),
        mkTask({
          id: 'd2',
          filename: 'hidden.mp3',
          source: 'https://stats.test/b',
          category: 'audio',
          speed: 2048,
          uploadSpeed: 256,
          createdAt: 6
        }),
        mkTask({
          id: 'q',
          filename: 'queued.bin',
          source: 'https://stats.test/c',
          status: 'queued',
          createdAt: 5
        }),
        mkTask({
          id: 'p',
          filename: 'paused.bin',
          source: 'https://stats.test/d',
          status: 'paused',
          createdAt: 4
        }),
        mkTask({
          id: 'c',
          filename: 'seed.bin',
          source: 'https://stats.test/e',
          status: 'completed',
          kind: 'torrent',
          seeding: true,
          uploadSpeed: 512,
          createdAt: 3
        }),
        mkTask({
          id: 'e',
          filename: 'error.bin',
          source: 'https://stats.test/f',
          status: 'error',
          createdAt: 2
        }),
        mkTask({
          id: 'processing',
          filename: 'processing.bin',
          source: 'https://stats.test/g',
          status: 'processing',
          createdAt: 1
        })
      ]
    })
  )
  await screen.findByText('needle.mp4')
  await act(async () => {})
  const counts = (): string[] =>
    Array.from(document.querySelectorAll('.sidebar .nav-count'), (node) => node.textContent ?? '')
  const stats = (): string[] =>
    Array.from(document.querySelectorAll('.statusbar .s-item'), (node) => node.textContent ?? '')
  assert.deepEqual(counts(), ['7', '5', '1', '1', '1'])
  const before = stats()
  assert.equal(before.length, 4, '含全局上行统计')
  assert.ok(before.includes('2 个下载中 · 1 排队'))
  t7Type('needle')
  assert.deepEqual(t7Names(), ['needle.mp4'])
  assert.deepEqual(counts(), ['7', '5', '1', '1', '1'])
  assert.deepEqual(stats(), before)
  t7Nav('已完成')
  t7Category('视频')
  t7Type('no-result')
  assert.deepEqual(t7Names(), [])
  assert.deepEqual(counts(), ['7', '5', '1', '1', '1'])
  assert.deepEqual(stats(), before, '统计不是 visibleTasks 的派生物')
})

test('T7-A13 App 在 composition 临时文本变化时也即时过滤，不提交第二份查询或重建输入', async () => {
  renderApp(
    mockApi({
      listTasks: async () => [mkTask({ filename: '中国.mp4', source: 'https://ime.test/file' })]
    })
  )
  await screen.findByText('中国.mp4')
  const input = t7SearchInput()
  input.focus()
  fireEvent.compositionStart(input)
  t7Type('zhong')
  assert.deepEqual(t7Names(), [])
  t7Type('中')
  assert.deepEqual(t7Names(), ['中国.mp4'])
  assert.equal(t7SearchInput(), input)
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
  assert.equal(input.value, '中')
  fireEvent.compositionEnd(input)
  t7Type('中国')
  fireEvent.keyDown(input, { key: 'Enter' })
  assert.equal(input.value, '中国')
  assert.deepEqual(t7Names(), ['中国.mp4'])
})

test('T7-A14 同名同源不同 id 的搜索行保留正确暂停/继续目标', async () => {
  const paused: string[] = []
  const resumed: string[] = []
  renderApp(
    mockApi({
      listTasks: async () => [
        mkTask({
          id: 'down-id',
          filename: 'same.mp4',
          source: 'https://identity.test/shared',
          status: 'downloading',
          createdAt: 2
        }),
        mkTask({
          id: 'paused-id',
          filename: 'same.mp4',
          source: 'https://identity.test/shared',
          status: 'paused',
          createdAt: 1
        }),
        mkTask({
          id: 'hidden-id',
          filename: 'other.mp4',
          source: 'https://identity.test/other',
          createdAt: 3
        })
      ],
      pauseTask: async (id) => {
        paused.push(id)
      },
      resumeTask: async (id) => {
        resumed.push(id)
      }
    })
  )
  await screen.findByText('other.mp4')
  t7Type('shared')
  assert.deepEqual(t7Names(), ['same.mp4', 'same.mp4'])
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.task-list .task'))
  fireEvent.click(within(rows[0]).getByTitle('暂停'))
  fireEvent.click(within(rows[1]).getByTitle('继续'))
  await waitFor(() => {
    assert.deepEqual(paused, ['down-id'])
    assert.deepEqual(resumed, ['paused-id'])
  })
})

test('T7-A15 搜索 source 只作内存匹配：DOM 无额外来源，API/存储/日志/网络相对初始化基线零增量', async (t) => {
  const source = 'https://private.test/resource?token=demo-only#fragment'
  const api = mockApi({ listTasks: async () => [mkTask({ filename: 'neutral.bin', source })] })
  const apiSpies = (Object.keys(api) as (keyof DownLordApi)[]).map((key) => t.mock.method(api, key))
  const storageSpies = (['setItem', 'removeItem', 'clear'] as const).map((key) =>
    t.mock.method(window.Storage.prototype, key)
  )
  const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((key) =>
    t.mock.method(console, key, () => {})
  )
  const fetchSpy = t.mock.method(globalThis, 'fetch', async () => new Response(''))
  const xhrSpy = t.mock.method(window.XMLHttpRequest.prototype, 'send', () => {})
  renderApp(api)
  await screen.findByText('neutral.bin')
  await act(async () => {})
  const input = t7SearchInput()
  assert.notEqual(document.activeElement, input, '首次渲染不抢焦点')
  const snapshot = (): number[] =>
    [...apiSpies, ...storageSpies, ...logSpies, fetchSpy, xhrSpy].map((spy) => spy.mock.callCount())
  const before = snapshot()
  const localBefore = JSON.stringify(window.localStorage)
  const sessionBefore = JSON.stringify(window.sessionStorage)
  const locationBefore = window.location.href
  const raw = '  ?token=demo-only  '
  t7Type(raw)
  assert.equal(input.value, raw, '用户自身原文可保留在输入框')
  assert.deepEqual(t7Names(), ['neutral.bin'], 'source 子串独立命中')
  assert.equal(
    document.body.textContent?.includes('demo-only'),
    false,
    '不新增 source 命中片段文本'
  )
  assert.equal(
    document.body.innerHTML.includes(source),
    false,
    '不新增来源列、title 或完整来源属性'
  )
  assert.equal(document.querySelector('.task .t-name')?.getAttribute('title'), 'neutral.bin')
  t7Type('missing-secret-code')
  assert.ok(screen.getByText('没有搜索结果'))
  assert.equal(
    document.querySelector('.empty')?.textContent?.includes('missing-secret-code'),
    false,
    '空态不回显查询'
  )
  fireEvent.click(screen.getByTitle('清除搜索（Esc）'))
  await act(async () => {})
  assert.deepEqual(snapshot(), before, '输入/清除不增加 API、存储写入、日志或网络调用')
  assert.equal(JSON.stringify(window.localStorage), localBefore)
  assert.equal(JSON.stringify(window.sessionStorage), sessionBefore)
  assert.equal(window.location.href, locationBefore)
})

test('T7-A15 App 查询跨导航/历史/设置/扩展往返保留，独立页不接收；重新挂载清空且不自动聚焦', async (t) => {
  const api = mockApi({
    listCategories: async () => t7Categories,
    listTasks: async () => [
      mkTask({
        id: 'hit',
        filename: '中文.mp4',
        source: 'https://lifecycle.test/hit',
        category: 'video',
        createdAt: 2
      }),
      mkTask({
        id: 'other',
        filename: 'other.mp3',
        source: 'https://lifecycle.test/other',
        category: 'audio',
        createdAt: 1
      })
    ]
  })
  const historySpy = t.mock.method(api, 'searchHistory')
  renderApp(api)
  await screen.findByText('中文.mp4')
  t7Nav('下载中')
  t7Category('视频')
  const raw = '  中文  '
  t7Type(raw)
  for (const page of ['历史', '设置', '浏览器扩展']) {
    t7Nav(page)
    assert.equal(screen.queryByRole('searchbox', { name: '搜索当前列表任务' }), null)
    if (page === '历史') {
      const historyInput = (await screen.findByPlaceholderText(
        '搜索文件名或链接…'
      )) as HTMLInputElement
      assert.equal(historyInput.value, '', '历史页独立查询不继承主列表搜索')
    } else if (page === '设置') {
      await screen.findByRole('button', { name: '外观' })
    } else {
      await screen.findByText('连接状态')
    }
    await act(async () => {})
    t7Nav('下载中')
    assert.equal(t7SearchInput().value, raw)
    assert.notEqual(document.activeElement, t7SearchInput(), '返回主列表不自动聚焦')
    assert.equal(document.querySelector('.filter-bar .chip.active')?.textContent, '视频')
    assert.deepEqual(t7Names(), ['中文.mp4'])
  }
  assert.equal(
    JSON.stringify(historySpy.mock.calls.map((call) => call.arguments)).includes('中文'),
    false
  )
  cleanup()
  renderApp(api)
  await screen.findByText('other.mp3')
  assert.equal(t7SearchInput().value, '', 'App 真正重新挂载从空查询开始')
  assert.notEqual(document.activeElement, t7SearchInput())
  assert.deepEqual(t7Names(), ['中文.mp4', 'other.mp3'])
})
