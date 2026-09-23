/// <reference types="node" />

/**
 * 接管确认框单测(R-01~R-05;v0.4 Task 4 · spec §7.1)。
 *
 * ⚠️ 单跑本文件须带 `TSX_TSCONFIG_PATH=tsconfig.web.json`(既有踩坑:漏了会满屏「React is not defined」,
 *    不是测试写错了)。`npm test` 的 runner 已经带上。
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CategoryConfig,
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateResolution,
  TakeoverItem,
  TakeoverSubmitPayload
} from '../../../shared/ipc'
import { previewDir } from '../lib/saveLocationView'
import TakeoverDialog from './TakeoverDialog'

afterEach(cleanup)

const DEFAULT_DIR = 'D:\\Downloads'
const PROGRAMS_DIR = 'D:\\Downloads\\Programs'

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'programs',
    displayName: '程序',
    extensions: ['exe', 'msi', 'zip'],
    savePath: PROGRAMS_DIR,
    isCustom: false
  },
  { key: 'other', displayName: '其他', extensions: [], savePath: DEFAULT_DIR, isCustom: false }
]

const ITEM: TakeoverItem = {
  id: 'tk_1',
  url: 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe?sign=abc',
  host: 'uu.gdl.netease.com',
  filename: 'UU-6.15.1.exe',
  totalBytes: 192_000_000,
  kind: 'http'
}

/** 同域三条(态 B 的常见形态) */
const SAME_HOST: TakeoverItem[] = [
  ITEM,
  {
    id: 'tk_2',
    url: 'https://uu.gdl.netease.com/dl/patch-2.dat',
    host: 'uu.gdl.netease.com',
    filename: 'patch-2.dat',
    totalBytes: 12_000_000,
    kind: 'http'
  },
  {
    id: 'tk_3',
    url: 'https://uu.gdl.netease.com/dl/readme.txt',
    host: 'uu.gdl.netease.com',
    filename: 'readme.txt',
    totalBytes: 0,
    kind: 'http'
  }
]

/** 跨域两条(**仍是态 B**,只是不渲染顶部单一域名行) */
const CROSS_HOST: TakeoverItem[] = [
  ITEM,
  {
    id: 'tk_9',
    url: 'https://cdn.example.org/tool.zip',
    host: 'cdn.example.org',
    filename: 'tool.zip',
    totalBytes: 4_000_000,
    kind: 'http'
  }
]

const CONFLICT: DuplicateConflict = {
  conflictId: 'task_7',
  kind: 'http',
  items: [
    {
      index: 0,
      filename: 'UU-6.15.1.exe',
      qualityLabel: null,
      existingDir: PROGRAMS_DIR,
      existingPath: `${PROGRAMS_DIR}\\UU-6.15.1.exe`,
      existing: 'completed'
    }
  ]
}

const noop = (): void => {}
const noBrowse = async (): Promise<string | null> => null

interface Recorded {
  submits: TakeoverSubmitPayload[]
  resolutions: DuplicateResolution[]
  opened: DuplicateConflictItem[]
  dismissed: () => number
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof TakeoverDialog>> = {}
): Recorded {
  const submits: TakeoverSubmitPayload[] = []
  const resolutions: DuplicateResolution[] = []
  const opened: DuplicateConflictItem[] = []
  let dismissCount = 0
  render(
    <TakeoverDialog
      items={[ITEM]}
      conflict={null}
      defaultDir={DEFAULT_DIR}
      categories={CATEGORIES}
      onSubmit={(p) => submits.push(p)}
      onDismiss={() => void (dismissCount += 1)}
      onBrowse={noBrowse}
      onResolveDuplicate={(r) => resolutions.push(r)}
      onOpenExisting={(i) => opened.push(i)}
      {...overrides}
    />
  )
  return { submits, resolutions, opened, dismissed: () => dismissCount }
}

// ── R-01:态 A 渲染 ─────────────────────────────────────────────────────

test('R-01 items=[] 不渲染(窗口在等主进程送批次)', () => {
  renderDialog({ items: [] })
  assert.equal(screen.queryByText('接管下载'), null)
})

