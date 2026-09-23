import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { AppUpdater, type AppAutoUpdaterLike, type AppUpdateCheckResultLike } from './appUpdater'
import type { ProxyResolved, UpdateStatus } from '../../shared/ipc'

const PROXY_DIRECT: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }
const PROXY_CUSTOM: ProxyResolved = {
  mode: 'manual',
  effectiveUrl: 'http://127.0.0.1:7890',
  systemDetected: null
}

/**
 * fake autoUpdater:EventEmitter 子类 + 记录 checkForUpdates / downloadUpdate / quitAndInstall 调用,
 * autoDownload / autoInstallOnAppQuit 为可写字段(断言构造后被置 false)。
 */
class FakeAutoUpdater extends EventEmitter implements AppAutoUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkCalls = 0
  downloadCalls = 0
  quitCalls = 0
  checkResult: AppUpdateCheckResultLike | null = null
  checkError: Error | null = null

  async checkForUpdates(): Promise<AppUpdateCheckResultLike | null> {
    this.checkCalls++
    if (this.checkError) throw this.checkError
    return this.checkResult
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls++
    return undefined
  }

  quitAndInstall(): void {
    this.quitCalls++
  }
}

interface Harness {
  updater: AppUpdater
  autoUpdater: FakeAutoUpdater
  statuses: UpdateStatus[]
  configureCalls: Array<string | null>
}

function makeHarness(proxy: ProxyResolved = PROXY_DIRECT): Harness {
  const autoUpdater = new FakeAutoUpdater()
  const statuses: UpdateStatus[] = []
  const configureCalls: Array<string | null> = []
  const updater = new AppUpdater({
    autoUpdater,
    getProxy: () => proxy,
    configureProxy: async (effectiveUrl) => {
      configureCalls.push(effectiveUrl)
    },
    onStatus: (s) => statuses.push(s),
    getCurrentVersion: () => '0.1.0'
  })
  return { updater, autoUpdater, statuses, configureCalls }
}

// ===================== 构造:诚实不静默 =====================

test('构造即置 autoDownload=false / autoInstallOnAppQuit=false(诚实不静默,§3.2)', () => {
  const { autoUpdater } = makeHarness()
  assert.equal(autoUpdater.autoDownload, false)
  assert.equal(autoUpdater.autoInstallOnAppQuit, false)
})

// ===================== 事件 → UpdateStatus 映射 =====================

test('update-available → phase:available + latestVersion', () => {
  const { autoUpdater, statuses } = makeHarness()
  autoUpdater.emit('update-available', { version: '0.2.0' })
  assert.deepEqual(statuses.at(-1), {
    target: 'app',
    phase: 'available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0'
  })
})

test('update-not-available → phase:up-to-date', () => {
  const { autoUpdater, statuses } = makeHarness()
  autoUpdater.emit('update-not-available', { version: '0.1.0' })
  assert.deepEqual(statuses.at(-1), {
    target: 'app',
    phase: 'up-to-date',
    currentVersion: '0.1.0',
    latestVersion: '0.1.0'
  })
})

test('download-progress → phase:downloading + percent 取整', () => {
  const { autoUpdater, statuses } = makeHarness()
  autoUpdater.emit('download-progress', { percent: 42.7 })
  assert.deepEqual(statuses.at(-1), {
    target: 'app',
    phase: 'downloading',
    percent: 43,
    currentVersion: '0.1.0'
  })
})

test('update-downloaded → phase:ready + message(诚实提示重启安装)', () => {
  const { autoUpdater, statuses } = makeHarness()
  autoUpdater.emit('update-downloaded', { version: '0.2.0' })
  const last = statuses.at(-1)
  assert.equal(last?.phase, 'ready')
  assert.equal(last?.latestVersion, '0.2.0')
  assert.ok(typeof last?.message === 'string' && last.message.length > 0)
})

test('error → phase:error + 可读错误(经 mapUpdateError,不糊原始栈)', () => {
  const { autoUpdater, statuses } = makeHarness()
  autoUpdater.emit('error', new Error('some raw electron-updater failure'))
  const last = statuses.at(-1)
  assert.equal(last?.phase, 'error')
  assert.ok(typeof last?.error === 'string' && last.error.length > 0)
  // 原始 message 不外泄给用户(只进日志)
  assert.ok(!last?.error?.includes('some raw electron-updater failure'))
})

// ===================== check():走代理 + 结果映射 =====================

