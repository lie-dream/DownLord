// scripts/release/source.mjs
// 发布 CLI 的来源冻结 / 规则 / 登记 / 期望清单 / 候选构树 / 公开历史只读检查。
// 只依赖 Git 只读子命令(参数数组、无 shell)与受控根内的文件写入;不含任何提交 / 推送 / 打包 / 改基准能力。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ── 错误分类 ────────────────────────────────────────────────────────────────
/** 执行错误(工具不可用 / 解析崩溃 / 读写失败)→ 退出码 3。 */
export class ReleaseExecutionError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'ReleaseExecutionError'
    this.code = code
    this.detail = detail
  }
}

/** 违反只读边界的调用(不该发生;发生即拒绝执行)。 */
export class ReleaseBoundaryError extends Error {
  constructor(code, message, detail = null) {
    super(message)
    this.name = 'ReleaseBoundaryError'
    this.code = code
    this.detail = detail
  }
}

// ── Git 只读适配器 ─────────────────────────────────────────────────────────
/** 允许的 Git 子命令白名单:全部只读。hash-object 不带 -w 时也只读(用于按 clean 过滤器算工作区文件的 blob id)。 */
export const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze([
  'version',
  'rev-parse',
  'symbolic-ref',
  'status',
  'ls-tree',
  'cat-file',
  'ls-files',
  'rev-list',
  'for-each-ref',
  'hash-object'
])
const READ_ONLY_SET = new Set(READ_ONLY_GIT_SUBCOMMANDS)
const FORBIDDEN_GIT_ARGS = new Set(['-w', '--write', '-f', '--force', '-d', '--delete', '-c', '-C'])

/**
 * @param {{ cwd: string, role: string, recorder?: Array<object> | null, spawnImpl?: typeof spawnSync }} opts
 */
export function createGitAdapter({ cwd, role, recorder = null, spawnImpl = spawnSync }) {
  return {
    cwd,
    role,
    run(args, opts = {}) {
      if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string')
        throw new ReleaseBoundaryError('GIT_ARGS_INVALID', 'git 调用必须是非空参数数组')
      if (!READ_ONLY_SET.has(args[0]))
        throw new ReleaseBoundaryError(
          'GIT_SUBCOMMAND_NOT_ALLOWED',
          `git 子命令不在只读白名单:${args[0]}`
        )
      for (const a of args)
        if (FORBIDDEN_GIT_ARGS.has(a))
          throw new ReleaseBoundaryError('GIT_ARG_NOT_ALLOWED', `git 参数被禁止:${a}`)
      if (recorder) recorder.push({ program: 'git', args: [...args], cwdRole: role })
      const res = spawnImpl('git', args, {
        cwd,
        encoding: opts.binary ? null : 'utf8',
        input: opts.input,
        maxBuffer: 1024 * 1024 * 1024,
        shell: false,
        windowsHide: true
      })
      if (res.error)
        throw new ReleaseExecutionError('GIT_SPAWN_FAILED', `git ${args[0]} 无法启动`, {
          code: res.error.code ?? null
        })
      return res
    }
  }
}

