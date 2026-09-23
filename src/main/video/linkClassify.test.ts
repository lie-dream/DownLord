import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyLink } from './linkClassify'

test('classifyLink: known video sites → video + friendly siteLabel', () => {
  assert.deepEqual(classifyLink('https://www.youtube.com/watch?v=abc'), {
    kind: 'video',
    siteLabel: 'YouTube'
  })
  assert.deepEqual(classifyLink('https://youtu.be/abc'), { kind: 'video', siteLabel: 'YouTube' })
  assert.deepEqual(classifyLink('https://www.bilibili.com/video/BV1xx411c7mD'), {
    kind: 'video',
    siteLabel: '哔哩哔哩'
  })
  assert.deepEqual(classifyLink('https://v.douyin.com/abc/'), { kind: 'video', siteLabel: '抖音' })
  assert.deepEqual(classifyLink('https://vimeo.com/123456'), { kind: 'video', siteLabel: 'Vimeo' })
  assert.deepEqual(classifyLink('https://x.com/user/status/1'), { kind: 'video', siteLabel: 'X' })
  assert.deepEqual(classifyLink('https://twitter.com/user/status/1'), {
    kind: 'video',
    siteLabel: 'X'
  })
})

test('classifyLink: direct-file extensions (non video site) → http', () => {
  assert.deepEqual(classifyLink('https://example.com/pkg/setup.zip'), { kind: 'http' })
  assert.deepEqual(classifyLink('https://dl.example.com/app/installer.exe'), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/tool.msi'), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/music/track.mp3'), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/disk.iso'), { kind: 'http' })
})

test('classifyLink: unknown sites / no direct ext → ambiguous (UI defaults to video)', () => {
  assert.deepEqual(classifyLink('https://example.com/some/page'), { kind: 'ambiguous' })
  assert.deepEqual(classifyLink('https://news.example.com/article/123'), { kind: 'ambiguous' })
})

test('classifyLink: invalid URL → ambiguous (no throw)', () => {
  assert.deepEqual(classifyLink('not a url'), { kind: 'ambiguous' })
  assert.deepEqual(classifyLink(''), { kind: 'ambiguous' })
})

test('classifyLink: known video site wins over a direct-file extension in the path', () => {
  // 已知视频站点优先于扩展名启发式
  assert.deepEqual(classifyLink('https://www.youtube.com/download/clip.zip'), {
    kind: 'video',
    siteLabel: 'YouTube'
  })
})

// —— Phase 4 链接识别加固(TODO #13,spec §6.2 / §6.4):并入运行时类别扩展名集合 ——

// 模拟运行时「类别 extensions 并集」子集:document.docx / archive.gz / video.mkv / audio.flac / program.deb / video.mp4
const KNOWN_EXTS: ReadonlySet<string> = new Set(['docx', 'gz', 'mkv', 'flac', 'deb', 'mp4'])

test('classifyLink: 带类别扩展名的直链(传 knownFileExts)→ http', () => {
  assert.deepEqual(classifyLink('https://example.com/a/file.docx', KNOWN_EXTS), { kind: 'http' })
  // .tar.gz 末段扩展名取 gz,archive 类含 gz
  assert.deepEqual(classifyLink('https://example.com/pkg.tar.gz', KNOWN_EXTS), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/movie.mkv', KNOWN_EXTS), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/song.flac', KNOWN_EXTS), { kind: 'http' })
  assert.deepEqual(classifyLink('https://example.com/app.deb', KNOWN_EXTS), { kind: 'http' })
})

test('classifyLink: 未知扩展名(.xyz,不在 DIRECT_FILE_EXTS ∪ knownFileExts)→ ambiguous', () => {
  assert.deepEqual(classifyLink('https://example.com/data.xyz', KNOWN_EXTS), { kind: 'ambiguous' })
})

test('classifyLink: 视频站点优先于 knownFileExts 扩展名命中(youtube/clip.mp4 仍 video)', () => {
  assert.deepEqual(classifyLink('https://www.youtube.com/download/clip.mp4', KNOWN_EXTS), {
    kind: 'video',
    siteLabel: 'YouTube'
  })
})

test('classifyLink: 传 knownFileExts 不影响内置 DIRECT_FILE_EXTS 命中(.zip 仍 http)', () => {
  assert.deepEqual(classifyLink('https://example.com/setup.zip', KNOWN_EXTS), { kind: 'http' })
})

// —— v0.3 Task 1:BT 识别(magnet / .torrent,spec §10.1)——

