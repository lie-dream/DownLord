import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFormatSelector } from './ytdlpFormat'
import type { ResolvedFormat } from '../../shared/ipc'

/** 构造一个 ResolvedFormat,只覆盖关心的字段 */
function fmt(partial: Partial<ResolvedFormat>): ResolvedFormat {
  return {
    formatId: '0',
    ext: 'mp4',
    height: null,
    fps: null,
    vcodec: null,
    acodec: null,
    filesize: null,
    tbr: null,
    formatNote: null,
    ...partial
  }
}

test('buildFormatSelector audioOnly → bestaudio/best, no merge (spec §3.3)', () => {
  assert.deepEqual(buildFormatSelector({ audioOnly: true }), {
    formatSelector: 'bestaudio/best',
    audioOnly: true
  })
})

test('buildFormatSelector muxed formatId → -f <id>, no merge (spec §3.3)', () => {
  const r = buildFormatSelector(
    { audioOnly: false, formatId: '18' },
    fmt({ formatId: '18', acodec: 'mp4a.40.2' })
  )
  assert.deepEqual(r, { formatSelector: '18', audioOnly: false })
})

test('buildFormatSelector video-only formatId → <id>+bestaudio with mp4 merge (spec §3.3)', () => {
  const r = buildFormatSelector(
    { audioOnly: false, formatId: '137' },
    fmt({ formatId: '137', acodec: 'none' })
  )
  assert.deepEqual(r, {
    formatSelector: '137+bestaudio/137',
    audioOnly: false,
    mergeFormat: 'mp4'
  })
})

test('buildFormatSelector heightCap → bestvideo[height<=H]+bestaudio with mp4 merge (spec §3.3)', () => {
  const r = buildFormatSelector({ audioOnly: false, heightCap: 1080 })
  assert.deepEqual(r, {
    formatSelector: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    audioOnly: false,
    mergeFormat: 'mp4'
  })
})

// ==================== 字幕透传(v0.2 Task 1 · spec §4.3)====================

test('buildFormatSelector 无 subtitles → VideoSubmit 不含 subtitles 键(零回归)', () => {
  const r = buildFormatSelector({ audioOnly: false, heightCap: 720 })
  assert.equal('subtitles' in r, false, '未选字幕 → 不加 subtitles 键')
})

test('buildFormatSelector 透传 choice.subtitles → VideoSubmit.subtitles(选择器逻辑不变)', () => {
  const sub = { langs: ['zh-Hans'], format: 'srt' as const, includeAuto: false }

  // heightCap 路径
  const cap = buildFormatSelector({ audioOnly: false, heightCap: 1080, subtitles: sub })
  assert.equal(cap.formatSelector, 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best')
  assert.deepEqual(cap.subtitles, sub)

  // audioOnly 路径(选择器不变,字幕仍透传;audioOnly 隐藏字幕区属 UI 逻辑)
  const audio = buildFormatSelector({ audioOnly: true, subtitles: sub })
  assert.equal(audio.formatSelector, 'bestaudio/best')
  assert.deepEqual(audio.subtitles, sub)

  // 单视频 muxed formatId 路径
  const muxed = buildFormatSelector(
    { audioOnly: false, formatId: '18', subtitles: sub },
    fmt({ formatId: '18', acodec: 'mp4a.40.2' })
  )
  assert.equal(muxed.formatSelector, '18')
  assert.deepEqual(muxed.subtitles, sub)
})
