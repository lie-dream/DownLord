/**
 * 暂借登录态的通道端到端集成测试 I-C4 / I-C5 / I-C6(v0.4 Task 6 · spec §8.2)。
 *
 * **起真服务 + 打真请求,不依赖外网**:`127.0.0.1` + `port: 0`(OS 分配随机空闲口,避免与
 * 开发机上真在跑的 52330 撞车),用 `node:http` 打**自己**。回环流量在内核内闭环。
 *
 * 链路是完整的:真 HTTP → `channelServer`(三闸)→ `dispatchChannelMessage`(版本 + 形状)
 * → `ExtensionChannelService`(校验 + 日志 + 广播)→ 真 `TakeoverService` / 真持有层。
 * 只有窗口 / 时钟 / `addTask` 是 fake(它们与本文件要证的三件事无关)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'

import { ExtensionChannelService } from './extensionChannelService'
import { nodeHttpFactory } from './nodeHttpFactory'
import { validateChannelPort } from './portValidation'
import type { ChannelLogger } from './channelServer'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import { TakeoverService, type TakeoverWindowHandle } from '../takeover/takeoverService'
import { cloneDefaultTakeoverConfig } from '../takeover/takeoverConfig'
import { createBorrowedCookieStore } from '../video/borrowedCookieStore'
import { EXTENSION_PROTOCOL_VERSION } from '../../shared/extensionProtocol'
import type { CookieSource } from '../../shared/ipc'

const TOKEN = 'c'.repeat(64)
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const T0 = 1_700_000_000_000

/**
 * ★ 两个**哨兵**:它们只出现在请求载荷里,绝不该出现在任何一行日志中(红线 R4)。
 * 取一眼可辨、不可能被别的东西碰巧包含的串。
 */
const SENTINEL_VALUE = 'SENTINEL-COOKIE-VALUE-9c1f'
const SENTINEL_DOMAIN = 'sentinel-site.example'
const PAGE_URL = `https://${SENTINEL_DOMAIN}/video/BV1x`

/** 取一个当下空闲的回环端口(`port: 0` 拿到后立刻释放)—— 避免与开发机上真在跑的 52330 撞车 */
async function pickFreePort(): Promise<number> {
  // OS 分配的临时端口可能落在通道端口校验拒绝的 BT / DHT 保留段 52301–52320
  //(validateChannelPort → reserved_bt,setConfig 不起服务;真 CI 的 runner 2026-09-23 撞到过),
  // 故只接受能通过校验的端口,连续 64 次都不行才放弃。
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createNetServer()
      s.on('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address()
        const picked = typeof addr === 'object' && addr !== null ? addr.port : 0
        s.close(() => resolve(picked))
      })
    })
    if (validateChannelPort(port).ok) return port
  }
  throw new Error('pickFreePort: 64 次取到的临时端口都被 validateChannelPort 拒绝')
}

/** 捕获式 logger —— I-C4 的全部证据就是这个数组 */
function capturingLogger(): ChannelLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m)
  }
}

/** 内存 fake fs(通道配置落盘;本文件不关心持久化) */
function memFs(): JsonConfigStoreFs {
  const files = new Map<string, string>()
  return {
    readFile: async (p) => {
      const text = files.get(p)
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    },
    writeFile: async (p, data) => void files.set(p, data),
    mkdir: async () => {},
    rename: async (from, to) => {
      const text = files.get(from)
      if (text !== undefined) {
        files.set(to, text)
        files.delete(from)
      }
    }
  }
}

function fakeWindow(): TakeoverWindowHandle {
  let destroyed = false
  return {
    send: () => {},
    showOnce: () => {},
    setContentHeight: () => {},
    close: () => void (destroyed = true),
    isDestroyed: () => destroyed,
    webContentsId: () => 101,
    onClosed: () => {}
  }
}

interface Harness {
  port: number
  logs: string[]
  borrowedHosts: () => string[]
  stop(): Promise<void>
}

