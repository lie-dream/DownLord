/// <reference types="node" />

/**
 * 「浏览器扩展」分组组件测试(v0.4 Task 3 · spec §7.1 组件测试清单)。
 *
 * 覆盖:两行状态 × 服务三态 × 扩展三态的回显 / ★ 配对码默认遮蔽(**DOM 里不出现明文 token**)/
 * 「复制」调用 navigator.clipboard.writeText / ★ 改端口成功后「扩展里的端口也要改成 N」提示出现 /
 * 「重新生成」走 confirm 且完成提示出现 / `exists:false` 显示「未找到扩展目录」而非空白。
 *
 * 桩语义贴主进程(spec §5.2 / §5.3):端口非法**整体不落盘**并回 `invalid_port:<code>`(端口保持原值);
 * 合法则落盘并回新端口。渲染层不自己判端口 —— 测试也据此只断言「回显主进程结论」。
 */

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DownLordApi,
  ExtensionChannelConfig,
  ExtensionChannelConfigPatch,
  ExtensionChannelStatus,
  ExtensionSideloadInfo,
  TakeoverPausePatch,
  TakeoverSettingsPatch,
  TakeoverSettingsView
} from '../../../shared/ipc'
import { Ctx as ToastCtx } from '../state/toastStore'
import ExtensionChannelSettings from './ExtensionChannelSettings'

/** 64 位小写 hex,与主进程 generateToken 同形;用于「DOM 里不出现明文」断言 */
const TOKEN = 'a1b2c3d4'.repeat(8)

/** 本轮渲染收到的 toast 文案(操作级反馈走 toast,与 v0.2 Task 5 复制下载链接同一先例) */
let toasts: string[] = []

afterEach(() => {
  cleanup()
  toasts = []
  delete (navigator as { clipboard?: unknown }).clipboard
})

/** 组件用 useToast,须在 Provider 内;这里注入捕获桩,便于断言反馈文案 */
function renderPanel(): ReturnType<typeof render> {
  return render(
    <ToastCtx.Provider value={{ showToast: (text: string) => toasts.push(text) }}>
      <ExtensionChannelSettings />
    </ToastCtx.Provider>
  )
}

/** 固定「现在」:接管的「剩余 N 分钟(至 HH:MM)」要可断言,故不用真实时钟造 pausedUntil */
const NOW = new Date(2026, 7, 3, 14, 30).getTime()

/** 接管配置默认快照(**默认开** —— 装了扩展即视为授权) */
function takeoverView(over: Partial<TakeoverSettingsView> = {}): TakeoverSettingsView {
  return { enabled: true, pausedUntil: null, paused: false, excludedDomains: [], ...over }
}

function status(over: Partial<ExtensionChannelStatus> = {}): ExtensionChannelStatus {  return {
    enabled: false,
    service: 'stopped',
    port: 52330,
    lastError: null,
    link: 'unpaired',
    lastHandshakeAt: null,
    ...over
  }
}

interface Captures {
  patches: ExtensionChannelConfigPatch[]
  regenerated: number
  shown: string[]
  unsubscribed: number
  push: ((s: ExtensionChannelStatus) => void) | null
  /** 接管配置写入口的捕获(v0.4 Task 4 Step 6a) */
  takeoverPatches: TakeoverSettingsPatch[]
  pausePatches: TakeoverPausePatch[]
  takeoverUnsubscribed: number
  pushTakeover: ((t: TakeoverSettingsView) => void) | null
}

