/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CategoryConfig,
  DownLordApi,
  HistoryQuery,
  HistoryStats,
  Task
} from '../../../shared/ipc'
import HistoryPage from './HistoryPage'
import { TasksProvider } from '../state/TasksContext'
import { ToastProvider } from '../state/ToastContext'

afterEach(cleanup)

const CATEGORIES: CategoryConfig[] = [
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
  },
  {
    key: 'archive',
    displayName: '压缩包',
    extensions: ['zip'],
    savePath: 'D:/DL/Archives',
    isCustom: false
  },
  {
    key: 'document',
    displayName: '文档',
    extensions: ['pdf'],
    savePath: 'D:/DL/Documents',
    isCustom: false
  },
  {
    key: 'program',
    displayName: '程序',
    extensions: ['exe'],
    savePath: 'D:/DL/Programs',
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: 'D:/DL', isCustom: false }
]

const mkTask = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  kind: 'http',
  source: 'http://x/movie',
  status: 'completed',
  filename: 'movie.mp4',
  savePath: 'C:/movie.mp4',
  category: 'video',
  totalBytes: 1000,
  downloadedBytes: 1000,
  speed: 0,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 5,
  startedAt: 2,
  completedAt: 3,
  ...over
})

const RESULTS: Task[] = [mkTask({}), mkTask({ id: 't2', filename: 'song.mp3', category: 'audio' })]

// 独特数字避免与其它文本冲突;byCategory 降序
const STATS: HistoryStats = {
  total: { count: 42, totalBytes: 42_000_000 },
  today: { count: 3, totalBytes: 3_000_000 },
  week: { count: 7, totalBytes: 7_000_000 },
  month: { count: 15, totalBytes: 15_000_000 },
  byCategory: [
    { category: 'video', count: 30, totalBytes: 40_000_000 },
    { category: 'audio', count: 12, totalBytes: 2_000_000 }
  ]
}
const EMPTY_STATS: HistoryStats = {
  total: { count: 0, totalBytes: 0 },
  today: { count: 0, totalBytes: 0 },
  week: { count: 0, totalBytes: 0 },
  month: { count: 0, totalBytes: 0 },
  byCategory: []
}

interface Captures {
  queries: HistoryQuery[]
  removed: Array<[string, boolean]>
  retried: string[]
}

function setupApi(over: Partial<DownLordApi> = {}): Captures {
  const caps: Captures = { queries: [], removed: [], retried: [] }
  const api = {
    // TasksProvider 挂载需要
    listTasks: async () => [],
    listCategories: async () => CATEGORIES,
    onTaskProgress: () => () => {},
    onTaskAdded: () => () => {},
    // HistoryPage 只读检索 / 统计
    searchHistory: async (q: HistoryQuery) => {
      caps.queries.push(q)
      return RESULTS
    },
    getHistoryStats: async () => STATS,
    // 行操作(经既有 window.api)
    removeTask: async (id: string, deleteFile: boolean) => {
      caps.removed.push([id, deleteFile])
    },
    retryTask: async (id: string) => {
      caps.retried.push(id)
    },
    pauseTask: async () => {},
    resumeTask: async () => {},
    openPath: async () => '',
    showItemInFolder: async () => '',
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  return caps
}

function renderPage(): void {
  render(
    <ToastProvider>
      <TasksProvider>
        <HistoryPage />
      </TasksProvider>
    </ToastProvider>
  )
}

test('挂载:防抖调 searchHistory + getHistoryStats,渲染结果列表', async () => {
  const caps = setupApi()
  renderPage()
  assert.ok(await screen.findByText('movie.mp4'))
  assert.ok(screen.getByText('song.mp3'))
  assert.ok(caps.queries.length >= 1, '挂载后至少发起一次检索')
})

test('搜索输入(防抖后)调 searchHistory 带 text', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  fireEvent.change(screen.getByLabelText('搜索历史'), { target: { value: '风景' } })
  await waitFor(() => assert.ok(caps.queries.some((q) => q.text === '风景')))
})

test('状态筛选变更 → searchHistory 带 status(失败 → error)', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'failed' } })
  await waitFor(() => assert.ok(caps.queries.some((q) => q.status?.includes('error'))))
})

test('类别 chip 变更 → searchHistory 带 category', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  // 点 .filter-bar 内的「视频」chip(避开占比条同名文本)
  fireEvent.click(screen.getByText('视频', { selector: '.chip' }))
  await waitFor(() => assert.ok(caps.queries.some((q) => q.category === 'video')))
})

test('时间选「自定义」→ 展开两个日期输入;填起始日期 → searchHistory 带 timePreset=custom + from', async () => {
  const caps = setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  fireEvent.change(screen.getByLabelText('时间筛选'), { target: { value: 'custom' } })
  const fromInput = await screen.findByLabelText('起始日期')
  assert.ok(screen.getByLabelText('结束日期'), '自定义展开结束日期输入')
  fireEvent.change(fromInput, { target: { value: '2026-07-01' } })
  await waitFor(() =>
    assert.ok(caps.queries.some((q) => q.timePreset === 'custom' && typeof q.from === 'number'))
  )
})

