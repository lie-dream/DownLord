/**
 * L3 · DownloadEngine 的错误与降级路径 —— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L3 层)。
 *
 * 既有 `downloadEngine.test.ts` 测的是**顺路**:代理注入、BT 选项、限速参数。本文件专测**逆路** ——
 * 引擎没起来 / 崩溃后死掉 / RPC 抛错 / 风暴超限,即那些只有 `catch` 块和早退分支才走得到的地方。
 * 之所以单独成文而不是往既有文件里加:那个文件一个断言都不许动(I-3),而这里要大量拨弄私有态。
 *
 * ⚠️ 为什么非测不可:只看行覆盖会系统性放过 `catch` 块(spec §1.5 的那条 ⚠️)。
 * 「崩溃风暴后对非终态任务发 error 终态」这条尤其 —— 它不发,用户看到的就是一排永远转圈的任务
 * (审计#8 记的正是这个「静默假死」),而**没有任何顺路断言会红**。
 *
 * 形态:纯 `*.test.ts`,不碰真 aria2c —— 私有 `rpcClient` / `child` 直接换成替身
 * (与既有 `makeCaptureEngine` 同一手法),故这些用例在无引擎的 CI 上也恒可跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import * as net from 'net'
import * as crypto from 'crypto'

import { DownloadEngine } from './downloadEngine'
import type { DownloadProgress } from '../../shared/ipc'

/** 引擎私有面的最小投影:只写下本文件真的要碰的那几个 */
interface EngineInternals {
  rpcClient: unknown
  child: unknown
  reviving: Promise<void> | null
  idToTask: Map<string, Record<string, unknown>>
  progressCache: Map<string, { downloadedBytes: number }>
  startAria2Internal(): Promise<void>
  ensurePolling(): void
  stopPolling(): void
  handleCrashStorm(msg: string): void
}

function makeEngine(): { engine: DownloadEngine; inner: EngineInternals } {
  const engine = new DownloadEngine(
    { aria2ProcessDeps: { spawn, net, crypto } },
    { aria2cPath: '/path/to/aria2c', defaultDir: '/tmp', pollInterval: 1_000_000 }
  )
  return { engine, inner: engine as unknown as EngineInternals }
}

/** 往内存任务表里塞一条,免得为了造前置条件去跑真 addUri */
function putTask(
  inner: EngineInternals,
  over: Record<string, unknown> & { id: string }
): void {
  inner.idToTask.set(over.id, {
    url: 'http://x',
    dir: '/d',
    status: 'downloading',
    desiredState: 'active',
    ...over
  })
}

// ==================== 未启动 / 前置校验 ====================

test('L3-eng-1 从未启动时 addUri 抛「DownloadEngine 未启动」(不是静默返回一个假 id)', async () => {
  const { engine } = makeEngine()
  await assert.rejects(() => engine.addUri({ url: 'http://x', dir: '/d' }), /DownloadEngine 未启动/)
})

test('L3-eng-2 pause / resume 的三条前置校验各自给出可区分的错误', async () => {
  const { engine, inner } = makeEngine()

  // ① 任务不存在
  await assert.rejects(() => engine.pause('nope'), /任务不存在: nope/)
  await assert.rejects(() => engine.resume('nope'), /任务不存在: nope/)

  // ② 任务在、但还没提交给 aria2(无 gid)
  putTask(inner, { id: 'nogid' })
  await assert.rejects(() => engine.pause('nogid'), /任务 nogid 尚未提交到 aria2/)
  await assert.rejects(() => engine.resume('nogid'), /任务 nogid 尚未提交到 aria2/)

  // ③ 任务与 gid 都在,但引擎没起来
  putTask(inner, { id: 'hasgid', gid: 'g1' })
  await assert.rejects(() => engine.pause('hasgid'), /DownloadEngine 未启动/)
  await assert.rejects(() => engine.resume('hasgid'), /DownloadEngine 未启动/)

  // 正向对照:把 rpcClient 换成替身后,同一次调用就通了 —— 证明上面三条抛的是各自那件事
  const calls: string[] = []
  inner.rpcClient = {
    async forcePause(gid: string) {
      calls.push(`forcePause:${gid}`)
    },
    async unpause(gid: string) {
      calls.push(`unpause:${gid}`)
    }
  }
  await engine.pause('hasgid')
  await engine.resume('hasgid')
  assert.deepEqual(calls, ['forcePause:g1', 'unpause:g1'])
  inner.stopPolling()
})

