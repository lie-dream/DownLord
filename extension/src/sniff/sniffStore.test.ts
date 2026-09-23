/**
 * 嗅探桶读写单测(v0.4 Task 5 Phase 1 · spec §2.5)。
 *
 * 守的是两件在纯函数里看不见的事:**读改写不许因并发而互相覆盖**(串行链),
 * 以及**没变化就不写盘**(高频事件上白写会把 `storage.session` 的写配额烧掉)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserAdapter, SniffedResponse } from '../adapter/browserAdapter'
import type { SniffBucket } from './sniffBucket'
import {
  bucketKey,
  clearAllBuckets,
  flushSniffWrites,
  readBucket,
  recordSniffedResponse,
  removeBucket
} from './sniffStore'

interface Fake {
  adapter: BrowserAdapter
  store: Map<string, unknown>
  calls: { sets: string[]; removes: string[] }
}

/** 让每次 `get` 跨一个宏任务再回 —— 不这样的话「并发读改写」这个坑在测试里根本不会发生 */
function later<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0))
}

function makeFake(seed: [string, unknown][] = []): Fake {
  const store = new Map<string, unknown>(seed)
  const calls = { sets: [] as string[], removes: [] as string[] }

  const session = {
    get<T>(key: string): Promise<T | undefined> {
      return later(store.get(key) as T | undefined)
    },
    set(key: string, value: unknown): Promise<void> {
      calls.sets.push(key)
      store.set(key, value)
      return later(undefined as unknown as void)
    },
    remove(key: string): Promise<void> {
      calls.removes.push(key)
      store.delete(key)
      return later(undefined as unknown as void)
    },
    keys(): Promise<string[]> {
      return later([...store.keys()])
    }
  }

  // 本文件只用 session 一块 —— 其余端口给占位实现,调到即视为出错
  const unused = (): never => {
    throw new Error('本文件不该用到这个端口')
  }
  const adapter = {
    session,
    storage: { get: unused, set: unused, remove: unused, onChanged: unused },
    runtime: {
      getVersion: unused,
      getId: unused,
      onInstalled: unused,
      onStartup: unused,
      onMessage: unused,
      sendMessage: unused,
      getUserAgent: unused
    },
    net: { postJson: unused },
    downloads: { onCreated: unused, cancel: unused, eraseCanceled: unused },
    webRequest: { onHeadersReceived: unused },
    tabs: { queryActiveId: unused, reloadBypassingCache: unused, onRemoved: unused }
  } as unknown as BrowserAdapter

  return { adapter, store, calls }
}

function response(
  url: string,
  headers: Record<string, string>,
  tabId = 7,
  initiator = 'https://page.example'
): SniffedResponse {
  return {
    tabId,
    url,
    initiator,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value }))
  }
}

const HLS = { 'Content-Type': 'application/x-mpegURL; charset=utf-8' }
const MP4 = { 'Content-Type': 'video/mp4', 'Content-Length': '88000000' }

test('收纳一条流媒体清单 → 落到 sniff:<tabId>,字段来自响应头', async () => {
  const fake = makeFake()

  await recordSniffedResponse(fake.adapter, response('https://x.example/index.m3u8?t=1', HLS))

  const bucket = await readBucket(fake.adapter, 7)
  assert.equal(fake.calls.sets[0], 'sniff:7')
  assert.equal(bucket?.items.length, 1)
  assert.deepEqual(bucket?.items[0], {
    url: 'https://x.example/index.m3u8?t=1',
    contentType: 'application/x-mpegurl',
    // ★ Phase 2:来源随条目一起存。**只能在采集时存** —— popup 里点下载那一刻,
    //   webRequest 的 details 早已不存在,而适配层刻意读不到 tab 的 url。
    //   取值是 **origin 级**,「不记 referrer 完整值」由取值形态保证而非自觉。
    initiator: 'https://page.example',
    ext: 'm3u8',
    group: 'stream',
    sizeBytes: null,
    seq: 1
  })
})

