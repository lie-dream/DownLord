/**
 * popup **渲染层** — 唯一碰 DOM 的文件(v0.4 Task 2 · spec §2.1;Task 5 Phase 2 三区重构)。
 *
 * 只做「model → DOM」这一件事:不取数、不判断缺失(那是数据层的活)、不碰 `chrome`。
 * 一律用 `textContent` 写值,**不拼 `innerHTML`** —— 值虽都来自本地,但拼串写 DOM 是个不该开的口子。
 *
 * ★ **本文件里没有一个业务判断**。资源区是「数组 → DOM」:分组、徽章、大小、分片归属、
 *   计数提示、四种非列表状态、每个按钮的文案与可点性,**全部**在 `sniff/sniffView.ts` 的
 *   `buildSniffSections` 里算完;连接告警要不要出现由 `popupModel.ts` 的 `connectionAlert`
 *   算完(空串 = 不出现)。这里只剩「遍历」与「空串即隐藏」两种机械动作。
 *   —— 若发现要在本文件里写 `if (…)` 判业务,那说明该判断放错了地方。
 *
 * **三区顺序(DESIGN §7 第 2 条)**:本页资源 / 接管状态(常驻一行)/ 诊断信息(默认折叠)。
 * 顺序即优先级:资源列表是**日常每次**都看的,配对码 / 端口 / 扩展 ID 是**配置期一次性**用的。
 *
 * ★ **v0.4 Task 6 在最上面加了「区零」**:整页视频入口(一个按钮 + 一行实话)。
 *   它排在资源区之前,理由同样是优先级 —— 它**不依赖嗅探开关、不依赖刷过页**,
 *   而资源列表要开了嗅探并刷新才有内容。三区的相对顺序一字未动。
 *
 * **为什么 `renderPopup` 返回一个 handle 而不是重复整树重绘**:握手结果是打开之后才回来的,
 * 整树重绘会把用户正在输入的配对码连同焦点一起抹掉。故结构只建一次,之后只改那几行文字。
 * **唯一的例外是资源区** —— 它整块重建(那里没有输入框,且「已发送」等行内状态**在 model 里**,
 * 重建不会丢;重建前后搬一次 `scrollTop`,列表不会跳回顶部)。
 */
import { PAUSE_PRESETS, type PopupModel } from './popupModel'
import type { SniffRow, SniffSectionsView } from '../sniff/sniffView'

export interface PopupHandlers {
  /** 「保存并连接」:交回**输入框原文**,校验是纯函数的活(`pairing.ts`),渲染层不判断 */
  onSubmit(input: { token: string; port: string }): void
  /**
   * 时长档 / 「恢复接管」。`minutes: null` = 恢复。
   *
   * ⚠️ 渲染层**不换算成绝对到期时刻** —— 那是主进程用它自己的时钟算的(真源在那边)。
   */
  onSetPause(minutes: number | null): void
  /** ★ v0.4 Task 5:拨动嗅探开关。**默认关**,由用户自己开 */
  onToggleSniff(enabled: boolean): void
  /** ★ v0.4 Task 5:「强制刷新本页」。**只在用户点了才刷** —— 绝不自动 reload */
  onReloadTab(): void
  /**
   * ★ v0.4 Task 5 Phase 2:用户点了某一条资源的「下载」。
   *
   * **原样把那一行交回装配点** —— 渲染层不挑字段、不判断走哪个引擎(那是主进程 `classifySniffed`
   * 的活)。**一次只交一条**:未被用户选中的资源从不离开浏览器。
   */
  onDownload(row: SniffRow): void
  /**
   * ★ v0.4 Task 6:「用 DownLord 下载此页视频」。
   *
   * ⚠️ **不带参数** —— 当前页地址由装配点向适配层现取。渲染层**拿不到 URL**,
   *    于是它不可能把地址写进 DOM 或日志(与资源行的 `initiator` 同一手法)。
   */
  onDownloadPageVideo(): void
}

