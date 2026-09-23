import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareYtDlpVersion,
  needsYtDlpUpdate,
  parseLatestRelease,
  selectAsset,
  selectSumsAsset,
  parseSha256Sums,
  computeSha256,
  YTDLP_ASSET_NAME,
  SHA256SUMS_ASSET_NAME
} from './ytdlpUpdate'

// ==================== 版本比对(spec §2.1)====================

test('compareYtDlpVersion 逐段数值比较(缺段补 0)', () => {
  assert.equal(compareYtDlpVersion('2026.06.09', '2026.06.10'), -1, '日递增')
  assert.equal(compareYtDlpVersion('2026.06.10', '2026.06.09'), 1)
  assert.equal(compareYtDlpVersion('2026.06.09', '2026.06.09'), 0, '相等')
  assert.equal(compareYtDlpVersion('2026.06.09', '2026.06.09.1'), -1, 'nightly 第四段更新')
  assert.equal(compareYtDlpVersion('2026.06.09.0', '2026.06.09'), 0, '缺段补 0 相等')
  assert.equal(compareYtDlpVersion('2026.6.9', '2026.06.09'), 0, '数值比较不看前导零')
})

test('compareYtDlpVersion 非法格式 → null(不可比,诚实)', () => {
  assert.equal(compareYtDlpVersion('nightly', '2026.06.09'), null)
  assert.equal(compareYtDlpVersion('2026.06.09', ''), null)
  assert.equal(compareYtDlpVersion('2026.06.x', '2026.06.09'), null)
})

test('needsYtDlpUpdate 仅 current<latest 且均可解析 → true', () => {
  assert.equal(needsYtDlpUpdate('2026.06.09', '2026.06.10'), true)
  assert.equal(needsYtDlpUpdate('2026.06.10', '2026.06.09'), false, '更旧不升级')
  assert.equal(needsYtDlpUpdate('2026.06.09', '2026.06.09'), false, '相等不升级')
  assert.equal(needsYtDlpUpdate('bogus', '2026.06.09'), false, '不可比 → false(不误判)')
})

// ==================== releases 解析(spec §2.1)====================

const RELEASE_JSON = {
  tag_name: '2026.06.10',
  assets: [
    { name: 'yt-dlp.exe', browser_download_url: 'https://x/yt-dlp.exe', size: 30_000_000 },
    { name: 'SHA2-256SUMS', browser_download_url: 'https://x/SHA2-256SUMS', size: 4096 },
    { name: 'yt-dlp', browser_download_url: 'https://x/yt-dlp', size: 3_000_000 }
  ]
}

test('parseLatestRelease 正常 → tag + 资产', () => {
  const r = parseLatestRelease(RELEASE_JSON)
  assert.ok(r)
  assert.equal(r.tag, '2026.06.10')
  assert.equal(r.assets.length, 3)
  assert.equal(r.assets[0].url, 'https://x/yt-dlp.exe')
  assert.equal(r.assets[0].size, 30_000_000)
})

test('parseLatestRelease 缺 tag / 缺 assets / 非对象 → null', () => {
  assert.equal(parseLatestRelease({ assets: [] }), null, '缺 tag')
  assert.equal(parseLatestRelease({ tag_name: 'v1' }), null, '缺 assets')
  assert.equal(parseLatestRelease({ tag_name: 'v1', assets: {} }), null, 'assets 非数组')
  assert.equal(parseLatestRelease(null), null)
  assert.equal(parseLatestRelease('not json'), null)
})

test('parseLatestRelease 跳过字段异型的单个资产(容错不整体失败)', () => {
  const r = parseLatestRelease({
    tag_name: 'v1',
    assets: [
      { name: 'ok.exe', browser_download_url: 'https://x/ok', size: 1 },
      { name: 123, browser_download_url: 'https://x/bad' }, // name 异型 → 跳过
      { browser_download_url: 'https://x/nourl' } // 缺 name → 跳过
    ]
  })
  assert.ok(r)
  assert.equal(r.assets.length, 1)
  assert.equal(r.assets[0].name, 'ok.exe')
})

test('selectAsset / selectSumsAsset 命中 / 缺失', () => {
  const r = parseLatestRelease(RELEASE_JSON)!
  assert.equal(selectAsset(r.assets, YTDLP_ASSET_NAME)?.url, 'https://x/yt-dlp.exe')
  assert.equal(selectSumsAsset(r.assets)?.url, 'https://x/SHA2-256SUMS')
  assert.equal(selectAsset(r.assets, 'nonexistent.exe'), null)
  assert.equal(SHA256SUMS_ASSET_NAME, 'SHA2-256SUMS')
  assert.equal(selectSumsAsset([]), null)
})

// ==================== SHA256(spec §2.3)====================

test('parseSha256Sums 多行取 yt-dlp.exe 行 hash(双空格 / 大小写归一)', () => {
  const text = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  yt-dlp.exe',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  yt-dlp_macos'
  ].join('\n')
  assert.equal(
    parseSha256Sums(text, 'yt-dlp.exe'),
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '取精确匹配行 + 小写归一'
  )
})

test('parseSha256Sums 缺目标行 / 空文本 → null', () => {
  assert.equal(parseSha256Sums('deadbeef  other.exe', 'yt-dlp.exe'), null, '格式非法(非 64 位)')
  assert.equal(parseSha256Sums('', 'yt-dlp.exe'), null)
  const only = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  yt-dlp'
  assert.equal(parseSha256Sums(only, 'yt-dlp.exe'), null, '无 yt-dlp.exe 行')
})

test('computeSha256 已知 buffer → 已知 hash', () => {
  // sha256('abc') 标准向量
  assert.equal(
    computeSha256(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
})
