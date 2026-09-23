/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CategoryConfig, DownLordApi } from '../../../shared/ipc'
import AddTaskDialog from './AddTaskDialog'
import { TasksProvider } from '../state/TasksContext'
import { ToastProvider } from '../state/ToastContext'

afterEach(cleanup)

// 注入运行时类别(含各类 extensions,与 categoryModel 同形)→ 验证 classifyLink 加固:
// document.docx / video.mkv / audio.flac / program.deb / archive.gz 均应判直链(http)
const CATEGORIES: CategoryConfig[] = [
  {
    key: 'video',
    displayName: '视频',
    extensions: ['mp4', 'mkv', 'avi', 'mov'],
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
    extensions: ['zip', 'rar', '7z', 'gz'],
    savePath: 'D:/DL/Archives',
    isCustom: false
  },
  {
    key: 'document',
    displayName: '文档',
    extensions: ['pdf', 'doc', 'docx', 'txt'],
    savePath: 'D:/DL/Documents',
    isCustom: false
  },
  {
    key: 'program',
    displayName: '程序',
    extensions: ['exe', 'msi', 'deb'],
    savePath: 'D:/DL/Programs',
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: 'D:/DL', isCustom: false }
]

// AddTaskDialog 现读 useTasks().categories(经 TasksProvider)→ mock window.api 满足 Provider 启动拉取
function setupApi(over: Partial<DownLordApi> = {}): void {
  const api = {
    getVersion: async () => '0.1.0',
    getDownloadDir: async () => 'D:/DL',
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    setTheme: async () => 'light',
    onThemeChanged: () => () => {},
    selectDirectory: async () => null,
    selectFile: async () => null,
    openPath: async () => '',
    showItemInFolder: async () => '',
    addTask: async () => 'id',
    pauseTask: async () => {},
    resumeTask: async () => {},
    removeTask: async () => {},
    retryTask: async () => {},
    listTasks: async () => [],
    onTaskProgress: () => () => {},
    onTaskAdded: () => () => {},
    getResolved: async () => null,
    selectFormat: async () => {},
    submitBatch: async () => {},
    applyTorrentSelection: async () => {},
    stopSeeding: async () => {},
    listCategories: async () => CATEGORIES,
    updateCategory: async () => {},
    getProxyConfig: async () => ({ mode: 'system', manualUrl: null }),
    setProxyConfig: async () => ({ mode: 'system', label: 'x', dot: 'off', effectiveUrl: null }),
    getProxyStatus: async () => ({ mode: 'system', label: 'x', dot: 'off', effectiveUrl: null }),
    onProxyStatusChanged: () => () => {},
    onClipboardLink: () => () => {},
    getSettings: async () => ({
      defaultDir: '',
      maxConcurrent: 3,
      maxOverallLimitKBps: 0,
      useAria2cForVideo: true,
      video: { defaultHeight: null, defaultAudioOnly: false },
      themeMode: 'system'
    }),
    setSettings: async () => ({
      defaultDir: '',
      maxConcurrent: 3,
      maxOverallLimitKBps: 0,
      useAria2cForVideo: true,
      video: { defaultHeight: null, defaultAudioOnly: false },
      themeMode: 'system'
    }),
    getEngineVersions: async () => ({ aria2: '1.37', ytdlp: '2026.06', ffmpeg: '7.0' }),
    searchHistory: async () => [],
    getHistoryStats: async () => ({
      total: { count: 0, totalBytes: 0 },
      today: { count: 0, totalBytes: 0 },
      week: { count: 0, totalBytes: 0 },
      month: { count: 0, totalBytes: 0 },
      byCategory: []
    }),
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
}

interface DialogProps {
  open: boolean
  defaultDir: string
  onClose: () => void
  onSubmit: (urls: string[], dir: string) => void
  onSubmitVideo?: (url: string, dir: string) => void
  onSubmitTorrent?: (source: string, dir: string) => void
}

function renderDialog(props: DialogProps): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <TasksProvider>
        <AddTaskDialog {...props} />
      </TasksProvider>
    </ToastProvider>
  )
}

test('open=false 时不渲染', () => {
  setupApi()
  renderDialog({ open: false, defaultDir: 'D:/DL', onClose: () => {}, onSubmit: () => {} })
  assert.equal(screen.queryByText('添加下载'), null)
})

test('输入多行 → 识别提示 + 提交回调收到 url 列表 + dir', () => {
  setupApi()
  let got: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => {
      got = { urls, dir }
    }
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1\nhttps://a/2' }
  })
  assert.ok(screen.getByText(/识别到 2 个直链/))
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(got, { urls: ['https://a/1', 'https://a/2'], dir: 'D:/DL' })
})