function must(res, what) {
  if (res.status !== 0)
    throw new ReleaseExecutionError('GIT_COMMAND_FAILED', `git ${what} 退出 ${res.status}`, {
      exit: res.status,
      stderr: String(res.stderr ?? '').slice(0, 400)
    })
  return res
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')
export const isFullOid = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
export const isSha256Hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

/** 解析 ref 为完整 commit id;不存在 → null。符号名由调用方事先拒绝,这里只做对象解析。 */
export function resolveCommit(git, ref) {
  const res = git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`])
  if (res.status !== 0) return null
  const oid = String(res.stdout).trim()
  return isFullOid(oid) ? oid : null
}

export function currentBranch(git) {
  const res = git.run(['symbolic-ref', '-q', 'HEAD'])
  if (res.status !== 0) return null
  return String(res.stdout).trim()
}

export function gitVersion(git) {
  return String(must(git.run(['version']), 'version').stdout).trim()
}

/** 仓库定位:顶层 / git-dir / common-dir。用于核对 cwd 是仓库根、且不是 worktree。 */
export function repositoryLayout(git) {
  const res = must(
    git.run([
      'rev-parse',
      '--show-toplevel',
      '--git-dir',
      '--git-common-dir',
      '--is-inside-work-tree'
    ]),
    'rev-parse layout'
  )
  const [toplevel, gitDir, commonDir, inside] = String(res.stdout).split(/\r?\n/)
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(git.cwd, p))
  return {
    toplevel: realOrNull(toplevel),
    gitDir: realOrNull(abs(gitDir)),
    commonDir: realOrNull(abs(commonDir)),
    insideWorkTree: inside === 'true'
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}

/** `git status --porcelain=v2 -z --untracked-files=all --no-renames`;空即干净。 */
export function worktreeStatus(git) {
  const res = must(
    git.run(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames']),
    'status'
  )
  const records = String(res.stdout).split('\0').filter(Boolean)
  const changed = []
  const untracked = []
  const unmerged = []
  for (const rec of records) {
    const tag = rec[0]
    if (tag === '1' || tag === '2') {
      const parts = rec.split(' ')
      changed.push(parts.slice(8).join(' '))
    } else if (tag === 'u') {
      const parts = rec.split(' ')
      unmerged.push(parts.slice(10).join(' '))
    } else if (tag === '?') {
      untracked.push(rec.slice(2))
    }
  }
  return {
    clean: records.length === 0,
    changed,
    untracked,
    unmerged
  }
}

/** `git ls-tree -r -z --full-tree <commit>` → [{mode,type,oid,path}] */
export function listTree(git, commit) {
  const res = must(git.run(['ls-tree', '-r', '-z', '--full-tree', commit]), 'ls-tree')
  const out = []
  for (const rec of String(res.stdout).split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    if (tab < 0) throw new ReleaseExecutionError('LS_TREE_PARSE', 'ls-tree 记录无法解析')
    const [mode, type, oid] = rec.slice(0, tab).split(' ')
    out.push({ mode, type, oid, path: rec.slice(tab + 1) })
  }
  return out
}

/** `<commit>:<path>` 的 blob id;不存在 → null。 */
export function blobOidAt(git, commit, relPath) {
  const res = git.run(['rev-parse', '--verify', '-q', '--end-of-options', `${commit}:${relPath}`])
  if (res.status !== 0) return null
  const oid = String(res.stdout).trim()
  return isFullOid(oid) ? oid : null
}

/** 工作区文件经 clean 过滤器后的 blob id(hash-object 不带 -w,只算不写)。文件不存在 → null。 */
export function worktreeBlobOid(git, root, relPath) {
  const abs = path.join(root, ...relPath.split('/'))
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    return null
  }
  const res = must(
    git.run(['hash-object', '--stdin', '--path', relPath], { input: buf, binary: true }),
    'hash-object'
  )
  return String(res.stdout).trim()
}

/** 批量读 blob:`cat-file --batch`,返回 Map<oid, Buffer>;缺失对象记入 missing。 */
export function readBlobs(git, oids) {
  const map = new Map()
  const missing = []
  const unique = [...new Set(oids)]
  if (unique.length === 0) return { map, missing }
  const res = must(
    git.run(['cat-file', '--batch'], {
      input: Buffer.from(unique.join('\n') + '\n', 'utf8'),
      binary: true
    }),
    'cat-file --batch'
  )
  const out = res.stdout
  let i = 0
  while (i < out.length) {
    const nl = out.indexOf(0x0a, i)
    if (nl < 0) throw new ReleaseExecutionError('CAT_FILE_PARSE', 'cat-file 头部不完整')
    const header = out.subarray(i, nl).toString('utf8').split(' ')
    if (header[1] === 'missing') {
      missing.push(header[0])
      i = nl + 1
      continue
    }
    const size = Number(header[2])
    if (!Number.isInteger(size) || size < 0)
      throw new ReleaseExecutionError('CAT_FILE_PARSE', 'cat-file 尺寸无法解析')
    const start = nl + 1
    map.set(header[0], Buffer.from(out.subarray(start, start + size)))
    i = start + size + 1
  }
  return { map, missing }
}

/** 批量判断对象是否存在于某仓库(`cat-file --batch-check`)。返回 Set<存在的 oid>。 */
export function existingObjects(git, oids) {
  const present = new Set()
  const unique = [...new Set(oids)]
  if (unique.length === 0) return present
  const res = must(
    git.run(['cat-file', '--batch-check'], {
      input: Buffer.from(unique.join('\n') + '\n', 'utf8')
    }),
    'cat-file --batch-check'
  )
  for (const line of String(res.stdout).split('\n')) {
    const parts = line.trim().split(' ')
    if (parts.length >= 3 && parts[1] !== 'missing') present.add(parts[0])
  }
  return present
}

/** `rev-list --parents <tip>` → [{oid, parents[]}](从 tip 向根)。 */
export function commitChain(git, tip) {
  const res = must(git.run(['rev-list', '--parents', tip]), 'rev-list --parents')
  return String(res.stdout)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [oid, ...parents] = line.trim().split(' ')
      return { oid, parents }
    })
}

/** 全部标签:名称 / 对象 id / 对象类型 / 剥离后目标。 */
export function listTags(git) {
  const res = must(
    git.run([
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)',
      'refs/tags'
    ]),
    'for-each-ref'
  )
  return String(res.stdout)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, objectId, objectType, peeled] = line.split('\0')
      return { name, objectId, objectType, targetId: peeled || objectId }
    })
}

// ── 规则(policy)────────────────────────────────────────────────────────────
const POLICY_REQUIRED_KEYS = [
  'schemaVersion',
  'stripPaths',
  'forbiddenCandidatePaths',
  'requiredTargets',
  'publicDocuments',
  'internalMarkers',
  'linkRules',
  'artifactRules',
  'checks',
  'admissionLabels',
  'controlledRoot'
]
/** Windows 不可表示字符:控制字符 0x00-0x1f 与 <>:"|?*(控制区间用 fromCharCode 构造,避免源码里出现真实控制字节)。 */
const WIN_ILLEGAL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + '<>:"|?*]'
)
const GLOB_CHARS = /[*?[\]{}]/
const STATUSES = Object.freeze([
  'PASS',
  'FAIL',
  'ERROR',
  'UNCHECKED',
  'PENDING',
  'DEFERRED_PUSH_LINK',
  'NOT_APPLICABLE'
])
export const STATUS_VALUES = STATUSES

/** 仓库相对 POSIX 路径的字面形态检查(规则、登记、树条目共用)。 */
export function posixPathProblems(p, { directory = false } = {}) {
  const problems = []
  if (typeof p !== 'string' || p.length === 0) return ['empty']
  if (p.includes('\\')) problems.push('backslash')
  if (p.startsWith('/')) problems.push('leading-slash')
  if (/^[A-Za-z]:/.test(p)) problems.push('drive-letter')
  if (p.startsWith('//') || p.startsWith('\\\\')) problems.push('unc')
  const segs = p.split('/')
  if (directory) {
    if (!p.endsWith('/')) problems.push('directory-missing-trailing-slash')
    segs.pop()
  } else if (p.endsWith('/')) problems.push('file-trailing-slash')
  for (const s of segs) {
    if (s === '') problems.push('empty-segment')
    if (s === '.' || s === '..') problems.push('dot-segment')
    else if (/[ .]$/.test(s)) problems.push('windows-trailing-space-or-dot')
    if (s.toLowerCase() === '.git') problems.push('git-segment')
    if (WIN_ILLEGAL_RE.test(s)) problems.push('windows-illegal-char')
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s))
      problems.push('windows-reserved-name')
  }
  return [...new Set(problems)]
}

export function validatePolicy(policy) {
  const errors = []
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['policy-not-object']
  for (const k of POLICY_REQUIRED_KEYS) if (!(k in policy)) errors.push(`missing:${k}`)
  if (policy.schemaVersion !== 1) errors.push('schemaVersion-not-1')
  const ids = new Set()
  const paths = new Set()
  for (const listName of ['stripPaths', 'forbiddenCandidatePaths']) {
    const list = policy[listName]
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${listName}-not-array`)
      continue
    }
    for (const rule of list) {
      if (!rule || typeof rule !== 'object') {
        errors.push(`${listName}-entry-not-object`)
        continue
      }
      if (typeof rule.id !== 'string' || ids.has(rule.id))
        errors.push(`${listName}-bad-or-duplicate-id`)
      ids.add(rule.id)
      if (rule.kind !== 'directory' && rule.kind !== 'file')
        errors.push(`${listName}-bad-kind:${rule.id}`)
      if (typeof rule.path !== 'string' || GLOB_CHARS.test(rule.path))
        errors.push(`${listName}-path-not-literal:${rule.id}`)
      else {
        const probs = posixPathProblems(rule.path, { directory: rule.kind === 'directory' }).filter(
          (x) => x !== 'git-segment'
        )
        if (probs.length) errors.push(`${listName}-path-invalid:${rule.id}:${probs.join(',')}`)
        if (paths.has(`${listName}:${rule.path}`))
          errors.push(`${listName}-duplicate-path:${rule.id}`)
        paths.add(`${listName}:${rule.path}`)
      }
    }
  }
  const rt = policy.requiredTargets
  if (!rt || !Array.isArray(rt.files) || !Array.isArray(rt.directories))
    errors.push('requiredTargets-shape')
  else {
    for (const f of rt.files)
      if (posixPathProblems(f).length) errors.push(`requiredTargets-file-invalid:${f}`)
    for (const d of rt.directories)
      if (
        !d ||
        posixPathProblems(d.path, { directory: true }).length ||
        !Number.isInteger(d.minEntries)
      )
        errors.push(`requiredTargets-directory-invalid:${d && d.path}`)
    if (rt.provenance) {
      for (const k of ['registry', 'materialsField', 'pathField', 'sha256Field'])
        if (typeof rt.provenance[k] !== 'string')
          errors.push(`requiredTargets-provenance-missing:${k}`)
    }
  }
  const pd = policy.publicDocuments
  if (
    !pd ||
    typeof pd.registry !== 'string' ||
    !Array.isArray(pd.documents) ||
    !Number.isInteger(pd.exactCount)
  )
    errors.push('publicDocuments-shape')
  else {
    if (pd.documents.length !== pd.exactCount) errors.push('publicDocuments-count-mismatch')
    for (const d of pd.documents)
      for (const k of ['sourcePath', 'publicPath', 'targetPath'])
        if (!d || posixPathProblems(d[k]).length) errors.push(`publicDocuments-path-invalid:${k}`)
    if (!Array.isArray(pd.forbiddenTargets)) errors.push('publicDocuments-forbiddenTargets-missing')
  }
  const im = policy.internalMarkers
  if (!im || !Array.isArray(im.markers) || !Array.isArray(im.allowedLiteralPositions))
    errors.push('internalMarkers-shape')
  else
    for (const m of im.markers)
      if (!m || typeof m.id !== 'string' || typeof m.value !== 'string' || !m.kind)
        errors.push('internalMarkers-marker-invalid')
  if (!Array.isArray(policy.checks) || policy.checks.length === 0) errors.push('checks-empty')
  else {
    const seen = new Set()
    for (const c of policy.checks) {
      if (!c || typeof c.id !== 'string' || seen.has(c.id))
        errors.push('checks-bad-or-duplicate-id')
      seen.add(c && c.id)
      if (!c || !c.stages || typeof c.stages !== 'object')
        errors.push(`checks-stages-missing:${c && c.id}`)
      else
        for (const st of ['pre-push', 'pre-release'])
          if (!['required', 'not-applicable'].includes(c.stages[st]))
            errors.push(`checks-stage-value-invalid:${c.id}:${st}`)
      if (!c || !Array.isArray(c.subchecks) || c.subchecks.length === 0)
        errors.push(`checks-subchecks-empty:${c && c.id}`)
    }
  }
  const al = policy.admissionLabels
  if (
    !al ||
    al.prepare !== 'candidate-prepared' ||
    al['pre-push'] !== 'push-admissible' ||
    al['pre-release'] !== 'release-admissible'
  )
    errors.push('admissionLabels-invalid')
  if (
    typeof policy.controlledRoot !== 'string' ||
    posixPathProblems(policy.controlledRoot, { directory: true }).length
  )
    errors.push('controlledRoot-invalid')
  return errors
}