/** 起一套「真通道 + 真接管 + 真持有层」,回它的端口 */
async function startHarness(cookieSource: CookieSource): Promise<Harness> {
  const logger = capturingLogger()
  const borrowed = createBorrowedCookieStore()

  const takeover = new TakeoverService({
    now: () => T0,
    configStore: { read: async () => cloneDefaultTakeoverConfig(), write: async () => {} },
    onConfigChanged: () => {},
    scheduleTick: () => () => {},
    createWindow: fakeWindow,
    isAppReady: () => true,
    hasMainWindow: () => true,
    addTask: async () => 'task_1',
    onTaskCreated: () => {},
    onDuplicate: () => () => {},
    resolveDuplicate: async () => {},
    suggestFilename: (url) => url.split('/').pop() ?? 'download',
    getResolvedTheme: () => 'dark',
    getCookieSource: () => cookieSource,
    getBorrowedCookieHosts: () => borrowed.hosts(),
    // ⚠️ 接管侧与通道侧**共用同一个 logger 收集器**:红线要求的是「任何一行日志」,
    //    只扫通道那一半会漏掉接管路径写的行。
    logger
  })
  await takeover.init()
  takeover.start()

  const service = new ExtensionChannelService({
    httpFactory: nodeHttpFactory,
    store: memFs(),
    configPath: 'C:/fake/extensionChannel.json',
    generateToken: () => TOKEN,
    now: () => T0,
    appVersion: '0.4.0-test',
    logger,
    sideload: {
      isPackaged: false,
      resourcesPath: 'C:/fake',
      appPath: 'C:/fake',
      existsSync: () => true
    },
    takeover: {
      handleIntent: (payload) => takeover.handleIntent(payload),
      handleSniffSelected: (payload) => takeover.handleSniffSelected(payload),
      handleVideoIntent: (payload) => takeover.handleVideoIntent(payload),
      getConfigView: () => takeover.getConfigView(),
      setPause: (payload) => void takeover.setPause(payload)
    },
    borrowedCookies: borrowed,
    onBorrowedCookiesChanged: () => {}
  })
  await service.init()
  const status = await service.setConfig({ enabled: true, port: await pickFreePort() })
  assert.equal(status.service, 'listening', '前置:通道必须真的起来了')

  return {
    port: status.port,
    logs: logger.lines,
    borrowedHosts: () => borrowed.hosts(),
    stop: async () => {
      takeover.stop()
      await service.stop()
    }
  }
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

/** 打一次真实 HTTP(`node:http` 不读任何代理环境变量,回环直连) */
function post(port: number, envelope: unknown): Promise<Reply> {
  const body = JSON.stringify(envelope)
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/channel',
        headers: {
          'Content-Type': 'application/json',
          'X-DownLord-Token': TOKEN,
          Origin: ORIGIN,
          'Content-Length': String(Buffer.byteLength(body))
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          })
        )
      }
    )
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('请求超时')))
    req.write(body)
    req.end()
  })
}

/** 一条形状合法的 offer(值是哨兵) */
function offerEnvelope(domain = SENTINEL_DOMAIN, protocolVersion = EXTENSION_PROTOCOL_VERSION): {
  type: string
  protocolVersion: number
  payload: unknown
} {
  return {
    type: 'cookie.offer',
    protocolVersion,
    payload: {
      domain,
      cookies: [
        {
          name: 'SESSDATA',
          value: SENTINEL_VALUE,
          domain: `.${SENTINEL_DOMAIN}`,
          path: '/',
          expires: 1_800_000_000,
          secure: true,
          httpOnly: true
        }
      ]
    }
  }
}

// ── I-C5:甲路径端到端 ───────────────────────────────────────────────────────

test('I-C5 ★ 真 video.intent → 应答含 needCookieFor → 真 cookie.offer → accepted → 持有层有该域', async () => {
  const h = await startHarness('extension')
  try {
    // ① 甲路径:popup 点「用 DownLord 下载此页视频」
    const intent = await post(h.port, {
      type: 'video.intent',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: { pageUrl: PAGE_URL, userAgent: 'UA/1.0' }
    })
    assert.equal(intent.status, 200)
    assert.deepStrictEqual(intent.body, {
      ok: true,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      // ★ 受理 + 点名:上界 1(甲路径只有 pageUrl 一个 URL)
      payload: { taken: true, needCookieFor: [SENTINEL_DOMAIN] }
    })

    // 前置:此刻持有层还是空的 —— cookie 是在受理之后才来的(spec §2.5 的时序巧合)
    assert.deepStrictEqual(h.borrowedHosts(), [])

    // ② 扩展按点名给予
    const offer = await post(h.port, offerEnvelope())
    assert.equal(offer.status, 200)
    assert.deepStrictEqual(offer.body, {
      ok: true,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      // 🔴 零回显:应答里除了 accepted 什么都没有
      payload: { accepted: true }
    })

    // ③ 落到持有层(纯内存)
    assert.deepStrictEqual(h.borrowedHosts(), [SENTINEL_DOMAIN])
  } finally {
    await h.stop()
  }
})

