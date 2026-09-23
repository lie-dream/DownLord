/**
 * VideoEngine 单元测试 — yt-dlp 下载后端(spec §3 / plan Phase 2 Task 2.2)。
 *
 * 注入式 mock 子进程(EventEmitter + PassThrough,仿 ytdlpProcess.test.ts),不起真 yt-dlp:
 * 按脚本吐 stdout 行,断言归一的 `DownloadProgress` 序列(downloading → phase:processing →
 * completed〔带真实终路径 savePath〕)、exit≠0 → error(经 mapDownloadError)、
 * pause=kill(保 .part,不发 error)/ resume=重起 / remove=kill+清理。
 *
 * 树杀(taskkill)注入 spy:本机为 win32,默认实现会真起 taskkill,故测试一律注入 treeKill,
 * 既避免真进程、又断言 PID 兜底被调用(spec §3.5)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { AddUriInput, CookieConfig, DownloadProgress, ProxyResolved } from '../../shared/ipc'
import { VideoEngine, scrubCookiePath } from './videoEngine'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  killed: boolean
  kill(signal?: string): boolean
}

/** 假子进程:kill 触发 close(null) 模拟被信号杀死;stdout/stderr 为可写流 */
function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pid
  child.killed = false
  child.kill = (signal?: string) => {
    child.killed = true
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', null, signal ?? 'SIGTERM')
    })
    return true
  }
  return child
}

interface Harness {
  engine: VideoEngine
  children: FakeChild[]
  calls: Array<{ path: string; args: string[] }>
  events: DownloadProgress[]
  treeKilled: number[]
  /** kill 调用顺序日志(`tree:<pid>` / `kill:<pid>`):验证「先树杀后 child.kill」(修 PyInstaller orphan) */
  killOrder: string[]
}

function createHarness(
  getProxy?: () => ProxyResolved,
  statSize?: (path: string) => number | null,
  getCookie?: () => CookieConfig,
  getSpeedLimit?: () => number,
  getVideoAccel?: () => { enabled: boolean; aria2cPath: string },
  cleanPartials?: (dir: string, outputBase: string) => void
): Harness {
  const children: FakeChild[] = []
  const calls: Array<{ path: string; args: string[] }> = []
  const killOrder: string[] = []
  let pid = 1000
  const spawn = ((path: string, args: string[]) => {
    calls.push({ path, args })
    const child = makeFakeChild(++pid)
    // 包裹 kill 记录调用顺序(相对 treeKill),验证 killChild 的「先树杀后 child.kill」顺序
    const origKill = child.kill.bind(child)
    child.kill = (signal?: string) => {
      killOrder.push(`kill:${child.pid}`)
      return origKill(signal)
    }
    children.push(child)
    return child
  }) as unknown as typeof import('child_process').spawn

  const treeKilled: number[] = []
  const engine = new VideoEngine(
    {
      spawn,
      treeKill: (p) => {
        killOrder.push(`tree:${p}`)
        treeKilled.push(p)
      },
      getProxy,
      statSize,
      getCookie,
      getSpeedLimit,
      getVideoAccel,
      cleanPartials
    },
    {
      ytdlpPath: 'C:\\bin\\yt-dlp.exe',
      ffmpegPath: 'C:\\bin\\ffmpeg.exe',
      aria2cPath: 'C:\\bin\\aria2c.exe',
      defaultDir: 'D:\\Downloads'
    }
  )
  const events: DownloadProgress[] = []
  engine.onProgress((p) => events.push(p))
  return { engine, children, calls, events, treeKilled, killOrder }
}

const VIDEO_INPUT: AddUriInput = {
  url: 'https://youtu.be/abc',
  dir: 'D:\\Downloads',
  filename: 'My Video.mp4',
  video: { formatSelector: '137+bestaudio/137', audioOnly: false, mergeFormat: 'mp4' }
}

