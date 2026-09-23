/// <reference types="node" />

import { type ReactElement } from 'react'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import TaskRow from './TaskRow'
import { ToastProvider } from '../state/ToastContext'
import type { Task, TaskStatus } from '../../../shared/ipc'

afterEach(cleanup)

// completed 态渲染 TaskRowMoreMenu,其内部 useToast()（复制链接 Toast）需 ToastProvider（与真实 App 一致）；统一包裹渲染
const renderRow = (ui: ReactElement): ReturnType<typeof render> =>
  render(<ToastProvider>{ui}</ToastProvider>)

const base: Task = {
  id: '1',
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
  completedAt: null
}
const noop = (): void => {}
const cbs = {
  onPause: noop,
  onResume: noop,
  onCancel: noop,
  onRemove: noop,
  onRetry: noop,
  onOpenFile: noop,
  onShowInFolder: noop
}
const withStatus = (status: TaskStatus, over: Partial<Task> = {}): Task => ({
  ...base,
  status,
  ...over
})

test('downloading 显示文件名 + 暂停按钮 + 进度百分比', () => {
  renderRow(<TaskRow task={base} {...cbs} />)
  assert.ok(screen.getByText('movie.mp4'))
  assert.ok(screen.getByTitle('暂停'))
  assert.ok(screen.getByText('50%'))
})

test('点暂停触发 onPause(id)', () => {
  let id = ''
  renderRow(<TaskRow task={base} {...cbs} onPause={(x) => (id = x)} />)
  fireEvent.click(screen.getByTitle('暂停'))
  assert.equal(id, '1')
})

test('paused 显示继续按钮,点继续触发 onResume(id)', () => {
  let id = ''
  renderRow(<TaskRow task={withStatus('paused')} {...cbs} onResume={(x) => (id = x)} />)
  assert.ok(screen.getAllByText('已暂停').length >= 1)
  fireEvent.click(screen.getByTitle('继续'))
  assert.equal(id, '1')
})

test('queued 显示排队胶囊 + 取消', () => {
  renderRow(<TaskRow task={withStatus('queued')} {...cbs} />)
  assert.ok(screen.getByText('排队中'))
  assert.ok(screen.getByTitle('取消'))
})

test('点取消触发 onCancel(id)', () => {
  let id = ''
  renderRow(<TaskRow task={base} {...cbs} onCancel={(x) => (id = x)} />)
  fireEvent.click(screen.getByTitle('取消'))
  assert.equal(id, '1')
})

test('completed 显示已完成 + 打开文件 / 打开文件夹', () => {
  renderRow(<TaskRow task={withStatus('completed')} {...cbs} />)
  assert.ok(screen.getByText(/已完成/))
  assert.ok(screen.getByTitle('打开文件'))
  assert.ok(screen.getByTitle('打开文件夹'))
})

test('completed 打开文件触发 onOpenFile(savePath)', () => {
  let p = ''
  renderRow(<TaskRow task={withStatus('completed')} {...cbs} onOpenFile={(x) => (p = x)} />)
  fireEvent.click(screen.getByTitle('打开文件'))
  assert.equal(p, 'C:/movie.mp4')
})

test('completed 打开文件夹触发 onShowInFolder(savePath)', () => {
  let p = ''
  renderRow(<TaskRow task={withStatus('completed')} {...cbs} onShowInFolder={(x) => (p = x)} />)
  fireEvent.click(screen.getByTitle('打开文件夹'))
  assert.equal(p, 'C:/movie.mp4')
})

// Task 9.5 — 已完成任务行「更多(⋯)」菜单
const done = (over: Partial<Task> = {}): Task =>
  withStatus('completed', {
    completedAt: 1_700_000_000_000,
    savePath: 'D:/Downloads/movie.mp4',
    ...over
  })

test('completed 渲染「更多」⋯ 按钮', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  assert.ok(screen.getByTitle('更多'))
})

test('点 ⋯ 展开菜单,显示大小 / 时间 / 保存位置', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  // 未展开:菜单不在文档
  assert.equal(screen.queryByRole('menu'), null)
  fireEvent.click(screen.getByTitle('更多'))
  assert.ok(screen.getByRole('menu'))
  assert.ok(screen.getByText('文件大小'))
  assert.ok(screen.getByText('200 B')) // totalBytes=200
  assert.ok(screen.getByText('完成时间'))
  assert.ok(screen.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)) // formatDate(completedAt)
  assert.ok(screen.getByText('保存位置'))
  // 路径显示所在目录,title 悬浮完整路径
  const path = screen.getByText('D:/Downloads')
  assert.equal(path.getAttribute('title'), 'D:/Downloads/movie.mp4')
})