export function parsePolicyBuffer(buf) {
  let policy
  try {
    policy = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new ReleaseExecutionError('POLICY_PARSE', `release-policy.json 解析失败:${e.message}`)
  }
  return { policy, sha256: sha256Hex(buf), errors: validatePolicy(policy) }
}

/** 路径分类:命中的剥离规则 / 禁止规则 / 大小写变体。规则字面量精确匹配,目录规则含自身与所有后代。 */
export function classifyPath(p, policy) {
  const hit = (list) => {
    let exact = null
    let caseVariant = null
    for (const rule of list) {
      const rp = rule.path
      if (rule.kind === 'directory') {
        if (p.startsWith(rp)) exact = exact ?? rule
        else if (p.toLowerCase().startsWith(rp.toLowerCase())) caseVariant = caseVariant ?? rule
      } else if (p === rp) exact = exact ?? rule
      else if (p.toLowerCase() === rp.toLowerCase()) caseVariant = caseVariant ?? rule
    }
    return { exact, caseVariant }
  }
  const strip = hit(policy.stripPaths)
  const forbidden = hit(policy.forbiddenCandidatePaths)
  return {
    stripped: strip.exact,
    forbidden: forbidden.exact,
    caseVariantOf: strip.caseVariant ?? forbidden.caseVariant
  }
}

// ── 登记(sync-base)────────────────────────────────────────────────────────
const REGISTRY_ROW_KEYS = ['sourcePath', 'publicPath', 'targetPath', 'baseCommit', 'publicSha256']

export function validateRegistry(registry, policy) {
  const errors = []
  if (!registry || typeof registry !== 'object' || Array.isArray(registry))
    return ['registry-not-object']
  if (registry.schemaVersion !== policy.publicDocuments.registrySchemaVersion)
    errors.push('schemaVersion-mismatch')
  const docs = registry.documents
  if (!Array.isArray(docs)) return [...errors, 'documents-not-array']
  if (docs.length !== policy.publicDocuments.exactCount)
    errors.push(`documents-count:${docs.length}!=${policy.publicDocuments.exactCount}`)
  const seen = { sourcePath: new Set(), publicPath: new Set(), targetPath: new Set() }
  const forbiddenTargets = new Set(policy.publicDocuments.forbiddenTargets ?? [])
  const expected = new Set(
    policy.publicDocuments.documents.map((d) => `${d.sourcePath}|${d.publicPath}|${d.targetPath}`)
  )
  for (const [i, row] of docs.entries()) {
    if (!row || typeof row !== 'object') {
      errors.push(`row${i}-not-object`)
      continue
    }
    const keys = Object.keys(row).sort()
    if (keys.join(',') !== [...REGISTRY_ROW_KEYS].sort().join(','))
      errors.push(`row${i}-keys:${keys.join('+')}`)
    for (const k of ['sourcePath', 'publicPath', 'targetPath']) {
      const probs = posixPathProblems(row[k])
      if (probs.length) errors.push(`row${i}-${k}-invalid:${probs.join(',')}`)
      else {
        if (seen[k].has(row[k])) errors.push(`row${i}-${k}-duplicate:${row[k]}`)
        seen[k].add(row[k])
      }
    }
    if (typeof row.baseCommit !== 'string') errors.push(`row${i}-baseCommit-missing`)
    else if (!isFullOid(row.baseCommit))
      errors.push(`row${i}-baseCommit-not-full-oid:${row.baseCommit.slice(0, 12)}`)
    if (!isSha256Hex(row.publicSha256)) errors.push(`row${i}-publicSha256-invalid`)
    if (forbiddenTargets.has(row.targetPath))
      errors.push(`row${i}-target-forbidden:${row.targetPath}`)
    if (typeof row.publicPath === 'string' && !classifyPath(row.publicPath, policy).stripped)
      errors.push(`row${i}-publicPath-not-stripped:${row.publicPath}`)
    if (typeof row.targetPath === 'string' && classifyPath(row.targetPath, policy).stripped)
      errors.push(`row${i}-targetPath-stripped:${row.targetPath}`)
    const triple = `${row.sourcePath}|${row.publicPath}|${row.targetPath}`
    if (!expected.has(triple)) errors.push(`row${i}-not-in-policy:${row.targetPath}`)
    expected.delete(triple)
  }
  for (const t of expected) errors.push(`policy-document-missing-in-registry:${t.split('|')[2]}`)
  return errors
}

