import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeVideoResolver } from './fakeVideoResolver'

test('FakeVideoResolver:普通 url → 单视频(含 mock formats)', async () => {
  const resolver = new FakeVideoResolver()
  const result = await resolver.resolve('http://x/video1')

  assert.equal(result.kind, 'video')
  if (result.kind === 'video') {
    assert.ok(result.title.length > 0)
    assert.equal(result.webpageUrl, 'http://x/video1')
    assert.ok(result.formats.length > 0)
    // 覆盖 video-only(acodec none → 需合音轨)与 muxed(含音频)两类,供格式对话框
    assert.ok(result.formats.some((f) => f.acodec === 'none'))
    assert.ok(result.formats.some((f) => f.acodec !== 'none' && f.acodec !== null))
  }
})

test('FakeVideoResolver:单视频回填 mock 字幕轨(zh-Hans 人工/en 人工/zh-Hans 自动并存,供 Step 5 字幕区手测)', async () => {
  const resolver = new FakeVideoResolver()
  const result = await resolver.resolve('http://x/video1')

  assert.equal(result.kind, 'video')
  if (result.kind === 'video') {
    assert.ok(result.subtitles.length >= 3, 'mock 回填多条字幕轨')
    assert.ok(
      result.subtitles.some((s) => s.lang === 'zh-Hans' && !s.auto),
      '含 zh-Hans 人工字幕'
    )
    assert.ok(
      result.subtitles.some((s) => s.lang === 'en' && !s.auto),
      '含 en 人工字幕'
    )
    assert.ok(
      result.subtitles.some((s) => s.lang === 'zh-Hans' && s.auto),
      '含 zh-Hans 自动生成字幕(同 lang 人工/自动并存)'
    )
  }
})

test('FakeVideoResolver:构造接 getProxy / getCookie 同签名(dev 忽略值,仅类型对称)', async () => {
  const resolver = new FakeVideoResolver({
    getProxy: () => ({ mode: 'direct', effectiveUrl: null, systemDetected: null }),
    getCookie: () => ({ source: 'browser', browser: 'chrome', profile: null, file: null })
  })
  const result = await resolver.resolve('http://x/video1')
  assert.equal(result.kind, 'video', 'dev 忽略 cookie 值,正常出 mock 视频')
})

test('FakeVideoResolver:url 含 playlist → 播放列表(N entries)', async () => {
  const resolver = new FakeVideoResolver()
  const result = await resolver.resolve('http://x/playlist-abc')

  assert.equal(result.kind, 'playlist')
  if (result.kind === 'playlist') {
    assert.ok(result.title.length > 0)
    assert.ok(result.entries.length >= 2)
    for (const entry of result.entries) {
      assert.ok(entry.id.length > 0)
      assert.ok(entry.title.length > 0)
      assert.ok(entry.url.length > 0)
    }
  }
})