test('R-01 态 A:标题 / 来源 host / 大小胶囊 / 预填文件名 / 两个按钮', () => {
  renderDialog()
  assert.ok(screen.getByText('接管下载'))
  assert.ok(screen.getByText('来自 uu.gdl.netease.com'))
  assert.ok(screen.getByText('183.1 MB'))
  assert.equal((screen.getByLabelText('文件名') as HTMLInputElement).value, 'UU-6.15.1.exe')
  assert.ok(screen.getByText('开始下载'))
  assert.ok(screen.getByText('取消'))
  // ★ 完整 URL 不在框内展示(带签名的长 URL 一行放不下,截断显示反而误导)
  assert.equal(screen.queryByText(new RegExp('sign=abc')), null)
})

test('R-01 大小未知(-1 / 0)→ 整个 pill 不渲染(不写「未知大小」这种噪音)', () => {
  renderDialog({ items: [{ ...ITEM, totalBytes: -1 }] })
  assert.equal(document.querySelector('.pill'), null)
  cleanup()
  renderDialog({ items: [{ ...ITEM, totalBytes: 0 }] })
  assert.equal(document.querySelector('.pill'), null)
})

test('R-01 文件名清空 → 禁用「开始下载」(防呆,同 BtFileDialog 空选禁用)', () => {
  const { submits } = renderDialog()
  fireEvent.change(screen.getByLabelText('文件名'), { target: { value: '   ' } })
  const submit = screen.getByText('开始下载') as HTMLButtonElement
  assert.equal(submit.disabled, true)
  fireEvent.click(submit)
  assert.equal(submits.length, 0)
})

// ── R-01:态 B 列表(唯一判据 = 条数)──────────────────────────────────────

test('R-01 态 B 判据:1 条 → 态 A(有文件名输入框);>1 条 → 态 B(列表,无输入框)', () => {
  renderDialog()
  assert.ok(screen.queryByLabelText('文件名'), '态 A 有文件名输入框')
  assert.equal(document.querySelector('.tk-list'), null)
  cleanup()

  renderDialog({ items: SAME_HOST })
  assert.ok(screen.getByText('接管 3 个下载'))
  assert.ok(document.querySelector('.tk-list'))
  // ★ 列表态不逐条改文件名(克制取舍,不是遗漏)
  assert.equal(screen.queryByLabelText('文件名'), null)
  assert.equal(document.querySelectorAll('.tk-item').length, 3)
  assert.ok(screen.getByText('来自 uu.gdl.netease.com'), '全批同 host → 顶部单一域名行')
  assert.ok(screen.getByText('开始下载 (3)'))
  assert.ok(screen.getByText('全部取消'))
})

test('R-01 态 B 逐条 × 移除 → 计数与按钮文案实时更新', () => {
  const { submits } = renderDialog({ items: SAME_HOST })

  fireEvent.click(screen.getByLabelText('移除 patch-2.dat'))
  assert.equal(document.querySelectorAll('.tk-item').length, 2)
  assert.ok(screen.getByText('开始下载 (2)'))
  // 标题仍显示原批次条数 —— 态判据取批次长度,界面不在用户眼皮底下换形态
  assert.ok(screen.getByText('接管 3 个下载'))

  fireEvent.click(screen.getByText('开始下载 (2)'))
  assert.deepEqual(
    submits[0].items.map((i) => i.id),
    ['tk_1', 'tk_3'],
    '被移除的条目不进提交载荷'
  )
})

test('R-01 态 B 移到 0 条 → 禁用提交 + 提示「已全部移除」', () => {
  const { submits } = renderDialog({ items: SAME_HOST })
  for (const name of ['UU-6.15.1.exe', 'patch-2.dat', 'readme.txt']) {
    fireEvent.click(screen.getByLabelText(`移除 ${name}`))
  }
  const submit = screen.getByText('开始下载 (0)') as HTMLButtonElement
  assert.equal(submit.disabled, true)
  assert.ok(screen.getByText('已全部移除,点「全部取消」关闭。'))
  fireEvent.click(submit)
  assert.equal(submits.length, 0)
})

