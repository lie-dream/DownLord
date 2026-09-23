/**
 * popup ↔ sw 的**扩展内部**消息约定(v0.4 Task 3 · spec §5.4)。
 *
 * ⚠️ 这**不是**本地通道协议,更**不是**「DownLord → 扩展」的反向推送(v0.4 明确不做)——
 * 两端都在浏览器里:popup 打开时叫醒 sw,顺带把最新事实取回来。
 * 通道协议在 `channel/protocol.ts` + `contract.ts`,与本文件无关。
 *
 * 为什么 popup 不自己握手、非要经 sw:握手结果要落 `storage` 给下一次冷启动看,
 * 而唤醒计数只有 sw 收到事件才会 +1(#46 的 M4 判据正是靠这条消息才可达)。
 */
import type { LastHandshake } from '../channel/handshakeClient'
import type { WakeState } from './lifecycle'

/** 唯一的消息种别。popup 每次打开、每次点「保存并连接」各发一条。 */
export const SW_SYNC_KIND = 'downlord:sync'

export interface SwSyncRequest {
  kind: typeof SW_SYNC_KIND
}

export interface SwSyncReply {
  /** `false` = sw 收到了但不认识这条消息(留个如实出口,不假装处理过) */
  handled: boolean
  /**
   * ★ v0.4 Task 5:**sw 自己那份构建标记**(`docs/TODO.md` #53)。
   *
   * 它是**必填**的 —— popup 拿它和自己那份比对,不一致就告警。
   * 旧 sw(本字段之前的产物)回不出它,守卫会因此判形状不认 → popup 侧落成
   * 「没问到」→ **按不一致处理**。这正是想要的:「沉默」与「一致」绝不可混为一谈。
   */
  buildId: string
  /** 本次唤醒后的计数;`undefined` = 未处理 */
  wake?: WakeState
  /** 本次握手结果;`undefined` = 未配对(什么都没做)或未处理 */
  handshake?: LastHandshake
}

export function isSwSyncRequest(value: unknown): value is SwSyncRequest {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>).kind === SW_SYNC_KIND
}

/**
 * sw 的应答经浏览器序列化往返,回到 popup 时是 `unknown` —— 用它验形状,不硬转。
 *
 * ⚠️ **`buildId` 一并验**:少了它就不是本版的 sw,而「不是本版」恰恰是 popup 要报的那件事。
 *    守卫若只看 `handled`,`reply.buildId` 会是类型上写着 string、运行时却是 `undefined` 的洞。
 */
export function isSwSyncReply(value: unknown): value is SwSyncReply {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.handled === 'boolean' && typeof record.buildId === 'string'
}
