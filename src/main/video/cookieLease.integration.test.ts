/**
 * 第四档「从扩展获取」的租约生命周期集成测试 I-C1 / I-C2 / I-C2b / I-C3 / I-C8
 * (v0.4 Task 6 · spec §4.4 / §4.6 / §6.2 / §8.2)。
 *
 * 🔴 **真 fs + 真临时目录(`mkdtempSync`),不用 fake fs** —— 「文件被删了」这句话只有真文件系统能证。
 *
 * 🔴 **每条删除断言都配正向对照**(spec §4.6):光断言「跑完之后不存在」是**假绿灯** ——
 * 一个**从来没创建过文件**的实现同样能通过。故:
 * - I-C1 同时断言 spawn **参数里**含 `--cookies <path>` **且此刻**文件真在;
 * - I-C2 的正向对照落在**注入的 `run` 回调体内** —— 这一条才真正证明「yt-dlp 需要它的那一刻它在」;
 * - I-C3 先在临时文件尚未删除时扫一次并断言**能命中**哨兵,再走完流程断言零命中
 *   (否则「扫不到」和「扫描器写错了」长得一模一样)。
 *
 * 除 fs 外只有子进程 / `ytdlpProcess.run` 是 fake(它们与本文件要证的事无关);
 * 持有层 / 租约 / Netscape 转换 / 参数组装 / 错误映射全部是**真件**,
 * 且 `leaseCookieFile` 与 `src/main/index.ts` 装配的是**同一个工厂函数**(不是照抄的抄件)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'

import { VideoEngine } from './videoEngine'
import { VideoResolver } from './videoResolver'
import { createBorrowedCookieStore, type BorrowedCookieStore } from './borrowedCookieStore'
import { createLeaseCookieFile } from './cookieLeaseFactory'
import { sweepCookieTempDir } from './cookieTempSweep'
import type { CookieLease } from './tempCookieFile'
import type { YtdlpProcess } from './ytdlpProcess'
import { ERR, toReadable } from '../errors/errorCatalog'
import type { AddUriInput, CookieConfig, DownloadProgress } from '../../shared/ipc'
import type { OfferedCookie } from '../../shared/extensionProtocol'

/**
 * ★ **哨兵**:只出现在暂借登录态里,绝不该在流程跑完后残留在 `<userData>` 的任何一个字节里(红线 R2 / R5)。
 * 取一眼可辨、不可能被别的东西碰巧包含的串。
 */
const SENTINEL_VALUE = 'SENTINEL-COOKIE-VALUE-7b3e'
const SENTINEL_HOST = 'sentinel-video.example'
const PAGE_URL = `https://${SENTINEL_HOST}/watch/BV1x`

/** 需要登录态的 stderr —— 命中既有优先级链里 login 那一格(改判的落点) */
const LOGIN_STDERR = 'ERROR: Sign in to confirm you are not a bot'

function cookieConfig(source: CookieConfig['source']): CookieConfig {
  return { source, browser: null, profile: null, file: null }
}

function sentinelCookies(): OfferedCookie[] {
  return [
    {
      name: 'SESSDATA',
      value: SENTINEL_VALUE,
      domain: `.${SENTINEL_HOST}`,
      path: '/',
      secure: true,
      httpOnly: true
    }
  ]
}

interface Fixture {
  /** 假 `<userData>` 根(真目录,测试结束整棵删掉) */
  userData: string
  cookieTmpDir: string
  store: BorrowedCookieStore
  leaseCookieFile: (hosts: string[]) => CookieLease | null
  /** 记录 `leaseCookieFile` 被调了几次(R10:非第四档恒 0) */
  leaseCalls: number
  cleanup(): void
}

/**
 * 建一个真临时 `<userData>`,并用**与 `index.ts` 完全相同的方式**接线租约工厂。
 * 顺带跑一次真 `sweepCookieTempDir`(它负责把 `cookies-tmp/` 建出来,与生产启动路径一致)。
 */
