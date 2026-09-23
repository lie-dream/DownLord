/**
 * ClipboardWatcher 服务单测(v0.2 Task 4 · spec §10.1)。
 *
 * 注入可变 fake `readText` + 手动 `tick()` + fake timer,不碰真实 Electron clipboard / 真实定时器(§3.3)。
 * 覆盖:变化触发一次 / 同值不触发 / 换回同 URL 不触发 / 非链接不触发 / trackedUrls 命中不触发 /
 * setEnabled(false) 停并清态 + tick no-op / 开启 seed 不首弹 / stop 清定时器 / 定时器驱动 tick。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ClipboardWatcher, type ClipboardWatcherDeps } from './clipboardWatcher'
import type { ClipboardLink } from '../../shared/ipc'

const VIDEO = 'https://www.youtube.com/watch?v=abc'
const ZIP = 'https://example.com/pkg/setup.zip'

/** 可变剪贴板 + onDetected 收集 + fake 定时器;返回操作句柄供测试驱动 */
function harness(
  opts: {
    initialClip?: string
    knownFileExts?: ReadonlySet<string>
    trackedUrls?: () => ReadonlySet<string>
    config?: { intervalMs?: number }
  } = {}
): {
  watcher: ClipboardWatcher
  setClip: (v: string) => void
  detected: ClipboardLink[]
  timer: {
    setCount: number
    lastMs: number
    lastCb: (() => void) | null
    cleared: unknown[]
  }
} {
  let clip = opts.initialClip ?? ''
  const detected: ClipboardLink[] = []
  const timer = {
    setCount: 0,
    lastMs: 0,
    lastCb: null as (() => void) | null,
    handleSeq: 0,
    lastHandle: null as unknown,
    cleared: [] as unknown[]
  }
  const deps: ClipboardWatcherDeps = {
    readText: () => clip,
    onDetected: (link) => detected.push(link),
    getKnownFileExts: opts.knownFileExts
      ? () => opts.knownFileExts as ReadonlySet<string>
      : undefined,
    getTrackedUrls: opts.trackedUrls,
    setInterval: (cb, ms) => {
      timer.setCount++
      timer.lastMs = ms
      timer.lastCb = cb
      timer.handleSeq++
      timer.lastHandle = { id: timer.handleSeq }
      return timer.lastHandle as ReturnType<typeof setInterval>
    },
    clearInterval: (h) => {
      timer.cleared.push(h)
    }
  }
  const watcher = new ClipboardWatcher(deps, opts.config)
  return { watcher, setClip: (v) => (clip = v), detected, timer }
}

test('剪贴板变为视频 URL → onDetected 调用一次,载荷正确', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true) // seed lastText=''
  h.setClip(VIDEO)
  h.watcher.tick()
  assert.deepEqual(h.detected, [{ url: VIDEO, kind: 'video' }])
})

test('同值再 tick → 不再调用(变化门)', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  h.watcher.tick() // 检测一次
  h.watcher.tick() // 剪贴板未变 → 变化门拦截
  h.watcher.tick()
  assert.equal(h.detected.length, 1, '同值不重复触发')
})

test('换到别的文本再换回同一 URL → 不调用(promptedUrls 去重)', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  h.watcher.tick() // 检测 VIDEO(promptedUrls={VIDEO})
  h.setClip('随手复制的一段话')
  h.watcher.tick() // 非链接,变化门更新 lastText
  h.setClip(VIDEO)
  h.watcher.tick() // 变化,但 VIDEO 已提示过 → 不弹
  assert.equal(h.detected.length, 1, '已提示过的 URL 不重复弹')
})

test('非链接文本变化 → 不调用', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip('just some random text')
  h.watcher.tick()
  h.setClip('https://example.com/some/page') // ambiguous → 不弹
  h.watcher.tick()
  assert.equal(h.detected.length, 0)
})