function setupApi(
  over: Partial<DownLordApi> = {},
  init: {
    status?: ExtensionChannelStatus
    sideload?: ExtensionSideloadInfo
    takeover?: TakeoverSettingsView
  } = {}
): Captures {
  const caps: Captures = {
    patches: [],
    regenerated: 0,
    shown: [],
    unsubscribed: 0,
    push: null,
    takeoverPatches: [],
    pausePatches: [],
    takeoverUnsubscribed: 0,
    pushTakeover: null
  }
  let current = init.status ?? status()
  // 桩 = 主进程 TakeoverService 语义:写后回**写后快照**,域名归一在主进程(此处照做一次)
  let tk = init.takeover ?? takeoverView()
  const api = {
    getExtensionChannelConfig: async (): Promise<ExtensionChannelConfig> => ({
      enabled: current.enabled,
      port: current.port,
      token: TOKEN
    }),
    getExtensionChannelStatus: async (): Promise<ExtensionChannelStatus> => current,
    getExtensionSideloadInfo: async (): Promise<ExtensionSideloadInfo> =>
      init.sideload ?? { dir: 'D:/DownLord/extension/dist', exists: true },
    // 桩 = 主进程 setConfig 语义:端口非法整体不落盘 + 回 invalid_port:<code>;合法则落新端口
    setExtensionChannelConfig: async (
      patch: ExtensionChannelConfigPatch
    ): Promise<ExtensionChannelStatus> => {
      caps.patches.push(patch)
      if (!Number.isInteger(patch.port)) {
        current = { ...current, lastError: 'invalid_port:not_integer' }
        return current
      }
      if (patch.port >= 52301 && patch.port <= 52320) {
        current = { ...current, lastError: 'invalid_port:reserved_bt' }
        return current
      }
      current = {
        ...current,
        enabled: patch.enabled,
        port: patch.port,
        lastError: null,
        service: patch.enabled ? 'listening' : 'stopped'
      }
      return current
    },
    regenerateExtensionToken: async (): Promise<ExtensionChannelConfig> => {
      caps.regenerated += 1
      return { enabled: current.enabled, port: current.port, token: 'f'.repeat(64) }
    },
    onExtensionChannelStatusChanged: (cb: (s: ExtensionChannelStatus) => void): (() => void) => {
      caps.push = cb
      return () => {
        caps.unsubscribed += 1
        caps.push = null
      }
    },
    showItemInFolder: async (p: string): Promise<string> => {
      caps.shown.push(p)
      return ''
    },
    getTakeoverConfig: async (): Promise<TakeoverSettingsView> => tk,
    setTakeoverConfig: async (patch: TakeoverSettingsPatch): Promise<TakeoverSettingsView> => {
      caps.takeoverPatches.push(patch)
      tk = {
        ...tk,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.excludedDomains === undefined
          ? {}
          : { excludedDomains: patch.excludedDomains.map((d) => d.toLowerCase()) })
      }
      return tk
    },
    setTakeoverPause: async (patch: TakeoverPausePatch): Promise<TakeoverSettingsView> => {
      caps.pausePatches.push(patch)
      // ★ 用**真实时钟**,与主进程 `now + minutes` 逐字同构 —— 用固定 NOW 会让「剩余 N 分钟」
      //   永远算不出真值,那条回归断言(必须是 60 不是 61)就守不住任何东西
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
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  return caps
}

/** 注入可捕获的剪贴板(jsdom 无 navigator.clipboard) */
function stubClipboard(): string[] {
  const written: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (t: string): Promise<void> => {
        written.push(t)
      }
    },
    configurable: true
  })
  return written
}

// ---------------- 第一行:服务状态三态 ----------------

test('第一行 listening:显示「监听中 · 127.0.0.1:端口」', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', port: 52330 }) })
  renderPanel()
  assert.ok(await screen.findByText(/本地通道:监听中 · 127\.0\.0\.1:52330/))
})

test('第一行 port_in_use:显示占用文案 + 就近给「改端口」入口', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'port_in_use', lastError: 'EADDRINUSE' }) })
  renderPanel()
  assert.ok(await screen.findByText(/本地通道:端口 52330 被占用,通道未启动/))
  assert.ok(screen.getByText('改端口'))
})

test('第一行 stopped:显示「已关闭」,且不显示「改端口」入口', async () => {
  setupApi({}, { status: status({ enabled: false, service: 'stopped' }) })
  renderPanel()
  assert.ok(await screen.findByText(/本地通道:已关闭/))
  assert.equal(screen.queryByText('改端口'), null)
})

test('★ stopped + lastError(EACCES):显示「未启动(EACCES)」,不被「已关闭」掩盖', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'stopped', lastError: 'EACCES' }) })
  renderPanel()
  assert.ok(await screen.findByText(/本地通道:未启动\(EACCES\)/))
  assert.equal(screen.queryByText(/本地通道:已关闭/), null)
})

// ---------------- 第二行:扩展三态 ----------------

test('第二行 unpaired:「未配对」+ 只说「本次启动以来尚未收到握手」(不谎称未安装 / 未配对成功)', async () => {
  setupApi({}, { status: status({ link: 'unpaired' }) })
  renderPanel()
  assert.ok(await screen.findByText(/浏览器扩展:未配对/))
  assert.ok(screen.getByText(/本次启动以来尚未收到扩展的握手/))
  assert.equal(screen.queryByText(/未安装/), null)
})

