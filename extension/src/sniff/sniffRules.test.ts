/**
 * 嗅探判定单测(v0.4 Task 5 Phase 1 · spec §7.1 的 U-01~U-07)。
 *
 * 纯函数、零 mock:输入是普通对象,输出是普通对象。
 * 两条反向探针盯着本文件 —— **RP-4**(删第 1 步分片判定 → U-02 红)、
 * **RP-5**(门槛上移到第 2 步之前 → U-06 红)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifySniffedResource,
  extractPathExt,
  MIN_FILE_BYTES,
  normalizeContentType,
  parseContentLength,
  readHeader,
  type SniffOutcome
} from './sniffRules'

/** 默认 1MB 以上,免得每条用例都为「够不够大」分心 */
function classify(
  url: string,
  contentType = '',
  contentLength: number | null = 8 * 1024 * 1024
): SniffOutcome {
  return classifySniffedResource({ url, contentType, contentLength })
}

// ── U-01:contentType 归一 ─────────────────────────────────────────────────

test('U-01: normalizeContentType 去 charset、去空白、转小写', () => {
  assert.equal(
    normalizeContentType('Application/X-MpegURL; charset=utf-8'),
    'application/x-mpegurl'
  )
  assert.equal(normalizeContentType('  VIDEO/MP2T  '), 'video/mp2t')
  assert.equal(normalizeContentType('application/dash+xml;charset=UTF-8'), 'application/dash+xml')
})

test('U-01: 缺失的 contentType 归一成空串(不引入第二个「没有」的取值)', () => {
  assert.equal(normalizeContentType(undefined), '')
  assert.equal(normalizeContentType(null), '')
  assert.equal(normalizeContentType(''), '')
})

test('U-01: 响应头取值大小写不敏感,同名取第一条', () => {
  const headers = [
    { name: 'CONTENT-TYPE', value: 'video/mp4' },
    { name: 'content-type', value: 'text/html' },
    { name: 'Content-Length', value: '1024' }
  ]

  assert.equal(readHeader(headers, 'Content-Type'), 'video/mp4')
  assert.equal(readHeader(headers, 'content-length'), '1024')
  assert.equal(readHeader(headers, 'X-Absent'), undefined)
})

test('U-01: Content-Length 非数字 / 负数 / 缺失一律 null(= 未知)', () => {
  assert.equal(parseContentLength('84000000'), 84_000_000)
  assert.equal(parseContentLength('0'), 0)
  assert.equal(parseContentLength(undefined), null)
  assert.equal(parseContentLength(''), null)
  assert.equal(parseContentLength('abc'), null)
  assert.equal(parseContentLength('-1'), null)
})

// ── U-02:分片黑名单(RP-4 盯这一条)────────────────────────────────────────

test('U-02: 分片三例 —— video/mp2t / .ts / .m4s 全部判 segment(只计数,不进列表)', () => {
  assert.deepEqual(classify('https://x.example/chunk', 'video/mp2t', 500_000), {
    kind: 'segment'
  })
  assert.deepEqual(classify('https://x.example/seg-1.ts', '', 500_000), { kind: 'segment' })
  assert.deepEqual(classify('https://x.example/init.m4s', 'application/octet-stream', 500_000), {
    kind: 'segment'
  })
})

// ── U-03 / U-04:OR 判据的两个方向 ─────────────────────────────────────────

test('U-03: 无扩展名的清单靠 contentType 命中(嗅探唯一不可替代的价值)', () => {
  assert.deepEqual(classify('https://cdn.x/play?id=123', 'application/vnd.apple.mpegurl', null), {
    kind: 'stream',
    ext: null,
    sizeBytes: null
  })
  assert.equal(classify('https://cdn.x/play?id=1', 'application/x-mpegurl', null).kind, 'stream')
  assert.equal(classify('https://cdn.x/manifest', 'application/dash+xml', null).kind, 'stream')
})

test('U-04: 有扩展名但 contentType 判不出 → 靠扩展名命中(OR 判据的正向证明)', () => {
  // application/octet-stream 既不是 video/ 也不是 audio/ —— AND 判据会把这条整个漏掉
  assert.deepEqual(classify('https://x.example/a.webm', 'application/octet-stream'), {
    kind: 'file',
    ext: 'webm',
    sizeBytes: 8 * 1024 * 1024
  })
  assert.equal(classify('https://x.example/b.m3u8', 'application/octet-stream').kind, 'stream')
  assert.equal(classify('https://x.example/c.mp4', 'text/plain').kind, 'file')
})

