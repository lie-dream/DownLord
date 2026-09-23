/**
 * 更新用 HTTP 客户端(v0.2 Task 6 · spec §2.2 / §3.3)。
 *
 * 基于 Electron `net` + **独立 update Session**:走 Chromium 网络、原生跟随重定向、支持 session 级
 * 代理(`setProxy({proxyRules})`),与业务下载引擎(aria2)完全隔离——不污染任务列表 / 无需 gid /
 * 分类路由。代理经 `configureProxy(effectiveUrl)` 从 `ProxyService.getResolved().effectiveUrl` 映射
 * (非空 → 该地址;null → 显式 `direct://`),每次请求前调用即可切档即时生效。
 *
 * 依赖(session / net)全注入:纯代理映射逻辑单测注入 fake session 断言 `setProxy` 参数,不碰真实
 * 网络 / Electron 运行时;真实实现由 `createUpdateHttpClient()` 装配(仅主进程调用)。
 */
import type { ClientRequest, Session } from 'electron'
import { createWriteStream } from 'fs'

/** 下载进度回调载荷(§2.2:换算百分比 → 广播) */
export interface DownloadProgress {
  received: number
  total: number
}

/**
 * 更新 HTTP 客户端接口(纯转发层依赖此抽象,单测注入 fake)。
 * - `configureProxy`:每次请求前设 session 代理(effectiveUrl null → direct://)。
 * - `getJson` / `getText`:GET 跟随重定向 + User-Agent;非 2xx 抛错(交 mapUpdateError)。
 * - `downloadToFile`:流式下载到 dest,`onProgress` 上报字节进度;失败抛错(编排层清理临时文件)。
 */
export interface UpdateHttpClient {
  configureProxy(effectiveUrl: string | null): Promise<void>
  getJson(url: string): Promise<unknown>
  getText(url: string): Promise<string>
  downloadToFile(
    url: string,
    dest: string,
    onProgress?: (p: DownloadProgress) => void
  ): Promise<void>
}

/** session 最小面(仅需 `setProxy`;真实 Electron `Session` 结构满足) */
export interface UpdateSessionLike {
  setProxy(config: { proxyRules: string }): Promise<void>
}

/** net 最小面(仅需 `request`;真实 Electron `net` 经 createUpdateHttpClient 注入) */
export interface UpdateNetLike {
  request(options: {
    url: string
    session?: Session
    redirect?: 'follow' | 'error' | 'manual'
  }): ClientRequest
}

/** GitHub 强制要求 User-Agent 头,否则拒绝 API 请求(§2.1) */
export const UPDATE_USER_AGENT = 'DownLord-Updater'

export interface ElectronUpdateHttpClientDeps {
  session: UpdateSessionLike & Session
  net: UpdateNetLike
  userAgent?: string
}

/**
 * Electron net 实现:构造期注入独立 update session + net;所有请求经该 session(代理隔离)。
 * `configureProxy` 是**唯一被单测覆盖**的纯映射逻辑;get/download 走真实网络归集成 / 手测(§7.3)。
 */
export class ElectronUpdateHttpClient implements UpdateHttpClient {
  private readonly userAgent: string

  constructor(private readonly deps: ElectronUpdateHttpClientDeps) {
    this.userAgent = deps.userAgent ?? UPDATE_USER_AGENT
  }

  /** 设 update session 代理(spec §3.3):effectiveUrl 非空 → 该地址;null → 显式直连。 */
  configureProxy(effectiveUrl: string | null): Promise<void> {
    return this.deps.session.setProxy({ proxyRules: effectiveUrl ?? 'direct://' })
  }

  /** GET 收全响应体为 Buffer(跟随重定向 + User-Agent);非 2xx 抛「HTTP <status>」(交 mapUpdateError)。 */
  private requestBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = this.deps.net.request({
        url,
        session: this.deps.session as Session,
        redirect: 'follow'
      })
      req.setHeader('User-Agent', this.userAgent)
      req.on('response', (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`))
            return
          }
          resolve(Buffer.concat(chunks))
        })
        res.on('error', (err: Error) => reject(err))
      })
      req.on('error', (err) => reject(err))
      req.end()
    })
  }

  async getJson(url: string): Promise<unknown> {
    const body = await this.requestBuffer(url)
    return JSON.parse(body.toString('utf-8'))
  }

  async getText(url: string): Promise<string> {
    const body = await this.requestBuffer(url)
    return body.toString('utf-8')
  }

  /** 流式下载到 dest(跟随重定向 + User-Agent);按 Content-Length 上报进度;失败抛错(临时文件由编排层清理)。 */
  downloadToFile(
    url: string,
    dest: string,
    onProgress?: (p: DownloadProgress) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.deps.net.request({
        url,
        session: this.deps.session as Session,
        redirect: 'follow'
      })
      req.setHeader('User-Agent', this.userAgent)
      req.on('response', (res) => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}`))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0) || 0
        let received = 0
        const out = createWriteStream(dest)
        out.on('error', (err) => reject(err))
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          out.write(chunk)
          onProgress?.({ received, total })
        })
        res.on('end', () => out.end(() => resolve()))
        res.on('error', (err: Error) => {
          out.destroy()
          reject(err)
        })
      })
      req.on('error', (err) => reject(err))
      req.end()
    })
  }
}

/**
 * 装配真实更新 HTTP 客户端(仅主进程调用):独立 partition session + Electron net。
 * `session.fromPartition('update')` 与业务网络隔离;代理由后续 `configureProxy` 按当前档设置。
 */
export function createUpdateHttpClient(deps: {
  net: UpdateNetLike
  session: UpdateSessionLike & Session
  userAgent?: string
}): UpdateHttpClient {
  return new ElectronUpdateHttpClient({
    session: deps.session,
    net: deps.net,
    userAgent: deps.userAgent
  })
}
