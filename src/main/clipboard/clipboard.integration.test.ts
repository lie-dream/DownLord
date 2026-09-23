/// <reference types="node" />

/**
 * 剪贴板监控 收口集成测试 — v0.2 Task 4 Phase 3(spec §10.2 / plan Phase 3)。
 *
 * 真 `SettingsService` + 真 `settings.json` 落盘(nodeSettingsStoreFs)+ fake clipboard + 真 `ClipboardWatcher`
 * + spy 广播(注入 onDetected):据实复现 index.ts 的 `onChange` 联动闭包(`clipboardWatcher.setEnabled(s.clipboardWatch)`),
 * 端到端验证:
 *   C1 settings:set{clipboardWatch:true} → onChange → setEnabled(true) → fake 剪贴板变视频链接 + tick → 广播正确 ClipboardLink;
 *   C2 settings:set{clipboardWatch:false} → setEnabled(false) → 后续剪贴板变化不广播(轮询停 + tick no-op);
 *   C3 隐私回归:落盘 settings.json 含 clipboardWatch 布尔,且**不含任何剪贴板内容**(URL / 文本)。
 *
 * 不依赖 node:sqlite / Electron:ClipboardWatcher 依赖全注入(readText / onDetected / 定时器),纯 node 直跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SettingsService } from '../settings/settingsService'
import { nodeSettingsStoreFs } from '../settings/nodeSettingsStoreFs'
import { ClipboardWatcher } from './clipboardWatcher'
import type { ClipboardLink } from '../../shared/ipc'

const VIDEO_URL = 'https://www.youtube.com/watch?v=abc'
const ZIP_URL = 'https://example.com/pack.zip'

interface Harness {
  dir: string
  configPath: string
  settingsService: SettingsService
  watcher: ClipboardWatcher
  detected: ClipboardLink[]
  /** 设置 fake 剪贴板文本(下一次 tick 读到) */
  setClipboard: (text: string) => void
  /** 手动驱动一次轮询(注入 no-op 定时器,tick 确定化调用) */
  tick: () => void
}

/**
 * 起「真 SettingsService(真 settings.json 落盘)+ fake clipboard + 真 ClipboardWatcher + spy 广播」夹具。
 * 装配序仿 index.ts(spec §3.4 / §7.4):init() → 构造 watcher → setEnabled(持久化档);
 * onChange 闭包延迟引用 watcher(仿 index.ts `clipboardWatcher?.setEnabled(s.clipboardWatch)`)。
 * 注入 no-op 定时器:不起真实轮询,tick() 手动驱动(不碰真实 Electron clipboard / 真实定时器)。
 */
async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-clipboard-'))
  const configPath = path.join(dir, 'config', 'settings.json')

  let clipboardText = ''
  const detected: ClipboardLink[] = []
  // ref-holder:onChange 闭包需在 watcher 构造前捕获引用,故用 const 槽位 + 延迟填充(而非 let 后赋值)
  const watcherRef: { current?: ClipboardWatcher } = {}

  const settingsService = new SettingsService({
    store: nodeSettingsStoreFs,
    configPath,
    systemDownloadsDir: dir,
    onChange: (s) => {
      watcherRef.current?.setEnabled(s.clipboardWatch) // 据实复现 index.ts:297 onChange 联动
    }
  })
  await settingsService.init()

  const watcher = new ClipboardWatcher(
    {
      readText: () => clipboardText,
      onDetected: (link) => detected.push(link),
      // 注入 no-op 定时器:startTimer 不真正调度,tick() 手动驱动(确定化,§3.3)
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {}
    },
    { intervalMs: 1000 }
  )
  watcherRef.current = watcher
  watcher.setEnabled(settingsService.get().clipboardWatch) // 尊重持久化档(默认 false → 不轮询)

  return {
    dir,
    configPath,
    settingsService,
    watcher,
    detected,
    setClipboard: (text) => {
      clipboardText = text
    },
    tick: () => watcher.tick()
  }
}

function cleanup(h: Harness): void {
  h.watcher.stop()
  try {
    fs.rmSync(h.dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

test('C1 settings:set{clipboardWatch:true} → onChange 启用 → 剪贴板变视频链接 + tick → 广播正确 ClipboardLink', async () => {
  const h = await startHarness()
  try {
    assert.equal(h.detected.length, 0, '默认关:未广播')

    // 开关开(经真实 settings:set → onChange → setEnabled(true) seed lastText='' 不首弹)
    await h.settingsService.set({ clipboardWatch: true })

    // 复制视频链接 → tick → 广播
    h.setClipboard(VIDEO_URL)
    h.tick()

    assert.equal(h.detected.length, 1, '检测到一次')
    assert.deepEqual(h.detected[0], { url: VIDEO_URL, kind: 'video' }, '广播载荷正确(video)')
  } finally {
    cleanup(h)
  }
})

test('C2 settings:set{clipboardWatch:false} → 停用 → 后续剪贴板变化不广播', async () => {
  const h = await startHarness()
  try {
    await h.settingsService.set({ clipboardWatch: true })
    h.setClipboard(VIDEO_URL)
    h.tick()
    assert.equal(h.detected.length, 1, '开启期检测到一次')

    // 关开关 → setEnabled(false):停轮询 + 清会话态 + tick no-op
    await h.settingsService.set({ clipboardWatch: false })
    h.setClipboard(ZIP_URL) // 复制新的可下载直链
    h.tick()

    assert.equal(h.detected.length, 1, '关闭后不再广播(tick no-op)')
  } finally {
    cleanup(h)
  }
})

test('C3 隐私回归:settings.json 含 clipboardWatch 布尔,且不含任何剪贴板内容(URL / 文本)', async () => {
  const h = await startHarness()
  try {
    await h.settingsService.set({ clipboardWatch: true })
    // 期间检测多个链接(制造「若泄漏则可见」的机会)
    h.setClipboard(VIDEO_URL)
    h.tick()
    h.setClipboard(ZIP_URL)
    h.tick()
    assert.equal(h.detected.length, 2, '两次检测(制造潜在泄漏点)')

    const raw = fs.readFileSync(h.configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { clipboardWatch?: unknown }

    // 含开关布尔(可持久化)
    assert.equal(parsed.clipboardWatch, true, 'settings.json 含 clipboardWatch=true')

    // 绝不含任何剪贴板内容(URL / 片段);lastText / promptedUrls 全内存,绝不落盘(spec §6.4)
    for (const leak of [VIDEO_URL, ZIP_URL, 'youtube', 'pack.zip', 'watch?v=']) {
      assert.equal(raw.includes(leak), false, `settings.json 不含剪贴板内容片段:${leak}`)
    }
  } finally {
    cleanup(h)
  }
})