test('classifyLink: magnet 链接 → torrent(最前置,不入 new URL)', () => {
  assert.deepEqual(classifyLink('magnet:?xt=urn:btih:abcdef123&dn=Movie'), { kind: 'torrent' })
  // 无 dn、仅 xt 也判 torrent
  assert.deepEqual(classifyLink('magnet:?xt=urn:btih:abcdef123'), { kind: 'torrent' })
})

test('classifyLink: .torrent 扩展名(非视频站)→ torrent(早于 DIRECT_FILE_EXTS)', () => {
  assert.deepEqual(classifyLink('https://example.com/files/ubuntu.torrent'), { kind: 'torrent' })
  assert.deepEqual(classifyLink('https://dl.example.com/a/b/c.torrent'), { kind: 'torrent' })
})

test('classifyLink: 视频站点优先于 .torrent 扩展名(youtube/x.torrent 仍 video)', () => {
  assert.deepEqual(classifyLink('https://www.youtube.com/download/x.torrent'), {
    kind: 'video',
    siteLabel: 'YouTube'
  })
})

test('classifyLink: 混淆项不误判为 torrent', () => {
  // host 以 "magnet" 开头但 scheme 是 https(非 magnet:)→ 按普通 URL,无 torrent 扩展 → ambiguous
  assert.deepEqual(classifyLink('https://magnetic.com/page'), { kind: 'ambiguous' })
  assert.deepEqual(classifyLink('https://magnet.example.com/watch'), { kind: 'ambiguous' })
  // host / 路径含 "torrent" 词但非 .torrent 扩展名 → 不误判
  assert.deepEqual(classifyLink('https://torrentsite.example.com/browse'), { kind: 'ambiguous' })
  assert.deepEqual(classifyLink('https://example.com/torrent/list'), { kind: 'ambiguous' })
})

test('classifyLink: .torrent 命中不受 knownFileExts 影响(仍 torrent 而非 http)', () => {
  assert.deepEqual(classifyLink('https://example.com/x.torrent', new Set(['zip', 'mp4'])), {
    kind: 'torrent'
  })
})

// —— v1.0 Task 3 Step 5 · #66:清单链接共享嗅探真源 ——

test('#66 m3u8 / mpd 判 video:pathname 后缀忽略大小写且不含 query/hash', () => {
  for (const url of [
    'https://cdn.example.com/live/master.m3u8',
    'https://cdn.example.com/live/manifest.mpd',
    'https://cdn.example.com/live/MASTER.M3U8?token=abc#track',
    'https://cdn.example.com/live/Manifest.MPD?file=a.zip#part'
  ]) {
    assert.deepEqual(classifyLink(url), { kind: 'video' }, url)
  }
})

test('#66 流媒体清单优先于用户 knownFileExts 的直链分类', () => {
  const known = new Set(['m3u8', 'mpd', 'torrent', 'zip'])
  assert.deepEqual(classifyLink('https://cdn.example.com/master.m3u8', known), { kind: 'video' })
  assert.deepEqual(classifyLink('https://cdn.example.com/manifest.mpd', known), { kind: 'video' })
})

test('#66 不改变 magnet / 视频站 / torrent 的既有优先级', () => {
  const known = new Set(['m3u8', 'mpd', 'torrent'])
  assert.deepEqual(classifyLink('magnet:?xt=urn:btih:abc&dn=master.m3u8', known), {
    kind: 'torrent'
  })
  assert.deepEqual(classifyLink('https://www.youtube.com/x.mpd', known), {
    kind: 'video',
    siteLabel: 'YouTube'
  })
  assert.deepEqual(classifyLink('https://cdn.example.com/x.torrent?file=x.m3u8', known), {
    kind: 'torrent'
  })
})

test('#66 非清单对照:query/hash 不冒充后缀,普通媒体的既有分类不变', () => {
  for (const url of [
    'https://cdn.example.com/play?file=master.m3u8#manifest.mpd',
    'https://cdn.example.com/.m3u8',
    'https://cdn.example.com/master.m3u8.part',
    'https://cdn.example.com/clip.mp4'
  ]) {
    assert.deepEqual(classifyLink(url), { kind: 'ambiguous' }, url)
  }
  assert.deepEqual(classifyLink('https://cdn.example.com/clip.mp4', new Set(['mp4'])), {
    kind: 'http'
  })
  assert.deepEqual(classifyLink('https://cdn.example.com/song.mp3?file=a.mpd'), { kind: 'http' })
})