test('trackedUrls 含该 URL → 不调用(已在任务列表)', () => {
  const tracked = new Set([VIDEO])
  const h = harness({ initialClip: '', trackedUrls: () => tracked })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  h.watcher.tick()
  assert.equal(h.detected.length, 0, '已在下载列表不打扰')
})

test('knownFileExts 注入 → .docx 直链被识别为可提示 http', () => {
  const h = harness({ initialClip: '', knownFileExts: new Set(['docx']) })
  h.watcher.setEnabled(true)
  const docx = 'https://example.com/report.docx'
  h.setClip(docx)
  h.watcher.tick()
  assert.deepEqual(h.detected, [{ url: docx, kind: 'http' }])
})

test('直链 .zip 变化 → onDetected kind http', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(ZIP)
  h.watcher.tick()
  assert.deepEqual(h.detected, [{ url: ZIP, kind: 'http' }])
})

test('开启 seed lastText:当前剪贴板已是链接也不首弹(seed 经变化门)', () => {
  const h = harness({ initialClip: VIDEO }) // 开启前剪贴板已有视频链接
  h.watcher.setEnabled(true) // seed lastText=VIDEO,不首弹
  assert.equal(h.detected.length, 0, 'setEnabled(true) 自身不弹')
  h.watcher.tick() // 剪贴板仍是 VIDEO → 与 seed 相同 → 变化门拦截
  assert.equal(h.detected.length, 0, '开启前已在剪贴板的旧链接不惊扰')
})

test('setEnabled(true) 启动轮询:注册定时器且间隔正确(默认 1000ms)', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  assert.equal(h.timer.setCount, 1, '启动一次轮询')
  assert.equal(h.timer.lastMs, 1000, '默认间隔 1000ms')
})

test('config.intervalMs 覆盖默认间隔', () => {
  const h = harness({ initialClip: '', config: { intervalMs: 500 } })
  h.watcher.setEnabled(true)
  assert.equal(h.timer.lastMs, 500)
})

test('定时器回调即驱动 tick(注册的 cb 触发检测)', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  assert.ok(h.timer.lastCb, '已注册轮询回调')
  h.timer.lastCb?.() // 模拟定时器到点
  assert.deepEqual(h.detected, [{ url: VIDEO, kind: 'video' }], '轮询回调驱动 tick 检测')
})

test('setEnabled(false) → clearInterval 调用 + tick no-op + 清 lastText/promptedUrls', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  h.watcher.tick() // 检测 VIDEO,promptedUrls={VIDEO}
  assert.equal(h.detected.length, 1)

  h.watcher.setEnabled(false)
  assert.equal(h.timer.cleared.length, 1, 'clearInterval 被调用一次')

  // tick no-op:关闭后即使剪贴板变化也不检测
  h.setClip('https://example.com/other.zip')
  h.watcher.tick()
  assert.equal(h.detected.length, 1, '关闭后 tick no-op')

  // 清态验证:重新开启后,先前已提示的 VIDEO 可再次触发(promptedUrls 已清)
  h.setClip('') // 使 seed lastText=''
  h.watcher.setEnabled(true)
  h.setClip(VIDEO)
  h.watcher.tick()
  assert.equal(h.detected.length, 2, 'promptedUrls 已清 → 同 URL 可再弹')
})

test('stop() → 清定时器', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.watcher.stop()
  assert.equal(h.timer.cleared.length, 1, 'stop 清定时器')
})

test('setEnabled 幂等:重复开启不重启轮询(避免无关 settings 变更重置变化门)', () => {
  const h = harness({ initialClip: '' })
  h.watcher.setEnabled(true)
  h.setClip(VIDEO) // 复制了一个链接,尚未 tick
  h.watcher.setEnabled(true) // 无关 settings 变更再次触发 setEnabled(true)
  assert.equal(h.timer.setCount, 1, '幂等:不重复注册定时器')
  // 未被重新 seed:此时 tick 仍能检测到 VIDEO(变化门未被重置)
  h.watcher.tick()
  assert.deepEqual(h.detected, [{ url: VIDEO, kind: 'video' }], '重复开启不重置变化门')
})
