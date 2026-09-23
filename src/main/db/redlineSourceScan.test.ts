/**
 * §7.3 / §7.4 红线里**结构性**的四条(R-7.3-d / R-7.3-f / R-7.4-a / R-7.4-b)—— 把原本只活在
 * 「人跑一次 grep」里的判据落成用例,让它们在 CI 里天天自己跑。
 *
 * 为什么这四条要用源码扫描而不是行为断言:它们说的都是「**某种东西永远不出现**」——
 * 「迁移 DDL 不引用 `schema.ts`」「`gid` 不进 db 层」「`.aria2` 不被读写解析」。这类命题没有
 * 可执行的正例可测,只能扫源码。
 *
 * 🔴 **四条共同的两个坑,本文件逐条都躲了**:
 *   ① **期望零命中的判据必须配正向对照** —— 否则「扫描器本身写错了 / 扫的目录里压根没有这个符号」
 *      与「真的零命中」输出一模一样,是恒真的空判据。本项目 v0.4 Task 7 就踩过「判据里的符号根本
 *      不在被搜目录下 ⇒ 恒零命中 ⇒ 恒真」。故每条零命中断言旁边都跟着一条**必然命中**的对照。
 *   ② **不许照抄「零命中」四个字** —— R-7.4-a 的 `.aria2` 在 `src/main/` 里**本来就有十几处命中**
 *      (注释 + `trashIfExists` 的删除调用),照抄成 `grep -rn "\.aria2" src/main/` 期望零命中
 *      会得到一次**恒定的假红**。红线原文是「不**读**、不**写**、不**解析**」,删除(用户主动删任务 /
 *      BT 完成收尾把残留移进回收站)是 ARCHITECTURE §7.4 与 taskManager 注释都明写允许的。
 *      故本文件判的是**用法**,不是**出现与否**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

const PROJECT_ROOT = resolve(__dirname, '../../..')
const DB_DIR = join(PROJECT_ROOT, 'src', 'main', 'db')
const MAIN_DIR = join(PROJECT_ROOT, 'src', 'main')

/** 递归收集目录下的**非测试** `.ts`(排除 `*.test.ts` / `*.d.ts`) */
function sourceFilesIn(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFilesIn(full))
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out.sort()
}

interface Hit {
  file: string
  line: number
  text: string
}

function scan(files: string[], pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((text, i) => {
      if (pattern.test(text)) {
        hits.push({ file: relative(PROJECT_ROOT, file).split(sep).join('/'), line: i + 1, text: text.trim() })
      }
    })
  }
  return hits
}

function render(hits: Hit[]): string {
  return hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n')
}

/** 是否是纯注释行(`//` 开头、块注释的 `*` 续行、或 `/*` 开头) */
function isCommentLine(text: string): boolean {
  return /^(\/\/|\*|\/\*)/.test(text.trim())
}

/**
 * 取一行的「代码面」:整行注释 → 空;行尾 `// …` 截掉(`://` 形态的 URL 不误截)。
 *
 * 🔴 **为什么所有「某符号不许出现」的判据都必须走这一层**:记录红线的注释里必然写着那个符号
 * (「本文件不引用 `TASKS_TABLE_SQL`」),扫全文等于**恒命中自己** —— 那是一次恒定的假红,
 * 而假红会把真红埋掉。
 */
function codeFace(text: string): string {
  if (isCommentLine(text)) return ''
  const idx = text.indexOf('//')
  if (idx <= 0) return idx === 0 ? '' : text
  return text[idx - 1] === ':' ? text : text.slice(0, idx)
}

/** 同 `scan`,但只看代码面(剔注释) */
function scanCode(files: string[], pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((text, i) => {
        const code = codeFace(text)
        if (code && pattern.test(code)) {
          hits.push({
            file: relative(PROJECT_ROOT, file).split(sep).join('/'),
            line: i + 1,
            text: code.trim()
          })
        }
      })
  }
  return hits
}

