/**
 * TODO 指派的双向关联审计(v0.4 Task 4 Phase 3 后立 · 2026-08-03)。
 *
 * **它防的是什么**:`docs/TODO.md` 里写「🚧 指派:v0.4 Task 7」是一个**单向指针** ——
 * TODO 知道该找谁,但被指派的那个 prompt **不知道有人在等它**。写 prompt 的人不会因为
 * 「某处 backlog 指了过来」就想起回头翻 TODO,于是条目静默失踪。
 *
 * **实证(2026-08-03 全量核对)**:7 条指派里 5 条双向、2 条单向,而那 2 条(#52 / #54)
 * **恰好都是执行期开的**。根因不是纪律松懈,是**时序**:
 * - **规划期**开的条目(#32/#33/#11/#12/#23/#43/#44)——先有 TODO 再写 prompt,写的时候自然会引用它 → 天然双向;
 * - **执行期**开的条目(#52/#54)——prompt 早就写完了才发现问题,**没人回头改 prompt** → 必然单向。
 * 指派方向与写作方向相反时,单向指针不是意外,是默认结果。故它必须由机器查,不能靠人记。
 *
 * **判据**:每一条带「指派」且状态为 🚧(未完成)的 TODO 条目,其目标 Task 的 prompt 文件里
 * 必须出现该条编号。三种结果:
 * - ✅ 双向 —— prompt 认领了它;
 * - ⏳ 待认领 —— 目标 prompt **还不存在**(指派给了尚未开写的 Task)。**不算失败**,
 *   但会列出来提醒:写那个 prompt 的第一件事就是把它接进去(见 CLAUDE.md 记账纪律)。
 * - ❌ 单向 —— 目标 prompt 存在却**没提到**该编号。**这是失败**,退出码 1。
 *
 * 用法:npm run audit:todo
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const TODO = join(ROOT, 'docs', 'TODO.md')

/** 条目标题行:`### 52. 标题 — 状态…` */
const HEADING = /^### (\d+)\.\s*(.*)$/
/** 指派目标:`v0.4 Task 7` / `v0.4 Task 4 Phase 4` */
const ASSIGN = /(v\d+\.\d+)\s*Task\s*(\d+)/

/**
 * 已完成 / 决议不做的条目不参与审计(指针指向哪里都无所谓)。
 *
 * ⚠️ **「有 ✅」不等于「done」** —— 一条 backlog 可以**部分**完成:#52 就是 ① 已修、② 还没做。
 *    首版只判 `includes('✅')`,于是给它标上 ① 的 ✅ 那一刻,**整条**连同没做完的 ② 一起
 *    从审计里静默消失了(2026-08-04 改写 #52 时实际撞到,当场发现)。故只要标题里还有 🚧,
 *    这一条就仍未完成 —— **未完成的那半才是审计要盯的东西**。
 */
function isDone(title) {
  if (title.includes('🚧')) return false
  return title.includes('✅') || title.includes('🚫')
}

/**
 * 找出这一条到底**指派**给了谁。
 *
 * ⚠️ **判据必须收窄到「指派语」,不能只看有没有出现 `Task N`** —— 首版判据就是只搜 `Task N`,
 *    结果 8 条全红,逐条看才发现 TODO.md 里「v0.4 Task 3」有**两种完全相反的含义**:
 *    - **指派**:`🚧 **v0.4 Task 7 指派**` / `🚧 v0.4 Task 6 立项` / `- **后续落点**:v0.4 Task 4 Phase 4`
 *    - **来源**:`待评估(v0.4 Task 3 明确不做 · 收口提取)` —— 说的是**谁决定不做的**,没指派给任何人
 *    把后者当指派,审计会对着一堆「本来就没人该做」的条目报红,红久了就没人看了(假红把真红埋掉)。
 *    这个假红本身钉死了一个事实,故如实收窄、并把理由写在这里,不是把它「改绿了事」。
 *
 * 只认两处:①标题行同时有 `🚧` 与「指派 / 立项」 ②正文的「后续落点」行。
 */
