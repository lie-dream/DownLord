/**
 * 资源区成品视图的单测(v0.4 Task 5 Phase 2 · spec §7.1 的 U-12~U-16)。
 *
 * 零 mock:进去是普通对象、出来是普通对象。**分片归属那三情形是本文件的重点** ——
 * 它们是 E4「归属不是拼接」的诚实实现,判据只有标签页(桶),不猜 URL 路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { SniffBucket, SniffedItem } from './sniffBucket'
import type { SniffGroup } from './sniffRules'
import { buildSniffSections, SIZE_PLACEHOLDER } from './sniffView'

const MB = 1024 * 1024

function item(
  url: string,
  group: SniffGroup,
  ext: string | null,
  sizeBytes: number | null = null,
  contentType = ''
): SniffedItem {
  return { url, contentType, initiator: 'https://page.example', ext, group, sizeBytes, seq: 0 }
}

function bucketOf(items: SniffedItem[], overrides: Partial<SniffBucket> = {}): SniffBucket {
  return {
    seq: items.length,
    segmentCount: 0,
    hiddenSmallCount: 0,
    overflowCount: 0,
    items: items.map((entry, index) => ({ ...entry, seq: index + 1 })),
    ...overrides
  }
}

const M3U8_A = 'https://cdn.example/av1-sample.m3u8?4582'
const M3U8_B = 'https://cdn.example/_1920_2.7M/prog_index.m3u8'
const MP4 = 'https://cdn.example/trailer.mp4'

/** 全部行(不分组),给「哪一行挂了什么」这类断言用 */
function allRows(view: ReturnType<typeof buildSniffSections>): {
  name: string
  note: string
}[] {
  return view.sections.flatMap((s) => s.rows.map((r) => ({ name: r.name, note: r.note })))
}

// ── U-12:恰好 1 条清单 → 挂在该条上 ───────────────────────────────────────

test('U-12: 12 片 + 恰好 1 条 stream → 该条下方「已聚合 12 片」', () => {
  const view = buildSniffSections(
    bucketOf([item(M3U8_A, 'stream', 'm3u8')], { segmentCount: 12 }),
    true,
    false
  )

  assert.equal(view.sections.length, 1)
  assert.equal(view.sections[0].title, '视频流')
  assert.equal(view.sections[0].rows[0].note, '已聚合 12 片')
  // 归属明确时**不**再往分组级挂一遍(同一件事说两次会让人以为是两批分片)
  assert.equal(view.sections[0].note, '')
  assert.deepEqual(view.notices, [])
})

// ── U-13:≥ 2 条清单 → 挂分组级,不挂到任一条 ───────────────────────────────

test('U-13: ★ 12 片 + 2 条 stream → **不挂到任一条**,出分组级一行', () => {
  const view = buildSniffSections(
    bucketOf([item(M3U8_A, 'stream', 'm3u8'), item(M3U8_B, 'stream', 'm3u8')], {
      segmentCount: 12
    }),
    true,
    false
  )

  // ⚠️ 多条清单时**无从判断 12 片归谁,猜就是错的**。硬挂给第一条会给出一个
  //    **具体但假**的数字,那比不给更坏 —— 挂到分组级是唯一诚实的落点。
  for (const row of allRows(view)) {
    assert.equal(row.note, '', `${row.name} 不该被挂上一个我们并不知道的数字`)
  }
  assert.equal(view.sections[0].note, '本页有 12 个分片请求属于上方清单,不单独列出')
})

test('U-13: ★ 分组级那句**不许暗示可展开** —— 分片 URL 桶里根本没存(2026-08-11 真机反馈)', () => {
  const view = buildSniffSections(
    bucketOf([item(M3U8_A, 'stream', 'm3u8'), item(M3U8_B, 'stream', 'm3u8')], {
      segmentCount: 8
    }),
    true,
    false
  )
  const note = view.sections[0].note

  // 用户把原文「已归入上方视频流」读成了「有 8 个东西被折叠了,但我展不开」——
  // 「归入」暗示容器关系,而真实关系只是归属。改后只陈述归属 + 不单独列出。
  assert.equal(/归入|展开|查看|点击/.test(note), false, `不许暗示可展开:${note}`)
  assert.match(note, /不单独列出/)
})

// ── U-14:0 条清单 → 不可下载的提示行 ──────────────────────────────────────

