import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { buildYtDlpResolveArgs, buildYtDlpDownloadArgs } from './ytdlpArgs'

/** 取某 flag 紧随其后的值(成对参数) */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// spec §3.2 进度模板(逐字符固定,供 ytdlpProgress 解析)
const PROGRESS_TEMPLATE =
  'dlp:%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s'

test('buildYtDlpResolveArgs returns the single-json flat-playlist resolve flags (spec §2.2)', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc')

  assert.deepEqual(args, [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    '--socket-timeout',
    '30',
    'https://youtu.be/abc'
  ])
})

test('buildYtDlpDownloadArgs (video, merge) emits -f/-o/progress/ffmpeg/merge/print + url last (spec §3.2)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'my_video',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '137+bestaudio', audioOnly: false, mergeFormat: 'mp4' }
  })

  assert.equal(valueAfter(args, '-f'), '137+bestaudio')
  const output = valueAfter(args, '-o')
  assert.ok(output && output.includes('my_video'))
  assert.match(output as string, /my_video\.%\(ext\)s$/)
  assert.ok(args.includes('--no-playlist'))
  assert.ok(args.includes('--newline'))
  assert.ok(
    args.includes('--progress'),
    '含 --progress(--print 隐含 quiet 会抑制进度输出,强制输出否则 UI 进度全程 0)'
  )
  assert.equal(valueAfter(args, '--progress-template'), PROGRESS_TEMPLATE)
  assert.equal(valueAfter(args, '--ffmpeg-location'), 'C:\\bin\\ffmpeg.exe')
  assert.equal(valueAfter(args, '--merge-output-format'), 'mp4')
  assert.ok(args.includes('--windows-filenames'))
  assert.ok(args.includes('--no-color'))
  assert.ok(args.includes('--no-warnings'))
  assert.ok(args.includes('--ignore-config'))
  assert.equal(valueAfter(args, '--print'), 'after_move:%(filepath)j')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc')
  // 视频(合并)路径不应出现音频提取参数
  assert.ok(!args.includes('-x'))
  assert.ok(!args.includes('--audio-format'))
})

test('buildYtDlpDownloadArgs (video) falls back to mp4 merge format when mergeFormat omitted', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false }
  })

  assert.equal(valueAfter(args, '--merge-output-format'), 'mp4')
})

test('buildYtDlpDownloadArgs (audioOnly) emits -x mp3 extraction and drops --merge-output-format (spec §3.2)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'song',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: 'bestaudio/best', audioOnly: true }
  })

  assert.equal(valueAfter(args, '-f'), 'bestaudio/best')
  assert.ok(args.includes('-x'))
  assert.equal(valueAfter(args, '--audio-format'), 'mp3')
  assert.equal(valueAfter(args, '--audio-quality'), '0')
  assert.ok(!args.includes('--merge-output-format'))
  // audioOnly 仍带统一的进度 / 终路径 / 防御参数
  assert.equal(valueAfter(args, '--progress-template'), PROGRESS_TEMPLATE)
  assert.equal(valueAfter(args, '--print'), 'after_move:%(filepath)j')
  assert.ok(args.includes('--windows-filenames'))
  assert.equal(args[args.length - 1], 'https://youtu.be/abc')
})

// ============ 代理注入(Task 7 · spec §4.2:undefined 不追加 / null→空串关闭 / 有值透传)============

test('buildYtDlpResolveArgs omits --proxy when proxy arg is undefined (向后兼容)', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc')
  assert.ok(!args.includes('--proxy'), '不传 proxy → 不追加 --proxy')
})

test('buildYtDlpResolveArgs appends --proxy <url> when given a proxy (墙外元信息也走代理)', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc', 'http://127.0.0.1:7890')
  assert.equal(valueAfter(args, '--proxy'), 'http://127.0.0.1:7890')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

test('buildYtDlpResolveArgs appends --proxy "" when proxy is null (direct/未读到显式关闭)', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc', null)
  assert.equal(valueAfter(args, '--proxy'), '', 'null → --proxy 空串(屏蔽环境 HTTP_PROXY)')
})

test('buildYtDlpDownloadArgs omits --proxy when proxy omitted (向后兼容)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false }
  })
  assert.ok(!args.includes('--proxy'))
})

test('buildYtDlpDownloadArgs appends --proxy <url> and keeps url last when proxy given', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false },
    proxy: 'socks5://127.0.0.1:7891'
  })
  assert.equal(valueAfter(args, '--proxy'), 'socks5://127.0.0.1:7891')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