export function parseRegistryBuffer(buf, policy) {
  let registry
  try {
    registry = JSON.parse(buf.toString('utf8'))
  } catch (e) {
    throw new ReleaseExecutionError('REGISTRY_PARSE', `sync-base.json 解析失败:${e.message}`)
  }
  return { registry, sha256: sha256Hex(buf), errors: validateRegistry(registry, policy) }
}

// ── 同步核对(I-05 / I-06)────────────────────────────────────────────────────
function firstDifferingLine(a, b) {
  const la = a.toString('utf8').split('\n')
  const lb = b.toString('utf8').split('\n')
  const n = Math.min(la.length, lb.length)
  for (let i = 0; i < n; i++) if (la[i] !== lb[i]) return i + 1
  return la.length === lb.length ? null : n + 1
}

/**
 * 逐文件同步核对:冻结 commit 的内部源 blob 对 baseCommit 同文件;工作区源经 clean 过滤器对冻结 blob;
 * 公开 blob 的 sha256 对登记值。无关提交不构成漂移。任何情况下都不写登记 / 公开文件。
 * @returns {{ subchecks: Array<object>, documents: Array<object> }}
 */
export function checkSync({ git, root, commit, registry, registryErrors }) {
  const sub = []
  const documents = []
  const push = (id, status, reasonCode = null, detail = null) =>
    sub.push({ id, status, reasonCode, detail })

  if (registryErrors.length)
    push('registry-shape', 'FAIL', 'REGISTRY_INVALID', { errors: registryErrors })
  else push('registry-shape', 'PASS')

  if (!registry || !Array.isArray(registry.documents)) {
    for (const id of [
      'base-commit-resolvable',
      'source-blob-unchanged-vs-base',
      'working-tree-source-unchanged',
      'public-hash-matches'
    ])
      push(id, 'UNCHECKED', 'REGISTRY_UNREADABLE')
    return { subchecks: sub, documents }
  }

  const bases = new Map()
  let baseUnresolvable = []
  for (const row of registry.documents) {
    if (!isFullOid(row.baseCommit)) continue
    if (!bases.has(row.baseCommit)) bases.set(row.baseCommit, resolveCommit(git, row.baseCommit))
    if (!bases.get(row.baseCommit)) baseUnresolvable.push(row.baseCommit)
  }
  baseUnresolvable = [...new Set(baseUnresolvable)]
  if (baseUnresolvable.length)
    push('base-commit-resolvable', 'PENDING', 'BASE_COMMIT_UNRESOLVABLE', {
      commits: baseUnresolvable
    })
  else push('base-commit-resolvable', 'PASS')

  const drift = []
  const uncommitted = []
  const hashMismatch = []
  const missing = []
  const needBlobs = []
  for (const row of registry.documents) {
    const rec = {
      sourcePath: row.sourcePath,
      publicPath: row.publicPath,
      targetPath: row.targetPath,
      baseCommit: row.baseCommit,
      sourceBlobAtCommit: null,
      sourceBlobAtBase: null,
      worktreeSourceBlob: null,
      publicBlobAtCommit: null,
      publicSha256Registered: row.publicSha256,
      publicSha256Actual: null,
      status: 'PASS',
      reasonCodes: []
    }
    documents.push(rec)
    if (posixPathProblems(row.sourcePath).length || posixPathProblems(row.publicPath).length) {
      rec.status = 'FAIL'
      rec.reasonCodes.push('REGISTRY_INVALID')
      continue
    }
    rec.sourceBlobAtCommit = blobOidAt(git, commit, row.sourcePath)
    rec.publicBlobAtCommit = blobOidAt(git, commit, row.publicPath)
    if (!rec.sourceBlobAtCommit) {
      missing.push({ path: row.sourcePath, at: 'frozen-commit' })
      rec.reasonCodes.push('SOURCE_MISSING_AT_COMMIT')
    }
    if (!rec.publicBlobAtCommit) {
      missing.push({ path: row.publicPath, at: 'frozen-commit' })
      rec.reasonCodes.push('PUBLIC_MISSING_AT_COMMIT')
    }
    if (isFullOid(row.baseCommit) && bases.get(row.baseCommit)) {
      rec.sourceBlobAtBase = blobOidAt(git, row.baseCommit, row.sourcePath)
      if (!rec.sourceBlobAtBase) {
        missing.push({ path: row.sourcePath, at: 'base-commit' })
        rec.reasonCodes.push('SOURCE_MISSING_AT_BASE')
      } else if (rec.sourceBlobAtCommit && rec.sourceBlobAtBase !== rec.sourceBlobAtCommit) {
        needBlobs.push(rec.sourceBlobAtCommit, rec.sourceBlobAtBase)
        drift.push(rec)
        rec.reasonCodes.push('SYNC_DRIFT')
      }
    }
    rec.worktreeSourceBlob = worktreeBlobOid(git, root, row.sourcePath)
    if (rec.sourceBlobAtCommit && rec.worktreeSourceBlob !== rec.sourceBlobAtCommit) {
      uncommitted.push(row.sourcePath)
      rec.reasonCodes.push('SYNC_DRIFT_UNCOMMITTED')
    }
    if (rec.publicBlobAtCommit) needBlobs.push(rec.publicBlobAtCommit)
    if (rec.reasonCodes.length) rec.status = 'FAIL'
  }
  const blobs = needBlobs.length ? readBlobs(git, needBlobs).map : new Map()
  const driftDetail = []
  for (const rec of drift) {
    const a = blobs.get(rec.sourceBlobAtCommit)
    const b = blobs.get(rec.sourceBlobAtBase)
    driftDetail.push({
      path: rec.sourcePath,
      frozenBlob: rec.sourceBlobAtCommit,
      baseBlob: rec.sourceBlobAtBase,
      frozenBytes: a ? a.length : null,
      baseBytes: b ? b.length : null,
      firstDifferingLine: a && b ? firstDifferingLine(a, b) : null,
      note: 'redacted: sizes and first differing line only; content is not printed'
    })
  }
  for (const rec of documents) {
    if (!rec.publicBlobAtCommit) continue
    const buf = blobs.get(rec.publicBlobAtCommit)
    rec.publicSha256Actual = buf ? sha256Hex(buf) : null
    if (rec.publicSha256Actual !== rec.publicSha256Registered) {
      hashMismatch.push({
        path: rec.publicPath,
        registered: rec.publicSha256Registered,
        actual: rec.publicSha256Actual
      })
      rec.reasonCodes.push('PUBLIC_HASH_MISMATCH')
      rec.status = 'FAIL'
    }
    const wt = worktreeBlobOid(git, root, rec.publicPath)
    if (wt !== rec.publicBlobAtCommit) {
      rec.reasonCodes.push('PUBLIC_FILE_UNCOMMITTED_CHANGE')
      rec.status = 'FAIL'
      hashMismatch.push({
        path: rec.publicPath,
        registered: rec.publicSha256Registered,
        actual: 'working-tree differs from frozen blob'
      })
    }
  }
  if (missing.length)
    push('source-blob-unchanged-vs-base', 'FAIL', 'SOURCE_OR_PUBLIC_MISSING', { missing })
  else if (driftDetail.length)
    push('source-blob-unchanged-vs-base', 'FAIL', 'SYNC_DRIFT', { drift: driftDetail })
  else if (baseUnresolvable.length)
    push('source-blob-unchanged-vs-base', 'PENDING', 'BASE_COMMIT_UNRESOLVABLE')
  else push('source-blob-unchanged-vs-base', 'PASS', null, { documents: documents.length })
  if (uncommitted.length)
    push('working-tree-source-unchanged', 'FAIL', 'SYNC_DRIFT_UNCOMMITTED', { paths: uncommitted })
  else push('working-tree-source-unchanged', 'PASS')
  if (hashMismatch.length)
    push('public-hash-matches', 'FAIL', 'PUBLIC_HASH_MISMATCH', { mismatches: hashMismatch })
  else if (missing.some((m) => m.at === 'frozen-commit'))
    push('public-hash-matches', 'FAIL', 'PUBLIC_MISSING_AT_COMMIT')
  else push('public-hash-matches', 'PASS')
  return { subchecks: sub, documents }
}

