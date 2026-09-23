import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeEngine } from './fakeEngine'
import type { DownloadProgress } from '../../shared/ipc'

function createTimerDeps(
  options: { totalBytes?: number; stepBytes?: number; intervalMs?: number } = {}
): {
  ticks: Array<() => void>
  cleared: unknown[]
  deps: {
    setInterval: (fn: () => void) => never
    clearInterval: (handle: unknown) => void
    totalBytes?: number
    stepBytes?: number
    intervalMs?: number
  }
} {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []

  return {
    ticks,
    cleared,
    deps: {
      setInterval: (fn: () => void) => {
        ticks.push(fn)
        return ticks.length as never
      },
      clearInterval: (handle: unknown) => {
        cleared.push(handle)
      },
      ...options
    }
  }
}

test('addUri 推进到 completed', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/file.zip', dir: 'd' })

  ticks[0]()
  ticks[0]()
  ticks[0]()

  assert.equal(frames.at(-1)?.status, 'completed')
  assert.equal(frames.at(-1)?.downloadedBytes, 30)
})

test('url 含 fail 推送 error', async () => {
  const { ticks, deps } = createTimerDeps()
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/fail-now.zip', dir: 'd' })
  ticks[0]()

  assert.equal(frames.at(-1)?.status, 'error')
  assert.match(frames.at(-1)?.errorCode ?? '', /模拟失败/)
})

test('url 含 failonce 首次失败后重提交成功', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/failonce.zip', dir: 'd' })
  ticks[0]()
  assert.equal(frames.at(-1)?.status, 'error')

  await engine.addUri({ url: 'http://x/failonce.zip', dir: 'd' })
  ticks[1]()
  ticks[1]()
  ticks[1]()

  assert.equal(frames.at(-1)?.status, 'completed')
})

test('url 含 slow 使用更小步进保持 downloading', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 80, stepBytes: 16, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/slow-file.zip', dir: 'd' })
  ticks[0]()

  assert.equal(frames.at(-1)?.status, 'downloading')
  assert.equal(frames.at(-1)?.downloadedBytes, 2)
})

test('url 含 video:下载序列经 processing 后处理再 completed(spec §4.5)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/video-clip', dir: 'd' })

  // 驱动到结束(completed 后引擎自清,多余 tick 不再产生帧)
  for (let i = 0; i < 10 && frames.at(-1)?.status !== 'completed'; i++) {
    ticks[0]()
  }

  // 末帧 completed,下载满
  assert.equal(frames.at(-1)?.status, 'completed')
  assert.equal(frames.at(-1)?.downloadedBytes, 30)
  // 下载阶段帧带 phase:'downloading'(归一进度,区别 aria2 的 undefined)
  assert.ok(frames.some((f) => f.status === 'downloading' && f.phase === 'downloading'))
  // 后处理:出现 phase:'processing' 帧(status 仍 downloading、speed 归零),且在 completed 之前
  const procIdx = frames.findIndex((f) => f.phase === 'processing')
  const doneIdx = frames.findIndex((f) => f.status === 'completed')
  assert.ok(procIdx >= 0, '应出现 processing 帧')
  assert.equal(frames[procIdx]?.speed, 0)
  assert.equal(frames[procIdx]?.status, 'downloading')
  assert.ok(procIdx < doneIdx, 'processing 应在 completed 之前')
})

test('input.video 提交即触发视频态(TaskManager 出队带 VideoSubmit)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  // url 不含 video 关键字,但带 video(VideoSubmit)→ 仍走视频后处理序列
  await engine.addUri({
    url: 'http://x/clip',
    dir: 'd',
    video: { formatSelector: 'best', audioOnly: false }
  })

  for (let i = 0; i < 10 && frames.at(-1)?.status !== 'completed'; i++) {
    ticks[0]()
  }

  assert.equal(frames.at(-1)?.status, 'completed')
  assert.ok(frames.some((f) => f.phase === 'processing'))
})

test('url 不含 video:下载帧不带 phase(不污染 aria2 契约)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/file.zip', dir: 'd' })
  ticks[0]()

  assert.equal(frames.at(-1)?.status, 'downloading')
  assert.equal(frames.at(-1)?.phase, undefined)

  ticks[0]()
  ticks[0]()
  assert.equal(frames.at(-1)?.status, 'completed')
})

test('限速 no-op(v0.2 Task 2 · spec §6.6):接受 getSpeedLimit 注入,setGlobalLimit / setTaskLimit 不真限速、不抛', async () => {
  // 接同签名注入(dev 忽略值);setGlobalLimit / setTaskLimit no-op 可调用不抛
  const engine = new FakeEngine({ getSpeedLimit: () => 500 })
  await engine.setGlobalLimit(500)
  await engine.setTaskLimit('fake_1', 256)
  assert.ok(true, 'fake 限速方法 no-op 不抛(dev:fake 可交互手测)')
})