test('buildYtDlpDownloadArgs appends --proxy "" when proxy is null (direct 显式关闭)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false },
    proxy: null
  })
  assert.equal(valueAfter(args, '--proxy'), '')
})

// ============ Cookie 注入(v0.2 Task 1 · spec §2.2:无 cookie 零回归 / 有 cookie 末尾追加)============

test('buildYtDlpResolveArgs 无 cookie → 与 v0.1 逐字节等价(零回归)', () => {
  // 不传 cookie(第三参 undefined)输出与既有断言完全一致
  assert.deepEqual(buildYtDlpResolveArgs('https://youtu.be/abc'), [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    '--socket-timeout',
    '30',
    'https://youtu.be/abc'
  ])
})

test('buildYtDlpResolveArgs 有 cookie → 末尾(url 前)追加 --cookies-from-browser,url 仍在最后', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc', undefined, {
    source: 'browser',
    browser: 'firefox',
    profile: null,
    file: null
  })
  assert.equal(valueAfter(args, '--cookies-from-browser'), 'firefox')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

test('buildYtDlpResolveArgs proxy + cookie 并存(proxy 在前,cookie 在后,url 最后)', () => {
  const args = buildYtDlpResolveArgs('https://youtu.be/abc', 'http://127.0.0.1:7890', {
    source: 'file',
    browser: null,
    profile: null,
    file: 'D:\\c.txt'
  })
  assert.equal(valueAfter(args, '--proxy'), 'http://127.0.0.1:7890')
  assert.equal(valueAfter(args, '--cookies'), 'D:\\c.txt')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc')
})

test('buildYtDlpDownloadArgs 无 cookie / 无字幕 → 不含 cookie / 字幕参数(零回归)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false }
  })
  assert.ok(!args.includes('--cookies-from-browser'))
  assert.ok(!args.includes('--cookies'))
  assert.ok(!args.includes('--write-subs'))
  assert.ok(!args.includes('--sub-langs'))
})

test('buildYtDlpDownloadArgs 有 cookie → 追加 cookie 参数,置于 --print 之前(不干扰落盘路径捕获)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false },
    cookie: { source: 'browser', browser: 'chrome', profile: null, file: null }
  })
  assert.equal(valueAfter(args, '--cookies-from-browser'), 'chrome')
  // cookie 片段在 --print 之前
  assert.ok(args.indexOf('--cookies-from-browser') < args.indexOf('--print'))
  assert.equal(valueAfter(args, '--print'), 'after_move:%(filepath)j')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

test('buildYtDlpDownloadArgs 有字幕(video.subtitles)→ 追加字幕参数,置于 --print 之前', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: {
      formatSelector: '22',
      audioOnly: false,
      subtitles: { langs: ['zh-Hans', 'en'], format: 'srt', includeAuto: true }
    }
  })
  assert.ok(args.includes('--write-subs'))
  assert.ok(args.includes('--write-auto-subs'))
  assert.equal(valueAfter(args, '--sub-langs'), 'zh-Hans,en')
  assert.equal(valueAfter(args, '--sub-format'), 'srt/best')
  assert.equal(valueAfter(args, '--convert-subs'), 'srt')
  // 字幕片段在 --print 之前(不干扰 after_move:filepath 捕获)
  assert.ok(args.indexOf('--write-subs') < args.indexOf('--print'))
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

// ============ downloader / 限速(v0.2 Task 2 · spec §2.4 / §6.1 / §7.7:缺省零回归 / 挂 aria2c / 回退分支)============

test('buildYtDlpDownloadArgs accel/limit 均缺省 → 无 --downloader / --limit-rate(逐字节等价 v0.1)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false }
  })
  assert.ok(!args.includes('--downloader'))
  assert.ok(!args.includes('--downloader-args'))
  assert.ok(!args.includes('--limit-rate'))
})

