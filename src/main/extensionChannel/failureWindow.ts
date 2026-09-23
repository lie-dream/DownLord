/**
 * 失败窗口限速(纯函数工厂,时钟由调用方传入;v0.4 Task 3 · spec §3.4 · plan 1.4)。
 *
 * ★ **只作用于失败请求:token 正确的请求永不被限速**。否则本机任意程序可以靠刷失败把
 * **合法扩展一起挡死**(自制拒绝服务)。故 `isTripped` 只在 token 校验失败后才被查
 * (`channelAuth.ts` 里以惰性回调形态注入,有单测断言 token 正确时它根本没被调用)。
 *
 * **诚实标注**:它的实际作用是**限制失败处理与日志的开销**,而不是「让 token 猜不出来」——
 * 64 位 hex(256 bit 熵)本来就猜不出来。不夸大成防暴力破解的主力。
 */

/** 滑动窗口长度 */
export const FAILURE_WINDOW_MS = 60_000
/** 窗口内失败次数上限:达到即触发(第 21 次失败请求拿到 429) */
export const FAILURE_MAX_FAILURES = 20

export interface FailureWindowOptions {
  windowMs?: number
  maxFailures?: number
}

export interface FailureWindow {
  /** 记一次鉴权失败(时间戳由调用方给,便于测试推进假时钟) */
  record(now: number): void
  /** 窗口内失败数是否已达上限(**只在 token 校验失败后被查**) */
  isTripped(now: number): boolean
  /** 窗口内当前失败数(诊断 / 测试用) */
  size(now: number): number
  /** 清空计数(服务停止时调用,避免跨启停累计) */
  reset(): void
}

/**
 * 建一个滑动窗口失败计数器。
 * 实现是「时间戳数组 + 每次操作先淘汰过期项」—— 窗口内最多 21 个元素,开销可忽略。
 */
export function createFailureWindow(options: FailureWindowOptions = {}): FailureWindow {
  const windowMs = options.windowMs ?? FAILURE_WINDOW_MS
  const maxFailures = options.maxFailures ?? FAILURE_MAX_FAILURES
  let failures: number[] = []

  /** 淘汰滑出窗口的记录(含时钟回拨:`now` 变小时旧记录同样按差值判定,不会永久卡住) */
  function prune(now: number): void {
    failures = failures.filter((at) => now - at < windowMs)
  }

  return {
    record(now: number): void {
      prune(now)
      failures.push(now)
    },
    isTripped(now: number): boolean {
      prune(now)
      return failures.length >= maxFailures
    },
    size(now: number): number {
      prune(now)
      return failures.length
    },
    reset(): void {
      failures = []
    }
  }
}
