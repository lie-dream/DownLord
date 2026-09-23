import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseYtDlpLine } from './ytdlpProgress'

test('parseYtDlpLine parses a downloading progress line (spec §3.4)', () => {
  assert.deepEqual(parseYtDlpLine('dlp:downloading|100|1000|0|500'), {
    type: 'progress',
    downloadedBytes: 100,
    totalBytes: 1000,
    speed: 500
  })
})

test('parseYtDlpLine falls back to estimate when total is unknown (spec §3.4 total||estimate||0)', () => {
  assert.deepEqual(parseYtDlpLine('dlp:downloading|100|0|2000|500'), {
    type: 'progress',
    downloadedBytes: 100,
    totalBytes: 2000,
    speed: 500
  })
  // total 与 estimate 均 NA → 0;speed NA → 0
  assert.deepEqual(parseYtDlpLine('dlp:downloading|50|NA|NA|NA'), {
    type: 'progress',
    downloadedBytes: 50,
    totalBytes: 0,
    speed: 0
  })
})

test('parseYtDlpLine accepts fractional speed', () => {
  const e = parseYtDlpLine('dlp:downloading|100|1000|0|512.5')
  assert.equal(e?.type, 'progress')
  if (e?.type === 'progress') assert.equal(e.speed, 512.5)
})

test('parseYtDlpLine 采纳 finished 行最终大小(修同名跳过 / 完成 0B,2026-07-01)', () => {
  // finished:downloaded 常为 NA→用 total 兜底;speed 归 0(该流已完成);
  // streamDone 标记供 VideoEngine 多流聚合(2026-07-09)
  assert.deepEqual(parseYtDlpLine('dlp:finished|NA|629172|NA|NA'), {
    type: 'progress',
    downloadedBytes: 629172,
    totalBytes: 629172,
    speed: 0,
    streamDone: true
  })
  // finished 带 downloaded 值时保留
  assert.deepEqual(parseYtDlpLine('dlp:finished|1000|1000|1000|0'), {
    type: 'progress',
    downloadedBytes: 1000,
    totalBytes: 1000,
    speed: 0,
    streamDone: true
  })
})

test('parseYtDlpLine ignores other (non-downloading/finished) dlp status lines', () => {
  assert.equal(parseYtDlpLine('dlp:error|0|0|0|0'), null)
  assert.equal(parseYtDlpLine('dlp:preprocessing|0|0|0|0'), null)
})

test('parseYtDlpLine flags post-processing lines (spec §3.4)', () => {
  assert.deepEqual(parseYtDlpLine('[Merger] Merging formats into "out.mp4"'), {
    type: 'postprocess'
  })
  assert.deepEqual(parseYtDlpLine('[ExtractAudio] Destination: song.mp3'), {
    type: 'postprocess'
  })
  assert.deepEqual(parseYtDlpLine('[VideoConvertor] Converting video'), { type: 'postprocess' })
  assert.deepEqual(parseYtDlpLine('Deleting original file out.f137.mp4 (pass -k to keep)'), {
    type: 'postprocess'
  })
})

test('parseYtDlpLine captures the after_move final path line (spec §3.4)', () => {
  assert.deepEqual(parseYtDlpLine('D:\\Downloads\\my video.mp4'), {
    type: 'destination',
    filepath: 'D:\\Downloads\\my video.mp4'
  })
  assert.deepEqual(parseYtDlpLine('/home/user/clip.mp4'), {
    type: 'destination',
    filepath: '/home/user/clip.mp4'
  })
})

test('parseYtDlpLine returns null for noise lines (spec §3.4)', () => {
  assert.equal(parseYtDlpLine('[download]  50.0% of 10.00MiB at 1.00MiB/s'), null)
  assert.equal(parseYtDlpLine('[youtube] abc123: Downloading webpage'), null)
  assert.equal(parseYtDlpLine(''), null)
  assert.equal(parseYtDlpLine('   '), null)
})

test('parseYtDlpLine captures the "has already been downloaded" skip line as destination (v0.2 Task 3 · spec §5.2)', () => {
  // 同名完整文件已存在 → yt-dlp 跳过下载,不发进度帧 → 旧链路完成 0B;抽路径作 destination
  // 供 close 时 statSize 校正真实大小 / 路径(路径含空格 → 惰性捕获到 " has already been downloaded" 前)
  assert.deepEqual(
    parseYtDlpLine('[download] D:\\Downloads\\my video [1080p].mp4 has already been downloaded'),
    { type: 'destination', filepath: 'D:\\Downloads\\my video [1080p].mp4' }
  )
  assert.deepEqual(parseYtDlpLine('[download] /home/user/clip.mp4 has already been downloaded'), {
    type: 'destination',
    filepath: '/home/user/clip.mp4'
  })
  // 普通 [download] 进度 / 目标行仍是噪声(零回归:不误判为 destination)
  assert.equal(parseYtDlpLine('[download]  50.0% of 10.00MiB at 1.00MiB/s'), null)
  assert.equal(parseYtDlpLine('[download] Destination: C:/x/y.mp4'), null)
})

// ==================== aria2c 外部下载器 readout(v0.2 Task 2 · 真机 2026-07-09)====================

test('parseYtDlpLine parses aria2c readout with ETA (挂 --downloader aria2c 期间进度唯一来源)', () => {
  assert.deepEqual(parseYtDlpLine('[#005b38 15MiB/28MiB(52%) CN:16 DL:18MiB ETA:5m58s]'), {
    type: 'progress',
    downloadedBytes: 15 * 1024 * 1024,
    totalBytes: 28 * 1024 * 1024,
    speed: 18 * 1024 * 1024
  })
})

test('parseYtDlpLine parses aria2c readout without ETA / with decimals(重绘残段 trim 后)', () => {
  assert.deepEqual(parseYtDlpLine('  [#86f331 8.3MiB/9.3MiB(89%) CN:9 DL:914KiB]'), {
    type: 'progress',
    downloadedBytes: Math.floor(8.3 * 1024 * 1024),
    totalBytes: Math.floor(9.3 * 1024 * 1024),
    speed: 914 * 1024
  })
})

test('parseYtDlpLine parses aria2c readout at 0B and without DL segment', () => {
  assert.deepEqual(parseYtDlpLine('[#70e276 0B/512MiB(0%) CN:16]'), {
    type: 'progress',
    downloadedBytes: 0,
    totalBytes: 512 * 1024 * 1024,
    speed: 0
  })
})

test('parseYtDlpLine does not mistake yt-dlp bracket tags for aria2c readout', () => {
  // [Merger] 等后处理标签仍走 postprocess;[download] 仍是噪声
  assert.deepEqual(parseYtDlpLine('[Merger] Merging formats into "out.mp4"'), {
    type: 'postprocess'
  })
  assert.equal(parseYtDlpLine('[download] Destination: C:/x/y.mp4'), null)
})

test('parseYtDlpLine decodes JSON destination line (after_move:%(filepath)j 防 mojibake,2026-07-09)', () => {
  // 全 ASCII \u 转义:任何子进程 stdout 编码下字节都相同。
  // Windows 路径的反斜杠用 fromCharCode 拼(源码免嵌套转义歧义)
  const BS = String.fromCharCode(92)
  const winPath = ['D:', 'WorkSpace', '下崩', 'Videos', '中文.mp4'].join(BS)
  assert.deepEqual(parseYtDlpLine(JSON.stringify(winPath)), {
    type: 'destination',
    filepath: winPath
  })
  // 非路径 JSON 字符串 → 不误判为 destination
  assert.equal(parseYtDlpLine('"not a path"'), null)
})