// ── 期望清单派生(策略 + 冻结 blobs + 登记覆盖)──────────────────────────────
const SUPPORTED_MODES = new Set(['100644', '100755'])
export const MANIFEST_DIGEST_KIND = 'sha256-of-sorted-manifest-lines(mode sha256 bytes path)'

export function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** 候选摘要:排序清单行 `mode sha256 bytes path` 的 SHA256。它不是 Git tree OID。任一条目缺 sha256 → null。 */
export function manifestDigest(entries) {
  const sorted = [...entries].sort((a, b) => compareUtf8(a.path, b.path))
  if (!sorted.every((r) => r.sha256)) return null
  const lines = sorted.map((r) => `${r.mode} ${r.sha256} ${r.bytes} ${r.path}`)
  return sha256Hex(Buffer.from(lines.join('\n') + '\n', 'utf8'))
}

/**
 * 从冻结树条目派生期望清单。不读工作区;内容来自 readBlob(oid) → Buffer。
 * @returns {{ entries: Array<object>, digest: string|null, findings: Array<object>, stats: object }}
 */
export function deriveExpectedManifest({ treeEntries, policy, registry, readBlob }) {
  const findings = []
  const add = (subcheck, reasonCode, detail) => findings.push({ subcheck, reasonCode, detail })
  const strippedByRule = {}
  const retained = []

  for (const e of treeEntries) {
    const cls = classifyPath(e.path, policy)
    if (cls.caseVariantOf)
      add('path-safety', 'CASE_VARIANT_OF_RULE_PATH', { path: e.path, rule: cls.caseVariantOf.id })
    if (cls.stripped) {
      strippedByRule[cls.stripped.id] = (strippedByRule[cls.stripped.id] ?? 0) + 1
      continue
    }
    if (cls.forbidden)
      add('forbidden-tracked-input', 'FORBIDDEN_TRACKED_INPUT', {
        path: e.path,
        rule: cls.forbidden.id
      })
    if (e.type !== 'blob' || !SUPPORTED_MODES.has(e.mode)) {
      const code =
        e.mode === '120000'
          ? 'SYMLINK_ENTRY'
          : e.mode === '160000'
            ? 'GITLINK_ENTRY'
            : 'UNSUPPORTED_MODE'
      add('tree-entries-supported', code, { path: e.path, mode: e.mode, type: e.type })
      continue
    }
    const probs = posixPathProblems(e.path)
    if (probs.length) {
      add('path-safety', 'PATH_UNSAFE', { path: e.path, problems: probs })
      continue
    }
    retained.push({ path: e.path, mode: e.mode, blob: e.oid, origin: 'tree' })
  }

  // 大小写碰撞:文件 / 目录前缀统一按小写比对
  const lowerSeen = new Map()
  for (const r of retained) {
    const segs = r.path.split('/')
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/')
      const kind = i === segs.length ? 'file' : 'dir'
      const key = prefix.toLowerCase()
      const prev = lowerSeen.get(key)
      if (!prev) lowerSeen.set(key, { prefix, kind })
      else if (prev.prefix !== prefix || prev.kind !== kind) {
        if (prev.prefix !== prefix)
          add('path-safety', 'CASE_COLLISION', { a: prev.prefix, b: prefix })
        else add('path-safety', 'FILE_DIRECTORY_CONFLICT', { path: prefix })
      }
    }
  }

  // 公开覆盖
  const byPath = new Map(retained.map((r) => [r.path, r]))
  const overlays = []
  if (registry && Array.isArray(registry.documents)) {
    for (const row of registry.documents) {
      if (typeof row.targetPath !== 'string' || typeof row.publicPath !== 'string') continue
      const target = byPath.get(row.targetPath)
      if (!target) {
        add('candidate-matches-expected', 'OVERLAY_TARGET_NOT_IN_TREE', {
          targetPath: row.targetPath
        })
        continue
      }
      const pub = treeEntries.find((e) => e.path === row.publicPath && e.type === 'blob')
      if (!pub) {
        add('candidate-matches-expected', 'OVERLAY_PUBLIC_NOT_IN_TREE', {
          publicPath: row.publicPath
        })
        continue
      }
      target.blob = pub.oid
      target.origin = `overlay:${row.publicPath}`
      overlays.push({ targetPath: row.targetPath, publicPath: row.publicPath, blob: pub.oid })
    }
  }

  // 必留目标
  const rt = policy.requiredTargets
  const missingFiles = rt.files.filter((f) => !byPath.has(f))
  if (missingFiles.length)
    add('required-targets', 'REQUIRED_TARGET_MISSING', { files: missingFiles })
  for (const d of rt.directories) {
    const n = retained.filter((r) => r.path.startsWith(d.path)).length
    if (n < d.minEntries)
      add('required-targets', 'REQUIRED_DIRECTORY_SHORT', {
        directory: d.path,
        entries: n,
        minEntries: d.minEntries
      })
  }

  // 内容与哈希
  const blobs = readBlob([...new Set(retained.map((r) => r.blob))])
  if (blobs.missing.length)
    add('candidate-matches-expected', 'BLOB_MISSING', { blobs: blobs.missing })
  for (const r of retained) {
    const buf = blobs.map.get(r.blob)
    if (!buf) {
      r.sha256 = null
      r.bytes = null
      continue
    }
    r.sha256 = sha256Hex(buf)
    r.bytes = buf.length
  }

  // 许可材料登记(从冻结 blob 读,不读第二份清单)
  if (rt.provenance) {
    const prov = byPath.get(rt.provenance.registry)
    const buf = prov ? blobs.map.get(prov.blob) : null
    if (!buf)
      add('required-targets', 'PROVENANCE_REGISTRY_MISSING', { path: rt.provenance.registry })
    else {
      let materials = null
      try {
        materials = JSON.parse(buf.toString('utf8'))[rt.provenance.materialsField]
      } catch {
        add('required-targets', 'PROVENANCE_REGISTRY_UNPARSEABLE', { path: rt.provenance.registry })
      }
      if (Array.isArray(materials)) {
        const bad = []
        for (const m of materials) {
          const p = m[rt.provenance.pathField]
          const want = m[rt.provenance.sha256Field]
          const got = byPath.get(p)
          if (!got) bad.push({ path: p, reason: 'missing' })
          else if (rt.provenance.mustMatchSha256 && got.sha256 !== want)
            bad.push({ path: p, reason: 'sha256-mismatch' })
        }
        if (bad.length) add('required-targets', 'PROVENANCE_MATERIAL_MISMATCH', { materials: bad })
      }
    }
  }

  retained.sort((a, b) => compareUtf8(a.path, b.path))
  const digest = manifestDigest(retained)
  return {
    entries: retained,
    digest,
    digestKind: MANIFEST_DIGEST_KIND,
    findings,
    overlays,
    stats: {
      treeEntries: treeEntries.length,
      retained: retained.length,
      strippedByRule,
      strippedTotal: Object.values(strippedByRule).reduce((s, n) => s + n, 0),
      totalBytes: retained.reduce((s, r) => s + (r.bytes ?? 0), 0)
    },
    blobs: blobs.map
  }
}

