/**
 * 本地通道 HTTP 服务(副作用集中处,依赖全注入;v0.4 Task 3 · spec §3.1 / §3.4 · plan 1.7)。
 *
 * 纯判定(三闸 / 限速 / 分发)全在 `channelAuth.ts` / `failureWindow.ts` / `channelDispatch.ts`,
 * 本文件只做:起停 socket、读 body(带两道上限)、把结果写回、按聚合口径打日志。
 *
 * ⚠️ 两条**不可越过**的红线:
 * 1. **只绑 `127.0.0.1`**(`BIND_HOST` 是模块级字面量常量,不进配置、不进 IPC、不可改)——
 *    绑回环的 socket 在**内核层面**就不接受其它网卡的连接,这是唯一一条不依赖我们代码正确性的防线。
 * 2. **响应头一律不含任何跨源放行头**(任何路径 / 方法 / 成功或失败)—— 这是闸②:
 *    让浏览器根据**我们的沉默**替我们拒掉网页 JS 的非简单请求。
 *    判据是机器可核验的:拿那个放行头名去 `grep -rn` 整个 `src/main/`,**应零命中** ——
 *    故本文件连注释里都不写它,否则这条 grep 就再也分不清「代码在设置它」与「注释在说别设它」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  EXTENSION_CHANNEL_MAX_BODY_BYTES,
  type ExtensionChannelResponse
} from '../../shared/extensionProtocol'
import type { ChannelServiceState } from '../../shared/ipc'
import { authorizeRequest, isAuthFailure, TOKEN_HEADER_LOWER } from './channelAuth'
import { createFailureWindow } from './failureWindow'
import { dispatchChannelMessage, type ChannelHandlers } from './channelDispatch'

/** ★ 绑定地址:**字面量常量,不进配置、不进 IPC、不可改**。配置项一旦存在就有人会去改它。 */
const BIND_HOST = '127.0.0.1'

/** 请求 / 请求头超时(挡本机程序的 slowloris 式挂连接) */
const REQUEST_TIMEOUT_MS = 5_000
/** 连接数上界。**是个上界、不是防线** —— 只避免句柄耗尽,不阻止有 token 的攻击者。 */
const MAX_CONNECTIONS = 32

/** 日志出口(注入;集成测试注入捕获器 → 断言任何一行都不含 token / Origin 值 / body 原文) */
export interface ChannelLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type ChannelRequestListener = (req: IncomingMessage, res: ServerResponse) => void

/**
 * HTTP 服务的最小注入面(真实实现 = `node:http` 的 `createServer`,见 `nodeHttpFactory.ts`)。
 * 形状刻意贴着 `http.Server`,故真实实现零适配代码。
 */
export interface ChannelHttpServer {
  listen(port: number, host: string, onListening: () => void): void
  close(callback: (err?: Error) => void): void
  address(): { address: string; port: number } | string | null
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): void
  removeListener(event: 'error', listener: (err: NodeJS.ErrnoException) => void): void
  requestTimeout: number
  headersTimeout: number
  maxConnections: number
  /** Node 18.2+ 提供;停机时兜底关掉残留连接,让端口立刻可被重新 bind */
  closeAllConnections?: () => void
}

export type ChannelHttpFactory = (listener: ChannelRequestListener) => ChannelHttpServer

export interface ChannelServerDeps {
  httpFactory: ChannelHttpFactory
  /** 实时读当前 token(**每请求读一次** → `regenerateToken` 后立刻生效) */
  getToken: () => string
  /** 时钟(真实 `() => Date.now()`;测试注入可推进的假时钟 —— 窗口限速靠它) */
  now: () => number
  logger: ChannelLogger
  /** 已鉴权消息的处理器(握手 handler 由 service 注入,**只读、零副作用**) */
  handlers: ChannelHandlers
}

export interface ChannelStartResult {
  state: ChannelServiceState
  /** 真实失败原因码(`'EADDRINUSE'` / `'EACCES'` …);成功为 `null` */
  lastError: string | null
  /** 实际监听端口(`port: 0` 时为 OS 分配的真实口);未监听为 `null` */
  actualPort: number | null
  /** 实际绑定地址(集成测试断言它恒为 `127.0.0.1`);未监听为 `null` */
  actualAddress: string | null
}

export interface ChannelServer {
  /** 起服务。**不顺延、不扫描**:`EADDRINUSE` 就停在 `port_in_use`,绝不试 port+1 */
  start(port: number): Promise<ChannelStartResult>
  /** 停服务(未启动为 no-op);停后同端口可被重新 `listen` */
  stop(): Promise<void>
}

