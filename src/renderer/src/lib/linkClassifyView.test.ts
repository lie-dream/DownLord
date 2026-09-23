/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeLink } from './linkClassifyView'

test('describeLink 视频站点 → video + 来源名 + 建议 video', () => {
  const d = describeLink('https://www.youtube.com/watch?v=abc')
  assert.equal(d.kind, 'video')
  assert.equal(d.suggestedKind, 'video')
  assert.equal(d.siteLabel, 'YouTube')
  assert.match(d.title, /YouTube/)
})

test('describeLink 哔哩哔哩', () => {
  const d = describeLink('https://www.bilibili.com/video/BV1xx411c7XX')
  assert.equal(d.kind, 'video')
  assert.equal(d.siteLabel, '哔哩哔哩')
  assert.match(d.title, /哔哩哔哩/)
})

test('describeLink 直链扩展名 → http + 建议 http', () => {
  const d = describeLink('https://files.example.com/app.zip')
  assert.equal(d.kind, 'http')
  assert.equal(d.suggestedKind, 'http')
  assert.match(d.title, /直链/)
})

test('describeLink 未知链接 → ambiguous,默认建议 video', () => {
  const d = describeLink('https://example.com/some/page')
  assert.equal(d.kind, 'ambiguous')
  assert.equal(d.suggestedKind, 'video')
  assert.match(d.title, /视频解析/)
})

// —— Phase 4 链接识别加固(spec §6.3):透传 knownFileExts ——

const KNOWN_EXTS: ReadonlySet<string> = new Set(['docx', 'mkv', 'flac'])

test('describeLink 传 knownFileExts:带类别扩展名直链 → http + 建议 http', () => {
  const d = describeLink('https://example.com/a/report.docx', KNOWN_EXTS)
  assert.equal(d.kind, 'http')
  assert.equal(d.suggestedKind, 'http')
  assert.match(d.title, /直链/)
})

test('describeLink 不传 knownFileExts:同一直链未加固 → ambiguous + 建议 video(零回归)', () => {
  const d = describeLink('https://example.com/a/report.docx')
  assert.equal(d.kind, 'ambiguous')
  assert.equal(d.suggestedKind, 'video')
})

test('describeLink 传 knownFileExts 不改视频站点结果(youtube 仍 video)', () => {
  const d = describeLink('https://www.youtube.com/watch?v=abc', KNOWN_EXTS)
  assert.equal(d.kind, 'video')
  assert.equal(d.suggestedKind, 'video')
  assert.equal(d.siteLabel, 'YouTube')
})

// —— v0.3 Task 1:torrent(spec §10.3)——

test('describeLink magnet: → torrent + 磁力文案(aria2 原生 BT)', () => {
  const d = describeLink('magnet:?xt=urn:btih:abc&dn=Show')
  assert.equal(d.kind, 'torrent')
  assert.match(d.title, /磁力链接/)
  assert.match(d.sub, /aria2 原生 BT/)
})

test('describeLink 远程 .torrent URL → torrent + 诚实「作为普通文件下载」(远程种子不做 BT)', () => {
  const d = describeLink('https://example.com/dist/ubuntu.torrent')
  assert.equal(d.kind, 'torrent')
  assert.match(d.title, /种子文件链接/)
  assert.match(d.sub, /普通文件下载/)
})