test('第二行 connected:「已连接」并附最近握手时间', async () => {
  const at = new Date(2026, 6, 31, 14, 5).getTime()
  setupApi(
    {},
    { status: status({ enabled: true, service: 'listening', link: 'connected', lastHandshakeAt: at }) }
  )
  renderPanel()
  assert.ok(await screen.findByText(/浏览器扩展:已连接\(最近握手 2026-07-31 14:05\)/))
})

test('★ 第二行 idle_pending:文案是「待活动」,**绝不出现「断开」**', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'idle_pending' }) })
  renderPanel()
  assert.ok(await screen.findByText(/浏览器扩展:待活动/))
  assert.ok(screen.getByText(/已握手过,但最近一段时间没有新活动/))
  assert.equal(document.body.textContent?.includes('断开'), false)
})

test('两行状态是**两行**、不合并:服务态与扩展态各占一个 .up-note', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'unpaired' }) })
  renderPanel()
  await screen.findByText(/本地通道:监听中/)
  const lines = document.querySelectorAll('.up-note')
  assert.equal(lines.length, 2)
})

test('状态广播(onExtensionChannelStatusChanged)驱动两行刷新;卸载即退订', async () => {
  const caps = setupApi()
  const view = renderPanel()
  await screen.findByText(/本地通道:已关闭/)

  caps.push?.(status({ enabled: true, service: 'listening', link: 'connected', lastHandshakeAt: 1 }))
  await waitFor(() => assert.ok(screen.getByText(/本地通道:监听中/)))

  view.unmount()
  assert.equal(caps.unsubscribed, 1)
})

// ---------------- 开关 ----------------

test('开关默认关;点开 → setExtensionChannelConfig({enabled:true,当前端口})', async () => {
  const caps = setupApi()
  renderPanel()
  const sw = await screen.findByRole('switch', { name: '启用本地通道' })
  assert.equal(sw.getAttribute('aria-checked'), 'false')
  // 关闭态追加「关闭后……配对码仍有效」说明
  assert.ok(screen.getByText(/已配对的配对码仍有效,重新启用即可继续用/))

  fireEvent.click(sw)
  await waitFor(() => assert.deepEqual(caps.patches.at(-1), { enabled: true, port: 52330 }))
  await waitFor(() => assert.equal(sw.getAttribute('aria-checked'), 'true'))
})

// ---------------- 配对码 ----------------

test('★ 配对码默认遮蔽:DOM 里不出现明文 token;点「显示」后才出现', async () => {
  setupApi()
  renderPanel()
  await screen.findByText('配对码')

  assert.equal(document.body.innerHTML.includes(TOKEN), false, 'DOM 不得含明文 token')
  assert.ok(document.querySelector('.ec-token code')?.textContent?.startsWith('•'))

  fireEvent.click(screen.getByText('显示'))
  await waitFor(() => assert.ok(document.body.innerHTML.includes(TOKEN)))
  fireEvent.click(screen.getByText('隐藏'))
  await waitFor(() => assert.equal(document.body.innerHTML.includes(TOKEN), false))
})

test('「复制」调用 navigator.clipboard.writeText(token),反馈走 toast', async () => {
  const written = stubClipboard()
  setupApi()
  renderPanel()
  await screen.findByText('配对码')

  fireEvent.click(screen.getByText('复制'))
  await waitFor(() => assert.deepEqual(written, [TOKEN]))
  await waitFor(() => assert.deepEqual(toasts, ['已复制配对码']))
})

test('★ 「重新生成」走**行内**二次确认(不碰 window.confirm);取消则不调 IPC', async () => {
  // 原生 confirm 会让 document 失焦,导致确认完第一次点「复制」必失败(2026-07-31 手测 4b)。
  // 这里把 window.confirm 换成会让测试失败的哨兵:一旦组件回头去调它,断言当场红。
  const nativeCalls: string[] = []
  Object.defineProperty(window, 'confirm', {
    value: (msg?: string) => {
      nativeCalls.push(msg ?? '')
      return true
    },
    configurable: true
  })
  const caps = setupApi()
  renderPanel()
  await screen.findByText('配对码')

  fireEvent.click(screen.getByText('重新生成'))
  // 确认横幅就地出现,且**没有**弹原生模态
  assert.ok(await screen.findByText(/旧配对会立即失效,已配对的扩展需要重新粘一次新配对码/))
  assert.deepEqual(nativeCalls, [], '不得调用 window.confirm')
  assert.equal(caps.regenerated, 0)

  fireEvent.click(screen.getByText('取消'))
  await waitFor(() =>
    assert.equal(screen.queryByText(/旧配对会立即失效/), null)
  )
  assert.equal(caps.regenerated, 0)
})