test('点「从列表删除」调 onRemove(id, false) 并关闭菜单(保留文件)', () => {
  let id = ''
  let del: boolean | null = null
  renderRow(
    <TaskRow
      task={done()}
      {...cbs}
      onRemove={(x, d) => {
        id = x
        del = d
      }}
    />
  )
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText(/从列表删除/))
  assert.equal(id, '1')
  assert.equal(del, false)
  assert.equal(screen.queryByRole('menu'), null)
})

test('点「删除文件」调 onRemove(id, true) 并关闭菜单(→ 回收站)', () => {
  let id = ''
  let del: boolean | null = null
  renderRow(
    <TaskRow
      task={done()}
      {...cbs}
      onRemove={(x, d) => {
        id = x
        del = d
      }}
    />
  )
  fireEvent.click(screen.getByTitle('更多'))
  fireEvent.click(screen.getByText(/删除文件/))
  assert.equal(id, '1')
  assert.equal(del, true)
  assert.equal(screen.queryByRole('menu'), null)
})

test('更多菜单三项顺序 / 视觉:复制(中性·首)→ 从列表删除(中性)→ 删除文件(danger·末)+ 图标各异(§2/§6)', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  fireEvent.click(screen.getByTitle('更多'))
  const items = screen.getByRole('menu').querySelectorAll('.tm-item')
  assert.equal(items.length, 3, '操作区三项(复制 + 两删除)')
  // 顺序(常用 → 危险):复制下载链接 → 从列表删除 → 删除文件(spec §6.1 菜单结构)
  assert.match(items[0].textContent ?? '', /复制下载链接/)
  assert.match(items[1].textContent ?? '', /从列表删除/)
  assert.match(items[2].textContent ?? '', /删除文件/)
  // 视觉区分:复制 / 从列表删除中性,仅「删除文件」为 danger(成品移回收站)
  assert.equal(items[0].classList.contains('danger'), false, '复制中性')
  assert.equal(items[1].classList.contains('danger'), false, '从列表删除中性')
  assert.equal(items[2].classList.contains('danger'), true, '删除文件 danger')
  // 三图标各异:IconCopy / IconListX / IconTrash
  const svgs = [...items].map((i) => i.querySelector('svg')?.innerHTML)
  assert.ok(svgs.every(Boolean), '三项各含图标')
  assert.equal(new Set(svgs).size, 3, '三图标各不相同')
})

test('completed 无行内删除按钮(删除入口只在更多菜单,防误删成品 §3)', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  assert.equal(screen.queryByTitle('删除'), null)
  assert.equal(screen.queryByTitle('取消'), null)
  assert.ok(screen.getByTitle('更多'))
})

test('点菜单外关闭菜单', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  fireEvent.click(screen.getByTitle('更多'))
  assert.ok(screen.getByRole('menu'))
  fireEvent.mouseDown(document.body)
  assert.equal(screen.queryByRole('menu'), null)
})

test('按 Esc 关闭菜单(spec §1.5)', () => {
  renderRow(<TaskRow task={done()} {...cbs} />)
  fireEvent.click(screen.getByTitle('更多'))
  assert.ok(screen.getByRole('menu'))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  assert.equal(screen.queryByRole('menu'), null)
})

test('其他态无「更多」⋯(零回归)', () => {
  const states: TaskStatus[] = [
    'downloading',
    'paused',
    'queued',
    'error',
    'resolving',
    'awaiting_selection',
    'processing'
  ]
  for (const s of states) {
    const { unmount } = renderRow(<TaskRow task={withStatus(s, { error: 'x' })} {...cbs} />)
    assert.equal(screen.queryByTitle('更多'), null, `${s} 不应有更多按钮`)
    unmount()
  }
})

test('error 显示可读原因 + 重试 / 删除', () => {
  renderRow(<TaskRow task={withStatus('error', { error: '连接超时' })} {...cbs} />)
  assert.ok(screen.getByText(/连接超时/))
  assert.ok(screen.getByTitle('重试'))
  assert.ok(screen.getByTitle('删除'))
})

