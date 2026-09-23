// scripts/release/checks.mjs
// 候选阶段检查(owner = 6b 的 11 项):候选边界 / 内部标记 / 候选敏感扫描 / 本地链接 / 外链证据 /
// 公开 Git 元数据 / 版本契约 / 内部门禁证据 / 验证差额 / 许可材料 / 人工审阅证据。
// 只读:遍历真实候选目录、读取 evidence/ 下的记录、通过只读 Git 适配器查公开仓库;唯一写入是
// evidence/<name>.<run-id>.json(wx,永不覆盖)。不含打包 / 提交 / 推送 / 网络探测 / 改基准能力。
// 规则唯一真源是 policy(scripts/release-policy.json);本文件不抄任何剥离 / 标记字面量。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { STATUS, redactValue, stableJson } from './report.mjs'
import { classifyPath, commitChain, listTags } from './source.mjs'

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')
const R = (id, status, reasonCode = null, detail = null) => ({ id, status, reasonCode, detail })
const cap = (arr, n = 50) => (arr.length > n ? [...arr.slice(0, n), `…(+${arr.length - n})`] : arr)
const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

// ── 候选内容读取 ─────────────────────────────────────────────────────────────
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|exe|dll|zip|7z|gz|tgz|rar|pdf|woff2?|ttf|otf|eot|db|sqlite|asar|node|wasm|mp4|mkv|webm|mp3|m4a|torrent)$/i
export const isBinaryPath = (p) => BINARY_EXT.test(p)
export const looksBinary = (buf) => buf.includes(0)

/** 从候选目录读全部文件为 Map<POSIX path, Buffer>(按字节序);链接 / .git 记异常。 */
export function loadCandidateFiles(candidateDir) {
  const files = new Map()
  const anomalies = []
  const walk = (dir, rel) => {
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      anomalies.push({ path: rel || '.', kind: 'unreadable-directory', code: e.code ?? null })
      return
    }
    for (const d of dirents) {
      const abs = path.join(dir, d.name)
      const relPath = rel ? `${rel}/${d.name}` : d.name
      let st
      try {
        st = fs.lstatSync(abs)
      } catch {
        anomalies.push({ path: relPath, kind: 'unreadable' })
        continue
      }
      if (st.isSymbolicLink()) {
        anomalies.push({ path: relPath, kind: 'symlink-or-reparse-point' })
        continue
      }
      if (st.isDirectory()) {
        if (d.name.toLowerCase() === '.git') {
          anomalies.push({ path: relPath, kind: 'git-directory' })
          continue
        }
        walk(abs, relPath)
        continue
      }
      if (!st.isFile()) {
        anomalies.push({ path: relPath, kind: 'not-regular-file' })
        continue
      }
      try {
        files.set(relPath, fs.readFileSync(abs))
      } catch (e) {
        anomalies.push({ path: relPath, kind: 'unreadable', code: e.code ?? null })
      }
    }
  }
  walk(candidateDir, '')
  const sorted = new Map([...files.entries()].sort((a, b) => compareUtf8(a[0], b[0])))
  return { files: sorted, anomalies }
}

// ── candidate-boundary ───────────────────────────────────────────────────────
export function checkCandidateBoundary({ policy, files, anomalies }) {
  const residue = []
  const forbidden = []
  const caseVariants = []
  for (const p of files.keys()) {
    const cls = classifyPath(p, policy)
    if (cls.stripped) residue.push({ path: p, rule: cls.stripped.id })
    if (cls.forbidden) forbidden.push({ path: p, rule: cls.forbidden.id })
    if (cls.caseVariantOf) caseVariants.push({ path: p, rule: cls.caseVariantOf.id })
  }
  const gitDirs = anomalies.filter((a) => a.kind === 'git-directory')
  const otherAnomalies = anomalies.filter((a) => a.kind !== 'git-directory')
  const rt = policy.requiredTargets
  const missingFiles = rt.files.filter((f) => !files.has(f))
  const shortDirs = []
  for (const d of rt.directories) {
    let n = 0
    for (const p of files.keys()) if (p.startsWith(d.path)) n++
    if (n < d.minEntries)
      shortDirs.push({ directory: d.path, entries: n, minEntries: d.minEntries })
  }
  const sub = []
  sub.push(
    residue.length || caseVariants.length
      ? R(
          'no-strip-residue',
          STATUS.FAIL,
          residue.length ? 'STRIP_RESIDUE' : 'CASE_VARIANT_OF_RULE_PATH',
          {
            residue: cap(residue),
            caseVariants: cap(caseVariants)
          }
        )
      : R('no-strip-residue', STATUS.PASS, null, { checkedEntries: files.size })
  )
  sub.push(
    missingFiles.length || shortDirs.length
      ? R(
          'required-targets-present',
          STATUS.FAIL,
          missingFiles.length ? 'REQUIRED_TARGET_MISSING' : 'REQUIRED_DIRECTORY_SHORT',
          {
            missingFiles: cap(missingFiles),
            shortDirectories: shortDirs
          }
        )
      : R('required-targets-present', STATUS.PASS, null, {
          files: rt.files.length,
          directories: rt.directories.length
        })
  )
  sub.push(
    forbidden.length || otherAnomalies.length
      ? R(
          'no-forbidden-paths',
          STATUS.FAIL,
          forbidden.length ? 'FORBIDDEN_PATH_PRESENT' : 'CANDIDATE_ANOMALY',
          {
            forbidden: cap(forbidden),
            anomalies: cap(otherAnomalies)
          }
        )
      : R('no-forbidden-paths', STATUS.PASS)
  )
  sub.push(
    gitDirs.length
      ? R('no-git-directory', STATUS.FAIL, 'GIT_DIRECTORY_PRESENT', {
          paths: gitDirs.map((g) => g.path)
        })
      : R('no-git-directory', STATUS.PASS)
  )
  return {
    subchecks: sub,
    evidenceBody: {
      entries: files.size,
      residue,
      caseVariants,
      forbidden,
      missingFiles,
      shortDirectories: shortDirs,
      anomalies
    }
  }
}

// ── internal-markers ─────────────────────────────────────────────────────────
const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'css',
  'json',
  'yml',
  'yaml',
  'toml',
  'ffpreset',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'prettierignore',
  'prettierrc'
])
function extOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  return base.slice(dot + 1).toLowerCase()
}
/** 文本面:code(源码 / 规则 / 配置)· prose(Markdown 与其余文本)。 */
export function textFace(p) {
  const ext = extOf(p)
  if (ext === 'md') return 'prose'
  if (CODE_EXT.has(ext)) return 'code'
  return 'prose'
}
const NOT_BOUNDARY = /[A-Za-z0-9_-]/
/** 边界感知的字面命中:前一字符不是路径 / 标识符字符(npm 包名 electron-publish 的目录不命中覆盖目录标记);token 类还要求后一字符也不是。 */
export function findMarkerOccurrences(text, marker) {
  const out = []
  let i = 0
  for (;;) {
    const idx = text.indexOf(marker.value, i)
    if (idx < 0) break
    i = idx + 1
    const before = idx > 0 ? text[idx - 1] : ''
    if (before && NOT_BOUNDARY.test(before)) continue
    if (marker.kind === 'token') {
      const after = text[idx + marker.value.length] ?? ''
      if (after && NOT_BOUNDARY.test(after)) continue
    }
    out.push(idx)
  }
  return out
}
function lineOf(text, idx) {
  let n = 1
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
function lineStartIdx(text, idx) {
  const s = text.lastIndexOf('\n', idx - 1)
  return s + 1
}
const JS_LIKE = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs'])
const HASH_LIKE = new Set(['yml', 'yaml', 'toml', 'ffpreset', 'editorconfig', 'prettierrc'])
const IGNORE_LIKE = new Set(['gitignore', 'gitattributes', 'prettierignore'])
/**
 * 语法位置分词:返回 idx → 'comment' | 'string' | 'ignore-rule' | 'code'。
 * JS 类:// 与斜杠星号注释、' " ` 字符串(模板整体按字符串);CSS:块注释与字符串;
 * 井号类:# 行注释;忽略文件:# 行注释,其余非空行整行是忽略规则。正则字面量不单独识别。
 */
export function positionClassifier(text, filePath) {
  const ext = extOf(filePath)
  const kinds = new Uint8Array(text.length) // 0 code · 1 comment · 2 string · 3 ignore-rule
  const fill = (a, b, k) => {
    for (let i = a; i < b && i < kinds.length; i++) kinds[i] = k
  }
  if (JS_LIKE.has(ext) || ext === 'css') {
    let i = 0
    const n = text.length
    while (i < n) {
      const c = text[i]
      const d = text[i + 1]
      if (c === '/' && d === '/' && ext !== 'css') {
        const e = text.indexOf('\n', i)
        const end = e < 0 ? n : e
        fill(i, end, 1)
        i = end
        continue
      }
      if (c === '/' && d === '*') {
        const e = text.indexOf('*/', i + 2)
        const end = e < 0 ? n : e + 2
        fill(i, end, 1)
        i = end
        continue
      }
      if (c === "'" || c === '"' || (c === '`' && ext !== 'css')) {
        let j = i + 1
        while (j < n) {
          if (text[j] === '\\') {
            j += 2
            continue
          }
          if (text[j] === c) break
          if (c !== '`' && text[j] === '\n') break
          j++
        }
        fill(i, Math.min(j + 1, n), 2)
        i = j + 1
        continue
      }
      i++
    }
  } else if (HASH_LIKE.has(ext) || IGNORE_LIKE.has(ext) || ext === '') {
    let ls = 0
    while (ls < text.length) {
      let le = text.indexOf('\n', ls)
      if (le < 0) le = text.length
      const line = text.slice(ls, le)
      const t = line.trim()
      if (t.startsWith('#')) fill(ls, le, 1)
      else if (IGNORE_LIKE.has(ext) && t.length) fill(ls, le, 3)
      else {
        const h = line.search(/(^|\s)#/)
        if (h >= 0 && HASH_LIKE.has(ext)) fill(ls + h, le, 1)
        for (const q of ["'", '"']) {
          let a = line.indexOf(q)
          while (a >= 0) {
            const b = line.indexOf(q, a + 1)
            if (b < 0) break
            fill(ls + a, ls + b + 1, 2)
            a = line.indexOf(q, b + 1)
          }
        }
      }
      ls = le + 1
    }
  } else if (ext === 'html' || ext === 'svg') {
    let i = 0
    for (;;) {
      const a = text.indexOf('<!--', i)
      if (a < 0) break
      const b = text.indexOf('-->', a + 4)
      const end = b < 0 ? text.length : b + 3
      fill(a, end, 1)
      i = end
    }
  }
  return (idx) => ['code', 'comment', 'string', 'ignore-rule'][kinds[idx] ?? 0]
}
/** JSON 字符串位置:轻量解析器记录每个字符串 token 的 [start,end) 与 JSON pointer。解析失败抛错。 */
export function jsonStringPositions(text) {
  const out = []
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const fail = (m) => {
    throw new Error(`JSON position parse failed at ${i}: ${m}`)
  }
  const str = () => {
    const start = i
    if (text[i] !== '"') fail('expected string')
    i++
    let v = ''
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const e = text[i + 1]
        if (e === 'u') {
          v += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
          continue
        }
        v += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[e] ?? e
        i += 2
        continue
      }
      v += text[i++]
    }
    if (text[i] !== '"') fail('unterminated string')
    i++
    return { start, end: i, value: v }
  }
  const esc = (k) => k.replace(/~/g, '~0').replace(/\//g, '~1')
  const value = (pointer) => {
    ws()
    const c = text[i]
    if (c === '"') {
      const t = str()
      out.push({ ...t, pointer, isKey: false })
      return
    }
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        ws()
        const k = str()
        const p = `${pointer}/${esc(k.value)}`
        out.push({ ...k, pointer: p, isKey: true })
        ws()
        if (text[i] !== ':') fail('expected colon')
        i++
        value(p)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return
        }
        fail('expected , or }')
      }
    }
    if (c === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      let idx = 0
      for (;;) {
        value(`${pointer}/${idx++}`)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return
        }
        fail('expected , or ]')
      }
    }
    const m = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!m) fail('unexpected token')
    i += m[0].length
  }
  value('')
  ws()
  if (i !== text.length) fail('trailing content')
  return out
}
/** 标题下的行号区间(`section` 为标题子串)。 */
function sectionRange(text, section) {
  const lines = text.split('\n')
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (!m) continue
    if (start < 0) {
      if (m[2].includes(section)) {
        start = i + 1
        level = m[1].length
      }
    } else if (m[1].length <= level) return [start, i]
  }
  return start < 0 ? null : [start, lines.length]
}
const POSITION_KINDS = new Set([
  'json-pointer',
  'named-case-data',
  'registry-file-field',
  'code-comment',
  'string-literal',
  'ignore-rule',
  'prose-term'
])
export function validateLiteralPositions(positions) {
  const errors = []
  if (!Array.isArray(positions)) return ['allowedLiteralPositions-not-array']
  for (const p of positions) {
    if (!p || typeof p.file !== 'string' || p.file.endsWith('/'))
      errors.push('position-file-invalid')
    if (!Array.isArray(p.positions) || p.positions.length === 0)
      errors.push(`position-kinds-missing:${p && p.file}`)
    else
      for (const k of p.positions)
        if (!POSITION_KINDS.has(k)) errors.push(`position-kind-unknown:${k}`)
    if (!Array.isArray(p.markers) || p.markers.length === 0)
      errors.push(`position-markers-missing:${p && p.file}`)
    if (p.positions?.includes('json-pointer') && !Array.isArray(p.jsonPointerPrefixes))
      errors.push(`position-json-pointers-missing:${p && p.file}`)
    if (
      p.positions?.includes('prose-term') &&
      (!Number.isInteger(p.maxOccurrences) || typeof p.section !== 'string')
    )
      errors.push(`position-prose-term-shape:${p && p.file}`)
    if ('wholeFile' in (p ?? {})) errors.push('position-whole-file')
  }
  return errors
}

