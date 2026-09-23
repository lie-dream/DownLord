/**
 * 接管 IPC 的窗口归属校验单测(I-11;v0.4 Task 4 · spec §3.7 / §7.2)。
 *
 * 直测 `createTakeoverIpcHandlers`(handler 本体的全部可测逻辑);`registerTakeoverIpc` 依赖
 * electron `ipcMain`,在 electron-as-node 测试环境不可直跑(同 `dialog.test.ts` / `category.test.ts` 模式)——
 * 通道名由 `IpcChannel` 常量单一来源保证,`event.sender.id` 的取值由 typecheck 静态保证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTakeoverIpcHandlers, type TakeoverIpcService } from './takeover'
import type { TakeoverSubmitPayload } from '../../shared/ipc'

const OWNER_ID = 7
const OTHER_ID = 42

function makeHarness(): {
  handlers: ReturnType<typeof createTakeoverIpcHandlers>
  calls: string[]
  warns: string[]
} {
  const calls: string[] = []
  const warns: string[] = []
  const service: TakeoverIpcService = {
    ownsSender: (id: number) => id === OWNER_ID,
    onRendererReady: () => calls.push('ready'),
    onSubmit: (payload: TakeoverSubmitPayload) => calls.push(`submit:${payload.items.length}`),
    onDismiss: () => calls.push('dismiss'),
    onDuplicatesSettled: () => calls.push('settled')
  }
  const handlers = createTakeoverIpcHandlers({
    service,
    logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} }
  })
  return { handlers, calls, warns }
}

const PAYLOAD: TakeoverSubmitPayload = {
  items: [{ id: 'tk_1', filename: 'UU-6.15.1.exe' }],
  dir: 'D:\\Downloads'
}

test('I-11 非 takeover 窗口的 sender 打 submit → 服务零调用 + 一条 warn', () => {
  const { handlers, calls, warns } = makeHarness()
  handlers.submit(OTHER_ID, PAYLOAD)
  assert.deepEqual(calls, [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /非接管窗口/)
})

test('I-11 ready / dismiss 同样校验归属(三条都能驱动接管流程)', () => {
  const { handlers, calls, warns } = makeHarness()
  handlers.ready(OTHER_ID)
  handlers.dismiss(OTHER_ID)
  assert.deepEqual(calls, [])
  assert.equal(warns.length, 2)
})

test('I-11 归属相符 → 三条正常转发', () => {
  const { handlers, calls, warns } = makeHarness()
  handlers.ready(OWNER_ID)
  handlers.submit(OWNER_ID, PAYLOAD)
  handlers.dismiss(OWNER_ID)
  assert.deepEqual(calls, ['ready', 'submit:1', 'dismiss'])
  assert.deepEqual(warns, [])
})

test('submit 载荷形状不符 → 忽略 + 一条 warn(渲染层来的东西不做类型假设)', () => {
  const { handlers, calls, warns } = makeHarness()
  handlers.submit(OWNER_ID, null)
  handlers.submit(OWNER_ID, { items: [], dir: 1 })
  handlers.submit(OWNER_ID, { items: [{ id: 'a' }], dir: 'D:\\' })
  handlers.submit(OWNER_ID, { dir: 'D:\\' })
  assert.deepEqual(calls, [])
  assert.equal(warns.length, 4)
  // 空 items 是合法形状(用户在态 B 把条目全 × 掉)—— 由服务侧决定怎么处理,不在此拦
  handlers.submit(OWNER_ID, { items: [], dir: 'D:\\' })
  assert.deepEqual(calls, ['submit:0'])
})
