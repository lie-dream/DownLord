/**
 * 临时目录夹具 + teardown(v1.0 Task 1 Phase 2 · spec §2.4ⓒ 的约束表)。
 *
 * 为什么需要它:§7.3 的头号红线是「**损坏时**备份旧库再新建,绝不静默丢弃」,要触发它就得造一个
 * **损坏的库文件** —— 而 `:memory:` 没有文件可损坏。不落地这个夹具,「§7.3 第一优先层」就只测得到
 * 迁移与索引,测不到最要紧的那半句。
 *
 * 项目此前**没有**这个形态(`tests/setup/jsdom.ts` 连 teardown 都没有),故约束写死在这里:
 *
 * | 约束 | 内容 |
 * |---|---|
 * | 目录 | `mkdtemp(join(os.tmpdir(), 'downlord-t1-'))`,**每个用例一个独立目录** |
 * | 清理 | `t.after(...)` 内 `rm(dir, { recursive: true, force: true })` |
 * | 清理失败 | **不得让用例变红**(Windows 文件锁偶发占用),但必须 `console.warn` 出来 |
 * | 绝不 | 🚫 不在仓库工作区内建临时库文件;🚫 不复用固定路径(并发跑会互相踩) |
 *
 * 「清理失败只 warn」不是偷懒:清理属于**测试自身的收尾**,它失败说明的是宿主机文件锁,而不是被测
 * 红线被破坏。让它判红会把一条真断言的红埋进一堆环境噪音里。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 只取用得到的那一面:`t.after` —— 免得为了类型把整个 TestContext 拖进来 */
export interface AfterHookHost {
  after(fn: () => void | Promise<void>): void
}

/**
 * 建一个本用例专属的临时目录,并把清理挂到该用例的 `after` 上。
 *
 * @param t 当前用例的 TestContext(`test('…', async (t) => …)` 的那个 `t`)
 * @param label 目录名中缀,便于失败时从 `%TEMP%` 里认出是谁留下的
 */
export async function makeTempDir(t: AfterHookHost, label = ''): Promise<string> {
  const prefix = label ? `downlord-t1-${label}-` : 'downlord-t1-'
  const dir = await mkdtemp(join(tmpdir(), prefix))

  t.after(async () => {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      // Windows 下 SQLite 句柄偶发滞留 → 删不掉。这属于宿主机噪音,不是红线被破坏:
      // 只 warn 不判红,但必须可见(静默吞掉会让「临时文件从不清理」这件事永远没人发现)。
      console.warn(`[tests/helpers/tmpdir] 清理临时目录失败(不判红):${dir}`, err)
    }
  })

  return dir
}