test('L3-eng-3 pause 走的是 forcePause 而不是优雅 pause(真机修订四:pause pending 窗口会顶掉 unpause)', async () => {
  const { engine, inner } = makeEngine()
  putTask(inner, { id: 't1', gid: 'g9' })
  const seen: string[] = []
  inner.rpcClient = {
    async forcePause(gid: string) {
      seen.push(`forcePause:${gid}`)
    },
    async pause(gid: string) {
      seen.push(`pause:${gid}`)
    }
  }
  await engine.pause('t1')
  assert.deepEqual(seen, ['forcePause:g9'], '只许调 forcePause;调优雅 pause 即回归那次真机故障')
  assert.equal(inner.idToTask.get('t1')?.desiredState, 'paused')
  assert.equal(inner.idToTask.get('t1')?.status, 'paused')
})

// ==================== 引擎复活单飞(崩溃后的手动分支)====================

test('L3-eng-4 死进程 + 并发两次 addUri → 只重启一次引擎(单飞,防双起)', async () => {
  const { engine, inner } = makeEngine()
  // 造「崩溃后未能自动恢复」的现场:child 指向已退出的进程,rpcClient 为空
  inner.child = { exitCode: 1, signalCode: null }
  inner.rpcClient = null

  let starts = 0
  let release = (): void => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  inner.startAria2Internal = async () => {
    starts += 1
    await gate // 卡住,好让两次 addUri 真正并发地撞在一起
    inner.rpcClient = {
      async addUri() {
        return 'gid_x'
      }
    }
    inner.child = { exitCode: null, signalCode: null }
  }

  const p1 = engine.addUri({ url: 'http://a', dir: '/d' })
  const p2 = engine.addUri({ url: 'http://b', dir: '/d' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(starts, 1, '两次并发 addUri 必须共享同一次 in-flight 重启')
  release()

  const ids = await Promise.all([p1, p2])
  assert.equal(starts, 1, '重启完成后仍应只有一次')
  assert.equal(new Set(ids).size, 2, '两次 addUri 各自拿到独立任务 id')
  assert.equal(inner.reviving, null, '单飞句柄用完必须清空,否则下次崩溃再也起不来')
  inner.stopPolling()
})

test('L3-eng-5 复活失败 → 错误抛给本次 addUri,且单飞句柄清空(下次还能再试)', async () => {
  const { engine, inner } = makeEngine()
  inner.child = { exitCode: 1, signalCode: null }
  inner.rpcClient = null

  let attempts = 0
  inner.startAria2Internal = async () => {
    attempts += 1
    throw new Error(`aria2c 二进制缺失(第 ${attempts} 次)`)
  }

  await assert.rejects(() => engine.addUri({ url: 'http://a', dir: '/d' }), /第 1 次/)
  assert.equal(inner.reviving, null, 'finally 必须清 reviving —— 不清就永远卡在第一次失败上')
  await assert.rejects(
    () => engine.addUri({ url: 'http://a', dir: '/d' }),
    /第 2 次/,
    '用户修好环境后必须还能再试一次(这正是这条复活缝存在的理由)'
  )
  assert.equal(attempts, 2)
})

test('L3-eng-6 从未启动(child === null)不自动拉起引擎,保持「未启动」原语义', async () => {
  const { engine, inner } = makeEngine()
  let starts = 0
  inner.startAria2Internal = async () => {
    starts += 1
  }
  await assert.rejects(() => engine.addUri({ url: 'http://a', dir: '/d' }), /DownloadEngine 未启动/)
  assert.equal(starts, 0, '没 start 过就不该被 addUri 悄悄拉起来')
})

// ==================== 崩溃风暴:非终态任务必须落 error ====================

test('L3-eng-7 崩溃风暴超限 → 非终态任务逐条发 error 帧(终态不重发),字节数取缓存不覆写成 0', () => {
  const { engine, inner } = makeEngine()
  const frames: DownloadProgress[] = []
  engine.onProgress((p) => frames.push(p))

  putTask(inner, { id: 'a', status: 'downloading' })
  putTask(inner, { id: 'b', status: 'paused' })
  putTask(inner, { id: 'c', status: 'completed' })
  putTask(inner, { id: 'd', status: 'error' })
  inner.progressCache.set('a', { downloadedBytes: 123456 })

  inner.handleCrashStorm('崩溃风暴超限')

  assert.deepEqual(
    frames.map((f) => f.id).sort(),
    ['a', 'b'],
    '只对非终态任务发 error;completed / error 不许重发(会把历史刷成重复错误)'
  )
  for (const f of frames) {
    assert.equal(f.status, 'error')
    assert.equal(f.errorCode, '崩溃风暴超限', '错误原因必须随帧带出,否则 UI 只能显「未知错误」')
  }
  assert.equal(
    frames.find((f) => f.id === 'a')?.downloadedBytes,
    123456,
    '已知进度必须保留 —— 覆写成 0 会把用户已下的字节数从库里抹掉'
  )
  assert.equal(frames.find((f) => f.id === 'b')?.downloadedBytes, 0, '无缓存则回 0')
  assert.equal(inner.idToTask.get('a')?.status, 'error', '内存态同步置 error')
  assert.equal(inner.idToTask.get('c')?.status, 'completed', '终态一个字不动')
})

// ==================== tracker 热应用:两件独立的事,互不中断 ====================

test('L3-eng-8 引擎未启动时 applyBtTrackers 诚实回全零,不抛、不假装成功', async () => {
  const { engine } = makeEngine()
  const r = await engine.applyBtTrackers(['udp://a:6969', 'udp://b:6969'])
  assert.deepEqual(r, { globalOk: false, patched: 0, failed: 0 })
})

test('L3-eng-9 changeGlobalOption 失败不中断追补:globalOk=false 但运行中任务照样逐个补', async () => {
  const { engine, inner } = makeEngine()
  const patched: Array<[string, unknown]> = []
  inner.rpcClient = {
    async changeGlobalOption() {
      throw new Error('rpc 拒绝')
    },
    async changeOption(gid: string, opts: unknown) {
      patched.push([gid, opts])
    }
  }
  putTask(inner, { id: 't1', gid: 'g1', isTorrent: true })
  putTask(inner, { id: 't2', gid: 'g2', isTorrent: true })
  putTask(inner, { id: 'http1', gid: 'g3' }) // 非 torrent:不补
  putTask(inner, { id: 'nogid', isTorrent: true }) // 无 gid:不补

  const r = await engine.applyBtTrackers(['udp://a:6969'])
  assert.equal(r.globalOk, false, '全局值失败要如实回报')
  assert.equal(r.patched, 2, '两件事互相独立:全局失败不许中断追补')
  assert.equal(r.failed, 0)
  assert.deepEqual(
    patched.map(([gid]) => gid),
    ['g1', 'g2'],
    '只补 torrent 且已有 gid 的任务'
  )
  assert.deepEqual(patched[0][1], { 'bt-tracker': 'udp://a:6969' })
})

test('L3-eng-10 单条追补失败只计 failed,不牵连其余任务', async () => {
  const { engine, inner } = makeEngine()
  inner.rpcClient = {
    async changeGlobalOption() {
      /* 成功 */
    },
    async changeOption(gid: string) {
      if (gid === 'bad') throw new Error('这条挂了')
    }
  }
  putTask(inner, { id: 't1', gid: 'ok1', isTorrent: true })
  putTask(inner, { id: 't2', gid: 'bad', isTorrent: true })
  putTask(inner, { id: 't3', gid: 'ok2', isTorrent: true })

  const r = await engine.applyBtTrackers(['udp://a:6969'])
  assert.deepEqual(r, { globalOk: true, patched: 2, failed: 1 })
})

test('L3-eng-11 setGlobalLimit / setTaskLimit 的 RPC 失败只记日志,绝不把异常抛给调用方', async () => {
  const { engine, inner } = makeEngine()
  inner.rpcClient = {
    async changeGlobalOption() {
      throw new Error('rpc 挂了')
    },
    async changeOption() {
      throw new Error('rpc 挂了')
    }
  }
  putTask(inner, { id: 't1', gid: 'g1' })

  // 不抛即通过:限速失败不该把「设置页保存」整条链炸掉(§7.1)
  await engine.setGlobalLimit(1024)
  await engine.setTaskLimit('t1', 512)

  // 正向对照:换成会成功的替身时,确实下发到了 RPC —— 否则上面两条在「根本没调用」时也绿
  const seen: string[] = []
  inner.rpcClient = {
    async changeGlobalOption(opts: Record<string, unknown>) {
      seen.push(`global:${JSON.stringify(opts)}`)
    },
    async changeOption(gid: string, opts: Record<string, unknown>) {
      seen.push(`task:${gid}:${JSON.stringify(opts)}`)
    }
  }
  await engine.setGlobalLimit(1024)
  await engine.setTaskLimit('t1', 512)
  assert.equal(seen.length, 2, '正向对照:两次调用都真的落到了 rpcClient 上')
})
