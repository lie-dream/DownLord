/**
 * 嗅探桶单测(v0.4 Task 5 Phase 1 · spec §7.1 的 U-08~U-11)。
 *
 * 零 mock:进去是普通对象、出来是普通对象。
 * 反向探针 **RP-9**(上限改成「丢最旧的任意条目」)盯着 U-11。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { acceptIntoBucket, emptyBucket, MAX_ITEMS_PER_TAB, type SniffBucket } from './sniffBucket'
import type { SniffOutcome } from './sniffRules'

const MB = 1024 * 1024

function file(sizeBytes: number | null = 84 * MB): SniffOutcome {
  return { kind: 'file', ext: 'mp4', sizeBytes }
}
function stream(sizeBytes: number | null = null): SniffOutcome {
  return { kind: 'stream', ext: 'm3u8', sizeBytes }
}

/** 连续收纳,省掉一串 `bucket = acceptIntoBucket(...)` */
function feed(
  bucket: SniffBucket,
  entries: readonly { outcome: SniffOutcome; url: string; contentType?: string }[]
): SniffBucket {
  return entries.reduce(
    (acc, e) => acceptIntoBucket(acc, e.outcome, e.url, e.contentType ?? ''),
    bucket
  )
}

// ── U-08:去重键 = URL 原样 ────────────────────────────────────────────────

test('U-08: 同 URL 两次 → 1 条', () => {
  const url = 'https://x.example/a.mp4'
  const bucket = feed(emptyBucket(), [
    { outcome: file(), url },
    { outcome: file(), url }
  ])

  assert.equal(bucket.items.length, 1)
  assert.equal(bucket.seq, 1, '第二次没新增条目,发号器也不该往前走')
})

test('U-08: query 不同 → 2 条(反证「不剥 query」)', () => {
  const bucket = feed(emptyBucket(), [
    { outcome: file(), url: 'https://x.example/play?id=1&q=1080' },
    { outcome: file(), url: 'https://x.example/play?id=1&q=720' }
  ])

  // 剥 query 会把两个清晰度合并成一条 —— 用户从此下不到另一个
  assert.equal(bucket.items.length, 2)
  assert.deepEqual(
    bucket.items.map((i) => i.url),
    ['https://x.example/play?id=1&q=1080', 'https://x.example/play?id=1&q=720']
  )
})

test('U-08: ignore 不改动桶,且返回原引用(调用方据此跳过写盘)', () => {
  const before = emptyBucket()
  const after = acceptIntoBucket(
    before,
    { kind: 'ignore' },
    'https://x.example/p.html',
    'text/html'
  )

  assert.equal(after, before, '无变化时必须返回原引用')
})

// ── U-09:sizeBytes 补齐但不覆盖 ───────────────────────────────────────────

test('U-09: 先 null 后 84MB → 补上,且 seq 不变', () => {
  const url = 'https://x.example/a.mp4'
  const first = feed(emptyBucket(), [{ outcome: file(null), url }])
  assert.equal(first.items[0].sizeBytes, null)

  const second = acceptIntoBucket(first, file(84 * MB), url, '')

  assert.equal(second.items.length, 1)
  assert.equal(second.items[0].sizeBytes, 84 * MB)
  assert.equal(second.items[0].seq, first.items[0].seq, 'seq 不变 → 列表顺序不跳动')
})

test('U-09: 先 84MB 后 null → 不覆盖(且返回原引用)', () => {
  const url = 'https://x.example/a.mp4'
  const first = feed(emptyBucket(), [{ outcome: file(84 * MB), url }])
  const second = acceptIntoBucket(first, file(null), url, '')

  assert.equal(second, first, '已有值不该被 null 盖掉,也不该白写一次盘')
  assert.equal(second.items[0].sizeBytes, 84 * MB)
})

// ── U-10:三个计数器 ───────────────────────────────────────────────────────

test('U-10: segment → segmentCount++ 且不进 items', () => {
  const bucket = feed(emptyBucket(), [
    { outcome: { kind: 'segment' }, url: 'https://x.example/seg-1.ts' },
    { outcome: { kind: 'segment' }, url: 'https://x.example/seg-2.ts' }
  ])

  assert.equal(bucket.segmentCount, 2)
  assert.deepEqual(bucket.items, [], '分片一条都不该进列表')
  assert.equal(bucket.seq, 0, '分片不占用发号器')
})

test('U-10: too-small → hiddenSmallCount++', () => {
  const bucket = feed(emptyBucket(), [
    { outcome: { kind: 'too-small' }, url: 'https://x.example/tiny.mp4' }
  ])

  assert.equal(bucket.hiddenSmallCount, 1)
  assert.deepEqual(bucket.items, [])
})

