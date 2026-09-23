/**
 * DownloadEngine 集成测试 — 需要真实 aria2c 二进制
 *
 * 本文件验证 spec §8.2 的五条集成链路，需要真实 aria2c.exe。
 * 不设 DOWNLORD_REAL_ENGINE=1 时跳过(跳过条数会打进 npm test 的 ⏭ 摘要,不再隐形)。
 *
 * 验证链路：
 * 1. add → 进度 → 完成
 * 2. 暂停 / 恢复
 * 3. 断点续传（中断后重提）
 * 4. 崩溃自恢复（kill aria2c → 自动重启 → 续传）
 * 5. 多线程分段（connections > 1）
 *
 * 运行方式：
 * 1. 确保 resources/bin/aria2c.exe 为真实二进制（非占位文本）
 * 2. DOWNLORD_REAL_ENGINE=1 npm test（会自动收集此文件）
 * 3. 或单独运行：DOWNLORD_REAL_ENGINE=1 tsx --test src/main/engine/integration.test.ts
 */

import { test } from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'

import { DownloadEngine } from './downloadEngine'

// ==================== 本地 HTTP 服务器（支持 Range 请求）====================

/**
 * 创建支持 Range 请求的本地 HTTP 服务器，提供小文件用于测试
 */
// 维持可观察的下载窗口；不改字节/Range 语义，连接关闭立即清理发送定时器。
function sendTestBody(res: http.ServerResponse, body: Buffer): void {
  let offset = 0
  const timer = setInterval(() => {
    if (res.writableNeedDrain) return
    const next = Math.min(offset + 32 * 1024, body.length)
    res.write(body.subarray(offset, next))
    offset = next
    if (offset === body.length) {
      clearInterval(timer)
      res.end()
    }
  }, 100)
  res.once('close', () => clearInterval(timer))
}

async function createTestServer(): Promise<{
  server: http.Server
  url: string
  fileSize: number
  cleanup: () => Promise<void>
}> {
  const testContent = Buffer.alloc(10 * 1024 * 1024) // 10MB 测试文件
  // 填充可识别内容
  for (let i = 0; i < testContent.length; i++) {
    testContent[i] = i % 256
  }

  const server = http.createServer((req, res) => {
    const range = req.headers.range

    if (range) {
      // 支持 Range 请求（多线程分段下载）
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : testContent.length - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${testContent.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/octet-stream'
      })
      sendTestBody(res, testContent.subarray(start, end + 1))
    } else {
      // 完整响应
      res.writeHead(200, {
        'Content-Length': testContent.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      })
      sendTestBody(res, testContent)
    }
  })

  // 监听随机端口
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/test-file.bin`

  return {
    server,
    url,
    fileSize: testContent.length,
    cleanup: async () => {
      return new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    }
  }
}

// ==================== 辅助函数 ====================

function waitForProgress(
  engine: DownloadEngine,
  trigger: () => Promise<string>,
  status: string,
  timeoutMs = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let taskId: string | undefined
    const seen = new Set<string>()
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`等待进度超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const finish = (id: string): void => {
      clearTimeout(timeout)
      unsubscribe()
      resolve(id)
    }
    const unsubscribe = engine.onProgress((progress) => {
      if (progress.status !== status) return
      seen.add(progress.id)
      if (progress.id === taskId) finish(progress.id)
    })
    // 先订阅再触发；addUri 返回 id 之前的同步/早到帧也按准确 id 匹配。
    void Promise.resolve()
      .then(trigger)
      .then(
        (id) => {
          taskId = id
          if (seen.has(id)) finish(id)
        },
        (err: unknown) => {
          clearTimeout(timeout)
          unsubscribe()
          reject(err)
        }
      )
  })
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ==================== 集成测试 ====================

/**
 * 检查 aria2c 是否为真实二进制
 */
function isRealAria2c(aria2cPath: string): boolean {
  if (!fs.existsSync(aria2cPath)) {
    return false
  }

  const stat = fs.statSync(aria2cPath)
  // 真实 aria2c.exe 至少几百 KB，占位文本文件只有几十字节
  if (stat.size < 1000) {
    return false
  }

  return true
}

const SKIP_INTEGRATION = process.env.DOWNLORD_REAL_ENGINE !== '1' // 默认跳过;DOWNLORD_REAL_ENGINE=1 时真跑