function findAssignment(titleLine, body) {
  const assigning = []
  if (titleLine.includes('🚧') && /指派|立项/.test(titleLine)) assigning.push(titleLine)
  assigning.push(...body.filter((l) => /^[-*]\s*\*\*后续落点\*\*/.test(l)))

  for (const line of assigning) {
    const m = ASSIGN.exec(line)
    if (m) return { version: m[1], task: Number(m[2]) }
  }
  return null
}

/**
 * 一个 Task 的 **全部** prompt 文件(2026-08-19 修正)。
 *
 * ⚠️ **原实现用 `.find()` 只取第一个** —— 它默认「一个 Task 一份 prompt」,而这个前提
 * 在 v0.4 Task 6 加出 `task6-step5b-*.md` 时当场破掉:条目**已经**被 Step 5b 的 prompt
 * 认领了,审计却因为只看见字典序靠前的那份而报「单向指针」。
 * **那是一条假红,而假红会把真红埋掉** —— 与本脚本首版「只搜 `Task N`」踩的是同一个坑。
 * 故改为**扫全部匹配文件,任一命中即算双向**。
 */
function promptPathsFor(version, task) {
  const dir = join(ROOT, 'docs', version, 'prompt')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => new RegExp(`^task${task}-.*\\.md$`).test(f))
    .map((f) => join(dir, f))
}

// ── 解析 TODO.md ─────────────────────────────────────────────────────────
const lines = readFileSync(TODO, 'utf8').split(/\r?\n/)
const entries = []
let current = null
for (const line of lines) {
  const m = HEADING.exec(line)
  if (m) {
    if (current) entries.push(current)
    current = { id: Number(m[1]), title: m[2], titleLine: line, body: [] }
    continue
  }
  if (current) current.body.push(line)
}
if (current) entries.push(current)

// ── 审计 ─────────────────────────────────────────────────────────────────
const twoWay = []
const pending = []
const oneWay = []

for (const e of entries) {
  if (isDone(e.title)) continue
  const target = findAssignment(e.titleLine, e.body)
  if (!target) continue // 没指派具体 Task(待评估 / 长期)—— 不在本审计范围

  const label = `#${e.id} → ${target.version} Task ${target.task}`
  const paths = promptPathsFor(target.version, target.task)
  if (paths.length === 0) {
    pending.push({ label, note: `${target.version}/prompt/task${target.task}-*.md 尚不存在` })
    continue
  }
  // 编号在 prompt 里的写法:`#52` 或 `TODO 52`(两种既有写法都认)
  const cite = new RegExp(`#${e.id}\\b|TODO[^\\n]{0,8}\\b${e.id}\\b`)
  const hit = paths.find((p) => cite.test(readFileSync(p, 'utf8')))
  if (hit) twoWay.push({ label, path: hit })
  else oneWay.push({ label, path: paths.join(' / ') })
}

// ── 报告 ─────────────────────────────────────────────────────────────────
console.log(`TODO 指派双向关联审计(共 ${entries.length} 条条目)\n`)

if (twoWay.length > 0) {
  console.log(`✅ 双向关联 ${twoWay.length} 条:`)
  for (const x of twoWay) console.log(`   ${x.label}`)
  console.log()
}

if (pending.length > 0) {
  console.log(`⏳ 待认领 ${pending.length} 条(目标 prompt 尚未撰写 —— 不算失败):`)
  for (const x of pending) console.log(`   ${x.label}   ${x.note}`)
  console.log(
    `   → 撰写该 prompt 时的第一件事:grep 一遍 TODO 把这些条目接进去(CLAUDE.md 记账纪律)\n`
  )
}

if (oneWay.length > 0) {
  console.log(`❌ 单向指针 ${oneWay.length} 条(TODO 指了过去,prompt 却没认领):`)
  for (const x of oneWay) {
    console.log(`   ${x.label}`)
    console.log(`     目标存在却零命中:${x.path.replace(ROOT, '.')}`)
  }
  console.log(`\n   → 修法:把该条目的**事实内联**进目标 prompt 的代码块(不是给个链接 ——`)
  console.log(
    `     prompt 代码块必须自包含,执行方看不到块外的东西),并在节首标注「认领的 backlog」。`
  )
  process.exit(1)
}

console.log('✅ 无单向指针')