/** 排空微任务:PassThrough 'data' 与 kill 的 close 都在微任务里投递 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('VideoEngine.addUri spawns yt-dlp with download args (-f / --ffmpeg-location) and returns an id', async () => {
  const { engine, calls } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)
  assert.ok(id, '返回内部 id')
  assert.equal(calls.length, 1, '每任务一进程')
  assert.equal(calls[0].path, 'C:\\bin\\yt-dlp.exe', '用注入的 ytdlpPath')
  assert.ok(calls[0].args.includes('-f'), '含 -f 格式选择器')
  assert.ok(calls[0].args.includes('137+bestaudio/137'), '含选定格式串')
  assert.ok(calls[0].args.includes('--ffmpeg-location'), '含 --ffmpeg-location(MediaTool 退化)')
})

test('VideoEngine progress line → downloading;postprocess → phase:processing;exit 0 → completed with savePath', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  child.stdout.write('[youtube] Extracting URL\n') // 噪声行 → 忽略
  child.stdout.write('dlp:downloading|500|1000|0|250\n')
  await tick()
  const prog = events.find((e) => e.status === 'downloading' && e.phase !== 'processing')
  assert.ok(prog, '进度行 → downloading')
  assert.equal(prog!.downloadedBytes, 500)
  assert.equal(prog!.totalBytes, 1000)
  assert.equal(prog!.speed, 250)

  child.stdout.write('[Merger] Merging formats into "out.mp4"\n')
  await tick()
  const proc = events.find((e) => e.phase === 'processing')
  assert.ok(proc, '后处理行 → phase:processing')
  assert.equal(
    proc!.status,
    'downloading',
    'processing 阶段 status 仍 downloading(不污染 aria2 契约)'
  )

  child.stdout.write('D:\\Downloads\\My Video.mp4\n') // after_move:filepath 终路径
  await tick()
  child.emit('close', 0, null)
  await tick()

  const done = events.find((e) => e.status === 'completed')
  assert.ok(done, 'exit 0 → completed')
  assert.equal(done!.savePath, 'D:\\Downloads\\My Video.mp4', 'completed 带真实终路径 savePath')
  assert.equal(done!.downloadedBytes, done!.totalBytes, '完成 downloadedBytes=totalBytes')
})

test('VideoEngine 完成从最终落盘文件 stat 真实大小(修 DASH / 同名跳过场景完成 0B,2026-07-01)', async () => {
  // 注入 statSize 返回 1.4G;模拟「无 downloading 进度」(同名跳过 / DASH 最后流很小)→ lastTotal=0
  const { engine, children, events } = createHarness(undefined, () => 1_400_000_000)
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  child.stdout.write('D:\\Downloads\\My Video.mp4\n') // 仅 after_move 终路径,无进度行
  await tick()
  child.emit('close', 0, null)
  await tick()

  const done = events.find((e) => e.status === 'completed')
  assert.ok(done, 'exit 0 → completed')
  assert.equal(
    done!.totalBytes,
    1_400_000_000,
    '完成大小取最终文件 stat(而非 lastTotal=0 → 不再假 0B)'
  )
  assert.equal(done!.downloadedBytes, 1_400_000_000)
})

test('VideoEngine 0B 兜底:「has already been downloaded」跳过行 → destination 落值 → close statSize 校正真实大小/路径(spec §5.2)', async () => {
  // yt-dlp 遇同名完整文件跳过下载:只打印该行、无 dlp:downloading 进度 / after_move。
  // parseYtDlpLine 抽出该路径归一为 destination 事件 → handleLine 落 rec.destination →
  // close(0) 既有 statSize 校正真实大小(非假 0B)+ 真实 savePath(非错位预测值)。
  const { engine, children, events } = createHarness(undefined, () => 987_654_321)
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  child.stdout.write('[download] D:\\Downloads\\My Video.mp4 has already been downloaded\n')
  await tick()
  child.emit('close', 0, null)
  await tick()

  const done = events.find((e) => e.status === 'completed')
  assert.ok(done, 'exit 0 → completed')
  assert.equal(
    done!.savePath,
    'D:\\Downloads\\My Video.mp4',
    '跳过行抽出的路径 → 真实 savePath(非错位预测值)'
  )
  assert.equal(done!.totalBytes, 987_654_321, 'close 从最终文件 statSize 校正真实大小(非假 0B)')
  assert.equal(done!.downloadedBytes, 987_654_321)
})

test('VideoEngine 兜底解析 stderr 的进度行(防某些版本进度落 stderr;进度主路径见 ytdlpArgs --progress)', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  // yt-dlp 真实行为:--progress-template 的进度帧输出到 stderr(非 stdout)
  child.stderr.write('dlp:downloading|1024|25998574|NA|454013\n')
  child.stderr.write('dlp:downloading|2096128|25998574|NA|2621387\n')
  await tick()

  const dl = events.filter((e) => e.status === 'downloading')
  assert.ok(dl.length >= 2, 'stderr 的进度帧被解析为 downloading 事件(不再全程 0)')
  const last = dl[dl.length - 1]
  assert.equal(last.downloadedBytes, 2096128, 'downloaded 递增')
  assert.equal(last.totalBytes, 25998574, 'total 有值')
  assert.equal(last.speed, 2621387, 'speed 有值')
})

test('VideoEngine emits only one phase:processing even across multiple postprocess lines', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  child.stdout.write('[Merger] Merging\n')
  child.stdout.write('[ExtractAudio] Destination\n')
  child.stdout.write('Deleting original file part\n')
  await tick()
  const processingEvents = events.filter((e) => e.phase === 'processing')
  assert.equal(processingEvents.length, 1, 'phase:processing 只发一次')
})

test('VideoEngine exit≠0 (not killed) → error with readable mapped errorCode', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  child.stderr.write('ERROR: ffmpeg not found. Please install or provide --ffmpeg-location\n')
  await tick()
  child.emit('close', 1, null)
  await tick()

  const err = events.find((e) => e.status === 'error')
  assert.ok(err, 'exit≠0 → error')
  assert.ok(err!.errorCode && err!.errorCode.length > 0, 'errorCode 可读非空')
  assert.match(err!.errorCode!, /合并|ffmpeg/i, '经 mapDownloadError 映射(ffmpeg 缺失)')
})

test('VideoEngine.pause kills the process (tree-kill fallback) and emits NO error (.part kept)', async () => {
  const { engine, children, events, treeKilled } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  await engine.pause(id)
  await tick()

  assert.equal(child.killed, true, 'pause kills yt-dlp 进程')
  assert.ok(treeKilled.includes(child.pid), 'Windows 树杀兜底以 pid 调用(spec §3.5)')
  assert.equal(
    events.find((e) => e.status === 'error'),
    undefined,
    '主动 kill 不发 error'
  )
  assert.equal(
    events.find((e) => e.status === 'completed'),
    undefined,
    '主动 kill 不发 completed'
  )
})

test('VideoEngine.resume restarts a fresh yt-dlp process (same args, .part 续传)', async () => {
  const { engine, children, calls } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.pause(id)
  await tick()

  await engine.resume(id)
  assert.equal(calls.length, 2, 'resume 重起新进程')
  assert.equal(children.length, 2)
  assert.deepEqual(calls[1].args, calls[0].args, 'resume 同参数(靠 .part / --continue 续传)')
})

test('VideoEngine.remove kills the process, clears mapping, ignores later output', async () => {
  const { engine, children, events } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  await engine.remove(id)
  await tick()
  assert.equal(child.killed, true, 'remove kills 进程')

  const before = events.length
  child.stdout.write('dlp:downloading|1|2|0|1\n') // 移除后再吐进度
  await tick()
  assert.equal(events.length, before, 'remove 后输出被忽略(映射已清理)')
})

test('VideoEngine.remove 先树杀(taskkill /T /F)再 child.kill:PyInstaller Python 子进程不 orphan(修真取消假死)', async () => {
  const { engine, children, treeKilled, killOrder } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  await engine.remove(id)
  await tick()

  // 顺序关键:taskkill 整棵树在前(趁 bootloader 父进程在,覆盖真正下载的 Python 子进程),child.kill 兜底在后。
  // 反了(先 child.kill 杀父)会 orphan 子进程 → yt-dlp 后台续下到完整(假取消,2026-07-01 手测)。
  assert.deepEqual(
    killOrder,
    [`tree:${child.pid}`, `kill:${child.pid}`],
    '先 taskkill /T /F 树杀,再 child.kill 兜底'
  )
  assert.ok(treeKilled.includes(child.pid), '树杀以 pid 调用')
  assert.equal(child.killed, true, '进程被杀')
})

test('VideoEngine.stop kills all in-flight processes without emitting terminal events', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  await engine.addUri({ ...VIDEO_INPUT, filename: 'Other.mp4' })

  await engine.stop()
  await tick()

  assert.ok(
    children.every((c) => c.killed),
    'stop kills 全部在跑进程'
  )
  assert.equal(
    events.find((e) => e.status === 'error'),
    undefined,
    'stop 不发 error'
  )
})

test('VideoEngine.addUri throws when input.video is missing (路由保证存在,防御)', async () => {
  const { engine } = createHarness()
  await assert.rejects(
    engine.addUri({ url: 'https://x', dir: 'D:\\Downloads', filename: 'x.mp4' }),
    /video/i
  )
})

// ============ 代理注入(Task 7 · spec §4.2:spawnFor 前实时取 effectiveUrl 传 buildYtDlpDownloadArgs)============

test('VideoEngine.addUri appends --proxy from injected getProxy (manual 用户值)', async () => {
  const { engine, calls } = createHarness(() => ({
    mode: 'manual',
    effectiveUrl: 'http://127.0.0.1:7890',
    systemDetected: null
  }))
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--proxy')
  assert.ok(i >= 0, '含 --proxy')
  assert.equal(calls[0].args[i + 1], 'http://127.0.0.1:7890')
})

test('VideoEngine.addUri appends --proxy "" when getProxy resolves direct (null 显式关闭)', async () => {
  const { engine, calls } = createHarness(() => ({
    mode: 'direct',
    effectiveUrl: null,
    systemDetected: null
  }))
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--proxy')
  assert.ok(i >= 0, '含 --proxy')
  assert.equal(calls[0].args[i + 1], '', 'direct → --proxy 空串显式关闭(屏蔽环境 HTTP_PROXY)')
})

test('VideoEngine reads current proxy on each spawn (切档即时生效)', async () => {
  let current: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }
  const { engine, calls } = createHarness(() => current)
  await engine.addUri(VIDEO_INPUT)
  assert.equal(calls[0].args[calls[0].args.indexOf('--proxy') + 1], '', '初始 direct → 空串')

  // 切档:回调返回值变更 → 下一次 spawn(新任务)实时读到新值
  current = { mode: 'manual', effectiveUrl: 'http://127.0.0.1:7890', systemDetected: null }
  await engine.addUri({ ...VIDEO_INPUT, filename: 'Other.mp4' })
  assert.equal(
    calls[1].args[calls[1].args.indexOf('--proxy') + 1],
    'http://127.0.0.1:7890',
    '切档后下一次 spawn 读到新值'
  )
})

// ============ Cookie 注入(v0.2 Task 1 · spec §2.2 / §6.2:spawnFor 前实时取 CookieConfig,与 proxy 对称)============

test('VideoEngine.addUri appends cookie args from injected getCookie (browser 档)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, () => ({
    source: 'browser',
    browser: 'firefox',
    profile: null,
    file: null
  }))
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--cookies-from-browser')
  assert.ok(i >= 0, '含 --cookies-from-browser')
  assert.equal(calls[0].args[i + 1], 'firefox')
})

test('VideoEngine.addUri without getCookie → no cookie args (零回归,与 v0.1 逐字节等价)', async () => {
  const { engine, calls } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  assert.equal(
    calls[0].args.includes('--cookies-from-browser'),
    false,
    '未注入 getCookie → 无 cookie 参数'
  )
  assert.equal(calls[0].args.includes('--cookies'), false)
})

test('VideoEngine reads current cookie on each spawn incl. resume (切档 / resume 实时读当前档)', async () => {
  let current: CookieConfig = { source: 'none', browser: null, profile: null, file: null }
  const { engine, calls } = createHarness(undefined, undefined, () => current)
  const id = await engine.addUri(VIDEO_INPUT)
  assert.equal(
    calls[0].args.includes('--cookies-from-browser'),
    false,
    '初始 none → 无 cookie 参数'
  )

  // 切档后 pause → resume 重起:resume 也实时读当前档(spec §2.2 切档即时生效)
  current = { source: 'browser', browser: 'chrome', profile: null, file: null }
  await engine.pause(id)
  await tick()
  await engine.resume(id)
  const i = calls[1].args.indexOf('--cookies-from-browser')
  assert.ok(i >= 0 && calls[1].args[i + 1] === 'chrome', 'resume 重起读到切档后的 cookie 档')
})

// ============ 字幕注入(v0.2 Task 1 · spec §3.2:字幕随 input.video.subtitles 到位,追加下载命令)============

test('VideoEngine.addUri appends subtitle args from input.video.subtitles(字幕随 video 到位)', async () => {
  const { engine, calls } = createHarness()
  await engine.addUri({
    ...VIDEO_INPUT,
    video: {
      formatSelector: '137+bestaudio/137',
      audioOnly: false,
      mergeFormat: 'mp4',
      subtitles: { langs: ['zh-Hans', 'en'], format: 'srt', includeAuto: true }
    }
  })
  const args = calls[0].args
  assert.ok(args.includes('--write-subs'), '含 --write-subs')
  assert.ok(args.includes('--write-auto-subs'), 'includeAuto → --write-auto-subs')
  assert.equal(args[args.indexOf('--sub-langs') + 1], 'zh-Hans,en', '--sub-langs 逗号拼接')
  assert.equal(args[args.indexOf('--sub-format') + 1], 'srt/best')
})

test('VideoEngine.addUri without subtitles → no subtitle args (零回归)', async () => {
  const { engine, calls } = createHarness()
  await engine.addUri(VIDEO_INPUT) // video 无 subtitles
  assert.equal(calls[0].args.includes('--write-subs'), false, '无字幕选择 → 无字幕参数')
})

// ============ aria2c 加速 + 回退(v0.2 Task 2 · spec §3.1 / §3.3:挂 aria2c / 失败回退一次自带下载器)============

const ARIA2C = 'C:\\bin\\aria2c.exe'
const ACCEL_ON = (): { enabled: boolean; aria2cPath: string } => ({
  enabled: true,
  aria2cPath: ARIA2C
})

test('VideoEngine 挂 aria2c(getVideoAccel.enabled)→ 首次 spawn 含 --downloader <aria2cPath>', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, undefined, ACCEL_ON)
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--downloader')
  assert.ok(i >= 0, '含 --downloader')
  assert.equal(calls[0].args[i + 1], ARIA2C, '--downloader 绝对路径定位内置 aria2c(spec §3.2)')
  assert.ok(calls[0].args.includes('--downloader-args'), '含 --downloader-args')
})

test('VideoEngine fragmented(HLS/DASH)+ 加速开档 → 不挂 --downloader(主动跳过注定回退)+ --concurrent-fragments 提速(v0.3 Task 4 · #24)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, undefined, ACCEL_ON)
  await engine.addUri({
    ...VIDEO_INPUT,
    video: { ...VIDEO_INPUT.video!, fragmented: true }
  })
  assert.equal(
    calls[0].args.includes('--downloader'),
    false,
    'fragmented → 不挂 aria2c(useAccel &&= !fragmented)'
  )
  const i = calls[0].args.indexOf('--concurrent-fragments')
  assert.ok(i >= 0, '未挂 aria2c → --concurrent-fragments 分片并发提速')
  assert.equal(calls[0].args[i + 1], '4')
})

test('VideoEngine 非 fragmented(undefined)+ 加速开档 → 仍挂 --downloader(progressive / 未知保守挂,回退不退化,§7.1)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, undefined, ACCEL_ON)
  await engine.addUri(VIDEO_INPUT) // video 无 fragmented → undefined → 保守挂(零回归)
  assert.ok(
    calls[0].args.includes('--downloader'),
    'undefined fragmented → 保守挂 aria2c(与既有 452-494 回退用例一致)'
  )
})

test('VideoEngine aria2c 失败(code≠0 非 kill)→ 回退一次自带下载器:二次 spawn 无 --downloader,不发 error(保持 downloading)', async () => {
  const { engine, children, calls, events } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    ACCEL_ON
  )
  await engine.addUri(VIDEO_INPUT)
  assert.ok(calls[0].args.includes('--downloader'), '首次挂 aria2c')

  // 挂 aria2c 的下载失败:非主动 kill 的非零退出
  children[0].emit('close', 1, null)
  await tick()

  assert.equal(calls.length, 2, '回退重起一次(自带下载器)')
  assert.equal(
    calls[1].args.includes('--downloader'),
    false,
    '二次 spawn 无 --downloader(自带下载器)'
  )
  assert.equal(
    events.find((e) => e.status === 'error'),
    undefined,
    '回退期不发 error(保持 downloading,不误导)'
  )
})

test('VideoEngine accelFallbackTried 防二次回退:回退后自带下载器仍失败 → 才真 error', async () => {
  const { engine, children, calls, events } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    ACCEL_ON
  )
  await engine.addUri(VIDEO_INPUT)
  children[0].emit('close', 1, null) // 挂 aria2c 失败 → 回退
  await tick()
  assert.equal(calls.length, 2, '已回退一次')

  children[1].emit('close', 1, null) // 自带下载器仍失败
  await tick()
  assert.equal(calls.length, 2, '不再第三次 spawn(accelFallbackTried 防循环)')
  const err = events.find((e) => e.status === 'error')
  assert.ok(err, '二次(自带下载器)失败才发 error')
})

test('VideoEngine 主动 kill(pause,killed=true)不触发加速回退', async () => {
  const { engine, calls, events } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    ACCEL_ON
  )
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.pause(id) // 主动 kill → close(null,signal) 但 killed=true
  await tick()

  assert.equal(calls.length, 1, '主动 kill 不回退重起(killed=true 早返回)')
  assert.equal(
    events.find((e) => e.status === 'error'),
    undefined,
    '主动 kill 不发 error'
  )
})

test('VideoEngine 未挂 aria2c 时非零退出不回退(直接 error,零回归)', async () => {
  const { engine, children, calls, events } = createHarness() // 无 getVideoAccel → 不挂 aria2c
  await engine.addUri(VIDEO_INPUT)
  assert.equal(calls[0].args.includes('--downloader'), false, '未挂 aria2c')
  children[0].emit('close', 1, null)
  await tick()
  assert.equal(calls.length, 1, '未挂 aria2c → 不回退')
  assert.ok(
    events.find((e) => e.status === 'error'),
    '直接 error(与 v0.1 行为一致)'
  )
})

// ============ 限速传导(v0.2 Task 2 · spec §2.3 / §2.4:全局 pull / 单任务 setTaskLimit,挂/未挂两分支)============

test('VideoEngine 全局限速(getSpeedLimit)未挂 aria2c → spawn 含 --limit-rate', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, () => 1024)
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--limit-rate')
  assert.ok(i >= 0, '未挂 aria2c → 限速经 --limit-rate')
  assert.equal(calls[0].args[i + 1], '1024K')
})

test('VideoEngine 全局限速 + 挂 aria2c → 限速经 --downloader-args 传给 aria2c(--max-download-limit)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, () => 1024, ACCEL_ON)
  await engine.addUri(VIDEO_INPUT)
  const i = calls[0].args.indexOf('--downloader-args')
  assert.ok(i >= 0, '含 --downloader-args')
  assert.match(
    calls[0].args[i + 1],
    /--max-download-limit=1024K/,
    '限速传给 aria2c(§2.4:--limit-rate 对外部下载器无效)'
  )
  assert.equal(calls[0].args.includes('--limit-rate'), false, '挂 aria2c 不用 --limit-rate')
})

test('VideoEngine.setTaskLimit 下载中 → 立即无缝重起带新限速(优先于全局,不发 error;未挂 → --limit-rate)', async () => {
  const { engine, calls, events } = createHarness(undefined, undefined, undefined, () => 1024) // 全局 1024
  const id = await engine.addUri(VIDEO_INPUT)
  assert.equal(
    calls[0].args[calls[0].args.indexOf('--limit-rate') + 1],
    '1024K',
    '首次用全局 1024K'
  )

  await engine.setTaskLimit(id, 256) // 下载中应用 → kill 当前进程 + 立即重起(2026-07-09 行为升级)
  await tick()
  assert.equal(calls.length, 2, '立即重起一次')
  assert.equal(
    calls[1].args[calls[1].args.indexOf('--limit-rate') + 1],
    '256K',
    '重起带任务级 256K(优先于全局 1024K)'
  )
  assert.equal(
    events.find((e) => e.status === 'error'),
    undefined,
    '无缝重起不发 error(主动 kill)'
  )
})

test('VideoEngine.setTaskLimit 已暂停(无进程)→ 只存值不重起,resume 时生效', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, () => 1024)
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.pause(id)
  await tick()

  await engine.setTaskLimit(id, 256)
  await tick()
  assert.equal(calls.length, 1, '暂停中不重起(存值即可)')

  await engine.resume(id)
  assert.equal(
    calls[1].args[calls[1].args.indexOf('--limit-rate') + 1],
    '256K',
    'resume 的 spawnFor 读 rec.limitKBps'
  )
})

test('VideoEngine.setTaskLimit 挂 aria2c → 立即重起经 downloader-args 传 --max-download-limit(同 downloader 不清残留)', async () => {
  const cleaned: string[] = []
  const { engine, calls } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    ACCEL_ON,
    (_d, b) => cleaned.push(b)
  )
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.setTaskLimit(id, 256)
  await tick()
  assert.equal(calls.length, 2, '下载中应用 → 立即重起')
  const i = calls[1].args.indexOf('--downloader-args')
  assert.match(
    calls[1].args[i + 1],
    /--max-download-limit=256K/,
    '任务级限速经 aria2c downloader-args 传导'
  )
  assert.equal(cleaned.length, 0, '仍挂 aria2c(同 downloader)→ 不清理,.aria2 正常续传')
})

test('VideoEngine.setTaskLimit(id, null) → 清除任务级覆盖,重起回落全局(v0.3 Task 4 · #25 第三态)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, () => 1024) // 全局 1024
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.setTaskLimit(id, 256)
  await tick()
  assert.equal(
    calls[1].args[calls[1].args.indexOf('--limit-rate') + 1],
    '256K',
    '前置:任务级 256K 覆盖全局'
  )

  await engine.setTaskLimit(id, null) // 「跟随全局」
  await tick()
  assert.equal(calls.length, 3, 'null 同样下载中立即重起')
  assert.equal(
    calls[2].args[calls[2].args.indexOf('--limit-rate') + 1],
    '1024K',
    'rec.limitKBps=undefined → spawnFor 的 `rec.limitKBps ?? globalKbps` 回落全局 1024K'
  )
})

test('VideoEngine.setTaskLimit 三态可分:0 = 本任务真不限(无 --limit-rate)≠ null = 跟随全局(v0.3 Task 4 · #25)', async () => {
  const { engine, calls } = createHarness(undefined, undefined, undefined, () => 1024) // 全局 1024
  const id = await engine.addUri(VIDEO_INPUT)

  await engine.setTaskLimit(id, 0) // 本任务不限(覆盖全局 1024)
  await tick()
  assert.equal(
    calls[1].args.includes('--limit-rate'),
    false,
    '0 → 覆盖全局为「不限」:重起不带 --limit-rate'
  )

  await engine.setTaskLimit(id, null) // 清除覆盖 → 回落全局 1024
  await tick()
  assert.equal(
    calls[2].args[calls[2].args.indexOf('--limit-rate') + 1],
    '1024K',
    'null ≠ 0:清除覆盖后回落全局 1024K(video 引擎三态真可分)'
  )
})

// ==================== 多流进度聚合(2026-07-09:切流 / 暂停恢复进度不回跳)====================

test('VideoEngine 双流(DASH)进度单调:第二流不把 downloadedBytes 打回 0', async () => {
  const { engine, children, events } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  // 视频流:下载中 → finished(72MB)
  child.stdout.write('dlp:downloading|1000|72000|NA|500' + String.fromCharCode(10))
  child.stdout.write('dlp:finished|NA|72000|NA|NA' + String.fromCharCode(10))
  // 音频流:从 0 起(未聚合时会回跳到 0/9000)
  child.stdout.write('dlp:downloading|300|9000|NA|400' + String.fromCharCode(10))
  await tick()

  const frames = events.filter((e) => e.status === 'downloading')
  assert.equal(frames.length, 2, 'finished 帧只累计基数不发帧(重放已完整流不把百分比闪到旧流 100%)')
  assert.equal(frames[0].downloadedBytes, 1000)
  assert.equal(frames[1].downloadedBytes, 72000 + 300, '第二流叠加已完成流基数,不回跳')
  assert.equal(frames[1].totalBytes, 72000 + 9000, 'total 同步聚合')
  // 全程单调
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].downloadedBytes >= frames[i - 1].downloadedBytes, `帧 ${i} 单调`)
  }
})

test('VideoEngine 恢复重起(resume)后已完整流 finished 重建基数,进度衔接不回 0', async () => {
  const { engine, children, events } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)

  // 第一次 spawn:视频流下到 20000/72000 后暂停
  children[0].stdout.write('dlp:downloading|20000|72000|NA|500' + String.fromCharCode(10))
  await tick()
  await engine.pause(id)
  await tick()

  // resume → 新 child:视频流续传完成(finished)→ 音频流从 0 起
  await engine.resume(id)
  const child2 = children[1]
  assert.ok(child2, 'resume 重起新进程')
  child2.stdout.write('dlp:finished|NA|72000|NA|NA' + String.fromCharCode(10))
  child2.stdout.write('dlp:downloading|500|9000|NA|400' + String.fromCharCode(10))
  await tick()

  const frames = events.filter((e) => e.status === 'downloading').map((e) => e.downloadedBytes)
  // 20000(暂停前)→ 72500(视频流 finished 只累计基数、音频流叠加后首帧),无任何回跳
  assert.deepEqual(frames, [20000, 72500])
})

test('VideoEngine aria2c readout 帧同样叠加流基数(挂加速的第二流不回 0)', async () => {
  const { engine, children, events } = createHarness(
    undefined,
    undefined,
    undefined,
    () => 0,
    () => ({ enabled: true, aria2cPath: ARIA2C })
  )
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  child.stdout.write('dlp:finished|NA|72000|NA|NA' + String.fromCharCode(10))
  child.stdout.write('[#abc123 1KiB/9KiB(11%) CN:8 DL:2KiB]' + String.fromCharCode(13))
  await tick()

  const frames = events.filter((e) => e.status === 'downloading')
  assert.equal(frames.length, 1, 'finished 帧只累计不发,readout 帧才发')
  assert.equal(frames[0].downloadedBytes, 72000 + 1024, 'readout 帧叠加基数(\r 分行)')
})

// ==================== 暂停→恢复诚实显示 + downloader 切换清理(2026-07-09 三轮)====================

test('VideoEngine resume 后进度诚实跟随新进程,不被暂停前水位钳死(修「进度冻结但速率变化」)', async () => {
  const { engine, children, events } = createHarness()
  const id = await engine.addUri(VIDEO_INPUT)

  // 第一次 spawn:下到 50000/95000 后暂停
  children[0].stdout.write('dlp:downloading|50000|95000|NA|500\n')
  await tick()
  await engine.pause(id)
  await tick()

  // resume:控制文件过期(硬杀 + aria2c 默认 60s 才 autosave)→ 新进程从低位重报。
  // 显示必须跟随真实值——跨 spawn 钳制旧水位会把进度条冻死,而 speed 原样透传,
  // 正是真机「百分比不动、速率持续变化」的来源。
  await engine.resume(id)
  children[1].stdout.write('dlp:downloading|3000|95000|NA|400\n')
  children[1].stdout.write('dlp:downloading|60000|95000|NA|450\n')
  await tick()

  const frames = events.filter((e) => e.status === 'downloading').map((e) => e.downloadedBytes)
  assert.deepEqual(frames, [50000, 3000, 60000], 'resume 后各帧 = 新进程真实值(诚实,不钳制)')
})

test('VideoEngine aria2c 回退自带下载器前清理残留(分段扩长的 .part 毒化原生续传 → 416 假完成坏文件)', async () => {
  const cleaned: string[] = []
  const { engine, children, calls } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    ACCEL_ON,
    (dir, base) => cleaned.push(`${dir}|${base}`)
  )
  await engine.addUri(VIDEO_INPUT)
  assert.equal(cleaned.length, 0, '首次 spawn 不清理')

  children[0].emit('close', 1, null) // aria2c 失败 → 回退自带下载器
  await tick()
  assert.equal(calls.length, 2, '回退重起一次')
  assert.deepEqual(
    cleaned,
    ['D:\\Downloads|My Video'],
    '切换 downloader 前清理 .part/.aria2(dir + outputBase)'
  )
})

test('VideoEngine 同 downloader 的 resume 不清理(正常续传,§7.4);开关切换后 resume 才清理', async () => {
  let enabled = true
  const cleaned: string[] = []
  const { engine, children, calls } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    () => ({ enabled, aria2cPath: ARIA2C }),
    (_dir, base) => cleaned.push(base)
  )
  const id = await engine.addUri(VIDEO_INPUT)
  await engine.pause(id)
  await tick()
  await engine.resume(id) // 仍挂 aria2c:同 downloader
  assert.equal(cleaned.length, 0, '同 downloader resume 不清理(.aria2 控制文件正常续传)')
  assert.ok(calls[1].args.includes('--downloader'), '仍挂 aria2c')

  await engine.pause(id)
  await tick()
  enabled = false // 用户关加速开关
  await engine.resume(id)
  assert.equal(children.length, 3)
  assert.deepEqual(cleaned, ['My Video'], '切到自带下载器前清理 aria2c 残留')
  assert.equal(calls[2].args.includes('--downloader'), false, '第三次 spawn 用自带下载器')
})

// ==================== 2026-07-11 审计修复:spawn 失败 error+close 双触发互斥 ====================

test('spawn 失败 error+close 双触发:只发一次 error 终态,close 不再触发加速回退重起', async () => {
  // 挂 aria2c 加速(enabled → rec.accelUsed=true):修复前 close 分支 code!==0 && accelUsed &&
  // !accelFallbackTried → 对已报错、已清理的任务再 spawnFor 一次注定失败的进程(三连 error 日志)
  const { engine, children, calls, events } = createHarness(
    undefined,
    undefined,
    undefined,
    undefined,
    () => ({ enabled: true, aria2cPath: ARIA2C })
  )
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]

  // Node 对 spawn 失败(ENOENT 等)的真实事件序:先 'error' 再 'close'(本机实测 code=-4058)
  child.emit('error', new Error('spawn UNKNOWN'))
  child.emit('close', -4058, null)
  await tick()

  const errors = events.filter((e) => e.status === 'error')
  assert.equal(errors.length, 1, '只发一次 error 终态(修复前 close 分支会再发)')
  assert.match(errors[0].errorCode ?? '', /无法启动视频下载/, '带 spawn 失败的真实原因')
  assert.equal(calls.length, 1, 'close 不触发加速回退重起(修复前会第二次 spawn)')
})

// ── v0.4 Task 6 Step 5b · Phase A:下载侧原始 stderr 进日志(ARCHITECTURE §6.3)────────
//
// 「下载失败的真凶看不见」是排障的第一道墙:解析侧有 `[VideoResolver] 解析失败 …\n<stderr>`,
// 下载侧却把 stderr 用完即丢。以下四条把「补上的这只眼睛」钉死,并守住红线 R4。

/** 捕获 console.error(logger 接管 console → main.log),返回捕获到的行 + 还原函数 */
function captureErrorLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  return { lines, restore: () => void (console.error = orig) }
}

