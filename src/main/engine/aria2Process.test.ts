import { test } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAria2, stopAria2, watchAria2Exit, Aria2CrashDetector } from './aria2Process'
import type { ChildProcess } from 'child_process'

/**
 * aria2Process 集成测试（需要真实 aria2c 二进制）
 *
 * 这些测试标注为需要真实二进制，CI 无 aria2c 时可跳过。
 * 启用方式:resources/bin/aria2c.exe 换成真实二进制 → `DOWNLORD_REAL_ENGINE=1 npm test`。
 */

/** 清理先订阅 exit 再 kill；已退出和超时两条路径都释放监听器 / 定时器。 */
async function cleanupChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      child.off('exit', done)
      resolve()
    }
    const timer = setTimeout(done, 2000)
    child.once('exit', done)
    child.kill()
  })
}

test(
  'startAria2 - 可以 spawn 子进程并就绪 [需要真实 aria2c]',
  { skip: process.env.DOWNLORD_REAL_ENGINE !== '1' },
  async (t) => {
    const { spawn } = await import('child_process')
    const net = await import('net')
    const crypto = await import('crypto')

    const aria2cPath = './resources/bin/aria2c.exe'
    const dir = mkdtempSync(join(tmpdir(), 'downlord-aria2-process-'))

    let result: { child: ChildProcess; port: number; secret: string } | undefined = undefined
    t.after(async () => {
      try {
        await cleanupChild(result?.child)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // 注入一个简单的 rpcClient mock 用于就绪探测
    const mockRpcClient = {
      async getVersion(baseURL: string, secret: string) {
        const request = {
          jsonrpc: '2.0',
          id: '1',
          method: 'aria2.getVersion',
          params: [`token:${secret}`]
        }

        const response = await fetch(baseURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const json = await response.json()
        if (json.error) {
          throw new Error(json.error.message)
        }

        return json.result
      }
    }

    result = await startAria2({ spawn, net, crypto }, { aria2cPath, dir }, mockRpcClient)

    assert.ok(result.child, '子进程应该启动')
    assert.ok(result.port > 0, '应该分配端口')
    assert.ok(result.secret.length === 64, 'secret 应该是 64 字符十六进制')
    assert.ok(!result.child.killed, '子进程应该存活')

    // 验证可以调用 RPC
    const baseURL = `http://127.0.0.1:${result.port}/jsonrpc`
    const version = await mockRpcClient.getVersion(baseURL, result.secret)
    assert.ok(version, '应该能获取版本信息')
  }
)

test(
  'stopAria2 - 优雅关闭子进程 [需要真实 aria2c]',
  { skip: process.env.DOWNLORD_REAL_ENGINE !== '1' },
  async (t) => {
    const { spawn } = await import('child_process')
    const net = await import('net')
    const crypto = await import('crypto')

    const aria2cPath = './resources/bin/aria2c.exe'
    const dir = mkdtempSync(join(tmpdir(), 'downlord-aria2-process-'))

    let result: { child: ChildProcess; port: number; secret: string } | undefined = undefined
    t.after(async () => {
      try {
        await cleanupChild(result?.child)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    const mockRpcClient = {
      async getVersion(baseURL: string, secret: string) {
        const request = {
          jsonrpc: '2.0',
          id: '1',
          method: 'aria2.getVersion',
          params: [`token:${secret}`]
        }

        const response = await fetch(baseURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        })

        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json = await response.json()
        if (json.error) throw new Error(json.error.message)
        return json.result
      }
    }

    result = await startAria2({ spawn, net, crypto }, { aria2cPath, dir }, mockRpcClient)

    assert.ok(!result.child.killed, '启动后应该存活')

    // 创建真实 RPC client 用于关闭
    const { createRpcClient } = await import('./rpcClient')
    const rpcClient = createRpcClient({
      baseURL: `http://127.0.0.1:${result.port}/jsonrpc`,
      secret: result.secret
    })

    await stopAria2(result.child, rpcClient)

    // 等待一小段时间确保进程退出
    await new Promise((resolve) => setTimeout(resolve, 500))

    assert.ok(result.child.killed || result.child.exitCode !== null, '应该已退出')
  }
)

// ============ 崩溃风暴超限通知(审计#8 · spec §8)============

/** 假子进程:只需 EventEmitter 发 exit 事件驱动 watchAria2Exit(不起真 aria2c) */
function makeFakeExitChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess
}

test('watchAria2Exit:60s 内崩溃 >5 次 → onGiveUp 回调被调用(文案含崩溃次数,审计#8)', (t) => {
  // mock setTimeout:前 5 次崩溃走重启退避的 setTimeout,mock 掉防真实挂起 / 泄漏定时器
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = makeFakeExitChild()
  const detector = new Aria2CrashDetector()
  let restarts = 0
  const giveUps: string[] = []
  watchAria2Exit(
    child,
    detector,
    () => restarts++,
    (msg) => giveUps.push(msg)
  )

  // 连续 6 次意外退出(同一 60s 窗口):前 5 次可重启,第 6 次 recordCrash 返回 false → onGiveUp
  for (let i = 0; i < 6; i++) {
    child.emit('exit', 1, null)
  }

  assert.strictEqual(giveUps.length, 1, '超限触发一次 onGiveUp(不再静默 return)')
  assert.match(giveUps[0], /6 次/, '文案含崩溃次数(getCrashLimitError)')
  assert.strictEqual(restarts, 0, '重启走 setTimeout(被 mock 未触发),不影响 onGiveUp 断言')
})

test('watchAria2Exit:≤5 次崩溃不触发 onGiveUp(仍走重启退避,既有零回归)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = makeFakeExitChild()
  const detector = new Aria2CrashDetector()
  const giveUps: string[] = []
  watchAria2Exit(
    child,
    detector,
    () => {},
    (msg) => giveUps.push(msg)
  )

  for (let i = 0; i < 5; i++) {
    child.emit('exit', 1, null)
  }
  assert.strictEqual(giveUps.length, 0, '≤5 次不放弃(走重启退避)')
})

test('watchAria2Exit:主动关闭(isIntentionalShutdown)不触发 onGiveUp / 不计崩溃', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = makeFakeExitChild()
  const detector = new Aria2CrashDetector()
  detector.markShuttingDown()
  const giveUps: string[] = []
  let restarts = 0
  watchAria2Exit(
    child,
    detector,
    () => restarts++,
    (msg) => giveUps.push(msg)
  )

  for (let i = 0; i < 10; i++) {
    child.emit('exit', 0, 'SIGTERM')
  }
  assert.strictEqual(giveUps.length, 0, '主动关闭不触发 onGiveUp')
  assert.strictEqual(restarts, 0, '主动关闭不重启')
})