test('I-C5 附:协议版本 2(Task 5 那一版)打两个新 type → 409,且持有层一个字节都没进', async () => {
  const h = await startHarness('extension')
  try {
    const intent = await post(h.port, {
      type: 'video.intent',
      protocolVersion: 2,
      payload: { pageUrl: PAGE_URL }
    })
    assert.equal(intent.status, 409)
    assert.deepStrictEqual(intent.body, {
      ok: false,
      reason: 'protocol_mismatch',
      appProtocolVersion: EXTENSION_PROTOCOL_VERSION
    })

    const offer = await post(h.port, offerEnvelope(SENTINEL_DOMAIN, 2))
    assert.equal(offer.status, 409)
    assert.deepStrictEqual(h.borrowedHosts(), [], '★ 版本不符时 handler 根本没被调用')
  } finally {
    await h.stop()
  }
})

test('I-C5 附:offer 的 domain 不是裸 host / cookie 项字段不全 → accepted:false,不写持有层', async () => {
  const h = await startHarness('extension')
  try {
    for (const domain of [
      'https://a.example', // 带 scheme
      'a.example/path', // 带 path
      'a.example:8080', // 带端口
      'u:p@a.example', // 带凭据
      '' // 空
    ]) {
      const reply = await post(h.port, offerEnvelope(domain))
      assert.deepStrictEqual(reply.body, {
        ok: true,
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        payload: { accepted: false }
      }, `应拒:${domain}`)
    }
    assert.deepStrictEqual(h.borrowedHosts(), [])

    // 逐项校验:唯一一条 cookie 缺 `secure` → 被丢掉 → 一条不剩 → 不写持有层(不谎报「借到了」)
    const broken = await post(h.port, {
      type: 'cookie.offer',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: {
        domain: SENTINEL_DOMAIN,
        cookies: [{ name: 'a', value: SENTINEL_VALUE, domain: SENTINEL_DOMAIN, path: '/' }]
      }
    })
    assert.deepStrictEqual(broken.body, {
      ok: true,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: { accepted: false }
    })
    assert.deepStrictEqual(h.borrowedHosts(), [])
  } finally {
    await h.stop()
  }
})

// ── I-C6:直链路径永不点名 ───────────────────────────────────────────────────

test('I-C6 ★ download.intent 的应答**永不含 needCookieFor** —— 直链带 cookie 本版不做', async () => {
  // ⚠️ 前置刻意选**第四档**:如果这一条在别的档位下测,它证明的只是「档位闸门有效」,
  //    而不是「直链路径根本没有那个写入点」。
  const h = await startHarness('extension')
  try {
    const reply = await post(h.port, {
      type: 'download.intent',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: {
        url: `https://${SENTINEL_DOMAIN}/dl/setup.exe`,
        referrer: PAGE_URL,
        danger: 'safe',
        totalBytes: 1024,
        userAgent: 'UA/1.0'
      }
    })
    assert.equal(reply.status, 200)
    assert.deepStrictEqual(reply.body, {
      ok: true,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: { taken: true }
    })

    // 对照:同一套服务、同一个 host,甲路径**是**带点名的 —— 证明上面那条不是因为档位没开
    const video = await post(h.port, {
      type: 'video.intent',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: { pageUrl: PAGE_URL }
    })
    const payload = video.body.payload as Record<string, unknown>
    assert.deepStrictEqual(payload.needCookieFor, [SENTINEL_DOMAIN])
  } finally {
    await h.stop()
  }
})