test('含非法行时提示无法识别', () => {
  setupApi()
  renderDialog({ open: true, defaultDir: 'D:/DL', onClose: () => {}, onSubmit: () => {} })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1\nmagnet:?x\n随便' }
  })
  assert.ok(screen.getByText(/2 行无法识别/))
})

test('无合法 URL 时添加禁用', () => {
  setupApi()
  renderDialog({ open: true, defaultDir: 'D:/DL', onClose: () => {}, onSubmit: () => {} })
  assert.equal((screen.getByText('添加') as HTMLButtonElement).disabled, true)
})

test('点取消触发 onClose', () => {
  setupApi()
  let closed = false
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => (closed = true),
    onSubmit: () => {}
  })
  fireEvent.click(screen.getByText('取消'))
  assert.equal(closed, true)
})

test('点右上角 × 触发 onClose', () => {
  setupApi()
  let closed = false
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => (closed = true),
    onSubmit: () => {}
  })
  fireEvent.click(screen.getByTitle('关闭'))
  assert.equal(closed, true)
})

test('点遮罩不关闭(防误触清空已粘贴链接)', () => {
  setupApi()
  let closed = false
  const { container } = renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => (closed = true),
    onSubmit: () => {}
  })
  fireEvent.click(container.querySelector('.overlay') as Element)
  assert.equal(closed, false)
})

test('单行视频链接 → 出识别卡(来源名)+ 默认提交走 addVideo', () => {
  setupApi()
  let video: { url: string; dir: string } | null = null
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitVideo: (url, dir) => (video = { url, dir })
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  // 识别卡显示来源友好名
  assert.ok(screen.getByText(/来源 YouTube/))
  // 默认建议视频 → 提交走 addVideo
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(video, { url: 'https://www.youtube.com/watch?v=abc', dir: 'D:/DL' })
  assert.equal(http, null)
})

test('单行链接切「作为直链下载」→ 提交走 http', () => {
  setupApi()
  let video: { url: string; dir: string } | null = null
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitVideo: (url, dir) => (video = { url, dir })
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'http' } })
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(http, { urls: ['https://www.youtube.com/watch?v=abc'], dir: 'D:/DL' })
  assert.equal(video, null)
})

test('多行输入仍按直链(不出识别卡)', () => {
  setupApi()
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitVideo: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1\nhttps://a/2' }
  })
  assert.ok(screen.getByText(/识别到 2 个直链/))
  assert.equal(screen.queryByRole('combobox'), null)
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(http, { urls: ['https://a/1', 'https://a/2'], dir: 'D:/DL' })
})

// —— Phase 4 链接识别加固(TODO #13):注入类别 extensions 后,带已知文件扩展名直链默认 http ——

test('加固:单行 .docx 直链 → 识别卡默认「作为直链下载」(注入类别 extensions)', async () => {
  setupApi()
  let video: { url: string; dir: string } | null = null
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitVideo: (url, dir) => (video = { url, dir })
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://example.com/files/report.docx' }
  })
  // categories 异步到达 → knownFileExts 含 docx → 识别卡建议直链(select=http)
  const sel = (await screen.findByRole('combobox')) as HTMLSelectElement
  await waitFor(() => assert.equal(sel.value, 'http'))
  assert.ok(screen.getByText('识别为直链下载'))
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(http, { urls: ['https://example.com/files/report.docx'], dir: 'D:/DL' })
  assert.equal(video, null)
})

test('加固:单行 youtube 链接仍默认「作为视频解析」(站点优先,不受类别 extensions 影响)', async () => {
  setupApi()
  let video: { url: string; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: (url, dir) => (video = { url, dir })
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  const sel = (await screen.findByRole('combobox')) as HTMLSelectElement
  // 即便注入含 mp4 等扩展名的 categories,视频站点优先 → 仍默认 video
  await waitFor(() => assert.equal(sel.value, 'video'))
  assert.ok(screen.getByText(/来源 YouTube/))
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(video, { url: 'https://www.youtube.com/watch?v=abc', dir: 'D:/DL' })
})

// —— 保存位置「所见即所存」(spec §2):显示镜像 main 落点 ——

test('保存到:单行 .mp4 直链 → 显 video 类目录(按扩展名归类,spec §2.2)', async () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://dl.example.com/a/clip.mp4' }
  })
  // categories 异步到达 → mp4 ∈ video extensions → 识别卡 http + 保存到显 video 类目录
  const sel = (await screen.findByRole('combobox')) as HTMLSelectElement
  await waitFor(() => assert.equal(sel.value, 'http'))
  await waitFor(() => assert.ok(screen.getByDisplayValue('D:/DL/Videos')))
})