test('★ 行内确认点「确定重新生成」:调 IPC + 完成提示走 toast', async () => {
  const caps = setupApi()
  renderPanel()
  await screen.findByText('配对码')

  fireEvent.click(screen.getByText('重新生成'))
  fireEvent.click(await screen.findByText('确定重新生成'))

  await waitFor(() => assert.equal(caps.regenerated, 1))
  await waitFor(() => assert.deepEqual(toasts, ['已生成新配对码,请到扩展里重新粘一次']))
  // 确认横幅收起
  assert.equal(screen.queryByText(/旧配对会立即失效/), null)
})

test('重新生成后新 token 仍遮蔽(明文显示态被收回)', async () => {
  setupApi()
  renderPanel()
  await screen.findByText('配对码')

  fireEvent.click(screen.getByText('显示'))
  await waitFor(() => assert.ok(document.body.innerHTML.includes(TOKEN)))

  fireEvent.click(screen.getByText('重新生成'))
  fireEvent.click(await screen.findByText('确定重新生成'))
  await waitFor(() => assert.ok(screen.getByText('显示')))
  assert.equal(document.body.innerHTML.includes('f'.repeat(64)), false)
})

// ---------------- 端口 ----------------

test('★ 改端口成功:走 toast 提醒 + 端口块下方留常驻只读行(2026-07-31 用户改判,不再要点「我知道了」)', async () => {
  // 原设计是不可自动消失的行内横幅(spec §4.4 ★)。用户手测后改判:每改一次端口就要点一遍
  // 「我知道了」代价大于收益 → 改为 toast(当场看见)+ 常驻只读行(事后回来还看得见)。
  // §4.4 的**本意**仍要守住:扩展读不了本机文件、不会自动跟上,这件事不能只靠一闪而过的提示。
  const caps = setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement
  assert.equal(input.value, '52330')

  // 默认端口下**不显示**常驻行 —— 没改过就没有「两侧要对齐」这件事
  assert.equal(screen.queryByText(/扩展里的端口也要填/), null)

  fireEvent.change(input, { target: { value: '52340' } })
  fireEvent.click(screen.getByText('重新绑定'))

  await waitFor(() => assert.deepEqual(caps.patches.at(-1), { enabled: false, port: 52340 }))
  // ① toast:带上具体数字,不写「端口已修改」这种没信息量的话
  await waitFor(() =>
    assert.deepEqual(toasts, ['端口已改为 52340 —— 记得把扩展里的端口也改成 52340'])
  )
  // ② 常驻只读行:不需要任何交互,但**不会自动消失**
  assert.ok(await screen.findByText(/当前生效:52340 —— 扩展里的端口也要填 52340/))
  // ③ 原先那个要点掉的横幅已不存在
  assert.equal(screen.queryByText('我知道了'), null)
})

test('★ 常驻端口提示只在非默认端口时出现(默认 52330 不啰嗦)', async () => {
  setupApi({}, { status: status({ port: 52330 }) })
  renderPanel()
  await screen.findByLabelText('本地通道端口')
  assert.equal(screen.queryByText(/扩展里的端口也要填/), null)
})

test('★ 两处行内提示都**跨整行**、不挂在左列 .sr-text 里(2026-07-31 手测 A10 / A6)', async () => {
  // 手测踩到的现象:提示挂在 .sr-text(左列)里,而 .set-row 是 align-items:center、
  // 右列的输入框与按钮**垂直居中** —— 左列一变高,输入框被推到行中间,提示看着比输入框高一截。
  // 这里守的是**结构**(提示必须是 .set-row 的兄弟、且带 .ec-rowmsg),像素与字重 jsdom 测不了。
  setupApi()
  renderPanel()

  const assertFullRow = (el: Element | null, what: string): void => {
    assert.ok(el, `${what}:没找到提示元素`)
    const box = el!.closest('.ec-rowmsg')
    assert.ok(box, `${what}:提示没带 .ec-rowmsg —— 它又被塞回行内了`)
    assert.equal(
      box!.closest('.sr-text'),
      null,
      `${what}:提示仍在左列 .sr-text 里 —— 会比垂直居中的输入框高一截`
    )
    assert.ok(
      box!.parentElement?.classList.contains('set-card'),
      `${what}:提示应与 .set-row 平级(同在 .set-card 下),才能占满整行`
    )
  }

  // ① 未提交脏态
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement
  fireEvent.change(input, { target: { value: '52340' } })
  assertFullRow(await screen.findByText(/还没生效/), '脏态提示')

  // ② 重新生成的行内二次确认
  fireEvent.click(screen.getByText('重新生成'))
  assertFullRow(await screen.findByText(/旧配对会立即失效/), '重新生成确认')
})