test('check() 前调 configureProxy(effectiveUrl),再 checkForUpdates(走代理,§3.3)', async () => {
  const h = makeHarness(PROXY_CUSTOM)
  h.autoUpdater.checkResult = { updateInfo: { version: '0.2.0' }, isUpdateAvailable: true }
  await h.updater.check()
  assert.deepEqual(h.configureCalls, ['http://127.0.0.1:7890'])
  assert.equal(h.autoUpdater.checkCalls, 1)
})

test('check() direct 档 → configureProxy(null)(显式直连)', async () => {
  const h = makeHarness(PROXY_DIRECT)
  h.autoUpdater.checkResult = { updateInfo: { version: '0.1.0' }, isUpdateAvailable: false }
  await h.updater.check()
  assert.deepEqual(h.configureCalls, [null])
})

test('check() 有更新 → UpdateCheckResult{hasUpdate:true, latestVersion}', async () => {
  const h = makeHarness()
  h.autoUpdater.checkResult = { updateInfo: { version: '0.2.0' }, isUpdateAvailable: true }
  const result = await h.updater.check()
  assert.deepEqual(result, {
    target: 'app',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    hasUpdate: true
  })
})

test('check() 无 isUpdateAvailable 字段 → 回退按版本不等推断 hasUpdate', async () => {
  const h = makeHarness()
  h.autoUpdater.checkResult = { updateInfo: { version: '0.1.0' } }
  const result = await h.updater.check()
  assert.equal(result.hasUpdate, false)
})

test('check() 失败 → 诚实回退(hasUpdate:false, latestVersion:null, error)+ onStatus error', async () => {
  const h = makeHarness()
  h.autoUpdater.checkError = new Error('ENOTFOUND api.github.com')
  const result = await h.updater.check()
  assert.equal(result.hasUpdate, false)
  assert.equal(result.latestVersion, null)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
  assert.equal(h.statuses.at(-1)?.phase, 'error')
})

// ===================== download() / quitAndInstall() =====================

test('download() 前调 configureProxy,再 downloadUpdate(走代理,§3.3)', async () => {
  const h = makeHarness(PROXY_CUSTOM)
  await h.updater.download()
  assert.deepEqual(h.configureCalls, ['http://127.0.0.1:7890'])
  assert.equal(h.autoUpdater.downloadCalls, 1)
  // 起始广播 downloading percent:0
  assert.equal(h.statuses.at(-1)?.phase, 'downloading')
})

test('quitAndInstall() 透传 autoUpdater.quitAndInstall(用户点击触发)', () => {
  const h = makeHarness()
  h.updater.quitAndInstall()
  assert.equal(h.autoUpdater.quitCalls, 1)
})

// ===================== checkSupported gate:dev 未打包态诚实快速返回(U5 修复) =====================

test('check() checkSupported()=false(dev 未打包)→ 诚实快速返回 error,不调 checkForUpdates(不 hang)', async () => {
  const autoUpdater = new FakeAutoUpdater()
  const statuses: UpdateStatus[] = []
  const configureCalls: Array<string | null> = []
  const updater = new AppUpdater({
    autoUpdater,
    getProxy: () => PROXY_DIRECT,
    configureProxy: async (u) => {
      configureCalls.push(u)
    },
    onStatus: (s) => statuses.push(s),
    getCurrentVersion: () => '0.1.0',
    checkSupported: () => false
  })
  const r = await updater.check()
  assert.equal(autoUpdater.checkCalls, 0, 'dev 态不发 checkForUpdates(不 hang，U5)')
  assert.equal(configureCalls.length, 0, '未真检查 → 不设代理')
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latestVersion, null)
  assert.match(r.error ?? '', /开发模式|未打包/, '诚实错误文案')
  assert.equal(statuses.at(-1)?.phase, 'error', 'error 态(UI 按钮从「检查中…」恢复,不卡死)')
})

test('check() checkSupported()=true(打包态)→ 正常走 checkForUpdates(gate 只挡 dev)', async () => {
  const autoUpdater = new FakeAutoUpdater()
  autoUpdater.checkResult = { updateInfo: { version: '0.2.0' }, isUpdateAvailable: true }
  const updater = new AppUpdater({
    autoUpdater,
    getProxy: () => PROXY_DIRECT,
    configureProxy: async () => {},
    onStatus: () => {},
    getCurrentVersion: () => '0.1.0',
    checkSupported: () => true
  })
  const r = await updater.check()
  assert.equal(autoUpdater.checkCalls, 1, '打包态正常检查')
  assert.equal(r.hasUpdate, true)
  assert.equal(r.latestVersion, '0.2.0')
})
