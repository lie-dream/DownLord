/**
 * 接管确认小窗口的 `BrowserWindow` 生命周期(v0.4 Task 4 · spec §3.4)。
 *
 * ★ **全 takeover 模块中唯一 `import electron` 的文件** —— 规则 / 缓冲 / 编排三层保持纯函数
 *   与依赖注入,单测无需真 `BrowserWindow`(spec §3.4 / plan 2.3)。
 *
 * 两条与主窗口刻意不同的地方:
 * - `setWindowOpenHandler` **一律 deny**(主窗口放行 http(s) 到系统浏览器;小窗口零放行)——
 *   它显示的内容来自一条不可信链条(网页 → 浏览器 → 扩展 → 通道),不给任何外跳能力。
 * - `additionalArguments` 打窗口标记,preload 据此只暴露 `takeoverApi`(spec §3.6)。
 *   `sandbox: true` 与主窗口**逐字一致**,不因构建便利降级(spec §3.6 末,已显式排除)。
 *
 * ★ **`show()` + `focus()` 只发生在「有内容可呈现」时**(`showOnce`),不在 `ready-to-show`:
 *   窗口在受理后即被预热(隐藏加载),500ms 聚合窗口结束才带着内容出现 —— 用户看不到空帧,
 *   也不会被一个还没内容的框抢走焦点。同窗换内容时**不再 focus**(DESIGN §4 克制 (d))。
 */
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { TAKEOVER_WINDOW_ARG } from '../../shared/ipc'
import type { TakeoverWindowHandle } from './takeoverService'

/** 当前可用的接管小窗口:`close()` 或 `closed` 时清空,故「窗口存在」= 这个引用非 null(spec §3.4「复用」) */
let takeoverWindow: BrowserWindow | null = null

/**
 * 所有由本模块创建过的接管窗口(含**正在关闭**的那个)。
 *
 * 与 `takeoverWindow` 分开的理由:关窗后要**立刻**断开复用引用(免得新一批被送进一个正在关的窗口),
 * 但 `isTakeoverWindow` 在窗口真正销毁前必须仍认得它 —— 否则 `canPresent` 第③条会把一个正在关的
 * 小窗口误当成「主窗口还在」。
 */
const knownTakeoverWindows = new WeakSet<BrowserWindow>()

/** 当前接管小窗口;不存在时为 `null` */
export function getTakeoverWindow(): BrowserWindow | null {
  return takeoverWindow
}

/**
 * 这个窗口是不是接管小窗口。
 *
 * 供 `canPresent()` 第③条判「主窗口还在不在」:`getAllWindows()` 里除掉接管小窗口后还有窗口,
 * 才说明主窗口没关(**不碰 `createWindow` / `window-all-closed`,那两段一字不改**)。
 */
export function isTakeoverWindow(win: BrowserWindow): boolean {
  return knownTakeoverWindows.has(win)
}

/**
 * 创建接管确认小窗口,返回注入给 `TakeoverService` 的最小操作面。
 *
 * **已存在时直接复用**(不新建、不重载)—— 换内容只走 `send`,避免闪烁与焦点抖动。
 */
export function createTakeoverWindowHandle(): TakeoverWindowHandle {
  const win =
    takeoverWindow && !takeoverWindow.isDestroyed() ? takeoverWindow : createTakeoverWindow()

  /** 本窗口是否已经 `show()` 过 —— 一次呈现只 focus 一次 */
  let shown = false

  return {
    send(channel: string, payload: unknown): void {
      if (win.isDestroyed()) return
      // ★ 定向:直投这一个窗口的 webContents,不经 getAllWindows() 遍历(spec §3.7)
      win.webContents.send(channel, payload)
    },
    showOnce(): void {
      if (win.isDestroyed() || shown) return
      shown = true
      // 沿用 `second-instance` 的两步手法(最小化时必须先 restore),但**对象是本窗口**:
      // 主窗口全程不 show / 不 focus / 不 restore / 不 flashFrame(DESIGN §4 克制 (a))
      if (win.isMinimized()) win.restore()

      // ★ 2026-08-02 真机修复:Windows 的**前台锁定**会拒绝后台进程的 `SetForegroundWindow`,
      //   并**自动闪烁任务栏按钮**代替 —— 用户看到的是「小窗口偷偷在别的窗口后面启动 + 任务栏
      //   红色闪烁」。(重启 DownLord 后必现;在 DownLord 上点过几次之后又不复现 —— 正是前台
      //   锁定「最近有用户交互的进程才给前台权」的表现。)
      //   故用**瞬时置顶**把窗口提到 z 序顶端后立刻取消:这**不是** `alwaysOnTop`
      //   (DESIGN §4 克制 (b) 仍成立)—— 取消之后用户可以立刻切走、别的窗口能盖住它,
      //   只是这一次呈现真的出现在眼前。闪烁由此消失(不再触发 OS 的 flash 兜底)。
      win.setAlwaysOnTop(true)
      win.show()
      win.focus()
      win.setAlwaysOnTop(false)
    },
    setContentHeight(height: number): void {
      if (win.isDestroyed()) return
      // 宽度恒 460 不变 —— 「460px 固定小框」是形态本身,只有高度随内容走(spec §4.4)。
      // 用 setContentSize(而非 setSize):frameless 窗口下二者接近,但内容尺寸才是 CSS 认的那个。
      const [width] = win.getContentSize()
      if (win.getContentSize()[1] === height) return // 同高不动,免得换批次时抖一下
      win.setContentSize(width, height)
    },
    close(): void {      // ★ 立刻断开复用引用:关窗与 `closed` 事件之间有一小段时间差,期间来的新一批必须开新窗口,
      //   而不是被送进这个正在关的窗口(那会静默丢内容)。`isTakeoverWindow` 仍认得它。
      if (takeoverWindow === win) takeoverWindow = null
      if (!win.isDestroyed()) win.close()
    },
    isDestroyed(): boolean {
      return win.isDestroyed()
    },
    webContentsId(): number | null {
      return win.isDestroyed() ? null : win.webContents.id
    },
    onClosed(callback: () => void): void {
      win.on('closed', callback)
    }
  }
}

function createTakeoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 300, // 态 A 固定高;态 B / C 的 setContentSize 归 Phase 3(spec §4.4)
    show: false, // ★ 由 showOnce() 在「有内容」时才显示,不在 ready-to-show
    frame: false, // 与主窗一致:.dialog-head 自带 ×,零新造 chrome
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false, // ★ 任务栏可见 —— 用户切走后能找回(不置顶的代价由它补回,spec §3.4)
    autoHideMenuBar: true,
    webPreferences: {
      // ★ 与主窗口**同一个 preload 文件**;靠 additionalArguments 的标记在文件内分支暴露
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [TAKEOVER_WINDOW_ARG],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  takeoverWindow = win
  knownTakeoverWindows.add(win)

  // 主窗口放行 http(s) 到系统浏览器;这里**零放行**(spec §3.4)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // 加载失败时窗口会一直隐藏着不出现(它只在有内容时 show)—— 如实记一条,别让它无声消失
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[takeover] 确认窗口加载失败(${code} ${desc})`)
  })

  win.on('closed', () => {
    // 清引用:此后 getTakeoverWindow() 为 null,服务据此判「窗口不存在 → 新建」
    if (takeoverWindow === win) {
      takeoverWindow = null
    }
  })

  // 加载两态,与主窗 `index.ts` 同构(dev 走 vite dev server,打包走 file://)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/takeover.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/takeover.html'))
  }

  return win
}