const DB_SOURCES = sourceFilesIn(DB_DIR)
const MAIN_SOURCES = sourceFilesIn(MAIN_DIR)
const MAIN_OUTSIDE_DB = MAIN_SOURCES.filter((f) => !f.startsWith(DB_DIR + sep))

test('前置:扫描面非空(证明下面所有零命中断言不是在扫一个空集合)', () => {
  assert.ok(DB_SOURCES.length >= 8, `src/main/db/ 非测试源文件 ≥ 8,实得 ${DB_SOURCES.length}`)
  assert.ok(MAIN_SOURCES.length > 50, `src/main/ 非测试源文件数量正常,实得 ${MAIN_SOURCES.length}`)
})

// ==================== R-7.3-d 迁移 DDL 字面自包含 ====================
//
// 迁移历史一经发布即为定值。若 v3 的重建 DDL 引用 `schema.ts::TASKS_TABLE_SQL`,schema 日后每演进
// 一次,这条**历史**迁移的行为就跟着漂移一次 —— 同一个存量库在不同版本的 DownLord 上会被迁成不同的表。

test('R-7.3-d 迁移 DDL 字面自包含:migration.ts 的**代码**里不引用 TASKS_TABLE_SQL', () => {
  // ⚠️ 判据只能扫**代码面**,不能扫全文。`migration.ts` 第 46 行的注释里就写着
  // 「不引用可变的 schema.ts::TASKS_TABLE_SQL」—— 记这条红线的注释对自己的 pattern
  // **天然不可能零命中**(本项目第三次踩到同一形态)。spec §2.2 与不变量卡写的
  // `grep -n "TASKS_TABLE_SQL" migration.ts ; 期望 exit=1` 因此**不可满足**,照字面执行会得到
  // 一次恒定的假红 —— 而假红会把真红埋掉。已记入交付说明。
  const hits = scanCode([join(DB_DIR, 'migration.ts')], /TASKS_TABLE_SQL/)
  assert.deepEqual(
    hits,
    [],
    `migration.ts 的代码里不得引用 TASKS_TABLE_SQL(迁移历史必须是定值,不随 schema.ts 漂移);实际:\n${render(hits)}`
  )
})

test('R-7.3-d 判据自检:代码面扫描确实能抓到一次真引用(而不是被注释过滤器一并吃掉)', () => {
  // 🔴 上一条把注释排除掉了 —— 那就必须证明「排除注释之后还抓得住代码」。
  // 否则 codeFace 若写成恒返回空串,上一条同样是绿的。
  const realReference = '      db.exec(TASKS_TABLE_SQL)'
  assert.ok(codeFace(realReference).length > 0, '代码行不会被 codeFace 吃成空串')
  assert.ok(/TASKS_TABLE_SQL/.test(codeFace(realReference)), '代码行里的真引用会被抓到')
  assert.equal(
    codeFace('    // **字面自包含**:不引用可变的 schema.ts::TASKS_TABLE_SQL——迁移历史一经发布即为定值,'),
    '',
    '注释行被正确剔除'
  )
})

test('R-7.3-d 的正向对照:TASKS_TABLE_SQL 确实存在于 schema.ts(判据不是在搜一个不存在的符号)', () => {
  // 🔴 缺这一条,上一条就是**恒真**的:符号若压根不在仓库里,任何文件里都搜不到它。
  const schemaSrc = readFileSync(join(DB_DIR, 'schema.ts'), 'utf8')
  assert.ok(schemaSrc.includes('TASKS_TABLE_SQL'), 'schema.ts 里确实定义着 TASKS_TABLE_SQL')
  assert.ok(
    /export const TASKS_TABLE_SQL/.test(schemaSrc),
    'TASKS_TABLE_SQL 是 schema.ts 的导出常量(即 migration.ts 一旦引用就能引用得到)'
  )
})

