/**
 * 更新 IPC 纯转发单测(v0.2 Task 6 Phase 3 · spec §7.1)。
 *
 * 直测 `createUpdateHandlers` 转发主体(handler 的全部逻辑;handler 本体依赖 electron `ipcMain`,
 * 在 electron-as-node 测试环境下不可直跑,故转发主体抽为纯函数以单测,`registerUpdateIpc` 仅薄包装注册)。
 * 注入 fake ytdlpUpdater / appUpdater(记录调用 + 预设返回),断言每个 handler **只调对应方法并原样回传**
 * (纯转发零加工、通道间不串);通道名 + preload 转发由 IpcChannel 常量单一来源 + DownLordApi 契约的 typecheck 静态保证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateHandlers, type UpdateIpcDeps } from './update'
import type { UpdateCheckResult } from '../../shared/ipc'

/** 预设检查结果(断言 handler 原样回传 service 返回值,不加工) */
const YTDLP_RESULT: UpdateCheckResult = {
  target: 'ytdlp',
  currentVersion: '2024.01.01',
  latestVersion: '2024.12.31',
  hasUpdate: true
}
const APP_RESULT: UpdateCheckResult = {
  target: 'app',
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  hasUpdate: true
}

/** fake service 各方法调用计数 */
interface Calls {
  ytCheck: number
  ytRun: number
  appCheck: number
  appDownload: number
  appQuitInstall: number
}

/** 注入式 fake ytdlpUpdater / appUpdater:记录调用次数,check 回预设结果,其余 no-op(结构满足 Pick 子集面)。 */
function makeDeps(): { deps: UpdateIpcDeps; calls: Calls } {
  const calls: Calls = { ytCheck: 0, ytRun: 0, appCheck: 0, appDownload: 0, appQuitInstall: 0 }
  const deps: UpdateIpcDeps = {
    ytdlpUpdater: {
      check: async () => {
        calls.ytCheck++
        return YTDLP_RESULT
      },
      run: async () => {
        calls.ytRun++
      }
    },
    appUpdater: {
      check: async () => {
        calls.appCheck++
        return APP_RESULT
      },
      download: async () => {
        calls.appDownload++
      },
      quitAndInstall: () => {
        calls.appQuitInstall++
      }
    }
  }
  return { deps, calls }
}

test('checkYtDlp → 调 ytdlpUpdater.check 一次并原样回传', async () => {
  const { deps, calls } = makeDeps()
  const result = await createUpdateHandlers(deps).checkYtDlp()
  assert.equal(calls.ytCheck, 1, 'ytdlpUpdater.check 被调一次')
  assert.equal(result, YTDLP_RESULT, '原样回传 service 返回值(同引用,纯转发不加工)')
})

test('runYtDlp → 调 ytdlpUpdater.run 一次,返回 void', async () => {
  const { deps, calls } = makeDeps()
  const result = await createUpdateHandlers(deps).runYtDlp()
  assert.equal(calls.ytRun, 1, 'ytdlpUpdater.run 被调一次')
  assert.equal(result, undefined, 'run 无返回值')
})

test('checkApp → 调 appUpdater.check 一次并原样回传', async () => {
  const { deps, calls } = makeDeps()
  const result = await createUpdateHandlers(deps).checkApp()
  assert.equal(calls.appCheck, 1, 'appUpdater.check 被调一次')
  assert.equal(result, APP_RESULT, '原样回传 service 返回值(同引用)')
})

test('downloadApp → 调 appUpdater.download 一次,返回 void', async () => {
  const { deps, calls } = makeDeps()
  const result = await createUpdateHandlers(deps).downloadApp()
  assert.equal(calls.appDownload, 1, 'appUpdater.download 被调一次')
  assert.equal(result, undefined, 'download 无返回值')
})

test('quitInstallApp → 调 appUpdater.quitAndInstall(同步方法包为 Promise<void>)', async () => {
  const { deps, calls } = makeDeps()
  const result = await createUpdateHandlers(deps).quitInstallApp()
  assert.equal(calls.appQuitInstall, 1, 'appUpdater.quitAndInstall 被调一次')
  assert.equal(result, undefined, '包为 Promise<void>,resolve 无值')
})

test('纯转发隔离:每个 handler 只调对应 service 方法,不误触其它通道', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createUpdateHandlers(deps)

  await handlers.checkYtDlp()
  // 只 ytCheck 自增,其余全 0(通道间不串)
  assert.deepEqual(calls, { ytCheck: 1, ytRun: 0, appCheck: 0, appDownload: 0, appQuitInstall: 0 })

  await handlers.checkApp()
  assert.deepEqual(calls, { ytCheck: 1, ytRun: 0, appCheck: 1, appDownload: 0, appQuitInstall: 0 })

  await handlers.runYtDlp()
  await handlers.downloadApp()
  await handlers.quitInstallApp()
  // 五通道各恰好一次
  assert.deepEqual(calls, { ytCheck: 1, ytRun: 1, appCheck: 1, appDownload: 1, appQuitInstall: 1 })
})
