/**
 * 接管确认小窗口的 IPC(v0.4 Task 4 · spec §3.7 · plan 2.3)。
 *
 * 六条小窗口通道里**本文件只管 R→M 的四条**(`ready` / `submit` / `dismiss` / `settled`);M→R 的两条
 * (`present` / `duplicate`)由 `takeoverService` 经窗口句柄**定向 send**,不在此注册 ——
 * 与既有 `broadcastExtensionChannelStatus` / `broadcastDuplicate` 的「广播」形态刻意不同:
 * 那些是状态广播(谁听都无害),这些是**定向指令**(主窗口收到只会添乱)。
 *
 * v0.4 Task 4 Step 6a 另加**设置页**用的三条 `handle` + 一条广播(`getConfig` / `setConfig` /
 * `setPause` / `configChanged`,spec §5.5)—— 那三条与小窗口无关,归属规则见 `registerTakeoverIpc`。
 *
 * ★ **窗口归属校验**:三条 handler 内都校验 `event.sender.id === 接管窗口的 webContents.id`,
 *   不符则**静默忽略并记一条 warn**。理由:这三条能真的建任务,而 `ipcMain` 对所有渲染进程开放 ——
 *   主窗口(或任何未来窗口)不该有能力驱动接管流程。这是「用接口形状强制职责」的第三次应用
 *   (前两次:Task 3 的 `setChannelConfig` 不收 `token`、本 Task 的 intent 载荷不设 `dir`)。
 *
 * 职责:纯转发 + 归属校验,不含业务逻辑(缓冲 / 终裁 / 建任务全在 `takeoverService` 与其纯函数)。
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  IpcChannel,
  type TakeoverPausePatch,
  type TakeoverSettingsPatch,
  type TakeoverSettingsView,
  type TakeoverSubmitPayload
} from '../../shared/ipc'
import type { ChannelLogger } from '../extensionChannel/channelServer'
import type { TakeoverService } from '../takeover/takeoverService'

/**
 * 向所有窗口广播「主进程侧新建了任务,请重拉列表」(v0.4 Task 4 Step 4 · 2026-08-02 真机修复)。
 *
 * ★ 这条**是广播不是定向**,与上面五条刻意相反:它是**状态变更通知**(谁听都无害、载荷为空),
 *   而 `present` / `duplicate` 是**指令**(主窗口收到只会添乱)。形态跟着语义走,不跟着模块走 ——
 *   故它逐字仿 `broadcastProgress` / `broadcastExtensionChannelStatus`,遍历未销毁窗口 `send`。
 *
 * 放在本文件而不是 `ipc/task.ts`:唯一的触发者是接管路径(`ipc/task.ts` 本 Task 一字不改)。
 */
export function broadcastTaskAdded(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.TaskAdded)
    }
  }
}

/**
 * 向所有窗口广播「接管配置变了」(v0.4 Task 4 Step 6a · spec §5.5)。
 *
 * ★ 与 `present` / `duplicate` 那两条**定向**指令刻意相反,这条是**状态广播**(谁听都无害):
 *   暂停真源有**两个写入口** —— 设置页与 popup 遥控器。popup 把暂停设上时,开着的设置页
 *   必须跟上,否则它显示的是自己最后写的值,而不是真源(CONTEXT.md「临时暂停接管」)。
 *   故它逐字仿 `broadcastExtensionChannelStatus`,遍历未销毁窗口 `send`。
 *
 * ⚠️ 载荷是 `TakeoverSettingsView`(**四键**,含域名例外表)—— 那是**窗口内**的东西;
 *   经本地通道下发给扩展的是三键的 `TakeoverConfigView`,两者不是一个类型,别混。
 */
export function broadcastTakeoverConfig(view: TakeoverSettingsView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.TakeoverConfigChanged, view)
    }
  }
}

/** 四条 `send`(R→M)只依赖服务的这五个方法 —— 单测注入极小的假对象即可(I-11) */
export type TakeoverIpcService = Pick<
  TakeoverService,
  'ownsSender' | 'onRendererReady' | 'onSubmit' | 'onDismiss' | 'onDuplicatesSettled'
>

/**
 * 三条设置页 `handle`(R→M→R)只依赖服务的这三个方法(v0.4 Task 4 Step 6a)。
 *
 * **与上面那组刻意分开**:`createTakeoverIpcHandlers` 只该看见小窗口那五条 ——
 * 让「确认框的 handler 工厂」连配置写入口都够不着,是接口形状层面的最小依赖。
 */
export type TakeoverSettingsService = Pick<
  TakeoverService,
  'getSettings' | 'setSettings' | 'setPause'
>

export interface TakeoverIpcDeps {
  service: TakeoverIpcService
  logger: ChannelLogger
}