// ── 受控根与候选写入 ────────────────────────────────────────────────────────
export const OWNER_MARKER = '.downlord-release-owner.json'
export const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isSafeReleaseId(id) {
  return (
    typeof id === 'string' &&
    RELEASE_ID_RE.test(id) &&
    !id.includes('..') &&
    id !== '.' &&
    id !== '.git'
  )
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

/** 确保 dir 存在、是真实目录(非链接 / 重解析点)、且解析后仍在 insideReal 之内。 */
function ensureRealDirInside(dir, insideReal) {
  const st = lstatOrNull(dir)
  if (!st) fs.mkdirSync(dir)
  else if (st.isSymbolicLink())
    throw new ReleaseBoundaryError('REPARSE_POINT', '受控根路径上存在链接或重解析点', {
      path: roleOf(dir, insideReal)
    })
  else if (!st.isDirectory())
    throw new ReleaseBoundaryError('NOT_DIRECTORY', '受控根路径不是目录', {
      path: roleOf(dir, insideReal)
    })
  const real = fs.realpathSync.native(dir)
  if (!(real === insideReal || real.startsWith(insideReal + path.sep)))
    throw new ReleaseBoundaryError('OUTSIDE_CONTROLLED_ROOT', '路径解析后越出受控根')
  return real
}

function roleOf(p, insideReal) {
  const real = realOrNull(p) ?? p
  return real.startsWith(insideReal)
    ? '<internal-root>' + real.slice(insideReal.length).split(path.sep).join('/')
    : '<outside>'
}

/**
 * 解析并创建受控发布根:<internalRoot>/<controlledRoot>/<releaseId>。
 * 逐级核对真实目录与重解析点;返回真实绝对路径集合。
 */
export function resolveReleaseRoot({ internalRoot, controlledRoot, releaseId }) {
  if (!isSafeReleaseId(releaseId))
    throw new ReleaseBoundaryError('RELEASE_ID_UNSAFE', 'release-id 不是安全标识')
  if (
    typeof controlledRoot !== 'string' ||
    posixPathProblems(controlledRoot, { directory: true }).length
  )
    throw new ReleaseBoundaryError('CONTROLLED_ROOT_INVALID', '受控根字面量不合法')
  const internalReal = fs.realpathSync.native(internalRoot)
  const segs = controlledRoot.split('/').filter(Boolean)
  let cur = internalReal
  for (const s of segs) cur = ensureRealDirInside(path.join(cur, s), internalReal)
  const controlledReal = cur
  const releaseReal = ensureRealDirInside(path.join(controlledReal, releaseId), controlledReal)
  return {
    internalReal,
    controlledReal,
    releaseReal,
    candidateDir: path.join(releaseReal, 'candidate'),
    reportsDir: path.join(releaseReal, 'reports'),
    evidenceDir: path.join(releaseReal, 'evidence'),
    buildDir: path.join(releaseReal, 'build'),
    sourceJson: path.join(releaseReal, 'source.json'),
    manifestJson: path.join(releaseReal, 'candidate-manifest.json')
  }
}

/** 遍历真实候选目录:逐文件 sha256;链接 / .git / 不可读均记异常。路径统一 POSIX、按字节序排序。 */
export function walkCandidate(candidateDir) {
  const entries = []
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
      const st = lstatOrNull(abs)
      if (!st) {
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
      if (d.name === OWNER_MARKER && rel === '') continue
      if (!st.isFile()) {
        anomalies.push({ path: relPath, kind: 'not-regular-file' })
        continue
      }
      try {
        const buf = fs.readFileSync(abs)
        entries.push({ path: relPath, sha256: sha256Hex(buf), bytes: buf.length })
      } catch (e) {
        anomalies.push({ path: relPath, kind: 'unreadable', code: e.code ?? null })
      }
    }
  }
  walk(candidateDir, '')
  entries.sort((a, b) => compareUtf8(a.path, b.path))
  return { entries, anomalies }
}

