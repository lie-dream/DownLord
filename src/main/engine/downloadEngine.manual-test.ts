/**
 * 临时验证脚本 — Phase 2 进度轮询 + 崩溃自动重启
 *
 * 用法（手动执行）：
 * 1. 确保 resources/bin/aria2c.exe 存在
 * 2. tsx src/main/engine/downloadEngine.manual-test.ts
 * 3. 观察进度输出
 * 4. 手动 kill aria2c 进程，观察自动重启和续传
 *
 * 验证点：
 * - 进度递增
 * - kill aria2c 后自动重启
 * - 重提任务并续传（依赖 .aria2 文件）
 * - 主进程不崩溃
 */

import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import { DownloadEngine } from './downloadEngine'

async function main(): Promise<void> {
  console.log('=== DownloadEngine Phase 2 手动验证 ===\n')

  // 定位 aria2c（假设在 resources/bin/）
  const projectRoot = path.resolve(__dirname, '../../..')
  const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

  if (!fs.existsSync(aria2cPath)) {
    console.error(`错误: 找不到 aria2c.exe: ${aria2cPath}`)
    console.error('请确保 resources/bin/aria2c.exe 存在')
    process.exit(1)
  }

  console.log(`✓ 找到 aria2c: ${aria2cPath}\n`)

  // 创建临时下载目录
  const downloadDir = path.join(os.tmpdir(), 'downlord-test')
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true })
  }
  console.log(`✓ 下载目录: ${downloadDir}\n`)

  // 创建 DownloadEngine
  const engine = new DownloadEngine(
    {
      aria2ProcessDeps: { spawn, net, crypto }
    },
    {
      aria2cPath,
      defaultDir: downloadDir,
      pollInterval: 1000
    }
  )

  // 订阅进度
  engine.onProgress((progress) => {
    console.log(
      `[进度] id=${progress.id} status=${progress.status} ` +
        `downloaded=${(progress.downloadedBytes / 1024).toFixed(1)}KB ` +
        `total=${(progress.totalBytes / 1024).toFixed(1)}KB ` +
        `speed=${(progress.speed / 1024).toFixed(1)}KB/s ` +
        `connections=${progress.connections}`
    )

    if (progress.status === 'completed') {
      console.log(`\n✓ 任务完成: ${progress.id}\n`)
    }

    if (progress.status === 'error') {
      console.error(`\n✗ 任务失败: ${progress.id} (errorCode: ${progress.errorCode})\n`)
    }
  })

  try {
    // 启动引擎
    console.log('启动 DownloadEngine...')
    await engine.start()
    console.log('✓ DownloadEngine 已启动\n')

    // 添加一个测试下载任务（Node.js 官网小文件）
    const testUrl = 'https://nodejs.org/dist/latest/SHASUMS256.txt'
    console.log(`添加测试任务: ${testUrl}`)
    const taskId = await engine.addUri({
      url: testUrl,
      dir: downloadDir,
      filename: 'test-download.txt'
    })
    console.log(`✓ 任务已添加: ${taskId}\n`)

    console.log('观察进度输出...')
    console.log('提示: 可以手动 kill aria2c 进程来测试崩溃恢复\n')

    // 保持运行，等待用户中断
    await new Promise(() => {
      // 永久等待（Ctrl+C 退出）
    })
  } catch (err) {
    console.error('错误:', err)
    process.exit(1)
  } finally {
    console.log('\n停止 DownloadEngine...')
    await engine.stop()
    console.log('✓ 已停止')
  }
}

// 优雅退出处理
process.on('SIGINT', async () => {
  console.log('\n\n收到 Ctrl+C，正在退出...')
  process.exit(0)
})

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