test('L1 下载失败(exit≠0 非 kill)→ 原始 stderr 进日志,与解析侧同形(url= / exitCode= / 原文)', async () => {
  const { engine, children } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  const cap = captureErrorLog()
  try {
    child.stderr.write('ERROR: fragment 1 not found; unable to continue\n')
    await tick()
    child.emit('close', 1, null)
    await tick()
  } finally {
    cap.restore()
  }

  const line = cap.lines.find((l) => l.includes('[VideoEngine] 下载失败'))
  assert.ok(line, '★ 下载失败必须留下一行原文日志(补这只眼睛正是本 Step 的第一件事)')
  assert.match(line!, /url=https:\/\/youtu\.be\/abc/, '与解析侧同形:带 url=')
  assert.match(line!, /exitCode=1/, '与解析侧同形:带 exitCode=')
  assert.match(line!, /fragment 1 not found; unable to continue/, '★ stderr 原文逐字落日志')
})

test('L1 反向对照 主动 kill(pause)→ 不记下载失败日志(零命中判据配的正向对照就是 L1)', async () => {
  const { engine, children } = createHarness()
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  const cap = captureErrorLog()
  try {
    child.stderr.write('ERROR: fragment 1 not found; unable to continue\n')
    await tick()
    await engine.pause('vid_1')
    await tick()
  } finally {
    cap.restore()
  }
  assert.equal(
    cap.lines.filter((l) => l.includes('[VideoEngine] 下载失败')).length,
    0,
    '暂停不是失败,不该被记成失败'
  )
})

