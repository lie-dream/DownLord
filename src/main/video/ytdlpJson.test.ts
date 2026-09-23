import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseYtDlpInfoJson } from './ytdlpJson'

// 单视频 -J 信息树片段(含 audio-only / video-only / muxed 三类格式)
const SINGLE_VIDEO = {
  id: 'abc123',
  title: 'My Test Video: Part 1',
  duration: 212.5,
  thumbnail: 'https://img.example/abc.jpg',
  extractor: 'youtube',
  webpage_url: 'https://www.youtube.com/watch?v=abc123',
  formats: [
    {
      format_id: '140',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      filesize: 3456789,
      tbr: 128,
      format_note: 'audio only'
    },
    {
      format_id: '137',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'avc1.640028',
      acodec: 'none',
      filesize_approx: 51234567,
      tbr: 2500,
      format_note: '1080p'
    },
    {
      format_id: '18',
      ext: 'mp4',
      height: 360,
      fps: 30,
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      filesize: 12345678,
      tbr: 600,
      format_note: '360p'
    }
  ]
}

const PLAYLIST = {
  _type: 'playlist',
  title: 'My Playlist',
  entries: [
    { id: 'v1', title: 'Episode 1', url: 'https://youtu.be/v1', duration: 100 },
    { id: 'v2', title: 'Episode 2', webpage_url: 'https://youtu.be/v2', duration: null },
    null,
    { id: 'v3' }
  ]
}

test('parseYtDlpInfoJson maps a single video into ResolvedVideo (spec §2.3)', () => {
  const r = parseYtDlpInfoJson(SINGLE_VIDEO)
  assert.equal(r.kind, 'video')
  if (r.kind !== 'video') return
  assert.equal(r.id, 'abc123')
  assert.equal(r.title, 'My Test Video: Part 1')
  assert.equal(r.durationSec, 212.5)
  assert.equal(r.thumbnail, 'https://img.example/abc.jpg')
  assert.equal(r.extractor, 'youtube')
  assert.equal(r.webpageUrl, 'https://www.youtube.com/watch?v=abc123')
  assert.equal(r.formats.length, 3)
})

test('parseYtDlpInfoJson maps formats with filesize fallback and null-safe fields (spec §2.3)', () => {
  const r = parseYtDlpInfoJson(SINGLE_VIDEO)
  if (r.kind !== 'video') {
    assert.fail('expected a video result')
    return
  }
  const [audio, videoOnly, muxed] = r.formats

  // audio-only:height 缺 → null;filesize 直接用
  assert.equal(audio.formatId, '140')
  assert.equal(audio.height, null)
  assert.equal(audio.vcodec, 'none')
  assert.equal(audio.acodec, 'mp4a.40.2')
  assert.equal(audio.filesize, 3456789)

  // video-only:filesize 缺 → 回退 filesize_approx;acodec 'none'
  assert.equal(videoOnly.formatId, '137')
  assert.equal(videoOnly.height, 1080)
  assert.equal(videoOnly.fps, 30)
  assert.equal(videoOnly.acodec, 'none')
  assert.equal(videoOnly.filesize, 51234567)
  assert.equal(videoOnly.tbr, 2500)

  // muxed:含音轨
  assert.equal(muxed.formatId, '18')
  assert.equal(muxed.acodec, 'mp4a.40.2')
  assert.equal(muxed.filesize, 12345678)
})

test('parseYtDlpInfoJson maps a playlist and skips non-object entries (spec §2.3)', () => {
  const r = parseYtDlpInfoJson(PLAYLIST)
  assert.equal(r.kind, 'playlist')
  if (r.kind !== 'playlist') return
  assert.equal(r.title, 'My Playlist')
  assert.equal(r.entries.length, 3) // null 项被过滤
  assert.deepEqual(r.entries[0], {
    id: 'v1',
    title: 'Episode 1',
    url: 'https://youtu.be/v1',
    durationSec: 100
  })
  // webpage_url 优先于 url;duration null → durationSec null
  assert.equal(r.entries[1].url, 'https://youtu.be/v2')
  assert.equal(r.entries[1].durationSec, null)
  // 标题缺失回退 id;url 缺失 → ''
  assert.equal(r.entries[2].title, 'v3')
  assert.equal(r.entries[2].url, '')
})

test('parseYtDlpInfoJson detects playlist by entries array even without _type', () => {
  const r = parseYtDlpInfoJson({ title: 'P', entries: [{ id: 'a', title: 'A', url: 'u' }] })
  assert.equal(r.kind, 'playlist')
})

test('parseYtDlpInfoJson is defensive: empty / non-object input does not throw (spec §2.3)', () => {
  const empty = parseYtDlpInfoJson({})
  assert.equal(empty.kind, 'video')
  if (empty.kind === 'video') {
    assert.deepEqual(empty.formats, [])
    assert.equal(empty.id, '')
    assert.equal(empty.title, '')
    assert.equal(empty.durationSec, null)
    assert.equal(empty.thumbnail, null)
  }
  // null / 非对象不崩
  assert.equal(parseYtDlpInfoJson(null).kind, 'video')
  assert.equal(parseYtDlpInfoJson(42).kind, 'video')
  assert.equal(parseYtDlpInfoJson('str').kind, 'video')
})

// ==================== 字幕回填(v0.2 Task 1 · spec §3.1)====================

test('parseYtDlpInfoJson 回填 subtitles(人工 + 自动合并标注)', () => {
  const r = parseYtDlpInfoJson({
    ...SINGLE_VIDEO,
    subtitles: { en: [{ ext: 'vtt', name: 'English' }] },
    automatic_captions: { 'ai-zh': [{ ext: 'vtt', name: '中文(自动)' }] }
  })
  assert.equal(r.kind, 'video')
  if (r.kind !== 'video') return
  assert.deepEqual(r.subtitles, [
    { lang: 'en', name: 'English', auto: false },
    { lang: 'ai-zh', name: '中文(自动)', auto: true }
  ])
})

test('parseYtDlpInfoJson 无字幕字段 → subtitles 空数组(既有解析零回归)', () => {
  const r = parseYtDlpInfoJson(SINGLE_VIDEO)
  if (r.kind !== 'video') return assert.fail('expected video')
  assert.deepEqual(r.subtitles, [], '既有 SINGLE_VIDEO 无字幕字段 → 空数组兜底')
  // 既有字段零回归
  assert.equal(r.formats.length, 3)
  assert.equal(r.title, 'My Test Video: Part 1')
})

test('parseYtDlpInfoJson 空对象 → subtitles 空数组', () => {
  const r = parseYtDlpInfoJson({})
  if (r.kind === 'video') assert.deepEqual(r.subtitles, [])
})

// ==================== 传输协议 protocol 解析(v0.3 Task 4 · #24 · spec §2)====================

test('parseYtDlpInfoJson 解析 format.protocol(缺字段 → null,保守挂 aria2c)', () => {
  const r = parseYtDlpInfoJson({
    id: 'x',
    title: 't',
    formats: [
      { format_id: 'hls', ext: 'mp4', protocol: 'm3u8_native' },
      { format_id: 'prog', ext: 'mp4', protocol: 'https' },
      { format_id: 'noproto', ext: 'mp4' }
    ]
  })
  if (r.kind !== 'video') return assert.fail('expected video')
  assert.equal(r.formats[0].protocol, 'm3u8_native', 'HLS protocol 解析')
  assert.equal(r.formats[1].protocol, 'https', 'progressive protocol 解析')
  assert.equal(r.formats[2].protocol, null, '缺 protocol 字段 → null(保守挂 aria2c)')
})
