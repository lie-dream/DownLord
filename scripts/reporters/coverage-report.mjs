import { mkdirSync, writeFileSync } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

/**
 * 覆盖率报告 reporter —— 只用于 `npm run coverage`,不进 `npm test` 路径。
 *
 * 为什么自己写而不是直接看内建 reporter 的表(两条 2026-08-23 实测理由):
 * ① dot reporter **根本不打印**覆盖率表;spec 打印,但会连带上万行逐用例输出。
 * ② 更要害:`--test-coverage-include` 是**过滤器,不是强制列入** —— 从未被任何测试
 *    import 的文件**根本不出现在报告里**(而不是以 0% 列出)。故「零覆盖清单」只能用
 *    **分母集合 − 报告集合** 算,读报告是读不出来的。
 *
 * 🔴「排除」与「豁免」不许混用:排除 = 它不该出现在分母里;豁免 = 它在分母里、确实没被
 *    覆盖、并写明为什么。把「不可测」悄悄归进排除项,等于把它伪装成「已覆盖」。
 *    本 reporter 只产出**机器可判定**的那半(三类排除项计数 + 零覆盖清单);
 *    豁免理由是人写的,落在命中清单里。
 */

const CWD = process.cwd()

// 分母 = 三个测试根下的一等源文件。extension 只收顶层 .ts 与 src 子树下的 .ts;
// scripts 只收顶层 .mjs —— scripts/verify 下是一次性探针 .mts 不计,
// scripts/reporters 是本 Phase 新增的度量代码、同样在顶层之外,故也不在分母内(报告里显式记一笔)。
const ROOTS = [
  { dir: 'src', recursive: true, exts: ['.ts', '.tsx'] },
  { dir: 'extension', recursive: false, exts: ['.ts'] },
  { dir: 'extension/src', recursive: true, exts: ['.ts'] },
  { dir: 'scripts', recursive: false, exts: ['.mjs'] }
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage'])

const EXCLUSION_LABELS = {
  ex1: '排除① *.d.ts(与纯 type-only 文件)',
  ex2: '排除② 测试文件自身 *.test.ts / *.test.tsx',
  ex3: '排除③ *.config.*'
}

export default async function* coverageReport(source) {
  let summary = null

  for await (const event of source) {
    if (event.type === 'test:coverage') summary = event.data.summary
  }

  if (!summary) {
    yield '\n⚠️ 未收到 test:coverage 事件 —— 覆盖率没有开启,或本次运行提前中断。\n'
    return
  }

  yield render(summary)
}

function render(summary) {
  const reported = new Map()
  for (const file of summary.files) reported.set(toRel(file.path), file)

  const inventory = takeInventory()
  const typeOnlyNote = reclassifyTypeOnly(inventory, reported)
  const denominator = inventory.filter((item) => item.kind === 'denominator')
  const covered = denominator.filter((item) => reported.has(item.rel))
  const zero = denominator.filter((item) => !reported.has(item.rel))
  const outOfScope = [...reported.keys()].filter(
    (rel) => !inventory.some((item) => item.rel === rel)
  )

  writeRawArtifact({ inventory, reported: [...reported.keys()], zero, outOfScope })

  const out = []

  out.push('')
  out.push('=== 覆盖率(逐文件) ===')
  out.push(tableRow('file', 'line %', 'branch %', 'funcs %', 'uncovered lines'))
  out.push('-'.repeat(120))
  for (const rel of [...reported.keys()].sort()) {
    const file = reported.get(rel)
    out.push(
      tableRow(
        rel,
        pct(file.coveredLinePercent),
        pct(file.coveredBranchPercent),
        pct(file.coveredFunctionPercent),
        uncoveredRanges(file.lines)
      )
    )
  }
  out.push('-'.repeat(120))

  const totals = summary.totals
  out.push('')
  out.push('=== 全局(仅含分母口径内、且被加载过的文件) ===')
  out.push(
    `行 ${pct(totals.coveredLinePercent)}% (${totals.coveredLineCount}/${totals.totalLineCount})` +
      ` · 分支 ${pct(totals.coveredBranchPercent)}% (${totals.coveredBranchCount}/${totals.totalBranchCount})` +
      ` · 函数 ${pct(totals.coveredFunctionPercent)}% (${totals.coveredFunctionCount}/${totals.totalFunctionCount})`
  )
  out.push('⚠️ 分母口径内但从未被加载的文件不在上面这个百分比里 —— 见下方「零覆盖清单」。')

  out.push('')
  out.push('=== src/main/db/ 逐文件行覆盖 ===')
  const dbFiles = denominator.filter((item) => item.rel.startsWith('src/main/db/'))
  for (const item of dbFiles.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const file = reported.get(item.rel)
    out.push(
      file
        ? `  ${padEnd(item.rel, 46)} 行 ${pct(file.coveredLinePercent)}%  分支 ${pct(file.coveredBranchPercent)}%  函数 ${pct(file.coveredFunctionPercent)}%`
        : `  ${padEnd(item.rel, 46)} 零覆盖(从未被任何测试加载)`
    )
  }

  const counts = {
    ex1: inventory.filter((item) => item.kind === 'ex1').length,
    ex2: inventory.filter((item) => item.kind === 'ex2').length,
    ex3: inventory.filter((item) => item.kind === 'ex3').length
  }
  const all = inventory.length

  out.push('')
  out.push('=== 分母口径与三类排除项 ===')
  out.push(`  一等源文件全集(三根 glob 命中)              : ${all}`)
  out.push(`    ${EXCLUSION_LABELS.ex1}      : ${counts.ex1}`)
  out.push(`    ${EXCLUSION_LABELS.ex2} : ${counts.ex2}`)
  out.push(`    ${EXCLUSION_LABELS.ex3}                       : ${counts.ex3}`)
  out.push(`  分母(全集 − 三类排除)                        : ${denominator.length}`)
  out.push(`    ├ 有覆盖(出现在覆盖率报告中)               : ${covered.length}`)
  out.push(`    └ 零覆盖(从未被加载 → 须逐条写豁免理由)    : ${zero.length}`)
  const lhs = counts.ex1 + counts.ex2 + counts.ex3 + zero.length + covered.length
  out.push(
    `  恒等式 排除 + 豁免候选 + 有覆盖 = 全集:` +
      ` ${counts.ex1}+${counts.ex2}+${counts.ex3}+${zero.length}+${covered.length} = ${lhs} vs ${all}` +
      ` → ${lhs === all ? 'OK' : '❌ MISMATCH'}`
  )
  out.push(
    `  恒等式 豁免候选 + 有覆盖 = 分母:` +
      ` ${zero.length}+${covered.length} = ${zero.length + covered.length} vs ${denominator.length}` +
      ` → ${zero.length + covered.length === denominator.length ? 'OK' : '❌ MISMATCH'}`
  )

  out.push('')
  out.push(`=== 排除项逐条(① 与 ③ 全列;② 共 ${counts.ex2} 个测试文件,按目录折叠) ===`)
  if (typeOnlyNote) out.push(`  ${typeOnlyNote}`)
  for (const kind of ['ex1', 'ex3']) {
    out.push(`  ${EXCLUSION_LABELS[kind]}:`)
    const items = inventory.filter((item) => item.kind === kind)
    if (items.length === 0) out.push('    (无)')
    for (const item of items.sort((a, b) => a.rel.localeCompare(b.rel))) {
      out.push(`    · ${padEnd(item.rel, 46)} ${item.reason}`)
    }
  }
  out.push(`  ${EXCLUSION_LABELS.ex2}:`)
  for (const [dir, n] of countByDir(inventory.filter((item) => item.kind === 'ex2'))) {
    out.push(`    · ${padEnd(dir, 46)} ${n}`)
  }
  out.push('    (完整清单见 coverage/denominator.json,该目录不入库)')

  out.push('')
  out.push(`=== 零覆盖清单(${zero.length} 个 · 每条都必须在命中清单里写豁免理由) ===`)
  if (zero.length === 0) out.push('  (空)')
  for (const item of zero.sort((a, b) => a.rel.localeCompare(b.rel))) out.push(`  · ${item.rel}`)

  out.push('')
  out.push(`=== 口径外(出现在报告里但不属于分母,${outOfScope.length} 个) ===`)
  if (outOfScope.length === 0) out.push('  (空)')
  for (const rel of outOfScope.sort()) out.push(`  · ${rel}`)
  out.push('')

  return out.join('\n')
}

function takeInventory() {
  const seen = new Map()

  for (const root of ROOTS) {
    for (const abs of walk(join(CWD, root.dir), root)) {
      const rel = toRel(abs)
      if (seen.has(rel)) continue
      const kind = classify(rel)
      seen.set(rel, { rel, kind, reason: kind === 'ex1' ? '声明文件 *.d.ts' : '' })
    }
  }

  return [...seen.values()]
}

function walk(dir, root, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (root.recursive && !SKIP_DIRS.has(entry.name)) walk(full, root, out)
      continue
    }
    if (entry.isFile() && root.exts.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }

  return out
}

