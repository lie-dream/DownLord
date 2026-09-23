import { buildRpcRequest, parseRpcResponse, RpcError } from './rpcCodec'
import { ERR, toReadable } from '../errors/errorCatalog'
import { mapAria2RpcError, mapEngineHttpError } from '../errors/mapError'

export interface RpcClientDeps {
  fetch: typeof globalThis.fetch
}

export interface RpcClientOpts {
  baseURL: string
  secret: string
}

/**
 * aria2 JSON-RPC 客户端，封装强类型方法。
 *
 * 错误处理：
 * - fetch 抛 ECONNREFUSED → 「下载引擎未就绪或已退出」
 * - AbortController 超时 → 「下载引擎响应超时」
 * - HTTP 非 2xx → 「下载引擎通信异常(HTTP <code>)」
 * - JSON-RPC error.code → 按 code 映射
 */
export class RpcClient {
  private idCounter = 0
  private deps: RpcClientDeps
  private opts: RpcClientOpts

  constructor(deps: RpcClientDeps, opts: RpcClientOpts) {
    this.deps = deps
    this.opts = opts
  }

  private nextId(): string {
    return String(++this.idCounter)
  }

  private async call(method: string, params: unknown[] = []): Promise<unknown> {
    const request = buildRpcRequest(method, params, {
      secret: this.opts.secret,
      id: this.nextId()
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000) // 10s 超时

    try {
      const response = await this.deps.fetch(this.opts.baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      })

      clearTimeout(timeout)

      if (!response.ok) {
        // aria2 对方法级 RPC 错误返回 HTTP 4xx + JSON-RPC error body(如对已完成任务 pause
        // → 400 {"error":{"code":1,"message":"GID ... is not found"}})。优先解析 body 透出
        // 真实 RPC 错误(经下方 RpcError 分支映射为可读中文);body 非 JSON-RPC 结构才退化为
        // 「通信异常(HTTP <status>)」。真机 2026-07-09 验收:先判 !ok 会吞掉全部 aria2 错误信息。
        let body: unknown = null
        try {
          body = await response.json()
        } catch {
          // body 非 JSON → 走 HTTP 退化
        }
        if (isRpcResponseShape(body)) {
          return parseRpcResponse(body) // error body → parseRpcResponse throw RpcError → 下方 catch 映射
        }
        throw new Error(toReadable(mapEngineHttpError(response.status)))
      }

      const json = await response.json()
      return parseRpcResponse(json)
    } catch (err) {
      clearTimeout(timeout)

      // 错误映射
      if (err instanceof RpcError) {
        throw new Error(mapRpcError(err))
      }

      if (err instanceof Error) {
        // fetch 网络错误
        if (err.name === 'AbortError') {
          throw new Error(toReadable(ERR.ENGINE_TIMEOUT))
        }

        // ECONNREFUSED 等连接错误
        if ('code' in err && err.code === 'ECONNREFUSED') {
          throw new Error(toReadable(ERR.ENGINE_NOT_READY))
        }

        // 其他 fetch 错误（可能是连接失败）
        if (err.message.includes('fetch') || err.message.includes('connect')) {
          throw new Error(toReadable(ERR.ENGINE_NOT_READY))
        }
      }

      throw err
    }
  }

  // ========== 方法封装 ==========

  async getVersion(): Promise<unknown> {
    return this.call('aria2.getVersion')
  }

  async addUri(uris: string[], options?: Record<string, unknown>): Promise<string> {
    const result = await this.call('aria2.addUri', [uris, options || {}])
    return String(result)
  }

  /**
   * `aria2.addTorrent(base64 种子内容, uris=[], options)` → gid(v0.3 Task 1 · spec §4.1)。
   * BT 走 aria2 原生(§6.1 不自研协议);磁力复用现成 `addUri([magnet], options)`。
   */
  async addTorrent(
    torrent: string,
    uris: string[] = [],
    options?: Record<string, unknown>
  ): Promise<string> {
    const result = await this.call('aria2.addTorrent', [torrent, uris, options || {}])
    return String(result)
  }

  /**
   * 动态改全局选项(v0.2 Task 2 · spec §2.2)。`aria2.changeGlobalOption` 一次调用对
   * **当前所有活动任务 + 之后新任务**生效(如 `max-overall-download-limit`),不重启进程、不碰 `.aria2`。
   */
  async changeGlobalOption(options: Record<string, string>): Promise<void> {
    await this.call('aria2.changeGlobalOption', [options])
  }

