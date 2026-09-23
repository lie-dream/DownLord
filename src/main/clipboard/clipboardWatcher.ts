/**
 * 剪贴板监控服务(v0.2 Task 4 · spec §3.3)。
 *
 * Electron 无剪贴板变化事件,只能定时 `clipboard.readText()` 与上次值比对(§3.1)。
 * 服务封在可测接口后:依赖全注入(`readText` / `onDetected` / 定时器 / getters),核心决策是纯函数
 * `decideClipboard`;单测注入 fake `readText` + 手动 `tick()` / fake timer,**不碰真实 Electron clipboard / 真实定时器**。
 *
 * 隐私红线(§6.4):`lastText` / `promptedUrls` 全内存、会话级、`setEnabled(false)` 即清;
 * 绝不 `console.*` 剪贴板文本 / URL;不落库、不写 settings。
 */
import type { ClipboardLink } from '../../shared/ipc'
import { decideClipboard } from './clipboardLink'

export interface ClipboardWatcherDeps {
  /** 读剪贴板文本(真实:`() => clipboard.readText()`;测试:注入 fake) */
  readText: () => string
  /** 检测到可下载新链接的回调(真实注入 `broadcastClipboardLink`;测试注入 spy) */
  onDetected: (link: ClipboardLink) => void
  /** 运行时类别扩展名并集(加固 `classifyLink`;缺省 → 仅内置 DIRECT_FILE_EXTS) */
  getKnownFileExts?: () => ReadonlySet<string>
  /** 已在任务列表的源 URL 集合(去重「已在下载」;缺省 → 空集) */
  getTrackedUrls?: () => ReadonlySet<string>
  /** 定时器注入(真实缺省用全局 setInterval;测试注入 fake) */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  /** 清定时器注入(真实缺省用全局 clearInterval;测试注入 fake) */
  clearInterval?: (h: ReturnType<typeof setInterval>) => void
}

export interface ClipboardWatcherConfig {
  /** 轮询间隔(默认 1000ms,§3.2) */
  intervalMs?: number
}

/** 默认轮询间隔:1000ms(亚秒级手感 + 可忽略开销 + 克制读取频次,§3.2) */
const DEFAULT_INTERVAL_MS = 1000

export class ClipboardWatcher {
  private readonly deps: ClipboardWatcherDeps
  private readonly intervalMs: number

  /** 上次剪贴板原值(变化门;**仅内存、不落盘 / 不日志**,setEnabled(false) 清空,§4.3) */
  private lastText = ''
  /** 本会话已提示过的 URL(避免同一 URL 反复弹;**仅内存**,setEnabled(false) 清空,§4.3) */
  private readonly promptedUrls = new Set<string>()
  /** 当前是否启用(变化门 / tick 生效前提) */
  private enabled = false
  /** 轮询定时器句柄(null = 未轮询) */
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: ClipboardWatcherDeps, config?: ClipboardWatcherConfig) {
    this.deps = deps
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  /**
   * 开关启停(§3.4):
   * - `true`(disabled→enabled):**seed `lastText = readText()` 但不首弹**(避免刚开启就为「开启前已在
   *   剪贴板的旧链接」惊扰,只监听此后的新复制)→ 启动 `intervalMs` 轮询。
   * - `false`(enabled→disabled):`clearInterval` + 清 `lastText` / `promptedUrls`(不保留任何剪贴板值)。
   *
   * **幂等**:重复同态调用无操作——`onChange` 对任意 settings 变更都会调 `setEnabled(s.clipboardWatch)`,
   * 若开关值未变则不应重启轮询 / 重置变化门(否则无关设置的改动会漏掉一次待检测的复制)。
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) {
      // seed 变化门为当前剪贴板值,使开启前已在剪贴板的内容不首弹
      this.lastText = this.deps.readText()
      this.startTimer()
    } else {
      this.clearTimer()
      this.lastText = ''
      this.promptedUrls.clear()
    }
  }

  /**
   * 单次轮询(§4.3):read → `decideClipboard` → 按结果改内部态 / 调 `onDetected`。
   * 未启用时 no-op(关闭后即便被误调也不检测);public 供单测确定化驱动。
   */
  tick(): void {
    if (!this.enabled) return
    const text = this.deps.readText()
    const decision = decideClipboard({
      text,
      lastText: this.lastText,
      promptedUrls: this.promptedUrls,
      trackedUrls: this.deps.getTrackedUrls?.(),
      knownFileExts: this.deps.getKnownFileExts?.()
    })
    if (decision.changed) {
      this.lastText = text
    }
    if (decision.link) {
      this.promptedUrls.add(decision.link.url)
      this.deps.onDetected(decision.link)
    }
  }

  /** 停止轮询、清定时器(退出即停,§3.4);**不清 `promptedUrls`**(仅 `setEnabled(false)` 清) */
  stop(): void {
    this.clearTimer()
  }

  private startTimer(): void {
    this.clearTimer()
    const setInt = this.deps.setInterval ?? setInterval
    this.timer = setInt(() => this.tick(), this.intervalMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      const clearInt = this.deps.clearInterval ?? clearInterval
      clearInt(this.timer)
      this.timer = null
    }
  }
}