test('★ 端口改了但没提交:显示「还没生效」脏态提示,提交后消失', async () => {
  setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement
  assert.equal(screen.queryByText(/还没生效/), null)

  // 只改数字、不点「重新绑定」也不按回车 —— 必须看得见「没生效」(2026-07-31 手测 3)
  fireEvent.change(input, { target: { value: '52340' } })
  assert.ok(await screen.findByText(/端口 52340 还没生效/))
  assert.ok(screen.getByText(/当前生效:52330/))

  fireEvent.click(screen.getByText('重新绑定'))
  await waitFor(() => assert.equal(screen.queryByText(/还没生效/), null))
})

test('端口改回原值:脏态提示自行消失(不需要提交)', async () => {
  setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement

  fireEvent.change(input, { target: { value: '52340' } })
  await screen.findByText(/还没生效/)
  fireEvent.change(input, { target: { value: '52330' } })
  await waitFor(() => assert.equal(screen.queryByText(/还没生效/), null))
})

test('端口落在 BT 已占段:回显主进程 reserved_bt 的具体文案,且不给「端口也要改」提示', async () => {
  setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement

  fireEvent.change(input, { target: { value: '52305' } })
  fireEvent.click(screen.getByText('重新绑定'))

  assert.ok(await screen.findByText(/52301–52320 已被 BT 与 DHT 的监听端口占用/))
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  assert.equal(screen.queryByText(/扩展里的端口也要改成/), null)
})

test('端口填非数字:回显主进程 not_integer 文案(校验结论不在渲染层)', async () => {
  const caps = setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement

  fireEvent.change(input, { target: { value: 'abc' } })
  fireEvent.click(screen.getByText('重新绑定'))

  // 渲染层照样把值交给主进程(不自行拦截),只是转换成 NaN
  await waitFor(() => assert.ok(Number.isNaN(caps.patches.at(-1)?.port)))
  assert.ok(await screen.findByText(/端口必须是整数/))
})

test('开关切换不顺带提交输入框里未确认的端口', async () => {
  const caps = setupApi()
  renderPanel()
  const input = (await screen.findByLabelText('本地通道端口')) as HTMLInputElement

  fireEvent.change(input, { target: { value: '52999' } })
  fireEvent.click(screen.getByRole('switch', { name: '启用本地通道' }))

  await waitFor(() => assert.deepEqual(caps.patches.at(-1), { enabled: true, port: 52330 }))
})

// ---------------- #42 发现引导 ----------------

test('#42 引导:路径框 + 三步 + 诚实边界 + extensions 页地址是可复制文本而非链接(v1.0 Task 3:第 1 步按 M-014 归位、第 2 步按 M-020 补 Chrome)', async () => {
  setupApi()
  renderPanel()
  const dir = (await screen.findByLabelText('扩展目录')) as HTMLInputElement
  assert.equal(dir.value, 'D:/DownLord/extension/dist')
  assert.equal(dir.readOnly, true)

  // v1.0 Task 3 `M-014`:原第 1 步「在上方打开『启用本地通道』开关」已归位到通道状态行,
  // **此处不再重复一份** —— 同一条指令留两处,改一处忘另一处就是下一轮的漂移。
  const steps = document.querySelectorAll('.ec-steps li')
  assert.equal(steps.length, 3)
  assert.equal(
    document.querySelector('.ec-steps')?.textContent?.includes('在上方打开「启用本地通道」开关'),
    false,
    '引导句已归位到通道状态行,安装步骤里不该再有一份'
  )
  assert.ok(steps[0].textContent?.includes('在 Edge 地址栏输入'))
  // v1.0 Task 3 `M-020`:Chrome 是 v1.0 新承诺的浏览器,引导里必须有它的入口 ——
  // 且**是补上、不是替换**,Edge 那半一个字不动(上一条断言即该方向的正向对照)
  assert.ok(steps[0].textContent?.includes('在 Chrome 地址栏输入'))
  assert.ok(steps[1].textContent?.includes('加载解压缩的扩展'))
  assert.ok(steps[2].textContent?.includes('把上面的配对码粘进去'))

  // 两家的 extensions 页地址都只作为可复制文本出现,不是 <a>
  for (const addr of ['edge://extensions/', 'chrome://extensions/']) {
    assert.equal(screen.getByText(addr).tagName, 'CODE', `${addr} 应是可复制的 <code>`)
  }
  assert.equal(document.querySelectorAll('.ec-steps a').length, 0)

  // ★ 诚实边界(v1.0 Task 3 随 M-020 同批订正):Chrome 已实测通过 / Firefox 本版不做,
  //   且**不得出现任何会过期的版本承诺**(原文「留到 v0.5」与 M-001 那句「计划在 v0.3」同类)
  assert.ok(screen.getByText(/Edge 与 Chrome 已实测通过,属承诺范围/))
  assert.ok(screen.getByText(/Firefox 本版不做/))
  const honest = document.querySelector('.ec-honest')?.textContent ?? ''
  assert.equal(/留到 v[0-9]|留 v[0-9]|计划在 v[0-9]/.test(honest), false, '不得含已被推翻的版本承诺')
  assert.equal(honest.includes('未实测、不承诺'), false, 'Chrome 已升为承诺范围,不得再写「不承诺」')
  // 正向对照:收窄边界的那句**必须仍在**(#91:嗅探 / 接管 / cookie 三条通路的浏览器边界挂在它上面)
  assert.ok(honest.includes('不据此宣称全部 Chromium 浏览器已验证'), '边界句不许被删或收窄')
})