/** 单值请求头:多值(数组)一律按「没有」处理 —— 宽容只会扩大匹配面 */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 解析 `content-length` 声明;缺失 / 非法 → `null`(它**可以撒谎或缺失**,故只是第一道) */
function parseContentLength(raw: string | string[] | undefined): number | null {
  const text = singleHeader(raw)
  if (text === undefined) return null
  const value = Number(text)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** 鉴权失败对外只回原因码;`404` / `405` / `413` 连原因码都不必回(非协议内请求) */
function unauthorizedBody(status: number): ExtensionChannelResponse | undefined {
  return status === 401 || status === 429 ? { ok: false, reason: 'unauthorized' } : undefined
}

export function createChannelServer(deps: ChannelServerDeps): ChannelServer {
  /** 失败窗口:★ 只在 **token 校验失败**后才被查(见 `channelAuth.ts` 的 `isTripped` 惰性回调) */
  const failureWindow = createFailureWindow()
  let server: ChannelHttpServer | null = null

  // 聚合计数(spec §3.5):内部诊断码只用于**计数**,既不回给对方也不逐条落日志
  let authFailureCount = 0
  let mismatchCount = 0
  let oversizedCount = 0

  /** 写响应。**永不设置任何跨源放行头** —— 这就是闸②(见文件头红线 2)。 */
  function respond(res: ServerResponse, status: number, body?: ExtensionChannelResponse): void {
    if (body === undefined) {
      // 失败即断:不保持 keep-alive 复用,让失败计数与连接一一对应,便于观测
      res.writeHead(status, { Connection: 'close' })
      res.end()
      return
    }
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      Connection: 'close'
    })
    res.end(text)
  }

  /**
   * 读请求体,**第二道上限**:流式累计超过 64KB 立刻 `destroy()` 连接。
   * `content-length` 可以撒谎或缺失,少这一道就有内存打爆面(spec §3.4)。
   */
  function readBody(req: IncomingMessage, onComplete: (text: string) => void): void {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > EXTENSION_CHANNEL_MAX_BODY_BYTES) {
        aborted = true
        oversizedCount += 1
        deps.logger.warn(`[extensionChannel] 请求体超限 ×${oversizedCount}`)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!aborted) onComplete(Buffer.concat(chunks).toString('utf8'))
    })
    // 客户端中途断开不是异常,更不该崩服务
    req.on('error', () => {})
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const now = deps.now()
    // **只取纯路径**:完整查询串一个字都不许进判定与日志(spec §3.5)
    const path = (req.url ?? '').split('?')[0]
    const decision = authorizeRequest(
      {
        method: req.method ?? '',
        path,
        // 只取判定真正需要的两个头,不把整包头传进纯函数
        headers: {
          [TOKEN_HEADER_LOWER]: singleHeader(req.headers[TOKEN_HEADER_LOWER]),
          origin: singleHeader(req.headers.origin)
        },
        contentLength: parseContentLength(req.headers['content-length'])
      },
      {
        token: deps.getToken(),
        isTripped: () => failureWindow.isTripped(now)
      }
    )

    if (!decision.ok) {
      if (isAuthFailure(decision.logCode)) {
        failureWindow.record(now)
        authFailureCount += 1
        deps.logger.warn(
          `[extensionChannel] 鉴权失败 ×${authFailureCount}(原因码 unauthorized)`
        )
      } else if (decision.logCode === 'too_large') {
        oversizedCount += 1
        deps.logger.warn(`[extensionChannel] 请求体超限 ×${oversizedCount}`)
      }
      // ★ 鉴权失败路径**不读 body**(先拒后读):省内存也省日志。
      // 未被消费的请求流保持暂停,数据不会进程序内存;`Connection: close` 让 Node 随后收连接。
      respond(res, decision.status, unauthorizedBody(decision.status))
      return
    }

    readBody(req, (text) => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // 非 JSON → 保持 `null` → 自然落进 dispatch 的「不是对象」分支(单一真源,不另开分支)
        parsed = null
      }

      const result = dispatchChannelMessage(parsed, deps.handlers)

      if (result.status === 409) {
        mismatchCount += 1
        deps.logger.warn(
          `[extensionChannel] 协议版本不匹配 ×${mismatchCount}(原因码 protocol_mismatch)`
        )
      }
      respond(res, result.status, result.body)
    })
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    failureWindow.reset()
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
      // 兜底关掉残留 keep-alive 连接,保证端口立刻可被重新 bind
      current.closeAllConnections?.()
    })
    deps.logger.info('[extensionChannel] 已关闭')
  }

  async function start(port: number): Promise<ChannelStartResult> {
    await stop()
    return new Promise<ChannelStartResult>((resolve) => {
      const next = deps.httpFactory(handleRequest)
      next.requestTimeout = REQUEST_TIMEOUT_MS
      next.headersTimeout = REQUEST_TIMEOUT_MS
      next.maxConnections = MAX_CONNECTIONS

      let settled = false
      const onStartError = (err: NodeJS.ErrnoException): void => {
        if (settled) return
        settled = true
        server = null
        const code = err.code ?? err.message
        if (code === 'EADDRINUSE') {
          // **不顺延、不扫描**:如实停在 port_in_use,由 UI 给「改端口」入口(spec §5.2)
          deps.logger.warn(`[extensionChannel] 端口 ${port} 被占用(EADDRINUSE),通道未启动`)
          resolve({
            state: 'port_in_use',
            lastError: 'EADDRINUSE',
            actualPort: null,
            actualAddress: null
          })
          return
        }
        // EACCES 之类罕见失败**不许被「已关闭」掩盖**:三态不新增,真实原因码进 lastError
        deps.logger.error(`[extensionChannel] 未启动(${code})`)
        resolve({ state: 'stopped', lastError: code, actualPort: null, actualAddress: null })
      }

      next.on('error', onStartError)
      next.listen(port, BIND_HOST, () => {
        if (settled) return
        settled = true
        next.removeListener('error', onStartError)
        // 运行期错误(listen 之后)只记日志,不改三态 —— 服务仍在监听
        next.on('error', (err: NodeJS.ErrnoException) => {
          deps.logger.error(`[extensionChannel] 运行期错误(${err.code ?? err.message})`)
        })
        server = next
        const info = next.address()
        const actualPort = typeof info === 'object' && info !== null ? info.port : port
        const actualAddress = typeof info === 'object' && info !== null ? info.address : BIND_HOST
        deps.logger.info(`[extensionChannel] 监听中 ${actualAddress}:${actualPort}`)
        resolve({ state: 'listening', lastError: null, actualPort, actualAddress })
      })
    })
  }

  return { start, stop }
}
