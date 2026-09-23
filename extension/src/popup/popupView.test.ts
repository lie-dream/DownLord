/**
 * popup 渲染层单测(v0.4 Task 3;jsdom 由 `tests/setup/jsdom.ts` 全局注入)。
 *
 * 守两条最不该退化的事:**Task 2 的四行事实不许撤**(唤醒计数是生命周期五条约定的活证据)、
 * **明文配对码不许进 DOM**。渲染层本身不判断,故这里不测文案内容(那是 `popupModel.test.ts`
 * 与 `sniff/sniffView.test.ts` 的活),只测**结构**与**回调把什么交回去**。
 *
 * v0.4 Task 5 Phase 2 三区重构:资源区在最上、接管一行居中、配对与诊断折进 `<details>`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { PopupModel } from './popupModel'
import { renderPopup, type PopupHandle, type PopupHandlers } from './popupView'
import type { SniffRow, SniffSectionsView } from '../sniff/sniffView'

const TOKEN = 'a'.repeat(64)

function row(overrides: Partial<SniffRow> = {}): SniffRow {
  return {
    url: 'https://cdn.example/trailer.mp4',
    name: 'trailer.mp4',
    badge: 'MP4',
    size: '84.0 MB',
    note: '',
    actionLabel: '下载',
    actionDisabled: false,
    error: '',
    contentType: 'video/mp4',
    initiator: 'https://page.example',
    totalBytes: 88_080_384,
    ...overrides
  }
}

function sniffView(overrides: Partial<SniffSectionsView> = {}): SniffSectionsView {
  return {
    unavailable: false,
    sections: [],
    notices: [],
    footnotes: [],
    empty: { text: '嗅探已关闭', small: '开启后…', canReload: false },
    ...overrides
  }
}

function makeModel(overrides: Partial<PopupModel> = {}): PopupModel {
  return {
    version: '0.3.0',
    extensionId: 'joomlppocobhkaeinpcmkkbphnjmjiei',
    wakeCount: '3',
    lastEvent: 'startup',
    paired: false,
    pairingStatus: '未保存',
    portValue: '52330',
    connection: '尚未保存配对码 —— 填入端口与配对码后点「保存并连接」',
    connectionAlert: '',
    takeoverStatus: '接管中',
    takeoverPaused: false,
    takeoverActionable: true,
    // v0.4 Task 5:默认一致 + 嗅探关着
    buildId: '0.4.0+20260809-143022',
    buildIdMismatch: false,
    buildIdWarning: '',
    sniffEnabled: false,
    sniffCount: '已关闭 · 0 条',
    sniff: sniffView(),
    // v0.4 Task 6:按钮**恒可点**(只在发送中才禁),那一行实话默认空串
    videoIntentEnabled: true,
    videoIntentMessage: '',
    ...overrides
  }
}

function mount(
  model: PopupModel = makeModel(),
  handlers: Partial<PopupHandlers> = {}
): { root: HTMLElement; handle: PopupHandle } {
  // 每个用例从干净文档起:jsdom 的 `#id` 选择器在**文档里有重名 id** 时会只认第一个,
  // 上一个用例遗留的 root 会让 `root.querySelector('#port')` 莫名其妙地返回 null。
  document.body.textContent = ''

  const root = document.createElement('div')
  document.body.append(root)
  const handle = renderPopup(root, model, {
    onSubmit: () => {},
    onSetPause: () => {},
    onToggleSniff: () => {},
    onReloadTab: () => {},
    onDownload: () => {},
    onDownloadPageVideo: () => {},
    ...handlers
  })
  return { root, handle }
}

function input(root: HTMLElement, id: string): HTMLInputElement {
  const element = root.querySelector<HTMLInputElement>(`#${id}`)
  assert.ok(element, `缺少输入框 #${id}`)
  return element
}

test('renderPopup: 保留 Task 2 的四行事实(唤醒计数是五条约定的活证据,不能撤)', () => {
  const { root } = mount()
  const labels = [...root.querySelectorAll('.label')].map((el) => el.textContent)

  for (const label of ['扩展版本', '扩展 ID', '唤醒计数', '最近事件']) {
    assert.ok(labels.includes(label), `少了一行事实:${label}`)
  }
  const values = [...root.querySelectorAll('.value')].map((el) => el.textContent)
  assert.ok(values.includes('3'), '唤醒计数要真显示出来')
})

test('renderPopup: 端口预填 model.portValue(不写魔法数,值由 DEFAULT_PORT 一路传下来)', () => {
  const { root } = mount(makeModel({ portValue: '52341' }))

  assert.equal(input(root, 'port').value, '52341')
})

test('renderPopup: 配对码框默认 type=password,点「显示」切成明文再点切回', () => {
  const { root } = mount()
  const token = input(root, 'token')
  const reveal = root.querySelector<HTMLButtonElement>('.reveal')
  assert.ok(reveal)

  assert.equal(token.type, 'password')
  reveal.click()
  assert.equal(token.type, 'text')
  assert.equal(reveal.textContent, '隐藏')
  reveal.click()
  assert.equal(token.type, 'password')
  assert.equal(reveal.textContent, '显示')
})

test('renderPopup: 点「保存并连接」把两个输入框的**原文**交回(校验是纯函数的活)', () => {
  const seen: { token: string; port: string }[] = []
  const { root } = mount(makeModel(), { onSubmit: (value) => seen.push(value) })

  // 注:单行 `<input>` 会自己吞掉换行(HTML 的 value 净化规则),故这里只能验空格;
  // 「粘贴带换行」那一路由 `pairing.test.ts` 直接喂给纯函数验。
  input(root, 'token').value = `  ${TOKEN}  `
  input(root, 'port').value = ' 52341 '
  root.querySelector<HTMLButtonElement>('.submit')?.click()

  assert.deepEqual(seen, [{ token: `  ${TOKEN}  `, port: ' 52341 ' }])
})

test('handle.update: 只刷新事实与结果行,**不动输入框**(用户可能正在打字)', () => {
  const { root, handle } = mount()
  input(root, 'token').value = '正在输入的内容'
  input(root, 'port').value = '52999'

  handle.update(
    makeModel({ wakeCount: '9', lastEvent: 'message', connection: '已连接 DownLord(应用 v0.3.0)' })
  )

  assert.equal(input(root, 'token').value, '正在输入的内容')
  assert.equal(input(root, 'port').value, '52999')
  assert.equal(root.querySelector('.status')?.textContent, '已连接 DownLord(应用 v0.3.0)')
  assert.ok([...root.querySelectorAll('.value')].some((el) => el.textContent === 'message'))
})

test('handle.setMessage: 写提示行,传空串即清空', () => {
  const { root, handle } = mount()

  handle.setMessage('端口须在 1024–65535 之间,当前填的是 80')
  assert.equal(
    root.querySelector('.message')?.textContent,
    '端口须在 1024–65535 之间,当前填的是 80'
  )

  handle.setMessage('')
  assert.equal(root.querySelector('.message')?.textContent, '')
})

test('★ 明文配对码不进 DOM:model 里根本没有 token,渲染层无从写出', () => {
  const { root, handle } = mount(makeModel({ paired: true, pairingStatus: '已保存' }))
  handle.update(makeModel({ paired: true, pairingStatus: '已保存' }))

  assert.equal(root.innerHTML.includes(TOKEN), false)
  // 已保存过配对码时输入框留空 + placeholder 说明留空即沿用,而不是把旧 token 回填进来
  assert.equal(input(root, 'token').value, '')
  assert.match(input(root, 'token').placeholder, /沿用/)
})

// ── 接管遥控区(v0.4 Task 4 · spec §5.4)────────────────────────────

function buttons(root: HTMLElement, selector: string): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(selector)]
}

test('renderPopup: 接管一行 = 标签 + 状态 + 三档 + 「恢复接管」', () => {
  const { root } = mount()

  assert.equal(root.querySelector('.takeover-state')?.textContent, '接管中')
  assert.deepEqual(
    buttons(root, '.takeover-actions .pause').map((b) => b.textContent),
    ['15 分钟', '1 小时', '4 小时']
  )
  assert.equal(root.querySelector('.takeover-actions .resume')?.textContent, '恢复接管')
})

test('renderPopup: 未暂停 → 显示三档、藏起「恢复接管」;暂停中反过来', () => {
  const { root, handle } = mount()

  assert.deepEqual(
    buttons(root, '.pause').map((b) => b.hidden),
    [false, false, false]
  )
  assert.equal(root.querySelector<HTMLButtonElement>('.resume')?.hidden, true)

  handle.update(
    makeModel({ takeoverPaused: true, takeoverStatus: '已暂停 · 剩余 15 分钟(至 17:30)' })
  )

  // 暂停中时用户要的只有一个动作 —— 再给三档只会让人以为「还能再叠 15 分钟」
  assert.deepEqual(
    buttons(root, '.pause').map((b) => b.hidden),
    [true, true, true]
  )
  assert.equal(root.querySelector<HTMLButtonElement>('.resume')?.hidden, false)
  assert.equal(
    root.querySelector('.takeover-state')?.textContent,
    '已暂停 · 剩余 15 分钟(至 17:30)'
  )
})

test('renderPopup: 三档各自把自己的分钟数交回,「恢复接管」交回 null', () => {
  const seen: (number | null)[] = []
  const { root, handle } = mount(makeModel(), { onSetPause: (minutes) => seen.push(minutes) })

  for (const button of buttons(root, '.pause')) button.click()
  handle.update(makeModel({ takeoverPaused: true }))
  root.querySelector<HTMLButtonElement>('.resume')?.click()

  // ⚠️ 交回的是**分钟数**,不是算好的到期时刻 —— 那是主进程用它自己的时钟算的
  assert.deepEqual(seen, [15, 60, 240, null])
})

test('★ 没问到接管状态 → 按钮全禁用(遥控器够不着 DownLord 时,能按的按钮就是骗人)', () => {
  const { root } = mount(makeModel({ takeoverStatus: '—', takeoverActionable: false }))

  for (const button of buttons(root, '.takeover-actions button')) {
    assert.equal(button.disabled, true, `应禁用:${button.textContent}`)
  }
  assert.equal(root.querySelector('.takeover-state')?.textContent, '—')
})

test('handle.update: 刷新接管一行时**不动输入框**(与结果行同一条纪律)', () => {
  const { root, handle } = mount()
  input(root, 'token').value = '正在输入的内容'

  handle.update(makeModel({ takeoverStatus: '已关闭', takeoverActionable: false }))

  assert.equal(input(root, 'token').value, '正在输入的内容')
  assert.equal(root.querySelector('.takeover-state')?.textContent, '已关闭')
})

test('接管按钮一律 type=button —— 不会顺带提交配对表单', () => {
  const { root } = mount()

  for (const button of buttons(root, '.takeover-actions button')) {
    assert.equal(button.type, 'button', `${button.textContent} 不该是 submit`)
  }
})

// ── v0.4 Task 5 Phase 1:嗅探一行 + 构建标记告警 ──────────────────────────

test('renderPopup: 构建标记有自己一行,且一致时不显示告警(不留空盒子)', () => {
  const { root } = mount(makeModel({ buildId: '0.4.0+20260809-143022' }))
  const labels = [...root.querySelectorAll('.label')].map((el) => el.textContent)
  const warning = root.querySelector<HTMLElement>('.buildid-warning')

  assert.ok(labels.includes('构建标记'), '诊断区少了构建标记这一行')
  assert.ok(
    [...root.querySelectorAll('.value')].some((el) => el.textContent === '0.4.0+20260809-143022')
  )
  assert.ok(warning)
  assert.equal(warning.hidden, true)
})

test('renderPopup: 不一致时告警行现身,文案原样来自 model(渲染层不判断)', () => {
  const warningText =
    '⚠ popup 与后台脚本版本不一致(popup A / 后台 B),请在 edge://extensions 里重新加载扩展'
  const { root, handle } = mount(makeModel({ buildIdMismatch: true, buildIdWarning: warningText }))
  const warning = root.querySelector<HTMLElement>('.buildid-warning')

  assert.equal(warning?.hidden, false)
  assert.equal(warning?.textContent, warningText)

  // update 也要把它收回去 —— 否则重新加载扩展后告警会一直挂着
  handle.update(makeModel())
  assert.equal(warning?.hidden, true)
  assert.equal(warning?.textContent, '')
})

test('renderPopup: 嗅探开关拨动 → 把新状态交回装配点(渲染层不自己写 storage)', () => {
  const seen: boolean[] = []
  const { root } = mount(makeModel(), { onToggleSniff: (enabled) => seen.push(enabled) })
  const toggle = input(root, 'sniff-enabled')

  assert.equal(toggle.checked, false, '默认关')
  toggle.checked = true
  toggle.dispatchEvent(new Event('change'))

  assert.deepEqual(seen, [true])
})

test('renderPopup: 「本页资源」的条数照 model 原样写(关着时也报真数,清干净没有要看得见)', () => {
  const { root, handle } = mount(makeModel({ sniffEnabled: true, sniffCount: '3 条' }))

  assert.equal(root.querySelector('.sniff-count')?.textContent, '3 条')

  handle.update(makeModel({ sniffCount: '已关闭 · 3 条' }))
  assert.equal(root.querySelector('.sniff-count')?.textContent, '已关闭 · 3 条')
})

test('renderPopup: ★ 点「强制刷新本页」才回调 —— 渲染期间绝不自动 reload', () => {
  let reloads = 0
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        empty: { text: '已开启。刷新本页后才能看到本页的媒体资源。', small: '', canReload: true }
      })
    }),
    {
      onReloadTab: () => {
        reloads += 1
      }
    }
  )

  assert.equal(reloads, 0, '渲染本身不该触发任何刷新')
  const reload = root.querySelector<HTMLButtonElement>('.sniff-reload')
  assert.equal(reload?.textContent, '强制刷新本页', '「强制」二字不是修饰:普通刷新走缓存 = 白刷')
  reload?.click()
  assert.equal(reloads, 1)
})

// ── v0.4 Task 5 Phase 2:三区结构 + 资源列表 ──────────────────────────────

test('★ 三区顺序:本页资源 → 接管状态 → 诊断信息(高频在上,配置期一次性的折在下面)', () => {
  const { root } = mount()
  const zones = [...root.children].map((el) => el.className || el.tagName.toLowerCase())

  // v0.4 Task 6 在最前面加了「区零」整页视频入口。**三区的相对顺序一字未动** ——
  // 这一条守的是那个顺序,不是「root 底下恰好四个孩子」。
  assert.deepEqual(zones, ['page-video', 'resources', 'takeover', 'connection-alert', 'diag'])
})

test('★ 诊断区默认折叠,且 Task 3/4 的诊断项一条不少地折在里面', () => {
  const { root } = mount()
  const details = root.querySelector('details')

  assert.equal(details?.open, false, '诊断区默认折叠')
  assert.equal(details?.querySelector('summary')?.textContent, '诊断信息')

  const labels = [...details!.querySelectorAll('.label')].map((el) => el.textContent)
  for (const label of ['配对码', '扩展版本', '扩展 ID', '构建标记', '唤醒计数', '最近事件']) {
    assert.ok(labels.includes(label), `诊断区少了一行:${label}`)
  }
  // 端口输入框与配对表单同样在诊断区里(配置期一次性用)
  assert.ok(details!.querySelector('#port'))
  assert.ok(details!.querySelector('.submit'))
})

test('★ 连接结论:正常 → 常驻行收起;异常 → 提升为常驻行(Task 3 Step 5 已有先例)', () => {
  const { root, handle } = mount()
  const alert = root.querySelector<HTMLElement>('.connection-alert')

  assert.equal(alert?.hidden, true)

  handle.update(makeModel({ connectionAlert: '连不上 DownLord。请确认:…' }))
  assert.equal(alert?.hidden, false)
  assert.equal(alert?.textContent, '连不上 DownLord。请确认:…')

  handle.update(makeModel({ connectionAlert: '' }))
  assert.equal(alert?.hidden, true, '恢复正常后要收回去,不留一条过期告警')
})

test('资源行四段:文件名 + 徽章 + 大小 + 下载按钮;完整 URL 只进 title', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [{ title: '媒体文件', rows: [row()], note: '' }],
        empty: null
      })
    })
  )

  assert.equal(root.querySelector('.res-group-title')?.textContent, '媒体文件')
  const name = root.querySelector<HTMLElement>('.res-name')
  assert.equal(name?.textContent, 'trailer.mp4')
  // 长 URL 会撑爆 380px,且对判断「下不下」几乎没帮助 —— 只走原生 tooltip
  assert.equal(name?.title, 'https://cdn.example/trailer.mp4')
  assert.equal(root.querySelector('.res-badge')?.textContent, 'MP4')
  assert.equal(root.querySelector('.res-size')?.textContent, '84.0 MB')
  assert.equal(root.querySelector('.res-download')?.textContent, '下载')
})

test('★ 点某一行「下载」→ **原样把那一行交回**(一次一条,渲染层不挑字段、不判引擎)', () => {
  const seen: SniffRow[] = []
  const target = row()
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [{ title: '媒体文件', rows: [target], note: '' }],
        empty: null
      })
    }),
    { onDownload: (r) => seen.push(r) }
  )

  root.querySelector<HTMLButtonElement>('.res-download')?.click()
  assert.deepEqual(seen, [target])
})

test('按钮文案与可点性照 model —— 渲染层不判断「发过没有」', () => {
  const { root, handle } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [{ title: '媒体文件', rows: [row()], note: '' }],
        empty: null
      })
    })
  )
  assert.equal(root.querySelector<HTMLButtonElement>('.res-download')?.disabled, false)

  handle.update(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [
          {
            title: '媒体文件',
            rows: [row({ actionLabel: '已发送', actionDisabled: true })],
            note: ''
          }
        ],
        empty: null
      })
    })
  )
  const button = root.querySelector<HTMLButtonElement>('.res-download')
  assert.equal(button?.textContent, '已发送')
  assert.equal(button?.disabled, true)
})

test('转交失败 → 行内多一句实话(**绝不假装成功**),按钮仍可点', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [
          {
            title: '媒体文件',
            rows: [row({ error: '没能交给 DownLord,请确认它正在运行' })],
            note: ''
          }
        ],
        empty: null
      })
    })
  )

  assert.equal(root.querySelector('.res-error')?.textContent, '没能交给 DownLord,请确认它正在运行')
  assert.equal(root.querySelector<HTMLButtonElement>('.res-download')?.disabled, false)
})

test('条目级「已聚合 N 片」与分组级分片提示各落各位', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [
          {
            title: '视频流',
            rows: [row({ note: '已聚合 12 片' })],
            note: '本页有 12 个分片请求属于上方清单,不单独列出'
          }
        ],
        empty: null
      })
    })
  )

  assert.equal(root.querySelector('.res-note')?.textContent, '已聚合 12 片')
  assert.equal(
    root.querySelector('.res-group-note')?.textContent,
    '本页有 12 个分片请求属于上方清单,不单独列出'
  )
})

test('★ 不可下载的提示行:**结构上连一个按钮都长不出来**', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        notices: ['本页检测到分片流,但未找到可下载的清单文件'],
        empty: null
      })
    })
  )
  const notice = root.querySelector<HTMLElement>('.res-notice')

  assert.equal(notice?.textContent, '本页检测到分片流,但未找到可下载的清单文件')
  assert.equal(notice?.querySelector('button'), null, '给按钮就是承诺一件做不到的事')
  assert.equal(root.querySelector('.res-download'), null)
})

test('底部小字逐行渲染(不静默截断)', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [{ title: '媒体文件', rows: [row()], note: '' }],
        footnotes: ['已隐藏 3 个小于 1MB 的媒体请求', '仅显示最近 50 条'],
        empty: null
      })
    })
  )

  assert.deepEqual(
    [...root.querySelectorAll('.res-foot > div')].map((el) => el.textContent),
    ['已隐藏 3 个小于 1MB 的媒体请求', '仅显示最近 50 条']
  )
})

test('空状态:主文案 + 小字;canReload 为假时不给刷新按钮', () => {
  const { root } = mount(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        empty: {
          text: '本页未检测到媒体资源',
          small: '本扩展不注入页面脚本,只读取网络请求的地址与响应头',
          canReload: false
        }
      })
    })
  )

  assert.equal(root.querySelector('.res-empty-text')?.textContent, '本页未检测到媒体资源')
  assert.equal(
    root.querySelector('.res-empty-small')?.textContent,
    '本扩展不注入页面脚本,只读取网络请求的地址与响应头'
  )
  assert.equal(root.querySelector('.sniff-reload'), null)
})

test('handle.update: 资源区整块重建时**不动输入框**(与结果行同一条纪律)', () => {
  const { root, handle } = mount()
  input(root, 'token').value = '正在输入的内容'

  handle.update(
    makeModel({
      sniffEnabled: true,
      sniff: sniffView({
        sections: [{ title: '媒体文件', rows: [row()], note: '' }],
        empty: null
      })
    })
  )

  assert.equal(input(root, 'token').value, '正在输入的内容')
  assert.equal(root.querySelector('.res-name')?.textContent, 'trailer.mp4')
})

// ── v0.4 Task 6:整页视频入口(区零) ──────────────────────────────────────

test('renderPopup: 「用 DownLord 下载此页视频」按钮在最上面,点击把事件交回装配点(不带 URL)', () => {
  let clicks = 0
  const { root } = mount(makeModel(), { onDownloadPageVideo: () => clicks++ })

  const button = root.querySelector<HTMLButtonElement>('.page-video-go')
  assert.ok(button, '缺少整页视频入口按钮')
  assert.equal(button.textContent, '用 DownLord 下载此页视频')
  assert.equal(root.firstElementChild?.className, 'page-video', '区零排在资源区之前')

  button.click()
  assert.equal(clicks, 1)
})

test('renderPopup: 按钮可点性只跟 model.videoIntentEnabled 走(渲染层不判断页面类型)', () => {
  const { root, handle } = mount(makeModel())
  const button = root.querySelector<HTMLButtonElement>('.page-video-go')
  assert.ok(button)
  assert.equal(button.disabled, false)

  handle.update(makeModel({ videoIntentEnabled: false }))
  assert.equal(button.disabled, true)
})

test('renderPopup: 那一行实话空串即隐藏,有值就原样写上去(不拼串、不判断)', () => {
  const { root, handle } = mount(makeModel())
  const message = root.querySelector<HTMLElement>('.page-video-msg')
  assert.ok(message)
  assert.equal(message.hidden, true)
  assert.equal(message.textContent, '')

  handle.update(makeModel({ videoIntentMessage: '已交给 DownLord,请在 DownLord 窗口确认' }))
  assert.equal(message.hidden, false)
  assert.equal(message.textContent, '已交给 DownLord,请在 DownLord 窗口确认')
})