/** `registerTakeoverIpc` 的注入面:四条 `send` + 三条 `handle` 两组方法都要 */
export interface TakeoverRegisterDeps extends TakeoverIpcDeps {
  service: TakeoverIpcService & TakeoverSettingsService
}

export interface TakeoverIpcHandlers {
  ready(senderId: number): void
  submit(senderId: number, payload: unknown): void
  dismiss(senderId: number): void
  settled(senderId: number): void
}

/** 提交载荷的最小形状守卫:非本形状一律忽略(渲染层来的东西不做类型假设) */
function isSubmitPayload(raw: unknown): raw is TakeoverSubmitPayload {
  if (!raw || typeof raw !== 'object') return false
  const p = raw as Record<string, unknown>
  if (typeof p.dir !== 'string') return false
  if (!Array.isArray(p.items)) return false
  return p.items.every(
    (i) =>
      !!i &&
      typeof i === 'object' &&
      typeof (i as Record<string, unknown>).id === 'string' &&
      typeof (i as Record<string, unknown>).filename === 'string'
  )
}

/**
 * 三条 handler 的可测本体(electron 只在 `registerTakeoverIpc` 里出现)。
 * 归属不符 = 静默忽略 + 一条 warn;**绝不因为「反正只是个 send」就放行**。
 */
export function createTakeoverIpcHandlers(deps: TakeoverIpcDeps): TakeoverIpcHandlers {
  const guard = (senderId: number, channel: string): boolean => {
    if (deps.service.ownsSender(senderId)) return true
    deps.logger.warn(`[takeover] 非接管窗口的 ${channel} 已忽略(sender=${senderId})`)
    return false
  }

  return {
    ready(senderId: number): void {
      if (!guard(senderId, IpcChannel.TakeoverReady)) return
      deps.service.onRendererReady()
    },
    submit(senderId: number, payload: unknown): void {
      if (!guard(senderId, IpcChannel.TakeoverSubmit)) return
      if (!isSubmitPayload(payload)) {
        deps.logger.warn('[takeover] submit 载荷形状不符,已忽略')
        return
      }
      deps.service.onSubmit(payload)
    },
    dismiss(senderId: number): void {
      if (!guard(senderId, IpcChannel.TakeoverDismiss)) return
      deps.service.onDismiss()
    },
    settled(senderId: number): void {
      if (!guard(senderId, IpcChannel.TakeoverSettled)) return
      deps.service.onDuplicatesSettled()
    }
  }
}

/**
 * 注册四条 `send` 通道(R→M)+ 三条设置页用的 `handle`(R→M→R)。
 *
 * ⚠️ 两组的**归属校验刻意不同**:四条 `send` 只有接管小窗口能驱动(它们能真的建任务);
 *    三条 `handle` 是**设置页**用的配置读写,与其它 `settings:*` / `extension:*` 同族 ——
 *    对所有窗口开放,不做 sender 校验(接管小窗口的 preload 面里根本没有这三条,
 *    最小暴露面由 `takeoverApi.ts` 的形状保障,而不是靠这里判 sender)。
 */
export function registerTakeoverIpc(deps: TakeoverRegisterDeps): void {
  const handlers = createTakeoverIpcHandlers(deps)

  ipcMain.on(IpcChannel.TakeoverReady, (event) => handlers.ready(event.sender.id))
  ipcMain.on(IpcChannel.TakeoverSubmit, (event, payload: unknown) =>
    handlers.submit(event.sender.id, payload)
  )
  ipcMain.on(IpcChannel.TakeoverDismiss, (event) => handlers.dismiss(event.sender.id))
  ipcMain.on(IpcChannel.TakeoverSettled, (event) => handlers.settled(event.sender.id))

  // takeover:getConfig — 读接管配置快照(设置页挂载回显;`paused` 由主进程算好)
  ipcMain.handle(IpcChannel.TakeoverGetConfig, async (): Promise<TakeoverSettingsView> => {
    return deps.service.getSettings()
  })

  // takeover:setConfig — 写总开关 / 域名例外表 → 落盘 + 广播 → 回写后快照(域名归一在主进程)
  ipcMain.handle(
    IpcChannel.TakeoverSetConfig,
    async (_event, patch: TakeoverSettingsPatch): Promise<TakeoverSettingsView> => {
      return deps.service.setSettings(patch)
    }
  )

  // takeover:setPause — 设时长档 → 落盘 + 广播 → 回写后快照(绝对到期时刻由主进程现算)
  ipcMain.handle(
    IpcChannel.TakeoverSetPause,
    async (_event, patch: TakeoverPausePatch): Promise<TakeoverSettingsView> => {
      return deps.service.setPause(patch)
    }
  )
}