test('error 点重试触发 onRetry(id)', () => {
  let id = ''
  renderRow(
    <TaskRow task={withStatus('error', { error: 'x' })} {...cbs} onRetry={(x) => (id = x)} />
  )
  fireEvent.click(screen.getByTitle('重试'))
  assert.equal(id, '1')
})

test('视频态视觉:resolving 解析文案 / processing 合并文案', () => {
  const { rerender } = renderRow(<TaskRow task={withStatus('resolving')} {...cbs} />)
  assert.ok(screen.getByText('正在解析链接…'))
  rerender(<TaskRow task={withStatus('processing')} {...cbs} />)
  assert.ok(screen.getByText('正在合并音视频…'))
})

test('awaiting_selection 不传 onSelectFormat 时不渲染选择清晰度(无死按钮)', () => {
  renderRow(<TaskRow task={withStatus('awaiting_selection')} {...cbs} />)
  assert.equal(screen.queryByText('选择清晰度'), null)
})

test('awaiting_selection 传入 onSelectFormat 时渲染并触发', () => {
  let id = ''
  render(
    <TaskRow task={withStatus('awaiting_selection')} {...cbs} onSelectFormat={(x) => (id = x)} />
  )
  fireEvent.click(screen.getByText('选择清晰度'))
  assert.equal(id, '1')
})

// v0.3 Task 2 — torrent 待选文件:「选择文件」入口(仿视频「选择清晰度」),文案按 kind 区分
test('torrent awaiting_selection:显「已获取种子信息,待选择文件」+ 传 onSelectFormat 出「选择文件」并触发', () => {
  let id = ''
  const t = withStatus('awaiting_selection', { kind: 'torrent' })
  render(<TaskRow task={t} {...cbs} onSelectFormat={(x) => (id = x)} />)
  assert.ok(screen.getByText('已获取种子信息,待选择文件'))
  assert.equal(screen.queryByText('选择清晰度'), null, 'torrent 不显示视频文案')
  fireEvent.click(screen.getByText('选择文件'))
  assert.equal(id, '1')
})

test('torrent awaiting_selection 不传 onSelectFormat → 无「选择文件」死按钮', () => {
  const t = withStatus('awaiting_selection', { kind: 'torrent' })
  renderRow(<TaskRow task={t} {...cbs} />)
  assert.equal(screen.queryByText('选择文件'), null)
})

// Task 9.6 §3 — 中间态(解析 / 待选 / 合并)补行内删除按钮:cancel → onRemove(id, false),后端清残留
test('中间态(resolving/awaiting_selection/processing)出行内删除按钮 → onRemove(id, false)', () => {
  const states: TaskStatus[] = ['resolving', 'awaiting_selection', 'processing']
  for (const s of states) {
    let id = ''
    let del: boolean | null = null
    const { unmount } = render(
      <TaskRow
        task={withStatus(s)}
        {...cbs}
        onRemove={(x, d) => {
          id = x
          del = d
        }}
      />
    )
    fireEvent.click(screen.getByTitle('删除'))
    assert.equal(id, '1', `${s} 行内删除应调 onRemove 且 id 正确`)
    assert.equal(del, false, `${s} 行内删除 deleteFile=false(后端清残留)`)
    unmount()
  }
})

test('中间态行内删除按钮为 danger 危险样式(§3)', () => {
  const states: TaskStatus[] = ['resolving', 'awaiting_selection', 'processing']
  for (const s of states) {
    const { unmount } = renderRow(<TaskRow task={withStatus(s)} {...cbs} />)
    const btn = screen.getByTitle('删除')
    assert.ok(btn.className.includes('danger'), `${s} 行内删除按钮应含 danger`)
    unmount()
  }
})

// Task 8.5 §3.3 — 清晰度行:视频任务显示 .t-quality(自动 / 手选 / 批量 / 仅音频),直链不显示
const video = (status: TaskStatus, qualityLabel?: string): Task =>
  withStatus(status, {
    kind: 'video',
    videoMeta: { title: 't', selectedFormat: 'f', postProcess: '', playlistIndex: 0, qualityLabel }
  })