function createFixture(options: { withSentinel?: boolean } = {}): Fixture {
  const userData = mkdtempSync(join(tmpdir(), 'downlord-cookie-'))
  const cookieTmpDir = join(userData, 'cookies-tmp')
  sweepCookieTempDir({ existsSync, mkdirSync, readdirSync, rmSync }, cookieTmpDir)

  const store = createBorrowedCookieStore()
  if (options.withSentinel !== false) store.offer(SENTINEL_HOST, sentinelCookies())

  const fixture: Fixture = {
    userData,
    cookieTmpDir,
    store,
    leaseCalls: 0,
    leaseCookieFile: () => null, // 下面立刻替换成真件(先占位以满足类型)
    cleanup: () => rmSync(userData, { recursive: true, force: true })
  }

  const real = createLeaseCookieFile({
    store,
    fileDeps: { writeFileSync, rmSync, randomHex: (n) => randomBytes(n).toString('hex') },
    dir: cookieTmpDir
  })
  fixture.leaseCookieFile = (hosts) => {
    fixture.leaseCalls += 1
    return real(hosts)
  }
  return fixture
}

/** 递归扫 `<userData>` 全部文件,返回**内容里含哨兵**的相对路径(I-C3 的全部证据) */
function scanForSentinel(root: string): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (readFileSync(full, 'utf8').includes(SENTINEL_VALUE)) hits.push(relative(root, full))
    }
  }
  walk(root)
  return hits
}

// ========================= VideoEngine 侧脚手架 =========================

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill(signal?: string): boolean
}

function makeFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pid
  child.kill = () => {
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', null, 'SIGTERM')
    })
    return true
  }
  return child
}

interface EngineHarness {
  engine: VideoEngine
  children: FakeChild[]
  calls: Array<{ args: string[] }>
  events: DownloadProgress[]
}

function createEngine(
  fixture: Fixture,
  source: CookieConfig['source'],
  options: { linked?: boolean; accel?: boolean; injectLease?: boolean } = {}
): EngineHarness {
  const children: FakeChild[] = []
  const calls: Array<{ args: string[] }> = []
  let pid = 2000
  const spawn = ((_path: string, args: string[]) => {
    calls.push({ args })
    const child = makeFakeChild(++pid)
    children.push(child)
    return child
  }) as unknown as typeof import('child_process').spawn

  const engine = new VideoEngine(
    {
      spawn,
      treeKill: () => {},
      getCookie: () => cookieConfig(source),
      leaseCookieFile: options.injectLease === false ? undefined : fixture.leaseCookieFile,
      isExtensionLinked: () => options.linked === true,
      getVideoAccel: options.accel
        ? () => ({ enabled: true, aria2cPath: 'C:\\bin\\aria2c.exe' })
        : undefined,
      statSize: () => 100
    },
    {
      ytdlpPath: 'C:\\bin\\yt-dlp.exe',
      ffmpegPath: 'C:\\bin\\ffmpeg.exe',
      aria2cPath: 'C:\\bin\\aria2c.exe',
      defaultDir: join(fixture.userData, 'dl')
    }
  )
  const events: DownloadProgress[] = []
  engine.onProgress((p) => events.push(p))
  return { engine, children, calls, events }
}

const VIDEO_INPUT: AddUriInput = {
  url: PAGE_URL,
  dir: 'D:\\Downloads',
  filename: 'Sentinel Video.mp4',
  video: { formatSelector: '137+bestaudio/137', audioOnly: false, mergeFormat: 'mp4' }
}

/** 排空微任务:PassThrough 的 'data' 与 kill 的 close 都在微任务里投递 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 从 spawn 参数里取 `--cookies` 的值(没有 → null)。**从真实参数里读**,不从别处推断 */
function cookiesArgOf(args: string[]): string | null {
  const i = args.indexOf('--cookies')
  return i >= 0 ? args[i + 1] : null
}

// ========================= I-C1:下载路径 =========================