test('★ 来源(initiator)缺失时归成空串,不引入第二个「没有」的取值', async () => {
  const fake = makeFake()

  await recordSniffedResponse(fake.adapter, response('https://x.example/a.mp4', MP4, 7, ''))

  const bucket = await readBucket(fake.adapter, 7)
  assert.equal(bucket?.items[0].initiator, '')
})

test('Content-Length 从响应头读出来并进条目', async () => {
  const fake = makeFake()

  await recordSniffedResponse(fake.adapter, response('https://x.example/a.mp4', MP4))

  const bucket = await readBucket(fake.adapter, 7)
  assert.equal(bucket?.items[0].sizeBytes, 88_000_000)
})

test('非媒体请求一个字节都不写盘(高频事件上这是主路径)', async () => {
  const fake = makeFake()

  await recordSniffedResponse(
    fake.adapter,
    response('https://x.example/app.js', { 'Content-Type': 'application/javascript' })
  )
  await flushSniffWrites()

  assert.deepEqual(fake.calls.sets, [])
  assert.equal(await readBucket(fake.adapter, 7), undefined)
})

test('同 URL 第二次命中且无新信息 → 不再写盘', async () => {
  const fake = makeFake()
  const event = response('https://x.example/a.mp4', MP4)

  await recordSniffedResponse(fake.adapter, event)
  await recordSniffedResponse(fake.adapter, event)
  await flushSniffWrites()

  assert.deepEqual(fake.calls.sets, ['sniff:7'], '第二次没有新信息,不该产生第二次写')
})

test('★ 串行链:同一 tab 的并发事件一条都不丢(不串行会互相覆盖)', async () => {
  const fake = makeFake()
  const events = Array.from({ length: 12 }, (_, i) => response(`https://x.example/${i}.mp4`, MP4))

  // 刻意**不 await 每一条** —— 真实的 onHeadersReceived 就是这样并发投递的
  await Promise.all(events.map((event) => recordSniffedResponse(fake.adapter, event)))
  await flushSniffWrites()

  const bucket = (await readBucket(fake.adapter, 7)) as SniffBucket
  assert.equal(bucket.items.length, 12, '少于 12 条 = 读改写被并发覆盖了')
  assert.deepEqual(
    bucket.items.map((i) => i.seq),
    Array.from({ length: 12 }, (_, i) => i + 1),
    'seq 应当连续单调'
  )
})

test('不同 tab 分桶,互不干扰', async () => {
  const fake = makeFake()

  await recordSniffedResponse(fake.adapter, response('https://x.example/a.mp4', MP4, 1))
  await recordSniffedResponse(fake.adapter, response('https://x.example/b.mp4', MP4, 2))

  assert.equal((await readBucket(fake.adapter, 1))?.items.length, 1)
  assert.equal((await readBucket(fake.adapter, 2))?.items.length, 1)
  assert.equal(bucketKey(2), 'sniff:2')
})

test('removeBucket 只删该 tab 的桶', async () => {
  const fake = makeFake()
  await recordSniffedResponse(fake.adapter, response('https://x.example/a.mp4', MP4, 1))
  await recordSniffedResponse(fake.adapter, response('https://x.example/b.mp4', MP4, 2))

  await removeBucket(fake.adapter, 1)

  assert.equal(await readBucket(fake.adapter, 1), undefined)
  assert.equal((await readBucket(fake.adapter, 2))?.items.length, 1)
})

test('clearAllBuckets 清掉全部 sniff:* 且不碰别的键,返回清掉的个数', async () => {
  const fake = makeFake([['other:key', { keep: true }]])
  await recordSniffedResponse(fake.adapter, response('https://x.example/a.mp4', MP4, 1))
  await recordSniffedResponse(fake.adapter, response('https://x.example/b.mp4', MP4, 2))

  const cleared = await clearAllBuckets(fake.adapter)

  assert.equal(cleared, 2)
  assert.equal(await readBucket(fake.adapter, 1), undefined)
  assert.equal(await readBucket(fake.adapter, 2), undefined)
  assert.deepEqual(fake.store.get('other:key'), { keep: true }, '别的键不该被误伤')
})
