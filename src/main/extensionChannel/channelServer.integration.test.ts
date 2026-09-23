import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'

import { createChannelServer, type ChannelLogger } from './channelServer'
import { nodeHttpFactory } from './nodeHttpFactory'
import { validateChannelPort } from './portValidation'
import { ExtensionChannelService } from './extensionChannelService'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import type { ExtensionChannelStatus } from '../../shared/ipc'
import { EXTENSION_CHANNEL_MAX_BODY_BYTES } from '../../shared/extensionProtocol'

/**
 * 本地通道集成测试 I1–I12(v0.4 Task 3 · spec §7.2)。
 *
 * **不依赖真实外网**:起的是本机回环服务(`127.0.0.1` + `port: 0` 让 OS 分配随机空闲口,
 * 避免与开发机上真在跑的 52330 撞车),用 `node:http` / `node:net` 打**自己**。
 * 回环流量在内核内闭环:不 DNS、不出网卡、不经任何代理。
 */

const TOKEN = 'a'.repeat(64)
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const APP_VERSION = '0.4.0-test'

/** 静默 logger(除 I9 外的用例不关心日志) */
function silentLogger(): ChannelLogger {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

/** 捕获式 logger(I9:断言任何一行都不含 token / Origin 值 / body 原文) */
function capturingLogger(): ChannelLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m)
  }
}

function makeServer(
  overrides: {
    logger?: ChannelLogger
    token?: () => string
    now?: () => number
    onHandshake?: (version: string) => void
  } = {}
): ReturnType<typeof createChannelServer> {
  return createChannelServer({
    httpFactory: nodeHttpFactory,
    getToken: overrides.token ?? ((): string => TOKEN),
    now: overrides.now ?? ((): number => Date.now()),
    logger: overrides.logger ?? silentLogger(),
    handlers: {
      handshake: (payload) => {
        overrides.onHandshake?.(payload.extensionVersion)
        return { appVersion: APP_VERSION }
      },
      // v0.4 Task 4 起 ChannelHandlers 是四支、Task 5 五支、Task 6 七支。本文件测的是**服务层**
      // (三闸 / 体积 / 限速),与接管 / cookie 无关,故其余六支给最小占位 ——
      // 它们的行为由 channelDispatch.test.ts 与 cookieChannel.integration.test.ts 断言。
      downloadIntent: () => ({ taken: false }),
      takeoverGetConfig: () => ({ enabled: true, pausedUntil: null, paused: false }),
      takeoverSetPause: () => ({ enabled: true, pausedUntil: null, paused: false }),
    sniffAddSelected: () => ({ taken: false as const }),
    videoIntent: () => ({ taken: false as const }),
    cookieOffer: () => ({ accepted: false as const })
    }
  })
}

interface HttpReply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** 打一次真实 HTTP 请求(**`node:http` 不读任何代理环境变量**,回环直连) */
function post(
  port: number,
  options: {
    method?: string
    path?: string
    token?: string | null
    origin?: string | null
    body?: string
    extraHeaders?: Record<string, string>
  } = {}
): Promise<HttpReply> {
  const body = options.body ?? ''
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.extraHeaders }
  if (options.token !== null) headers['X-DownLord-Token'] = options.token ?? TOKEN
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN
  if (body.length > 0) headers['Content-Length'] = String(Buffer.byteLength(body))

  return new Promise<HttpReply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/channel',
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('请求超时')))
    if (body.length > 0) req.write(body)
    req.end()
  })
}

/** 合法握手信封 */
function helloBody(version = '0.4.0', protocolVersion: number | string = 3): string {
  return JSON.stringify({
    type: 'handshake',
    protocolVersion,
    payload: { extensionVersion: version }
  })
}

/** 取一个当下空闲的回环端口(`port: 0` 拿到后立刻释放) */
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

/** 探一个端口能否被 bind(用于挑「自己与 +1 都空闲」的端口对,避免 I6 假红) */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer()
    s.on('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/** 连一次某地址:成功 resolve `null`,失败 resolve 错误码 */
function tryConnect(host: string, port: number, timeoutMs = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const done = (code: string | null): void => {
      socket.destroy()
      resolve(code)
    }
    socket.setTimeout(timeoutMs, () => done('ETIMEDOUT'))
    socket.on('connect', () => done(null))
    socket.on('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message))
  })
}

