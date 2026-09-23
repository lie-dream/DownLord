/**
 * 真机验收 D — B 站真实站点端到端(真实 VideoEngine 生产代码路径)。
 *
 * 需要:真实网络、Firefox 已登录 B 站(与应用内 Cookie 设置一致)。
 * 验证:中文标题视频 → 解析后下载(挂 aria2c + 限速 1024K + 代理)→ aria2c readout 进度帧
 * → completed savePath 中文不乱码 → 磁盘文件存在。
 * 用法:npx tsx scripts/verify/verify-bili.mts [proxyUrl](缺省 http://127.0.0.1:7890)
 */
import { spawn } from 'child_process'
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
const proxyUrl = process.argv[2] ?? 'http://127.0.0.1:7890'

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-bili-e2e-'))
  const dir = path.join(base, '下崽目录')
  fs.mkdirSync(dir, { recursive: true })

  const events: DownloadProgress[] = []
  const engine = new VideoEngine(
    {
      spawn,
      getProxy: () => ({ mode: 'manual', effectiveUrl: proxyUrl, systemDetected: null }),
      getCookie: () => ({ source: 'browser', browser: 'firefox', profile: null, file: null }),
      getSpeedLimit: () => 1024,
      getVideoAccel: () => ({ enabled: true, aria2cPath: path.join(binDir, 'aria2c.exe') })
    },
    {
      ytdlpPath,
      ffmpegPath: path.join(binDir, 'ffmpeg.exe'),
      aria2cPath: path.join(binDir, 'aria2c.exe'),
      defaultDir: dir
    }
  )
  engine.onProgress((p) => {
    events.push({ ...p })
    if (events.length % 10 === 1 || p.status !== 'downloading') {
      console.log(
        `[事件] ${p.status}${p.phase ? '/' + p.phase : ''} ${p.downloadedBytes}/${p.totalBytes}B speed=${p.speed}`
      )
    }
  })

  console.log(`目录: ${dir}\n下载中(挂 aria2c + 限速 1024K + 代理 ${proxyUrl})...`)
  await engine.addUri({
    url: 'https://www.bilibili.com/video/BV1tbKd6pEUK',
    dir,
    filename: '中文标题验证 [1080p].mp4',
    video: {
      formatSelector: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      audioOnly: false,
      mergeFormat: 'mp4'
    }
  })

  const term = await new Promise<DownloadProgress | null>((resolve) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const t = events.find((e) => e.status === 'completed' || e.status === 'error')
      if (t) {
        clearInterval(timer)
        resolve(t)
      } else if (Date.now() - t0 > 240000) {
        clearInterval(timer)
        resolve(null)
      }
    }, 500)
  })

  const frames = events.filter((e) => e.status === 'downloading' && e.downloadedBytes > 0).length
  const expected = path.join(dir, '中文标题验证 [1080p].mp4')
  console.log(`\n终态=${term?.status ?? '超时'} err=${term?.errorCode ?? '-'}`)
  console.log(`进度帧(含 aria2c readout)=${frames}`)
  console.log(`savePath=${term?.savePath ?? '-'}`)
  console.log(`期望   =${expected}`)
  const okPath = term?.savePath === expected
  const okFile = fs.existsSync(expected)
  console.log(
    `\nD1 完成=${term?.status === 'completed' ? 'PASS' : 'FAIL'}  D2 进度帧>3=${frames > 3 ? 'PASS' : 'FAIL'}  D3 中文路径无乱码=${okPath ? 'PASS' : 'FAIL'}  D4 磁盘文件存在=${okFile ? 'PASS' : 'FAIL'}`
  )
  process.exit(term?.status === 'completed' && frames > 3 && okPath && okFile ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
