/**
 * `dialog:selectFile` / `dialog:selectDirectory` 结果判定单测(v0.2 Task 1 Phase 3)。
 *
 * 直测 `firstPathOrNull` 纯函数——handler 的全部可测逻辑(取消 / 无选择 → null,选中 → 首个绝对路径)。
 * handler 本体依赖 electron `ipcMain` / `dialog` / `BrowserWindow`,在 electron-as-node 测试环境下不可直跑
 * (同 category.test.ts 模式),故「取消 / 透传返回」判定抽为纯函数单测;通道名 + preload 转发由
 * IpcChannel 常量单一来源 + DownLordApi 契约的 typecheck 静态保证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstPathOrNull } from './dialog'

test('取消(canceled=true)→ null', () => {
  assert.equal(firstPathOrNull({ canceled: true, filePaths: [] }), null)
})

test('未选择(filePaths 空)→ null', () => {
  assert.equal(firstPathOrNull({ canceled: false, filePaths: [] }), null)
})

test('选中 → 透传首个绝对路径(cookies.txt)', () => {
  assert.equal(
    firstPathOrNull({ canceled: false, filePaths: ['D:\\cookies\\cookies.txt'] }),
    'D:\\cookies\\cookies.txt'
  )
})

test('多选防御:仍取首个(与 selectDirectory 契约一致)', () => {
  assert.equal(
    firstPathOrNull({ canceled: false, filePaths: ['C:\\a.txt', 'C:\\b.txt'] }),
    'C:\\a.txt'
  )
})