const CONFIG_PATH = 'C:/userData/config/extensionChannel.json'

/** 装一个走**完整链路**(配置 → 起停 → 三闸 → 分发 → 连接态 → 广播)的 service,fs 与时钟全在内存 */
function makeService(logger: ChannelLogger = silentLogger()): {
  service: ExtensionChannelService
  files: Map<string, string>
  broadcasts: ExtensionChannelStatus[]
} {
  const files = new Map<string, string>()
  const store: JsonConfigStoreFs = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return files.get(p)!
    },
    writeFile: async (p, d) => {
      files.set(p, d)
    },
    rename: async (from, to) => {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    mkdir: async () => {}
  }

  const broadcasts: ExtensionChannelStatus[] = []
  let tokenSeq = 0
  const service = new ExtensionChannelService({
    httpFactory: nodeHttpFactory,
    store,
    configPath: CONFIG_PATH,
    generateToken: () => {
      tokenSeq += 1
      return String(tokenSeq).repeat(64).slice(0, 64)
    },
    now: () => Date.now(),
    appVersion: APP_VERSION,
    onStatusChanged: (s) => broadcasts.push(s),
    logger,
    sideload: {
      isPackaged: false,
      resourcesPath: 'C:/electron/resources',
      appPath: 'D:/Projects/DownLord',
      existsSync: () => true
    }
  })
  return { service, files, broadcasts }
}

// ─────────────────────────────────────────────────────────────────────────────

test('I1: 正确 token + Origin + 正确版本 → 200 / ok:true / payload.appVersion 为注入值', async () => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    assert.equal(started.state, 'listening')
    const reply = await post(started.actualPort!, { body: helloBody() })
    assert.equal(reply.status, 200)
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: true,
      protocolVersion: 3,
      payload: { appVersion: APP_VERSION }
    })
  } finally {
    await server.stop()
  }
})

test('I2: 错 token → 401,响应体**恰好** {ok:false,reason:"unauthorized"}(无多余字段)', async () => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    const reply = await post(started.actualPort!, { token: 'b'.repeat(64), body: helloBody() })
    assert.equal(reply.status, 401)
    const parsed = JSON.parse(reply.body) as Record<string, unknown>
    assert.deepStrictEqual(parsed, { ok: false, reason: 'unauthorized' })
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['ok', 'reason'],
      '不得泄漏是哪一闸拦的,也不得附带协议版本'
    )
  } finally {
    await server.stop()
  }
})

test('I3: 缺 Origin / 错 Origin → 拒(P2 阳性 → 闸③ 走原判据「缺 Origin 也拒」)', async () => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    const missing = await post(started.actualPort!, { origin: null, body: helloBody() })
    assert.equal(missing.status, 401)
    assert.deepStrictEqual(JSON.parse(missing.body), { ok: false, reason: 'unauthorized' })

    const bad = await post(started.actualPort!, { origin: 'https://evil.com', body: helloBody() })
    assert.equal(bad.status, 401)

    const spoofed = await post(started.actualPort!, {
      origin: 'https://evil.com/#chrome-extension://',
      body: helloBody()
    })
    assert.equal(spoofed.status, 401, 'startsWith 而非 includes')
  } finally {
    await server.stop()
  }
})

test('I4: OPTIONS /channel → 405 且响应头里**零个** access-control-allow-*', async () => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    const reply = await post(started.actualPort!, {
      method: 'OPTIONS',
      extraHeaders: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-downlord-token'
      }
    })
    assert.equal(reply.status, 405)
    const corsHeaders = Object.keys(reply.headers).filter((k) =>
      k.toLowerCase().startsWith('access-control-allow')
    )
    assert.deepStrictEqual(corsHeaders, [], `预检响应不得带任何放行头,实际:${corsHeaders.join()}`)
    assert.equal(reply.body, '', '非协议内请求一个字都不必回')

    // 正向对照:**成功**响应同样不带(闸② 要求「任何路径任何方法成功或失败都不回」)
    const ok = await post(started.actualPort!, { body: helloBody() })
    assert.deepStrictEqual(
      Object.keys(ok.headers).filter((k) => k.toLowerCase().startsWith('access-control-allow')),
      []
    )
  } finally {
    await server.stop()
  }
})