// ── I-C4:日志零 cookie 值、零域名 ───────────────────────────────────────────

/** 「任何一行都不含哨兵」—— 抽成函数,好让正向对照用**同一个**断言 */
function assertNoSentinel(lines: string[]): void {
  for (const line of lines) {
    assert.equal(line.includes(SENTINEL_VALUE), false, `日志含 cookie 值:${line}`)
    assert.equal(line.includes(SENTINEL_DOMAIN), false, `日志含域名:${line}`)
  }
}

test('I-C4 ★ 日志零 cookie 值 + 零域名(offer 成功 / offer 拒绝两条路径都扫)', async () => {
  const h = await startHarness('extension')
  try {
    // 成功路径:先点名再给予(点名那一步的应答里带域名,更容易被顺手记进日志)
    await post(h.port, {
      type: 'video.intent',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: { pageUrl: PAGE_URL, userAgent: 'UA/1.0' }
    })
    await post(h.port, offerEnvelope())
    // 拒绝路径
    await post(h.port, offerEnvelope('a.example/path'))

    assert.ok(h.logs.length > 0, '前置:得真有日志被写出来,否则「扫不到」毫无意义')
    // 正向:确实记了点东西(计数与原因码),不是因为整条链路一行都没打
    assert.ok(
      h.logs.some((l) => l.includes('cookie.offer 受理')),
      `应有受理行:${h.logs.join(' | ')}`
    )
    assert.ok(
      h.logs.some((l) => l.includes('cookie.offer 拒绝(原因码 invalid_domain)')),
      `应有拒绝行:${h.logs.join(' | ')}`
    )

    assertNoSentinel(h.logs)
  } finally {
    await h.stop()
  }
})

test('I-C4 正向对照 ★ 故意 log 一次哨兵 → 上面那个断言**必须**红(否则它是个假绿灯)', () => {
  // 「日志干净」与「断言写错了所以永远不红」输出一模一样 —— 这一条是区分二者的唯一办法。
  assert.throws(
    () => assertNoSentinel([`[extensionChannel][cookie] 受理 domain=${SENTINEL_DOMAIN}`]),
    /日志含域名/,
    '★ 扫描器对域名必须能红'
  )
  assert.throws(
    () => assertNoSentinel([`[extensionChannel][cookie] SESSDATA=${SENTINEL_VALUE}`]),
    /日志含 cookie 值/,
    '★ 扫描器对 cookie 值必须能红'
  )
})

test('I-C4 边界(如实标注,只报不改)★ 丙路径的 sniff host 是 Task 5 既有日志形态,第四档下仍会留痕', async () => {
  // ⚠️ 这条**不是**在给泄漏背书,而是把当前边界钉死并留给未来:
  // 甲路径(`video.intent`)是为第四档而生的,故本 Task 把它的 host 从日志里去掉了;
  // 丙路径(`sniff.addSelected`)是 Task 5 既有路径 —— 它在没选第四档时也照跑,host 记的是
  // 「用户点了这条资源」。**本 Step 不擅自改 Task 5 的既有行为**,但第四档开启时,
  // 那一行 host 确实构成「该域被借过」的间接痕迹。是否一并收敛,归用户裁决。
  const h = await startHarness('extension')
  try {
    await post(h.port, {
      type: 'sniff.addSelected',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      payload: {
        url: `https://${SENTINEL_DOMAIN}/hls/index.m3u8`,
        contentType: 'application/vnd.apple.mpegurl',
        referrer: PAGE_URL,
        userAgent: 'UA/1.0',
        totalBytes: -1
      }
    })
    assert.ok(
      h.logs.some((l) => l.includes('[takeover] sniff') && l.includes(SENTINEL_DOMAIN)),
      `边界已变化 —— 若丙路径也改成不记 host,请把本用例连同 §7.1 的 R4 断言一起更新:${h.logs.join(' | ')}`
    )
    // 而 cookie 值在任何路径下都**绝不**出现 —— 这一半没有例外
    for (const line of h.logs) {
      assert.equal(line.includes(SENTINEL_VALUE), false, `日志含 cookie 值:${line}`)
    }
  } finally {
    await h.stop()
  }
})
