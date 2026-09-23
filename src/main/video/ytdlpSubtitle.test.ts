import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSubtitleTracks, toYtdlpSubtitleArgs, normalizeSubtitle } from './ytdlpSubtitle'
import type { SubtitleChoice } from '../../shared/ipc'

/** 取某 flag 紧随其后的值(成对参数) */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// ==================== parseSubtitleTracks(防御式合并,spec §3.1)====================

test('parseSubtitleTracks 合并 subtitles(人工)+ automatic_captions(自动)并标注 auto', () => {
  const tracks = parseSubtitleTracks({
    subtitles: {
      en: [{ ext: 'vtt', url: 'u1', name: 'English' }],
      'zh-Hans': [{ ext: 'srt', url: 'u2', name: 'Chinese' }]
    },
    automatic_captions: {
      'ai-zh': [{ ext: 'vtt', url: 'u3', name: '中文(自动生成)' }]
    }
  })

  // 先收人工(auto=false),再收自动(auto=true)
  assert.deepEqual(tracks, [
    { lang: 'en', name: 'English', auto: false },
    { lang: 'zh-Hans', name: 'Chinese', auto: false },
    { lang: 'ai-zh', name: '中文(自动生成)', auto: true }
  ])
})

test('parseSubtitleTracks 同 lang 人工 + 自动并存(两条都保留,UI 标注区分)', () => {
  const tracks = parseSubtitleTracks({
    subtitles: { en: [{ ext: 'srt', name: 'English' }] },
    automatic_captions: { en: [{ ext: 'vtt', name: 'English (auto)' }] }
  })
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks[0], { lang: 'en', name: 'English', auto: false })
  assert.deepEqual(tracks[1], { lang: 'en', name: 'English (auto)', auto: true })
})

test('parseSubtitleTracks 缺 name → null;仅 subtitles / 仅 automatic_captions 也可', () => {
  const onlyAuto = parseSubtitleTracks({ automatic_captions: { es: [{ ext: 'vtt' }] } })
  assert.deepEqual(onlyAuto, [{ lang: 'es', name: null, auto: true }])

  const onlyHuman = parseSubtitleTracks({ subtitles: { fr: [{ ext: 'srt' }] } })
  assert.deepEqual(onlyHuman, [{ lang: 'fr', name: null, auto: false }])
})

test('parseSubtitleTracks 无字幕字段 / 空对象 → [](空数组兜底)', () => {
  assert.deepEqual(parseSubtitleTracks({}), [])
  assert.deepEqual(parseSubtitleTracks({ subtitles: {}, automatic_captions: {} }), [])
})

test('parseSubtitleTracks 防御:非对象 / null / 字段类型异常不抛,返回 []', () => {
  assert.deepEqual(parseSubtitleTracks(null), [])
  assert.deepEqual(parseSubtitleTracks(42), [])
  assert.deepEqual(parseSubtitleTracks('str'), [])
  // 字段值非「lang → 数组」结构:逐 lang 跳过非数组,不抛
  assert.deepEqual(parseSubtitleTracks({ subtitles: 'nope' }), [])
  assert.deepEqual(parseSubtitleTracks({ subtitles: { en: 'not-array' } }), [])
})

// ==================== toYtdlpSubtitleArgs(参数映射,spec §3.2)====================

test('toYtdlpSubtitleArgs undefined / 空 langs → [](零附加,零回归)', () => {
  assert.deepEqual(toYtdlpSubtitleArgs(undefined), [])
  assert.deepEqual(toYtdlpSubtitleArgs({ langs: [], format: 'srt', includeAuto: false }), [])
})

test('toYtdlpSubtitleArgs 有 langs → --write-subs / --sub-langs / --sub-format / --convert-subs', () => {
  const args = toYtdlpSubtitleArgs({ langs: ['zh-Hans', 'en'], format: 'srt', includeAuto: false })
  assert.deepEqual(args, [
    '--write-subs',
    '--sub-langs',
    'zh-Hans,en',
    '--sub-format',
    'srt/best',
    '--convert-subs',
    'srt'
  ])
  // 不含自动生成开关(includeAuto=false)
  assert.ok(!args.includes('--write-auto-subs'))
})

test('toYtdlpSubtitleArgs includeAuto → 追加 --write-auto-subs', () => {
  const args = toYtdlpSubtitleArgs({ langs: ['en'], format: 'vtt', includeAuto: true })
  assert.ok(args.includes('--write-subs'))
  assert.ok(args.includes('--write-auto-subs'))
  assert.equal(valueAfter(args, '--sub-langs'), 'en')
  assert.equal(valueAfter(args, '--sub-format'), 'vtt/best')
  assert.equal(valueAfter(args, '--convert-subs'), 'vtt')
})

// ==================== normalizeSubtitle(去空 / 去重 / trim,spec §4.4)====================

test('normalizeSubtitle langs 去空 / 去重 / trim(保序)', () => {
  const sel: SubtitleChoice = {
    langs: [' zh-Hans ', 'en', '', '  ', 'en', 'zh-Hans'],
    format: 'srt',
    includeAuto: true
  }
  const n = normalizeSubtitle(sel)
  assert.deepEqual(n.langs, ['zh-Hans', 'en'], 'trim + 去空 + 去重保序')
  assert.equal(n.format, 'srt', 'format 保持')
  assert.equal(n.includeAuto, true, 'includeAuto 保持')
})

test('normalizeSubtitle 空 langs → 空 langs(默认偏好稳定)', () => {
  assert.deepEqual(normalizeSubtitle({ langs: [], format: 'srt', includeAuto: false }).langs, [])
})