test('U-14: ★ 12 片 + 0 条 stream → 提示行,且**结构上没有下载按钮**', () => {
  const view = buildSniffSections(bucketOf([], { segmentCount: 12 }), true, false)

  assert.deepEqual(view.notices, ['本页检测到分片流,但未找到可下载的清单文件'])
  // ⚠️ 结构断言:提示行是**字符串**,不是行对象 —— 它连一个能长出按钮的位置都没有。
  //    我们确实没有可交给 yt-dlp 的 URL,给按钮就是承诺一件做不到的事。
  assert.deepEqual(view.sections, [])
  assert.equal(view.empty, null, '有提示行就不是空状态 —— 「检测到了但没有可下的那一条」是有内容的')
})

test('U-14: 有分片无清单但有直链 → 提示行与「媒体文件」组并存', () => {
  const view = buildSniffSections(
    bucketOf([item(MP4, 'file', 'mp4', 84 * MB)], { segmentCount: 3 }),
    true,
    false
  )

  assert.deepEqual(
    view.sections.map((s) => s.title),
    ['媒体文件']
  )
  assert.deepEqual(view.notices, ['本页检测到分片流,但未找到可下载的清单文件'])
})

// ── U-15:空状态两子态 ────────────────────────────────────────────────────

test('U-15: 已开 + 本页零资源 → 「本页未检测到媒体资源」+ 隐私小字', () => {
  const view = buildSniffSections(bucketOf([]), true, false)

  assert.equal(view.empty?.text, '本页未检测到媒体资源')
  assert.equal(view.empty?.small, '本扩展不注入页面脚本,只读取网络请求的地址与响应头')
  assert.deepEqual(view.sections, [])
})

test('U-15: 刚开 + 本页零资源 → 「刷新本页后」+ 强制刷新按钮(**绝不自动 reload**)', () => {
  const view = buildSniffSections(bucketOf([]), true, true)

  assert.equal(view.empty?.text, '已开启。刷新本页后才能看到本页的媒体资源。')
  assert.equal(view.empty?.canReload, true)
  // 提示语一律写「本页」不写「本会话」—— 切了标签页就看不到原页面的资源
  assert.equal(view.empty?.text.includes('本会话'), false)
})

test('U-15: 两种空状态措辞不同 —— 原因不同,修法也不同', () => {
  const justEnabled = buildSniffSections(bucketOf([]), true, true)
  const steady = buildSniffSections(bucketOf([]), true, false)

  assert.notEqual(justEnabled.empty?.text, steady.empty?.text)
})

test('U-15: 开关关着 → 先说清「开了会读什么」(用户是在打开之前决定的)', () => {
  const view = buildSniffSections(bucketOf([]), false, false)

  assert.equal(view.empty?.text, '嗅探已关闭')
  assert.match(view.empty?.small ?? '', /地址与响应头/)
  assert.equal(view.empty?.canReload, false)
  // 关着时不谈缓存 —— 那句话此刻没有意义
  assert.deepEqual(view.footnotes, [])
})

// ── U-16:没读到桶 ≠ 桶是空的 ──────────────────────────────────────────────

test('U-16: ★ `sniff === undefined`(没读到桶)与「桶为空」渲染不同', () => {
  const unread = buildSniffSections(undefined, true, false)
  const emptyBucketView = buildSniffSections(bucketOf([]), true, false)

  assert.equal(unread.unavailable, true)
  assert.equal(unread.empty?.text, '无法读取本页资源')

  assert.equal(emptyBucketView.unavailable, false)
  assert.equal(emptyBucketView.empty?.text, '本页未检测到媒体资源')

  // 「读不到」不许被「没有」的那套话盖住 —— 沿用 PopupFacts.takeover 的既有约定
  assert.notEqual(unread.empty?.text, emptyBucketView.empty?.text)
})

test('U-16: 没读到桶时不编造任何底部小字(连缓存那句都不说)', () => {
  const view = buildSniffSections(undefined, true, false)

  assert.deepEqual(view.footnotes, [])
  assert.deepEqual(view.sections, [])
  assert.deepEqual(view.notices, [])
})

// ── 分组、行内四段、排序 ──────────────────────────────────────────────────

test('分组恰好两组,且**空组不渲染**(不显示「视频流(0)」这种噪音)', () => {
  const onlyFiles = buildSniffSections(bucketOf([item(MP4, 'file', 'mp4', 84 * MB)]), true, false)

  assert.deepEqual(
    onlyFiles.sections.map((s) => s.title),
    ['媒体文件']
  )
})

test('行四段:文件名(末段)+ 徽章 + 大小 + 完整 URL 只进 title 用的字段', () => {
  const view = buildSniffSections(bucketOf([item(MP4, 'file', 'mp4', 84 * MB)]), true, false)
  const row = view.sections[0].rows[0]

  assert.equal(row.name, 'trailer.mp4')
  assert.equal(row.badge, 'MP4')
  assert.equal(row.size, '84.0 MB')
  assert.equal(row.url, MP4)
})

