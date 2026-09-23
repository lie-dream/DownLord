import type { ChildProcess } from 'child_process'
import { buildAria2Args } from './aria2Args'
import { findFreePort } from './port'
import { generateSecret } from './secret'
import { stripProxyEnv } from '../childEnv'

export interface Aria2ProcessDeps {
  spawn: typeof import('child_process').spawn
  net: typeof import('net')
  crypto: typeof import('crypto')
}

export interface StartAria2Options {
  aria2cPath: string
  dir: string
  /**
   * 全局下载限速 KB/s 启动初值(v0.2 Task 2 · spec §2.2)。透传 `buildAria2Args`:`kbps>0` 才加
   * `--max-download-limit`(每任务默认上限,v1.0 Task 8 · #100),`0` / 缺省 → 不加(零回归)。崩溃重启复用本路径 → 自动带当前限速。
   */
  maxOverallLimitKBps?: number
  /** DHT 路由表持久化路径(v0.3 修订三 · spec §4.2);透传 `buildAria2Args`,有值才加 `--dht-file-path` */
  dhtFilePath?: string
  /** IPv6 DHT 路由表持久化路径(2026-07-25 真机修订 · spec §14);透传 `buildAria2Args` */
  dhtFilePath6?: string
  /**
   * BT tracker 生效表(v0.4 Task 1 · spec §4.2 pull);透传 `buildAria2Args`:非空则替换内置表,
   * 缺省 / 空数组 → 用 `DEFAULT_BT_TRACKERS`(零回归)。崩溃重启复用本路径 → 自动带当时的生效表。
   */
  btTrackers?: readonly string[]
}

export interface StartAria2Result {
  child: ChildProcess
  port: number
  secret: string
}

export interface Aria2CrashHandler {
  onCrash?: () => void
}

/**
 * 崩溃检测状态，用于区分主动关闭 vs 意外退出
 */
export class Aria2CrashDetector {
  private isShuttingDown = false
  private crashCount = 0
  private firstCrashTime: number | null = null
  private readonly maxCrashesPerWindow = 5
  private readonly crashWindowMs = 60000 // 1 分钟

  /**
   * 标记进入主动关闭状态（stopAria2 调用时设置）
   */
  markShuttingDown(): void {
    this.isShuttingDown = true
  }

  /**
   * 检查是否是主动关闭
   */
  isIntentionalShutdown(): boolean {
    return this.isShuttingDown
  }

  /**
   * 重置关闭标志（重启后调用）
   */
  reset(): void {
    this.isShuttingDown = false
  }

  /**
   * 记录崩溃并检查是否超过风暴阈值
   * @returns true 表示应该重启，false 表示超过阈值应停止重启
   */
  recordCrash(): boolean {
    const now = Date.now()

    // 重置窗口：如果距离首次崩溃已超过窗口时间
    if (this.firstCrashTime === null || now - this.firstCrashTime > this.crashWindowMs) {
      this.firstCrashTime = now
      this.crashCount = 1
      return true
    }

    // 增加崩溃计数
    this.crashCount++

    // 检查是否超过阈值
    if (this.crashCount > this.maxCrashesPerWindow) {
      return false // 停止重启
    }

    return true // 可以重启
  }

  /**
   * 获取退避延迟（毫秒）
   * 指数退避：500ms, 1s, 2s, 4s, ...
   */
  getBackoffDelay(): number {
    const baseDelay = 500
    const attempt = Math.min(this.crashCount, 10) // 最多 10 次方
    return baseDelay * Math.pow(2, attempt - 1)
  }

  /**
   * 获取可读错误信息
   */
  getCrashLimitError(): string {
    return `aria2c 在 ${this.crashWindowMs / 1000} 秒内崩溃 ${this.crashCount} 次，已停止自动重启。请检查日志或手动重试。`
  }
}

/**
 * 环形缓冲区，用于收集 aria2c 的 stdout/stderr（仅供日志诊断，不解析驱动业务）
 */
class CircularBuffer {
  private buffer: string[] = []
  private maxLines: number

  constructor(maxLines = 100) {
    this.maxLines = maxLines
  }

  append(line: string): void {
    this.buffer.push(line)
    if (this.buffer.length > this.maxLines) {
      this.buffer.shift()
    }
  }