test('R-01 态 B 大小未知的条目不渲染 pill(readme.txt totalBytes=0)', () => {
  renderDialog({ items: SAME_HOST })
  // 三条里只有两条有大小
  assert.equal(document.querySelectorAll('.tk-item .pill').length, 2)
})

// ── R-05:跨域批次仍用态 B ────────────────────────────────────────────────

test('R-05 跨域批次:仍是一个列表框,不渲染顶部单一域名行,每条前缀显示自己的 host', () => {
  renderDialog({ items: CROSS_HOST })

  // ★ 绝不按 host 拆成多个窗口 —— 一个列表,两条
  assert.ok(document.querySelector('.tk-list'))
  assert.equal(document.querySelectorAll('.tk-item').length, 2)
  // 顶部单一域名行不存在
  assert.equal(screen.queryByText('来自 uu.gdl.netease.com'), null)
  assert.equal(document.querySelector('.tk-origin'), null)
  // 每条前缀显示自己的 host
  const hosts = [...document.querySelectorAll('.tk-item-host')].map((n) => n.textContent)
  assert.deepEqual(hosts, ['uu.gdl.netease.com', 'cdn.example.org'])
})

test('R-05 同域批次不渲染逐条 host 前缀(顶部那一行已经说了)', () => {
  renderDialog({ items: SAME_HOST })
  assert.equal(document.querySelectorAll('.tk-item-host').length, 0)
})

// ── R-02:落点镜像(与 AddTaskDialog 同一断言形态)────────────────────────

test('R-02 未浏览 → 显示分类目录 = previewDir(null, defaultDir, 类目录)', () => {
  renderDialog()
  const shown = (screen.getByDisplayValue(PROGRAMS_DIR) as HTMLInputElement).value
  assert.equal(shown, previewDir(null, DEFAULT_DIR, PROGRAMS_DIR))
})

test('R-02 无匹配类别 → 回落 defaultDir(等价 main other → defaultDir)', () => {
  renderDialog({ items: [{ ...ITEM, url: 'https://a.com/x.weirdext', filename: 'x.weirdext' }] })
  assert.ok(screen.getByDisplayValue(DEFAULT_DIR))
})

test('R-02 态 B 统一落点:跟随时显示 defaultDir + 诚实文案(逐字复用 AddTaskDialog 的措辞)', () => {
  renderDialog({ items: SAME_HOST })
  assert.ok(screen.getByDisplayValue(DEFAULT_DIR))
  assert.ok(screen.getByText('各文件按类型分类保存'))
})

test('R-02 态 B 浏览到显式目录 → 不再显示「按类型分类保存」(此时不按类型分了)', async () => {
  renderDialog({ items: SAME_HOST, onBrowse: async () => 'E:\\Games' })
  fireEvent.click(screen.getByText('浏览…'))
  await waitFor(() => assert.ok(screen.getByDisplayValue('E:\\Games')))
  assert.equal(screen.queryByText('各文件按类型分类保存'), null)
})

test('R-02 提交传 sentinel:未浏览 → dir === defaultDir(主进程 explicitDirOf 判走分类)', () => {
  const { submits } = renderDialog()
  fireEvent.click(screen.getByText('开始下载'))
  assert.equal(submits.length, 1)
  assert.deepEqual(submits[0], {
    items: [{ id: 'tk_1', filename: 'UU-6.15.1.exe' }],
    dir: DEFAULT_DIR
  })
})

test('R-02 浏览到别的目录 → 显示该目录,提交传该目录(显式覆盖)', async () => {
  const picked = 'E:\\Games'
  const { submits } = renderDialog({ onBrowse: async () => picked })
  fireEvent.click(screen.getByText('浏览…'))
  await waitFor(() => assert.ok(screen.getByDisplayValue(picked)))
  fireEvent.click(screen.getByText('开始下载'))
  assert.equal(submits[0].dir, picked)
})

test('R-02 用户改名 → 提交带改后的名字(trim)', () => {
  const { submits } = renderDialog()
  fireEvent.change(screen.getByLabelText('文件名'), { target: { value: '  我的安装包.exe  ' } })
  fireEvent.click(screen.getByText('开始下载'))
  assert.equal(submits[0].items[0].filename, '我的安装包.exe')
})

