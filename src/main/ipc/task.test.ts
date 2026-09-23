/**
 * 查重广播的定向单测(U-15 / U-16;v0.4 Task 4 · spec §6.3 · plan 3.3)。
 *
 * ★ **U-15 先于实现落地**:它断言的是 **Task 3 交付态**的行为(「广播给全部未销毁窗口」)。
 *   先跑绿 = 钉死基准,再加那一行定向、确保仍绿 —— 缺省等价只能这样证明。
 *
 * 直测 `broadcastDuplicate` 的扇出主体:`registerTaskIpc` 依赖 electron `ipcMain`,在
 * electron-as-node 测试环境不可直跑(同 `bt.test.ts` / `takeover.test.ts` 既有模式);
 * 窗口集经参数注入,故 `BrowserWindow` 全程不参与。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { broadcastDuplicate, type DuplicateBroadcastWindow } from './task'
import { IpcChannel, type DuplicateConflict } from '../../shared/ipc'
const CONFLICT: DuplicateConflict = {
  conflictId: 'task_7',
  kind: 'http',
  items: [
    {
      index: 0,
      filename: 'UU-6.15.1.exe',
      qualityLabel: null,
      existingDir: 'D:\\Downloads\\Programs',
      existingPath: 'D:\\Downloads\\Programs\\UU-6.15.1.exe',
      existing: 'completed'
    }
  ]
}

interface FakeWindow extends DuplicateBroadcastWindow {
  received: { channel: string; conflict: DuplicateConflict }[]
}

function makeWindow(destroyed = false): FakeWindow {
  const received: FakeWindow['received'] = []
  return {
    received,
    isDestroyed: () => destroyed,
    webContents: { send: (channel, conflict) => void received.push({ channel, conflict }) }
  }
}

// ── U-15:缺省(不传 deps)= Task 3 交付态,广播给每一个窗口 ────────────────────

test('U-15 缺省:每一个未销毁窗口都收到 task:duplicate(= Task 3 交付态行为)', () => {
  const wins = [makeWindow(), makeWindow(), makeWindow()]

  // 不传 deps —— 这正是 Task 3 交付态的调用形态(缺省 `{}` → 判定短路)
  broadcastDuplicate(CONFLICT, undefined, wins)

  for (const [i, win] of wins.entries()) {
    assert.equal(win.received.length, 1, `第 ${i + 1} 个窗口必须收到`)
    assert.equal(win.received[0].channel, IpcChannel.TaskDuplicate)
    assert.deepStrictEqual(win.received[0].conflict, CONFLICT, '载荷原样透传,不加工')
  }
})

test('U-15 已销毁的窗口跳过(既有行为,逐字不动)', () => {
  const alive = makeWindow()
  const dead = makeWindow(true)

  broadcastDuplicate(CONFLICT, undefined, [dead, alive])

  assert.equal(dead.received.length, 0)
  assert.equal(alive.received.length, 1)
})

// ── U-16:传 isOwnedByTakeover → 命中的冲突零窗口收到(定向,主窗口全程不动)────────

test('U-16 传 () => true → 零窗口收到(冲突归接管小窗口独占)', () => {
  const wins = [makeWindow(), makeWindow(), makeWindow()]

  broadcastDuplicate(CONFLICT, { isOwnedByTakeover: () => true }, wins)

  for (const win of wins) {
    assert.equal(win.received.length, 0, '★ 主窗口不得收到接管路径的冲突(否则弹陈旧僵尸框)')
  }
})

test('U-16 判定按 conflictId 逐条走:不属于接管的照常广播', () => {
  const wins = [makeWindow(), makeWindow()]
  const owned = new Set(['task_7'])
  const deps = { isOwnedByTakeover: (id: string) => owned.has(id) }

  broadcastDuplicate(CONFLICT, deps, wins)
  assert.equal(wins[0].received.length, 0, 'task_7 属接管 → 拦下')

  broadcastDuplicate({ ...CONFLICT, conflictId: 'task_99' }, deps, wins)
  assert.equal(wins[0].received.length, 1, 'task_99 不属接管 → 照常广播')
  assert.equal(wins[1].received.length, 1)
  assert.equal(wins[0].received[0].conflict.conflictId, 'task_99')
})

test('U-16 传空 deps({}) 与不传 deps 行为相同(缺省短路,零回归)', () => {
  const a = makeWindow()
  const b = makeWindow()

  broadcastDuplicate(CONFLICT, {}, [a])
  broadcastDuplicate(CONFLICT, undefined, [b])

  assert.equal(a.received.length, 1)
  assert.deepStrictEqual(a.received, b.received)
})
