/**
 * 剪贴板识别 / 去重纯函数单测(v0.2 Task 4 · spec §10.1)。
 *
 * 覆盖 normalizeClipboardText / classifyClipboardText / decideClipboard 全分支:
 * video/http/ambiguous 不弹 / 非 URL / 前后空白 trim / 内部空白不抓取 / 超长 / knownFileExts 升级 /
 * 同值 / 已提示 / 已在列表。纯函数、零副作用,不碰真实 Electron clipboard(§3.3)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyClipboardText, decideClipboard, normalizeClipboardText } from './clipboardLink'

// ==================== normalizeClipboardText(整段即单个 http(s) URL token)====================

test('normalizeClipboardText: 单个 http(s) URL → 原样返回', () => {
  assert.equal(
    normalizeClipboardText('https://www.youtube.com/watch?v=abc'),
    'https://www.youtube.com/watch?v=abc'
  )
  assert.equal(normalizeClipboardText('http://example.com/a.zip'), 'http://example.com/a.zip')
})

test('normalizeClipboardText: 前后空白 / 换行 → trim 后返回', () => {
  assert.equal(normalizeClipboardText('  https://youtu.be/abc  '), 'https://youtu.be/abc')
  assert.equal(normalizeClipboardText('\nhttps://youtu.be/abc\n'), 'https://youtu.be/abc')
  assert.equal(normalizeClipboardText('\thttps://youtu.be/abc\t'), 'https://youtu.be/abc')
})

test('normalizeClipboardText: 内部空白 / 换行(多 token / 散文夹 URL)→ null(不抓取)', () => {
  assert.equal(normalizeClipboardText('https://a.com/x y'), null, '内部空格 → 非单 token')
  assert.equal(
    normalizeClipboardText('看这个视频 https://youtu.be/abc'),
    null,
    '散文夹 URL 不抓取(隐私 / 克制)'
  )
  assert.equal(
    normalizeClipboardText('https://a.com/1\nhttps://b.com/2'),
    null,
    '多行多 URL → 非单 token'
  )
})

test('normalizeClipboardText: 空 / 纯空白 → null', () => {
  assert.equal(normalizeClipboardText(''), null)
  assert.equal(normalizeClipboardText('   '), null)
  assert.equal(normalizeClipboardText('\n\t'), null)
})

test('normalizeClipboardText: 非 http(s)(file:// / 自定义协议 / 纯文本)→ null', () => {
  assert.equal(normalizeClipboardText('file:///C:/secret.txt'), null)
  assert.equal(normalizeClipboardText('magnet:?xt=urn:btih:abc'), null)
  assert.equal(normalizeClipboardText('ftp://example.com/x'), null)
  assert.equal(normalizeClipboardText('hello world'), null)
  assert.equal(normalizeClipboardText('some random note'), null)
})

test('normalizeClipboardText: 超 maxLen → null(超长护栏,默认 2048)', () => {
  const huge = 'https://example.com/' + 'a'.repeat(2100)
  assert.equal(normalizeClipboardText(huge), null, '默认 2048 上限')
  // 自定义 maxLen 生效
  assert.equal(normalizeClipboardText('https://a.com/xxxx', 10), null, '短 maxLen → 超限 null')
  assert.equal(normalizeClipboardText('https://a.com/', 2048), 'https://a.com/', '未超限保留')
})

// ==================== classifyClipboardText(归一 + 复用 classifyLink;仅 video / http 返回)====================

test('classifyClipboardText: 已知视频站 → { url, kind:video }', () => {
  assert.deepEqual(classifyClipboardText('https://www.youtube.com/watch?v=abc'), {
    url: 'https://www.youtube.com/watch?v=abc',
    kind: 'video'
  })
  assert.deepEqual(classifyClipboardText('https://www.bilibili.com/video/BV1xx411c7mD'), {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    kind: 'video'
  })
})

test('classifyClipboardText: 已知直链扩展名 → { url, kind:http }', () => {
  assert.deepEqual(classifyClipboardText('https://example.com/pkg/setup.zip'), {
    url: 'https://example.com/pkg/setup.zip',
    kind: 'http'
  })
  assert.deepEqual(classifyClipboardText('https://example.com/music/track.mp3'), {
    url: 'https://example.com/music/track.mp3',
    kind: 'http'
  })
})

test('classifyClipboardText: ambiguous(新闻文章 / 未知站根)→ null(不弹)', () => {
  assert.equal(classifyClipboardText('https://example.com/some/page'), null)
  assert.equal(classifyClipboardText('https://news.example.com/article/123'), null)
  assert.equal(classifyClipboardText('https://example.com'), null, '未知站根 URL → 不弹')
})

test('classifyClipboardText: 非 URL 纯文本 → null', () => {
  assert.equal(classifyClipboardText('not a url'), null)
  assert.equal(classifyClipboardText(''), null)
  assert.equal(classifyClipboardText('随手复制的一段话'), null)
})

test('classifyClipboardText: 前后空白 → trim 后命中,url 为归一值', () => {
  assert.deepEqual(classifyClipboardText('  https://youtu.be/abc  '), {
    url: 'https://youtu.be/abc',
    kind: 'video'
  })
})

test('classifyClipboardText: 内部空白 / 散文夹 URL → null(不抓取)', () => {
  assert.equal(classifyClipboardText('看这个 https://youtu.be/abc'), null)
  assert.equal(classifyClipboardText('https://a.com/x y'), null)
})

test('classifyClipboardText: 超 maxLen → null', () => {
  const huge = 'https://www.youtube.com/watch?v=' + 'a'.repeat(2100)
  assert.equal(classifyClipboardText(huge), null)
})

test('classifyClipboardText: knownFileExts 传入 → .docx 直链升为 http(不传退化 ambiguous 不弹)', () => {
  const known: ReadonlySet<string> = new Set(['docx'])
  assert.deepEqual(classifyClipboardText('https://example.com/a/file.docx', known), {
    url: 'https://example.com/a/file.docx',
    kind: 'http'
  })
  // 不传 knownFileExts → docx 不在内置 DIRECT_FILE_EXTS → ambiguous → null(不弹)
  assert.equal(
    classifyClipboardText('https://example.com/a/file.docx'),
    null,
    '不传时退化仅内置扩展名'
  )
})

test('classifyClipboardText: 视频站优先于 knownFileExts 命中', () => {
  const known: ReadonlySet<string> = new Set(['mp4'])
  assert.deepEqual(classifyClipboardText('https://www.youtube.com/download/clip.mp4', known), {
    url: 'https://www.youtube.com/download/clip.mp4',
    kind: 'video'
  })
})

// ==================== decideClipboard(变化门 + 可下载过滤 + 去重)====================

const V = 'https://www.youtube.com/watch?v=abc'
const EMPTY: ReadonlySet<string> = new Set()

test('decideClipboard: 同值(text === lastText)→ changed:false,link:null(零识别开销)', () => {
  const d = decideClipboard({ text: V, lastText: V, promptedUrls: EMPTY })
  assert.deepEqual(d, { changed: false, link: null })
})

test('decideClipboard: 新的可下载视频链接 → changed:true,link 非空', () => {
  const d = decideClipboard({ text: V, lastText: '', promptedUrls: EMPTY })
  assert.deepEqual(d, { changed: true, link: { url: V, kind: 'video' } })
})

test('decideClipboard: 新的可下载直链 → changed:true,link kind http', () => {
  const url = 'https://example.com/pkg/setup.zip'
  const d = decideClipboard({ text: url, lastText: '', promptedUrls: EMPTY })
  assert.deepEqual(d, { changed: true, link: { url, kind: 'http' } })
})

test('decideClipboard: 变化但 ambiguous / 非 URL → changed:true,link:null(不弹)', () => {
  const amb = decideClipboard({
    text: 'https://example.com/some/page',
    lastText: '',
    promptedUrls: EMPTY
  })
  assert.deepEqual(amb, { changed: true, link: null })
  const plain = decideClipboard({ text: '随手复制的话', lastText: '', promptedUrls: EMPTY })
  assert.deepEqual(plain, { changed: true, link: null })
})

test('decideClipboard: 已提示过的 URL(promptedUrls 命中)→ changed:true,link:null', () => {
  const d = decideClipboard({ text: V, lastText: '', promptedUrls: new Set([V]) })
  assert.deepEqual(d, { changed: true, link: null }, '同会话已弹过不重复弹')
})

test('decideClipboard: 已在任务列表(trackedUrls 命中)→ changed:true,link:null', () => {
  const d = decideClipboard({
    text: V,
    lastText: '',
    promptedUrls: EMPTY,
    trackedUrls: new Set([V])
  })
  assert.deepEqual(d, { changed: true, link: null }, '已在下载列表不打扰')
})

test('decideClipboard: knownFileExts 使 .docx 直链成为可提示链接', () => {
  const url = 'https://example.com/report.docx'
  const d = decideClipboard({
    text: url,
    lastText: '',
    promptedUrls: EMPTY,
    knownFileExts: new Set(['docx'])
  })
  assert.deepEqual(d, { changed: true, link: { url, kind: 'http' } })
})

test('decideClipboard: 前后空白链接 → link.url 为归一值(与 promptedUrls 去重口径一致)', () => {
  const d = decideClipboard({ text: `  ${V}  `, lastText: '', promptedUrls: EMPTY })
  assert.deepEqual(d, { changed: true, link: { url: V, kind: 'video' } })
  // 去重口径:已提示集合存归一 URL → 带空白的同链接不再弹
  const d2 = decideClipboard({ text: `  ${V}  `, lastText: '', promptedUrls: new Set([V]) })
  assert.deepEqual(d2, { changed: true, link: null })
})

test('decideClipboard: 超 maxLen 的新文本 → changed:true,link:null(超长护栏)', () => {
  const huge = 'https://www.youtube.com/watch?v=' + 'a'.repeat(2100)
  const d = decideClipboard({ text: huge, lastText: '', promptedUrls: EMPTY })
  assert.deepEqual(d, { changed: true, link: null })
})