test('集成测试 1 - add → 进度 → 完成 [需要真实 aria2c]', { skip: SKIP_INTEGRATION }, async (t) => {
  const projectRoot = path.resolve(__dirname, '../../..')
  const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

  if (!isRealAria2c(aria2cPath)) {
    console.log('⚠️  跳过：resources/bin/aria2c.exe 不是真实二进制')
    return
  }

  // 创建临时下载目录
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-integration-'))
  let testServer: Awaited<ReturnType<typeof createTestServer>> | undefined = undefined
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
  )
  t.after(async () => {
    try {
      await engine.stop()
    } finally {
      try {
        await testServer?.cleanup()
      } finally {
        fs.rmSync(downloadDir, { recursive: true, force: true })
      }
    }
  })
  testServer = await createTestServer()

  await engine.start()

  // 添加下载任务
  const taskId = await waitForProgress(
    engine,
    () =>
      engine.addUri({
        url: testServer.url,
        dir: downloadDir,
        filename: 'test-download.bin'
      }),
    'completed'
  )

  assert.ok(taskId, '应返回任务 ID')

  // 验证文件落盘且大小正确
  const downloadedFile = path.join(downloadDir, 'test-download.bin')
  assert.ok(fs.existsSync(downloadedFile), '文件应落盘')

  const stat = fs.statSync(downloadedFile)
  assert.equal(stat.size, testServer.fileSize, '文件大小应正确')
})

test('集成测试 2 - 暂停 / 恢复 [需要真实 aria2c]', { skip: SKIP_INTEGRATION }, async (t) => {
  const projectRoot = path.resolve(__dirname, '../../..')
  const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

  if (!isRealAria2c(aria2cPath)) {
    console.log('⚠️  跳过：resources/bin/aria2c.exe 不是真实二进制')
    return
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-integration-'))
  let testServer: Awaited<ReturnType<typeof createTestServer>> | undefined = undefined
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
  )
  t.after(async () => {
    try {
      await engine.stop()
    } finally {
      try {
        await testServer?.cleanup()
      } finally {
        fs.rmSync(downloadDir, { recursive: true, force: true })
      }
    }
  })
  testServer = await createTestServer()

  await engine.start()

  const taskId = await waitForProgress(
    engine,
    () =>
      engine.addUri({
        url: testServer.url,
        dir: downloadDir,
        filename: 'test-pause-resume.bin'
      }),
    'downloading'
  )

  // 暂停
  await engine.pause(taskId)
  await sleep(1000)

  const tasks = engine.list()
  const task = tasks.find((t) => t.id === taskId)
  assert.equal(task?.status, 'paused', '应处于暂停状态')

  // 恢复
  await waitForProgress(
    engine,
    async () => {
      await engine.resume(taskId)
      return taskId
    },
    'completed'
  )

  const downloadedFile = path.join(downloadDir, 'test-pause-resume.bin')
  assert.ok(fs.existsSync(downloadedFile), '文件应完整下载')
})

test(
  '集成测试 3 - 断点续传（中断后重提）[需要真实 aria2c]',
  { skip: SKIP_INTEGRATION },
  async (t) => {
    const projectRoot = path.resolve(__dirname, '../../..')
    const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

    if (!isRealAria2c(aria2cPath)) {
      console.log('⚠️  跳过：resources/bin/aria2c.exe 不是真实二进制')
      return
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-integration-'))
    let testServer: Awaited<ReturnType<typeof createTestServer>> | undefined = undefined
    const engine = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
    )
    t.after(async () => {
      try {
        await engine.stop()
      } finally {
        try {
          await testServer?.cleanup()
        } finally {
          fs.rmSync(downloadDir, { recursive: true, force: true })
        }
      }
    })
    testServer = await createTestServer()

    await engine.start()

    const filename = 'test-resume.bin'
    const taskId = await waitForProgress(
      engine,
      () =>
        engine.addUri({
          url: testServer.url,
          dir: downloadDir,
          filename
        }),
      'downloading',
      10000
    )

    // 等待部分下载
    await sleep(1000)

    // 中断：删除任务（但保留 .aria2 控制文件）
    await engine.remove(taskId)
    await sleep(500)

    // 重新提交同一任务（同 url/dir/filename）
    await waitForProgress(
      engine,
      () =>
        engine.addUri({
          url: testServer.url,
          dir: downloadDir,
          filename
        }),
      'completed'
    )

    // 验证文件大小正确
    const downloadedFile = path.join(downloadDir, filename)
    const stat = fs.statSync(downloadedFile)
    assert.equal(stat.size, testServer.fileSize, '续传后文件大小应正确')
  }
)