test('I5: body 超上限 —— ① content-length 声明超限 → 413 不读体;② 声明撒谎 → 超限处断连', async () => {
  const server = makeServer()
  const started = await server.start(0)
  const port = started.actualPort!
  try {
    // ① 声明 1e9:服务端在读 body 之前就拒。用裸 socket 手写请求头(不真发 body)。
    const declared = await new Promise<string>((resolve, reject) => {
      const socket: Socket = netConnect({ host: '127.0.0.1', port })
      let text = ''
      socket.setTimeout(5_000, () => {
        socket.destroy()
        reject(new Error('① 超时:服务端没有在读 body 前应答'))
      })
      socket.on('data', (c: Buffer) => {
        text += c.toString('utf8')
      })
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
      socket.write(
        `POST /channel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `X-DownLord-Token: ${TOKEN}\r\nOrigin: ${ORIGIN}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n`
      )
    })
    assert.match(declared, /^HTTP\/1\.1 413/, `期望 413,实际首行:${declared.split('\r\n')[0]}`)

    // ② content-length 撒谎为小值、实发 1MB:第二道(流式累计)在超限处 destroy 连接
    const truncated = await new Promise<boolean>((resolve, reject) => {
      const socket: Socket = netConnect({ host: '127.0.0.1', port })
      let closed = false
      socket.setTimeout(5_000, () => {
        socket.destroy()
        reject(new Error('② 超时:服务端没有断开超限连接'))
      })
      socket.on('close', () => {
        closed = true
        resolve(true)
      })
      socket.on('error', () => resolve(true)) // ECONNRESET 同样算「被断开」
      socket.write(
        `POST /channel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `X-DownLord-Token: ${TOKEN}\r\nOrigin: ${ORIGIN}\r\n` +
          `Content-Type: application/json\r\nContent-Length: 10\r\n\r\n`
      )
      const chunk = 'x'.repeat(64 * 1024)
      const pump = (): void => {
        for (let i = 0; i < 32 && !closed; i += 1) socket.write(chunk)
        if (!closed) setTimeout(pump, 10)
      }
      pump()
    })
    assert.equal(truncated, true, '实发 1MB 必须在累计超限处被断开')
  } finally {
    await server.stop()
  }
})

test('I6: 端口被占 → port_in_use + lastError EADDRINUSE,且**没有在 port+1 监听**(不顺延)', async () => {
  const port = await pickFreePort()
  const squatter = createNetServer()
  await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve))

  const server = makeServer()
  try {
    const started = await server.start(port)
    assert.equal(started.state, 'port_in_use')
    assert.equal(started.lastError, 'EADDRINUSE')
    assert.equal(started.actualPort, null, '服务根本没有监听任何端口')

    // ★ 不顺延、不扫描:port+1 上不许有**我们的**通道服务。
    // ⚠️ 判据不能只写「连不上」:开发机的动态端口范围可能被改到低位密集区
    // (本机实测起始 1024),port+1 随时可能被别的程序瞬时占用 —— 那不是我们顺延。
    // 故连得上时改打一次真握手:只有拿到本通道的 200 应答才算顺延。
    const code = await tryConnect('127.0.0.1', port + 1)
    if (code === null) {
      const probe = await post(port + 1, { body: helloBody() }).catch(() => null)
      const isOurChannel =
        probe !== null &&
        probe.status === 200 &&
        (JSON.parse(probe.body) as { ok?: boolean }).ok === true
      assert.equal(
        isOurChannel,
        false,
        `${port + 1} 上应答了本通道协议 → 服务顺延了,绝不允许`
      )
    } else {
      assert.equal(code, 'ECONNREFUSED', `${port + 1} 上应无监听,实际:${code}`)
    }
  } finally {
    await server.stop()
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  }
})