/** 实际候选与期望清单逐项比对。 */
export function compareCandidate(expectedEntries, actual) {
  const exp = new Map(expectedEntries.map((e) => [e.path, e]))
  const act = new Map(actual.entries.map((e) => [e.path, e]))
  const missing = []
  const extra = []
  const modified = []
  for (const [p, e] of exp) {
    const a = act.get(p)
    if (!a) missing.push(p)
    else if (a.sha256 !== e.sha256 || a.bytes !== e.bytes) modified.push(p)
  }
  for (const p of act.keys()) if (!exp.has(p)) extra.push(p)
  const ok =
    missing.length === 0 &&
    extra.length === 0 &&
    modified.length === 0 &&
    actual.anomalies.length === 0
  const cap = (arr) => (arr.length > 50 ? [...arr.slice(0, 50), `…(+${arr.length - 50})`] : arr)
  return {
    ok,
    missing: cap(missing),
    extra: cap(extra),
    modified: cap(modified),
    anomalies: actual.anomalies.slice(0, 50)
  }
}

/**
 * 把期望清单写成候选:先写 .staging-<runId>(带所有权标记),复核完整后重命名为 candidate/。
 * 失败只删除本轮自己的暂存项;绝不触碰受控根之外的任何路径。
 */
export function writeCandidate({ roots, runId, releaseId, expectedEntries, blobs }) {
  if (lstatOrNull(roots.candidateDir))
    throw new ReleaseBoundaryError('CANDIDATE_EXISTS', 'candidate/ 已存在,不覆盖')
  const staging = path.join(roots.releaseReal, `.staging-${runId}`)
  if (lstatOrNull(staging))
    throw new ReleaseBoundaryError('STAGING_EXISTS', '同 run-id 暂存目录已存在')
  fs.mkdirSync(staging)
  const marker = { releaseId, runId, pid: process.pid, createdAt: new Date().toISOString() }
  fs.writeFileSync(path.join(staging, OWNER_MARKER), JSON.stringify(marker))
  const stagingReal = fs.realpathSync.native(staging)
  const cleanup = () => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(stagingReal, OWNER_MARKER), 'utf8'))
      if (m.runId !== runId || m.releaseId !== releaseId) return
      if (!stagingReal.startsWith(roots.releaseReal + path.sep)) return
      fs.rmSync(stagingReal, { recursive: true, force: false })
    } catch {
      /* 留给人工诊断,不扩大删除范围 */
    }
  }
  try {
    for (const e of expectedEntries) {
      const buf = blobs.get(e.blob)
      if (!buf) throw new ReleaseExecutionError('BLOB_MISSING', `blob 内容缺失:${e.path}`)
      const target = path.join(stagingReal, ...e.path.split('/'))
      const resolved = path.resolve(target)
      if (!resolved.startsWith(stagingReal + path.sep))
        throw new ReleaseBoundaryError('PATH_ESCAPE', '条目解析后越出暂存目录', { path: e.path })
      const parent = path.dirname(resolved)
      fs.mkdirSync(parent, { recursive: true })
      const pst = lstatOrNull(parent)
      if (!pst || pst.isSymbolicLink() || !pst.isDirectory())
        throw new ReleaseBoundaryError('REPARSE_POINT', '暂存父目录不是真实目录', { path: e.path })
      fs.writeFileSync(resolved, buf, { flag: 'wx' })
    }
    const actual = walkCandidate(stagingReal)
    const cmp = compareCandidate(expectedEntries, actual)
    if (!cmp.ok)
      throw new ReleaseExecutionError('STAGING_VERIFY_FAILED', '暂存内容与期望清单不一致', cmp)
    fs.rmSync(path.join(stagingReal, OWNER_MARKER))
    fs.renameSync(stagingReal, roots.candidateDir)
    return { candidateDir: roots.candidateDir, written: expectedEntries.length }
  } catch (err) {
    cleanup()
    throw err
  }
}

/** 列出发布根下不属于本轮的暂存目录(只报告,不删除)。 */
export function listForeignStaging(releaseReal, runId) {
  const out = []
  for (const name of fs.readdirSync(releaseReal)) {
    if (name.startsWith('.staging-') && name !== `.staging-${runId}`) out.push(name)
  }
  return out
}

// ── 公开历史只读检查(I-01 · 6a 接口)──────────────────────────────────────
export function validateBaseline(baseline) {
  const errors = []
  if (!baseline || typeof baseline !== 'object') return ['baseline-not-object']
  if (baseline.schemaVersion !== 1) errors.push('schemaVersion-not-1')
  if (!(baseline.previousPublicCommit === null || isFullOid(baseline.previousPublicCommit)))
    errors.push('previousPublicCommit-invalid')
  if (!Array.isArray(baseline.tags)) errors.push('tags-not-array')
  else
    for (const t of baseline.tags)
      if (!t || typeof t.name !== 'string' || !isFullOid(t.objectId) || !isFullOid(t.targetId))
        errors.push(`tag-invalid:${t && t.name}`)
  if (typeof baseline.confirmedBy !== 'string' || !baseline.confirmedBy)
    errors.push('confirmedBy-missing')
  if (typeof baseline.confirmedAt !== 'string' || !baseline.confirmedAt)
    errors.push('confirmedAt-missing')
  return errors
}

/**
 * 公开仓库独立性 / 单父链 / 基线父 / 标签不动 / 与内部对象不相交 / 内容 = 候选清单。
 * publicLayout 由调用方提供(真实场景来自 repositoryLayout + 文件系统;替身测试可注入)。
 */
