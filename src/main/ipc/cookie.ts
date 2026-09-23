/**
 * 暂借登录态 IPC handler — 接线持有层与渲染进程(v0.4 Task 6 · spec §6.4)。
 *
 * - `cookie:getBorrowedHosts`:invoke/handle,取当前持有的**域列表**(设置页可见行挂载时读);
 * - `cookie:clearBorrowed`:invoke/handle,清空持有层 → 回写后快照(恒 `{hosts:[]}`);
 * - `cookie:borrowedChanged`:main→renderer 主动推,`cookie.offer` 受理后广播最新域列表。
 *
 * 🔴 **三条通道的载荷类型都是 `BorrowedCookieHosts`,它只有一个 `hosts` 字段** ——
 * 「渲染层看不到 cookie 值」(红线 R3)因此是**接口形状的后果**,不是一条需要人去遵守的纪律。
 * 想让 cookie 值流到渲染层,得先往那个类型里加字段 —— 那一步足够刺眼。
 *
 * ⚠️ **单独成文件而不是并进 `extension.ts`**:那一份的注入面是 `ExtensionChannelService`
 * (通道的配置与状态),这三条的注入面是**持有层**。两者生命周期与职责都不同 ——
 * 持有层还要给 `VideoResolver` / `VideoEngine` 用(Step 3b),它不属于通道。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannel, type BorrowedCookieHosts } from '../../shared/ipc'
import type { BorrowedCookieStore } from '../video/borrowedCookieStore'

export interface CookieIpcDeps {
  /** 暂借登录态持有层(主进程装配后传入;handler 纯转发其 `hosts()` / `clear()`) */
  borrowedCookies: BorrowedCookieStore
}

/**
 * 两个 invoke handler 的**本体**(与 `ipcMain` 解耦,好让 `I-C7` 直测返回值形状)。
 *
 * ⚠️ 抽出来的理由与 `takeover.ts` / `dialog.ts` / `category.ts` 逐字相同:`registerCookieIpc`
 * 依赖 electron `ipcMain`,在 electron-as-node 测试环境不可直跑;而**内联箭头函数无法直测**,
 * 测试里另抄一份就是「测试测的是它自己抄的那份」——那种绿灯什么都不证明。
 */
export interface CookieIpcHandlers {
  getBorrowedHosts(): BorrowedCookieHosts
  clearBorrowed(): BorrowedCookieHosts
}

/** 建两个 handler 本体(纯转发持有层,零业务逻辑) */
export function createCookieIpcHandlers(deps: CookieIpcDeps): CookieIpcHandlers {
  return {
    // 取域列表(设置页可见行挂载时读)
    getBorrowedHosts: () => ({ hosts: deps.borrowedCookies.hosts() }),

    // 清空 → 回写后快照(渲染层就地更新,不再回读一次)
    // ⚠️ 清的是**主进程内存**,不碰浏览器里的任何 cookie:DownLord 从不写、不删用户的 cookie。
    clearBorrowed: () => {
      deps.borrowedCookies.clear()
      return { hosts: deps.borrowedCookies.hosts() }
    }
  }
}

/**
 * 向所有窗口推送持有层变更(spec §6.4)。
 *
 * 供 `ExtensionChannelService` 构造期 `onBorrowedCookiesChanged` 注入:`cookie.offer` 受理后
 * 把最新**域列表**广播到所有窗口 —— 设置页正开着时那一行当场更新。
 * 逐字仿 `broadcastExtensionChannelStatus`,遍历未销毁窗口 `webContents.send`。
 *
 * ⚠️ 入参就是 host 列表本身:调用方**没有机会**顺手多塞点什么进来。
 */
export function broadcastBorrowedCookiesChanged(hosts: string[]): void {
  const snapshot: BorrowedCookieHosts = { hosts }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.CookieBorrowedChanged, snapshot)
    }
  }
}

/**
 * 注册暂借登录态 IPC handler(两个 invoke/handle;推送见 `broadcastBorrowedCookiesChanged`)。
 *
 * @param deps - 持有层注入(handler 内只调其方法并回传,不含任何业务逻辑)
 */
export function registerCookieIpc(deps: CookieIpcDeps): void {
  const handlers = createCookieIpcHandlers(deps)

  // cookie:getBorrowedHosts — 取域列表(设置页可见行)
  ipcMain.handle(IpcChannel.CookieGetBorrowedHosts, async (): Promise<BorrowedCookieHosts> => {
    return handlers.getBorrowedHosts()
  })

  // cookie:clearBorrowed — 清空 → 回写后快照
  ipcMain.handle(IpcChannel.CookieClearBorrowed, async (): Promise<BorrowedCookieHosts> => {
    return handlers.clearBorrowed()
  })
}