test('I7: 只绑回环 —— address 恒为 127.0.0.1,且从本机非回环 IPv4 连同一端口被拒', async (t) => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    assert.equal(started.actualAddress, '127.0.0.1', '绑定地址是字面量常量,不可配')

    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((info) => info.family === 'IPv4' && !info.internal)

    if (!external) {
      // ⚠️ 不假装通过:如实跳过并打印原因(spec §7.2 I7)
      t.skip('本机无非回环 IPv4 地址(无网卡 / 仅 IPv6),「从外面打不进来」这半条无法取证')
      return
    }

    const code = await tryConnect(external.address, started.actualPort!)
    assert.equal(
      code,
      'ECONNREFUSED',
      `从 ${external.address} 连回环服务应被内核拒绝,实际:${code}`
    )
  } finally {
    await server.stop()
  }
})

test('I8: 版本不匹配 → 409 + appProtocolVersion:3', async () => {
  const server = makeServer()
  const started = await server.start(0)
  try {
    // 旧扩展报 1(v0.4 Task 5 bump 到 2、Task 6 再 bump 到 3)—— 不尽力兼容,一律 409。
    // ⚠️ 这里的 `1` 是**刻意不同**的:它要的是「与本侧真源不等」,不是「上一个版本」。
    const reply = await post(started.actualPort!, { body: helloBody('0.4.0', 1) })
    assert.equal(reply.status, 409)
    assert.deepStrictEqual(JSON.parse(reply.body), {
      ok: false,
      reason: 'protocol_mismatch',
      appProtocolVersion: 3
    })
  } finally {
    await server.stop()
  }
})

test('I9: 日志红线 —— 任何一行都不含 token / Origin 值 / body 原文', async () => {
  // 走**完整链路**(service + 真 server):通道日志分散在两层(传输层的监听 / 鉴权失败 / 已关闭,
  // 业务层的握手成功),只测其中一层等于给另一层留了不设防的口子。
  const logger = capturingLogger()
  const { service } = makeService(logger)
  const port = await pickFreePort()
  const body = helloBody('0.4.0')
  let realToken = ''
  try {
    await service.init()
    const enabledStatus = await service.setConfig({ enabled: true, port })
    assert.equal(enabledStatus.service, 'listening', `前置:通道必须真的起来了(${enabledStatus.lastError})`)
    realToken = service.getConfig().token

    await post(port, { token: realToken, body }) // I1 成功路径
    await post(port, { token: 'b'.repeat(64), body }) // I2 失败路径
  } finally {
    await service.stop()
  }

  const joined = logger.lines.join('\n')
  assert.ok(logger.lines.length > 0, '至少应有监听 / 握手 / 鉴权失败 / 已关闭几行')
  assert.equal(joined.includes(realToken), false, '★ token 一个字符都不许进日志')
  assert.equal(
    joined.includes('b'.repeat(64)),
    false,
    '★ 错误的 token 同样不许记(它可能是用户手滑贴错的另一个真密钥)'
  )
  assert.equal(joined.includes(ORIGIN), false, '★ Origin 的值本身是「来源内容」,不许记')
  assert.equal(joined.includes(body), false, '★ 请求体原文不许记')
  assert.equal(joined.includes('"type":"handshake"'), false, '★ body 片段同样不许记')
  assert.equal(joined.includes('token_mismatch'), false, '内部诊断码只用于计数,不逐条落日志')

  // 该记的要记:聚合计数 + 对外原因码 + 扩展版本(非敏感,且诚实呈现需要它)
  assert.ok(
    logger.lines.some((l) => l.includes('鉴权失败 ×1') && l.includes('unauthorized')),
    `期望有聚合计数行,实际:\n${joined}`
  )
  assert.ok(
    logger.lines.some((l) => l.includes('握手成功') && l.includes('0.4.0')),
    `期望有握手成功行(带扩展版本),实际:\n${joined}`
  )
  assert.ok(logger.lines.some((l) => l.includes('监听中 127.0.0.1:')))
  assert.ok(logger.lines.some((l) => l.includes('已关闭')))
})