test('video 手选清晰度在副信息行显示 .t-quality(1080P)', () => {
  const { container } = renderRow(<TaskRow task={video('downloading', '1080P')} {...cbs} />)
  const q = container.querySelector('.t-quality')
  assert.ok(q)
  assert.equal(q?.textContent, '1080P')
})

test('video 自动 / 批量「最高」清晰度显示', () => {
  const { container } = renderRow(<TaskRow task={video('completed', '最高')} {...cbs} />)
  assert.equal(container.querySelector('.t-quality')?.textContent, '最高')
})

test('video 仅音频显示「仅音频 MP3」', () => {
  const { container } = renderRow(<TaskRow task={video('completed', '仅音频 MP3')} {...cbs} />)
  assert.equal(container.querySelector('.t-quality')?.textContent, '仅音频 MP3')
})

test('直链(http)不渲染清晰度标签', () => {
  const { container } = renderRow(<TaskRow task={base} {...cbs} />)
  assert.equal(container.querySelector('.t-quality'), null)
})

test('video 待选(无 qualityLabel)不渲染清晰度标签', () => {
  const { container } = renderRow(<TaskRow task={video('awaiting_selection')} {...cbs} />)
  assert.equal(container.querySelector('.t-quality'), null)
})

// Task 2 §5.3 — 单任务限速 popover(仅 downloading / paused;传 onLimit 才出入口)
test('downloading 传 onLimit → 出限速入口(title 限速);不传 → 无入口', () => {
  const { unmount } = renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  assert.ok(screen.getByTitle('限速'))
  unmount()
  renderRow(<TaskRow task={base} {...cbs} />)
  assert.equal(screen.queryByTitle('限速'), null, '不传 onLimit → 无死按钮')
})

test('点限速图标开 popover;选「自定义」输入 2 MB/s + 应用 → onLimit(id, 2048) 并关闭', () => {
  let got: [string, number | null] | null = null
  renderRow(<TaskRow task={base} {...cbs} onLimit={(id, kbps) => (got = [id, kbps])} />)
  assert.equal(screen.queryByRole('dialog'), null, '未展开无 popover')
  fireEvent.click(screen.getByTitle('限速'))
  assert.ok(screen.getByRole('dialog'))
  fireEvent.click(screen.getByText('自定义'))
  fireEvent.change(screen.getByLabelText('单任务限速(MB/s)'), { target: { value: '2' } })
  fireEvent.click(screen.getByText('应用'))
  assert.deepEqual(got, ['1', 2048], '2 MB/s → 2048 KB/s')
  assert.equal(screen.queryByRole('dialog'), null, '应用后关闭')
})

test('自定义 + 空输入应用 → onLimit(id, 0)(本任务不限速,覆盖全局)', () => {
  let got: [string, number | null] | null = null
  renderRow(<TaskRow task={base} {...cbs} onLimit={(id, kbps) => (got = [id, kbps])} />)
  fireEvent.click(screen.getByTitle('限速'))
  fireEvent.click(screen.getByText('自定义'))
  fireEvent.click(screen.getByText('应用'))
  assert.deepEqual(got, ['1', 0])
})

// v0.3 Task 4 #25 — 限速第三态 radio:跟随全局(null 清除覆盖)/ 自定义(0 = 不限 / N = 限速值)
test('选「跟随全局」→ onLimit(id, null)(清除任务级覆盖)并关闭;自定义输入框隐藏', () => {
  let got: [string, number | null] | null = null
  renderRow(
    <TaskRow
      task={{ ...base, limitKBps: 2048 }}
      {...cbs}
      onLimit={(id, kbps) => (got = [id, kbps])}
    />
  )
  fireEvent.click(screen.getByTitle('限速'))
  // 已设值 → 打开即「自定义」态,输入框在
  assert.ok(screen.getByLabelText('单任务限速(MB/s)'))
  fireEvent.click(screen.getByText('跟随全局'))
  assert.deepEqual(got, ['1', null], '跟随全局 → null(而非 0)')
  assert.equal(screen.queryByRole('dialog'), null, '选定后关闭')
})