test('U-04 对照:contentType 命中而扩展名判不出 —— 另一半也要成立', () => {
  assert.equal(classify('https://x.example/stream?id=9', 'video/mp4').kind, 'file')
  assert.equal(classify('https://x.example/audio?id=9', 'audio/mpeg').kind, 'file')
})

// ── U-05:门槛边界 ─────────────────────────────────────────────────────────

test('U-05: 1MB 门槛四例(999999 / 1048576 / 1048577 / null)', () => {
  assert.equal(MIN_FILE_BYTES, 1_048_576)

  assert.deepEqual(classify('https://x.example/a.mp4', 'video/mp4', 999_999), {
    kind: 'too-small'
  })
  assert.equal(classify('https://x.example/a.mp4', 'video/mp4', 1_048_576).kind, 'file')
  assert.equal(classify('https://x.example/a.mp4', 'video/mp4', 1_048_577).kind, 'file')
  // chunked 无 Content-Length → 放行(与 OR 的取向一致:宁可多列一条可以不点的)
  assert.deepEqual(classify('https://x.example/a.mp4', 'video/mp4', null), {
    kind: 'file',
    ext: 'mp4',
    sizeBytes: null
  })
})

// ── U-06:门槛不作用于 stream(RP-5 盯这一条)──────────────────────────────

test('U-06: 门槛不作用于 stream —— index.m3u8 + 812 字节仍是 stream,不是 too-small', () => {
  assert.deepEqual(classify('https://x.example/index.m3u8', 'application/x-mpegurl', 812), {
    kind: 'stream',
    ext: 'm3u8',
    sizeBytes: 812
  })
  // m3u8 / mpd 清单本身只有几 KB —— 门槛上移会把**最该抓的那一条**滤掉
  assert.equal(classify('https://x.example/manifest.mpd', '', 1_200).kind, 'stream')
  assert.equal(classify('https://cdn.x/play?id=1', 'application/dash+xml', 400).kind, 'stream')
})

// ── U-07:扩展名提取 ───────────────────────────────────────────────────────

test('U-07: 带 query 的扩展名提取先取 pathname', () => {
  assert.equal(extractPathExt('https://x.example/index.m3u8?token=abc'), 'm3u8')
  assert.equal(extractPathExt('https://x.example/a/b/TRAILER.MP4?x=1#frag'), 'mp4')
  assert.equal(extractPathExt('https://x.example/play?id=123'), null)
  assert.equal(extractPathExt('https://x.example/'), null)
  assert.equal(extractPathExt('https://x.example/.hidden'), null)
})

test('U-07: 非法 URL → extractPathExt 为 null,分类为 ignore', () => {
  assert.equal(extractPathExt('not a url'), null)
  assert.deepEqual(classify('not a url', 'application/x-mpegurl', null), { kind: 'ignore' })
  assert.deepEqual(classify('', 'video/mp4', null), { kind: 'ignore' })
})

test('U-07: 带 query 的清单靠 pathname 的扩展名命中(query 不参与判定)', () => {
  assert.equal(classify('https://x.example/index.m3u8?token=abc').kind, 'stream')
})

// ── 兜底:非媒体一律 ignore ────────────────────────────────────────────────
// ⚠️ 三条的字节数**刻意都 ≥ 1MB**:RP-5(门槛上移)期望的失败集合是**恰好** { U-06 },
//    这里若用小体积,门槛上移后它们会一起变红,归因当场坍塌。

test('第 5 步:非媒体请求一律 ignore', () => {
  assert.deepEqual(classify('https://x.example/page.html', 'text/html', 4_000_000), {
    kind: 'ignore'
  })
  assert.deepEqual(classify('https://x.example/app.js', 'application/javascript', 9_000_000), {
    kind: 'ignore'
  })
  assert.deepEqual(classify('https://x.example/logo.png', 'image/png', 2_000_000), {
    kind: 'ignore'
  })
})