test('buildYtDlpDownloadArgs 挂 aria2c → 含 --downloader <path> + --downloader-args,置于 --print 之前(不干扰落盘路径捕获)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false },
    accel: { enabled: true, aria2cPath: 'C:\\bin\\aria2c.exe' },
    limitKBps: 500
  })
  assert.equal(valueAfter(args, '--downloader'), 'C:\\bin\\aria2c.exe')
  assert.equal(
    valueAfter(args, '--downloader-args'),
    'aria2c:-x 16 -s 16 -k 1M --connect-timeout=10 --auto-save-interval=1 --allow-overwrite=true --max-download-limit=500K'
  )
  // downloader 片段在 --print 之前(§6.1 / §7.7)
  assert.ok(args.indexOf('--downloader') < args.indexOf('--print'))
  assert.equal(valueAfter(args, '--print'), 'after_move:%(filepath)j')
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
  // 未挂分支的 --limit-rate 不应出现(限速已并入 downloader-args)
  assert.ok(!args.includes('--limit-rate'))
})

test('buildYtDlpDownloadArgs 回退分支(accel.enabled=false)+ 限速 → --limit-rate,不含 --downloader', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '22', audioOnly: false },
    accel: { enabled: false, aria2cPath: 'C:\\bin\\aria2c.exe' },
    limitKBps: 500
  })
  assert.ok(!args.includes('--downloader'))
  assert.equal(valueAfter(args, '--limit-rate'), '500K')
  // limit-rate 在 --print 之前
  assert.ok(args.indexOf('--limit-rate') < args.indexOf('--print'))
  assert.equal(args[args.length - 1], 'https://youtu.be/abc', 'url 仍在末尾')
})

// ── v0.4 Task 5:headers 到 yt-dlp 的两条通路(spec §4.5)──────────────────────
//
// ★ U-26 / U-27 是**基准测试**:它们在改 `ytdlpArgs.ts` 之前先写、先跑绿,断言的是
//   **改动前的当前行为**(手写整条期望数组,不用任何辅助函数推导)。此后加 `headers?`
//   参数,这两条仍绿 = 「缺省逐字节等价」的唯一可信证明。
//   ⚠️ **不要把它们改成「取当前实现再比一遍」** —— 那样改坏了也恒绿。

/** 手写的下载参数基准(改动前实测,逐字符)—— 无 proxy / cookie / 字幕 / 加速 / 限速 / headers */
const DOWNLOAD_BASELINE = [
  '-f',
  '137+bestaudio',
  '-o',
  join('D:\\Downloads', 'my_video.%(ext)s'),
  '--no-playlist',
  '--newline',
  '--progress',
  '--progress-template',
  PROGRESS_TEMPLATE,
  '--ffmpeg-location',
  'C:\\bin\\ffmpeg.exe',
  '--merge-output-format',
  'mp4',
  '--windows-filenames',
  '--no-color',
  '--no-warnings',
  '--ignore-config',
  '--socket-timeout',
  '30',
  // ⚠️ 缺省下载器分支**本来就带**这两项(`toYtdlpDownloaderArgs` 未挂 aria2c 时的自带并发)——
  //    手写基准时曾漏掉,是这条基准测试当场把它揪出来的。**这就是「手写而非取当前实现」的价值**。
  '--concurrent-fragments',
  '4',
  '--print',
  'after_move:%(filepath)j',
  'https://youtu.be/abc'
]

test('U-26 缺省逐字节等价:buildYtDlpDownloadArgs 不带 headers → 与手写期望数组完全相同', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://youtu.be/abc',
    dir: 'D:\\Downloads',
    outputBase: 'my_video',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: '137+bestaudio', audioOnly: false, mergeFormat: 'mp4' }
  })
  assert.deepStrictEqual(args, DOWNLOAD_BASELINE)
})

test('U-27 缺省逐字节等价:buildYtDlpResolveArgs(url, proxy, cookie) 三参调用与手写期望数组完全相同', () => {
  // 三参全给(且都取「不产生附加参数」的那一档)—— 证明新增第四参不改变前三参的输出
  const args = buildYtDlpResolveArgs('https://youtu.be/abc', undefined, undefined)
  assert.deepStrictEqual(args, [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    '--socket-timeout',
    '30',
    'https://youtu.be/abc'
  ])

  // proxy + cookie 都有值时同样逐字符固定(headers 缺省不得挤进这条链)
  const withOpts = buildYtDlpResolveArgs('https://youtu.be/abc', 'http://127.0.0.1:7890', {
    source: 'browser',
    browser: 'edge',
    profile: null,
    file: null
  })
  assert.deepStrictEqual(withOpts, [
    '-J',
    '--flat-playlist',
    '--no-warnings',
    '--ignore-config',
    '--no-color',
    '--socket-timeout',
    '30',
    '--proxy',
    'http://127.0.0.1:7890',
    '--cookies-from-browser',
    'edge',
    'https://youtu.be/abc'
  ])
})