  getLines(): string[] {
    return [...this.buffer]
  }
}

/**
 * 启动 aria2c 子进程并等待就绪。
 *
 * 流程：
 * 1. 探测空闲端口
 * 2. 生成随机 secret
 * 3. 组装参数并 spawn
 * 4. 轮询 RPC getVersion 确认就绪（200ms 间隔，5s 总超时）
 * 5. 启动失败换端口重试（最多 3 次）
 *
 * @throws 重试耗尽后抛出可读错误，不崩主进程
 */
export async function startAria2(
  deps: Aria2ProcessDeps,
  opts: StartAria2Options,
  rpcClient?: {
    getVersion: (baseURL: string, secret: string) => Promise<unknown>
  }
): Promise<StartAria2Result> {
  const maxRetries = 3
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await startAria2Attempt(deps, opts, rpcClient)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (attempt < maxRetries) {
        // 换端口重试
        continue
      }
    }
  }

  throw new Error(`aria2c 启动失败（已重试 ${maxRetries} 次）：${lastError?.message || '未知错误'}`)
}

async function startAria2Attempt(
  deps: Aria2ProcessDeps,
  opts: StartAria2Options,
  rpcClient?: {
    getVersion: (baseURL: string, secret: string) => Promise<unknown>
  }
): Promise<StartAria2Result> {
  // 1. 探测空闲端口
  const port = await findFreePort(deps.net)

  // 2. 生成 secret
  const secret = generateSecret(deps.crypto)

  // 3. 组装参数
  const args = buildAria2Args({
    port,
    secret,
    dir: opts.dir,
    mainPid: process.pid,
    maxOverallLimitKBps: opts.maxOverallLimitKBps,
    dhtFilePath: opts.dhtFilePath,
    dhtFilePath6: opts.dhtFilePath6,
    btTrackers: opts.btTrackers
  })

  // 4. spawn（不经 shell，避免注入;剔除宿主代理环境变量——aria2 的协议级代理(HTTP_PROXY 等
  //    环境变量填充)会**覆盖**任务级 all-proxy,致 direct/manual 档全部失效,见 ../childEnv.ts）
  const child = deps.spawn(opts.aria2cPath, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: stripProxyEnv(),
    windowsHide: true // 打包 GUI 态防子进程闪控制台窗口(与 probeVersion 一致)
  })

  // 收集 stdout/stderr 到环形缓冲（仅日志用）
  const stdoutBuffer = new CircularBuffer()
  const stderrBuffer = new CircularBuffer()

  // spawn 失败(二进制缺失 / 不可执行)是异步 'error' 事件:无监听会冒泡成 uncaughtException,
  // 且真实 errno 被 5s 后的「就绪超时」文案掩盖 → 记入 stderr 缓冲,随就绪超时错误一并带出。
  child.on('error', (err) => {
    stderrBuffer.append(`[spawn error] ${err.message}`)
  })

  child.stdout?.on('data', (chunk) => {
    const lines = chunk.toString().split('\n')
    lines.forEach((line) => {
      if (line.trim()) stdoutBuffer.append(line.trim())
    })
  })

  child.stderr?.on('data', (chunk) => {
    const lines = chunk.toString().split('\n')
    lines.forEach((line) => {
      if (line.trim()) stderrBuffer.append(line.trim())
    })
  })

  // 5. 就绪探测
  const baseURL = `http://127.0.0.1:${port}/jsonrpc`

  try {
    await waitForReady(baseURL, secret, rpcClient)
  } catch (err) {
    // 就绪失败，杀掉子进程
    child.kill()

    const stderr = stderrBuffer.getLines().slice(-10).join('\n')
    throw new Error(
      `aria2c RPC 就绪超时（端口 ${port}）：${err instanceof Error ? err.message : String(err)}${stderr ? `\n最近 stderr：\n${stderr}` : ''}`
    )
  }

  return { child, port, secret }
}

/**
 * 轮询调用 aria2.getVersion 直到成功，或超时失败
 */
