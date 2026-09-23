import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeBasename, predictExt } from './filename'
import type { ResolvedFormat } from '../../shared/ipc'

/** 构造一个 ResolvedFormat,只覆盖关注字段 */
function fmt(over: Partial<ResolvedFormat>): ResolvedFormat {
  return {
    formatId: '22',
    ext: 'mp4',
    height: 720,
    fps: 30,
    vcodec: 'avc1',
    acodec: 'mp4a.40.2',
    filesize: null,
    tbr: null,
    formatNote: null,
    ...over
  }
}

test('sanitizeBasename replaces Windows illegal chars with underscore', () => {
  assert.equal(sanitizeBasename('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j')
})

test('sanitizeBasename replaces control chars U+0000–U+001F with underscore', () => {
  // 运行时拼控制字符,避免源码内联真实 NUL
  const withControls = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x1f) + 'c'
  assert.equal(sanitizeBasename(withControls), 'a_b_c')
})

test('sanitizeBasename preserves Chinese characters and inner spaces, trims edges', () => {
  assert.equal(sanitizeBasename('  我的视频 标题  '), '我的视频 标题')
})

test('sanitizeBasename trims after replacing illegal edge chars', () => {
  // 替换发生在 trim 之前:"  <bad>  " → "  _bad_  " → trim → "_bad_"
  assert.equal(sanitizeBasename('  <bad>  '), '_bad_')
})

test('sanitizeBasename prefixes Windows reserved device names with underscore', () => {
  assert.equal(sanitizeBasename('CON'), '_CON')
  assert.equal(sanitizeBasename('nul'), '_nul') // 不分大小写
  assert.equal(sanitizeBasename('COM1.txt'), '_COM1.txt') // 判定针对去扩展名后的 stem
  assert.equal(sanitizeBasename('LPT9'), '_LPT9')
})

test('sanitizeBasename strips trailing dots and spaces (Windows drops them silently)', () => {
  assert.equal(sanitizeBasename('video.'), 'video')
  assert.equal(sanitizeBasename('a . '), 'a')
})

test('sanitizeBasename falls back to "download" when cleaning empties the name', () => {
  // 全非法字符 → 全变 `_`?不,`_` 是合法字符;真正清空的是尾部点/空格清洗后为空
  assert.equal(sanitizeBasename('. . '), 'download')
  assert.equal(sanitizeBasename('   '), 'download')
})

test('sanitizeBasename leaves normal titles byte-for-byte unchanged', () => {
  assert.equal(sanitizeBasename('我的视频 标题'), '我的视频 标题') // 中文 + 内部空格
  assert.equal(sanitizeBasename('1.2.3 教程'), '1.2.3 教程') // 合法点:stem 是 `1`,非保留名
  assert.equal(sanitizeBasename('CONsole 教程'), 'CONsole 教程') // stem `CONsole` 非保留名,不误伤
})

test('predictExt returns mp3 for audioOnly (even when a format is supplied)', () => {
  assert.equal(predictExt({ audioOnly: true }), 'mp3')
  assert.equal(predictExt({ audioOnly: true }, fmt({ ext: 'webm', acodec: 'opus' })), 'mp3')
})

test('predictExt returns mp4 (merge) for batch heightCap without a concrete format', () => {
  assert.equal(predictExt({ audioOnly: false, heightCap: 1080 }), 'mp4')
})

test('predictExt returns mp4 (merge) for a video-only format needing +bestaudio', () => {
  assert.equal(
    predictExt({ audioOnly: false, formatId: '137' }, fmt({ acodec: 'none', ext: 'mp4' })),
    'mp4'
  )
})

test('predictExt returns the format ext for a muxed format (no merge)', () => {
  assert.equal(
    predictExt(
      { audioOnly: false, formatId: '22' },
      fmt({ acodec: 'opus', vcodec: 'vp9', ext: 'webm' })
    ),
    'webm'
  )
})