test('「复制路径」写剪贴板;「在资源管理器中定位」调 showItemInFolder + 如实说明它开的是上一级', async () => {
  const written = stubClipboard()
  const caps = setupApi()
  renderPanel()
  await screen.findByLabelText('扩展目录')

  fireEvent.click(screen.getByText('复制路径'))
  await waitFor(() => assert.deepEqual(written, ['D:/DownLord/extension/dist']))
  await waitFor(() => assert.deepEqual(toasts, ['已复制扩展目录路径']))

  fireEvent.click(screen.getByText('在资源管理器中定位'))
  await waitFor(() => assert.deepEqual(caps.shown, ['D:/DownLord/extension/dist']))
  // showItemInFolder 打开的是**上一级**并选中 dist —— 行为不改,但必须说清,否则用户以为点错了
  assert.ok(screen.getByText(/会打开上一级目录并选中 dist/))
})

test('★ exists:false → 如实显示「未找到扩展目录」(不静默、不当没事)', async () => {
  setupApi({}, { sideload: { dir: 'D:/DownLord/extension/dist', exists: false } })
  renderPanel()

  assert.ok(await screen.findByText(/未找到扩展目录:D:\/DownLord\/extension\/dist/))
  assert.ok(screen.getByText(/开发态请先跑 npm run build/))
  // 目录不存在时定位按钮不可点(点了也打不开)
  assert.equal((screen.getByText('在资源管理器中定位') as HTMLButtonElement).disabled, true)
})

// ---------------- 下载接管子区(v0.4 Task 4 Step 6a · spec §5.5)----------------

test('① 接管总开关**默认开**,且描述如实说明需要装扩展', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()

  const sw = await screen.findByRole('switch', { name: '下载接管' })
  await waitFor(() => assert.equal(sw.getAttribute('aria-checked'), 'true'))
  assert.ok(screen.getByText(/在浏览器里点下载时,由 DownLord 接管。需要安装并配对浏览器扩展。/))
})

test('① 切总开关 → 上报 {enabled:false},且状态行改显「已关闭」', async () => {
  const caps = setupApi(
    {},
    { status: status({ enabled: true, service: 'listening', link: 'connected' }) }
  )
  renderPanel()

  fireEvent.click(await screen.findByRole('switch', { name: '下载接管' }))
  await waitFor(() => assert.deepEqual(caps.takeoverPatches, [{ enabled: false }]))
  await waitFor(() => assert.ok(screen.getByText('已关闭')))
})

test('② 四态之「接管中」:开着 + 未暂停 + 通道监听中', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()
  assert.ok(await screen.findByText('接管中'))
})

test('★ ② 四态之「通道未启动」:诚实绑在**确实为真**的判据上(不拿「没握手」当「接管不会发生」)', async () => {
  setupApi({}, { status: status({ enabled: false, service: 'stopped', link: 'unpaired' }) })
  renderPanel()
  assert.ok(await screen.findByText('本地通道未启动 · 接管不会发生'))
})