test('U-10: 第 51 条 file → overflowCount++,items 停在上限', () => {
  const fifty = feed(
    emptyBucket(),
    Array.from({ length: MAX_ITEMS_PER_TAB }, (_, i) => ({
      outcome: file(),
      url: `https://x.example/${i}.mp4`
    }))
  )
  assert.equal(fifty.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(fifty.overflowCount, 0)

  const overflowed = acceptIntoBucket(fifty, file(), 'https://x.example/last.mp4', '')

  assert.equal(overflowed.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(overflowed.overflowCount, 1)
  assert.equal(overflowed.items.at(-1)?.url, 'https://x.example/last.mp4', '新的进来了')
  assert.equal(
    overflowed.items.find((i) => i.url === 'https://x.example/0.mp4'),
    undefined,
    '被挤掉的是最旧的那条'
  )
})

// ── U-11:上限只挤 file,不挤 stream(RP-9 盯这一条)──────────────────────

test('U-11: 上限只挤 file 不挤 stream', () => {
  // ★ 两个子例。第二个才是**能证伪 RP-9** 的那个 ——
  //   若最旧的那条本来就是 file(子例一),「丢最旧的 file」与「丢最旧的任意条」结果一模一样,
  //   探针改坏了也看不出来。故必须让 **stream 排在最前面**。
  const fillFiles = (bucket: SniffBucket, count: number, tag: string): SniffBucket =>
    feed(
      bucket,
      Array.from({ length: count }, (_, i) => ({
        outcome: file(),
        url: `https://x.example/${tag}-${i}.mp4`
      }))
    )

  // 子例一(spec 的字面情形):50 条 file 满 → 再来 1 条 stream
  const afterStream = acceptIntoBucket(
    fillFiles(emptyBucket(), MAX_ITEMS_PER_TAB, 'a'),
    stream(),
    'https://x.example/index.m3u8',
    'application/x-mpegurl'
  )
  assert.equal(afterStream.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(afterStream.overflowCount, 1)
  assert.ok(
    afterStream.items.some((i) => i.url === 'https://x.example/index.m3u8'),
    'stream 必须在列'
  )
  assert.equal(
    afterStream.items.find((i) => i.url === 'https://x.example/a-0.mp4'),
    undefined,
    '被挤掉的是最旧的 file'
  )

  // 子例二(stream 排最前):再来 1 条 file 时,**不许**动那条 stream
  const streamFirst = fillFiles(
    feed(emptyBucket(), [
      {
        outcome: stream(),
        url: 'https://x.example/first.m3u8',
        contentType: 'application/x-mpegurl'
      }
    ]),
    MAX_ITEMS_PER_TAB - 1,
    'b'
  )
  assert.equal(streamFirst.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(streamFirst.items[0].group, 'stream', '前置条件:最旧的那条是 stream')

  const afterFile = acceptIntoBucket(streamFirst, file(), 'https://x.example/extra.mp4', '')

  assert.equal(afterFile.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(afterFile.overflowCount, 1)
  assert.equal(
    afterFile.items[0].url,
    'https://x.example/first.m3u8',
    'stream 永不被挤掉 —— 挤掉它的实现会在这里变红'
  )
  assert.equal(
    afterFile.items.find((i) => i.url === 'https://x.example/b-0.mp4'),
    undefined,
    '被挤掉的应当是最旧的 file'
  )

  // 子例三(极端):满桶全是 stream → 谁都不挤,新来的落空并计入 overflow
  const allStreams = feed(
    emptyBucket(),
    Array.from({ length: MAX_ITEMS_PER_TAB }, (_, i) => ({
      outcome: stream(),
      url: `https://x.example/c-${i}.m3u8`,
      contentType: 'application/x-mpegurl'
    }))
  )
  const afterFull = acceptIntoBucket(allStreams, stream(), 'https://x.example/new.m3u8', '')

  assert.equal(afterFull.items.length, MAX_ITEMS_PER_TAB)
  assert.equal(afterFull.overflowCount, 1)
  assert.equal(
    afterFull.items.find((i) => i.url === 'https://x.example/new.m3u8'),
    undefined,
    '挤掉一条已在列的 stream 去换一条新的并不更好 —— 拒收才让「stream 永不被挤掉」恒真'
  )
  assert.equal(afterFull.items[0].url, 'https://x.example/c-0.m3u8', '在列的 stream 一条都没少')
})
