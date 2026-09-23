/**
 * CompositeDownloadEngine 单元测试 — 双执行器路由(spec §4.1 / plan Phase 2 Task 2.3)。
 *
 * mock 两后端(http=aria2 / video=yt-dlp),断言:addUri 按 `input.video` 在 / 否分流(唯一分流点)
 * + 记 id→backend;pause/resume/remove 按 id 回查正确后端;onProgress 合并两路;start/stop 顺序。
 * 对 TaskManager 透明:Composite 自身实现 TaskEngine,id 直接透传后端(不重映射)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AddUriInput, DownloadProgress } from '../../shared/ipc'
import { CompositeDownloadEngine, type ManagedTaskEngine } from './compositeEngine'

class MockBackend implements ManagedTaskEngine {
  readonly addUriCalls: AddUriInput[] = []
  readonly pauseCalls: string[] = []
  readonly resumeCalls: string[] = []
  readonly removeCalls: string[] = []
  readonly globalLimitCalls: number[] = []
  readonly taskLimitCalls: Array<{ id: string; kbps: number | null }> = []
  readonly stopSeedingCalls: string[] = []
  private counter = 0
  private cb: ((p: DownloadProgress) => void) | null = null

  constructor(
    private readonly name: string,
    private readonly order: string[]
  ) {}

  async start(): Promise<void> {
    this.order.push(`${this.name}:start`)
  }
  async stop(): Promise<void> {
    this.order.push(`${this.name}:stop`)
  }
  async addUri(input: AddUriInput): Promise<string> {
    this.addUriCalls.push(input)
    return `${this.name}_${++this.counter}`
  }
  async pause(id: string): Promise<void> {
    this.pauseCalls.push(id)
  }
  async resume(id: string): Promise<void> {
    this.resumeCalls.push(id)
  }
  async remove(id: string): Promise<void> {
    this.removeCalls.push(id)
  }
  async setGlobalLimit(kbps: number): Promise<void> {
    this.globalLimitCalls.push(kbps)
  }
  async setTaskLimit(id: string, kbps: number | null): Promise<void> {
    this.taskLimitCalls.push({ id, kbps })
  }
  async stopSeeding(id: string): Promise<void> {
    this.stopSeedingCalls.push(id)
  }
  onProgress(cb: (p: DownloadProgress) => void): () => void {
    this.cb = cb
    return () => {
      this.cb = null
    }
  }
  emit(p: DownloadProgress): void {
    this.cb?.(p)
  }
}

function createHarness(): {
  composite: CompositeDownloadEngine
  http: MockBackend
  video: MockBackend
  order: string[]
} {
  const order: string[] = []
  const http = new MockBackend('http', order)
  const video = new MockBackend('video', order)
  const composite = new CompositeDownloadEngine(http, video)
  return { composite, http, video, order }
}

const HTTP_INPUT: AddUriInput = { url: 'https://x/a.bin', dir: 'D:\\Downloads', filename: 'a.bin' }
const VIDEO_INPUT: AddUriInput = {
  url: 'https://youtu.be/abc',
  dir: 'D:\\Downloads',
  filename: 'v.mp4',
  video: { formatSelector: 'best', audioOnly: false }
}

test('addUri routes by input.video: video → video backend, http(no video) → http backend', async () => {
  const { composite, http, video } = createHarness()

  const httpId = await composite.addUri(HTTP_INPUT)
  const videoId = await composite.addUri(VIDEO_INPUT)

  assert.equal(http.addUriCalls.length, 1, '直链路由到 aria2 后端')
  assert.equal(video.addUriCalls.length, 1, '视频路由到 yt-dlp 后端')
  assert.equal(http.addUriCalls[0].url, 'https://x/a.bin')
  assert.equal(video.addUriCalls[0].url, 'https://youtu.be/abc')
  assert.ok(httpId.startsWith('http_'), 'id 透传后端(不重映射)')
  assert.ok(videoId.startsWith('video_'))
})

test('分流器逐字段透传 AddUriInput:http 后端收到的与传入的完全相同(零加工)', async () => {
  const { composite, http } = createHarness()

  await composite.addUri(HTTP_INPUT)

  // v0.4 Task 4 Phase 3 的等价基准(spec §6.2):分流器**只路由不加工**,故「引擎收到什么」
  // 完全取决于上游 `toAddUriInput`。`deepStrictEqual` 比较自有可枚举键集合 —— 多一个
  // `headers: undefined` 也会红,故这条同时是「缺省不得多出任何键」的下游守卫。
  assert.deepStrictEqual(http.addUriCalls[0], HTTP_INPUT)
})

test('pause / resume / remove route by id back to the correct backend', async () => {
  const { composite, http, video } = createHarness()
  const httpId = await composite.addUri(HTTP_INPUT)
  const videoId = await composite.addUri(VIDEO_INPUT)

  await composite.pause(httpId)
  await composite.resume(httpId)
  await composite.pause(videoId)
  await composite.resume(videoId)

  assert.deepEqual(http.pauseCalls, [httpId], 'http id → http.pause')
  assert.deepEqual(http.resumeCalls, [httpId])
  assert.deepEqual(video.pauseCalls, [videoId], 'video id → video.pause')
  assert.deepEqual(video.resumeCalls, [videoId])
  assert.equal(video.pauseCalls.includes(httpId), false, '不会错投到另一后端')
})

test('remove routes to the correct backend and forgets the id mapping', async () => {
  const { composite, http, video } = createHarness()
  const videoId = await composite.addUri(VIDEO_INPUT)

  await composite.remove(videoId)
  assert.deepEqual(video.removeCalls, [videoId], 'video id → video.remove')
  assert.equal(http.removeCalls.length, 0)

  // 移除后 id 已忘记 → 再操作抛错(回查失败)
  await assert.rejects(() => composite.pause(videoId), /未知|unknown|id/i)
})

test('onProgress merges both backends; unsubscribe removes both', async () => {
  const { composite, http, video } = createHarness()
  const seen: string[] = []
  const off = composite.onProgress((p) => seen.push(p.id))

  http.emit({
    id: 'http_1',
    status: 'downloading',
    totalBytes: 1,
    downloadedBytes: 0,
    speed: 0,
    connections: 1
  })
  video.emit({
    id: 'video_1',
    status: 'completed',
    totalBytes: 1,
    downloadedBytes: 1,
    speed: 0,
    connections: 0
  })
  assert.deepEqual(seen, ['http_1', 'video_1'], '合并两路进度')

  off()
  http.emit({
    id: 'http_2',
    status: 'downloading',
    totalBytes: 1,
    downloadedBytes: 0,
    speed: 0,
    connections: 1
  })
  video.emit({
    id: 'video_2',
    status: 'downloading',
    totalBytes: 1,
    downloadedBytes: 0,
    speed: 0,
    connections: 0
  })
  assert.deepEqual(seen, ['http_1', 'video_1'], '退订后两路都不再回调')
})

test('start starts http then video; stop stops video then http (spec §4.1 顺序)', async () => {
  const { composite, order } = createHarness()
  await composite.start()
  await composite.stop()
  assert.deepEqual(order, ['http:start', 'video:start', 'video:stop', 'http:stop'])
})

test('pick throws for an unknown id (never added / already removed)', async () => {
  const { composite } = createHarness()
  await assert.rejects(() => composite.pause('nope'), /未知|unknown|id/i)
})

// ============ 限速路由(v0.2 Task 2 · spec §2.2 / §2.3 / §6.4)============

test('setGlobalLimit 仅转 http 后端(aria2 push);video 靠 getSpeedLimit pull 不 push', async () => {
  const { composite, http, video } = createHarness()
  await composite.setGlobalLimit(500)
  assert.deepEqual(http.globalLimitCalls, [500], '全局限速 push 到 aria2 后端')
  assert.deepEqual(video.globalLimitCalls, [], 'video 后端不 push(靠 getSpeedLimit pull)')
})

test('setTaskLimit 按 id 路由到受理后端', async () => {
  const { composite, http, video } = createHarness()
  const httpId = await composite.addUri(HTTP_INPUT)
  const videoId = await composite.addUri(VIDEO_INPUT)

  await composite.setTaskLimit(httpId, 256)
  await composite.setTaskLimit(videoId, 128)

  assert.deepEqual(http.taskLimitCalls, [{ id: httpId, kbps: 256 }], 'http id → http.setTaskLimit')
  assert.deepEqual(
    video.taskLimitCalls,
    [{ id: videoId, kbps: 128 }],
    'video id → video.setTaskLimit'
  )
})

test('setTaskLimit 未知 id → 回查失败抛错(与 pause/resume 同构)', async () => {
  const { composite } = createHarness()
  await assert.rejects(() => composite.setTaskLimit('nope', 100), /未知|unknown|id/i)
})

test('setTaskLimit(null) 按 id 路由并原样透传(v0.3 Task 4 · #25:路由不解释三态语义)', async () => {
  const { composite, http, video } = createHarness()
  const httpId = await composite.addUri(HTTP_INPUT)
  const videoId = await composite.addUri(VIDEO_INPUT)

  await composite.setTaskLimit(httpId, null)
  await composite.setTaskLimit(videoId, null)

  assert.deepEqual(
    http.taskLimitCalls,
    [{ id: httpId, kbps: null }],
    'http id → http.setTaskLimit(null)(aria2 后端自解释为 max-download-limit=0)'
  )
  assert.deepEqual(
    video.taskLimitCalls,
    [{ id: videoId, kbps: null }],
    'video id → video.setTaskLimit(null)(video 后端自解释为回落全局)'
  )
})

// ============ 停止做种路由(v0.3 Task 3 · spec §7)============

test('stopSeeding 按 id 路由到受理后端(torrent 天然落 aria2 http 后端)', async () => {
  const { composite, http, video } = createHarness()
  const httpId = await composite.addUri(HTTP_INPUT)
  const videoId = await composite.addUri(VIDEO_INPUT)

  await composite.stopSeeding(httpId)
  await composite.stopSeeding(videoId)

  assert.deepEqual(http.stopSeedingCalls, [httpId], 'http id → http.stopSeeding')
  assert.deepEqual(video.stopSeedingCalls, [videoId], 'video id → video.stopSeeding')
})

test('stopSeeding 未知 id → 回查失败抛错(与 pause/resume 同构)', async () => {
  const { composite } = createHarness()
  await assert.rejects(() => composite.stopSeeding('nope'), /未知|unknown|id/i)
})
