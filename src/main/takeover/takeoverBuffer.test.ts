/**
 * 聚合缓冲状态机单测(U-07~U-10;v0.4 Task 4 · spec §7.1 / §3.3)。
 *
 * 时钟注入 → 全程手动推进,零真实定时器。三条规则各配至少一支:
 * 固定窗口不重置计时 / 呈现中只攒不弹 / `settled()` 非空立刻呈现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAKEOVER_BATCH_WINDOW_MS, createTakeoverBuffer } from './takeoverBuffer'

const T0 = 1_700_000_000_000

function makeBuffer(): { buffer: ReturnType<typeof createTakeoverBuffer<string>>; at: (t: number) => void } {
  let now = T0
  const buffer = createTakeoverBuffer<string>({ now: () => now })
  return { buffer, at: (t: number) => void (now = t) }
}

test('常量:聚合窗口 500ms(改了就该有人重新论证延迟上限)', () => {
  assert.equal(TAKEOVER_BATCH_WINDOW_MS, 500)
})

// ── U-07:固定窗口,**不重置计时**(反 debounce)──────────────────────────

test('U-07 首条 accept → armed(at = now+500);第二条(now+200)→ hold 且 deadline 不变', () => {
  const { buffer, at } = makeBuffer()
  assert.deepEqual(buffer.accept('a'), { kind: 'armed', at: T0 + 500 })

  at(T0 + 200)
  assert.deepEqual(buffer.accept('b'), { kind: 'hold' })
  // ★ 反 debounce 的真正判据:到原 deadline 就弹,不因第二条而顺延到 T0+700
  at(T0 + 500)
  assert.deepEqual(buffer.tick(), { kind: 'present', batch: ['a', 'b'] })
})

// ── U-08:到点才弹,批内顺序 = 到达顺序 ─────────────────────────────────

test('U-08 tick(now+499) 无动作;tick(now+500) → present,batch 两条且顺序为到达顺序', () => {
  const { buffer, at } = makeBuffer()
  buffer.accept('first')
  at(T0 + 100)
  buffer.accept('second')

  at(T0 + 499)
  assert.deepEqual(buffer.tick(), { kind: 'hold' })
  assert.equal(buffer.isPresenting(), false)

  at(T0 + 500)
  assert.deepEqual(buffer.tick(), { kind: 'present', batch: ['first', 'second'] })
  assert.equal(buffer.isPresenting(), true)
  assert.equal(buffer.size(), 0)
})

// ── U-09:呈现中只攒不弹(屏幕上永远只有一个确认窗口)────────────────────

test('U-09 呈现中 accept 恒 hold、tick 恒无动作;新来的成为下一批(当前批是快照)', () => {
  const { buffer, at } = makeBuffer()
  buffer.accept('a')
  at(T0 + 500)
  assert.deepEqual(buffer.tick(), { kind: 'present', batch: ['a'] })

  at(T0 + 600)
  assert.deepEqual(buffer.accept('b'), { kind: 'hold' })
  at(T0 + 2000)
  assert.deepEqual(buffer.accept('c'), { kind: 'hold' })
  assert.deepEqual(buffer.tick(), { kind: 'hold' })
  assert.deepEqual(buffer.tick(), { kind: 'hold' })
  assert.equal(buffer.size(), 2)

  // 用户处理完当前批 → b / c 才作为**下一批**出现
  assert.deepEqual(buffer.settled(), { kind: 'present', batch: ['b', 'c'] })
})

// ── U-10:settled 立刻呈现 / 缓冲空则 idle ──────────────────────────────

test('U-10 settled 缓冲非空 → 立刻 present(不再等 500ms)', () => {
  const { buffer, at } = makeBuffer()
  buffer.accept('a')
  at(T0 + 500)
  buffer.tick()

  at(T0 + 501)
  buffer.accept('b')
  // ★ 立刻:同一时刻 settled 就拿到下一批,不需要再推进 500ms
  assert.deepEqual(buffer.settled(), { kind: 'present', batch: ['b'] })
})

test('U-10 settled 缓冲空 → idle(窗口可关),此后新意图重新起 500ms 窗口', () => {
  const { buffer, at } = makeBuffer()
  buffer.accept('a')
  at(T0 + 500)
  buffer.tick()
  assert.deepEqual(buffer.settled(), { kind: 'idle' })
  assert.equal(buffer.isPresenting(), false)

  at(T0 + 900)
  assert.deepEqual(buffer.accept('b'), { kind: 'armed', at: T0 + 1400 })
})

test('不设上限:长时间不理时缓冲持续增长,不截断、不丢弃', () => {
  const { buffer, at } = makeBuffer()
  buffer.accept('a')
  at(T0 + 500)
  buffer.tick()
  for (let i = 0; i < 50; i++) buffer.accept(`x${i}`)
  assert.equal(buffer.size(), 50)
  const action = buffer.settled()
  assert.equal(action.kind === 'present' && action.batch.length, 50)
})

test('reset 清空(服务停止;避免跨启停残留)', () => {
  const { buffer } = makeBuffer()
  buffer.accept('a')
  buffer.reset()
  assert.equal(buffer.size(), 0)
  assert.equal(buffer.isPresenting(), false)
  assert.deepEqual(buffer.tick(), { kind: 'idle' })
})