test('保存到:单行视频链接 → 显默认目录 + 文案「视频将按类别保存」(spec §2.3)', async () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  const sel = (await screen.findByRole('combobox')) as HTMLSelectElement
  await waitFor(() => assert.equal(sel.value, 'video'))
  assert.ok(screen.getByDisplayValue('D:/DL'))
  assert.ok(screen.getByText('视频将按类别保存(可在选清晰度时确认)'))
})

test('保存到:多行批量 → 显默认目录 + 文案「各文件按类型分类保存」(spec §2.2)', () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1.zip\nhttps://a/2.pdf' }
  })
  assert.ok(screen.getByDisplayValue('D:/DL'))
  assert.ok(screen.getByText('各文件按类型分类保存'))
})

test('保存到:浏览自定义目录 → 显示该目录 + 传值用该目录 + 文案消失(显式覆盖,spec §2.1)', async () => {
  setupApi({ selectDirectory: async () => 'E:/Custom' })
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitVideo: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1.zip\nhttps://a/2.pdf' }
  })
  fireEvent.click(screen.getByText('浏览'))
  await waitFor(() => assert.ok(screen.getByDisplayValue('E:/Custom')))
  // 显式覆盖 → 不再显示「按类型分类保存」文案
  assert.equal(screen.queryByText('各文件按类型分类保存'), null)
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(http, { urls: ['https://a/1.zip', 'https://a/2.pdf'], dir: 'E:/Custom' })
})

// —— v0.3 Task 1:磁力 / 种子识别卡 + 选种子文件(spec §10.3)——

test('单行 magnet: → 出磁力识别卡(无 video/http select)+ 提交走 onSubmitTorrent', () => {
  setupApi()
  let torrent: { source: string; dir: string } | null = null
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir }),
    onSubmitTorrent: (source, dir) => (torrent = { source, dir })
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:abc&dn=My+Show' }
  })
  // 识别卡显示磁力文案,无「视频 / 直链」select
  assert.ok(screen.getByText('识别为磁力链接'))
  assert.equal(screen.queryByRole('combobox'), null, 'torrent 卡无 video/http select')
  // 添加按钮可用(magnet 不进 urls,但单 magnet 放行)
  assert.equal((screen.getByText('添加') as HTMLButtonElement).disabled, false)
  fireEvent.click(screen.getByText('添加'))
  assert.deepEqual(torrent, { source: 'magnet:?xt=urn:btih:abc&dn=My+Show', dir: 'D:/DL' })
  assert.equal(http, null)
})

test('单行 magnet: → 保存位置显 <defaultDir>/Torrents + 诚实文案 + 无浏览按钮', () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitTorrent: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:abc' }
  })
  assert.ok(screen.getByDisplayValue('D:/DL/Torrents'))
  assert.ok(screen.getByText('种子按整包保存到 Torrents 目录'))
  // BT 落点固定,浏览无效 → 不出浏览按钮(诚实)
  assert.equal(screen.queryByText('浏览'), null)
})

test('「选择种子文件」→ selectFile(.torrent filter)得路径 → 直投 onSubmitTorrent + 关闭', async () => {
  setupApi({ selectFile: async () => 'C:/seeds/ubuntu.torrent' })
  let torrent: { source: string; dir: string } | null = null
  let closed = false
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => (closed = true),
    onSubmit: () => {},
    onSubmitTorrent: (source, dir) => (torrent = { source, dir })
  })
  fireEvent.click(screen.getByText('选择种子文件…'))
  await waitFor(() =>
    assert.deepEqual(torrent, { source: 'C:/seeds/ubuntu.torrent', dir: 'D:/DL' })
  )
  assert.equal(closed, true, '选中种子文件 → 提交后关闭对话框')
})

test('「选择种子文件」取消(selectFile 返回 null)→ 不提交、不关闭', async () => {
  setupApi({ selectFile: async () => null })
  let torrent: { source: string; dir: string } | null = null
  let closed = false
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => (closed = true),
    onSubmit: () => {},
    onSubmitTorrent: (source, dir) => (torrent = { source, dir })
  })
  fireEvent.click(screen.getByText('选择种子文件…'))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(torrent, null)
  assert.equal(closed, false)
})

test('未接 onSubmitTorrent(退化):不出「选择种子文件」按钮;单 magnet 回退直链批量', () => {
  setupApi()
  let http: { urls: string[]; dir: string } | null = null
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: (urls, dir) => (http = { urls, dir })
  })
  assert.equal(screen.queryByText('选择种子文件…'), null)
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:abc' }
  })
  // 无 onSubmitTorrent → magnet 不识别为种子,按「无法识别」直链提示,添加禁用
  assert.ok(screen.getByText(/1 行无法识别/))
  assert.equal((screen.getByText('添加') as HTMLButtonElement).disabled, true)
  assert.equal(http, null)
})