/**
 * 内部标记检查。prose 面(Markdown 等)零命中;code 面每处命中必须落在 policy 声明的精确位置。
 * 敏感规则不在这里,也不因这些位置豁免。
 */
export function checkInternalMarkers({ policy, files }) {
  const im = policy.internalMarkers
  const posErrors = validateLiteralPositions(im.allowedLiteralPositions)
  if (posErrors.length)
    return {
      subchecks: [
        R('prose-clean', STATUS.ERROR, 'POSITION_SCHEMA_INVALID', { errors: posErrors }),
        R('literal-positions-only', STATUS.ERROR, 'POSITION_SCHEMA_INVALID', {
          errors: posErrors
        })
      ],
      evidenceBody: { errors: posErrors }
    }
  const positionsByFile = new Map()
  for (const p of im.allowedLiteralPositions) {
    if (!positionsByFile.has(p.file)) positionsByFile.set(p.file, [])
    positionsByFile.get(p.file).push(p)
  }
  const proseHits = []
  const codeUnallowed = []
  const allowed = []
  const skipped = []
  const parseErrors = []
  let scannedFiles = 0
  const usedPositions = new Set()
  const registryRange = (text) => {
    const start = text.indexOf('const ADJUDICATED = [')
    if (start < 0) return null
    const end = text.indexOf('\n]', start)
    return end < 0 ? null : [start, end]
  }
  for (const [file, buf] of files) {
    if (isBinaryPath(file) || looksBinary(buf)) {
      skipped.push({ path: file, reason: isBinaryPath(file) ? 'binary-path' : 'binary-content' })
      continue
    }
    scannedFiles++
    const text = buf.toString('utf8')
    const face = textFace(file)
    const decls = positionsByFile.get(file) ?? []
    let classify = null
    let jsonTable = null
    let jsonError = null
    for (const marker of im.markers) {
      const occ = findMarkerOccurrences(text, marker)
      if (occ.length === 0) continue
      const decl = decls.filter((d) => d.markers.includes(marker.id) || d.markers.includes('*'))
      for (const idx of occ) {
        const line = lineOf(text, idx)
        const hit = { path: file, line, marker: marker.id }
        if (face === 'prose') {
          const pt = decl.find((d) => d.positions.includes('prose-term'))
          if (pt) {
            const range = sectionRange(text, pt.section)
            const inSection = range && line - 1 >= range[0] && line - 1 < range[1]
            const already = allowed.filter((x) => x.path === file && x.marker === marker.id).length
            if (inSection && already < pt.maxOccurrences) {
              allowed.push({ ...hit, position: 'prose-term', section: pt.section })
              usedPositions.add(`${file}|prose-term`)
              continue
            }
            proseHits.push({
              ...hit,
              reason: inSection ? 'PROSE_TERM_EXCEEDED' : 'PROSE_TERM_OUTSIDE_SECTION'
            })
            continue
          }
          proseHits.push(hit)
          continue
        }
        if (extOf(file) === 'json') {
          if (!jsonTable && !jsonError) {
            try {
              jsonTable = jsonStringPositions(text)
            } catch (e) {
              jsonError = e.message
              parseErrors.push({ path: file, error: e.message })
            }
          }
          if (jsonError) {
            codeUnallowed.push({ ...hit, position: 'json', reason: 'JSON_UNPARSEABLE' })
            continue
          }
          const tok = jsonTable.find((t) => idx >= t.start && idx < t.end)
          const jp = decl.find((d) => d.positions.includes('json-pointer'))
          const under =
            tok &&
            jp &&
            jp.jsonPointerPrefixes.some(
              (pre) => tok.pointer === pre || tok.pointer.startsWith(pre + '/')
            )
          if (under) {
            allowed.push({ ...hit, position: 'json-pointer', pointer: tok.pointer })
            usedPositions.add(`${file}|json-pointer`)
          } else
            codeUnallowed.push({
              ...hit,
              position: tok ? 'json-string' : 'json-structure',
              pointer: tok?.pointer ?? null,
              reason: jp ? 'JSON_POINTER_OUTSIDE_ALLOWED' : 'NO_DECLARED_POSITION'
            })
          continue
        }
        if (!classify) classify = positionClassifier(text, file)
        const syn = classify(idx)
        let ok = null
        for (const d of decl) {
          if (d.positions.includes('code-comment') && syn === 'comment') ok = 'code-comment'
          else if (
            d.positions.includes('named-case-data') &&
            (syn === 'string' || syn === 'comment')
          )
            ok = 'named-case-data'
          else if (d.positions.includes('string-literal') && syn === 'string') ok = 'string-literal'
          else if (d.positions.includes('ignore-rule') && syn === 'ignore-rule') ok = 'ignore-rule'
          else if (d.positions.includes('registry-file-field') && syn === 'string') {
            const rr = registryRange(text)
            const lineText = text.slice(lineStartIdx(text, idx), idx)
            if (rr && idx > rr[0] && idx < rr[1] && /^\s*file:\s*['"]/.test(lineText))
              ok = 'registry-file-field'
          }
          if (ok) break
        }
        if (ok) {
          allowed.push({ ...hit, position: ok })
          usedPositions.add(`${file}|${ok}`)
        } else
          codeUnallowed.push({
            ...hit,
            position: syn,
            reason: decl.length ? 'POSITION_NOT_DECLARED' : 'NO_DECLARED_POSITION'
          })
      }
    }
  }
  // 声明了却零命中的位置:登记腐烂,报告但不阻断(它防的是被遗忘的豁免口子)
  const unusedDeclarations = im.allowedLiteralPositions
    .filter((p) => files.has(p.file))
    .filter((p) => !p.positions.some((k) => usedPositions.has(`${p.file}|${k}`)))
    .map((p) => p.file)
  const sub = []
  sub.push(
    parseErrors.length
      ? R('prose-clean', STATUS.ERROR, 'PARSE_ERROR', { parseErrors })
      : proseHits.length
        ? R('prose-clean', STATUS.FAIL, 'INTERNAL_MARKER_IN_PROSE', { hits: cap(proseHits) })
        : R('prose-clean', STATUS.PASS, null, { scannedFiles, skipped: skipped.length })
  )
  sub.push(
    parseErrors.length
      ? R('literal-positions-only', STATUS.ERROR, 'PARSE_ERROR', { parseErrors })
      : codeUnallowed.length
        ? R('literal-positions-only', STATUS.FAIL, 'INTERNAL_MARKER_OUTSIDE_DECLARED_POSITION', {
            hits: cap(codeUnallowed)
          })
        : R('literal-positions-only', STATUS.PASS, null, {
            allowedOccurrences: allowed.length,
            unusedDeclarations
          })
  )
  return {
    subchecks: sub,
    evidenceBody: {
      scannedFiles,
      skipped,
      proseHits,
      codeUnallowed,
      allowed,
      unusedDeclarations,
      parseErrors
    }
  }
}

// ── candidate-secrets:在原身份下对显式实时候选文件集运行内部扫描器规则 ────────────
const IMPORT_LINE_RE = /^import .+$/gm
const STRIPPED_BLOCK_RE = /const STRIPPED = \[[\s\S]*?\n\]/
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)

/**
 * 把内部扫描器源码在隔离上下文里对候选文件集执行:
 * - 内容输入 = 显式候选文件集(无 Git、无历史、无未跟踪),路径面 = 候选目录树;
 * - 身份 = 调用方给的 username 与内部仓库根(R10 / R11 原身份,不换成候选根或 runner);
 * - 发布面谓词由 policy.stripPaths 派生(不再用扫描器自带的旧表达式);
 * - ADJUDICATED 原样保留,登记适用性在外层逐条计算;绝不读取任何内部处置载体。
 */
export function runCandidateSecrets({
  scannerSource,
  policy,
  files,
  internalRoot,
  username = os.userInfo().username ?? '',
  timeoutMs = 120000
}) {
  const lit = (v) => reEsc(v).replace(/[/]/g, '\\/')
  const stripRules = policy.stripPaths
    .map((r) => (r.kind === 'directory' ? `/^${lit(r.path)}/` : `/^${lit(r.path)}$/`))
    .join(',\n  ')
  if (typeof scannerSource !== 'string' || scannerSource.length === 0)
    return { executionError: 'SCANNER_SOURCE_MISSING', state: null, logs: '' }
  if (!STRIPPED_BLOCK_RE.test(scannerSource))
    return { executionError: 'SCANNER_SHAPE_UNEXPECTED', state: null, logs: '' }
  const source = scannerSource
    .replace(IMPORT_LINE_RE, '')
    .replace(STRIPPED_BLOCK_RE, `const STRIPPED = [\n  ${stripRules}\n]`)
  const rootReal = internalRoot
  const toRel = (abs) => {
    const rel = path.relative(rootReal, abs).split(path.sep).join('/')
    if (rel === '' || rel === '.') return ''
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw Object.assign(new Error('outside'), { code: 'EACCES' })
    return rel
  }
  const dirIndex = new Map()
  for (const p of files.keys()) {
    const segs = p.split('/')
    for (let i = 0; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      if (!dirIndex.has(dir)) dirIndex.set(dir, new Map())
      dirIndex.get(dir).set(segs[i], i < segs.length - 1)
    }
  }
  const logs = []
  const exitSignal = Symbol('scanner-exit')
  let exitCode = null
  let executionError = null
  const gitStub = (_cmd, args) => {
    const a = JSON.stringify(args)
    if (a === JSON.stringify(['ls-files', '-z']))
      return { status: 0, stdout: [...files.keys()].join('\0'), stderr: '' }
    if (a === JSON.stringify(['ls-files', '--others', '--exclude-standard', '-z']))
      return { status: 0, stdout: '', stderr: '' }
    if (a === JSON.stringify(['rev-list', '--objects', '--all']))
      return { status: 0, stdout: '', stderr: '' }
    if (a === JSON.stringify(['cat-file', '--batch']))
      return { status: 0, stdout: Buffer.alloc(0), stderr: '' }
    return { status: 128, stdout: '', stderr: 'not modelled' }
  }
  const ctx = createContext({
    Buffer,
    createHash,
    isIP: netIsIPImpl,
    spawnSync: gitStub,
    readFileSync: (file) => {
      const rel = toRel(file)
      const buf = files.get(rel)
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return buf
    },
    statSync: (file) => {
      const rel = toRel(file)
      const buf = files.get(rel)
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: buf.length }
    },
    readdirSync: (dir) => {
      const rel = toRel(dir)
      const m = dirIndex.get(rel)
      if (!m) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return [...m].map(([name, isDir]) => ({ name, isDirectory: () => isDir }))
    },
    join: path.join,
    relative: path.relative,
    sep: path.sep,
    userInfo: () => ({ username }),
    process: {
      cwd: () => rootReal,
      exit: (code) => {
        exitCode = code
        throw exitSignal
      }
    },
    console: { log: (...args) => logs.push(args.join(' ')) }
  })
  try {
    runInContext(source, ctx, { filename: 'candidate-secrets-adapter.mjs', timeout: timeoutMs })
    exitCode = 0
  } catch (e) {
    if (e !== exitSignal) executionError = e instanceof Error ? e.message : String(e)
  }
  if (executionError) return { executionError, state: null, logs: logs.join('\n'), exitCode }
  let state
  try {
    state = JSON.parse(
      JSON.stringify(
        runInContext(
          '({ open, stale, openSummary, ackSeen: [...ackSeen].map(([key, b]) => ({ key, hits: b.hits.length })), coverage, inputErrors, status, USER_RULE_ON, REPO_RULE_ON, rootSegments: REPO_SEGS.length, rules: RULES.map((r) => ({ id: r.id, off: Boolean(r.off) })), registry: ADJUDICATED.map((a) => ({ rule: a.rule, file: a.file, sha: a.sha })) })',
          ctx
        )
      )
    )
  } catch (e) {
    return {
      executionError: `STATE_EXTRACT_FAILED ${e.message}`,
      state: null,
      logs: logs.join('\n'),
      exitCode
    }
  }
  return { executionError: null, state, logs: logs.join('\n'), exitCode }
}
// 与标准库 isIP 同语义(刻意不引入网络模块,保持模块面只读):4 / 6 / 0
function netIsIPImpl(s) {
  if (typeof s !== 'string') return 0
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s))
    return 4
  const v6 =
    /^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?:(?::[0-9a-f]{1,4}){1,7}|:)|(?:[0-9a-f]{1,4}:){6}(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){1,5}:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){0,1}:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){0,2}:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){0,3}:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){0,4}:(?:\d{1,3}\.){3}\d{1,3}|::(?:[0-9a-f]{1,4}:){0,5}(?:\d{1,3}\.){3}\d{1,3}|::(?:\d{1,3}\.){3}\d{1,3})$/i
  if (v6.test(s)) {
    const tail = s.match(/(\d{1,3}\.){3}\d{1,3}$/)
    if (tail && tail[0].split('.').some((n) => Number(n) > 255)) return 0
    return 6
  }
  return 0
}