test('R-7.3-d 迁移不从 schema.ts 取任何 SQL 常量,且 v3 的重建 DDL 是字面量', () => {
  const migrationSrc = readFileSync(join(DB_DIR, 'migration.ts'), 'utf8')

  // 只允许取 `createTables`(v1 建表)与类型;任何 `*_SQL` 常量都不许进来
  const schemaImports = [...migrationSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/schema'/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.replace(/\btype\b/, '').trim())
    .filter(Boolean)
  assert.deepEqual(schemaImports, ['createTables', 'SchemaDatabase'], '仅从 schema.ts 取建表函数与类型')

  // v3 的表重建必须自己写全(字面量),不得是拼接来的
  assert.ok(migrationSrc.includes('CREATE TABLE tasks_new'), 'v3 的重建 DDL 以字面量写在 migration.ts 内')
  assert.ok(
    migrationSrc.includes("CHECK(kind IN ('http', 'video', 'torrent'))"),
    'v3 的 CHECK 约束同为字面量(不引用 schema.ts 的定义)'
  )
})

// ==================== R-7.3-f / R-7.4-b 运行时态不进 db 层 ====================

const RUNTIME_TOKENS = ['gid', 'limitKBps', 'headers', 'seeding', 'sniff']

test('R-7.3-f / R-7.4-b:五个运行时态符号在 src/main/db/ 全域零命中', () => {
  for (const token of RUNTIME_TOKENS) {
    const hits = scan(DB_SOURCES, new RegExp(token))
    assert.deepEqual(
      hits,
      [],
      `src/main/db/ 不得出现运行时态符号 ${token};实际命中:\n${render(hits)}`
    )
  }
})

test('R-7.3-f / R-7.4-b 的正向对照:同样五个符号在 src/main/ 的其余部分确实存在', () => {
  // 🔴 缺这一条,上一条会在「符号名拼错」时同样绿 —— 那正是本项目踩过的假绿灯形态。
  for (const token of RUNTIME_TOKENS) {
    const hits = scan(MAIN_OUTSIDE_DB, new RegExp(token))
    assert.ok(hits.length > 0, `正向对照:${token} 在 src/main/ 的 db 之外确实出现过(否则判据在搜空气)`)
  }
})

// ==================== R-7.4-a `.aria2` 不读、不写、不解析 ====================
//
// ⚠️ 判据形态是本条最容易写错的地方。文本命中有六类,前三类是**行为**:
//   ① `trashIfExists(savePath + '.aria2')` / `rmSync(...)` —— **删除**残留(用户主动删任务 / BT 完成
//      收尾 / 视频残片清理)。§7.4 与 taskManager 注释都明写允许:删除不是读 / 写 / 解析。
//   ② `name.endsWith('.aria2')` —— 按**文件名后缀**把残留识别出来(查重排除 / 清残留),不碰内容。
//   ③ 纯路径构造 / 存在性检查 —— 只为避让 data/control 占名,不碰内容。
//   ④ 注释与文档字符串;⑤ `mapError` 里给用户看的中文文案;⑥ `raw.aria2` 这种**属性名**误命中
//      (引擎版本映射,与控制文件毫无关系)。
// 故:扫描只看**代码面里的字符串字面量**(自动甩掉 ④⑥),再逐条分类(留下 ①②③⑤),
// 并单独断言「读 / 写 / 解析 API 与 `.aria2` 同行」零命中。

/** 读 / 写 / 解析类 API —— 与 `.aria2` 同行出现即视为破线 */
const READ_WRITE_PARSE =
  /\b(readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|openSync|readdirSync|JSON\.parse)\b/

/**
 * `.aria2` 出现在字符串字面量里、**且不是属性访问**。
 * 两个条件缺一不可(两次实测踩出来的):只要「在字符串里」会捞到
 * `` `…aria2=${engineVersionsCache.aria2}…` `` 这种模板串里的属性访问;只要「不是属性访问」
 * 又会捞到注释掉的文档文本。前一个字符必须是引号 / 反引号 / `}`,即**不是**标识符字符。
 */
const ARIA2_IN_STRING = /(['"`])[^'"`\n]*(?<![A-Za-z0-9_$])\.aria2/

// 2026-09-09 M-011:补入已核实的纯路径 / existsSync 用法,不是忽略整行关键词。
// 仅接受标识符属性链和当前三种整行形态;额外调用、不同路径、同行副作用仍未归类。
const PATH_REFERENCE = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const CONTROL_PATH_ONLY = [
  new RegExp(String.raw`^if \(!item && this\.fileExists\(${PATH_REFERENCE} \+ '\.aria2'\)\) \{$`),
  new RegExp(String.raw`^return \[(${PATH_REFERENCE}), \1 \+ '\.aria2'\]$`),
  new RegExp(String.raw`^this\.fileExists\(${PATH_REFERENCE} \+ '\.aria2'\) \|\|$`)
]

function isControlPathOrExistenceCheck(text: string): boolean {
  return CONTROL_PATH_ONLY.some((pattern) => pattern.test(text))
}

test('R-7.4-a:`.aria2` 在 src/main/ 的每一处**代码**命中,都不是读 / 写 / 解析', () => {
  const hits = scanCode(MAIN_SOURCES, ARIA2_IN_STRING)

  // 正向对照①:确实扫到了东西。一处都扫不到时,下面的分类断言全部恒真。
  assert.ok(hits.length > 0, '正向对照:src/main/ 的代码里确实存在 `.aria2` 字符串字面量')

  const readWriteParse = hits.filter((h) => READ_WRITE_PARSE.test(h.text))
  assert.deepEqual(
    readWriteParse,
    [],
    `.aria2 不得被读 / 写 / 解析(字节级进度与续传全归 aria2);实际:\n${render(readWriteParse)}`
  )

  // 剩下的必须落进四类:删除残留 / 后缀识别 / 用户可见文案 / 纯路径与存在性检查
  const isDelete = (t: string): boolean => /trashIfExists|rmSync|unlink/.test(t)
  const isSuffixTest = (t: string): boolean => /endsWith\(|includes\(|startsWith\(/.test(t)
  const isUserFacingText = (t: string): boolean => /残留后重试/.test(t)
  const unclassified = hits.filter(
    (h) =>
      !isDelete(h.text) &&
      !isSuffixTest(h.text) &&
      !isUserFacingText(h.text) &&
      !isControlPathOrExistenceCheck(h.text)
  )
  assert.deepEqual(
    unclassified,
    [],
    `.aria2 的每处代码命中都应是删除残留 / 后缀识别 / 用户文案 / 纯路径与存在性检查;未归类的:\n${render(unclassified)}`
  )

  // 正向对照②:分类器真的在分类,而不是所有行都掉进同一个桶
  assert.ok(hits.some((h) => isDelete(h.text)), '正向对照:确有 `.aria2` 的删除调用(§7.4 允许)')
  assert.ok(hits.some((h) => isSuffixTest(h.text)), '正向对照:确有 `.aria2` 的后缀识别')
  assert.ok(
    hits.some((h) => isControlPathOrExistenceCheck(h.text)),
    '正向对照:确有 `.aria2` 的纯路径构造 / 存在性检查'
  )
})

test('R-7.4-a 判据自检:同一条规则拿到「读 .aria2」的样本行时确实会判违规', () => {
  // 🔴 上一条断言的是「没有命中」。这条证明那个检测器**抓得住**它该抓的东西 ——
  // 否则规则写错(比如漏了词边界、正则永不匹配)时,上一条会永远是绿的。
  const samples = [
    "const raw = readFileSync(task.savePath + '.aria2')",
    "const ctrl = JSON.parse(fs.readFileSync(p + '.aria2', 'utf8'))",
    'createReadStream(`${savePath}.aria2`)'
  ]
  for (const sample of samples) {
    assert.ok(READ_WRITE_PARSE.test(sample), `样本应被判为读 / 写 / 解析:${sample}`)
    assert.ok(ARIA2_IN_STRING.test(sample), `样本应被 .aria2 扫描命中:${sample}`)
  }
  assert.ok(
    !READ_WRITE_PARSE.test("await this.trashIfExists(task.savePath + '.aria2')"),
    '反面对照:允许的删除调用不被误判为读 / 写 / 解析'
  )
  assert.ok(
    !ARIA2_IN_STRING.test('aria2: (raw.aria2 ? parseAria2Version(raw.aria2) : null)'),
    '反面对照:`raw.aria2` 这种属性访问不被当成控制文件名'
  )
  assert.ok(
    !ARIA2_IN_STRING.test('`[binaries] 引擎版本探测: aria2=${engineVersionsCache.aria2}`'),
    '反面对照:模板串里的属性访问同样不被当成控制文件名'
  )
})

test('R-7.4-a 纯路径分类:三种现用的路径构造 / 存在性检查可被识别', () => {
  const samples = [
    "if (!item && this.fileExists(task.savePath + '.aria2')) {",
    "return [path, path + '.aria2']",
    "this.fileExists(path + '.aria2') ||"
  ]
  for (const sample of samples) {
    assert.ok(ARIA2_IN_STRING.test(sample), '正向对照:仍进入原控制文件扫描')
    assert.ok(!READ_WRITE_PARSE.test(sample), '不含读 / 写 / 解析 API')
    assert.ok(isControlPathOrExistenceCheck(sample), sample)
  }
})

test('R-7.4-a 纯路径分类:嵌套或同行的读 / 写 / 解析仍被原禁止规则抓住', () => {
  const samples = [
    "if (!item && this.fileExists(readFileSync(path + '.aria2'))) {",
    "this.fileExists(JSON.parse(raw) + '.aria2') ||",
    "return [path, path + '.aria2']; writeFileSync(out, raw)",
    "this.fileExists(path + '.aria2') || appendFileSync(out, raw)",
    "return [path, readFileSync(path + '.aria2')]"
  ]
  for (const sample of samples) {
    assert.ok(ARIA2_IN_STRING.test(sample), '仍进入原控制文件扫描')
    assert.ok(READ_WRITE_PARSE.test(sample), '原禁止 API 断言仍会拒绝')
    assert.ok(!isControlPathOrExistenceCheck(sample), sample)
  }
})

test('R-7.4-a 纯路径分类:未知调用 / 混合语句 / 不同路径不被新类别放过', () => {
  const samples = [
    "consume(path + '.aria2')",
    "this.fileExists(path + '.aria2') || consume(path)",
    "if (!item && this.fileExists(path + '.aria2')) { consume(path)",
    "return [path, path + '.aria2']; consume(path)",
    "return [path, other + '.aria2']",
    "return [path, makePath() + '.aria2']",
    "return [path, path + '.aria2', consume(path)]",
    "if (consume(item) && this.fileExists(path + '.aria2')) {",
    "return [path, path + '.aria2']\nconsume(path)"
  ]
  for (const sample of samples) {
    assert.ok(ARIA2_IN_STRING.test(sample), '未知用法仍进入原控制文件扫描')
    assert.ok(!isControlPathOrExistenceCheck(sample), sample)
  }
})

// ==================== `src/main/db/` 不碰引擎控制文件 ====================

test('R-7.4-a 补强:db 层完全不提及 .aria2 / .part 之类的引擎控制文件名', () => {
  const pattern = /(['"`])[^'"`\n]*\.(aria2|part)\b/
  const hits = scan(DB_SOURCES, pattern)
  assert.deepEqual(hits, [], `db 层不得提及引擎控制文件;实际:\n${render(hits)}`)

  // 正向对照:同一 pattern 在 src/main/ 其余部分有命中(证明 pattern 本身能匹配到东西)
  assert.ok(scan(MAIN_OUTSIDE_DB, pattern).length > 0, '正向对照:pattern 在 db 之外确有命中')
})

test('前置:被扫的都是真文件(排除项没把整个目录排空)', () => {
  for (const file of DB_SOURCES) {
    assert.ok(statSync(file).size > 0, `${relative(PROJECT_ROOT, file)} 非空`)
  }
})