function classify(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (base.endsWith('.d.ts')) return 'ex1'
  if (/\.test\.tsx?$/.test(base)) return 'ex2'
  if (/\.config\./.test(base)) return 'ex3'
  return 'denominator'
}

/**
 * 「纯 type-only 文件」按排除项① 处置(与 *.d.ts 同类)。
 *
 * 判据用**机器证据**而不是眼看:经 esbuild 转译后产物为空 ⇒ 文件里没有任何运行时代码,
 * 它不可能有覆盖率、也不该占分母。
 * 🔴 这与「结构上不可覆盖的豁免项」是两回事,不许混:那种在分母里、确实没被覆盖、要写理由;
 *    这种压根不是可执行代码。只在**零覆盖**的候选上做判定 —— 有覆盖的文件当然不是 type-only。
 */
function reclassifyTypeOnly(inventory, reported) {
  let transformSync
  try {
    ;({ transformSync } = createRequire(import.meta.url)('esbuild'))
  } catch (err) {
    return `⚠️ esbuild 不可用(${err.message}),纯 type-only 文件未能自动归入排除①,请人工核对零覆盖清单。`
  }

  let moved = 0
  for (const item of inventory) {
    if (item.kind !== 'denominator' || reported.has(item.rel)) continue
    if (item.rel.endsWith('.mjs')) continue

    let code
    try {
      code = transformSync(readFileSync(join(CWD, item.rel), 'utf8'), {
        loader: item.rel.endsWith('.tsx') ? 'tsx' : 'ts',
        format: 'esm'
      }).code
    } catch {
      continue
    }

    if (code.replace(/\s+/g, '') !== '') continue
    item.kind = 'ex1'
    item.reason = '纯 type-only(esbuild 转译产物为空)'
    moved += 1
  }

  return moved > 0
    ? `(其中 ${moved} 个是纯 type-only 文件,由 esbuild 转译产物为空判定,非 *.d.ts)`
    : ''
}