test('★ ② 通道在监听但本次启动未握手:如实陈述、**不下结论**(与「待活动」同一种分不清)', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'unpaired' }) })
  renderPanel()

  assert.ok(await screen.findByText('接管中'))
  assert.ok(screen.getByText(/本次启动以来尚未收到扩展的握手 —— 若还没装扩展/))
  // 不许出现「扩展尚未连接 · 接管不会发生」这种替浏览器打的包票
  assert.equal(document.body.textContent?.includes('扩展尚未连接 · 接管不会发生'), false)
})

test('② 时长档**恰好三档纯时间** + 无「直到关闭浏览器」/「永久暂停」', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()

  assert.ok(await screen.findByText('15 分钟'))
  assert.ok(screen.getByText('1 小时'))
  assert.ok(screen.getByText('4 小时'))
  assert.equal(screen.queryByText(/直到关闭浏览器/), null)
  assert.equal(screen.queryByText(/永久暂停/), null)
})

test('② 点「1 小时」→ 上报 {minutes:60};状态改显「已暂停 · 剩余 N 分钟(至 HH:MM)」;三档换成「恢复接管」', async () => {
  const caps = setupApi(
    {},
    { status: status({ enabled: true, service: 'listening', link: 'connected' }) }
  )
  renderPanel()

  fireEvent.click(await screen.findByText('1 小时'))
  await waitFor(() => assert.deepEqual(caps.pausePatches, [{ minutes: 60 }]))
  // ★★ 回归钉死(2026-08-03 手测):必须是「剩余 60 分钟」,**不是 61**。
  //    旧实现用组件**挂载那一刻**的时刻去减主进程按**点击那一刻**算的 pausedUntil,
  //    差值被 Math.ceil 压成恒 +1 —— 三档一律显示 16 / 61 / 241。
  await waitFor(() =>
    assert.ok(screen.getByText((t) => t.startsWith('已暂停 · 剩余 60 分钟(至 ')))
  )
  // 「至 HH:MM」形状(具体时刻随真实时钟走,只断言格式);用函数匹配器 —— 正则里的全角括号易踩坑
  assert.ok(screen.getByText((t) => /^已暂停 · 剩余 60 分钟.至 \d{2}:\d{2}.$/.test(t)))
  assert.ok(screen.getByText('恢复接管'))
  assert.equal(screen.queryByText('15 分钟'), null)
})

test('② 暂停中点「恢复接管」→ 上报 {minutes:null},三档回来', async () => {
  const caps = setupApi(
    {},
    {
      status: status({ enabled: true, service: 'listening', link: 'connected' }),
      takeover: takeoverView({ pausedUntil: NOW + 60 * 60_000, paused: true })
    }
  )
  renderPanel()

  fireEvent.click(await screen.findByText('恢复接管'))
  await waitFor(() => assert.deepEqual(caps.pausePatches, [{ minutes: null }]))
  await waitFor(() => assert.ok(screen.getByText('15 分钟')))
})

test('★ popup 遥控器写了真源 → 广播推过来,设置页当场跟上(不显示自己最后写的值)', async () => {
  const caps = setupApi(
    {},
    { status: status({ enabled: true, service: 'listening', link: 'connected' }) }
  )
  renderPanel()
  assert.ok(await screen.findByText('接管中'))

  // 模拟 popup 那边设了暂停 → 主进程广播
  caps.pushTakeover?.(takeoverView({ pausedUntil: NOW + 15 * 60_000, paused: true }))
  await waitFor(() => assert.ok(screen.getByText(/^已暂停 · 剩余/)))
})

