import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mapResolveError, mapDownloadError } from './resolveError'

test('mapResolveError maps Unsupported URL → 暂不支持 / 直链 (spec §2.4)', () => {
  const msg = mapResolveError('ERROR: Unsupported URL: https://example.com/foo', 1)
  assert.match(msg, /暂不支持/)
  assert.match(msg, /直链/)
})

test('mapResolveError maps login / private / members-only → 需登录 / 会员 (spec §2.4)', () => {
  assert.match(mapResolveError('ERROR: Sign in to confirm your age', 1), /登录|会员/)
  assert.match(mapResolveError('ERROR: Private video. Sign in if you have access', 1), /登录|会员/)
  assert.match(
    mapResolveError('ERROR: Join this channel to get access to members-only content', 1),
    /登录|会员/
  )
})

test('mapResolveError maps HTTP 4xx / unable to download → 网络 / 代理 (spec §2.4)', () => {
  assert.match(
    mapResolveError('ERROR: Unable to download webpage: HTTP Error 403: Forbidden', 1),
    /网络|代理/
  )
  assert.match(mapResolveError('ERROR: Unable to download webpage', 1), /网络|代理/)
})

test('mapResolveError maps timeout (killed, exitCode null) → 解析超时 (spec §2.4)', () => {
  assert.match(mapResolveError('', null), /超时/)
})

test('mapResolveError maps clean exit (exitCode 0, JSON / formats failure) → 站点改版 (spec §2.4)', () => {
  assert.match(mapResolveError('', 0), /改版|更新/)
})

test('mapResolveError falls back to 站点改版 for unknown non-zero failures', () => {
  assert.match(mapResolveError('ERROR: something totally unexpected', 1), /改版|更新|失败/)
})

// ==================== mapDownloadError(下载失败 → 可读中文,spec §3.4 / §5.1)====================

test('mapDownloadError maps missing ffmpeg / merge failure → 合并失败 + ffmpeg (spec §5.1)', () => {
  assert.match(
    mapDownloadError('ERROR: ffmpeg not found. Please install or provide the path', 1),
    /合并|ffmpeg/i
  )
  assert.match(
    mapDownloadError('ERROR: Postprocessing: ffprobe and ffmpeg not found', 1),
    /合并|ffmpeg/i
  )
})

test('mapDownloadError reuses login / network keywords (spec §3.4)', () => {
  assert.match(mapDownloadError('ERROR: Sign in to confirm your age', 1), /登录|会员/)
  assert.match(
    mapDownloadError('ERROR: Unable to download: HTTP Error 403: Forbidden', 1),
    /网络|代理/
  )
})

test('mapDownloadError falls back to readable 下载失败 for unknown non-zero failures', () => {
  const msg = mapDownloadError('ERROR: some unexpected yt-dlp failure', 1)
  assert.match(msg, /下载失败|重试/)
  assert.ok(msg.length > 0)
})
