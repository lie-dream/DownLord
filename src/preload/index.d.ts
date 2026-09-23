import type { DownLordApi, TakeoverApi } from '../shared/ipc'

declare global {
  interface Window {
    /**
     * 主窗口的 API 面(59 条)。
     * ⚠️ **接管确认小窗口里为 `undefined`** —— preload 按窗口标记只 expose 一个对象(spec §3.6),
     * 类型上仍声明为必有,是为了不给主窗口那几十处调用点平白加一层 `?.`(既有形态零回归)。
     */
    api: DownLordApi
    /**
     * 接管确认小窗口的 API 面(十二条)。
     * ⚠️ **主窗口里为 `undefined`** —— 同上,故这里声明为可选:小窗口内的消费方拿到的是必有值,
     * 而任何在主窗口误用它的代码会被类型系统当场拦下。
     */
    takeoverApi?: TakeoverApi
  }
}

export {}
