/**
 * 全链路复现 — 真实 TaskManager + CompositeEngine + 真实 SQLite(与 GUI 按钮同一代码路径)。
 *
 * 用户真机反馈(2026-07-09):点暂停后文件仍在下载;恢复后进度从头。
 * TM1 直链(本地) / TM2 视频挂 aria2c(本地) / TM3 视频挂 aria2c(B 站真实双流,--bili 才跑)。
 * 每场景收集:暂停后 status / 服务器字节 / tasklist 残留 / 文件尺寸偷涨 / .aria2 控制文件 /
 * 恢复后前几帧 downloadedBytes(从头 vs 断点)。
 * 用法:npx tsx scripts/verify/repro-taskmanager-pause.mts [--bili]
 */
import { spawn, execSync } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'
import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { DownloadEngine } from '../../src/main/engine/downloadEngine'
import { VideoEngine } from '../../src/main/video/videoEngine'
import { CompositeDownloadEngine } from '../../src/main/engine/compositeEngine'
import { VideoResolver } from '../../src/main/video/videoResolver'
import { createYtdlpProcess } from '../../src/main/video/ytdlpProcess'
import { TaskManager } from '../../src/main/tasks/taskManager'
import { initDatabase } from '../../src/main/db/connection'
import { seedDefaultCategories } from '../../src/main/db/categoryDao'
import type { ProxyResolved, CookieConfig } from '../../src/shared/ipc'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binDir = path.join(projectRoot, 'resources/bin')
const aria2cPath = path.join(binDir, 'aria2c.exe')
const ffmpegPath = path.join(binDir, 'ffmpeg.exe')
const ytdlpPath = fs.existsSync(path.join(process.env.APPDATA ?? '', 'DownLord/bin/yt-dlp.exe'))
  ? path.join(process.env.APPDATA!, 'DownLord/bin/yt-dlp.exe')
  : path.join(binDir, 'yt-dlp.exe')
const RUN_BILI = process.argv.includes('--bili')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function walkFiles(dir: string): Array<{ p: string; size: number }> {
  const out: Array<{ p: string; size: number }> = []
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name)
      if (f.isDirectory()) out.push(...walkFiles(full))
      else out.push({ p: full, size: fs.statSync(full).size })
    }
  } catch {
    /* 读失败忽略 */
  }
  return out
}

function dirSnapshot(dir: string): string {
  return (
    walkFiles(dir)
      .map((f) => `${path.relative(dir, f.p)}=${f.size}`)
      .join(', ') || '(空)'
  )
}

function totalSize(dir: string): number {
  return walkFiles(dir).reduce((s, f) => s + f.size, 0)
}

function enginePids(): Set<string> {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq yt-dlp.exe" /FO CSV /NH & tasklist /FI "IMAGENAME eq aria2c.exe" /FO CSV /NH',
      { shell: 'cmd.exe', encoding: 'utf8' }
    )
    return new Set(
      out
        .split(String.fromCharCode(10))
        .filter((l) => l.includes('.exe'))
        .map((l) => l.split(',')[1])
    )
  } catch {
    return new Set()
  }
}

