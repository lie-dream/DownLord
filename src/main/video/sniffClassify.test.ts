import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifySniffed } from './sniffClassify'
import { classifyLink } from './linkClassify'

/** `classifySniffed` 四层分流单测(v0.4 Task 5 · spec §4.3 · 用例 U-19~U-24) */

test('U-19 ①层 分片(伪造载荷的防御层):video/mp2t 与 .m4s / .ts 一律 segment', () => {
  // Content-Type 侧 —— `video/mp2t` 就是 HLS 的 .ts 分片
  assert.deepStrictEqual(classifySniffed('https://cdn.x/seg-1', 'video/mp2t'), { kind: 'segment' })
  // 扩展名侧 —— 这两个是 `SNIFF_SEGMENT_EXTS` 的全部
  assert.deepStrictEqual(classifySniffed('https://cdn.x/init.m4s', ''), { kind: 'segment' })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/seg-000123.ts', ''), { kind: 'segment' })

  // ★ 顺序守卫:`video/mp2t` 也以 `video/` 开头 —— 若①③两层顺序被换,这两条会落 http
  assert.deepStrictEqual(classifySniffed('https://cdn.x/a.mp4', 'video/mp2t'), { kind: 'segment' })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/x.m4s', 'video/mp4'), { kind: 'segment' })

  // 带 query 也要认出扩展名(去重键不剥 query,但判扩展名走 pathname)
  assert.deepStrictEqual(classifySniffed('https://cdn.x/seg-9.ts?token=abc', ''), {
    kind: 'segment'
  })
})

test('U-20 ②层 流媒体清单 → video(三种 contentType + 两种扩展名)', () => {
  for (const ct of ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/dash+xml']) {
    assert.deepStrictEqual(classifySniffed('https://cdn.x/play?id=123', ct), { kind: 'video' }, ct)
  }
  // ★ 无扩展名的清单只能靠 contentType 认出来 —— 那正是嗅探不可替代的价值
  assert.deepStrictEqual(classifySniffed('https://cdn.x/index.m3u8', ''), { kind: 'video' })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/manifest.mpd', ''), { kind: 'video' })
  // 扩展名 OR contentType(不是 AND):只要一边命中就成立
  assert.deepStrictEqual(classifySniffed('https://cdn.x/index.m3u8?t=1', 'application/octet-stream'), {
    kind: 'video'
  })
})

test('U-21 ③层 contentType 分支:video/* 与 audio/* → http', () => {
  assert.deepStrictEqual(classifySniffed('https://cdn.x/play?id=7', 'video/mp4'), { kind: 'http' })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/play?id=7', 'audio/mpeg'), { kind: 'http' })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/play?id=7', 'video/webm'), { kind: 'http' })
})

test('U-22 ★ ③层扩展名分支的守卫:cdn/x.mp4 + application/octet-stream → http', () => {
  // ⚠️ 这条是「③层扩展名分支不可省」的**唯一机器守卫**(反向探针 RP-2 删掉那半 → 本条变红)。
  //    CDN 对 mp4 发 `application/octet-stream` 是最常见情形,contentType 判不出;
  //    而 `.mp4` **不在** `linkClassify` 的 `DIRECT_FILE_EXTS` 里 → fallback 会落 ambiguous。
  assert.deepStrictEqual(classifySniffed('https://cdn.example.com/v/x.mp4', 'application/octet-stream'), {
    kind: 'http'
  })
  // 反向对照:少了③层扩展名分支时,它会落到④层的 ambiguous → unknown
  assert.equal(
    classifyLink('https://cdn.example.com/v/x.mp4').kind,
    'ambiguous',
    '★ 反向对照:.mp4 在 classifyLink 里确实是 ambiguous —— 本条守卫才有意义'
  )
  // `SNIFF_MEDIA_EXTS` 其余四个同样靠这一层
  for (const ext of ['flv', 'm4a', 'webm']) {
    assert.deepStrictEqual(
      classifySniffed(`https://cdn.example.com/v/x.${ext}`, 'application/octet-stream'),
      { kind: 'http' },
      ext
    )
  }
  // `mp3` 两条路都通(它既在 SNIFF_MEDIA_EXTS 又在 DIRECT_FILE_EXTS)—— 结论一致
  assert.deepStrictEqual(classifySniffed('https://cdn.example.com/a/x.mp3', ''), { kind: 'http' })
})

test('U-23 ④层 fallback 到 classifyLink:已知视频站 → video;普通网页 → unknown', () => {
  // 已知视频站靠 classifyLink 天然命中(**包装而非分叉**的正面证明)
  assert.deepStrictEqual(classifySniffed('https://youtube.com/watch?v=x', ''), { kind: 'video' })
  assert.deepStrictEqual(classifySniffed('https://www.bilibili.com/video/BV1x', ''), { kind: 'video' })
  // 直链扩展名同样靠它(zip 不在任何 SNIFF_* 清单里)
  assert.deepStrictEqual(classifySniffed('https://dl.example.com/a.zip', ''), { kind: 'http' })

  // 判不出 → unknown → **不受理**(判不出就不猜)
  assert.deepStrictEqual(classifySniffed('https://example.com/page', ''), { kind: 'unknown' })
  assert.deepStrictEqual(classifySniffed('https://example.com/page', 'text/html'), {
    kind: 'unknown'
  })
  // torrent 同样收敛成 unknown —— **嗅探不是 BT 入口**
  // ⚠️ host 刻意避开 `x.com` / `youtube.com` 等:`classifyLink` 的**已知视频站表优先于 `.torrent`**,
  //    用 `x.com/a.torrent` 会得到 `video`(这条在写用例时踩到过,不是实现的问题)。
  assert.deepStrictEqual(classifySniffed('https://tracker.example.org/a.torrent', ''), {
    kind: 'unknown'
  })
  assert.deepStrictEqual(classifySniffed('magnet:?xt=urn:btih:abc', ''), { kind: 'unknown' })
  // URL 非法 → 扩展名取不到 + classifyLink 回 ambiguous → unknown(不抛)
  assert.deepStrictEqual(classifySniffed('not a url', ''), { kind: 'unknown' })
  assert.deepStrictEqual(classifySniffed('', ''), { kind: 'unknown' })
})

test('U-24 ★ 不依赖 classifyLink 的可选第二参(knownFileExts)—— 判定不随用户类别配置漂移', () => {
  const url = 'https://cdn.example.com/f/x.xyz'

  // classifySniffed 判 unknown:`xyz` 不在任何 SNIFF_* 清单,也不在内置 DIRECT_FILE_EXTS
  assert.deepStrictEqual(classifySniffed(url, ''), { kind: 'unknown' })

  // ★ 反向对照:同一个 URL,只要**传了**第二参就会变成 http ——
  //   两者结论不同,就证明 classifySniffed 确实没传它(否则本断言与上一条不可能并存)。
  assert.equal(classifyLink(url, new Set(['xyz'])).kind, 'http')
  assert.equal(classifyLink(url).kind, 'ambiguous')
})

test('★ contentType 归一是防御层的一部分:伪造者不受「已去 charset、已小写」的协议约定约束', () => {
  // 协议约定扩展侧发来的 contentType 已归一,但第①层挡的正是**伪造的载荷**
  assert.deepStrictEqual(classifySniffed('https://cdn.x/seg', 'Video/MP2T; charset=utf-8'), {
    kind: 'segment'
  })
  assert.deepStrictEqual(classifySniffed('https://cdn.x/play', 'Application/X-MpegURL;charset=utf-8'), {
    kind: 'video'
  })
})