// ── R-03:诚实提示 / Esc / 点遮罩不关闭 ──────────────────────────────────

test('R-03 ★ 诚实提示:只说「已请求」,并如实告知文件可能已在浏览器下载目录里', () => {
  // ⚠️ 2026-08-04 据真机取证改写(`docs/TODO.md` #52 的 ②)。原断言守的是
  //    「浏览器那边的下载**已经取消**」这句**已发生**的陈述,而它并不总为真:
  //    `downloads.cancel()` 打在一个已下完的项目上是**静默无效**的(Edge 151 实测),
  //    手测中抓到四条 1441 KB 的 `complete` 记录 —— 那些文件确实落进了浏览器下载目录。
  //    故这里改守**诚实性**而不是某一串字面:结果不许说死,第二份不许瞒着。
  for (const items of [[ITEM], SAME_HOST]) {
    cleanup()
    renderDialog({ items })
    const note = document.querySelector('.tk-note')?.textContent ?? ''

    assert.match(note, /已请求浏览器取消/, `要说「已请求」而不是断言结果:${note}`)
    assert.equal(
      /已经取消|已取消/.test(note),
      false,
      `不许把 cancel 的结果说死 —— 它对已下完的项目是静默无效的:${note}`
    )
    assert.match(note, /可能已在浏览器下载目录里/, `「可能有第二份」必须如实告诉用户:${note}`)
  }
})

test('R-03 两态文案各说各的(单条说「这次下载」,列表说「这些下载」+ 移除项)', () => {
  renderDialog()
  const single = document.querySelector('.tk-note')?.textContent ?? ''
  cleanup()
  renderDialog({ items: SAME_HOST })
  const list = document.querySelector('.tk-note')?.textContent ?? ''

  assert.notEqual(single, list)
  assert.match(single, /点「取消」DownLord 就不下载它/)
  assert.match(list, /移除的条目 DownLord 不会下载/)
})

test('R-03 Esc / × / 取消 都走 dismiss', () => {
  const one = renderDialog()
  fireEvent.keyDown(window, { key: 'Escape' })
  assert.equal(one.dismissed(), 1)
  fireEvent.click(screen.getByLabelText('取消')) // 头部 ×
  assert.equal(one.dismissed(), 2)
  fireEvent.click(screen.getByText('取消')) // 底部按钮
  assert.equal(one.dismissed(), 3)
})

test('R-03 点遮罩**不关闭**(防误触,同 FormatDialog / BtFileDialog 既有规矩)', () => {
  const { dismissed } = renderDialog()
  const overlay = document.querySelector('.overlay')
  assert.ok(overlay)
  fireEvent.click(overlay)
  assert.equal(dismissed(), 0)
})

test('提交后禁用按钮:双击不会建两个任务', () => {
  const { submits } = renderDialog()
  const submit = screen.getByText('开始下载') as HTMLButtonElement
  fireEvent.click(submit)
  fireEvent.click(submit)
  assert.equal(submits.length, 1)
})

test('同窗换批次 → 文件名 / 落点 / 提交态 / 移除态 全部重置', () => {
  const submits: TakeoverSubmitPayload[] = []
  const props = {
    conflict: null,
    defaultDir: DEFAULT_DIR,
    categories: CATEGORIES,
    onSubmit: (p: TakeoverSubmitPayload) => submits.push(p),
    onDismiss: noop,
    onBrowse: noBrowse,
    onResolveDuplicate: noop,
    onOpenExisting: noop
  }
  const view = render(<TakeoverDialog items={[ITEM]} {...props} />)
  fireEvent.change(screen.getByLabelText('文件名'), { target: { value: '改过的.exe' } })
  fireEvent.click(screen.getByText('开始下载'))

  const next: TakeoverItem = {
    id: 'tk_2',
    url: 'https://b.com/next.zip',
    host: 'b.com',
    filename: 'next.zip',
    totalBytes: 0,
    kind: 'http'
  }
  view.rerender(<TakeoverDialog items={[next]} {...props} />)
  assert.equal((screen.getByLabelText('文件名') as HTMLInputElement).value, 'next.zip')
  const submit = screen.getByText('开始下载') as HTMLButtonElement
  assert.equal(submit.disabled, false, '换批次后「开始下载」必须重新可用')
  fireEvent.click(submit)
  assert.equal(submits.length, 2)
  assert.equal(submits[1].items[0].id, 'tk_2')
})

