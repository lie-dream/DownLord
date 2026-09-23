import { test } from 'node:test'
import assert from 'node:assert/strict'

import { qualityLabelOf, qualityTag, resolvedTopHeight } from './qualityLabel'
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

test('qualityLabelOf 仅音频 → 仅音频 MP3(优先于一切,spec §3.1)', () => {
  assert.equal(qualityLabelOf({ audioOnly: true }), '仅音频 MP3')
  // 即便误带 format / heightCap,audioOnly 仍最高优先
  assert.equal(
    qualityLabelOf({ audioOnly: true, heightCap: 720 }, fmt({ height: 1080 })),
    '仅音频 MP3'
  )
})

test('qualityLabelOf 手选具体格式 height → ${height}P(精确清晰度)', () => {
  assert.equal(
    qualityLabelOf({ audioOnly: false, formatId: '137' }, fmt({ height: 1080 })),
    '1080P'
  )
  assert.equal(qualityLabelOf({ audioOnly: false, formatId: '18' }, fmt({ height: 360 })), '360P')
})

test('qualityLabelOf heightCap >= 2160 → 最高(自动按封顶)', () => {
  assert.equal(qualityLabelOf({ audioOnly: false, heightCap: 2160 }), '最高')
  assert.equal(qualityLabelOf({ audioOnly: false, heightCap: 4320 }), '最高')
})

test('qualityLabelOf heightCap 720 → ≤720P', () => {
  assert.equal(qualityLabelOf({ audioOnly: false, heightCap: 720 }), '≤720P')
  assert.equal(qualityLabelOf({ audioOnly: false, heightCap: 1080 }), '≤1080P')
})

test('qualityLabelOf 兜底无约束 → 最高', () => {
  // 无 audioOnly / 无 format.height / 无 heightCap
  assert.equal(qualityLabelOf({ audioOnly: false }), '最高')
  // format 存在但 height 为 null(缺字段)→ 不走精确分支,落兜底
  assert.equal(qualityLabelOf({ audioOnly: false, formatId: '0' }, fmt({ height: null })), '最高')
})

// ===== qualityTag(文件名清晰度短标,2026-07-01 修同名覆盖 / 跳过)=====

test('qualityTag 仅音频 → null(音频 mp3 扩展名已区分,不加标签)', () => {
  assert.equal(qualityTag({ audioOnly: true }), null)
  assert.equal(qualityTag({ audioOnly: true, heightCap: 720 }, fmt({ height: 1080 })), null)
})

test('qualityTag 手选具体格式 height → ${height}p', () => {
  assert.equal(qualityTag({ audioOnly: false, formatId: '137' }, fmt({ height: 1080 })), '1080p')
  assert.equal(qualityTag({ audioOnly: false, formatId: '18' }, fmt({ height: 360 })), '360p')
})

test('qualityTag heightCap ≥2160 → 最高 / 否则 ${cap}p', () => {
  assert.equal(qualityTag({ audioOnly: false, heightCap: 2160 }), '最高')
  assert.equal(qualityTag({ audioOnly: false, heightCap: 720 }), '720p')
  assert.equal(qualityTag({ audioOnly: false, heightCap: 1080 }), '1080p')
})

test('qualityTag 兜底无约束 → 最高', () => {
  assert.equal(qualityTag({ audioOnly: false }), '最高')
  assert.equal(qualityTag({ audioOnly: false, formatId: '0' }, fmt({ height: null })), '最高')
})

test('qualityTag 产出文件名安全(纯数字 + p,不含 ≤ 与 Windows 非法字符)', () => {
  // 与 qualityLabelOf 差异:label 用 ≤720P,tag 用 720p(可直接进文件名)
  const tag = String(qualityTag({ audioOnly: false, heightCap: 720 }))
  assert.equal(tag, '720p')
  assert.doesNotMatch(tag, /[<>:"/\\|?*]/)
})

// ===== resolvedTopHeight(#30 清晰度归一:自动 / 最高 / 封顶 → 实际最高 height)=====

test('resolvedTopHeight 无 cap → 全局最高 height', () => {
  const formats = [fmt({ height: 360 }), fmt({ height: 1080 }), fmt({ height: 720 })]
  assert.equal(resolvedTopHeight(formats), 1080)
  assert.equal(resolvedTopHeight(formats, null), 1080)
})

test('resolvedTopHeight 有 cap → ≤cap 的实际最高', () => {
  const formats = [fmt({ height: 1080 }), fmt({ height: 360 })]
  assert.equal(resolvedTopHeight(formats, 720), 360, 'cap 720、视频有 1080/360 → 360(≤720 最高)')
  assert.equal(resolvedTopHeight(formats, 1080), 1080, 'cap 1080 → 1080')
  assert.equal(resolvedTopHeight(formats, 2160), 1080, 'cap 高于所有 → 全局最高')
})

test('resolvedTopHeight 视频最高 < cap → 取实际(720 < 1080 → 720)', () => {
  const formats = [fmt({ height: 720 }), fmt({ height: 480 })]
  assert.equal(resolvedTopHeight(formats, 1080), 720)
})

test('resolvedTopHeight 无有效 height(纯音频 / 空)→ null', () => {
  assert.equal(resolvedTopHeight([]), null)
  assert.equal(resolvedTopHeight([fmt({ height: null }), fmt({ height: null })]), null)
  assert.equal(resolvedTopHeight([fmt({ height: null })], 720), null)
})

test('resolvedTopHeight cap 排除所有(视频最低 > cap)→ null(调用点回落「最高」,诚实)', () => {
  assert.equal(resolvedTopHeight([fmt({ height: 1080 })], 480), null)
})
