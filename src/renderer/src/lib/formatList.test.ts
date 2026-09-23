/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedFormat, ResolvedVideo } from '../../../shared/ipc'
import { buildFormatRows, extractorLabel } from './formatList'

const MB = 1024 * 1024

const fmt = (over: Partial<ResolvedFormat> = {}): ResolvedFormat => ({
  formatId: 'x',
  ext: 'mp4',
  height: 1080,
  fps: 30,
  vcodec: 'avc1.640028',
  acodec: 'mp4a.40.2',
  filesize: null,
  tbr: null,
  formatNote: null,
  ...over
})

const video = (formats: ResolvedFormat[], over: Partial<ResolvedVideo> = {}): ResolvedVideo => ({
  kind: 'video',
  id: 'i',
  title: 't',
  durationSec: 100,
  thumbnail: null,
  extractor: 'youtube',
  webpageUrl: 'u',
  formats,
  subtitles: [],
  ...over
})

test('buildFormatRows 剔除纯音频项', () => {
  const rows = buildFormatRows(
    video([
      fmt({
        formatId: 'a',
        height: null,
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        formatNote: 'audio only'
      }),
      fmt({ formatId: '720', height: 720 })
    ])
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].formatId, '720')
})

test('buildFormatRows 按 height 降序', () => {
  const rows = buildFormatRows(
    video([
      fmt({ formatId: 'c', height: 360 }),
      fmt({ formatId: 'a', height: 1080 }),
      fmt({ formatId: 'b', height: 720 })
    ])
  )
  assert.deepEqual(
    rows.map((r) => r.height),
    [1080, 720, 360]
  )
})

test('buildFormatRows 同清晰度去重并保留 muxed', () => {
  const rows = buildFormatRows(
    video([
      // 同为 1080P:video-only(需合音轨) + muxed(含音频)→ 去重保留 muxed
      fmt({ formatId: 'vonly', height: 1080, fps: 30, acodec: 'none', filesize: 500 * MB }),
      fmt({ formatId: 'muxed', height: 1080, fps: 30, acodec: 'mp4a.40.2', filesize: 480 * MB })
    ])
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].formatId, 'muxed')
  assert.match(rows[0].infoLabel, /含音频/)
})

test('buildFormatRows 大小:filesize / tbr 估算 / 未知', () => {
  const rows = buildFormatRows(
    video(
      [
        fmt({ formatId: 'known', height: 1080, filesize: 480 * MB }),
        fmt({ formatId: 'approx', height: 720, filesize: null, tbr: 1000 }),
        fmt({ formatId: 'unknown', height: 360, filesize: null, tbr: null })
      ],
      { durationSec: 100 }
    )
  )
  const byId = Object.fromEntries(rows.map((r) => [r.formatId, r.sizeLabel]))
  assert.equal(byId.known, '~ 480.0 MB')
  // tbr 1000 kbps × 100s = 1000*1000/8*100 = 12,500,000 B ≈ 11.9 MB
  assert.equal(byId.approx, '~ 11.9 MB')
  assert.equal(byId.unknown, '未知')
})

test('buildFormatRows 含音频 vs 需合音轨标注', () => {
  const rows = buildFormatRows(
    video([
      fmt({ formatId: 'm', height: 720, acodec: 'mp4a.40.2' }),
      fmt({ formatId: 'v', height: 1080, acodec: 'none' })
    ])
  )
  const byId = Object.fromEntries(rows.map((r) => [r.formatId, r.infoLabel]))
  assert.match(byId.m, /含音频/)
  assert.match(byId.v, /需合音轨/)
})

test('buildFormatRows resLabel:fps>30 显示帧率,否则仅清晰度', () => {
  const rows = buildFormatRows(
    video([
      fmt({ formatId: 'hi', height: 1080, fps: 60 }),
      fmt({ formatId: 'lo', height: 720, fps: 30 })
    ])
  )
  const byId = Object.fromEntries(rows.map((r) => [r.formatId, r.resLabel]))
  assert.equal(byId.hi, '1080P 60')
  assert.equal(byId.lo, '720P')
})

test('buildFormatRows infoLabel 含容器与编码', () => {
  const rows = buildFormatRows(
    video([fmt({ formatId: 'a', height: 1080, ext: 'mp4', vcodec: 'avc1.640028' })])
  )
  assert.match(rows[0].infoLabel, /MP4/)
  assert.match(rows[0].infoLabel, /H\.264/)
})

test('extractorLabel 已知来源映射友好名', () => {
  assert.equal(extractorLabel('youtube'), 'YouTube')
  assert.equal(extractorLabel('bilibili'), '哔哩哔哩')
  assert.equal(extractorLabel('BiliBili'), '哔哩哔哩')
  assert.equal(extractorLabel('youtube:tab'), 'YouTube')
})

test('extractorLabel 未知来源原样返回', () => {
  assert.equal(extractorLabel('mock'), 'mock')
  assert.equal(extractorLabel('somesite'), 'somesite')
})