// ── R4(日志零 cookie 值 + 零域名)· 仿 I-C4 ─────────────────────────────────────────
//
// ★ 本 Step 对 R4 的判断,逐条写在 videoEngine.ts 的日志点注释里,要点:
//   ① cookie 值只在那份一次性 cookies.txt 里,不进 argv、不进 stderr → 零 cookie 值;
//   ② 临时文件路径可能被 yt-dlp 回显 → `scrubCookiePath` 一律抹成 `<cookies>`;
//   ③ 域名:这一行日志**与 cookie 四档无关、四档下逐字相同**,不携带「该域被借过」的信息。
//      这是**如实标注的边界**——若日后要求「日志零 URL」,该一并收敛的是解析侧与这里两处。

const COOKIE_SENTINEL = 'SESSDATA_SENTINEL_VALUE_9f3a'
const LEASE_PATH_SENTINEL = 'C:\\Temp\\downlord-cookies-9f3a\\cookies.txt'

/** 「任何一行都不含哨兵」—— 抽成函数,好让正向对照用**同一个**断言(仿 I-C4) */
function assertNoCookieTrace(lines: string[]): void {
  for (const line of lines) {
    assert.equal(line.includes(COOKIE_SENTINEL), false, `日志含 cookie 值:${line}`)
    assert.equal(line.includes(LEASE_PATH_SENTINEL), false, `日志含临时 cookie 文件路径:${line}`)
  }
}

