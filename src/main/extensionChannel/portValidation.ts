/**
 * 通道端口校验(纯函数;v0.4 Task 3 · spec §5.2 · plan 1.6)。
 *
 * 失败带**具体 code** 而非布尔 —— UI 要据此出「端口必须是 1024–65535 的整数」/
 * 「52301–52320 已被 BT 与 DHT 占用」这类**能指路的**文案(CONTEXT.md「诚实」)。
 */

/** BT 监听段起点(`aria2Args.ts` 的 `--listen-port=52301-52310`) */
export const RESERVED_BT_PORT_MIN = 52301
/** DHT 监听段终点(`aria2Args.ts` 的 `--dht-listen-port=52311-52320`) */
export const RESERVED_BT_PORT_MAX = 52320

/** 可用端口下界(1024 以下为特权端口,Windows 上也常被系统服务占用) */
export const MIN_CHANNEL_PORT = 1024
/** 可用端口上界 */
export const MAX_CHANNEL_PORT = 65535

/** 失败原因码(供 UI 出具体文案;不与通道对外原因码混用) */
export type ChannelPortInvalidCode = 'not_integer' | 'out_of_range' | 'reserved_bt'

export type ChannelPortValidation =
  | { ok: true; port: number }
  | { ok: false; code: ChannelPortInvalidCode }

/**
 * 校验通道端口:整数 + `1024–65535` + **避开 BT / DHT 已占段 `52301–52320`**。
 *
 * 避开已占段是**防自伤**:选中该段会与 aria2 的固定监听端口冲突,
 * 表现为「通道起不来」或「BT 起不来」二选一,且极难被用户联想到。
 */
export function validateChannelPort(value: unknown): ChannelPortValidation {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, code: 'not_integer' }
  }
  if (value < MIN_CHANNEL_PORT || value > MAX_CHANNEL_PORT) {
    return { ok: false, code: 'out_of_range' }
  }
  if (value >= RESERVED_BT_PORT_MIN && value <= RESERVED_BT_PORT_MAX) {
    return { ok: false, code: 'reserved_bt' }
  }
  return { ok: true, port: value }
}
