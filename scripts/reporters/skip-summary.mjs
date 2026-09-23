import { relative } from 'node:path'

/**
 * skipped 用例摘要 reporter —— 与 dot / spec 并列的第二个 reporter,只写 stderr。
 *
 * 为什么需要它:接入前这些 skipped 用例是**完全隐形**的 —— 默认 dot reporter 不打印
 * skipped 数,而 runner 用 stdio:'inherit' 直通子进程输出、拿不到任何结构化结果,
 * 「加一行 console.log」够不着。R2 收口时被消灭的那种静默 skip,换个写法就原封不动地活着。
 *
 * 形态:dot / spec 仍独占 stdout,输出一个字节都不变;本 reporter 走 stderr,
 * 在 stdio:'inherit' 下直接显示,runner 零解析、零临时文件。
 * 摘要给的不只是数字,还有**这几条分别是谁** —— 数字说明有多少条隐形,名单说明是哪几条。
 *
 * 事件形状 2026-08-23 实测:被跳过的用例走 `test:pass`,data 带 name / file / skip / nesting。
 */
export default async function* skipSummary(source) {
  const byFile = new Map()
  let total = 0

  for await (const event of source) {
    if (event.type !== 'test:pass') continue

    const data = event.data ?? {}
    if (!data.skip) continue

    total += 1
    const file = data.file ?? '(未知文件)'
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(data.name)
  }

  if (total === 0) {
    yield '\n⏭ 跳过 0 个用例\n'
    return
  }

  let out = `\n⏭ 跳过 ${total} 个用例(${byFile.size} 个文件):\n`
  for (const file of [...byFile.keys()].sort()) {
    out += `   ${toDisplayPath(file)}\n`
    for (const name of byFile.get(file)) out += `     · ${name}\n`
  }
  out += '   其中需真实引擎的那些:DOWNLORD_REAL_ENGINE=1 npm test 即可跑起来\n'
  yield out
}

function toDisplayPath(file) {
  const rel = relative(process.cwd(), file)
  const usable = rel && !rel.startsWith('..') ? rel : file
  return usable.replaceAll('\\', '/')
}