test('L2 ★ 第四档下载失败:日志零 cookie 值、零临时文件路径(R4)', async () => {
  const children: FakeChild[] = []
  let pid = 5000
  const spawn = (() => {
    const child = makeFakeChild(++pid)
    children.push(child)
    return child
  }) as unknown as typeof import('child_process').spawn
  const engine = new VideoEngine(
    {
      spawn,
      treeKill: () => {},
      getCookie: () => ({ source: 'extension' }) as CookieConfig,
      leaseCookieFile: (hosts) => ({
        path: LEASE_PATH_SENTINEL,
        hosts,
        release: () => {}
      })
    },
    {
      ytdlpPath: 'C:\\bin\\yt-dlp.exe',
      ffmpegPath: 'C:\\bin\\ffmpeg.exe',
      aria2cPath: 'C:\\bin\\aria2c.exe',
      defaultDir: 'D:\\Downloads'
    }
  )
  await engine.addUri(VIDEO_INPUT)
  const child = children[0]
  const cap = captureErrorLog()
  try {
    // yt-dlp 把 --cookies 那个路径回显进 stderr 的形态(IO 报错时真实可能出现)
    child.stderr.write(`ERROR: unable to open cookie file ${LEASE_PATH_SENTINEL}\n`)
    // ⚠️ 这里**故意不注入一行含 cookie 值的 stderr**。理由不是回避,而是那样测不到东西:
    //    VideoEngine **结构上拿不到 cookie 值**(值只在持有层,本层只见到一个文件路径,
    //    这正是 R3 / R4 的形态保证),故它也无从 scrub。若 yt-dlp 哪天真把值打进 stderr,
    //    要收敛的是**那一层**、不是这里。本用例证的是:正常形态下这一行日志零 cookie 值。
    child.stderr.write('ERROR: fragment 1 not found; unable to continue\n')
    await tick()
    child.emit('close', 1, null)
    await tick()
  } finally {
    cap.restore()
  }
  const line = cap.lines.find((l) => l.includes('[VideoEngine] 下载失败'))
  assert.ok(line, '正向对照:这一行确实记了(否则下面的「扫不到」毫无意义)')
  assert.match(line!, /<cookies>/, '★ 临时文件路径被抹成占位')
  assertNoCookieTrace(cap.lines)
})