test(
  '集成测试 4 - 崩溃自恢复（kill aria2c）[需要真实 aria2c]',
  { skip: SKIP_INTEGRATION },
  async (t) => {
    const projectRoot = path.resolve(__dirname, '../../..')
    const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

    if (!isRealAria2c(aria2cPath)) {
      console.log('⚠️  跳过：resources/bin/aria2c.exe 不是真实二进制')
      return
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-integration-'))
    let testServer: Awaited<ReturnType<typeof createTestServer>> | undefined = undefined
    const engine = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
    )
    t.after(async () => {
      try {
        await engine.stop()
      } finally {
        try {
          await testServer?.cleanup()
        } finally {
          fs.rmSync(downloadDir, { recursive: true, force: true })
        }
      }
    })
    testServer = await createTestServer()

    await engine.start()

    const taskId = await waitForProgress(
      engine,
      () =>
        engine.addUri({
          url: testServer.url,
          dir: downloadDir,
          filename: 'test-crash-recovery.bin'
        }),
      'downloading'
    )

    await sleep(1000)

    // 模拟崩溃：真 kill aria2c 子进程。私有字段是 `child`(v1.0 Task 6 F-3 订正:原写法读不存在的
    // `aria2Child`,kill 分支从未执行,文件断言绿证明不了「真实 kill → 自动重启」)。Windows 上
    // ChildProcess.kill() = TerminateProcess,足够;不用 taskkill。
    const internal = engine as unknown as {
      child: import('node:child_process').ChildProcess | null
    }
    const pidBefore = internal.child?.pid
    assert.ok(pidBefore, '崩溃前必须拿到 aria2c 子进程 pid')
    await waitForProgress(
      engine,
      async () => {
        internal.child!.kill()
        return taskId
      },
      'completed',
      60000
    )
    // 崩溃检测经指数退避(首轮 500ms)后重启;等到 child 换成活着的新进程再断言,上限 15s(超时即红,不是宽限)
    const restartDeadline = Date.now() + 15000
    while (
      Date.now() < restartDeadline &&
      (internal.child?.pid === pidBefore || internal.child?.exitCode !== null)
    ) {
      await sleep(100)
    }
    assert.notEqual(internal.child?.pid, pidBefore, 'aria2c 必须已被重启(pid 变化)')
    assert.equal(internal.child?.exitCode, null, '重启后的 aria2c 子进程必须仍在运行')

    // 验证主进程未崩溃，文件完整
    const downloadedFile = path.join(downloadDir, 'test-crash-recovery.bin')
    assert.ok(fs.existsSync(downloadedFile), '崩溃恢复后文件应完整')

    const stat = fs.statSync(downloadedFile)
    assert.equal(stat.size, testServer.fileSize, '文件大小应正确')
  }
)

test(
  '集成测试 5 - 多线程分段（connections > 1）[需要真实 aria2c]',
  { skip: SKIP_INTEGRATION },
  async (t) => {
    const projectRoot = path.resolve(__dirname, '../../..')
    const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

    if (!isRealAria2c(aria2cPath)) {
      console.log('⚠️  跳过：resources/bin/aria2c.exe 不是真实二进制')
      return
    }

    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-integration-'))
    let testServer: Awaited<ReturnType<typeof createTestServer>> | undefined = undefined
    const engine = new DownloadEngine(
      { aria2ProcessDeps: { spawn, net, crypto } },
      { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
    )
    t.after(async () => {
      try {
        await engine.stop()
      } finally {
        try {
          await testServer?.cleanup()
        } finally {
          fs.rmSync(downloadDir, { recursive: true, force: true })
        }
      }
    })
    testServer = await createTestServer()

    let maxConnections = 0

    // 监听进度，记录最大连接数
    const off = engine.onProgress((progress) => {
      if (progress.connections > maxConnections) {
        maxConnections = progress.connections
      }
    })
    t.after(off)

    await engine.start()

    await waitForProgress(
      engine,
      () =>
        engine.addUri({
          url: testServer.url,
          dir: downloadDir,
          filename: 'test-multithread.bin'
        }),
      'completed'
    )

    // 验证曾经使用了多个连接（--split=16 / --max-connection-per-server=16 生效）
    assert.ok(maxConnections > 1, `多线程分段应生效（最大连接数 ${maxConnections} > 1）`)
  }
)