function countByDir(items) {
  const byDir = new Map()
  for (const item of items) {
    const dir = item.rel.slice(0, item.rel.lastIndexOf('/') + 1)
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  return [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function writeRawArtifact(payload) {
  try {
    mkdirSync(join(CWD, 'coverage'), { recursive: true })
    writeFileSync(
      join(CWD, 'coverage', 'denominator.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    )
  } catch (err) {
    // 原始产物写不出不该让覆盖率跑失败 —— 控制台那份才是判据。
    console.error(`⚠️ coverage/denominator.json 写入失败:${err.message}`)
  }
}

function uncoveredRanges(lines) {
  if (!Array.isArray(lines)) return ''

  const ranges = []
  let start = null
  let prev = null

  for (const { line, count } of lines) {
    if (count === 0) {
      if (start === null) start = line
      prev = line
      continue
    }
    if (start !== null) ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = null
  }
  if (start !== null) ranges.push(start === prev ? `${start}` : `${start}-${prev}`)

  return ranges.join(' ')
}

function tableRow(file, line, branch, funcs, uncovered) {
  return (
    padEnd(file, 62) + padStart(line, 8) + padStart(branch, 10) + padStart(funcs, 9) + '  ' + uncovered
  )
}

function pct(value) {
  return typeof value === 'number' ? value.toFixed(2) : '—'
}

function padEnd(text, width) {
  return String(text).length >= width ? String(text) : String(text).padEnd(width)
}

function padStart(text, width) {
  return String(text).padStart(width)
}

function toRel(abs) {
  return relative(CWD, abs).replaceAll('\\', '/')
}
