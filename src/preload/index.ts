import { contextBridge } from 'electron'
import { TAKEOVER_WINDOW_ARG } from '../shared/ipc'
import { api } from './mainApi'
import { takeoverApi } from './takeoverApi'

/**
 * preload 入口:**单文件、单构建入口,按窗口标记二选一暴露**(v0.4 Task 4 · spec §3.6)。
 *
 * 主窗口与接管确认小窗口**共用这一个 preload**;小窗口建窗时由主进程经
 * `webPreferences.additionalArguments` 打上 `--downlord-takeover` 标记(`takeoverWindow.ts`),
 * 这里读 `process.argv` 分支。
 *
 * ★ **分支即边界**:小窗口拿不到 `api` 那 59 条,主窗口拿不到 `takeoverApi` ——
 *   不是靠约定,是靠这里**只 expose 一个对象**(§7.2「接口形状即职责边界」)。
 *
 * ★ 刻意**不走 preload 多入口**:electron-vite 的 lib 模式与 CJS 输出保持默认,构建风险为零;
 *   两个窗口的 `sandbox: true` 因此得以**逐字一致**,不出现「同一应用两种安全姿态」。
 *   (2026-08-02 B1 取证:sandbox preload 里 `process.argv` 确实读得到该标记 —— 小窗口 `true`、
 *   主窗口 `false`,故退路①`location.pathname` 判法未启用。)
 */
const isTakeover = process.argv.includes(TAKEOVER_WINDOW_ARG)

// contextIsolation 开启时经 contextBridge 暴露(本项目恒为 true,见 §2.3);
// else 分支仅作模板兜底,正常路径不会走到。
if (process.contextIsolated) {
  try {
    if (isTakeover) {
      contextBridge.exposeInMainWorld('takeoverApi', takeoverApi)
    } else {
      contextBridge.exposeInMainWorld('api', api)
    }
  } catch (error) {
    console.error(error)
  }
} else {
  if (isTakeover) {
    // @ts-ignore (define in dts)
    window.takeoverApi = takeoverApi
  } else {
    // @ts-ignore (define in dts)
    window.api = api
  }
}