/** 逐条计算 ADJUDICATED 对候选的适用性:剥离 / 禁止 / 不在候选 → 退役(不算 stale);在候选且零命中 → stale。 */
export function registryApplicability({ policy, files, registry, ackSeen }) {
  const seen = new Set(ackSeen.map((a) => a.key))
  const rows = registry.map((a) => {
    const key = `${a.rule}|${a.file}|${a.sha}`
    const cls = classifyPath(a.file, policy)
    let applicability
    if (cls.stripped) applicability = `retired:stripped:${cls.stripped.id}`
    else if (cls.forbidden) applicability = `retired:forbidden:${cls.forbidden.id}`
    else if (!files.has(a.file)) applicability = 'retired:not-in-candidate'
    else if (seen.has(key)) applicability = 'applied'
    else applicability = 'stale-in-candidate'
    const credential = /^R[1-6]$/.test(a.rule)
    return {
      rule: a.rule,
      file: a.file,
      ...(credential ? { fingerprintRedacted: true } : { sha: a.sha }),
      applicability
    }
  })
  return rows
}

export function checkCandidateSecrets({ policy, files, scannerSource, internalRoot, username }) {
  const run = runCandidateSecrets({ scannerSource, policy, files, internalRoot, username })
  if (run.executionError) {
    const err = (id) =>
      R(id, STATUS.ERROR, 'SCANNER_EXECUTION_ERROR', { error: run.executionError.slice(0, 300) })
    return {
      subchecks: [
        err('identity-context-present'),
        err('open-empty'),
        err('stale-empty'),
        err('coverage-listed')
      ],
      evidenceBody: { executionError: run.executionError }
    }
  }
  const st = run.state
  const sub = []
  const identityOk = st.USER_RULE_ON && st.REPO_RULE_ON
  const identityDigest = sha256Hex(
    `downlord-identity-context\n${username ?? os.userInfo().username}\n${internalRoot}`
  )
  sub.push(
    identityOk
      ? R('identity-context-present', STATUS.PASS, null, {
          userRuleOn: true,
          repoRuleOn: true,
          rootSegments: st.rootSegments,
          identityContextSha256: identityDigest,
          role: '<internal-root>'
        })
      : R('identity-context-present', STATUS.PENDING, 'IDENTITY_CONTEXT_UNAVAILABLE', {
          userRuleOn: st.USER_RULE_ON,
          repoRuleOn: st.REPO_RULE_ON,
          rootSegments: st.rootSegments
        })
  )
  if (st.inputErrors.length)
    sub.push(R('open-empty', STATUS.ERROR, 'SCAN_INPUT_ERROR', { inputErrors: st.inputErrors }))
  else if (st.open.length)
    sub.push(
      R('open-empty', STATUS.FAIL, 'OPEN_FINDINGS', {
        groups: st.openSummary.length,
        occurrences: st.open.length,
        summary: cap(st.openSummary, 30)
      })
    )
  else
    sub.push(
      R('open-empty', STATUS.PASS, null, {
        scannedFiles: st.coverage.workspace.scannedFiles,
        rules: st.rules.filter((r) => !r.off).map((r) => r.id)
      })
    )
  const rows = registryApplicability({ policy, files, registry: st.registry, ackSeen: st.ackSeen })
  const staleRows = rows.filter((r) => r.applicability === 'stale-in-candidate')
  const counts = {}
  for (const r of rows) counts[r.applicability] = (counts[r.applicability] ?? 0) + 1
  sub.push(
    staleRows.length
      ? R('stale-empty', STATUS.FAIL, 'REGISTRY_STALE_IN_CANDIDATE', {
          stale: cap(staleRows),
          counts
        })
      : R('stale-empty', STATUS.PASS, null, { counts })
  )
  const skipped = st.coverage.workspace.skipped
  sub.push(
    R('coverage-listed', STATUS.PASS, null, {
      candidateFiles: st.coverage.workspace.candidateFiles,
      scannedFiles: st.coverage.workspace.scannedFiles,
      skipped: skipped.length,
      skippedReasons: Object.fromEntries(
        [...new Set(skipped.map((s) => s.reason))].map((r) => [
          r,
          skipped.filter((s) => s.reason === r).length
        ])
      ),
      history:
        'not-applicable-to-candidate (no git history in candidate); internal history stays on the internal scan',
      note: 'skipped material is not clean; listed for supplementary checks'
    })
  )
  return {
    subchecks: sub,
    evidenceBody: {
      scope: 'explicit-live-candidate-file-set-original-identity',
      identityContextSha256: identityDigest,
      userRuleOn: st.USER_RULE_ON,
      repoRuleOn: st.REPO_RULE_ON,
      rootSegments: st.rootSegments,
      scannerExit: run.exitCode,
      scannerStatus: st.status,
      counts: {
        openGroups: st.openSummary.length,
        openOccurrences: st.open.length,
        acknowledged: st.ackSeen.length,
        registry: rows.length,
        ...counts
      },
      open: st.openSummary,
      registry: rows,
      coverage: st.coverage,
      inputErrors: st.inputErrors,
      internalDispositionsLoaded: false
    }
  }
}