// ── R-04:态 C —— 同一小窗口内换成既有 DuplicateDialog ─────────────────────

test('R-04 conflict 非空 → 渲染 DuplicateDialog,TakeoverDialog 本体消失', () => {
  renderDialog({ items: SAME_HOST, conflict: CONFLICT })

  assert.ok(screen.getByText('检测到重复下载'), '换成查重框')
  assert.ok(screen.getByText('该文件已存在,请选择处理方式。'))
  // ★ 同一个窗口内换内容 —— 接管框的列表 / 按钮全部不在了
  assert.equal(screen.queryByText('接管 3 个下载'), null)
  assert.equal(document.querySelector('.tk-list'), null)
  assert.equal(screen.queryByText('全部取消'), null)
})

test('R-04 四决策回调参数逐字透传(挂载方据此调 takeoverApi.resolveDuplicate)', () => {
  const { resolutions } = renderDialog({ items: [ITEM], conflict: CONFLICT })

  fireEvent.click(screen.getByText('覆盖'))
  fireEvent.click(screen.getByText('跳过'))
  fireEvent.click(screen.getByText('重命名'))

  assert.deepStrictEqual(resolutions, [
    { conflictId: 'task_7', decision: 'overwrite' },
    { conflictId: 'task_7', decision: 'skip' },
    { conflictId: 'task_7', decision: 'rename' }
  ])
})

test('R-04 「已存在 · 打开」透传冲突项(挂载方据 existing 走 openPath / showItemInFolder)', () => {
  const { opened, resolutions } = renderDialog({ items: [ITEM], conflict: CONFLICT })

  fireEvent.click(screen.getByText('已存在 · 打开'))

  assert.deepStrictEqual(opened, [CONFLICT.items[0]])
  assert.deepStrictEqual(resolutions, [{ conflictId: 'task_7', decision: 'open' }])
})

test('R-04 态 C 的 × / Esc 落成显式 skip(接管路径没有「稍后再决策」的兜底,不许静默蒸发)', () => {
  const { resolutions } = renderDialog({ items: [ITEM], conflict: CONFLICT })

  fireEvent.click(screen.getByLabelText('关闭'))
  assert.deepStrictEqual(resolutions, [{ conflictId: 'task_7', decision: 'skip' }])

  fireEvent.keyDown(window, { key: 'Escape' })
  assert.deepStrictEqual(resolutions[1], { conflictId: 'task_7', decision: 'skip' })
  assert.equal(resolutions.length, 2, '态 C 时接管框自己的 Esc 监听让位,不会一次按键关两层')
})

// ── v0.4 Task 5:video 条目的诚实呈现(spec §4.6 第 2 点)────────────────────────

/** 一条视频流条目(嗅探来的 m3u8),`kind === 'video'` 是唯一判据 */
const VIDEO_ITEM: TakeoverItem = {
  id: 'tk_v1',
  url: 'https://cdn.example.com/hls/index.m3u8',
  host: 'cdn.example.com',
  filename: 'index.m3u8',
  totalBytes: -1,
  kind: 'video'
}

test('★ kind=video 态 A:文件名输入框换成只读说明(改了名却静默不生效是不诚实的)', () => {
  renderDialog({ items: [VIDEO_ITEM] })

  // ① 没有输入框可改
  assert.equal(screen.queryByLabelText('文件名'), null, 'video 条目不该给可编辑的文件名输入框')
  // ② 换成一行只读说明(逐字)
  assert.ok(screen.getByText('文件名与保存位置将在解析后确定(视频流由 yt-dlp 解析)'))
  // ③ 落点行改口为「预计」—— applySelection 才按类别定型
  assert.ok(screen.getByText('预计保存到此处(解析后可能按类别调整)'))
  // ④ 仍然可以提交(没有名字可填,不该被「名字非空」这条防呆卡死)
  assert.equal((screen.getByText('开始下载') as HTMLButtonElement).disabled, false)
})