test('大小缺失 → `—`(**不写「未知」更不写 0**),并按协议归成 totalBytes = -1', () => {
  const view = buildSniffSections(bucketOf([item(M3U8_A, 'stream', 'm3u8', null)]), true, false)
  const row = view.sections[0].rows[0]

  assert.equal(row.size, SIZE_PLACEHOLDER)
  assert.equal(row.totalBytes, -1)
})

test('徽章:扩展名判不出时退到 contentType;再判不出退到组名', () => {
  const view = buildSniffSections(
    bucketOf([
      item('https://cdn.example/play?id=1', 'stream', null, null, 'application/x-mpegurl'),
      item('https://cdn.example/blob?id=2', 'file', null, 1 * MB, 'application/octet-stream')
    ]),
    true,
    false
  )

  assert.equal(view.sections[0].rows[0].badge, 'HLS')
  assert.equal(view.sections[1].rows[0].badge, '媒体文件')
})

test('文件名:末段为空 → 显示 host;百分号转义还原', () => {
  const view = buildSniffSections(
    bucketOf([
      item('https://cdn.example/', 'file', null, 2 * MB),
      item('https://cdn.example/%E7%89%87.mp4', 'file', 'mp4', 2 * MB)
    ]),
    true,
    false
  )

  assert.deepEqual(
    view.sections[0].rows.map((r) => r.name),
    ['cdn.example', '片.mp4']
  )
})

// ── 末段重名时补一级目录(2026-08-11 真机反馈)────────────────────────────

test('★ 本页内末段重名 → 补上一级目录,否则三条清单在列表里长得一模一样', () => {
  // 真机形态(hls.js demo / Apple HLS 示例页都是这样):区分码率的信息全在**目录名**里
  const view = buildSniffSections(
    bucketOf([
      item('https://cdn.example/_1920_2.7M/prog_index.m3u8', 'stream', 'm3u8'),
      item('https://cdn.example/_864_1.1M/prog_index.m3u8', 'stream', 'm3u8'),
      item('https://cdn.example/x36xhzz.m3u8', 'stream', 'm3u8')
    ]),
    true,
    false
  )

  assert.deepEqual(
    view.sections[0].rows.map((r) => r.name),
    [
      '_1920_2.7M/prog_index.m3u8',
      '_864_1.1M/prog_index.m3u8',
      // ★ **不重名的那条不补** —— 补目录是为了消解重名,不是给所有行加长度
      'x36xhzz.m3u8'
    ]
  )
})

test('重名判定跨组进行(本页是一个整体),且**只补一级、不递归**', () => {
  const view = buildSniffSections(
    bucketOf([
      item('https://cdn.example/a/index.m3u8', 'stream', 'm3u8'),
      item('https://cdn.example/b/index.m3u8', 'file', 'mp4', 2 * MB)
    ]),
    true,
    false
  )

  assert.deepEqual(
    [...view.sections[0].rows, ...view.sections[1].rows].map((r) => r.name),
    ['a/index.m3u8', 'b/index.m3u8']
  )
})

test('★ 补完仍重名(同目录、只有 query 不同)→ **到此为止,不再往上补**', () => {
  const view = buildSniffSections(
    bucketOf([
      item('https://cdn.example/v/play.m3u8?q=1080', 'stream', 'm3u8'),
      item('https://cdn.example/v/play.m3u8?q=720', 'stream', 'm3u8')
    ]),
    true,
    false
  )

  // 再往上补会把整条路径贴进 380px 的行里,而完整 URL 本来就在 title tooltip 里。
  // 如实止步,不假装能把每种情形都区分开。
  assert.deepEqual(
    view.sections[0].rows.map((r) => r.name),
    ['v/play.m3u8', 'v/play.m3u8']
  )
  assert.notEqual(view.sections[0].rows[0].url, view.sections[0].rows[1].url, 'URL 仍各不相同')
})

test('重名条目没有上一级目录(在站点根下)→ 原样,不编一个目录出来', () => {
  const view = buildSniffSections(
    bucketOf([
      item('https://a.example/index.m3u8', 'stream', 'm3u8'),
      item('https://b.example/index.m3u8', 'stream', 'm3u8')
    ]),
    true,
    false
  )

  assert.deepEqual(
    view.sections[0].rows.map((r) => r.name),
    ['index.m3u8', 'index.m3u8']
  )
})