test('L2 正向对照 ★ 故意 log 一次哨兵 → 上面那个断言**必须**红(否则它是个假绿灯)', () => {
  // 「日志干净」与「扫描器写错了所以永远不红」输出一模一样 —— 这一条是区分二者的唯一办法。
  assert.throws(
    () => assertNoCookieTrace([`[VideoEngine] 下载失败 … --cookies ${LEASE_PATH_SENTINEL}`]),
    /日志含临时 cookie 文件路径/,
    '★ 扫描器对临时文件路径必须能红'
  )
  assert.throws(
    () => assertNoCookieTrace([`[VideoEngine] 下载失败 … SESSDATA=${COOKIE_SENTINEL}`]),
    /日志含 cookie 值/,
    '★ 扫描器对 cookie 值必须能红'
  )
})

test('L3 scrubCookiePath 纯函数:有租约 → 全部出现处抹成 <cookies>;无租约 → 原样(零回归)', () => {
  const raw = `a ${LEASE_PATH_SENTINEL} b ${LEASE_PATH_SENTINEL} c`
  assert.equal(scrubCookiePath(raw, LEASE_PATH_SENTINEL), 'a <cookies> b <cookies> c')
  assert.equal(scrubCookiePath(raw, undefined), raw, '前三档无租约 → 与改动前逐字节等价')
  assert.equal(scrubCookiePath('', LEASE_PATH_SENTINEL), '')
})
