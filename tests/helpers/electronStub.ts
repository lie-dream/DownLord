/**
 * `electron` 模块的测试替身(v1.0 Task 1 Phase 2 后半 · 零覆盖清单的 C 类)。
 *
 * 为什么需要它:`src/main/ipc/` 下十个注册模块顶层就 `import { ipcMain } from 'electron'`,而
 * **`npm test` 跑在 electron-as-node 下,`require('electron')` 回的是一个字符串**(可执行文件路径),
 * `ipcMain` / `app` / `BrowserWindow` 全是 `undefined`(2026-08-26 实测:
 * `ELECTRON_RUN_AS_NODE=1 electron -e "console.log(typeof require('electron'))"` → `string`)。
 * 故那十个模块长期零覆盖 —— 不是不可测,是缺一个替身。
 *
 * 用法:与 `betterSqliteStub.ts` 同一手法 —— 测试里劫持 `Module._resolveFilename` 把 `'electron'`
 * 指到本文件,再 `await import('../../src/main/ipc/xxx')`。**产品代码一个字不动。**
 *
 * 🚫 本替身**不模拟 Electron 语义**,只做「记下来谁调了什么」:被测对象是那十个模块的**转发正确性**
 * (通道名对不对、参数有没有原样传、销毁窗口有没有被跳过),不是 Electron 自己。
 */

/** 一次 `webContents.send` 的记录 */
export interface SentMessage {
  /** 收到这条消息的窗口 id */
  windowId: number
  channel: string
  args: unknown[]
}

/** 假窗口:`webContents` 是身份对象,`fromWebContents` 靠它反查 */
export class FakeWindow {
  readonly webContents: { send: (channel: string, ...args: unknown[]) => void }
  destroyed = false
  maximized = false
  readonly calls: string[] = []

  constructor(readonly id: number) {
    this.webContents = {
      send: (channel: string, ...args: unknown[]) => {
        recorder.sent.push({ windowId: this.id, channel, args })
      }
    }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  minimize(): void {
    this.calls.push('minimize')
  }
  maximize(): void {
    this.calls.push('maximize')
    this.maximized = true
  }
  unmaximize(): void {
    this.calls.push('unmaximize')
    this.maximized = false
  }
  isMaximized(): boolean {
    return this.maximized
  }
  close(): void {
    this.calls.push('close')
  }
}

type Handler = (event: unknown, ...args: unknown[]) => unknown
type Listener = (event: unknown, ...args: unknown[]) => void

/** 全部记录集中一处,测试用 `resetElectronStub()` 在每个用例开头清空 */
export const recorder = {
  /** `ipcMain.handle` 注册表:通道名 → handler */
  handlers: new Map<string, Handler>(),
  /** `ipcMain.on` 注册表:通道名 → listener */
  listeners: new Map<string, Listener>(),
  /** `nativeTheme.on` 注册表 */
  themeListeners: new Map<string, () => void>(),
  /** 所有 `webContents.send` */
  sent: [] as SentMessage[],
  /** `BrowserWindow.getAllWindows()` 返回的窗口 */
  windows: [] as FakeWindow[],
  /** `shell.openPath` / `shell.showItemInFolder` 调用记录 */
  shellCalls: [] as string[],
  /** `shell.openPath` 的返回值(空串 = 成功) */
  openPathResult: '',
  /** `app.getPath(name)` 的映射 */
  appPaths: { downloads: 'D:\\Downloads' } as Record<string, string>,
  appVersion: '1.0.0',
  /** `ipcRenderer.invoke` 调用记录(preload 侧) */
  invokes: [] as Array<{ channel: string; args: unknown[] }>,
  /** `ipcRenderer.send` 调用记录 */
  sends: [] as Array<{ channel: string; args: unknown[] }>,
  /** `ipcRenderer.on` / `removeListener` 记录 */
  rendererListeners: [] as Array<{ channel: string; op: 'on' | 'removeListener' }>,
  /** `contextBridge.exposeInMainWorld` 记录 */
  exposed: [] as Array<{ key: string; value: unknown }>
}

export function resetElectronStub(): void {
  recorder.handlers.clear()
  recorder.listeners.clear()
  recorder.themeListeners.clear()
  recorder.sent.length = 0
  recorder.windows.length = 0
  recorder.shellCalls.length = 0
  recorder.openPathResult = ''
  recorder.appPaths = { downloads: 'D:\\Downloads' }
  recorder.appVersion = '1.0.0'
  recorder.invokes.length = 0
  recorder.sends.length = 0
  recorder.rendererListeners.length = 0
  recorder.exposed.length = 0
  nativeTheme.shouldUseDarkColors = false
  nativeTheme.themeSource = 'system'
}

/** 取某通道的 handler;取不到就抛 —— 「通道没注册」必须是红,不是 undefined 往下漂 */
export function invokeHandler(channel: string, ...args: unknown[]): unknown {
  const fn = recorder.handlers.get(channel)
  if (!fn) throw new Error(`通道未注册(ipcMain.handle):${channel}`)
  return fn({}, ...args)
}

/** 触发某通道的单向监听器;`sender` 用于 `BrowserWindow.fromWebContents` 反查 */
export function emitListener(channel: string, sender: unknown): void {
  const fn = recorder.listeners.get(channel)
  if (!fn) throw new Error(`通道未注册(ipcMain.on):${channel}`)
  fn({ sender })
}

// ==================== 以下是 `electron` 的导出面 ====================

export const ipcMain = {
  handle(channel: string, fn: Handler): void {
    if (recorder.handlers.has(channel)) {
      // 同一通道注册两次在真 Electron 里会抛,这里也不许静默覆盖 —— 那是真 bug 的形状
      throw new Error(`通道重复注册:${channel}`)
    }
    recorder.handlers.set(channel, fn)
  },
  on(channel: string, fn: Listener): void {
    recorder.listeners.set(channel, fn)
  }
}

export const BrowserWindow = {
  getAllWindows(): FakeWindow[] {
    return recorder.windows
  },
  fromWebContents(sender: unknown): FakeWindow | null {
    return recorder.windows.find((w) => w.webContents === sender) ?? null
  }
}

export const app = {
  getVersion(): string {
    return recorder.appVersion
  },
  getPath(name: string): string {
    return recorder.appPaths[name] ?? `<unknown:${name}>`
  }
}

export const shell = {
  async openPath(p: string): Promise<string> {
    recorder.shellCalls.push(`openPath:${p}`)
    return recorder.openPathResult
  },
  showItemInFolder(p: string): void {
    recorder.shellCalls.push(`showItemInFolder:${p}`)
  }
}

export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: 'system' as 'system' | 'light' | 'dark',
  on(event: string, fn: () => void): void {
    recorder.themeListeners.set(event, fn)
  },
  /** 测试侧手动触发 `updated`(真 Electron 里由系统主题切换触发) */
  fireUpdated(): void {
    recorder.themeListeners.get('updated')?.()
  }
}

// ==================== 渲染侧(preload 用)====================

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    recorder.invokes.push({ channel, args })
    return undefined
  },
  send(channel: string, ...args: unknown[]): void {
    recorder.sends.push({ channel, args })
  },
  on(channel: string, _fn: (...a: unknown[]) => void): void {
    recorder.rendererListeners.push({ channel, op: 'on' })
  },
  removeListener(channel: string, _fn: (...a: unknown[]) => void): void {
    recorder.rendererListeners.push({ channel, op: 'removeListener' })
  }
}

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    recorder.exposed.push({ key, value })
  }
}