test('限速 radio 三态回显:undefined→跟随全局(无输入框)/ 0→自定义+空 / N→自定义+值', () => {
  const checked = (label: string): string | null =>
    screen.getByText(label).closest('[role="radio"]')?.getAttribute('aria-checked') ?? null

  // ① undefined = 跟随全局(无任务级覆盖)
  const r1 = renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(checked('跟随全局'), 'true', 'undefined → 跟随全局选中')
  assert.equal(checked('自定义'), 'false')
  assert.equal(screen.queryByLabelText('单任务限速(MB/s)'), null, '跟随全局态不展开输入框')
  r1.unmount()

  // ② 0 = 本任务不限(覆盖全局)→ 自定义 + 空输入(占位「不限速」)
  const r2 = renderRow(<TaskRow task={{ ...base, limitKBps: 0 }} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(checked('自定义'), 'true', '0 → 自定义选中(与 undefined 不再塌缩)')
  const empty = screen.getByLabelText('单任务限速(MB/s)') as HTMLInputElement
  assert.equal(empty.value, '', '0 → 空输入')
  assert.equal(empty.getAttribute('placeholder'), '不限速')
  r2.unmount()

  // ③ N>0 → 自定义 + 值(KB/s → MB/s)
  renderRow(<TaskRow task={{ ...base, limitKBps: 2048 }} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(checked('自定义'), 'true')
  assert.equal((screen.getByLabelText('单任务限速(MB/s)') as HTMLInputElement).value, '2')
})

test('暂停中的视频任务限速 popover 含「将在继续时生效」灰字;下载中视频 / 直链不含(立即生效,2026-07-09)', () => {
  const { unmount } = renderRow(<TaskRow task={video('paused', '1080P')} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.ok(screen.getByText(/将在继续时生效/), '暂停中的视频任务标注继续时生效')
  unmount()
  // 下载中的视频任务:引擎无缝重起立即生效 → 无该提示
  const r2 = renderRow(<TaskRow task={video('downloading', '1080P')} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(screen.queryByText(/生效/), null, '下载中视频立即生效,无提示')
  r2.unmount()
  // 直链任务:即时生效,无提示
  renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(screen.queryByText(/生效/), null, '直链即时生效,无提示')
})

test('限速 popover 回显当前值(task.limitKBps=2048 → 自定义 + 输入框 2);未设置 → 跟随全局', () => {
  const { unmount } = renderRow(
    <TaskRow task={{ ...base, limitKBps: 2048 }} {...cbs} onLimit={noop} />
  )
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(
    (screen.getByLabelText('单任务限速(MB/s)') as HTMLInputElement).value,
    '2',
    '2048 KB/s 回显为 2 MB/s'
  )
  unmount()
  renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(
    screen.getByText('跟随全局').closest('[role="radio"]')?.getAttribute('aria-checked'),
    'true',
    '未设置 → 跟随全局(无输入框)'
  )
})

test('仅 limitKBps 变化也触发重渲染(memo 比较器含 limitKBps):暂停中设限速后重开 popover 能回显', () => {
  // 暂停中任务设限速时 status/bytes/speed 全不变——比较器漏 limitKBps 会吞掉重渲染,
  // popover 读旧 props 永远显示「不限速」(真机 2026-07-09 反馈「数值没保留」)
  const { rerender } = renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(screen.queryByLabelText('单任务限速(MB/s)'), null, '初始未设置 → 跟随全局态')
  fireEvent.keyDown(document.body, { key: 'Escape' })

  rerender(<TaskRow task={{ ...base, limitKBps: 1024 }} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.equal(
    (screen.getByLabelText('单任务限速(MB/s)') as HTMLInputElement).value,
    '1',
    'limitKBps 单独变化被行感知,回显 1 MB/s'
  )
})

test('限速 popover 点外 / Esc 关闭', () => {
  renderRow(<TaskRow task={base} {...cbs} onLimit={noop} />)
  fireEvent.click(screen.getByTitle('限速'))
  assert.ok(screen.getByRole('dialog'))
  fireEvent.mouseDown(document.body)
  assert.equal(screen.queryByRole('dialog'), null, '点外关闭')
  fireEvent.click(screen.getByTitle('限速'))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  assert.equal(screen.queryByRole('dialog'), null, 'Esc 关闭')
})

test('限速入口仅 downloading / paused;其它态不出(§5.3 防误触)', () => {
  const states: TaskStatus[] = [
    'queued',
    'completed',
    'error',
    'resolving',
    'awaiting_selection',
    'processing'
  ]
  for (const s of states) {
    const { unmount } = renderRow(
      <TaskRow task={withStatus(s, { error: 'x' })} {...cbs} onLimit={noop} />
    )
    assert.equal(screen.queryByTitle('限速'), null, `${s} 不应有限速入口`)
    unmount()
  }
})

// v0.3 Task 3 — torrent 做种中变体:做种中 pill(seed)+ ↑ 上行 + stopSeed 按钮 + memo
const seeding = (over: Partial<Task> = {}): Task =>
  withStatus('completed', {
    kind: 'torrent',
    seeding: true,
    downloadedBytes: 1000,
    totalBytes: 1000,
    uploadLength: 1200,
    uploadSpeed: 500,
    connections: 3,
    ...over
  })

test('torrent 做种中:渲染 .pill.seed「做种中」+ ↑ 上行(.t-speed.upload)+ 分享率副信息', () => {
  const { container } = renderRow(<TaskRow task={seeding()} {...cbs} onStopSeeding={noop} />)
  const pill = container.querySelector('.pill.seed')
  assert.ok(pill, '做种中 pill 存在')
  assert.equal(pill?.textContent, '做种中')
  const up = container.querySelector('.t-speed.upload')
  assert.ok(up, '↑ 上行速度存在')
  assert.match(up?.textContent ?? '', /↑/)
  assert.ok(screen.getByText(/分享率 1\.20 · 3 节点/))
})

test('torrent 做种中:传 onStopSeeding → 出「停止做种」中性按钮(非 danger),点触发 onStopSeeding(id)', () => {
  let id = ''
  const { container } = renderRow(
    <TaskRow task={seeding()} {...cbs} onStopSeeding={(x) => (id = x)} />
  )
  const btn = screen.getByTitle('停止做种')
  assert.ok(btn)
  assert.equal(btn.className.includes('danger'), false, '停止做种为中性,非 danger(保留文件)')
  fireEvent.click(btn)
  assert.equal(id, '1')
  // 做种中仍可打开文件 / 文件夹 / 更多
  assert.ok(screen.getByTitle('打开文件'))
  assert.ok(container.querySelector('.task-more'))
})

test('torrent 做种中:不传 onStopSeeding → 无「停止做种」死按钮', () => {
  renderRow(<TaskRow task={seeding()} {...cbs} />)
  assert.equal(screen.queryByTitle('停止做种'), null)
})

test('torrent completed 非 seeding:零回归(无做种中 pill / 无停止做种)', () => {
  const { container } = renderRow(
    <TaskRow task={seeding({ seeding: false })} {...cbs} onStopSeeding={noop} />
  )
  assert.equal(container.querySelector('.pill.seed'), null)
  assert.equal(screen.queryByTitle('停止做种'), null)
  assert.ok(screen.getByText(/已完成/))
})

test('memo 比较器纳入 uploadSpeed:仅 uploadSpeed 变化也触发重渲染(做种数据不被吞)', () => {
  const { container, rerender } = renderRow(
    <TaskRow task={seeding({ uploadSpeed: 1024 })} {...cbs} onStopSeeding={noop} />
  )
  assert.match(container.querySelector('.t-speed.upload')?.textContent ?? '', /1\.0 KB\/s/)
  // 仅 uploadSpeed 变化(status/bytes 全不变)——比较器漏则吞掉重渲染;rerender 保留 ToastProvider(做种态含更多菜单)
  rerender(
    <ToastProvider>
      <TaskRow task={seeding({ uploadSpeed: 2048 })} {...cbs} onStopSeeding={noop} />
    </ToastProvider>
  )
  assert.match(container.querySelector('.t-speed.upload')?.textContent ?? '', /2\.0 KB\/s/)
})

test('memo 比较器纳入 connections:torrent 下载中 0 速 peers 变化触发重渲染(可观测)', () => {
  const dl = (over: Partial<Task>): Task =>
    withStatus('downloading', {
      kind: 'torrent',
      speed: 0,
      downloadedBytes: 0,
      totalBytes: 100,
      ...over
    })
  const { rerender } = renderRow(<TaskRow task={dl({ connections: 0 })} {...cbs} />)
  assert.ok(screen.getByText('正在寻找节点…'))
  rerender(<TaskRow task={dl({ connections: 5 })} {...cbs} />)
  assert.ok(screen.getByText('5 节点 · 等待数据…'))
})
