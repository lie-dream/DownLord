import type { DownloadProgress } from '../../shared/ipc'
import { mapAria2Status } from './taskModel'

export interface RpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params: unknown[]
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: unknown
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface Aria2ProgressStatus {
  gid: string
  status: string
  totalLength: string
  completedLength: string
  downloadSpeed: string
  connections: string
  errorCode?: string
  /** Native paths; HTTP decoration needs engine protocol context, so parseProgress leaves them untouched. */
  files?: Array<{ path?: string; length?: string }>
  /**
   * aria2 对失败下载给出的原文说明(真机修订 2026-07-27 · spec §13);`errorCode=1`(unknown)时它是唯一
   * 说得清的信息(如 `SSL/TLS handshake failure: …`)。仅失败帧携带,正常帧无此键。
   */
  errorMessage?: string
  /**
   * BT 富进度原始键(v0.3 Task 3 · spec §4;aria2 tellStatus/tellActive 对 BT 任务返回,http 无此键):
   * numSeeders = 做种节点数、uploadSpeed = 上行 B/s、uploadLength = 累计上传字节(字符串,与其余键同)。
   */
  numSeeders?: string
  uploadSpeed?: string
  uploadLength?: string
}

export class RpcError extends Error {
  code: number
  data?: unknown

  constructor(error: RpcErrorBody) {
    super(error.message)
    this.name = 'RpcError'
    this.code = error.code
    this.data = error.data
  }
}

export function buildRpcRequest(
  method: string,
  params: unknown[],
  opts: { secret: string; id: string | number }
): RpcRequest {
  return {
    jsonrpc: '2.0',
    id: opts.id,
    method,
    params: [`token:${opts.secret}`, ...params]
  }
}

export function parseRpcResponse(json: RpcResponse): unknown {
  if (json.error !== undefined) {
    throw new RpcError(normalizeRpcError(json.error))
  }

  return json.result
}

export function parseProgress(
  rawStatus: Aria2ProgressStatus,
  internalId: string
): DownloadProgress {
  const progress: DownloadProgress = {
    id: internalId,
    status: mapAria2Status(rawStatus.status),
    totalBytes: parseNumber(rawStatus.totalLength),
    downloadedBytes: parseNumber(rawStatus.completedLength),
    speed: parseNumber(rawStatus.downloadSpeed),
    connections: parseNumber(rawStatus.connections)
  }

  if (rawStatus.errorCode !== undefined && rawStatus.errorCode !== '') {
    progress.errorCode = rawStatus.errorCode
  }

  // aria2 原文错误说明(真机修订 2026-07-27 · spec §13):仅非空时设 —— 正常帧 / 旧 aria2 无此键时
  // progress 保持干净(不含 errorMessage),映射侧回落原文案,逐字节零回归。
  if (rawStatus.errorMessage !== undefined && rawStatus.errorMessage !== '') {
    progress.errorMessage = rawStatus.errorMessage
  }

  // BT 富进度(v0.3 Task 3 · spec §4):仅原始键存在时 parseNumber 进可选字段;
  // http 帧无这些键 → progress 保持干净(不含 numSeeders/uploadSpeed/uploadLength,零回归)。
  if (rawStatus.numSeeders !== undefined) {
    progress.numSeeders = parseNumber(rawStatus.numSeeders)
  }
  if (rawStatus.uploadSpeed !== undefined) {
    progress.uploadSpeed = parseNumber(rawStatus.uploadSpeed)
  }
  if (rawStatus.uploadLength !== undefined) {
    progress.uploadLength = parseNumber(rawStatus.uploadLength)
  }

  return progress
}

function normalizeRpcError(error: unknown): RpcErrorBody {
  if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      data: error.data
    }
  }

  return {
    code: -32603,
    message: 'Invalid aria2 RPC error response',
    data: error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNumber(value: string): number {
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}