// ==================== v1.0 Task 3 · P2「UI 文案」新增用例 ====================
// 逐字文案真源 = spec §4「如实说清单」;本段全部为**新增**,不改任何既有断言。

test('M-010 禁用态给出原因', async () => {
  setupApi()
  renderDialog({ open: true, defaultDir: 'D:/DL', onClose: () => {}, onSubmit: () => {} })

  // ① 空输入:按钮灰 **且** 说清为什么(此前两者只有前一半)
  const btn = screen.getByText('添加') as HTMLButtonElement
  assert.equal(btn.disabled, true)
  assert.ok(
    screen.getByText('未识别到有效链接(需要 http(s) 链接、磁力链接或 .torrent 地址)。')
  )

  // ② 纯中文输入:与空输入同为禁用态,原因照样在
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), { target: { value: '随便写点中文' } })
  assert.equal((screen.getByText('添加') as HTMLButtonElement).disabled, true)
  assert.ok(screen.getByText(/未识别到有效链接/))

  // ③ 反向对照:一旦有合法链接,按钮可点、原因随之消失(不是一条恒显示的废话)
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), { target: { value: 'https://a/1.zip' } })
  await waitFor(() => assert.equal((screen.getByText('添加') as HTMLButtonElement).disabled, false))
  assert.equal(screen.queryByText(/未识别到有效链接/), null)
})

test('M-024 多行提示只收直链', () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {}
  })
  // 1 直链 + 1 视频页链接:结构上**只有单行才走视频路径**,故这里两条都按直链下 ——
  // 此前一个字不说,用户拿到的是「下载失败(引擎代码 22)」这种内部错误码
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://a/1.zip\nhttps://www.bilibili.com/video/BV1xx' }
  })
  const note = screen.getByText(
    '多行批量只收直链。视频页链接请一行一条单独添加 —— 多行路径不会走视频解析。'
  )
  // ★ 必须是**独立提示行**,不许塞进「保存到」下方的 saveHint(既有断言钉着 saveHint 的语义)
  assert.equal(note.closest('.save-hint'), null, '提示不得塞进 saveHint')
  assert.ok(note.closest('.detect-hint'), '提示应落在链接字段的识别提示区')
  // 既有 saveHint 仍是它自己那句(零回归的正向对照)
  assert.ok(screen.getByText('各文件按类型分类保存'))

  // 反向对照:单行时不出现 —— 单行**确实**会走视频解析,那时说这句话就是假的
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.bilibili.com/video/BV1xx' }
  })
  assert.equal(screen.queryByText(/多行批量只收直链/), null)
})

test('M-007 切「作为直链下载」后识别提示随之改口', () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {}
  })
  // 普通网页 / 未知站 → ambiguous,默认建议视频解析
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://example.com/some/page' }
  })
  // ① 未改选时**逐字不变**(零回归的正向对照 —— 否则下面那条断言换个恒空实现也能过)
  assert.ok(screen.getByText('未知链接,将尝试视频解析'))
  assert.ok(screen.getByText('无法确定类型,默认按视频解析(可切换为直链下载)'))

  // ② 切到「作为直链下载」→ 提示与此刻真实行为一致,不再说要去做视频解析
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'http' } })
  const card = document.querySelector('.detect') as HTMLElement
  assert.equal(card.textContent?.includes('将尝试视频解析'), false)
  assert.equal(card.textContent?.includes('默认按视频解析'), false)
  assert.ok(screen.getByText('已改为:作为直链下载'))
  assert.ok(screen.getByText('将作为普通文件直接下载'))

  // ③ 切回来 → 回到原识别文案(改口是双向的,不是一次性覆盖)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'video' } })
  assert.ok(screen.getByText('未知链接,将尝试视频解析'))
})

test('M-007 视频链接改选直链也改口;magnet 那一支不受影响(无 select)', () => {
  setupApi()
  renderDialog({
    open: true,
    defaultDir: 'D:/DL',
    onClose: () => {},
    onSubmit: () => {},
    onSubmitVideo: () => {},
    onSubmitTorrent: () => {}
  })
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'https://www.youtube.com/watch?v=abc' }
  })
  assert.ok(screen.getByText(/来源 YouTube/))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'http' } })
  assert.ok(screen.getByText('已改为:作为直链下载'))
  assert.equal(screen.queryByText(/来源 YouTube/), null)

  // magnet:没有 select,改口逻辑对它不适用 —— 识别卡逐字保持
  fireEvent.change(screen.getByPlaceholderText(/粘贴/), {
    target: { value: 'magnet:?xt=urn:btih:abc' }
  })
  assert.ok(screen.getByText('识别为磁力链接'))
  assert.ok(screen.getByText('将用 aria2 原生 BT 能力下载整包内容'))
})
