/**
 * 一次性端到端黑盒探针(v0.4 Task 3 功能验收 · 不入库、不进 npm test)。
 *
 * 与既有集成测试的区别:这里用**真实装配**——真 node:http + 真 fs(临时目录)+ 真 ExtensionChannelService,
 * 最后再用 node:vm 跑**真构建产物 extension/dist/sw.js** 对这个真服务打一次握手。
 * 跑法:node --import tsx scripts/verify/task3-e2e-probe.mts
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import vm from 'node:vm'

import { ExtensionChannelService } from '../../src/main/extensionChannel/extensionChannelService'
import { nodeChannelStoreFs } from '../../src/main/extensionChannel/nodeChannelStoreFs'
import { nodeHttpFactory } from '../../src/main/extensionChannel/nodeHttpFactory'

const EXT_ORIGIN = 'chrome-extension://joomlppocobhkaeinpcmkkbphnjmjiei'
const PORT = 52377 // 避开产品默认 52330 与 BT 段,防撞开发机上真在跑的服务

let passed = 0
let failed = 0
const logs: string[] = []

function check(id: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`ok   ${id}${detail ? ' — ' + detail : ''}`)
  } else {
    failed++
    console.log(`FAIL ${id}${detail ? ' — ' + detail : ''}`)
  }
}

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function req(opts: {
  port?: number
  method?: string
  path?: string
  token?: string | null
  origin?: string | null
  body?: string
  contentLength?: string
  extraHeaders?: Record<string, string>
}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token !== null && opts.token !== undefined) headers['X-DownLord-Token'] = opts.token
    if (opts.origin !== null && opts.origin !== undefined) headers['Origin'] = opts.origin
    if (opts.contentLength) headers['Content-Length'] = opts.contentLength
    Object.assign(headers, opts.extraHeaders ?? {})

    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port ?? PORT,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/channel',
        headers
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        )
      }
    )
    r.on('error', reject)
    if (opts.body !== undefined) r.write(opts.body)
    r.end()
  })
}

const envelope = (v = 1, type = 'handshake'): string =>
  JSON.stringify({ type, protocolVersion: v, payload: { extensionVersion: '0.3.0' } })

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dl-e2e-'))
  const configPath = join(dir, 'config', 'extensionChannel.json')

  const svc = new ExtensionChannelService({
    httpFactory: nodeHttpFactory,
    store: nodeChannelStoreFs,
    configPath,
    generateToken: () => randomBytes(32).toString('hex'),
    now: () => Date.now(),
    appVersion: '0.3.0',
    onStatusChanged: () => {},
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m)
    },
    sideload: {
      isPackaged: false,
      resourcesPath: '/fake/resources',
      appPath: process.cwd(),
      existsSync
    }
  })

  // ---------- A. 首启:默认关 + token 保障 + 键集合 ----------
  await svc.init()
  const cfg0 = svc.getConfig()
  const raw0 = JSON.parse(readFileSync(configPath, 'utf-8'))
  check('E-A1 首启即生成配置文件(不以启用为条件)', existsSync(configPath))
  check('E-A2 服务默认关', cfg0.enabled === false, `enabled=${cfg0.enabled}`)
  check('E-A3 默认端口 52330', cfg0.port === 52330, `port=${cfg0.port}`)
  check('E-A4 token 为 64 位小写 hex', /^[0-9a-f]{64}$/.test(cfg0.token))
  check(
    'E-A5 落盘键集合恰好 enabled/port/token',
    JSON.stringify(Object.keys(raw0).sort()) === '["enabled","port","token"]',
    Object.keys(raw0).sort().join(',')
  )

  await svc.start()
  check('E-A6 enabled:false 时 start() 是 no-op(不监听)', svc.getStatus().service === 'stopped')
  // ★ E-A7 只能是**条件断言**:52330 是产品默认端口,本机很可能正开着一个真 DownLord
  //   (手测时就是这个状态)。断言「整机 52330 上没有任何东西」是在断言机器状态、不是断言被测服务,
  //   那种判据一旦被别人占用就假红。故先探明占用者是谁,再决定断言还是如实跳过。
  const squatterOn52330 = await new Promise<'none' | 'downlord' | 'other'>((res) => {
    const probeReq = httpRequest(
      { host: '127.0.0.1', port: 52330, method: 'POST', path: '/channel', timeout: 2000 },
      (r) => {
        let b = ''
        r.on('data', (c) => (b += c))
        r.on('end', () =>
          res(b === '{"ok":false,"reason":"unauthorized"}' ? 'downlord' : 'other')
        )
      }
    )
    probeReq.on('error', () => res('none'))
    probeReq.on('timeout', () => { probeReq.destroy(); res('other') })
    probeReq.end('{}')
  })
  if (squatterOn52330 === 'none') {
    check('E-A7 默认关时 52330 上没有本服务在听', true, '52330 空闲,且本实例确实没去监听')
  } else {
    console.log(
      `skip E-A7 —— 本机 52330 已被${squatterOn52330 === 'downlord' ? '一个真 DownLord 实例' : '别的程序'}占用,` +
        '无法据此判定「本实例没在监听」(如实跳过,不假装通过;本实例的 stopped 态已由 E-A6 断言)'
    )
  }

  // ---------- B. 启用 + 三闸 ----------
  const st1 = await svc.setConfig({ enabled: true, port: PORT })
  check('E-B0 启用后进入 listening', st1.service === 'listening', `service=${st1.service}`)
  const token = svc.getConfig().token

  const r1 = await req({ token, origin: EXT_ORIGIN, body: envelope() })
  const j1 = JSON.parse(r1.body)
  check('E-B1 正确 token + Origin + 版本 → 200 / ok:true', r1.status === 200 && j1.ok === true)
  check('E-B1b 回 appVersion(注入值)', j1.payload?.appVersion === '0.3.0', JSON.stringify(j1.payload))

  const r2 = await req({ token: 'f'.repeat(64), origin: EXT_ORIGIN, body: envelope() })
  check('E-B2 错 token → 401', r2.status === 401)
  check('E-B2b 响应体恰好 {ok:false,reason:"unauthorized"} 无多余字段',
    r2.body === '{"ok":false,"reason":"unauthorized"}', r2.body)

  const r3 = await req({ token, origin: null, body: envelope() })
  check('E-B3 缺 Origin → 拒(P2 阳性,闸③ 走原判据)', r3.status === 401)

  const r4 = await req({ token, origin: 'https://evil.com', body: envelope() })
  check('E-B4 恶意 Origin → 拒', r4.status === 401)

  const r5 = await req({ token, origin: 'https://x/#chrome-extension://', body: envelope() })
  check('E-B5 前缀伪装(startsWith 而非 includes)→ 拒', r5.status === 401)

  const r6 = await req({ token, origin: 'chrome-extension://ANY_OTHER_ID', body: envelope() })
  check('E-B6 任意扩展 ID 前缀 → 放行(不做 ID 白名单)', r6.status === 200)

  // ---------- C. 闸② 预检 ----------
  const r7 = await req({ method: 'OPTIONS', token: null, origin: EXT_ORIGIN })
  const corsKeys = Object.keys(r7.headers).filter((k) =>
    k.toLowerCase().startsWith('access-control-allow')
  )
  check('E-C1 OPTIONS → 405', r7.status === 405, `status=${r7.status}`)
  check('E-C2 ★ 响应头里零个跨源放行头', corsKeys.length === 0, `命中:[${corsKeys.join(',')}]`)
  const r7b = await req({ token, origin: EXT_ORIGIN, body: envelope() })
  const corsKeys2 = Object.keys(r7b.headers).filter((k) =>
    k.toLowerCase().startsWith('access-control-allow')
  )
  check('E-C3 ★ 成功响应同样零个跨源放行头', corsKeys2.length === 0, `命中:[${corsKeys2.join(',')}]`)

  // ---------- D. 形状闸 + 体积 + 版本 ----------
  check('E-D1 GET /channel → 405', (await req({ method: 'GET', token, origin: EXT_ORIGIN })).status === 405)
  check('E-D2 POST /other → 404', (await req({ path: '/other', token, origin: EXT_ORIGIN, body: envelope() })).status === 404)

  const r8 = await req({ token, origin: EXT_ORIGIN, contentLength: '1000000000', body: 'x' })
  check('E-D3 content-length 声明超 64KB → 413', r8.status === 413, `status=${r8.status}`)

  let destroyed = false
  try {
    await req({ token, origin: EXT_ORIGIN, body: 'y'.repeat(1024 * 1024) })
  } catch {
    destroyed = true
  }
  check('E-D4 实发 1MB(声明撒谎)→ 服务在超限处断开连接', destroyed)

  const r9 = await req({ token, origin: EXT_ORIGIN, body: envelope(2) })
  const j9 = JSON.parse(r9.body)
  check('E-D5 protocolVersion:2 → 409 + appProtocolVersion:1',
    r9.status === 409 && j9.appProtocolVersion === 1, r9.body)

  const r10 = await req({ token, origin: EXT_ORIGIN, body: envelope(1, 'download.intent') })
  check('E-D6 未知 type → 拒(增长表外的 type 不静默降级)', r10.status === 409, `status=${r10.status}`)

  // ---------- F. 只绑回环 ----------
  const nonLoopback = Object.values(networkInterfaces())
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal)?.address
  if (!nonLoopback) {
    console.log('skip E-F1 —— 本机没有非回环 IPv4(如实跳过,不假装通过)')
  } else {
    // ★ 三种结局都要有明确输出:连上=FAIL / 被拒=PASS / 超时无响应=PASS(但标注是「无响应」而非「明确被拒」)
    const verdict = await new Promise<'connected' | 'refused' | 'timeout'>((res) => {
      const sock = connect({ host: nonLoopback, port: PORT })
      const done = (v: 'connected' | 'refused' | 'timeout'): void => { sock.destroy(); res(v) }
      sock.on('connect', () => done('connected'))
      sock.on('error', () => done('refused'))
      setTimeout(() => done('timeout'), 3000)
    })
    check(`E-F1 ★ 从本机非回环 IPv4(${nonLoopback}:${PORT})连不进来`, verdict !== 'connected',
      verdict === 'refused' ? '明确被拒(ECONNREFUSED)' : '3s 内无任何响应(被丢弃 —— 同样进不来,但不是明确拒绝)')
  }

  // ---------- G. 日志红线 ----------
  const originLeak = logs.filter((l) => l.includes(EXT_ORIGIN))
  const tokenLeak = logs.filter((l) => l.includes(token) || l.includes(token.slice(0, 8)))
  const bodyLeak = logs.filter((l) => l.includes('extensionVersion'))
  check('E-G1 日志不含 token(连前 8 位都不含)', tokenLeak.length === 0, tokenLeak.join(' | '))
  check('E-G2 日志不含 Origin 的值', originLeak.length === 0, originLeak.join(' | '))
  check('E-G3 日志不含 body 原文', bodyLeak.length === 0, bodyLeak.join(' | '))
  check('E-G4 有聚合计数行(鉴权失败 ×N)', logs.some((l) => /鉴权失败/.test(l)),
    logs.filter((l) => /鉴权失败/.test(l))[0] ?? '(无)')

  // ---------- H. 三态 + 重新生成 + 改端口 ----------
  check('E-H1 有过成功握手 → connected', svc.getStatus().link === 'connected', svc.getStatus().link)
  const newCfg = await svc.regenerateToken()
  check('E-H2 重新生成 token:值变了且仍 64hex', newCfg.token !== token && /^[0-9a-f]{64}$/.test(newCfg.token))
  check('E-H3 重新生成后连接态回落 unpaired', svc.getStatus().link === 'unpaired', svc.getStatus().link)
  check('E-H4 旧 token 立即失效 → 401',
    (await req({ token, origin: EXT_ORIGIN, body: envelope() })).status === 401)
  check('E-H5 新 token 可用 → 200',
    (await req({ token: newCfg.token, origin: EXT_ORIGIN, body: envelope() })).status === 200)
  check('E-H5b ★ 重新生成**不重启服务**(端口不抖动,仍 listening)',
    svc.getStatus().service === 'listening' && svc.getStatus().port === PORT, svc.getStatus().service)

  const PORT2 = PORT + 5
  const st2 = await svc.setConfig({ enabled: true, port: PORT2 })
  check('E-H6 改端口后在新端口监听', st2.service === 'listening' && st2.port === PORT2, `port=${st2.port}`)
  check('E-H7 ★ 改端口不改 token(不需重新配对)', svc.getConfig().token === newCfg.token)
  check('E-H8 新端口可用',
    (await req({ port: PORT2, token: newCfg.token, origin: EXT_ORIGIN, body: envelope() })).status === 200)
  let oldClosed = false
  try {
    await req({ port: PORT, token: newCfg.token, origin: EXT_ORIGIN, body: envelope() })
  } catch { oldClosed = true }
  check('E-H9 旧端口已释放', oldClosed)

  // ---------- I. 端口被占:不启动、不顺延 ----------
  await svc.setConfig({ enabled: false, port: PORT2 })
  const squatter = createServer(() => {})
  const BUSY = PORT + 11
  await new Promise<void>((res) => squatter.listen(BUSY, '127.0.0.1', res))
  const st3 = await svc.setConfig({ enabled: true, port: BUSY })
  check('E-I1 端口被占 → service=port_in_use', st3.service === 'port_in_use', `service=${st3.service}`)
  check('E-I2 lastError 如实报 EADDRINUSE', st3.lastError === 'EADDRINUSE', `lastError=${st3.lastError}`)
  let plus1Refused = false
  try {
    await req({ port: BUSY + 1, token: newCfg.token, origin: EXT_ORIGIN, body: envelope() })
  } catch { plus1Refused = true }
  check('E-I3 ★ 没有顺延到 port+1', plus1Refused)
  await new Promise<void>((res) => squatter.close(() => res()))

  // ---------- J. 关闭总开关 ----------
  await svc.setConfig({ enabled: true, port: PORT2 })
  const tokenFinal = svc.getConfig().token
  await svc.setConfig({ enabled: false, port: PORT2 })
  check('E-J1 关闭后 service=stopped', svc.getStatus().service === 'stopped')
  let closed = false
  try { await req({ port: PORT2, token: tokenFinal, origin: EXT_ORIGIN, body: envelope() }) } catch { closed = true }
  check('E-J2 关闭后端口已释放', closed)
  check('E-J3 ★ 关闭不清 token(配对码仍有效,重开即用)', svc.getConfig().token === tokenFinal)

  // ---------- E(挪到此处). 限速只作用于失败请求 ----------
  // ★ 刻意放在改端口之后:每次 stop→start 都是新 server / 新窗口,不污染前面的用例
  await svc.setConfig({ enabled: true, port: PORT2 })
  const tokenFinal2 = svc.getConfig().token
  for (let i = 0; i < 20; i++) await req({ port: PORT2, token: '0'.repeat(64), origin: EXT_ORIGIN, body: envelope() })
  const r11 = await req({ port: PORT2, token: '0'.repeat(64), origin: EXT_ORIGIN, body: envelope() })
  check('E-E1 连打 21 次错 token → 429', r11.status === 429, `status=${r11.status}`)
  const r12 = await req({ port: PORT2, token: tokenFinal2, origin: EXT_ORIGIN, body: envelope() })
  check('E-E2 ★ 限速期间正确 token 仍 200(不误伤合法扩展)', r12.status === 200, `status=${r12.status}`)


  // ---------- K. 全程结束后配置文件仍只有三个键 ----------
  const rawEnd = JSON.parse(readFileSync(configPath, 'utf-8'))
  check('E-K1 ★ 全程结束后落盘键集合仍恰好 enabled/port/token(连接态零泄漏)',
    JSON.stringify(Object.keys(rawEnd).sort()) === '["enabled","port","token"]',
    Object.keys(rawEnd).sort().join(','))

  // ---------- L. ★ 真产物 sw.js ↔ 真服务 端到端(含两条阴性对照)----------
  await svc.setConfig({ enabled: true, port: PORT2 })
  const liveToken = svc.getConfig().token
  const swPath = join(process.cwd(), 'extension', 'dist', 'sw.js')

  /** 在 vm 里跑真产物 sw.js,用给定配对触发 onStartup,回传它落进 storage 的握手结果 */
  async function runRealSw(
    pairing: { token: string; port: number } | null,
    opts: { withBrowserOrigin?: boolean } = {}
  ): Promise<{
    last: { reason?: string; appVersion?: string } | undefined
    wake: { count?: number; lastEvent?: string } | undefined
    registered: boolean
  }> {
    const store: Record<string, unknown> = {}
    if (pairing) store['downlord:pairing'] = pairing
    let startupCb: ((...a: unknown[]) => unknown) | null = null
    const fakeChrome = {
      runtime: {
        getManifest: () => ({ version: '0.3.0' }),
        id: 'joomlppocobhkaeinpcmkkbphnjmjiei',
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: (cb: (...a: unknown[]) => unknown) => { startupCb = cb } },
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve(undefined)
      },
      storage: {
        local: {
          get: (k: string) => Promise.resolve(k in store ? { [k]: store[k] } : {}),
          set: (o: Record<string, unknown>) => { Object.assign(store, o); return Promise.resolve() },
          remove: () => Promise.resolve()
        }
      }
    }
    // ★ node 的 fetch **不会**像浏览器那样自动加 Origin 头,而闸③ 要求它。
    //   P2 已在真 Edge 实测确认浏览器会加 `chrome-extension://<id>`,故这里用一层 wrapper **模拟浏览器行为**。
    //   这是探针的模拟,不是产品代码;withBrowserOrigin:false 则原样用 node fetch(用作闸③ 的阴性对照)。
    const fetchForSw: typeof globalThis.fetch = (url, init) => {
      if (!opts.withBrowserOrigin) return globalThis.fetch(url as string, init)
      const headers = { ...((init?.headers as Record<string, string>) ?? {}), Origin: EXT_ORIGIN }
      return globalThis.fetch(url as string, { ...init, headers })
    }
    const ctx = vm.createContext({
      chrome: fakeChrome,
      fetch: fetchForSw,
      // ★ 真浏览器 sw 里这些都是全局;vm 是空 realm,必须逐个注入。
      //   漏注入 AbortSignal 会让 fetchNet 抛 ReferenceError 并被归为 'unreachable' —— 假阴性。
      AbortSignal,
      AbortController,
      console, setTimeout, clearTimeout, TextEncoder, URL, Promise
    })
    vm.runInContext(readFileSync(swPath, 'utf-8'), ctx, { filename: 'sw.js' })
    const cb = startupCb as unknown as (() => unknown) | null
    const registered = typeof cb === 'function'
    if (cb) {
      await cb()
      await new Promise((r) => setTimeout(r, 800))
    }
    return {
      last: store['downlord:lastHandshake'] as { reason?: string; appVersion?: string } | undefined,
      wake: store['downlord:wakeState'] as { count?: number; lastEvent?: string } | undefined,
      registered
    }
  }

  if (!existsSync(swPath)) {
    console.log('skip E-L —— extension/dist/sw.js 不存在,先跑 npm run build')
  } else {
    // ★ 正向:真配对 → 真服务
    const tMark = Date.now()
    const ok = await runRealSw({ token: liveToken, port: PORT2 }, { withBrowserOrigin: true })
    check('E-L1 真产物 sw.js 在空 realm 里成功执行并注册 onStartup', ok.registered)
    check('E-L2 ★★ 真产物 sw 冷启动 → 真服务握手成功(reason=ok)', ok.last?.reason === 'ok', JSON.stringify(ok.last))
    check('E-L3 ★★ sw 拿到真服务回报的应用版本', ok.last?.appVersion === '0.3.0', JSON.stringify(ok.last))
    const stAfter = svc.getStatus()
    check('E-L4 ★ 服务端确实收到了这次握手(lastHandshakeAt 推进到本次之后)',
      typeof stAfter.lastHandshakeAt === 'number' && stAfter.lastHandshakeAt >= tMark,
      `lastHandshakeAt=${stAfter.lastHandshakeAt} / mark=${tMark}`)
    check('E-L5 唤醒计数落 storage 且 lastEvent=startup',
      ok.wake?.count === 1 && ok.wake?.lastEvent === 'startup', JSON.stringify(ok.wake))

    // ★ 阴性对照 1:错 token → 服务端必须拒,sw 必须如实归为 unauthorized(不是 ok、也不是 unreachable)
    const bad = await runRealSw({ token: 'a'.repeat(64), port: PORT2 }, { withBrowserOrigin: true })
    check('E-L6 ★ 阴性对照:错配对码 → sw 得到 unauthorized(证明上面的 ok 不是假绿)',
      bad.last?.reason === 'unauthorized', JSON.stringify(bad.last))

    // ★ 阴性对照 2:未配对 → 一个请求都不该发(约定 L5:不试探)
    const tMark2 = Date.now()
    const none = await runRealSw(null, { withBrowserOrigin: true })
    check('E-L7 ★ 阴性对照:未配对 → sw 不写握手结果(压根没发请求)',
      none.last === undefined, JSON.stringify(none.last))
    check('E-L7b ★ 未配对时服务端 lastHandshakeAt 未被推进',
      (svc.getStatus().lastHandshakeAt ?? 0) < tMark2,
      `lastHandshakeAt=${svc.getStatus().lastHandshakeAt} / mark=${tMark2}`)

    // ★ 阴性对照 3(意外收获,很有价值):对 token 但**不带浏览器签发的 Origin**(raw node fetch)
    //   → 被闸③ 拒。证明闸③ 在真实端到端链路上是活的,不只是单测里的分支。
    const noOrigin = await runRealSw({ token: liveToken, port: PORT2 }, { withBrowserOrigin: false })
    check('E-L8 ★ 阴性对照:对 token 但无浏览器 Origin(非浏览器客户端)→ 被闸③ 拒',
      noOrigin.last?.reason === 'unauthorized', JSON.stringify(noOrigin.last))
  }

  await svc.stop()
  rmSync(dir, { recursive: true, force: true })

  console.log('\n================ 汇总 ================')
  console.log(`pass ${passed} / fail ${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('探针自身异常:', e)
  process.exit(2)
})