// ============ BT 帧序(v0.3 Task 1 · spec §9:元数据帧 → torrentInfo 帧 → 整包下载 → completed)============

test('input.torrent:元数据帧(无 torrentInfo)→ 一帧 torrentInfo → 整包下载 → completed(spec §9)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({
    url: 'magnet:?xt=urn:btih:abc',
    dir: 'd',
    torrent: { source: 'magnet' }
  })

  for (let i = 0; i < 12 && frames.at(-1)?.status !== 'completed'; i++) {
    ticks[0]()
  }

  // 帧序:前 2 帧元数据(downloading、无 torrentInfo、done=0)→ 第 3 帧带 torrentInfo → 推进 → completed
  assert.equal(frames[0]?.status, 'downloading')
  assert.equal(frames[0]?.torrentInfo, undefined, '元数据帧不含 torrentInfo(Task 侧保持 resolving)')
  assert.equal(frames[0]?.downloadedBytes, 0)
  assert.equal(frames[1]?.torrentInfo, undefined)

  const infoIdx = frames.findIndex((f) => f.torrentInfo)
  assert.equal(infoIdx, 2, '元数据帧耗尽后第一帧带 torrentInfo')
  assert.equal(frames[infoIdx]?.torrentInfo?.name, 'Fake Torrent')
  assert.equal(frames[infoIdx]?.torrentInfo?.totalBytes, 30)
  assert.equal(frames[infoIdx]?.torrentInfo?.files.length, 3, 'v0.3 Task 2:默认多文件(≥3,触发待选)')
  assert.equal(
    frames[infoIdx]?.torrentInfo?.files.every((f) => f.selected),
    true,
    '初始全选(默认整包,待选前)'
  )
  assert.equal(frames.filter((f) => f.torrentInfo).length, 1, 'torrentInfo 只发一次')

  const doneIdx = frames.findIndex((f) => f.status === 'completed')
  assert.ok(doneIdx > infoIdx, 'completed 在 torrentInfo 之后')
  assert.equal(frames.at(-1)?.downloadedBytes, 30, '整包下载满(无 awaitSelection → 不暂停待选)')
  assert.equal(
    frames.some((f) => f.phase !== undefined),
    false,
    'BT 帧不带 video phase'
  )
})

test('url 为 magnet(dev 直触,无 torrent 标记)同样走 BT 帧序(spec §9)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'magnet:?xt=urn:btih:def&dn=x', dir: 'd' })

  for (let i = 0; i < 10 && frames.at(-1)?.status !== 'completed'; i++) {
    ticks[0]()
  }

  assert.ok(
    frames.some((f) => f.torrentInfo),
    'magnet url 触发 BT 分支(含 torrentInfo 帧)'
  )
  assert.equal(frames.at(-1)?.status, 'completed')
})

test('http 任务不受 BT 分支影响:无 torrentInfo 帧(零回归)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []

  engine.onProgress((progress) => frames.push(progress))

  await engine.start()
  await engine.addUri({ url: 'http://x/file.zip', dir: 'd' })
  ticks[0]()
  ticks[0]()

  assert.equal(
    frames.some((f) => f.torrentInfo),
    false
  )
  assert.equal(frames.at(-1)?.status, 'completed')
})

// ============ BT await 文件选择(v0.3 Task 2 · spec §9.3:多文件待选 → 暂停 → resume 续下 / 单文件豁免)============

test('torrent.awaitSelection:多文件 torrentInfo 后暂停(btPaused,模拟 pause-metadata),resume 后续推进 → completed', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 30, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  await engine.start()
  const id = await engine.addUri({
    url: 'magnet:?xt=urn:btih:multi',
    dir: 'd',
    torrent: { source: 'magnet', awaitSelection: true }
  })

  ticks[0]() // 元数据帧 1
  ticks[0]() // 元数据帧 2
  ticks[0]() // torrentInfo(多文件)→ 之后 btPaused
  const infoFrame = frames.find((f) => f.torrentInfo)
  assert.equal(infoFrame?.torrentInfo?.files.length, 3, '多文件(≥3)')

  // 暂停:后续 tick 不推进(done 停在 0)
  const framesBefore = frames.length
  ticks[0]()
  ticks[0]()
  assert.equal(frames.length, framesBefore, 'btPaused 期间不再产生进度帧(模拟 pause-metadata)')
  assert.equal(frames.at(-1)?.downloadedBytes, 0, '选前 done 不推进')

  // resume(unpause)→ 续推进到 completed
  await engine.resume(id)
  for (let i = 0; i < 6 && frames.at(-1)?.status !== 'completed'; i++) {
    ticks[0]()
  }
  assert.equal(frames.at(-1)?.status, 'completed', 'resume 后整包下载满 → completed')
  assert.equal(frames.at(-1)?.downloadedBytes, 30)
})

