/**
 * 接管意图的聚合缓冲(纯函数工厂,时钟注入;v0.4 Task 4 · spec §3.3 · plan 2.3)。
 *
 * 仿 `extensionChannel/failureWindow.ts`:状态全在闭包、时钟由调用方给,单测可推进假时钟,
 * 主进程只负责按返回的 `BufferAction` 排 / 清一个一次性定时器。
 *
 * **不变量:屏幕上永远只有一个确认窗口。** 三条规则(逐条给出理由,免得实现期纠结):
 * 1. **500ms 固定窗口,不重置计时** —— 首条 `accept` 起算 `deadline = now + 500`,后续 `accept`
 *    **不动 deadline**。重置计时(debounce)会让「持续点」的用户永远等不到窗口、延迟上限不可预测;
 *    固定窗口的延迟上限恒为 500ms。
 * 2. **窗口开着 → 只攒不弹** —— `isPresenting()` 为真时 `accept` 恒回 `hold`、`tick` 恒无动作。
 * 3. **`settled()` 时缓冲非空 → 立刻呈现,不再等 500ms** —— 那批早就攒够了,再等是纯粹的空转。
 *
 * **不设上限**:用户长时间不理时缓冲持续增长,**不截断、不丢弃** —— 截断会制造「一部分进 DownLord、
 * 一部分进浏览器、落点还不同」的分裂体验,比多点几次确认糟得多。缓冲只活在内存,**重启即清**。
 *
 * **当前批一旦 `present` 就是快照**:新来的进缓冲、成为下一批 —— 用户正在读的列表不会突然多两行。
 */

/** 聚合窗口长度(固定窗口,非 debounce) */
export const TAKEOVER_BATCH_WINDOW_MS = 500

/**
 * 缓冲的动作指令 —— 调用方**只按它做副作用**,不去读缓冲内部状态。
 *
 * `hold` 同时表示「已攒下,继续等」与「本次 tick 无动作」:两者对调用方是同一件事(什么都不做)。
 */
export type BufferAction<T> =
  | { kind: 'hold' }
  | { kind: 'armed'; at: number }
  | { kind: 'present'; batch: T[] }
  | { kind: 'idle' }

export interface TakeoverBuffer<T> {
  /** 收一条意图。首条 → `armed`(调用方据此排定时器);其余 / 呈现中 → `hold` */
  accept(item: T): BufferAction<T>
  /** 定时器回调。到点且缓冲非空 → `present`;未到点 / 呈现中 → `hold`;缓冲空 → `idle` */
  tick(): BufferAction<T>
  /** 当前批处理完(确认 / 取消 / 窗口关闭)。缓冲非空 → **立刻** `present`;空 → `idle`(窗口可关) */
  settled(): BufferAction<T>
  /** 缓冲内待呈现条数(**不含**已呈现的当前批) */
  size(): number
  /** 是否有一批正在呈现 */
  isPresenting(): boolean
  /** 清空(服务停止时调用,避免跨启停残留;仿 `failureWindow.reset`) */
  reset(): void
}

export interface TakeoverBufferOptions {
  /** 时钟(真实 `() => Date.now()`;测试注入可推进的假时钟) */
  now: () => number
  windowMs?: number
}

/**
 * 建一个聚合缓冲。泛型只为免去测试构造完整意图 —— 缓冲对元素内容**一无所知**,
 * 它只管「攒多久、什么时候弹、一次弹几条」。
 */
export function createTakeoverBuffer<T>(options: TakeoverBufferOptions): TakeoverBuffer<T> {
  const windowMs = options.windowMs ?? TAKEOVER_BATCH_WINDOW_MS
  /** 待呈现队列(到达顺序) */
  let pending: T[] = []
  /** 当前窗口的到点时刻;`null` = 未计时 */
  let deadline: number | null = null
  /** 有一批正在呈现(窗口开着) */
  let presenting = false

  /** 取走全部待呈现项作为一批,并置呈现中 */
  function takeBatch(): BufferAction<T> {
    const batch = pending
    pending = []
    deadline = null
    presenting = true
    return { kind: 'present', batch }
  }

  return {
    accept(item: T): BufferAction<T> {
      pending.push(item)
      // 规则 2:窗口开着只攒不弹(也不排计时器 —— 关窗 / 确认后由 settled() 立刻弹)
      if (presenting) return { kind: 'hold' }
      // 规则 1:已在计时中就**不动 deadline**(固定窗口,非 debounce)
      if (deadline !== null) return { kind: 'hold' }
      deadline = options.now() + windowMs
      return { kind: 'armed', at: deadline }
    },

    tick(): BufferAction<T> {
      if (presenting) return { kind: 'hold' }
      if (deadline === null) return pending.length > 0 ? takeBatch() : { kind: 'idle' }
      if (options.now() < deadline) return { kind: 'hold' }
      if (pending.length === 0) {
        deadline = null
        return { kind: 'idle' }
      }
      return takeBatch()
    },

    settled(): BufferAction<T> {
      presenting = false
      // 规则 3:早就攒够了,不再等 500ms
      if (pending.length > 0) return takeBatch()
      deadline = null
      return { kind: 'idle' }
    },

    size(): number {
      return pending.length
    },

    isPresenting(): boolean {
      return presenting
    },

    reset(): void {
      pending = []
      deadline = null
      presenting = false
    }
  }
}