export function checkPublicHistory({
  publicGit,
  internalGit,
  publicLayout,
  internalLayout,
  baseline,
  baselineErrors,
  candidateDigest,
  candidateEntries,
  policy
}) {
  const sub = []
  const push = (id, status, reasonCode = null, detail = null) =>
    sub.push({ id, status, reasonCode, detail })
  const result = { subchecks: sub, publicCommit: null, chainLength: null, tags: [] }

  // repository-independent
  const indep = []
  if (!publicLayout || !publicLayout.gitDir) indep.push('git-dir-unresolvable')
  else {
    if (!publicLayout.gitDirIsDirectory) indep.push('git-is-not-a-directory(worktree-or-file)')
    if (publicLayout.commonDir !== publicLayout.gitDir) indep.push('common-dir-differs(worktree)')
    if (
      internalLayout &&
      internalLayout.commonDir &&
      publicLayout.commonDir === internalLayout.commonDir
    )
      indep.push('shares-internal-git-dir')
    if (
      internalLayout &&
      internalLayout.toplevel &&
      publicLayout.toplevel &&
      (publicLayout.toplevel === internalLayout.toplevel ||
        publicLayout.toplevel.startsWith(internalLayout.toplevel + path.sep))
    )
      indep.push('inside-internal-root')
  }
  if (indep.length)
    push('repository-independent', 'FAIL', 'PUBLIC_REPO_NOT_INDEPENDENT', { problems: indep })
  else push('repository-independent', 'PASS')

  if (publicLayout && publicLayout.hasAlternates)
    push('no-alternates', 'FAIL', 'ALTERNATES_PRESENT')
  else if (!publicLayout) push('no-alternates', 'UNCHECKED', 'LAYOUT_UNRESOLVABLE')
  else push('no-alternates', 'PASS')

  const branch = currentBranch(publicGit)
  if (branch !== policy.publicGit.branch)
    push('branch-is-main', 'FAIL', 'PUBLIC_BRANCH_NOT_MAIN', { branch })
  else push('branch-is-main', 'PASS')

  const tip = resolveCommit(publicGit, policy.publicGit.branch)
  result.publicCommit = tip
  if (!tip) {
    push('public-commit-present', 'PENDING', 'NO_PUBLIC_COMMIT')
  } else push('public-commit-present', 'PASS', null, { commit: tip })

  if (baselineErrors === null) push('baseline-present', 'PENDING', 'BASELINE_MISSING')
  else if (baselineErrors.length)
    push('baseline-present', 'FAIL', 'BASELINE_INVALID', { errors: baselineErrors })
  else push('baseline-present', 'PASS')
  const baselineOk = baselineErrors && baselineErrors.length === 0

  if (!tip) {
    for (const id of [
      'parent-matches-baseline',
      'linear-single-parent-chain',
      'no-internal-commit-intersection',
      'content-matches-candidate'
    ])
      push(id, 'PENDING', 'NO_PUBLIC_COMMIT')
  } else {
    const chain = commitChain(publicGit, tip)
    result.chainLength = chain.length
    const head = chain[0]
    if (!baselineOk) push('parent-matches-baseline', 'PENDING', 'BASELINE_MISSING')
    else if (baseline.previousPublicCommit === null) {
      if (head.parents.length !== 0)
        push('parent-matches-baseline', 'FAIL', 'FIRST_COMMIT_HAS_PARENT', {
          parents: head.parents
        })
      else push('parent-matches-baseline', 'PASS', null, { root: head.oid })
    } else if (head.parents.length !== 1 || head.parents[0] !== baseline.previousPublicCommit)
      push('parent-matches-baseline', 'FAIL', 'PARENT_NOT_PREVIOUS_PUBLIC', {
        parents: head.parents,
        expected: baseline.previousPublicCommit
      })
    else push('parent-matches-baseline', 'PASS', null, { parent: head.parents[0] })

    const merges = chain.filter((c) => c.parents.length > 1).map((c) => c.oid)
    if (merges.length)
      push('linear-single-parent-chain', 'FAIL', 'MERGE_COMMIT_IN_PUBLIC_CHAIN', {
        commits: merges
      })
    else push('linear-single-parent-chain', 'PASS', null, { length: chain.length })

    const shared = [
      ...existingObjects(
        internalGit,
        chain.map((c) => c.oid)
      )
    ]
    if (shared.length)
      push('no-internal-commit-intersection', 'FAIL', 'INTERNAL_OBJECT_SHARED', { commits: shared })
    else push('no-internal-commit-intersection', 'PASS', null, { checked: chain.length })

    const tree = listTree(publicGit, tip)
    const unsupported = tree.filter((e) => e.type !== 'blob' || !SUPPORTED_MODES.has(e.mode))
    const blobs = readBlobs(
      publicGit,
      tree.filter((e) => e.type === 'blob').map((e) => e.oid)
    )
    const rows = tree
      .filter((e) => e.type === 'blob')
      .map((e) => {
        const buf = blobs.map.get(e.oid)
        return {
          path: e.path,
          mode: e.mode,
          sha256: buf ? sha256Hex(buf) : null,
          bytes: buf ? buf.length : null
        }
      })
      .sort((a, b) => compareUtf8(a.path, b.path))
    const digest = manifestDigest(rows)
    if (unsupported.length)
      push('content-matches-candidate', 'FAIL', 'PUBLIC_TREE_UNSUPPORTED_ENTRY', {
        entries: unsupported.slice(0, 20)
      })
    else if (!candidateDigest)
      push('content-matches-candidate', 'UNCHECKED', 'CANDIDATE_DIGEST_MISSING')
    else if (digest !== candidateDigest) {
      const cmp = compareCandidate(candidateEntries ?? [], { entries: rows, anomalies: [] })
      push('content-matches-candidate', 'FAIL', 'CONTENT_MISMATCH', {
        publicDigest: digest,
        candidateDigest,
        ...cmp
      })
    } else push('content-matches-candidate', 'PASS', null, { digest })
  }

  const tags = listTags(publicGit)
  result.tags = tags
  if (!baselineOk) push('tags-unmoved', 'PENDING', 'BASELINE_MISSING', { tags: tags.length })
  else {
    const byName = new Map(tags.map((t) => [t.name, t]))
    const moved = []
    const missingTags = []
    for (const b of baseline.tags) {
      const t = byName.get(b.name)
      if (!t) missingTags.push(b.name)
      else if (t.objectId !== b.objectId || t.targetId !== b.targetId)
        moved.push({ name: b.name, baseline: b, actual: t })
    }
    const added = tags
      .filter((t) => !baseline.tags.some((b) => b.name === t.name))
      .map((t) => t.name)
    if (moved.length || missingTags.length)
      push('tags-unmoved', 'FAIL', 'TAG_MOVED_OR_MISSING', { moved, missing: missingTags, added })
    else push('tags-unmoved', 'PASS', null, { baselineTags: baseline.tags.length, added })
  }
  return result
}

/** 真实公开仓库的布局探测(只读):返回 checkPublicHistory 需要的 publicLayout。 */
export function probePublicLayout(publicRepoPath, publicGit) {
  const real = realOrNull(publicRepoPath)
  if (!real) return null
  const dotGit = path.join(real, '.git')
  const st = lstatOrNull(dotGit)
  const layout = repositoryLayout(publicGit)
  return {
    toplevel: layout.toplevel,
    gitDir: layout.gitDir,
    commonDir: layout.commonDir,
    gitDirIsDirectory: Boolean(st && st.isDirectory() && !st.isSymbolicLink()),
    hasAlternates: Boolean(
      layout.commonDir && lstatOrNull(path.join(layout.commonDir, 'objects', 'info', 'alternates'))
    )
  }
}