test('★ 排序 = 采集顺序(seq 升序),**不按大小** —— 长视频的子清单可以比 master 大得多', () => {
  // 真机取证(2026-08-09,Apple HLS 示例页):master 29585 B 在前,子清单 1589 B 在后。
  // 长视频里这个大小关系会**反过来**(media playlist 逐条列分片、轻易上百 KB),
  // 故按大小排会把用户该点的那条排到最后。
  const view = buildSniffSections(
    bucketOf([item(M3U8_A, 'stream', 'm3u8', 29585), item(M3U8_B, 'stream', 'm3u8', 1589)]),
    true,
    false
  )

  assert.deepEqual(
    view.sections[0].rows.map((r) => r.url),
    [M3U8_A, M3U8_B]
  )
  // **不加任何「这是主清单」的标注** —— 采集顺序是弱信号不是断言,我们并不知道
  for (const row of view.sections[0].rows) assert.equal(row.note, '')
})

// ── 不静默截断:三行底部小字 ──────────────────────────────────────────────

test('隐藏计数 / 上限提示逐字如实', () => {
  const view = buildSniffSections(
    bucketOf([item(MP4, 'file', 'mp4', 84 * MB)], { hiddenSmallCount: 3, overflowCount: 7 }),
    true,
    false
  )

  assert.ok(view.footnotes.includes('已隐藏 3 个小于 1MB 的媒体请求'))
  assert.ok(view.footnotes.includes('仅显示最近 50 条'))
})

test('★ 缓存边界那一行恒定可见 —— R2 的真实影响是「采少了」,空状态那句话覆盖不到', () => {
  const withList = buildSniffSections(bucketOf([item(MP4, 'file', 'mp4', 84 * MB)]), true, false)
  const emptyList = buildSniffSections(bucketOf([]), true, false)

  for (const view of [withList, emptyList]) {
    const cacheNote = view.footnotes.find((n) => n.includes('缓存'))
    assert.ok(cacheNote, '有列表时用户看到 2 条,根本不知道少了 2 条 —— 这一行就是为此')
    // 措辞红线:只陈述恒为真的事实,**不写「已覆盖」「保证抓全」**
    assert.equal(/已覆盖|保证|一定能|全部资源/.test(cacheNote), false)
    assert.equal(cacheNote.includes('本会话'), false)
  }
})

test('零隐藏 / 零溢出 → 不出那两行(没被截断就别说被截断了)', () => {
  const view = buildSniffSections(bucketOf([item(MP4, 'file', 'mp4', 84 * MB)]), true, false)

  assert.equal(
    view.footnotes.some((n) => n.includes('已隐藏') || n.includes('仅显示最近')),
    false
  )
})

// ── 转交状态:三态 + 失败如实回落 ─────────────────────────────────────────

test('默认 → 按钮「下载」可点、无错误行', () => {
  const view = buildSniffSections(bucketOf([item(MP4, 'file', 'mp4', 84 * MB)]), true, false)
  const row = view.sections[0].rows[0]

  assert.equal(row.actionLabel, '下载')
  assert.equal(row.actionDisabled, false)
  assert.equal(row.error, '')
})

test('sending / sent → 按钮禁用;★ failed → **恢复可点** + 一行实话,绝不假装成功', () => {
  const bucket = bucketOf([item(MP4, 'file', 'mp4', 84 * MB)])

  const sending = buildSniffSections(bucket, true, false, { [MP4]: 'sending' })
  assert.equal(sending.sections[0].rows[0].actionDisabled, true)

  const sent = buildSniffSections(bucket, true, false, { [MP4]: 'sent' })
  assert.equal(sent.sections[0].rows[0].actionLabel, '已发送')
  assert.equal(sent.sections[0].rows[0].actionDisabled, true)

  const failed = buildSniffSections(bucket, true, false, { [MP4]: 'failed' })
  assert.equal(failed.sections[0].rows[0].actionLabel, '下载')
  assert.equal(failed.sections[0].rows[0].actionDisabled, false, '失败后必须能再点一次')
  assert.equal(failed.sections[0].rows[0].error, '没能交给 DownLord,请确认它正在运行')
})

test('转交状态按 URL 归位 —— 不会串到别的行上', () => {
  const view = buildSniffSections(
    bucketOf([item(M3U8_A, 'stream', 'm3u8'), item(MP4, 'file', 'mp4', 84 * MB)]),
    true,
    false,
    { [MP4]: 'sent' }
  )

  assert.equal(view.sections[0].rows[0].actionLabel, '下载')
  assert.equal(view.sections[1].rows[0].actionLabel, '已发送')
})

test('转交载荷随行带出:contentType / initiator(origin 级)/ totalBytes', () => {
  const view = buildSniffSections(
    bucketOf([item(MP4, 'file', 'mp4', 84 * MB, 'video/mp4')]),
    true,
    false
  )
  const row = view.sections[0].rows[0]

  assert.equal(row.contentType, 'video/mp4')
  assert.equal(row.initiator, 'https://page.example')
  assert.equal(row.totalBytes, 84 * MB)
})