test('torrent.awaitSelection:url 含 single → 单文件 torrentInfo(豁免路径,§2.2)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  await engine.start()
  await engine.addUri({
    url: 'magnet:?xt=urn:btih:single01',
    dir: 'd',
    torrent: { source: 'magnet', awaitSelection: true }
  })
  ticks[0]()
  ticks[0]()
  ticks[0]() // torrentInfo(单文件)
  const infoFrame = frames.find((f) => f.torrentInfo)
  assert.equal(infoFrame?.torrentInfo?.files.length, 1, 'url 含 single → 单文件')
  assert.equal(infoFrame?.torrentInfo?.files[0]?.path, 'Fake Single/movie.mkv')
})

test('applyTorrentSelection:记录 arg(供集成断言;dev no-op 不真过滤字节)', async () => {
  const engine = new FakeEngine()
  await engine.applyTorrentSelection('fake_1', '1,3')
  await engine.applyTorrentSelection('fake_2', null)
  assert.deepEqual(engine.applyTorrentSelectionCalls, [
    { id: 'fake_1', arg: '1,3' },
    { id: 'fake_2', arg: null }
  ])
})

// ============ BT 做种(v0.3 Task 3:开档下载满 → seeding 帧 → 帧耗尽 / stopSeeding → completed)============

test('做种关档(默认,未注入 getSeedConfig):torrent 下载满即 completed,无 seeding 帧(零回归)', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine(deps)
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  await engine.start()
  await engine.addUri({
    url: 'magnet:?xt=urn:btih:seed01',
    dir: 'd',
    torrent: { source: 'magnet' }
  })
  for (let i = 0; i < 15 && frames.at(-1)?.status !== 'completed'; i++) ticks[0]()

  assert.equal(frames.at(-1)?.status, 'completed')
  assert.equal(
    frames.some((f) => f.seeding),
    false,
    '关档无 seeding 帧'
  )
})

test('做种开档:torrent 下载满 → seeding 帧(seeding:true + 上行 / numSeeders,downloadSpeed=0)→ 帧耗尽 completed', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine({
    ...deps,
    getSeedConfig: () => ({ enabled: true, ratio: 1, timeMin: 60 })
  })
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  await engine.start()
  await engine.addUri({
    url: 'magnet:?xt=urn:btih:seed01',
    dir: 'd',
    torrent: { source: 'magnet' }
  })
  for (let i = 0; i < 25 && frames.at(-1)?.status !== 'completed'; i++) ticks[0]()

  const seed = frames.find((f) => f.seeding)
  assert.ok(seed, '开档下载满后出现 seeding 帧')
  assert.equal(seed?.seeding, true)
  assert.equal(seed?.downloadedBytes, 20, 'seeding 帧 bytes 100%')
  assert.ok((seed?.uploadSpeed ?? 0) > 0, 'seeding 帧带 uploadSpeed(上行)')
  assert.equal(seed?.numSeeders, 3, 'seeding 帧带 numSeeders')
  assert.equal(seed?.speed, 0, 'seeding 帧 downloadSpeed 归零(只上行)')
  assert.equal(frames.at(-1)?.status, 'completed', '帧耗尽(模拟达 seed 条件自然停)→ completed')
})

test('stopSeeding(dev:fake):做种中调用 → 记调用 + 收尾 completed', async () => {
  const { ticks, deps } = createTimerDeps({ totalBytes: 20, stepBytes: 10, intervalMs: 100 })
  const engine = new FakeEngine({
    ...deps,
    getSeedConfig: () => ({ enabled: true, ratio: 1, timeMin: 60 })
  })
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  await engine.start()
  const id = await engine.addUri({
    url: 'magnet:?xt=urn:btih:seed01',
    dir: 'd',
    torrent: { source: 'magnet' }
  })
  // 驱动到首个 seeding 帧(做种中)
  for (let i = 0; i < 25 && !frames.some((f) => f.seeding); i++) ticks[0]()
  assert.ok(
    frames.some((f) => f.seeding),
    '已进入做种'
  )

  await engine.stopSeeding(id)
  assert.deepEqual(engine.stopSeedingCalls, [id], 'stopSeeding 记调用')
  assert.equal(frames.at(-1)?.status, 'completed', '停做种 → 收尾 completed')
})