test('③ 域名例外表:Enter 新增 → 上报整表;× 删除 → 上报去掉那条的整表', async () => {
  const caps = setupApi(
    {},
    {
      status: status({ enabled: true, service: 'listening', link: 'connected' }),
      takeover: takeoverView({ excludedDomains: ['a.com'] })
    }
  )
  renderPanel()

  const input = await screen.findByLabelText('添加不接管的域名')
  fireEvent.change(input, { target: { value: 'https://dl.Example.com/x.zip?t=1' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  // 渲染层只做即时回显用的轻量归一;权威归一在主进程,故这里断言的是「已归一后的整表」
  await waitFor(() =>
    assert.deepEqual(caps.takeoverPatches, [{ excludedDomains: ['a.com', 'dl.example.com'] }])
  )
  await waitFor(() => assert.ok(screen.getByText('dl.example.com')))

  fireEvent.click(screen.getByLabelText('删除 a.com'))
  await waitFor(() => assert.equal(caps.takeoverPatches.length, 2))
  assert.deepEqual(caps.takeoverPatches[1], { excludedDomains: ['dl.example.com'] })
})

test('③ 空输入 / 重复域名不上报(不落一条空规则、不重复)', async () => {
  const caps = setupApi(
    {},
    {
      status: status({ enabled: true, service: 'listening', link: 'connected' }),
      takeover: takeoverView({ excludedDomains: ['a.com'] })
    }
  )
  renderPanel()

  const input = await screen.findByLabelText('添加不接管的域名')
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'A.COM' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => assert.deepEqual(caps.takeoverPatches, []))
})

test('★ 界面隔离硬约束:接管子区**一个字都不提「文件类型 / 扩展名」**,也没有扩展名输入框', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()
  await screen.findByText('接管中')

  const card = document.querySelector('.ec-takeover') as HTMLElement
  assert.ok(card, '接管子区必须存在')
  assert.equal(card.textContent?.includes('文件类型'), false)
  assert.equal(card.textContent?.includes('扩展名'), false)
  assert.equal(card.querySelector('[aria-label="添加扩展名"]'), null)
  // 域名例外表只收域名
  assert.ok(card.querySelector('[aria-label="添加不接管的域名"]'))
})

test('★ 每个 .set-row 都带 .sr-icon 空占位(缺了整段文字会左移 34px,2026-07-29 手测踩出)', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()
  await screen.findByText('接管中')

  const rows = document.querySelectorAll('.ec-takeover .set-row')
  assert.equal(rows.length, 3, '接管子区恰好三行')
  for (const row of rows) {
    assert.ok(row.querySelector(':scope > .sr-icon'), '每行首个子元素必须是 .sr-icon 占位')
  }
})

test('卸载即退订接管配置广播(与通道状态广播同一纪律)', async () => {
  const caps = setupApi(
    {},
    { status: status({ enabled: true, service: 'listening', link: 'connected' }) }
  )
  const view = renderPanel()
  await screen.findByText('接管中')
  view.unmount()
  assert.equal(caps.takeoverUnsubscribed, 1)
})

// ==================== v1.0 Task 3 · P2「UI 文案」新增用例 ====================
// 逐字文案真源 = spec §4「如实说清单」;本段全部为**新增**。

test('M-014 引导句只在通道未开时出现且在状态行', async () => {
  setupApi({}, { status: status({ enabled: false, service: 'stopped' }) })
  renderPanel()

  const guide = await screen.findByText(
    '本地通道未启用 —— 扩展的接管 / 嗅探 / Cookie 功能全部不可用。请打开上方「启用本地通道」开关。'
  )
  // ★ 位置:必须挂在**通道状态行**上(与「本地通道:…」那句同一个 .set-row),
  //   不是下方「安装浏览器扩展」卡里 —— 那正是 M-014 要修的错位
  const row = guide.closest('.set-row') as HTMLElement
  assert.ok(row, '引导句应在某个 .set-row 内')
  assert.ok(row.textContent?.includes('本地通道:'), '引导句必须与通道状态同一行')
  assert.equal(guide.closest('.ec-guide'), null, '不得再落在「安装浏览器扩展」卡里')
})

test('M-014 通道已开 → 引导句消失(显示条件不再形同虚设)', async () => {
  setupApi({}, { status: status({ enabled: true, service: 'listening', link: 'connected' }) })
  renderPanel()
  await screen.findByText(/本地通道:监听中/)
  // 此前它恒可见 —— 通道开着的用户照样被要求「去打开通道」,自相矛盾
  assert.equal(screen.queryByText(/请打开上方「启用本地通道」开关/), null)
  assert.equal(
    document.body.textContent?.includes('在上方打开「启用本地通道」开关'),
    false,
    '安装步骤里也不该再留一份'
  )
})

test('M-020 安装引导同时给 Edge 与 Chrome', async () => {
  setupApi()
  renderPanel()
  await screen.findByLabelText('扩展目录')
  const steps = document.querySelector('.ec-steps') as HTMLElement
  const text = steps.textContent ?? ''
  // Chrome 是 v1.0 新承诺的浏览器(D6):按引导找不到入口的用户直接卡在安装第一步
  assert.ok(text.includes('chrome://extensions/'), 'Chrome 的入口必须在')
  // ★ 正向对照:**是补上、不是把 Edge 换掉** —— 只验新增的那一半会漏掉「替换」这种错法
  assert.ok(text.includes('edge://extensions/'), 'Edge 的入口不得被换掉')
})