// ── local-links / external-links ──────────────────────────────────────────────
const ABS_WIN = /^[A-Za-z]:[\\/]/
const ABS_UNC = /^(\\\\|\/\/)[^/\\]/
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
function stripCode(md) {
  // 去围栏代码块与行内代码(保留行数:替换为等长空白 / 换行)
  let out = md.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, (m) =>
    m.replace(/[^\n]/g, ' ')
  )
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
  return out
}
export function githubSlug(heading) {
  let t = heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
  t = t.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-')
  return t
}
export function headingAnchors(md) {
  const anchors = new Set()
  const counts = new Map()
  const text = stripCode(md)
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = githubSlug(m[2])
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    anchors.add(n === 0 ? base : `${base}-${n}`)
  }
  for (const m of md.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) anchors.add(m[1])
  return anchors
}
function unwrap(t) {
  t = t.trim()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  return t
}
/** 从一份文档提取全部链接目标 [{syntax, target, line}]。 */
const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
export function extractLinks(file, text) {
  const links = []
  const isMd = extOf(file) === 'md'
  const isHtml = extOf(file) === 'html' || extOf(file) === 'svg'
  const body = isMd ? stripCode(text) : isHtml ? stripHtmlComments(text) : text
  const add = (syntax, target, idx) => {
    if (target === undefined || target === null || target === '') return
    links.push({ syntax, target: unwrap(target), line: lineOf(body, idx) })
  }
  if (isMd) {
    const defs = new Map()
    for (const m of body.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/gm)) {
      defs.set(m[1].toLowerCase(), m[2])
      add('markdown-reference', m[2], m.index)
    }
    for (const m of body.matchAll(
      /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
    ))
      add(m[1] ? 'markdown-image' : 'markdown-inline', m[3], m.index)
    for (const m of body.matchAll(/(!?)\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const id = (m[3] || m[2]).toLowerCase()
      if (defs.has(id))
        links.push({
          syntax: 'markdown-reference',
          target: unwrap(defs.get(id)),
          line: lineOf(body, m.index),
          via: id
        })
      else
        links.push({
          syntax: 'markdown-reference',
          target: null,
          line: lineOf(body, m.index),
          unresolvedReference: id
        })
    }
    for (const m of body.matchAll(/<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/g))
      add('markdown-autolink', m[1], m.index)
    for (const m of body.matchAll(/(?<![("'<\]])\bhttps?:\/\/[^\s<>)\]"']+/g)) {
      const t = m[0].replace(/[.,;:!?]+$/, '')
      // 排除已作为 inline 目标捕获的同一位置
      if (!links.some((l) => l.target === t && l.line === lineOf(body, m.index)))
        add('markdown-autolink', t, m.index)
    }
  }
  for (const m of body.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    add('html-anchor', m[1] ?? m[2], m.index)
  for (const m of body.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    add('html-img', m[1] ?? m[2], m.index)
  if (isHtml) {
    for (const m of body.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
      add('html-script-src', m[1] ?? m[2], m.index)
    for (const m of body.matchAll(/<link\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
      add('html-link-href', m[1] ?? m[2], m.index)
  }
  if (extOf(file) === 'svg' || extOf(file) === 'html')
    for (const m of body.matchAll(/\b(?:xlink:href|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const t = m[1] ?? m[2]
      if (extOf(file) === 'svg') add('svg-href', t, m.index)
    }
  return links
}
/** 未解析的引用形态(policy.linkRules.unparsedReferenceTypes):出现即不能把解析覆盖记为 PASS。 */
export function unparsedOccurrences(file, text) {
  const out = []
  const ext = extOf(file)
  const media = /<(iframe|video|audio|source|embed|object|track)\b[^>]*?\b(?:src|href)\s*=/gi
  if (ext === 'md') {
    const body = stripCode(text)
    for (const m of body.matchAll(
      /<(iframe|video|audio|source|embed|object|track|script|link)\b[^>]*?\b(?:src|href)\s*=/gi
    ))
      out.push({
        kind: 'markdown-html-block-other',
        tag: m[1].toLowerCase(),
        line: lineOf(body, m.index)
      })
    return out
  }
  if (ext === 'html' || ext === 'svg') {
    const body = stripHtmlComments(text)
    for (const m of body.matchAll(media))
      out.push({ kind: 'html-media-src', tag: m[1].toLowerCase(), line: lineOf(body, m.index) })
    for (const m of body.matchAll(/\burl\s*\(/gi))
      out.push({ kind: 'css-url', line: lineOf(body, m.index) })
  }
  return out
}
function matchGlob(p, glob) {
  // 只支持 **/*.ext 形态
  const m = /^\*\*\/\*\.([a-z0-9]+)$/i.exec(glob)
  return m ? extOf(p) === m[1].toLowerCase() : false
}
/** 逐字上游材料集合:provenance 登记里 transformation 为 verbatim byte copy 的路径。 */
export function verbatimUpstreamSet(policy, files) {
  const out = new Set()
  const prov = policy.requiredTargets.provenance
  if (!prov || !files.has(prov.registry)) return out
  try {
    const reg = JSON.parse(files.get(prov.registry).toString('utf8'))
    for (const m of reg[prov.materialsField] ?? [])
      if (m.transformation === 'verbatim byte copy' && typeof m[prov.pathField] === 'string')
        out.add(m[prov.pathField])
  } catch {
    /* 登记不可解析由 license-materials 报告 */
  }
  return out
}
function dirIndexHas(files, dir) {
  const prefix = dir + '/'
  for (const p of files.keys()) if (p.startsWith(prefix)) return true
  return false
}
export function checkLocalLinks({ policy, files }) {
  const lr = policy.linkRules
  const docs = [...files.keys()].filter((p) => lr.documentGlobs.some((g) => matchGlob(p, g)))
  const statics = [...files.keys()].filter((p) =>
    lr.staticReferenceGlobs.some((g) => matchGlob(p, g))
  )
  const anchorCache = new Map()
  const anchorsOf = (p) => {
    if (!anchorCache.has(p)) anchorCache.set(p, headingAnchors(files.get(p).toString('utf8')))
    return anchorCache.get(p)
  }
  const lowerIndex = new Map()
  for (const p of files.keys()) lowerIndex.set(p.toLowerCase(), p)
  const verbatim = verbatimUpstreamSet(policy, files)
  const entryDecl = new Map((lr.staticEntryFiles ?? []).map((d) => [d.path, d]))
  const buildOutputs = []
  const unparsed = []
  const upstreamUnparsed = []
  const upstreamMissing = []
  const upstreamUnresolved = []
  const upstreamExternal = []
  const syntaxCounts = Object.fromEntries(lr.syntaxCoverage.map((s) => [s, 0]))
  const unresolved = []
  const missing = []
  const caseMismatch = []
  const stripped = []
  const machineAbs = []
  const external = []
  const local = []
  const parseErrors = []
  for (const file of [...docs, ...statics]) {
    let links
    try {
      links = extractLinks(file, files.get(file).toString('utf8'))
    } catch (e) {
      parseErrors.push({ path: file, error: e.message })
      continue
    }
    const isUpstream = verbatim.has(file)
    for (const u of unparsedOccurrences(file, files.get(file).toString('utf8')))
      (isUpstream ? upstreamUnparsed : unparsed).push({ path: file, ...u })
    const decl = entryDecl.get(file) ?? null
    for (const l of links) {
      syntaxCounts[l.syntax] = (syntaxCounts[l.syntax] ?? 0) + 1
      if (l.target === null) {
        ;(isUpstream ? upstreamUnresolved : unresolved).push({
          path: file,
          line: l.line,
          reference: l.unresolvedReference
        })
        continue
      }
      const t = l.target
      if (ABS_WIN.test(t) || ABS_UNC.test(t) || /^file:/i.test(t)) {
        machineAbs.push({
          path: file,
          line: l.line,
          form: ABS_WIN.test(t) ? 'windows-drive' : /^file:/i.test(t) ? 'file-uri' : 'unc'
        })
        continue
      }
      if (SCHEME.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) {
        if (/^(mailto|tel|javascript):/i.test(t)) continue
        ;(isUpstream ? upstreamExternal : external).push({
          path: file,
          line: l.line,
          syntax: l.syntax,
          url: t
        })
        continue
      }
      if (decl && Array.isArray(decl.buildOutputs) && decl.buildOutputs.includes(t)) {
        buildOutputs.push({
          path: file,
          line: l.line,
          syntax: l.syntax,
          target: t,
          class: 'build-output'
        })
        continue
      }
      let [target, anchor] = t.split('#', 2)
      target = target.split('?')[0]
      try {
        target = decodeURIComponent(target)
      } catch {
        /* 保留原样 */
      }
      let resolved
      if (target === '') resolved = file
      else if (target.startsWith('/'))
        resolved = path.posix.normalize(
          decl && typeof decl.rootRelativeTo === 'string'
            ? decl.rootRelativeTo + target.slice(1)
            : target.slice(1)
        )
      else resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target))
      if (resolved.endsWith('/')) resolved = resolved.slice(0, -1)
      const entry = { path: file, line: l.line, syntax: l.syntax, target: t, resolved }
      local.push(entry)
      const cls = classifyPath(resolved, policy)
      if (cls.stripped || cls.forbidden) {
        stripped.push({ ...entry, rule: (cls.stripped ?? cls.forbidden).id })
        continue
      }
      const isDir = dirIndexHas(files, resolved)
      if (!files.has(resolved) && !isDir) {
        const lower = lowerIndex.get(resolved.toLowerCase())
        if (isUpstream) upstreamMissing.push({ ...entry, caseVariant: lower ?? null })
        else if (lower) caseMismatch.push({ ...entry, actual: lower })
        else missing.push(entry)
        continue
      }
      if (
        anchor !== undefined &&
        anchor !== '' &&
        files.has(resolved) &&
        extOf(resolved) === 'md'
      ) {
        let a = anchor
        try {
          a = decodeURIComponent(anchor)
        } catch {
          /* keep */
        }
        if (!anchorsOf(resolved).has(a.toLowerCase()) && !anchorsOf(resolved).has(a))
          (isUpstream ? upstreamMissing : missing).push({
            ...entry,
            anchor: a,
            reason: 'ANCHOR_MISSING'
          })
      }
    }
  }
  const sub = []
  sub.push(
    parseErrors.length
      ? R('all-syntaxes-parsed', STATUS.ERROR, 'LINK_PARSE_ERROR', { parseErrors })
      : unresolved.length
        ? R('all-syntaxes-parsed', STATUS.FAIL, 'UNRESOLVED_REFERENCE', {
            unresolved: cap(unresolved)
          })
        : unparsed.length
          ? R('all-syntaxes-parsed', STATUS.UNCHECKED, 'UNPARSED_REFERENCE_PRESENT', {
              unparsed: cap(unparsed),
              unparsedReferenceTypes: lr.unparsedReferenceTypes ?? []
            })
          : R('all-syntaxes-parsed', STATUS.PASS, null, {
              documents: docs.length,
              staticFiles: statics.length,
              syntaxCounts,
              localLinks: local.length,
              externalLinks: external.length,
              upstreamVerbatimFiles: verbatim.size,
              buildOutputs: buildOutputs.length,
              unparsedReferenceTypes: lr.unparsedReferenceTypes ?? [],
              unparsedOccurrences: 0,
              upstreamUnparsedOccurrences: upstreamUnparsed.length
            })
  )
  sub.push(
    missing.length
      ? R('targets-exist', STATUS.FAIL, 'LINK_TARGET_MISSING', { missing: cap(missing) })
      : R('targets-exist', STATUS.PASS, null, { checked: local.length })
  )
  sub.push(
    caseMismatch.length
      ? R('case-matches', STATUS.FAIL, 'LINK_TARGET_CASE_MISMATCH', {
          caseMismatch: cap(caseMismatch)
        })
      : R('case-matches', STATUS.PASS)
  )
  sub.push(
    stripped.length
      ? R('no-stripped-targets', STATUS.FAIL, 'LINK_TARGET_STRIPPED', { stripped: cap(stripped) })
      : R('no-stripped-targets', STATUS.PASS)
  )
  sub.push(
    machineAbs.length
      ? R('no-machine-absolute', STATUS.FAIL, 'LINK_TARGET_MACHINE_ABSOLUTE', {
          machineAbs: cap(machineAbs)
        })
      : R('no-machine-absolute', STATUS.PASS)
  )
  return {
    subchecks: sub,
    external,
    evidenceBody: {
      upstreamVerbatim: {
        files: [...verbatim],
        missing: upstreamMissing,
        unresolved: upstreamUnresolved,
        external: upstreamExternal,
        unparsed: upstreamUnparsed
      },
      buildOutputs,
      unparsed,
      documents: docs,
      staticFiles: statics,
      syntaxCounts,
      local,
      external,
      missing,
      caseMismatch,
      stripped,
      machineAbs,
      unresolved,
      parseErrors
    }
  }
}

export function checkExternalLinks({ policy, external, evidence, candidateDigest }) {
  const lr = policy.linkRules.externalLinks
  // 自有仓库网页前缀由 policy.publicGit.remote 派生,不在本文件写死仓库名
  const deferredPrefix = `https://github.com/${policy.publicGit.remote}/`
  const urls = [...new Set(external.map((e) => e.url))].sort()
  const sub = []
  if (urls.length === 0) {
    sub.push(R('per-url-result', STATUS.PASS, null, { urls: 0 }))
    sub.push(R('deferred-entries-exact', STATUS.PASS, null, { deferred: 0 }))
    return { subchecks: sub, evidenceBody: { urls: [], results: [] } }
  }
  if (!evidence)
    return {
      subchecks: [
        R('per-url-result', STATUS.PENDING, 'EXTERNAL_EVIDENCE_MISSING', { urls: urls.length }),
        R('deferred-entries-exact', STATUS.UNCHECKED, 'EXTERNAL_EVIDENCE_MISSING')
      ],
      evidenceBody: { urls, results: [] }
    }
  if (evidence.__parseError || evidence.schemaVersion !== 1 || !Array.isArray(evidence.results))
    return {
      subchecks: [
        R('per-url-result', STATUS.ERROR, 'EXTERNAL_EVIDENCE_INVALID'),
        R('deferred-entries-exact', STATUS.ERROR, 'EXTERNAL_EVIDENCE_INVALID')
      ],
      evidenceBody: { urls }
    }
  if (evidence.candidateDigest !== candidateDigest)
    return {
      subchecks: [
        R('per-url-result', STATUS.PENDING, 'EXTERNAL_EVIDENCE_CANDIDATE_MISMATCH', {
          recorded: evidence.candidateDigest ?? null
        }),
        R('deferred-entries-exact', STATUS.UNCHECKED, 'EXTERNAL_EVIDENCE_CANDIDATE_MISMATCH')
      ],
      evidenceBody: { urls }
    }
  const byUrl = new Map(evidence.results.map((r) => [r.url, r]))
  const rows = []
  const statuses = []
  const deferredProblems = []
  let deferredCount = 0
  for (const url of urls) {
    const rec = byUrl.get(url)
    if (!rec) {
      rows.push({ url, status: STATUS.PENDING, reasonCode: 'URL_RESULT_MISSING' })
      statuses.push(STATUS.PENDING)
      continue
    }
    let status = rec.status
    let reasonCode = null
    if (!['PASS', 'FAIL', 'ERROR', 'PENDING', 'DEFERRED_PUSH_LINK'].includes(status)) {
      status = STATUS.ERROR
      reasonCode = 'URL_RESULT_STATUS_INVALID'
    } else if (status === 'PASS' && (!rec.checkedAt || !rec.checkedBy)) {
      status = STATUS.PENDING
      reasonCode = 'URL_RESULT_UNBOUND'
    } else if (status === 'DEFERRED_PUSH_LINK') {
      deferredCount++
      const exact = lr.deferredPushLinks.includes(url)
      const okForm =
        url.startsWith(deferredPrefix) && !/\/releases\/download\//.test(url) && !url.includes('*')
      if (!exact || !okForm || !rec.dependsOnPush) {
        deferredProblems.push({
          url,
          exactInPolicy: exact,
          formValid: okForm,
          dependsOnPush: Boolean(rec.dependsOnPush)
        })
        status = STATUS.FAIL
        reasonCode = 'DEFERRED_ENTRY_NOT_EXACT'
      }
    }
    rows.push({
      url,
      status,
      reasonCode,
      checkedAt: rec.checkedAt ?? null,
      httpStatus: rec.httpStatus ?? null,
      finalUrl: rec.finalUrl ?? null
    })
    statuses.push(status)
  }
  const worst = (list) => {
    for (const s of [STATUS.ERROR, STATUS.FAIL, STATUS.PENDING, STATUS.DEFERRED_PUSH_LINK])
      if (list.includes(s)) return s
    return STATUS.PASS
  }
  const w = worst(statuses)
  sub.push(
    R('per-url-result', w, w === STATUS.PASS ? null : 'URL_RESULTS_INCOMPLETE', {
      urls: urls.length,
      results: cap(rows, 100)
    })
  )
  sub.push(
    deferredProblems.length
      ? R('deferred-entries-exact', STATUS.FAIL, 'DEFERRED_ENTRY_NOT_EXACT', {
          problems: deferredProblems
        })
      : R('deferred-entries-exact', STATUS.PASS, null, { deferred: deferredCount })
  )
  return { subchecks: sub, evidenceBody: { urls, results: rows, deferredProblems } }
}

// ── public-metadata ──────────────────────────────────────────────────────────
function parseGitObject(text) {
  const nl = text.indexOf('\n\n')
  const header = (nl < 0 ? text : text.slice(0, nl)).split('\n')
  const message = nl < 0 ? '' : text.slice(nl + 2)
  const fields = {}
  for (const line of header) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const k = line.slice(0, sp)
    const v = line.slice(sp + 1)
    if (k === 'parent') (fields.parent ??= []).push(v)
    else fields[k] = v
  }
  return { fields, message }
}
function parseIdentity(v) {
  const m = /^(.*?)\s*<([^>]*)>/.exec(v ?? '')
  return m ? { name: m[1], email: m[2] } : { name: v ?? '', email: '' }
}
function privacyProblems(text, { policy, machineUser, repoSegments }) {
  const problems = []
  for (const m of policy.internalMarkers.markers)
    if (findMarkerOccurrences(text, m).length)
      problems.push({ kind: 'internal-marker', marker: m.id })
  if (/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(text)) problems.push({ kind: 'windows-absolute-path' })
  if (/\\\\[^\s\\]+\\/.test(text)) problems.push({ kind: 'unc-path' })
  if (
    machineUser &&
    machineUser.length >= 3 &&
    new RegExp(`(?<![A-Za-z0-9_])${reEsc(machineUser)}(?![A-Za-z0-9_])`).test(text)
  )
    problems.push({ kind: 'machine-username' })
  if (repoSegments && repoSegments.length >= 3) {
    for (let i = 0; i + 2 < repoSegments.length; i++) {
      const re = new RegExp(
        repoSegments
          .slice(i, i + 3)
          .map(reEsc)
          .join('[\\\\/]')
      )
      if (re.test(text)) {
        problems.push({ kind: 'internal-repository-path' })
        break
      }
    }
  }
  const maint = policy.publicGit.maintainer.email.toLowerCase()
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))
    if (m[0].toLowerCase() !== maint) problems.push({ kind: 'foreign-email' })
  return problems
}
export function checkPublicMetadata({
  policy,
  publicGit,
  tip,
  baseline,
  machineUser,
  repoSegments
}) {
  const pendAll = (code, detail = null) => ({
    subchecks: ['author', 'committer', 'tagger', 'message-content'].map((id) =>
      R(id, STATUS.PENDING, code, detail)
    ),
    evidenceBody: { reasonCode: code }
  })
  if (!publicGit) return pendAll('PUBLIC_REPO_NOT_PROVIDED')
  if (!tip) return pendAll('NO_PUBLIC_COMMIT')
  const maint = policy.publicGit.maintainer
  const chain = commitChain(publicGit, tip)
  const stop = baseline?.previousPublicCommit ?? null
  const commits = []
  for (const c of chain) {
    if (stop && c.oid === stop) break
    commits.push(c.oid)
  }
  const authorProblems = []
  const committerProblems = []
  const messageProblems = []
  const records = []
  const identOk = (id) =>
    id.name === maint.name && id.email.toLowerCase() === maint.email.toLowerCase()
  for (const oid of commits) {
    const res = publicGit.run(['cat-file', '-p', oid])
    if (res.status !== 0)
      return {
        subchecks: ['author', 'committer', 'tagger', 'message-content'].map((id) =>
          R(id, STATUS.ERROR, 'GIT_COMMAND_FAILED', { oid })
        ),
        evidenceBody: {}
      }
    const obj = parseGitObject(String(res.stdout))
    const author = parseIdentity(obj.fields.author)
    const committer = parseIdentity(obj.fields.committer)
    if (!identOk(author)) authorProblems.push({ commit: oid, field: 'author' })
    if (!identOk(committer)) committerProblems.push({ commit: oid, field: 'committer' })
    const probs = privacyProblems(obj.message, { policy, machineUser, repoSegments })
    if (probs.length) messageProblems.push({ commit: oid, problems: probs })
    records.push({
      commit: oid,
      authorOk: identOk(author),
      committerOk: identOk(committer),
      messageProblems: probs.length
    })
  }
  const tags = listTags(publicGit)
  const taggerProblems = []
  const tagRecords = []
  for (const t of tags) {
    if (t.objectType === 'tag') {
      const res = publicGit.run(['cat-file', '-p', t.objectId])
      if (res.status !== 0)
        return {
          subchecks: ['author', 'committer', 'tagger', 'message-content'].map((id) =>
            R(id, STATUS.ERROR, 'GIT_COMMAND_FAILED', { tag: t.name })
          ),
          evidenceBody: {}
        }
      const obj = parseGitObject(String(res.stdout))
      const tagger = parseIdentity(obj.fields.tagger)
      const probs = privacyProblems(obj.message, { policy, machineUser, repoSegments })
      if (!identOk(tagger)) taggerProblems.push({ tag: t.name, field: 'tagger' })
      if (probs.length) messageProblems.push({ tag: t.name, problems: probs })
      tagRecords.push({
        tag: t.name,
        type: 'annotated',
        taggerOk: identOk(tagger),
        messageProblems: probs.length
      })
    } else
      tagRecords.push({
        tag: t.name,
        type: 'lightweight',
        taggerOk: null,
        note: 'no tagger field; type and target recorded'
      })
  }
  const sub = [
    authorProblems.length
      ? R('author', STATUS.FAIL, 'AUTHOR_IDENTITY_MISMATCH', { problems: cap(authorProblems) })
      : R('author', STATUS.PASS, null, { commits: commits.length }),
    committerProblems.length
      ? R('committer', STATUS.FAIL, 'COMMITTER_IDENTITY_MISMATCH', {
          problems: cap(committerProblems)
        })
      : R('committer', STATUS.PASS, null, { commits: commits.length }),
    taggerProblems.length
      ? R('tagger', STATUS.FAIL, 'TAGGER_IDENTITY_MISMATCH', { problems: cap(taggerProblems) })
      : R('tagger', STATUS.PASS, null, {
          annotated: tagRecords.filter((t) => t.type === 'annotated').length,
          lightweight: tagRecords.filter((t) => t.type === 'lightweight').length
        }),
    messageProblems.length
      ? R('message-content', STATUS.FAIL, 'MESSAGE_PRIVACY_PROBLEM', {
          problems: cap(messageProblems)
        })
      : R('message-content', STATUS.PASS, null, {
          commits: commits.length,
          tags: tagRecords.length
        })
  ]
  return {
    subchecks: sub,
    evidenceBody: {
      tip,
      checkedCommits: commits,
      stoppedAt: stop,
      commits: records,
      tags: tagRecords
    }
  }
}

// ── metadata-contract ────────────────────────────────────────────────────────
function readJsonBuf(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return { __parseError: true }
  }
}
function yamlPublishBlock(text) {
  // 只识别 provider / owner / repo 三个键(顶层或 publish: 段内)
  const get = (k) => {
    const m = new RegExp(`^\\s*${k}:\\s*([^#\\n]+)`, 'm').exec(text)
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null
  }
  return { provider: get('provider'), owner: get('owner'), repo: get('repo') }
}
export function checkMetadataContract({ policy, files }) {
  const pkg = files.has('package.json') ? readJsonBuf(files.get('package.json')) : null
  const lock = files.has('package-lock.json') ? readJsonBuf(files.get('package-lock.json')) : null
  const sub = []
  const semver = /^\d+\.\d+\.\d+$/
  if (!pkg || pkg.__parseError)
    sub.push(R('package-version', STATUS.ERROR, 'PACKAGE_JSON_UNREADABLE'))
  else if (!semver.test(pkg.version ?? ''))
    sub.push(
      R('package-version', STATUS.FAIL, 'PACKAGE_VERSION_INVALID', { version: pkg.version ?? null })
    )
  else sub.push(R('package-version', STATUS.PASS, null, { version: pkg.version }))
  if (!lock || lock.__parseError)
    sub.push(R('lock-version', STATUS.ERROR, 'PACKAGE_LOCK_UNREADABLE'))
  else {
    const rootV = lock.packages?.['']?.version ?? null
    if (!pkg || pkg.__parseError || lock.version !== pkg.version || rootV !== pkg.version)
      sub.push(
        R('lock-version', STATUS.FAIL, 'LOCK_VERSION_MISMATCH', {
          package: pkg?.version ?? null,
          lock: lock.version ?? null,
          lockRoot: rootV
        })
      )
    else sub.push(R('lock-version', STATUS.PASS, null, { version: lock.version }))
  }
  const maint = policy.publicGit.maintainer
  if (pkg && !pkg.__parseError) {
    const a = pkg.author
    const name = typeof a === 'string' ? a.replace(/\s*<.*$/, '').trim() : a?.name
    const email = typeof a === 'string' ? (/<([^>]*)>/.exec(a) ?? [])[1] : a?.email
    if (name !== maint.name || (email && email.toLowerCase() !== maint.email.toLowerCase()))
      sub.push(
        R('author', STATUS.FAIL, 'AUTHOR_FIELD_MISMATCH', {
          name: name ?? null,
          hasEmail: Boolean(email)
        })
      )
    else sub.push(R('author', STATUS.PASS, null, { name }))
    const npm = pkg.engines?.npm ?? null
    const m = /^>=\s*(\d+)/.exec(npm ?? '')
    if (!m || Number(m[1]) < 11)
      sub.push(R('engines-npm', STATUS.FAIL, 'ENGINES_NPM_MISMATCH', { npm }))
    else sub.push(R('engines-npm', STATUS.PASS, null, { npm }))
  } else {
    sub.push(R('author', STATUS.UNCHECKED, 'PACKAGE_JSON_UNREADABLE'))
    sub.push(R('engines-npm', STATUS.UNCHECKED, 'PACKAGE_JSON_UNREADABLE'))
  }
  const [owner, repo] = policy.publicGit.remote.split('/')
  const targets = []
  const problems = []
  for (const f of ['dev-app-update.yml', 'electron-builder.yml']) {
    if (!files.has(f)) {
      problems.push({ file: f, reason: 'missing' })
      continue
    }
    const text = files.get(f).toString('utf8')
    const block =
      f === 'electron-builder.yml' ? text.slice(Math.max(0, text.search(/^publish:/m))) : text
    const y = yamlPublishBlock(block)
    targets.push({ file: f, ...y })
    if (y.provider !== 'github' || y.owner !== owner || y.repo !== repo)
      problems.push({ file: f, ...y })
  }
  const manifest = files.has('extension/manifest.json')
    ? readJsonBuf(files.get('extension/manifest.json'))
    : null
  if (!manifest || manifest.__parseError)
    problems.push({ file: 'extension/manifest.json', reason: 'unreadable' })
  else if ('version' in manifest)
    problems.push({
      file: 'extension/manifest.json',
      reason: 'source-manifest-must-not-carry-version'
    })
  sub.push(
    problems.length
      ? R('update-targets', STATUS.FAIL, 'UPDATE_TARGET_MISMATCH', { problems, targets })
      : R('update-targets', STATUS.PASS, null, { targets })
  )
  return {
    subchecks: sub,
    evidenceBody: { version: pkg?.version ?? null, lock: lock?.version ?? null, targets, problems }
  }
}

// ── internal-gate / validation-delta(证据驱动)────────────────────────────────
function runStatus(run) {
  if (!run) return [STATUS.PENDING, 'RUN_EVIDENCE_MISSING']
  if (run.error || run.status === 'ERROR' || run.spawnError)
    return [STATUS.ERROR, 'RUN_EXECUTION_ERROR']
  if (run.exitCode === 0) return [STATUS.PASS, null]
  if (run.exitCode === 1) return [STATUS.FAIL, 'RUN_FAILED']
  if (Number.isInteger(run.exitCode)) return [STATUS.ERROR, 'RUN_ABNORMAL_EXIT']
  return [STATUS.PENDING, 'RUN_EXIT_MISSING']
}
export function checkInternalGate({ gateEvidence, releaseTestsEvidence, commit }) {
  const sub = []
  const items = ['gate', 'scan-secrets', 'scan-licenses', 'audit-todo']
  if (!gateEvidence)
    for (const id of items) sub.push(R(id, STATUS.PENDING, 'INTERNAL_GATE_EVIDENCE_MISSING'))
  else if (gateEvidence.__parseError || gateEvidence.schemaVersion !== 1 || !gateEvidence.runs)
    for (const id of items) sub.push(R(id, STATUS.ERROR, 'INTERNAL_GATE_EVIDENCE_INVALID'))
  else if (gateEvidence.commit !== commit)
    for (const id of items)
      sub.push(
        R(id, STATUS.FAIL, 'EVIDENCE_COMMIT_MISMATCH', {
          recorded: gateEvidence.commit ?? null,
          frozen: commit
        })
      )
  else
    for (const id of items) {
      const run = gateEvidence.runs[id]
      const [status, code] = runStatus(run)
      sub.push(
        R(
          id,
          status,
          code,
          run
            ? {
                command: run.command ?? null,
                exitCode: run.exitCode ?? null,
                status: run.status ?? null,
                finishedAt: run.finishedAt ?? null
              }
            : null
        )
      )
    }
  if (!releaseTestsEvidence)
    sub.push(R('test-release', STATUS.PENDING, 'RELEASE_TESTS_EVIDENCE_MISSING'))
  else if (releaseTestsEvidence.__parseError || releaseTestsEvidence.schemaVersion !== 1)
    sub.push(R('test-release', STATUS.ERROR, 'RELEASE_TESTS_EVIDENCE_INVALID'))
  else if (releaseTestsEvidence.commit !== commit)
    sub.push(
      R('test-release', STATUS.FAIL, 'EVIDENCE_COMMIT_MISMATCH', {
        recorded: releaseTestsEvidence.commit ?? null,
        frozen: commit
      })
    )
  else {
    const [status, code] = runStatus(releaseTestsEvidence)
    const c = releaseTestsEvidence.counts ?? {}
    const bad =
      status === STATUS.PASS && (!Number.isInteger(c.tests) || c.tests === 0 || c.fail !== 0)
    sub.push(
      bad
        ? R('test-release', STATUS.FAIL, 'RELEASE_TESTS_COUNTS_INVALID', { counts: c })
        : R('test-release', status, code, {
            command: releaseTestsEvidence.command ?? null,
            exitCode: releaseTestsEvidence.exitCode ?? null,
            counts: c
          })
    )
  }
  return { subchecks: sub }
}
export const REQUIRED_DELTA_ITEMS = Object.freeze([
  'internal-gate',
  'todo-audit-internal',
  'todo-stripped-candidate',
  'prompt-stripped-candidate',
  'npm-test-collection',
  'release-tests-not-collected',
  'candidate-toolchain',
  'public-ci',
  'sync-strip-markers',
  'secrets-identity',
  'git-metadata',
  'local-links',
  'external-links',
  'npm-licenses',
  'engine-notices-offline',
  'artifacts',
  'semantics-screenshots',
  'security-channel',
  'task6-acceptance'
])
const DELTA_FIELDS = [
  'object',
  'input',
  'canRun',
  'coverage',
  'conclusion',
  'timepoint',
  'evidence'
]
export function checkValidationDelta({ policy, evidence, files, commit, candidateDigest }) {
  if (!evidence)
    return {
      subchecks: [
        R('delta-items-listed', STATUS.PENDING, 'DELTA_EVIDENCE_MISSING', {
          required: REQUIRED_DELTA_ITEMS
        }),
        R('no-unresolved-push-blocker', STATUS.UNCHECKED, 'DELTA_EVIDENCE_MISSING')
      ]
    }
  if (evidence.__parseError || evidence.schemaVersion !== 1 || !Array.isArray(evidence.items))
    return {
      subchecks: [
        R('delta-items-listed', STATUS.ERROR, 'DELTA_EVIDENCE_INVALID'),
        R('no-unresolved-push-blocker', STATUS.ERROR, 'DELTA_EVIDENCE_INVALID')
      ]
    }
  if (evidence.commit !== commit || evidence.candidateDigest !== candidateDigest)
    return {
      subchecks: [
        R('delta-items-listed', STATUS.FAIL, 'EVIDENCE_COMMIT_MISMATCH', {
          recordedCommit: evidence.commit ?? null,
          recordedDigest: evidence.candidateDigest ?? null
        }),
        R('no-unresolved-push-blocker', STATUS.UNCHECKED, 'EVIDENCE_COMMIT_MISMATCH')
      ]
    }
  const byId = new Map(evidence.items.map((i) => [i.id, i]))
  const missing = REQUIRED_DELTA_ITEMS.filter((id) => !byId.has(id))
  const incomplete = []
  for (const it of evidence.items) {
    const lacking = DELTA_FIELDS.filter(
      (f) => it[f] === undefined || it[f] === null || it[f] === ''
    )
    if (lacking.length || typeof it.pushBlocker !== 'boolean' || typeof it.resolved !== 'boolean')
      incomplete.push({ id: it.id, lacking })
  }
  // 自动事实交叉核对:候选里没有 TODO / prompt 目录 ⇒ 对应差额项不能声称可运行
  const contradictions = []
  const todo = byId.get('todo-stripped-candidate')
  // 待办文件路径取自 policy 的剥离规则(file 规则里以 TODO.md 结尾的那条),本文件不写内部路径字面量
  const backlogRule = policy.stripPaths.find(
    (r) => r.kind === 'file' && /(^|\/)TODO\.md$/.test(r.path)
  )
  const backlogPath = backlogRule ? backlogRule.path : null
  if (todo && backlogPath && !files.has(backlogPath) && todo.canRun === true)
    contradictions.push({
      id: 'todo-stripped-candidate',
      fact: `${backlogPath} absent from candidate`
    })
  const prompt = byId.get('prompt-stripped-candidate')
  const hasPrompt = [...files.keys()].some((p) => /^docs\/v\d+\.\d+\/prompt\//.test(p))
  if (prompt && !hasPrompt && prompt.canRun === true)
    contradictions.push({
      id: 'prompt-stripped-candidate',
      fact: 'no prompt directory in candidate'
    })
  const sub = []
  if (missing.length || incomplete.length)
    sub.push(R('delta-items-listed', STATUS.PENDING, 'DELTA_ITEM_MISSING', { missing, incomplete }))
  else if (contradictions.length)
    sub.push(
      R('delta-items-listed', STATUS.FAIL, 'DELTA_CONTRADICTS_CANDIDATE', { contradictions })
    )
  else sub.push(R('delta-items-listed', STATUS.PASS, null, { items: evidence.items.length }))
  const blockers = evidence.items
    .filter((i) => i.pushBlocker === true && i.resolved !== true)
    .map((i) => i.id)
  sub.push(
    blockers.length
      ? R('no-unresolved-push-blocker', STATUS.FAIL, 'UNRESOLVED_PUSH_BLOCKER', { blockers })
      : R('no-unresolved-push-blocker', STATUS.PASS)
  )
  return { subchecks: sub }
}

// ── license-materials ────────────────────────────────────────────────────────
export function checkLicenseMaterials({ policy, files }) {
  const prov = policy.requiredTargets.provenance
  const regPath = prov.registry
  const err = (code, detail) => ({
    subchecks: ['materials-present', 'hashes-match-provenance', 'notices-consistent'].map((id) =>
      R(id, STATUS.FAIL, code, detail)
    ),
    evidenceBody: { reasonCode: code }
  })
  if (!files.has(regPath)) return err('PROVENANCE_REGISTRY_MISSING', { path: regPath })
  const reg = readJsonBuf(files.get(regPath))
  if (reg.__parseError || !Array.isArray(reg[prov.materialsField]))
    return err('PROVENANCE_REGISTRY_UNPARSEABLE', { path: regPath })
  const materials = reg[prov.materialsField]
  const missing = []
  const mismatch = []
  const listed = []
  for (const m of materials) {
    const p = m[prov.pathField]
    const want = m[prov.sha256Field]
    if (!files.has(p)) {
      missing.push(p)
      continue
    }
    const got = sha256Hex(files.get(p))
    listed.push({ path: p, sha256: got, bytes: files.get(p).length })
    if (got !== want) mismatch.push({ path: p, expected: want, actual: got })
  }
  const sub = []
  sub.push(
    missing.length
      ? R('materials-present', STATUS.FAIL, 'LICENSE_MATERIAL_MISSING', { missing: cap(missing) })
      : R('materials-present', STATUS.PASS, null, { materials: materials.length })
  )
  sub.push(
    mismatch.length
      ? R('hashes-match-provenance', STATUS.FAIL, 'LICENSE_MATERIAL_HASH_MISMATCH', {
          mismatch: cap(mismatch)
        })
      : R('hashes-match-provenance', STATUS.PASS, null, { verified: listed.length })
  )
  const problems = []
  const noticesPath = reg.notices?.source ?? policy.artifactRules.packagedNotices
  if (!files.has(noticesPath)) problems.push({ kind: 'notices-missing', path: noticesPath })
  if (reg.notices && reg.notices.source !== policy.artifactRules.packagedNotices)
    problems.push({ kind: 'notices-source-mismatch', registered: reg.notices.source })
  const eb = files.has('electron-builder.yml')
    ? files.get('electron-builder.yml').toString('utf8')
    : ''
  for (const needle of [
    'license-notices/**/*',
    'license-provenance.json',
    `from: ${policy.artifactRules.packagedNotices}`
  ])
    if (!eb.includes(needle)) problems.push({ kind: 'extra-resources-missing', needle })
  const g = reg.gplExtraction
  if (g) {
    const src = files.get(g.sourcePath)
    const tgt = files.get(g.targetPath)
    if (!src || sha256Hex(src) !== g.sourceSha256)
      problems.push({ kind: 'gpl-extraction-source-mismatch', path: g.sourcePath })
    if (!tgt || sha256Hex(tgt) !== g.extractedSha256)
      problems.push({ kind: 'gpl-extraction-target-mismatch', path: g.targetPath })
    if (g.sourceSha256 === g.extractedSha256)
      problems.push({ kind: 'gpl-extraction-hash-conflated' })
    if (src && tgt) {
      const t = tgt.toString('utf8')
      if (
        !/END OF TERMS AND CONDITIONS/.test(t) ||
        !/How to Apply These Terms/i.test(t) ||
        !/\b17\./.test(t)
      )
        problems.push({ kind: 'gpl-extraction-incomplete', path: g.targetPath })
    }
  } else problems.push({ kind: 'gpl-extraction-record-missing' })
  sub.push(
    problems.length
      ? R('notices-consistent', STATUS.FAIL, 'NOTICES_INCONSISTENT', { problems })
      : R('notices-consistent', STATUS.PASS, null, { notices: noticesPath })
  )
  return {
    subchecks: sub,
    evidenceBody: {
      registry: regPath,
      registrySha256: sha256Hex(files.get(regPath)),
      materials: listed,
      missing,
      mismatch,
      problems
    }
  }
}

// ── manual-checks(证据完整性 + 内容绑定;结论由具名审阅记录承担)────────────────
const AUTOMATED_REVIEWER = /^(ai|assistant|bot|script|automated|claude|codex|gpt|model)\b/i
const README_COMMUNITY = [
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'extension/README.md'
]
export function checkManualChecks({ policy, files, evidence, candidateDigest }) {
  const ids = ['public-documents-reviewed', 'readme-community-reviewed', 'screenshots-reviewed']
  if (!evidence)
    return { subchecks: ids.map((id) => R(id, STATUS.PENDING, 'MANUAL_EVIDENCE_MISSING')) }
  if (evidence.__parseError || evidence.schemaVersion !== 1 || !Array.isArray(evidence.reviews))
    return { subchecks: ids.map((id) => R(id, STATUS.ERROR, 'MANUAL_EVIDENCE_INVALID')) }
  const byId = new Map(evidence.reviews.map((r) => [r.id, r]))
  const evalReview = (subId, reviewId, requiredPaths, extra) => {
    const rev = byId.get(reviewId)
    if (!rev)
      return R(subId, STATUS.PENDING, 'REVIEW_MISSING', {
        review: reviewId,
        required: requiredPaths
      })
    if (!rev.reviewer || AUTOMATED_REVIEWER.test(String(rev.reviewer)) || !rev.reviewedAt)
      return R(subId, STATUS.FAIL, 'REVIEWER_INVALID', { review: reviewId })
    if (rev.candidateDigest !== undefined && rev.candidateDigest !== candidateDigest)
      return R(subId, STATUS.FAIL, 'REVIEW_CANDIDATE_MISMATCH', { review: reviewId })
    const byPath = new Map((rev.files ?? []).map((f) => [f.path, f]))
    const missing = requiredPaths.filter((p) => !byPath.has(p))
    const stale = []
    const extraProblems = []
    for (const p of requiredPaths) {
      const f = byPath.get(p)
      if (!f) continue
      if (!files.has(p)) {
        stale.push({ path: p, reason: 'not-in-candidate' })
        continue
      }
      if (f.sha256 !== sha256Hex(files.get(p))) stale.push({ path: p, reason: 'sha256-differs' })
      if (extra)
        for (const [k, v] of Object.entries(extra))
          if (f[k] !== v)
            extraProblems.push({ path: p, field: k, expected: v, actual: f[k] ?? null })
    }
    if (missing.length)
      return R(subId, STATUS.PENDING, 'REVIEW_INCOMPLETE', { review: reviewId, missing })
    if (stale.length) return R(subId, STATUS.FAIL, 'REVIEW_STALE', { review: reviewId, stale })
    if (extraProblems.length)
      return R(subId, STATUS.FAIL, 'REVIEW_FIELD_INVALID', {
        review: reviewId,
        problems: extraProblems
      })
    if (rev.result !== 'PASS')
      return R(subId, STATUS.FAIL, 'REVIEW_RESULT_NOT_PASS', {
        review: reviewId,
        result: rev.result ?? null
      })
    return R(subId, STATUS.PASS, null, {
      review: reviewId,
      files: requiredPaths.length,
      reviewedAt: rev.reviewedAt
    })
  }
  const five = policy.publicDocuments.documents.map((d) => d.targetPath)
  const shots = [...files.keys()].filter(
    (p) => p.startsWith('docs/assets/screenshots/') && /\.(png|jpe?g|webp)$/i.test(p)
  )
  const sub = [
    evalReview('public-documents-reviewed', 'public-documents', five, null),
    evalReview(
      'readme-community-reviewed',
      'readme-community',
      README_COMMUNITY.filter((p) => files.has(p) || p === 'README.md'),
      null
    ),
    shots.length === 0
      ? R('screenshots-reviewed', STATUS.FAIL, 'NO_SCREENSHOTS_IN_CANDIDATE')
      : evalReview('screenshots-reviewed', 'screenshots', shots, {
          privacy: 'reviewed',
          metadataReviewed: true,
          source: 'real-capture'
        })
  ]
  return { subchecks: sub }
}

// ── 编排:在 check 阶段填入 owner=6b 的 11 项 ──────────────────────────────────
function readJsonOrNull(p) {
  let buf
  try {
    buf = fs.readFileSync(p)
  } catch {
    return null
  }
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return { __parseError: true }
  }
}
function writeEvidence(roots, name, runId, body, roles) {
  fs.mkdirSync(roots.evidenceDir, { recursive: true })
  const file = `${name}.${runId}.json`
  fs.writeFileSync(
    path.join(roots.evidenceDir, file),
    stableJson(redactValue({ schemaVersion: 1, kind: name, runId, ...body }, roles)),
    { flag: 'wx' }
  )
  return `evidence/${file}`
}

/**
 * @param {object} p
 * @param {object} p.policy
 * @param {object} p.roots
 * @param {string} p.internalRoot 真实内部根(原身份)
 * @param {{commit:string}} p.frozen
 * @param {string} p.candidateDigest
 * @param {{git:object, tip:string|null, baseline:object|null}|null} p.publicRepo
 * @param {string} p.runId
 * @param {string} p.generatedAt
 * @param {object} p.roles 脱敏角色表
 * @param {string} p.scannerSource scan-secrets.mjs 源码(从冻结 blob 读)
 * @param {string} [p.username]
 * @returns {Map<string, object>} results
 */
export function runCandidateChecks({
  policy,
  roots,
  internalRoot,
  frozen,
  candidateDigest,
  publicRepo,
  runId,
  generatedAt,
  roles,
  scannerSource,
  username,
  results = new Map()
}) {
  const { files, anomalies } = loadCandidateFiles(roots.candidateDir)
  const ev = (name, body) =>
    writeEvidence(
      roots,
      name,
      runId,
      { generatedAt, commit: frozen.commit, candidateDigest, ...body },
      roles
    )
  const put = (id, res, evidence, extra = {}) =>
    results.set(id, {
      subchecks: res.subchecks,
      command: 'checks.mjs(read-only)',
      exitCode: 0,
      evidence,
      location: '<candidate>',
      ...extra
    })

  const boundary = checkCandidateBoundary({ policy, files, anomalies })
  put('candidate-boundary', boundary, [ev('candidate-boundary', boundary.evidenceBody)])

  const markers = checkInternalMarkers({ policy, files })
  put('internal-markers', markers, [ev('internal-markers', markers.evidenceBody)])

  const secrets = checkCandidateSecrets({ policy, files, scannerSource, internalRoot, username })
  put('candidate-secrets', secrets, [ev('secrets', secrets.evidenceBody)])

  const links = checkLocalLinks({ policy, files })
  put('local-links', links, [ev('local-links', links.evidenceBody)])

  const extEvidence = readJsonOrNull(path.join(roots.evidenceDir, 'external-links.json'))
  const ext = checkExternalLinks({
    policy,
    external: links.external,
    evidence: extEvidence,
    candidateDigest
  })
  put('external-links', ext, [
    'evidence/external-links.json',
    ev('external-links-result', ext.evidenceBody)
  ])

  const machineUser = username ?? os.userInfo().username ?? ''
  const repoSegments = internalRoot.split(path.sep).filter(Boolean)
  const meta = publicRepo
    ? checkPublicMetadata({
        policy,
        publicGit: publicRepo.git,
        tip: publicRepo.tip,
        baseline: publicRepo.baseline,
        machineUser,
        repoSegments
      })
    : checkPublicMetadata({ policy, publicGit: null })
  put('public-metadata', meta, [ev('public-metadata', meta.evidenceBody ?? {})], {
    location: '<public-root>',
    command: 'git(read-only, public)'
  })

  const contract = checkMetadataContract({ policy, files })
  put('metadata-contract', contract, [ev('metadata-contract', contract.evidenceBody)])

  const gate = checkInternalGate({
    gateEvidence: readJsonOrNull(path.join(roots.evidenceDir, 'internal-gate.json')),
    releaseTestsEvidence: readJsonOrNull(path.join(roots.evidenceDir, 'release-tests.json')),
    commit: frozen.commit
  })
  put('internal-gate', gate, ['evidence/internal-gate.json', 'evidence/release-tests.json'], {
    command: 'evidence(read)'
  })

  const delta = checkValidationDelta({
    policy,
    evidence: readJsonOrNull(path.join(roots.evidenceDir, 'validation-delta.json')),
    files,
    commit: frozen.commit,
    candidateDigest
  })
  put('validation-delta', delta, ['evidence/validation-delta.json'], { command: 'evidence(read)' })

  const lic = checkLicenseMaterials({ policy, files })
  put('license-materials', lic, [ev('license-materials', lic.evidenceBody)])

  const manual = checkManualChecks({
    policy,
    files,
    evidence: readJsonOrNull(path.join(roots.evidenceDir, 'manual-checks.json')),
    candidateDigest
  })
  put('manual-checks', manual, ['evidence/manual-checks.json'], { command: 'evidence(read)' })
  return results
}