test('I-C1 ★ VideoEngine:close 之后临时 cookies.txt 不存在(正向对照:参数里有它、且此刻文件真在)', async () => {
  const fx = createFixture()
  try {
    const { engine, children, calls } = createEngine(fx, 'extension', { linked: true })
    await engine.addUri(VIDEO_INPUT)

    // ── 正向对照(同一用例内):没有这一半,一个**从来没创建过文件**的实现同样能通过 ──
    assert.equal(fx.leaseCalls, 1, '第四档 → 物化一次')
    const path = cookiesArgOf(calls[0].args)
    assert.ok(path, 'spawn 参数里含 --cookies <path>(与 file 档同形)')
    assert.equal(existsSync(path!), true, '★ yt-dlp 拿到参数的这一刻,文件真在磁盘上')
    assert.match(readFileSync(path!, 'utf8'), /# Netscape HTTP Cookie File/)
    assert.ok(readFileSync(path!, 'utf8').includes(SENTINEL_VALUE), '文件里确实是那份登录态')

    // ── 释放点①:close 最顶端 ──
    children[0].emit('close', 0, null)
    await tick()
    assert.equal(existsSync(path!), false, '★ close 之后文件不存在(用完即删)')
  } finally {
    fx.cleanup()
  }
})

test('I-C1b ★ 暂停(kill → close 顶端)同样删掉 —— 兑现「暂停期间磁盘上无文件」', async () => {
  const fx = createFixture()
  try {
    const { engine, calls } = createEngine(fx, 'extension', { linked: true })
    const id = await engine.addUri(VIDEO_INPUT)
    const path = cookiesArgOf(calls[0].args)
    assert.ok(path)
    assert.equal(existsSync(path!), true, '正向对照:暂停前它在')

    // 🔴 主动 kill 的 close 会在 `if (killed) return` 处提前返回 —— 释放若不在**最顶端**就漏删
    await engine.pause(id)
    await tick()
    assert.equal(existsSync(path!), false, '★ 暂停后磁盘上没有这份登录态')
  } finally {
    fx.cleanup()
  }
})

test('I-C1c ★ spawn 失败(ENOENT)走 error 分支同样删掉(该分支置 killed=true,close 会提前 return)', async () => {
  const fx = createFixture()
  try {
    const { engine, children, calls, events } = createEngine(fx, 'extension', { linked: true })
    await engine.addUri(VIDEO_INPUT)
    const path = cookiesArgOf(calls[0].args)
    assert.ok(path)
    assert.equal(existsSync(path!), true, '正向对照:spawn 失败前它在')

    // Node 先发 'error' 再发 'close';既有代码在 error 里置 killed=true → close 提前 return
    children[0].emit('error', new Error('spawn yt-dlp.exe ENOENT'))
    await tick()
    assert.equal(existsSync(path!), false, '★ error 分支已释放')
    children[0].emit('close', null, null) // 幂等:重复释放无副作用、不抛
    await tick()
    assert.equal(existsSync(path!), false)
    assert.ok(
      events.some((e) => e.status === 'error'),
      '错误事件照常发(释放不改变既有行为)'
    )
  } finally {
    fx.cleanup()
  }
})

test('I-C1d ★ aria2c 加速回退重起:旧租约先删、新租约另建一份(close 在重起之前跑)', async () => {
  const fx = createFixture()
  try {
    const { engine, children, calls } = createEngine(fx, 'extension', {
      linked: true,
      accel: true
    })
    await engine.addUri(VIDEO_INPUT)
    const first = cookiesArgOf(calls[0].args)
    assert.ok(first)
    assert.equal(existsSync(first!), true, '正向对照:第一次 spawn 的那份在')

    children[0].emit('close', 1, null) // 挂了 aria2c 的非零退出 → 回退重起
    await tick()

    assert.equal(calls.length, 2, '确实重起了一次(自带下载器)')
    const second = cookiesArgOf(calls[1].args)
    assert.ok(second)
    assert.notEqual(second, first, '每次 spawnFor 各建各的租约(同域并发各写各的)')
    assert.equal(existsSync(first!), false, '★ 旧租约已释放')
    assert.equal(existsSync(second!), true, '正向对照:新租约已就位')

    children[1].emit('close', 0, null)
    await tick()
    assert.equal(existsSync(second!), false, '★ 新租约随第二次 close 释放')
  } finally {
    fx.cleanup()
  }
})

test('I-C1e ★ R10 闸门:非第四档**从不调** leaseCookieFile,参数里也没有 --cookies', async () => {
  for (const source of ['none', 'browser', 'file'] as const) {
    const fx = createFixture()
    try {
      const { engine, children, calls } = createEngine(fx, source, { linked: true })
      await engine.addUri(VIDEO_INPUT)
      assert.equal(fx.leaseCalls, 0, `档位 ${source} → 物化回调一次都不该被调到`)
      assert.equal(cookiesArgOf(calls[0].args), null, `档位 ${source} → 无 --cookies`)
      assert.deepEqual(readdirSync(fx.cookieTmpDir), [], '专用目录里一个文件都没建')
      children[0].emit('close', 0, null)
      await tick()
    } finally {
      fx.cleanup()
    }
  }
})

// ========================= I-C2 / I-C2b:解析路径 =========================

const SINGLE_VIDEO_JSON = JSON.stringify({
  id: 'abc',
  title: 'Sentinel Video',
  extractor: 'generic',
  webpage_url: PAGE_URL,
  formats: [{ format_id: '18', ext: 'mp4', height: 360, acodec: 'mp4a.40.2', vcodec: 'avc1' }]
})

/**
 * 造一个真 `VideoResolver`,把注入的 `run` 变成**观察窗** ——
 * ★ I-C2 的正向对照就落在这个回调体内:它是「yt-dlp 需要这份文件的那一刻」的唯一等价物。
 */
function createResolver(
  fx: Fixture,
  source: CookieConfig['source'],
  onRun: (args: string[]) => { exitCode: number; stdout: string; stderr: string } | never,
  linked = true
): VideoResolver {
  const ytdlpProcess: YtdlpProcess = {
    async run(_path, args) {
      return onRun(args)
    }
  }
  return new VideoResolver(
    {
      ytdlpProcess,
      getCookie: () => cookieConfig(source),
      leaseCookieFile: fx.leaseCookieFile,
      isExtensionLinked: () => linked
    },
    { ytdlpPath: 'C:\\bin\\yt-dlp.exe' }
  )
}

test('I-C2 ★ VideoResolver:resolve() 返回后文件不存在(正向对照在 run 回调体内断言它此刻在)', async () => {
  const fx = createFixture()
  try {
    let seen: string | null = null
    let existedDuringRun: boolean | null = null
    const resolver = createResolver(fx, 'extension', (args) => {
      // ★ 正向对照:**yt-dlp 真正要用它的那一刻**
      seen = cookiesArgOf(args)
      existedDuringRun = seen ? existsSync(seen) : false
      return { exitCode: 0, stdout: SINGLE_VIDEO_JSON, stderr: '' }
    })

    const result = await resolver.resolve(PAGE_URL)
    assert.equal(result.kind, 'video')
    assert.ok(seen, 'run 参数里含 --cookies <path>')
    assert.equal(existedDuringRun, true, '★ run 执行期间文件在磁盘上')
    assert.equal(existsSync(seen!), false, '★ resolve 返回后文件不存在(finally 释放)')
  } finally {
    fx.cleanup()
  }
})

test('I-C2b ★ run 抛错时同样删掉(finally 路径 —— 只有 finally 能覆盖异常出口)', async () => {
  const fx = createFixture()
  try {
    let seen: string | null = null
    let existedDuringRun: boolean | null = null
    const resolver = createResolver(fx, 'extension', (args) => {
      seen = cookiesArgOf(args)
      existedDuringRun = seen ? existsSync(seen) : false
      throw new Error('boom: 进程层炸了')
    })

    await assert.rejects(() => resolver.resolve(PAGE_URL), /boom/)
    assert.ok(seen)
    assert.equal(existedDuringRun, true, '正向对照:抛错之前它在')
    assert.equal(existsSync(seen!), false, '★ 抛错后文件同样不存在')
  } finally {
    fx.cleanup()
  }
})

test('I-C2c 解析失败 + supplied → 错误文案是 STALE(不是「需要登录」那条死胡同)', async () => {
  const fx = createFixture()
  try {
    const resolver = createResolver(fx, 'extension', () => ({
      exitCode: 1,
      stdout: '',
      stderr: LOGIN_STDERR
    }))
    await assert.rejects(
      () => resolver.resolve(PAGE_URL),
      (err: Error) => {
        assert.equal(err.message, toReadable(ERR.COOKIE_EXTENSION_STALE))
        return true
      }
    )
  } finally {
    fx.cleanup()
  }
})

test('I-C2d 解析失败 + missing → NONE,且 `<域名>` 被真实 host 填上(域名唯一允许出现的地方:UI)', async () => {
  // 通道连着但持有层没有该域 → 不物化 → missing
  const fx = createFixture({ withSentinel: false })
  try {
    const resolver = createResolver(fx, 'extension', (args) => {
      assert.equal(cookiesArgOf(args), null, '没拿到登录态 → 参数里没有 --cookies')
      return { exitCode: 1, stdout: '', stderr: LOGIN_STDERR }
    })
    await assert.rejects(
      () => resolver.resolve(PAGE_URL),
      (err: Error) => {
        assert.ok(err.message.startsWith(`未取到 ${SENTINEL_HOST} 的登录态`), err.message)
        assert.doesNotMatch(err.message, /<域名>/, '占位必须被填掉,不能糊到用户脸上')
        return true
      }
    )
  } finally {
    fx.cleanup()
  }
})

// ========================= I-C3:落盘零 cookie =========================

test('I-C3 ★ 落盘零 cookie:跑完整第四档流程后扫 <userData> 全部文件,零命中哨兵', async () => {
  const fx = createFixture()
  try {
    // 造一份真实形态的 settings.json(第四档已选中)——「只记来源,绝不存内容」的被扫对象。
    // ⚠️ 反向探针 RP-7 的插入点就是这个文件:往里写哨兵 → 本用例必须变红。
    mkdirSync(join(fx.userData, 'config'), { recursive: true })
    writeFileSync(
      join(fx.userData, 'config', 'settings.json'),
      JSON.stringify(
        { video: { cookie: { source: 'extension', browser: null, profile: null, file: null } } },
        null,
        2
      ),
      'utf8'
    )

    const { engine, children, calls } = createEngine(fx, 'extension', { linked: true })
    await engine.addUri(VIDEO_INPUT)

    // ── ★ 第一次扫(临时文件尚未删除):**必须命中** ──
    // 没有这一半,「扫不到」和「扫描器写错了」长得一模一样。
    const during = scanForSentinel(fx.userData)
    assert.equal(
      during.length,
      1,
      `正向对照:此刻应恰好命中 1 个文件,实得 ${JSON.stringify(during)}`
    )
    assert.ok(during[0].startsWith('cookies-tmp'), '命中的正是那份一次性投影')

    // ── 走完流程 ──
    children[0].emit('close', 0, null)
    await tick()

    // ── 第二次扫:零命中 ──
    const after = scanForSentinel(fx.userData)
    assert.deepEqual(after, [], `<userData> 里不该再有任何一处哨兵,实得 ${JSON.stringify(after)}`)
    assert.deepEqual(readdirSync(fx.cookieTmpDir), [], '专用目录已空')
    // settings.json 只记来源不记内容(它仍在,只是不含哨兵)——顺带证明扫描器扫到了它
    assert.match(
      readFileSync(join(fx.userData, 'config', 'settings.json'), 'utf8'),
      /"source": "extension"/
    )
    void calls
  } finally {
    fx.cleanup()
  }
})

// ========================= I-C8:第四档 + 通道未启用 =========================

test('I-C8 ★ 第四档 + 通道未启用:参数与 none 档**逐字节相同**,失败时得到 NOT_PAIRED', async () => {
  const fx = createFixture({ withSentinel: false })
  try {
    // ① 第四档 + 通道未启用(linked:false,持有层也空)
    const ext = createEngine(fx, 'extension', { linked: false })
    await ext.engine.addUri(VIDEO_INPUT)
    // ② none 档(同一份输入、同一份配置)
    const none = createEngine(fx, 'none', { linked: false })
    await none.engine.addUri(VIDEO_INPUT)

    assert.deepStrictEqual(
      ext.calls[0].args,
      none.calls[0].args,
      '★ 逐字节相同 —— 选了第四档但没连上,不该让公开内容下不了'
    )
    assert.equal(cookiesArgOf(ext.calls[0].args), null)
    assert.deepEqual(readdirSync(fx.cookieTmpDir), [], '没物化任何文件')

    // ③ 真失败 → 错误文案指向「去配对」,而不是「去设置 → 视频 → Cookie 来源」那条死胡同
    ext.children[0].stderr.write(`${LOGIN_STDERR}\n`)
    await tick()
    ext.children[0].emit('close', 1, null)
    await tick()

    const failed = ext.events.find((e) => e.status === 'error')
    assert.ok(failed, '非零退出 → error 事件')
    assert.equal(failed!.errorCode, toReadable(ERR.COOKIE_EXTENSION_NOT_PAIRED))
    assert.match(failed!.errorCode!, /设置 → 浏览器扩展/)
  } finally {
    fx.cleanup()
  }
})

test('I-C8b 第四档 + 通道连着但没这个域 → 同样不物化,但失败文案是 NONE(两半的下一步不同)', async () => {
  const fx = createFixture({ withSentinel: false })
  try {
    const { engine, children, calls, events } = createEngine(fx, 'extension', { linked: true })
    await engine.addUri(VIDEO_INPUT)
    assert.equal(cookiesArgOf(calls[0].args), null)

    children[0].stderr.write(`${LOGIN_STDERR}\n`)
    await tick()
    children[0].emit('close', 1, null)
    await tick()

    const failed = events.find((e) => e.status === 'error')
    assert.ok(failed)
    assert.ok(failed!.errorCode!.startsWith(`未取到 ${SENTINEL_HOST} 的登录态`), failed!.errorCode)
    assert.match(failed!.errorCode!, /用扩展重新发起一次下载/)
  } finally {
    fx.cleanup()
  }
})

test('I-C8c 未注入 leaseCookieFile → 第四档也恒不物化,与改动前逐字节等价', async () => {
  const fx = createFixture()
  try {
    const withLease = createEngine(fx, 'extension', { linked: true })
    await withLease.engine.addUri(VIDEO_INPUT)
    const bare = createEngine(fx, 'none', { injectLease: false })
    await bare.engine.addUri(VIDEO_INPUT)
    const extBare = createEngine(fx, 'extension', { injectLease: false, linked: true })
    await extBare.engine.addUri(VIDEO_INPUT)

    assert.deepStrictEqual(extBare.calls[0].args, bare.calls[0].args, '未注入 → 与 none 档同参数')
    assert.notDeepStrictEqual(
      withLease.calls[0].args,
      bare.calls[0].args,
      '正向对照:注入了就**确实**多出 --cookies(否则上面那条全等是空对空)'
    )
    withLease.children[0].emit('close', 0, null)
    await tick()
  } finally {
    fx.cleanup()
  }
})

// ========================= #75:受限 www 别名的真实消费 =========================

test('#75 真 lease 双向借用 www 别名:保留实际 host / 原 domain,释放后删除', (t) => {
  for (const [offered, requested] of [
    ['www.' + SENTINEL_HOST, SENTINEL_HOST],
    [SENTINEL_HOST, 'www.' + SENTINEL_HOST]
  ]) {
    const fx = createFixture({ withSentinel: false })
    t.after(() => fx.cleanup())
    fx.store.offer(offered, [
      {
        name: 'hostOnly',
        value: 'host-value',
        domain: offered,
        path: '/',
        secure: true,
        httpOnly: true
      },
      {
        name: 'domain',
        value: 'domain-value',
        domain: '.' + SENTINEL_HOST,
        path: '/watch',
        secure: false,
        httpOnly: false
      }
    ])
    const lease = fx.leaseCookieFile([requested])
    assert.ok(lease, offered + ' -> ' + requested)
    assert.deepEqual(lease.hosts, [offered], '租约记录实际快照,不是请求的别名')
    assert.equal(existsSync(lease.path), true, '正向对照:释放前文件真实存在')
    assert.equal(
      readFileSync(lease.path, 'utf8'),
      '# Netscape HTTP Cookie File\n' +
        ['#HttpOnly_' + offered, 'FALSE', '/', 'TRUE', '0', 'hostOnly', 'host-value'].join('\t') +
        '\n' +
        ['.' + SENTINEL_HOST, 'TRUE', '/watch', 'FALSE', '0', 'domain', 'domain-value'].join('\t') +
        '\n',
      'hostOnly 与共享域逐列保留,不因别名改写 cookie.domain'
    )
    lease.release()
    assert.equal(existsSync(lease.path), false)
    assert.deepEqual(readdirSync(fx.cookieTmpDir), [])
  }
})

test('#75 VideoResolver 消费 www 快照:run 时文件在,返回后删除', async (t) => {
  const fx = createFixture({ withSentinel: false })
  t.after(() => fx.cleanup())
  fx.store.offer('www.' + SENTINEL_HOST, sentinelCookies())
  let seen: string | null = null
  const resolver = createResolver(fx, 'extension', (args) => {
    seen = cookiesArgOf(args)
    assert.ok(seen, '裸域任务消费 www 快照')
    assert.equal(existsSync(seen), true)
    assert.equal(
      readFileSync(seen, 'utf8'),
      '# Netscape HTTP Cookie File\n' +
        ['#HttpOnly_.' + SENTINEL_HOST, 'TRUE', '/', 'TRUE', '0', 'SESSDATA', SENTINEL_VALUE].join(
          '\t'
        ) +
        '\n'
    )
    return { exitCode: 0, stdout: SINGLE_VIDEO_JSON, stderr: '' }
  })
  assert.equal((await resolver.resolve(PAGE_URL)).kind, 'video')
  assert.ok(seen)
  assert.equal(existsSync(seen), false)
  assert.equal(fx.leaseCalls, 1)
})

test('#75 VideoResolver 别名已提供但登录失败仍为 STALE,失败后删文件', async (t) => {
  const fx = createFixture({ withSentinel: false })
  t.after(() => fx.cleanup())
  fx.store.offer('www.' + SENTINEL_HOST, sentinelCookies())
  let seen: string | null = null
  let existedDuringRun = false
  const resolver = createResolver(fx, 'extension', (args) => {
    seen = cookiesArgOf(args)
    existedDuringRun = seen !== null && existsSync(seen)
    return { exitCode: 1, stdout: '', stderr: LOGIN_STDERR }
  })
  await assert.rejects(
    () => resolver.resolve(PAGE_URL),
    (err: Error) => {
      assert.equal(err.message, toReadable(ERR.COOKIE_EXTENSION_STALE), '不能退化为未取到 NONE')
      return true
    }
  )
  assert.equal(existedDuringRun, true, '正向对照:报登录失败前真提供过文件')
  assert.ok(seen)
  assert.equal(existsSync(seen), false)
})

test('#75 VideoEngine 消费裸域快照:真 cookies 文件 / STALE / close 后释放', async (t) => {
  const fx = createFixture()
  t.after(() => fx.cleanup())
  const { engine, children, calls, events } = createEngine(fx, 'extension', { linked: true })
  await engine.addUri({ ...VIDEO_INPUT, url: 'https://www.' + SENTINEL_HOST + '/watch/BV1x' })
  const cookiePath = cookiesArgOf(calls[0].args)
  assert.ok(cookiePath, 'www 任务消费裸域快照')
  assert.equal(existsSync(cookiePath), true)
  assert.equal(
    readFileSync(cookiePath, 'utf8'),
    '# Netscape HTTP Cookie File\n' +
      ['#HttpOnly_.' + SENTINEL_HOST, 'TRUE', '/', 'TRUE', '0', 'SESSDATA', SENTINEL_VALUE].join(
        '\t'
      ) +
      '\n'
  )
  children[0].stderr.write(LOGIN_STDERR + '\n')
  await tick()
  children[0].emit('close', 1, null)
  await tick()
  const failed = events.find((e) => e.status === 'error')
  assert.ok(failed)
  assert.equal(failed.errorCode, toReadable(ERR.COOKIE_EXTENSION_STALE))
  assert.equal(existsSync(cookiePath), false, 'close 后删除,不扩大登录态持久化面')
})

test('#75 真 lease 越权与不同端口不物化,精确项与同端口 www 为正向对照', (t) => {
  for (const [offered, requested] of [
    ['a.github.io', 'b.github.io'],
    ['b.github.io', 'a.github.io'],
    ['sub.example.com', 'example.com'],
    ['example.com', 'sub.example.com'],
    ['www.example.com:8443', 'example.com:9443'],
    ['www.example.com:8443', 'example.com']
  ]) {
    const fx = createFixture({ withSentinel: false })
    t.after(() => fx.cleanup())
    fx.store.offer(offered, [
      {
        name: 'session',
        value: 'private',
        domain: '.' + SENTINEL_HOST,
        path: '/',
        secure: false,
        httpOnly: false
      }
    ])
    assert.equal(fx.leaseCookieFile([requested]), null, offered + ' -> ' + requested)
    assert.deepEqual(readdirSync(fx.cookieTmpDir), [], '负向对照:没有物化任何文件')
    const exact = fx.leaseCookieFile([offered])
    assert.ok(exact, '同一持有层的精确请求确实能物化,不是恒 null')
    assert.equal(existsSync(exact.path), true)
    exact.release()
    assert.equal(existsSync(exact.path), false)
  }
  const fx = createFixture({ withSentinel: false })
  t.after(() => fx.cleanup())
  fx.store.offer('www.example.com:8443', sentinelCookies())
  const samePort = fx.leaseCookieFile(['example.com:8443'])
  assert.ok(samePort, '同端口的 www 别名应命中')
  assert.deepEqual(samePort.hosts, ['www.example.com:8443'])
  assert.equal(existsSync(samePort.path), true)
  samePort.release()
  assert.equal(existsSync(samePort.path), false)
})