export interface PopupHandle {
  /** 用新事实刷新结果行与事实行。**不动输入框** —— 那里可能正有用户在打字 */
  update(model: PopupModel): void
  /** 临时提示(校验失败的具体项 / 「正在连接…」);传空串即清空 */
  setMessage(text: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function appendRow(list: HTMLElement, label: string, value: string): HTMLElement {
  const row = el('div', 'row')
  row.append(el('span', 'label', label), el('span', 'value', value))
  list.append(row)
  return row.lastElementChild as HTMLElement
}

function createField(
  id: string,
  labelText: string
): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('div', 'field')

  const label = document.createElement('label')
  label.htmlFor = id
  label.textContent = labelText

  const input = document.createElement('input')
  input.id = id
  input.type = 'text'

  field.append(label, input)
  return { field, input }
}

/**
 * 接管遥控区:一行状态 + 一排按钮(**功能与文案一字不改**,Phase 2 只把它下移到资源列表之后)。
 *
 * 三档与「恢复接管」**同批建好、靠 `hidden` 切**(暂停中时用户要的只有恢复这一个动作)。
 * 按钮一律 `type="button"` —— 它们在 `<form>` 之外,但显式写出来免得日后有人搬进表单时踩到默认提交。
 */
function createTakeover(handlers: PopupHandlers): {
  root: HTMLElement
  apply(model: PopupModel): void
} {
  const root = el('div', 'takeover')

  const head = el('div', 'takeover-head')
  const state = el('span', 'takeover-state')
  head.append(el('span', 'label', '下载接管'), state)

  const actions = el('div', 'takeover-actions')

  const presets = PAUSE_PRESETS.map((preset) => {
    const button = el('button', 'pause', preset.label)
    button.type = 'button'
    button.addEventListener('click', (): void => handlers.onSetPause(preset.minutes))
    return button
  })

  const resume = el('button', 'resume', '恢复接管')
  resume.type = 'button'
  resume.addEventListener('click', (): void => handlers.onSetPause(null))

  actions.append(...presets, resume)
  root.append(head, actions)

  return {
    root,
    apply(model: PopupModel): void {
      state.textContent = model.takeoverStatus
      for (const button of presets) {
        button.hidden = model.takeoverPaused
        button.disabled = !model.takeoverActionable
      }
      resume.hidden = !model.takeoverPaused
      resume.disabled = !model.takeoverActionable
    }
  }
}

/**
 * 一行资源:文件名 + 类型徽章 + 大小 + 下载按钮(DESIGN §7 第 4 条)。
 *
 * **完整 URL 只走原生 `title` tooltip**:长 URL 会撑爆 380px,且 URL 本身对判断「下不下」
 * 几乎没帮助。文件名靠 CSS 截断,**不截字符串** —— 截过的字符串连 tooltip 都救不回来。
 *
 * ⚠️ **`initiator` 一个字都不进 DOM**:它只活在闭包里,点击时原样交回装配点。
 */
function createResourceRow(row: SniffRow, handlers: PopupHandlers): HTMLElement {
  const wrap = el('div', 'res-item')

  const line = el('div', 'res-row')
  const name = el('span', 'res-name', row.name)
  name.title = row.url

  const button = el('button', 'res-download', row.actionLabel)
  button.type = 'button'
  button.disabled = row.actionDisabled
  button.addEventListener('click', (): void => handlers.onDownload(row))

  line.append(name, el('span', 'res-badge', row.badge), el('span', 'res-size', row.size), button)
  wrap.append(line)

  // 「已聚合 N 片」与失败那行实话:空串即不建元素(**空串即隐藏**,不留空盒子)
  for (const [className, text] of [
    ['res-note', row.note],
    ['res-error', row.error]
  ] as const) {
    if (text !== '') wrap.append(el('div', className, text))
  }
  return wrap
}

/**
 * 资源区的 body —— **整块重建**,输入即 `SniffSectionsView`,输出即 DOM。
 *
 * 四类内容按固定顺序拼:分组(**空组不渲染**,因为 `sections` 里根本没有空组)→ 分组级分片提示 →
 * 不可下载的提示行(**结构上就没有按钮** —— 我们确实没有可交给 yt-dlp 的 URL,
 * 给按钮就是承诺一件做不到的事)→ 非列表状态。
 */
function renderSniffBody(
  body: HTMLElement,
  view: SniffSectionsView,
  handlers: PopupHandlers
): void {
  const scrollTop = body.scrollTop
  body.textContent = ''

  for (const section of view.sections) {
    const group = el('div', 'res-group')
    group.append(el('div', 'res-group-title', section.title))
    for (const row of section.rows) group.append(createResourceRow(row, handlers))
    if (section.note !== '') group.append(el('div', 'res-group-note', section.note))
    body.append(group)
  }

  for (const notice of view.notices) body.append(el('div', 'res-notice', notice))

  if (view.empty) {
    const empty = el('div', 'res-empty')
    empty.append(el('div', 'res-empty-text', view.empty.text))
    if (view.empty.small !== '') empty.append(el('div', 'res-empty-small', view.empty.small))
    if (view.empty.canReload) {
      // 「强制」二字不是修饰:普通刷新会走缓存,而缓存命中不触发响应头事件 —— 那样刷了也白刷
      const reload = el('button', 'sniff-reload', '强制刷新本页')
      reload.type = 'button'
      reload.addEventListener('click', (): void => handlers.onReloadTab())
      empty.append(reload)
    }
    body.append(empty)
  }

  body.scrollTop = scrollTop
}

/**
 * 区一「本页资源」:标题 + 条数 + 嗅探开关 + 列表 + 底部小字。
 *
 * ★ **条数那一行在开关关着时照样报真数**(形如「已关闭 · 0 条」,2026-08-09 真机验收改):
 *   原先关着一律只说「已关闭」,于是「桶到底清干净没有」在界面上**不可观察** ——
 *   清桶失败会被一句安心的「已关闭」盖住。措辞在数据层算,这里只负责写上去。
 */
function createResources(handlers: PopupHandlers): {
  root: HTMLElement
  apply(model: PopupModel): void
} {
  const root = el('section', 'resources')

  const head = el('div', 'res-head')
  const count = el('span', 'sniff-count')

  const toggleLabel = el('label', 'sniff-toggle')
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.id = 'sniff-enabled'
  toggle.addEventListener('change', (): void => handlers.onToggleSniff(toggle.checked))
  const toggleText = el('span', '', '网页嗅探')
  toggleLabel.append(toggle, toggleText)

  head.append(el('span', 'res-title', '本页资源'), count, toggleLabel)

  const body = el('div', 'res-body')
  const foot = el('div', 'res-foot')

  root.append(head, body, foot)

  return {
    root,
    apply(model: PopupModel): void {
      toggle.checked = model.sniffEnabled
      count.textContent = model.sniffCount
      renderSniffBody(body, model.sniff, handlers)

      // 隐藏计数 / 上限提示 / 缓存边界 —— 同样是「数组 → DOM」
      foot.textContent = ''
      for (const note of model.sniff.footnotes) foot.append(el('div', '', note))
    }
  }
}

/**
 * ★ v0.4 Task 6:整页视频入口 —— 一个按钮 + 一行实话。
 *
 * **按钮文案与可点性都不在这里判**:文案是常量,可点性来自 `model.videoIntentEnabled`
 * (只在发送中为假)。**绝不在这里写「这一页看起来像不像视频页」的判断** ——
 * 那种判断要么要 content script(表外权限),要么是一条我们做不到的启发式(spec §7.4)。
 *
 * 那一行实话**空串即隐藏**,不留空盒子(与 `res-note` / `res-error` 同一手法)。
 */
function createPageVideo(handlers: PopupHandlers): {
  root: HTMLElement
  apply(model: PopupModel): void
} {
  const root = el('section', 'page-video')

  const button = el('button', 'page-video-go', '用 DownLord 下载此页视频')
  button.type = 'button'
  button.addEventListener('click', (): void => handlers.onDownloadPageVideo())

  const message = el('div', 'page-video-msg')
  root.append(button, message)

  return {
    root,
    apply(model: PopupModel): void {
      button.disabled = !model.videoIntentEnabled
      message.textContent = model.videoIntentMessage
      message.hidden = model.videoIntentMessage === ''
    }
  }
}

export function renderPopup(
  root: HTMLElement,
  model: PopupModel,
  handlers: PopupHandlers
): PopupHandle {
  root.textContent = ''

  // ── 区零:整页视频入口(v0.4 Task 6)────────────────────────────────
  //   放在最上面是因为它**与嗅探无关也不依赖嗅探开关**:用户想下这一页的视频时,
  //   第一眼就该看见它;而资源列表要开了嗅探、刷过页才有内容。
  const pageVideo = createPageVideo(handlers)

  // ── 区一:本页资源 ────────────────────────────────────────────────
  const resources = createResources(handlers)

  // ── 区二:接管状态(常驻一行)+ 连接结论(仅异常时提升为常驻行)────
  const takeover = createTakeover(handlers)
  const connectionAlert = el('div', 'connection-alert')

  // ── 区三:诊断信息(原生 <details>,零 JS 折叠逻辑、零新增状态)────
  const diag = document.createElement('details')
  diag.className = 'diag'
  const summary = document.createElement('summary')
  summary.textContent = '诊断信息'
  const diagBody = el('div', 'diag-body')

  const form = el('form', 'pair')

  const port = createField('port', '端口')
  port.input.inputMode = 'numeric'
  port.input.autocomplete = 'off'
  port.input.value = model.portValue

  const token = createField('token', '配对码')
  // 配对码是身份凭证,默认不明文显示;旁边给一个「显示」开关供用户自查粘对了没
  token.input.type = 'password'
  token.input.autocomplete = 'off'
  token.input.placeholder = model.paired
    ? '留空 = 沿用已保存的配对码'
    : '在 DownLord 里点「复制」后粘贴'

  const reveal = el('button', 'reveal', '显示')
  reveal.type = 'button'
  reveal.addEventListener('click', (): void => {
    const revealed = token.input.type === 'password'
    token.input.type = revealed ? 'text' : 'password'
    reveal.textContent = revealed ? '隐藏' : '显示'
  })
  token.field.append(reveal)

  const submit = el('button', 'submit', '保存并连接')
  submit.type = 'submit'

  form.append(port.field, token.field, submit)
  form.addEventListener('submit', (event: Event): void => {
    event.preventDefault()
    handlers.onSubmit({ token: token.input.value, port: port.input.value })
  })

  const status = el('div', 'status', model.connection)
  const message = el('div', 'message')

  const list = el('div', 'rows')
  // ⚠️ 行标签是「配对码」不是「配对状态」:这一行只回答「本机存没存过这串码」,
  //    **不回答「配对成没成」**——那是上面结果行的活(popupModel 的 pairingStatus 注释有原委)。
  const pairingStatusEl = appendRow(list, '配对码', model.pairingStatus)
  const versionEl = appendRow(list, '扩展版本', model.version)
  const extensionIdEl = appendRow(list, '扩展 ID', model.extensionId)
  // ★ v0.4 Task 5:构建标记(#53)。**显示的是 popup 自己那份**,是否与后台一致由下面那行说 ——
  //   两个产物、两份标记,只显示一份等于什么都没证明。
  const buildIdEl = appendRow(list, '构建标记', model.buildId)
  const wakeCountEl = appendRow(list, '唤醒计数', model.wakeCount)
  const lastEventEl = appendRow(list, '最近事件', model.lastEvent)

  /** 版本不一致的告警行 —— 一致时整行 `hidden`,不留一个空盒子在那儿 */
  const buildIdWarning = el('div', 'buildid-warning')

  diagBody.append(form, status, message, list, buildIdWarning)
  diag.append(summary, diagBody)

  function apply(next: PopupModel): void {
    pageVideo.apply(next)
    resources.apply(next)
    takeover.apply(next)
    connectionAlert.textContent = next.connectionAlert
    connectionAlert.hidden = next.connectionAlert === ''
    status.textContent = next.connection
    pairingStatusEl.textContent = next.pairingStatus
    versionEl.textContent = next.version
    extensionIdEl.textContent = next.extensionId
    buildIdEl.textContent = next.buildId
    wakeCountEl.textContent = next.wakeCount
    lastEventEl.textContent = next.lastEvent
    buildIdWarning.textContent = next.buildIdWarning
    buildIdWarning.hidden = !next.buildIdMismatch
  }
  apply(model)

  root.append(pageVideo.root, resources.root, takeover.root, connectionAlert, diag)

  return {
    update: apply,
    setMessage(text: string): void {
      message.textContent = text
    }
  }
}