test('U-28 带 headers → --referer / --user-agent 各恰好一次,顺序稳定且在 --print 之前', () => {
  const headers = { Referer: 'https://page.example.com/', 'User-Agent': 'UA/1.0' }
  const args = buildYtDlpDownloadArgs({
    url: 'https://cdn.example.com/hls/index.m3u8',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: 'best', audioOnly: false },
    headers
  })

  // ① 各恰好一次(无条件 push 或重复摊开都会让这里变 2)
  assert.equal(args.filter((a) => a === '--referer').length, 1)
  assert.equal(args.filter((a) => a === '--user-agent').length, 1)
  // ② 值正确
  assert.equal(valueAfter(args, '--referer'), 'https://page.example.com/')
  assert.equal(valueAfter(args, '--user-agent'), 'UA/1.0')
  // ③ 顺序稳定:referer 在 user-agent 之前,两者都在 --print 之前(不干扰落盘路径捕获)
  assert.ok(args.indexOf('--referer') < args.indexOf('--user-agent'))
  assert.ok(args.indexOf('--user-agent') < args.indexOf('--print'))
  assert.equal(args[args.length - 1], 'https://cdn.example.com/hls/index.m3u8', 'url 仍在末尾')
  // ④ ★ 绝不出现任意头入口
  assert.equal(args.includes('--add-header'), false)

  // ⑤ ★ 与基准逐项对账:带 headers 的输出 = 基准 + 恰好 4 个元素,其余一字不动
  const withoutHeaders = buildYtDlpDownloadArgs({
    url: 'https://cdn.example.com/hls/index.m3u8',
    dir: 'D:\\Downloads',
    outputBase: 'clip',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: 'best', audioOnly: false }
  })
  assert.equal(args.length, withoutHeaders.length + 4)
  assert.deepStrictEqual(
    args.filter((a) => !['--referer', 'https://page.example.com/', '--user-agent', 'UA/1.0'].includes(a)),
    withoutHeaders,
    '★ 除了那 4 个元素,带不带 headers 的参数序列完全相同'
  )
})

test('U-28 附:解析阶段同样带 headers(防盗链站在拉 m3u8 清单那一步就会 403)', () => {
  const args = buildYtDlpResolveArgs('https://cdn.example.com/hls/index.m3u8', undefined, undefined, {
    Referer: 'https://page.example.com/',
    'User-Agent': 'UA/1.0'
  })
  assert.equal(valueAfter(args, '--referer'), 'https://page.example.com/')
  assert.equal(valueAfter(args, '--user-agent'), 'UA/1.0')
  assert.equal(args[args.length - 1], 'https://cdn.example.com/hls/index.m3u8', 'url 仍在末尾')
  assert.equal(args.includes('--add-header'), false)
})

// ── v0.4 Task 6 Step 5b:字幕失败不再有一票否决权(2026-08-19 真机 YouTube)──────────
//
// 真机 main.log 里两条 `Unable to download video subtitles for 'zh-Hans': HTTP Error 429`
// —— stderr 只有这一行、exit 却是 1,整个任务报错。字幕是附属产物,不该能杀掉主视频。

test('S5b 要了字幕 → 追加 -i,让字幕失败不致命', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://www.youtube.com/watch?v=1WEAJ-DFkHE',
    dir: 'D:\\Downloads',
    outputBase: 'v',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: {
      formatSelector: 'best',
      audioOnly: false,
      mergeFormat: 'mp4',
      subtitles: { langs: ['zh-Hans'], includeAuto: false, format: 'srt' }
    }
  })
  assert.ok(args.includes('--write-subs'), '前提:确实要了字幕')
  assert.ok(args.includes('-i'), '★ 字幕失败不再杀掉主视频')
})

test('S5b 没要字幕 → 不加 -i(影响面精确关在「主动要了字幕」这一种情形,零回归)', () => {
  const args = buildYtDlpDownloadArgs({
    url: 'https://www.youtube.com/watch?v=1WEAJ-DFkHE',
    dir: 'D:\\Downloads',
    outputBase: 'v',
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
    video: { formatSelector: 'best', audioOnly: false, mergeFormat: 'mp4' }
  })
  assert.equal(args.includes('--write-subs'), false, '前提:没要字幕')
  assert.equal(args.includes('-i'), false, '★ 不要字幕的任务与改动前逐字节等价')
})
