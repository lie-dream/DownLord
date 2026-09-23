/**
 * 真机验收 C — VideoEngine(真 yt-dlp.exe)本地全链路。
 *
 * C1: 自带下载器下载本地直链 → 进度 + completed + after_move 路径
 * C2: 挂 aria2c(--downloader)同链路 → 复现真机「aria2c 加速下载失败」
 * C3: 中文目录 + 中文文件名 → after_move 回传路径是否 mojibake(编码根因实锤)
 * C4: 下载中 pause(killCurrent)→ 进程树死透 + 服务器字节冻结(真暂停铁证)
 * 用法:npx tsx scripts/verify/verify-video.mts
 */
import { spawn, execSync } from 'child_process'
import * as net from 'net'
import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { VideoEngine } from '../../src/main/video/videoEngine'
import type { DownloadProgress } from '../../src/shared/ipc'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binDir = path.join(projectRoot, 'resources/bin')
const ytdlpPath = fs.existsSync(path.join(process.env.APPDATA ?? '', 'DownLord/bin/yt-dlp.exe'))
  ? path.join(process.env.APPDATA!, 'DownLord/bin/yt-dlp.exe')
  : path.join(binDir, 'yt-dlp.exe')
const ffmpegPath = path.join(binDir, 'ffmpeg.exe')
const aria2cPath = path.join(binDir, 'aria2c.exe')

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function report(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 全局限速文件服务器(~1.5MB/s,Content-Length + Range) */
function makeServer(totalMB: number): Promise<{
  url: string
  sentBytes: () => number
  close: () => void
}> {
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
      const port = (server.address() as net.AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/video.mp4`,
        sentBytes: () => sent,
        close: () => server.close()
      })
    })
  })
}

function listEngineProcs(): string {
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq yt-dlp.exe" /FO CSV /NH & tasklist /FI "IMAGENAME eq aria2c.exe" /FO CSV /NH',
      { shell: 'cmd.exe', encoding: 'utf8' }
    )
    return out
      .split('\n')
      .filter((l) => l.includes('.exe'))
      .join(' | ')
  } catch {
    return '(tasklist 失败)'
  }
}

interface RunResult {
  events: DownloadProgress[]
  engine: VideoEngine
  id: string
}

function makeEngine(dir: string, accel: boolean, events: DownloadProgress[]): VideoEngine {
  const engine = new VideoEngine(
    {
      spawn,
      getProxy: () => ({ mode: 'direct', effectiveUrl: null, systemDetected: null }),
      getSpeedLimit: () => 0,
      getVideoAccel: () => ({ enabled: accel, aria2cPath })
    },
    { ytdlpPath, ffmpegPath, aria2cPath, defaultDir: dir }
  )
  engine.onProgress((p) => events.push({ ...p }))
  return engine
}

async function runDownload(
  dir: string,
  url: string,
  filename: string,
  accel: boolean
): Promise<RunResult> {
  const events: DownloadProgress[] = []
  const engine = makeEngine(dir, accel, events)
  const id = await engine.addUri({
    url,
    dir,
    filename,
    video: { formatSelector: 'best', audioOnly: false }
  })
  return { events, engine, id }
}

function waitTerminal(
  events: DownloadProgress[],
  timeoutMs: number
): Promise<DownloadProgress | null> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const term = events.find((e) => e.status === 'completed' || e.status === 'error')
      if (term) {
        clearInterval(timer)
        resolve(term)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        resolve(null)
      }
    }, 200)
  })
}

async function main(): Promise<void> {
  console.log(`yt-dlp: ${ytdlpPath}`)
  const version = execSync(`"${ytdlpPath}" --version`, { encoding: 'utf8' }).trim()
  console.log(`yt-dlp --version: ${version}\n`)

  // ===== C1: 自带下载器,本地直链 =====
  {
    const srv = await makeServer(6)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c1-'))
    const { events } = await runDownload(dir, srv.url, 'testfile.mp4', false)
    const term = await waitTerminal(events, 30000)
    const frames = events.filter((e) => e.status === 'downloading').length
    report(
      'C1 yt-dlp 自带下载器完成',
      term?.status === 'completed',
      `终态=${term?.status ?? '超时'} 进度帧=${frames} savePath=${term?.savePath ?? '-'} err=${term?.errorCode ?? '-'}`
    )
    srv.close()
  }

  // ===== C2: 挂 aria2c(真机回退复现) =====
  {
    const srv = await makeServer(6)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c2-'))
    const { events } = await runDownload(dir, srv.url, 'accel.mp4', true)
    const term = await waitTerminal(events, 30000)
    const frames = events.filter((e) => e.status === 'downloading').length
    report(
      'C2 挂 aria2c 加速完成(复现回退?)',
      term?.status === 'completed',
      `终态=${term?.status ?? '超时'} 进度帧=${frames} savePath=${term?.savePath ?? '-'} err=${term?.errorCode ?? '-'}`
    )
    srv.close()
  }

  // ===== C3: 中文目录 + 中文文件名(编码) =====
  {
    const srv = await makeServer(2)
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c3-'))
    const dir = path.join(base, '下崽测试')
    fs.mkdirSync(dir, { recursive: true })
    const { events } = await runDownload(dir, srv.url, '中文视频名.mp4', false)
    const term = await waitTerminal(events, 30000)
    const expected = path.join(dir, '中文视频名.mp4')
    const got = term?.savePath ?? '(无)'
    const fileOnDisk = fs.existsSync(expected)
    report(
      'C3 中文路径 after_move 回传不乱码',
      term?.status === 'completed' && got === expected,
      `期望=${expected} 实得=${got} 磁盘文件存在=${fileOnDisk}`
    )
    srv.close()
  }

  // ===== C4: 下载中暂停 → 进程树死透 + 字节冻结 =====
  {
    const srv = await makeServer(64)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c4-'))
    const { events, engine, id } = await runDownload(dir, srv.url, 'pausetest.mp4', false)
    await sleep(6000) // 让下载真正跑起来
    const framesBefore = events.filter((e) => e.status === 'downloading').length
    await engine.pause(id)
    await sleep(800)
    const procsAfterPause = listEngineProcs()
    const sentAtPause = srv.sentBytes()
    await sleep(2500)
    const sentAfter = srv.sentBytes()
    const noTerm = !events.some((e) => e.status === 'completed' || e.status === 'error')
    report(
      'C4 视频 pause 真停(进程死透+字节冻结+无终态事件)',
      sentAfter === sentAtPause && procsAfterPause === '' && noTerm,
      `进度帧=${framesBefore} 差=${sentAfter - sentAtPause}B 残留进程=[${procsAfterPause || '无'}] 无终态=${noTerm}`
    )
    srv.close()
  }

  // ===== C5: 挂 aria2c 下载中暂停(v0.2 新链路的暂停) =====
  {
    const srv = await makeServer(64)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-c5-'))
    const { events, engine, id } = await runDownload(dir, srv.url, 'pauseaccel.mp4', true)
    await sleep(6000)
    await engine.pause(id)
    await sleep(800)
    const procsAfterPause = listEngineProcs()
    const sentAtPause = srv.sentBytes()
    await sleep(2500)
    const sentAfter = srv.sentBytes()
    const noTerm = !events.some((e) => e.status === 'completed' || e.status === 'error')
    report(
      'C5 挂 aria2c 暂停真停(进程死透+字节冻结+无终态事件)',
      sentAfter === sentAtPause && procsAfterPause === '' && noTerm,
      `差=${sentAfter - sentAtPause}B 残留进程=[${procsAfterPause || '无'}] 无终态=${noTerm}`
    )
    srv.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 视频验收: ${results.length - failed.length}/${results.length} PASS ===`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