test('统计卡渲染 4 窗口(今日 / 本周 / 本月 / 累计)+ 数量', async () => {
  setupApi()
  renderPage()
  await screen.findByText('累计')
  const cards = Array.from(document.querySelectorAll('.stat-card'))
  assert.equal(cards.length, 4)
  assert.deepEqual(
    cards.map((c) => c.querySelector('.sc-label')?.textContent),
    ['今日', '本周', '本月', '累计']
  )
  assert.equal(cards[0].querySelector('.sc-count')?.textContent, '3个', '今日数量')
  assert.equal(cards[3].querySelector('.sc-count')?.textContent, '42个', '累计数量')
})

test('按类别占比条渲染(名称 + 数量·大小;video/audio 各一行;宽按数据量 B8)', async () => {
  setupApi()
  renderPage()
  await screen.findByText('累计')
  const rows = Array.from(document.querySelectorAll('.hcb-row'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].querySelector('.hcb-name')?.textContent, '视频')
  assert.match(rows[0].querySelector('.hcb-num')?.textContent ?? '', /30 个/)
  // B8:宽 ∝ totalBytes(video 40M 满格;audio 2M → 5%),区别于按 count(会是 40%)
  assert.equal((rows[0].querySelector('.hcb-bar > span') as HTMLElement).style.width, '100%')
  assert.equal(
    (rows[1].querySelector('.hcb-bar > span') as HTMLElement).style.width,
    '5%',
    'audio 宽按 bytes(2M/40M)而非 count(12/30=40%)'
  )
})

test('占比条按数据量降序排列:数量多但体积小的类排后(B8)', async () => {
  // document 数量最多(50)但体积最小(1MB);video 数量少(2)但体积最大(10GB)→ video 排首、条最长
  const stats: HistoryStats = {
    total: { count: 52, totalBytes: 10_001_000_000 },
    today: { count: 0, totalBytes: 0 },
    week: { count: 0, totalBytes: 0 },
    month: { count: 0, totalBytes: 0 },
    byCategory: [
      { category: 'document', count: 50, totalBytes: 1_000_000 },
      { category: 'video', count: 2, totalBytes: 10_000_000_000 }
    ]
  }
  setupApi({ getHistoryStats: async () => stats })
  renderPage()
  await screen.findByText('累计')
  const rows = Array.from(document.querySelectorAll('.hcb-row'))
  assert.equal(
    rows[0].querySelector('.hcb-name')?.textContent,
    '视频',
    '体积最大的 video 排首(而非数量最多的 document)'
  )
  assert.equal((rows[0].querySelector('.hcb-bar > span') as HTMLElement).style.width, '100%')
  const docW = (rows[1].querySelector('.hcb-bar > span') as HTMLElement).style.width
  assert.ok(parseFloat(docW) < 1, `document 体积极小 → 条极短(${docW})`)
})

test('自定义时间起 > 止 → 内联提示(B5);纠正为正常序后提示消失', async () => {
  setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  fireEvent.change(screen.getByLabelText('时间筛选'), { target: { value: 'custom' } })
  fireEvent.change(await screen.findByLabelText('起始日期'), { target: { value: '2026-07-10' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-01' } })
  assert.ok(await screen.findByText(/起始日期晚于结束/), '倒置显示提示')
  // 纠正结束日期为更晚 → 提示消失
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-20' } })
  await waitFor(() => assert.equal(screen.queryByText(/起始日期晚于结束/), null))
})

// 注:非法日期(6.31)提示走 date 控件 validity.badInput,jsdom 不模拟该控件的 badInput/清空行为,
// 故 invalid 分支由 validateCustomRange 单测(historyView.test)+ 真机手测覆盖,此处不在 jsdom 强测。

test('空态:完全无历史(无筛选 + 无结果 + 统计空)→「还没有下载历史」', async () => {
  setupApi({ searchHistory: async () => [], getHistoryStats: async () => EMPTY_STATS })
  renderPage()
  assert.ok(await screen.findByText('还没有下载历史'))
  // 完全无历史时不堆一排 0 统计卡
  assert.equal(document.querySelector('.stat-card'), null)
})

test('空态:有筛选但无匹配 →「没有匹配的历史记录」+「清除筛选」;点清除 → 搜索框复位', async () => {
  setupApi({ searchHistory: async () => [], getHistoryStats: async () => STATS })
  renderPage()
  const input = (await screen.findByLabelText('搜索历史')) as HTMLInputElement
  fireEvent.change(input, { target: { value: 'zzz' } })
  assert.ok(await screen.findByText('没有匹配的历史记录'))
  fireEvent.click(screen.getByText('清除筛选'))
  await waitFor(() =>
    assert.equal((screen.getByLabelText('搜索历史') as HTMLInputElement).value, '')
  )
})

test('结果达 500 上限 → 底部诚实提示(不静默截断)', async () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    mkTask({ id: `t${i}`, filename: `f${i}.zip`, category: 'archive' })
  )
  setupApi({ searchHistory: async () => many })
  renderPage()
  assert.ok(await screen.findByText(/仅显示最近 500 条/))
})

test('completed 更多菜单「删除文件」→ removeTask(id,true) + 操作后刷新(再检索)', async () => {
  // 用默认桩(searchHistory 记录 caps.queries);RESULTS 两条 completed → 取第一个「更多」
  const caps = setupApi()
  renderPage()
  await screen.findByText('movie.mp4')
  const before = caps.queries.length
  fireEvent.click(screen.getAllByTitle('更多')[0])
  fireEvent.click(screen.getByText(/删除文件/))
  await waitFor(() => assert.deepEqual(caps.removed.at(-1), ['t1', true]))
  await waitFor(() => assert.ok(caps.queries.length > before, '删除后重新检索刷新历史列表'))
})