  /**
   * 动态改单任务选项(v0.2 Task 2 · spec §2.3)。`aria2.changeOption(gid)` 即时改该 gid 的
   * 运行时选项(如 `max-download-limit`),不重建下载、不碰 `.aria2`。
   */
  async changeOption(gid: string, options: Record<string, string>): Promise<void> {
    await this.call('aria2.changeOption', [gid, options])
  }

  async pause(gid: string): Promise<void> {
    await this.call('aria2.pause', [gid])
  }

  /**
   * 立即暂停(v0.3 Task 1 · 2026-07-22 真机修订四)。`aria2.pause` 是优雅暂停:任务先进
   * 「pause pending」等在途连接收尾(BT 还要联系 tracker 注销,可达数秒),窗口内 unpause 报
   * 「GID#… cannot be unpaused now」(真机:暂停后立点开始偶发报错)。forcePause 跳过收尾、
   * 立即转 paused;续传不受影响(`.aria2` 控制文件由 --auto-save-interval=1 每秒保存)。
   */
  async forcePause(gid: string): Promise<void> {
    await this.call('aria2.forcePause', [gid])
  }

  async unpause(gid: string): Promise<void> {
    await this.call('aria2.unpause', [gid])
  }

  async remove(gid: string): Promise<void> {
    await this.call('aria2.remove', [gid])
  }

  /**
   * 立即移除(v0.3 Task 2 · 2026-07-25 真机修订三)。`aria2.remove` 是优雅移除:BT 任务要向
   * tracker 发 stopped 收尾(bt-tracker-timeout=10s 内可长挂),期间**文件句柄不释放**——真机:
   * 删 BT 任务后 `shell.trashItem` 在 1.7s 退避内全部失败(Failed to perform delete operation),
   * 文件夹残留、用户手删又撞句柄锁弹系统提权框。forceRemove 跳过收尾立即移除、句柄即刻释放;
   * 用户删任务是明确意图,无需优雅注销(与 forcePause 同理,修订四先例)。
   */
  async forceRemove(gid: string): Promise<void> {
    await this.call('aria2.forceRemove', [gid])
  }

  /** Remove only this stopped download's RPC result; never purge unrelated task results. */
  async removeDownloadResult(gid: string): Promise<void> {
    await this.call('aria2.removeDownloadResult', [gid])
  }

  async tellStatus(gid: string, keys?: string[]): Promise<unknown> {
    return this.call('aria2.tellStatus', keys ? [gid, keys] : [gid])
  }

  async tellActive(keys?: string[]): Promise<unknown> {
    return this.call('aria2.tellActive', keys ? [keys] : [])
  }

  async tellWaiting(offset: number, num: number, keys?: string[]): Promise<unknown> {
    return this.call('aria2.tellWaiting', keys ? [offset, num, keys] : [offset, num])
  }

  async tellStopped(offset: number, num: number, keys?: string[]): Promise<unknown> {
    return this.call('aria2.tellStopped', keys ? [offset, num, keys] : [offset, num])
  }

  async shutdown(): Promise<void> {
    await this.call('aria2.shutdown')
  }

  async forceShutdown(): Promise<void> {
    await this.call('aria2.forceShutdown')
  }
}

/**
 * 映射 aria2 JSON-RPC 错误为可读中文(Task 9 收口:委托 `mapAria2RpcError` + `toReadable`,
 * 错误码 → 文案的判定逻辑统一迁入 `src/main/errors`,本处行为不变)。
 */
function mapRpcError(err: RpcError): string {
  return toReadable(mapAria2RpcError(err.code, err.message))
}

/** HTTP 非 2xx 时的 body 是否为 JSON-RPC 响应结构(带 error / result 字段) */
function isRpcResponseShape(body: unknown): body is Parameters<typeof parseRpcResponse>[0] {
  return typeof body === 'object' && body !== null && ('error' in body || 'result' in body)
}

/**
 * 便捷工厂：用 globalThis.fetch 创建客户端
 */
export function createRpcClient(opts: RpcClientOpts): RpcClient {
  return new RpcClient({ fetch: globalThis.fetch }, opts)
}
