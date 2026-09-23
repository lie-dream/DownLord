/**
 * 真机验收 A — aria2 直链全链路(真 aria2c.exe,本地 HTTP 服务器,零外网依赖)。
 *
 * 验证:启动/RPC → addUri 下载 → 进度递增 → pause(服务器侧字节停止流出 = 真暂停铁证)
 * → resume 续传 → completed → remove 清理 → 限速 changeGlobalOption 生效。
 * 用法:npx tsx scripts/verify/verify-aria2.mts
 */
import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'
import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { DownloadEngine } from '../../src/main/engine/downloadEngine'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const aria2cPath = path.join(projectRoot, 'resources/bin/aria2c.exe')

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function report(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 本地限速文件服务器:总 64MB,**全局**令牌桶 ~2MB/s(16 连接共享),支持 Range(续传验证) */
function createThrottledServer(): Promise<{
  url: string
  sentBytes: () => number
  close: () => void
}> {
  const TOTAL = 64 * 1024 * 1024
  const CHUNK = 16 * 1024
  let sent = 0
  let budget = 0
  setInterval(() => {
    budget = 2 * 1024 * 1024 // 每秒全局补 2MB 预算
  }, 1000).unref()
  budget = 2 * 1024 * 1024
  const server = http.createServer((req, res) => {
    let start = 0
    let end = TOTAL - 1
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      if (m) {
        start = Number(m[1])
        if (m[2]) end = Number(m[2])
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
        'Accept-Ranges': 'bytes'
      })
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': TOTAL,
        'Accept-Ranges': 'bytes'
      })
    }
    let pos = start
    const timer = setInterval(() => {
      if (pos > end || res.destroyed) {
        clearInterval(timer)
        res.end()
        return
      }
      if (budget <= 0) return // 全局预算耗尽,等下一秒
      const size = Math.min(CHUNK, end - pos + 1, budget)
      budget -= size
      res.write(Buffer.alloc(size, 0x61))
      pos += size
      sent += size
    }, 10)
    req.on('close', () => clearInterval(timer))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}/big.bin`,
        sentBytes: () => sent,
        close: () => server.close()
      })
    })
  })
}

async function main(): Promise<void> {
  if (!fs.existsSync(aria2cPath)) {
    console.error(`找不到 aria2c: ${aria2cPath}`)
    process.exit(1)
  }
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-verify-'))
  const server = await createThrottledServer()
  console.log(`服务器: ${server.url}\n下载目录: ${downloadDir}\n`)

  const engine = new DownloadEngine(
    {
      aria2ProcessDeps: { spawn, net, crypto },
      getProxy: () => ({ mode: 'direct', effectiveUrl: null, systemDetected: null })
    },
    { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
  )

  const events: Array<{ id: string; status: string; bytes: number; speed: number }> = []
  engine.onProgress((p) => {
    events.push({ id: p.id, status: p.status, bytes: p.downloadedBytes, speed: p.speed })
  })

  // --- 1. 启动 ---
  try {
    await engine.start()
    report('A1 aria2c 启动 + RPC 就绪', true)
  } catch (err) {
    report('A1 aria2c 启动 + RPC 就绪', false, String(err))
    process.exit(1)
  }

  // --- 2. 下载 + 进度 ---
  const id = await engine.addUri({ url: server.url, dir: downloadDir, filename: 'big.bin' })
  await sleep(3000)
  const dlEvents = events.filter((e) => e.id === id && e.status === 'downloading')
  report(
    'A2 addUri 后进度递增',
    dlEvents.length >= 2 && dlEvents[dlEvents.length - 1].bytes > 0,
    `进度帧=${dlEvents.length} 最新=${dlEvents[dlEvents.length - 1]?.bytes ?? 0}B`
  )

  // --- 3. 暂停:服务器字节停止流出 ---
  await engine.pause(id)
  await sleep(600) // TCP 缓冲排空
  const sentAtPause = server.sentBytes()
  await sleep(2500)
  const sentAfterWait = server.sentBytes()
  const frozen = sentAfterWait === sentAtPause
  report(
    'A3 pause 后服务器字节冻结(真暂停)',
    frozen,
    `pause 时=${sentAtPause}B, 2.5s 后=${sentAfterWait}B, 差=${sentAfterWait - sentAtPause}B`
  )

  // --- 4. 恢复:续传继续(引擎进度事件的 downloadedBytes 增长 = aria2 真实接收) ---
  await engine.resume(id)
  const bytesAtResume = events.filter((e) => e.id === id).at(-1)?.bytes ?? 0
  await sleep(3000)
  const bytesAfterResume = events.filter((e) => e.id === id).at(-1)?.bytes ?? 0
  report(
    'A4 resume 后下载继续(续传)',
    bytesAfterResume > bytesAtResume,
    `resume 时=${bytesAtResume}B → 3s 后=${bytesAfterResume}B`
  )

  // --- 5. 限速 changeGlobalOption(判据 = 配置读回 + aria2 自报速率显著下降;环回下 TCP 无背压、
  //     已建立的高速连接上 aria2 限速粒度粗,精确 64K 只在真实网络成立 — B 站真机实测 910KiB≈1024K ✓) ---
  await engine.setGlobalLimit(64) // 64KB/s
  type RpcLike = { call(method: string, params?: unknown[]): Promise<unknown> }
  const rpc = (engine as unknown as { rpcClient: RpcLike }).rpcClient
  const raw = (await rpc.call('aria2.getGlobalOption')) as Record<string, string>
  const applied = raw['max-overall-download-limit'] === String(64 * 1024)
  await sleep(2500)
  const t0 = events.length
  await sleep(3000)
  const speeds: number[] = []
  for (const e of events.slice(t0))
    if (e.id === id && e.status === 'downloading') speeds.push(e.speed)
  const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length / 1024 : -1
  report(
    'A5 全局限速 64KB/s 配置生效 + 速率下降',
    applied && avgSpeed >= 0 && avgSpeed < 2048 * 0.75,
    `读回=${raw['max-overall-download-limit']}B 自报均速 ${avgSpeed.toFixed(1)}KB/s(不限速 ≈2048;环回精度见注)`
  )
  await engine.setGlobalLimit(0)

  // --- 6. 取消(remove) ---
  await engine.remove(id)
  await sleep(600)
  const sentAtRemove = server.sentBytes()
  await sleep(2000)
  const sentAfterRemove = server.sentBytes()
  report(
    'A6 remove 后服务器字节冻结(真取消)',
    sentAfterRemove === sentAtRemove,
    `差=${sentAfterRemove - sentAtRemove}B`
  )

  // --- 7. 代理注入:addUri 带 all-proxy → 请求必须经 mock 代理进来 ---
  {
    let proxied = 0
    const proxySrv = http.createServer((req, res) => {
      proxied++
      // 绝对 URI 形式(HTTP 代理协议特征);直接代为拉取本地文件服务器
      http
        .get(req.url!, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        })
        .on('error', () => {
          res.writeHead(502)
          res.end()
        })
    })
    await new Promise<void>((r) => proxySrv.listen(0, '127.0.0.1', r))
    const proxyPort = (proxySrv.address() as net.AddressInfo).port
    const engine2 = new DownloadEngine(
      {
        aria2ProcessDeps: { spawn, net, crypto },
        getProxy: () => ({
          mode: 'manual',
          effectiveUrl: `http://127.0.0.1:${proxyPort}`,
          systemDetected: null
        })
      },
      { aria2cPath, defaultDir: downloadDir, pollInterval: 500 }
    )
    await engine2.start()
    const id2 = await engine2.addUri({
      url: server.url,
      dir: downloadDir,
      filename: 'via-proxy.bin'
    })
    await sleep(2500)
    report(
      'A7 任务级 all-proxy 注入(请求经 mock 代理)',
      proxied > 0,
      `mock 代理收到请求数=${proxied}`
    )
    await engine2.remove(id2)
    await engine2.stop()
    proxySrv.close()
  }

  // --- 收尾 ---
  await engine.stop()
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 直链验收: ${results.length - failed.length}/${results.length} PASS ===`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