/** 全局令牌桶限速服务器(1.5MB/s) */
function makeServer(
  totalMB: number
): Promise<{ url: string; sentBytes: () => number; close: () => void }> {
  const TOTAL = totalMB * 1024 * 1024
  let sent = 0
  let budget = 1536 * 1024
  setInterval(() => {
    budget = 1536 * 1024
  }, 1000).unref()
  const server = http.createServer((req, res) => {
    let start = 0
    let end = TOTAL - 1
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    if (m) {
      start = Number(m[1])
      if (m[2]) end = Number(m[2])
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
        'Accept-Ranges': 'bytes'
      })
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
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
      if (budget <= 0) return
      const size = Math.min(16 * 1024, end - pos + 1, budget)
      budget -= size
      res.write(Buffer.alloc(size, 0x61))
      pos += size
      sent += size
    }, 10)
    req.on('close', () => clearInterval(timer))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/video.mp4`,
        sentBytes: () => sent,
        close: () => server.close()
      })
    })
  })
}

interface Ctx {
  tm: TaskManager
  frames: Array<{ id: string; status: string; bytes: number }>
  stop: () => Promise<void>
}

async function makeTaskManager(
  defaultDir: string,
  opts: { proxy?: string | null; cookieFirefox?: boolean }
): Promise<Ctx> {
  const getProxy = (): ProxyResolved => ({
    mode: 'manual' as const,
    effectiveUrl: opts.proxy ?? null,
    systemDetected: null
  })
  const getCookie = (): CookieConfig =>
    opts.cookieFirefox
      ? { source: 'browser' as const, browser: 'firefox' as const, profile: null, file: null }
      : { source: 'none' as const, browser: null, profile: null, file: null }
  const http2 = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto }, getProxy, getSpeedLimit: () => 0 },
    { aria2cPath, defaultDir, pollInterval: 500 }
  )
  const video = new VideoEngine(
    {
      spawn,
      getProxy,
      getCookie,
      getSpeedLimit: () => 0,
      getVideoAccel: () => ({ enabled: true, aria2cPath })
    },
    { ytdlpPath, ffmpegPath, aria2cPath, defaultDir }
  )
  const composite = new CompositeDownloadEngine(http2, video)
  await composite.start()
  const resolver = new VideoResolver(
    { ytdlpProcess: createYtdlpProcess({ spawn }), getProxy, getCookie },
    { ytdlpPath }
  )
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tm-db-'))
  const db = initDatabase(path.join(dbDir, 't.db'))
  seedDefaultCategories(db)
  const tm = new TaskManager(
    {
      engine: composite,
      videoResolver: resolver,
      initDatabase: () => db,
      getVideoPrefs: () => ({ defaultHeight: 1080, defaultAudioOnly: false }),
      trashItem: async () => {},
      delay: async () => {}
    },
    { dbPath: path.join(dbDir, 't.db'), defaultDir, maxConcurrent: 3 }
  )
  const frames: Ctx['frames'] = []
  tm.onProgress((p) => frames.push({ id: p.id, status: p.status, bytes: p.downloadedBytes }))
  await tm.start()
  return {
    tm,
    frames,
    stop: async () => {
      await tm.stop()
      await composite.stop()
    }
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true
    await sleep(300)
  }
  return cond()
}

async function scenario(
  name: string,
  kind: 'http' | 'video',
  url: string,
  ctx: Ctx,
  dir: string,
  srv?: { sentBytes: () => number }
): Promise<void> {
  console.log(`\n========== ${name} ==========`)
  const { tm, frames } = ctx
  const basePids = enginePids() // 基线(含本场景常驻 aria2)
  const id = await tm.addTask({ kind, source: url, dir })

  // 等待进入 downloading 且有实际字节
  const started = await waitFor(
    () => {
      const t = tm.getTask(id)
      return t?.status === 'downloading' && t.downloadedBytes > 512 * 1024
    },
    kind === 'video' ? 120000 : 30000
  )
  const beforePause = tm.getTask(id)!
  const watchDir = path.dirname(beforePause.savePath) // 分类路由后的真实落盘目录
  console.log(
    `下载中: started=${started} status=${beforePause.status} bytes=${beforePause.downloadedBytes} watchDir=${watchDir}`
  )
  if (!started) {
    console.log('!! 未进入下载,场景中止')
    return
  }

  // ---- 暂停 ----
  await tm.pauseTask(id)
  const atPause = tm.getTask(id)!
  const pauseBytes = atPause.downloadedBytes
  await sleep(800) // 缓冲排空
  const sizeA = totalSize(watchDir)
  const sentA = srv?.sentBytes() ?? -1
  await sleep(3000)
  const sizeB = totalSize(watchDir)
  const sentB = srv?.sentBytes() ?? -1
  const newPids = [...enginePids()].filter((p) => !basePids.has(p))
  console.log(`暂停后: status=${atPause.status} 断点bytes=${pauseBytes}`)
  console.log(
    `  偷跑检测: 目录尺寸 ${sizeA} → ${sizeB}(差=${sizeB - sizeA}) 服务器字节差=${srv ? sentB - sentA : 'N/A'}`
  )
  console.log(`  新增残留进程(基线差分): [${newPids.join(' ') || '无'}]`)
  console.log(`  目录快照: ${dirSnapshot(watchDir)}`)
  const stealth =
    sizeB - sizeA > 0 || (srv !== undefined && sentB - sentA > 0) || newPids.length > 0
  console.log(`  >>> 偷偷下载: ${stealth ? '!!!! 复现 !!!!' : '未复现(真停)'}`)

  // ---- 恢复 ----
  const frameMark = frames.length
  await tm.resumeTask(id)
  await waitFor(
    () =>
      frames.slice(frameMark).some((f) => f.id === id && f.status === 'downloading' && f.bytes > 0),
    90000
  )
  const resumeFrames = frames
    .slice(frameMark)
    .filter((f) => f.id === id && f.bytes > 0)
    .slice(0, 6)
  console.log(`恢复后前几帧 bytes: ${resumeFrames.map((f) => f.bytes).join(' → ') || '(90s 无帧)'}`)
  const firstBytes = resumeFrames[0]?.bytes ?? -1
  const fromScratch = firstBytes >= 0 && firstBytes < pauseBytes * 0.5
  console.log(
    `  >>> 从头下载: ${fromScratch ? `!!!! 复现 !!!!(断点 ${pauseBytes} → 首帧 ${firstBytes})` : `未复现(首帧 ${firstBytes} ≥ 断点半数)`}`
  )

  // 等终态或 90s 后放弃
  await waitFor(
    () => {
      const t = tm.getTask(id)
      return t?.status === 'completed' || t?.status === 'error'
    },
    kind === 'video' ? 180000 : 90000
  )
  const final = tm.getTask(id)!
  console.log(
    `终态: ${final.status} bytes=${final.downloadedBytes}/${final.totalBytes} err=${final.error ?? '-'} savePath=${final.savePath}`
  )
  await tm.removeTask(id).catch(() => {})
}

async function main(): Promise<void> {
  // TM1 直链(本地)
  {
    const srv = await makeServer(48)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tm1-'))
    const ctx = await makeTaskManager(dir, { proxy: null })
    await scenario('TM1 直链(本地,aria2 常驻)', 'http', srv.url, ctx, dir, srv)
    await ctx.stop()
    srv.close()
  }
  // TM2 视频挂 aria2c(本地单流)
  {
    const srv = await makeServer(48)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tm2-'))
    const ctx = await makeTaskManager(dir, { proxy: null })
    await scenario('TM2 视频挂 aria2c(本地单流)', 'video', srv.url, ctx, dir, srv)
    await ctx.stop()
    srv.close()
  }
  // TM3 B 站真实双流(需网络 + Firefox cookie + Clash)
  if (RUN_BILI) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-tm3-'))
    const ctx = await makeTaskManager(dir, { proxy: 'http://127.0.0.1:7890', cookieFirefox: true })
    await scenario(
      'TM3 视频挂 aria2c(B 站真实双流)',
      'video',
      'https://www.bilibili.com/video/BV1tbKd6pEUK',
      ctx,
      dir
    )
    await ctx.stop()
  }
  console.log('\n(完)')
  process.exit(0)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