test('I10: 限速不误伤 —— 连打 21 次错 token 后 429,紧接着正确 token 仍 200', async () => {
  const server = makeServer()
  const started = await server.start(0)
  const port = started.actualPort!
  try {
    for (let i = 1; i <= 20; i += 1) {
      const reply = await post(port, { token: 'b'.repeat(64), body: helloBody() })
      assert.equal(reply.status, 401, `第 ${i} 次失败应是 401`)
    }
    const tripped = await post(port, { token: 'b'.repeat(64), body: helloBody() })
    assert.equal(tripped.status, 429, '第 21 次失败触发窗口限速')
    assert.deepStrictEqual(JSON.parse(tripped.body), { ok: false, reason: 'unauthorized' })

    // ★ 核心取舍:本机程序刷失败**挡不住**合法扩展
    const legit = await post(port, { body: helloBody() })
    assert.equal(legit.status, 200, '窗口触发期间正确 token 必须照常放行')
  } finally {
    await server.stop()
  }
})

test('I11: stop() 释放端口 —— 同端口可被重新 listen', async () => {
  const server = makeServer()
  const started = await server.start(0)
  const port = started.actualPort!
  await post(port, { body: helloBody() }) // 先跑一次真请求,确保有过连接
  await server.stop()

  const again = makeServer()
  const restarted = await again.start(port)
  try {
    assert.equal(restarted.state, 'listening', 'stop 后同端口必须能重新绑上')
    assert.equal(restarted.actualPort, port)
  } finally {
    await again.stop()
  }
})

test('I12: 握手刷新 lastActiveAt(unpaired → connected)+ 广播被调用;regenerateToken 后回落 unpaired', async () => {
  const { service, files, broadcasts } = makeService()
  const port = await pickFreePort()

  try {
    await service.init()
    assert.equal(service.getStatus().service, 'stopped', '默认关:init 后不监听')
    assert.equal(service.getStatus().link, 'unpaired')
    assert.ok(service.getConfig().token.length === 64, 'token 与「是否启用」无关,恒有值')

    // 开启 + 指定端口
    const status = await service.setConfig({ enabled: true, port })
    assert.equal(status.service, 'listening')
    assert.equal(status.port, port)
    assert.equal(status.link, 'unpaired', '刚起服务,还没人握手')

    // 真握手
    const reply = await post(port, { token: service.getConfig().token, body: helloBody('9.9.9') })
    assert.equal(reply.status, 200)

    const afterHandshake = service.getStatus()
    assert.equal(afterHandshake.link, 'connected')
    assert.ok(afterHandshake.lastHandshakeAt !== null)
    assert.ok(
      broadcasts.some((s) => s.link === 'connected'),
      '握手成功必须广播(状态栏 / 设置页即时跟上)'
    )

    // 重新生成 token → 清连接态 → 回落未配对;旧 token 当场失效
    const oldToken = service.getConfig().token
    const regenerated = await service.regenerateToken()
    assert.notEqual(regenerated.token, oldToken)
    assert.equal(service.getStatus().link, 'unpaired', '重新生成后状态立刻回落未配对')
    assert.equal(service.getStatus().lastHandshakeAt, null)

    const stale = await post(port, { token: oldToken, body: helloBody() })
    assert.equal(stale.status, 401, '旧配对码必须当场失效')
    const fresh = await post(port, { token: regenerated.token, body: helloBody() })
    assert.equal(fresh.status, 200, '新配对码即刻生效(token 每请求实时读,无需重启服务)')

    // ★ 落盘只有三个键(连接状态是运行时态)
    const onDisk = JSON.parse(files.get(CONFIG_PATH)!) as Record<string, unknown>
    assert.deepStrictEqual(Object.keys(onDisk).sort(), ['enabled', 'port', 'token'])

    // 关开关 → 服务停,端口释放
    const off = await service.setConfig({ enabled: false, port })
    assert.equal(off.service, 'stopped')
    assert.equal(await isPortFree(port), true, '关闭后端口必须真的释放')

    // 端口非法 → 整体不落盘,如实回 invalid_port
    const invalid = await service.setConfig({ enabled: true, port: 52305 })
    assert.equal(invalid.lastError, 'invalid_port:reserved_bt')
    assert.equal(service.getConfig().port, port, '非法端口不落盘,配置保持原样')
  } finally {
    await service.stop()
  }
})

test('体积常量与契约一致(两侧同一真源:服务端据此拒,扩展端据此不发)', () => {
  assert.equal(EXTENSION_CHANNEL_MAX_BODY_BYTES, 64 * 1024)
})