async function waitForReady(
  baseURL: string,
  secret: string,
  rpcClient?: {
    getVersion: (baseURL: string, secret: string) => Promise<unknown>
  }
): Promise<void> {
  const interval = 200 // ms
  const timeout = 5000 // ms
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      if (rpcClient) {
        await rpcClient.getVersion(baseURL, secret)
      } else {
        // 后备：直接用 fetch（用于测试或 rpcClient 未就绪的情况）
        await probeVersion(baseURL, secret)
      }
      return // 成功
    } catch {
      // 失败，继续轮询
      await sleep(interval)
    }
  }

  throw new Error('就绪探测超时')
}

async function probeVersion(baseURL: string, secret: string): Promise<void> {
  const request = {
    jsonrpc: '2.0',
    id: '1',
    method: 'aria2.getVersion',
    params: [`token:${secret}`]
  }

  const response = await fetch(baseURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    // 单次探测不得挂死:waitForReady 的 5s 总预算靠循环前检查,单次 fetch 无限悬挂会绕过它
    signal: AbortSignal.timeout(2000)
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const json = await response.json()
  if (json.error) {
    throw new Error(json.error.message)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 优雅关闭 aria2c 子进程。
 *
 * 流程：
 * 1. 标记主动关闭状态（防崩溃检测误触发）
 * 2. 调用 RPC shutdown
 * 3. 等待子进程 exit（3s 超时）
 * 4. 超时则调用 forceShutdown
 * 5. 仍不退则 child.kill()
 */
export async function stopAria2(
  child: ChildProcess,
  rpcClient: {
    shutdown: () => Promise<void>
    forceShutdown: () => Promise<void>
  },
  crashDetector?: Aria2CrashDetector
): Promise<void> {
  // 1. 标记主动关闭（防止 exit 监听器触发崩溃重启）
  if (crashDetector) {
    crashDetector.markShuttingDown()
  }

  // 子进程已退出(如崩溃后恢复失败,child 指向死进程):'exit' 不会再触发,
  // 下面三段 once('exit') 会白等约 5s 拖慢应用退出 → 直接返回
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  // 2. 调用 RPC shutdown
  try {
    await rpcClient.shutdown()
  } catch {
    // shutdown 失败不影响后续 kill 兜底
  }

  // 3. 等待 exit（3s 超时）
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

  const timeoutPromise = sleep(3000).then(() => 'timeout')

  const result = await Promise.race([exitPromise, timeoutPromise])

  if (result === 'timeout') {
    // 4. 超时，调用 forceShutdown
    try {
      await rpcClient.forceShutdown()
    } catch {
      // 失败不影响后续 kill
    }

    // 等待一小段时间看是否退出
    const forceExitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    const shortTimeoutPromise = sleep(1000).then(() => 'timeout')

    const forceResult = await Promise.race([forceExitPromise, shortTimeoutPromise])

    if (forceResult === 'timeout') {
      // 5. 仍不退，强制 kill
      child.kill('SIGKILL')

      // 等待 kill 生效
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(1000)
      ])
    }
  }
}

/**
 * 监听子进程退出，区分主动关闭 vs 崩溃
 */
export function watchAria2Exit(
  child: ChildProcess,
  crashDetector: Aria2CrashDetector,
  onCrash: () => void,
  onGiveUp?: (msg: string) => void
): void {
  child.on('exit', (code, signal) => {
    // 主动关闭，不触发崩溃处理
    if (crashDetector.isIntentionalShutdown()) {
      return
    }

    // 意外退出（崩溃）
    console.error(`[aria2Process] aria2c 意外退出 (code: ${code}, signal: ${signal})`)

    // 检查是否应该重启
    const shouldRestart = crashDetector.recordCrash()

    if (!shouldRestart) {
      // 审计#8(spec §8):崩溃风暴超限不再静默 return —— 上抛 onGiveUp,让上层对非终态任务发 error
      // 终态(§7.1 崩溃隔离不静默失败),UI 从「下载中 0 速」永久假死变可见 error 可重试。
      const msg = crashDetector.getCrashLimitError()
      console.error(`[aria2Process] ${msg}`)
      onGiveUp?.(msg)
      return
    }

    // 获取退避延迟
    const delay = crashDetector.getBackoffDelay()
    console.log(`[aria2Process] 将在 ${delay}ms 后尝试重启 aria2c...`)

    // 延迟后触发崩溃回调
    setTimeout(() => {
      onCrash()
    }, delay)
  })
}