test('★ kind=http 逐字保持现状(本 Task 对确认框的改动只作用于 video 条目)', () => {
  renderDialog() // 默认 ITEM.kind === 'http'

  // ① 输入框仍在、仍预填建议名
  assert.equal((screen.getByLabelText('文件名') as HTMLInputElement).value, 'UU-6.15.1.exe')
  // ② 两句 video 专属文案一个字都不出现
  assert.equal(screen.queryByText('文件名与保存位置将在解析后确定(视频流由 yt-dlp 解析)'), null)
  assert.equal(screen.queryByText('预计保存到此处(解析后可能按类别调整)'), null)
  assert.equal(document.querySelector('.tk-readonly'), null)
  // ③ 清空名字仍禁用提交(既有防呆未被 video 分支带偏)
  fireEvent.change(screen.getByLabelText('文件名'), { target: { value: '   ' } })
  assert.equal((screen.getByText('开始下载') as HTMLButtonElement).disabled, true)
})

test('★ 态 B(列表)不受 kind 影响:本来就不逐条改名,故不出现只读说明', () => {
  renderDialog({ items: [VIDEO_ITEM, { ...VIDEO_ITEM, id: 'tk_v2' }] })
  assert.equal(document.querySelector('.tk-readonly'), null)
  assert.equal(screen.queryByText('预计保存到此处(解析后可能按类别调整)'), null)
  assert.ok(screen.getByText('开始下载 (2)'))
})

test('★ video 条目提交:载荷里 filename 为空串(名字由 applySelection 重算,不臆造)', () => {
  const { submits } = renderDialog({ items: [VIDEO_ITEM] })
  fireEvent.click(screen.getByText('开始下载'))
  assert.equal(submits.length, 1)
  assert.deepStrictEqual(submits[0].items, [{ id: 'tk_v1', filename: '' }])
})

// ── v0.4 Task 6 Phase 4:确认框「将使用 … 的登录态」附加行 ──────────────────

/** 带暂借登录态的视频条目(`kind:'http'` 恒没有 cookieHosts:直链走 aria2,不带登录态) */
const COOKIE_ITEM: TakeoverItem = {
  id: 'tk_c1',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  host: 'www.bilibili.com',
  filename: '待解析',
  totalBytes: 0,
  kind: 'video',
  cookieHosts: ['www.bilibili.com']
}

test('★ Task6 cookieHosts 非空 → 渲染「将使用 … 的登录态(可在设置页清除)」', () => {
  renderDialog({ items: [COOKIE_ITEM] })
  // D7 ③:这一行**必须带撤销出口** —— 只告知不给回路,用户不知道去哪儿收回
  assert.ok(screen.getByText('将使用 www.bilibili.com 的登录态(可在设置页清除)'))
})

test('★ Task6 cookieHosts 缺失 → 整行不渲染(present 时刻实读,不做实时推送)', () => {
  renderDialog()
  assert.equal(screen.queryByText(/将使用/), null)
  // 正向对照:同一个框在有 cookieHosts 时确实渲染得出来(证明上面那条不是选择器写错)
  cleanup()
  renderDialog({ items: [COOKIE_ITEM] })
  assert.ok(screen.queryByText(/将使用/))
})

test('★ Task6 态 B:多域去重合并成一行', () => {
  renderDialog({
    items: [
      COOKIE_ITEM,
      { ...COOKIE_ITEM, id: 'tk_c2', cookieHosts: ['www.bilibili.com'] },
      { ...COOKIE_ITEM, id: 'tk_c3', cookieHosts: ['www.youtube.com'] }
    ]
  })
  assert.ok(screen.getByText('将使用 www.bilibili.com、www.youtube.com 的登录态(可在设置页清除)'))
})

test('★ Task6 态 B:把带登录态的条目逐条移除后,那一行随之消失', () => {
  renderDialog({ items: [ITEM, COOKIE_ITEM] })
  assert.ok(screen.getByText('将使用 www.bilibili.com 的登录态(可在设置页清除)'))
  fireEvent.click(screen.getByLabelText('移除 待解析'))
  assert.equal(screen.queryByText(/将使用/), null)
})
