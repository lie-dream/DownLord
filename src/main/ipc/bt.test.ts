/**
 * BT IPC 纯转发单测(v0.4 Task 1 · spec §7.1)。
 *
 * 直测 `createBtHandlers` 转发主体(handler 的全部逻辑;handler 本体依赖 electron `ipcMain`,
 * 在 electron-as-node 测试环境下不可直跑,故转发主体抽为纯函数以单测,`registerBtIpc` 仅薄包装注册)。
 * 注入 fake trackerService / diagnose(记录调用 + 预设返回),断言每个 handler **只调对应方法并原样回传**
 * (纯转发零加工、通道间不串);通道名 + preload 转发由 IpcChannel 常量单一来源 + DownLordApi 契约的 typecheck 静态保证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBtHandlers, type BtIpcDeps } from './bt'
import type { BtTrackerStatus, InboundDiagnosis } from '../../shared/ipc'

/** 预设状态 / 诊断(断言 handler 原样回传 service 返回值,不加工) */
const STATUS_CURRENT: BtTrackerStatus = {
  state: 'ok',
  updatedAt: 1_700_000_000_000,
  count: 52,
  usingBuiltin: false,
  lastError: null,
  busy: false
}
const STATUS_AFTER_UPDATE: BtTrackerStatus = {
  state: 'failed',
  updatedAt: 0,
  count: 47,
  usingBuiltin: true,
  lastError: '网络不可达',
  busy: false
}
const DIAGNOSIS: InboundDiagnosis = {
  state: 'unlikely',
  factors: [
    { id: 'publicIPv6', label: '公网 IPv6', verdict: 'against', detail: '未检测到公网 IPv6 地址。' }
  ],
  checkedAt: 1_700_000_000_001
}

/** fake 各方法调用计数 */
interface Calls {
  getStatus: number
  updateNow: number
  diagnose: number
}

/** 注入式 fake service:记录调用次数,回预设值(结构满足 Pick 子集面) */
function makeDeps(): { deps: BtIpcDeps; calls: Calls } {
  const calls: Calls = { getStatus: 0, updateNow: 0, diagnose: 0 }
  const deps: BtIpcDeps = {
    trackerService: {
      getStatus: async () => {
        calls.getStatus++
        return STATUS_CURRENT
      },
      updateNow: async () => {
        calls.updateNow++
        return STATUS_AFTER_UPDATE
      }
    },
    diagnose: () => {
      calls.diagnose++
      return DIAGNOSIS
    }
  }
  return { deps, calls }
}

test('getTrackerStatus → 调 trackerService.getStatus 一次并原样回传', async () => {
  const { deps, calls } = makeDeps()
  const result = await createBtHandlers(deps).getTrackerStatus()
  assert.equal(calls.getStatus, 1, 'trackerService.getStatus 被调一次')
  assert.equal(result, STATUS_CURRENT, '原样回传 service 返回值(同引用,纯转发不加工)')
})

test('updateTrackersNow → 调 trackerService.updateNow 一次并原样回传(含失败态)', async () => {
  const { deps, calls } = makeDeps()
  const result = await createBtHandlers(deps).updateTrackersNow()
  assert.equal(calls.updateNow, 1, 'trackerService.updateNow 被调一次')
  assert.equal(result, STATUS_AFTER_UPDATE, '失败态也原样回传(渲染层据此 toast,不在 IPC 层改判)')
})

test('getInboundDiagnosis → 调注入的 diagnose 一次并原样回传(同步包为 Promise)', async () => {
  const { deps, calls } = makeDeps()
  const result = await createBtHandlers(deps).getInboundDiagnosis()
  assert.equal(calls.diagnose, 1, 'diagnose 被调一次')
  assert.equal(result, DIAGNOSIS, '原样回传(判定全在纯函数,IPC 零加工)')
})

test('getInboundDiagnosis 每次调用都重新实算(不缓存结果,换网即得新结论)', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createBtHandlers(deps)
  await handlers.getInboundDiagnosis()
  await handlers.getInboundDiagnosis()
  await handlers.getInboundDiagnosis()
  assert.equal(calls.diagnose, 3, '三次 invoke → 三次实算(spec §3.4 换网自动重算的地基)')
})

test('纯转发隔离:每个 handler 只调对应依赖,不误触其它通道', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createBtHandlers(deps)

  await handlers.getTrackerStatus()
  assert.deepEqual(calls, { getStatus: 1, updateNow: 0, diagnose: 0 }, '读状态不触发拉取')

  await handlers.getInboundDiagnosis()
  assert.deepEqual(calls, { getStatus: 1, updateNow: 0, diagnose: 1 }, '入站自检不触发 tracker 拉取')

  await handlers.updateTrackersNow()
  assert.deepEqual(calls, { getStatus: 1, updateNow: 1, diagnose: 1 }, '三通道各恰好一次')
})
