// scripts/release.mjs
// 发布 CLI 唯一入口:`prepare --release-id <id>` 构独立候选;`check --release-id <id> --stage pre-push|pre-release [--public-repo <dir>]` 复验。
// 能力止于只读 Git 查询 + 受控根内写入 + 检查;不打包、不初始化 / 切分支、不提交 / 推送、不改基准。
// 规则唯一真源:scripts/release-policy.json(从冻结 commit 的 blob 读取,再与工作区文件核对)。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ReleaseBoundaryError,
  ReleaseExecutionError,
  blobOidAt,
  checkPublicHistory,
  checkSync,
  compareCandidate,
  createGitAdapter,
  currentBranch,
  deriveExpectedManifest,
  gitVersion,
  isSafeReleaseId,
  listForeignStaging,
  listTree,
  parsePolicyBuffer,
  parseRegistryBuffer,
  probePublicLayout,
  readBlobs,
  repositoryLayout,
  resolveCommit,
  resolveReleaseRoot,
  validateBaseline,
  walkCandidate,
  worktreeBlobOid,
  worktreeStatus,
  writeCandidate
} from './release/source.mjs'
import { runCandidateChecks } from './release/checks.mjs'
import {
  EXIT,
  STATUS,
  buildErrorReport,
  buildStageReport,
  redactValue,
  runId as makeRunId,
  stableJson,
  writeReport
} from './release/report.mjs'

export const POLICY_PATH = 'scripts/release-policy.json'
const STAGES = ['pre-push', 'pre-release']
const USAGE = [
  'usage:',
  '  node scripts/release.mjs prepare --release-id <id>',
  '  node scripts/release.mjs check --release-id <id> --stage pre-push|pre-release [--public-repo <dir>]',
  'exit: 0 admitted for the selected operation/stage · 1 rule violation · 2 missing input/argument error · 3 execution error'
].join('\n')

// ── 参数解析(严格:未知参数 / 非法 stage / 缺 release-id → 2)──────────────
export function parseArgs(argv) {
  const [op, ...rest] = argv
  if (op !== 'prepare' && op !== 'check') return { error: `unknown operation: ${op ?? '(none)'}` }
  const out = { op, releaseId: null, stage: null, publicRepo: null }
  const allowed =
    op === 'prepare'
      ? new Set(['--release-id'])
      : new Set(['--release-id', '--stage', '--public-repo'])
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    let key = a
    let val = null
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) {
      key = a.slice(0, eq)
      val = a.slice(eq + 1)
    } else {
      val = rest[i + 1]
      i++
    }
    if (!allowed.has(key)) return { error: `unknown argument: ${key}` }
    if (val === undefined || val === null || val === '' || val.startsWith('--'))
      return { error: `missing value for ${key}` }
    const prop = key === '--release-id' ? 'releaseId' : key === '--stage' ? 'stage' : 'publicRepo'
    if (out[prop] !== null) return { error: `duplicate argument: ${key}` }
    out[prop] = val
  }
  if (!out.releaseId) return { error: 'missing --release-id' }
  if (!isSafeReleaseId(out.releaseId))
    return {
      error:
        'release-id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ and contain no path separators'
    }
  if (op === 'check') {
    if (!out.stage) return { error: 'missing --stage' }
    if (!STAGES.includes(out.stage)) return { error: `invalid stage: ${out.stage}` }
  }
  return out
}

// ── 来源冻结 ────────────────────────────────────────────────────────────────
function readInternalRoot(git, cwdReal) {
  const layout = repositoryLayout(git)
  if (!layout.insideWorkTree || !layout.toplevel)
    throw new ReleaseExecutionError('NOT_A_REPOSITORY', 'cwd 不是 Git 工作区')
  if (layout.toplevel !== cwdReal)
    throw new ReleaseExecutionError('NOT_REPOSITORY_ROOT', 'cwd 必须是内部仓库根', {
      cwdRole: '<cwd>'
    })
  return layout
}

function freezeSource({ git, cwdReal, policyPathInTree }) {
  const sub = []
  const push = (id, status, reasonCode = null, detail = null) =>
    sub.push({ id, status, reasonCode, detail })
  const branch = currentBranch(git)
  if (branch !== 'refs/heads/main') push('on-main', STATUS.FAIL, 'NOT_ON_MAIN', { branch })
  else push('on-main', STATUS.PASS)
  const status = worktreeStatus(git)
  if (!status.clean)
    push('clean-worktree', STATUS.FAIL, 'WORKTREE_DIRTY', {
      changed: status.changed.slice(0, 50),
      untracked: status.untracked.slice(0, 50),
      unmerged: status.unmerged.slice(0, 50)
    })
  else push('clean-worktree', STATUS.PASS)
  const commit = resolveCommit(git, 'refs/heads/main')
  const head = resolveCommit(git, 'HEAD')
  if (!commit)
    throw new ReleaseExecutionError('MAIN_UNRESOLVABLE', 'refs/heads/main 无法解析为 commit')
  const treeRes = git.run(['rev-parse', '--verify', '-q', `${commit}^{tree}`])
  if (treeRes.status !== 0)
    throw new ReleaseExecutionError('TREE_UNRESOLVABLE', 'main 的 tree 无法解析')
  const tree = String(treeRes.stdout).trim()
  if (head !== commit) push('frozen-commit', STATUS.FAIL, 'HEAD_NOT_MAIN', { head, main: commit })
  else push('frozen-commit', STATUS.PASS, null, { commit, tree })

  // policy:从冻结 commit 的 blob 读;工作区文件必须与之同字节
  const policyBlob = blobOidAt(git, commit, policyPathInTree)
  let policy = null
  let policySha256 = null
  if (!policyBlob)
    push('policy-frozen', STATUS.FAIL, 'POLICY_NOT_COMMITTED', { path: policyPathInTree })
  else {
    const { map } = readBlobs(git, [policyBlob])
    const parsed = parsePolicyBuffer(map.get(policyBlob))
    policySha256 = parsed.sha256
    if (parsed.errors.length)
      push('policy-frozen', STATUS.FAIL, 'POLICY_INVALID', { errors: parsed.errors })
    else {
      policy = parsed.policy
      // 工作区文件经 Git clean 过滤器(eol / attributes)后的 blob id 必须等于冻结 blob —— 不比原始字节,免受 CRLF checkout 影响
      if (worktreeBlobOid(git, cwdReal, policyPathInTree) !== policyBlob)
        push('policy-frozen', STATUS.FAIL, 'POLICY_WORKTREE_DIFFERS')
      else push('policy-frozen', STATUS.PASS, null, { blob: policyBlob, sha256: policySha256 })
    }
  }
  let registry = null
  let registrySha256 = null
  let registryErrors = []
  let registryBlob = null
  if (policy) {
    const regPath = policy.publicDocuments.registry
    registryBlob = blobOidAt(git, commit, regPath)
    if (!registryBlob) {
      registryErrors = ['REGISTRY_NOT_COMMITTED']
      push('registry-frozen', STATUS.FAIL, 'REGISTRY_NOT_COMMITTED', { path: regPath })
    } else {
      const { map } = readBlobs(git, [registryBlob])
      const parsed = parseRegistryBuffer(map.get(registryBlob), policy)
      registry = parsed.registry
      registrySha256 = parsed.sha256
      registryErrors = parsed.errors
      if (worktreeBlobOid(git, cwdReal, regPath) !== registryBlob)
        push('registry-frozen', STATUS.FAIL, 'REGISTRY_WORKTREE_DIFFERS')
      else
        push('registry-frozen', STATUS.PASS, null, { blob: registryBlob, sha256: registrySha256 })
    }
  } else push('registry-frozen', STATUS.UNCHECKED, 'POLICY_UNAVAILABLE')
  return {
    subchecks: sub,
    branch,
    commit,
    tree,
    head,
    status,
    policy,
    policySha256,
    policyBlob,
    registry,
    registrySha256,
    registryErrors,
    registryBlob
  }
}

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
}

function readJsonOrNull(p) {
  const buf = readFileOrNull(p)
  if (!buf) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return { __parseError: true }
  }
}

/** 期望清单派生 + 子项状态。 */
function deriveExpected({ git, frozen }) {
  const treeEntries = listTree(git, frozen.commit)
  const derived = deriveExpectedManifest({
    treeEntries,
    policy: frozen.policy,
    registry: frozen.registryErrors.length ? null : frozen.registry,
    readBlob: (oids) => readBlobs(git, oids)
  })
  const bySub = new Map()
  for (const f of derived.findings) {
    if (!bySub.has(f.subcheck)) bySub.set(f.subcheck, [])
    bySub.get(f.subcheck).push({ reasonCode: f.reasonCode, ...f.detail })
  }
  const sub = []
  for (const id of [
    'tree-entries-supported',
    'path-safety',
    'forbidden-tracked-input',
    'required-targets'
  ]) {
    const items = bySub.get(id)
    if (items && items.length)
      sub.push({
        id,
        status: STATUS.FAIL,
        reasonCode: items[0].reasonCode,
        detail: { items: items.slice(0, 50) }
      })
    else sub.push({ id, status: STATUS.PASS, reasonCode: null, detail: null })
  }
  const overlayProblems = (bySub.get('candidate-matches-expected') ?? []).filter(
    (x) => x.reasonCode !== 'BLOB_MISSING'
  )
  if (frozen.registryErrors.length)
    sub.push({
      id: 'overlay-derivation',
      status: STATUS.FAIL,
      reasonCode: 'REGISTRY_INVALID',
      detail: null
    })
  else if (overlayProblems.length)
    sub.push({
      id: 'overlay-derivation',
      status: STATUS.FAIL,
      reasonCode: overlayProblems[0].reasonCode,
      detail: { items: overlayProblems }
    })
  return { treeEntries, derived, subchecks: sub }
}

function sourceRecord({ frozen, derived, releaseId, runId, now, tool, packageVersion }) {
  return {
    schemaVersion: 1,
    kind: 'release-source',
    releaseId,
    preparedRunId: runId,
    preparedAt: now,
    tool,
    internalRoot: '<internal-root>',
    branch: frozen.branch,
    commit: frozen.commit,
    tree: frozen.tree,
    policy: { path: POLICY_PATH, blob: frozen.policyBlob, sha256: frozen.policySha256 },
    registry: {
      path: frozen.policy.publicDocuments.registry,
      blob: frozen.registryBlob,
      sha256: frozen.registrySha256
    },
    packageVersion,
    publicDocuments: derived.overlays,
    candidate: {
      digest: derived.digest,
      digestKind: derived.digestKind,
      entries: derived.entries.length,
      bytes: derived.stats.totalBytes,
      strippedByRule: derived.stats.strippedByRule,
      strippedTotal: derived.stats.strippedTotal,
      treeEntries: derived.stats.treeEntries
    }
  }
}

function manifestRecord({ frozen, derived, releaseId }) {
  return {
    schemaVersion: 1,
    kind: 'release-candidate-manifest',
    releaseId,
    commit: frozen.commit,
    tree: frozen.tree,
    digest: derived.digest,
    digestKind: derived.digestKind,
    entries: derived.entries.map((e) => ({
      path: e.path,
      mode: e.mode,
      blob: e.blob,
      sha256: e.sha256,
      bytes: e.bytes,
      origin: e.origin
    }))
  }
}

function packageVersionAt(git, commit) {
  const oid = blobOidAt(git, commit, 'package.json')
  if (!oid) return null
  try {
    return JSON.parse(readBlobs(git, [oid]).map.get(oid).toString('utf8')).version ?? null
  } catch {
    return null
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
/**
 * @param {string[]} argv
 * @param {{ cwd?: string, spawnImpl?: Function, recorder?: object[]|null, stdout?: (s:string)=>void, stderr?: (s:string)=>void, now?: () => Date }} deps
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s + '\n'))
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s + '\n'))
  const args = parseArgs(argv)
  if (args.error) {
    stderr(`release: ${args.error}\n${USAGE}`)
    return EXIT.INCOMPLETE
  }
  const cwd = deps.cwd ?? process.cwd()
  const nowDate = (deps.now ?? (() => new Date()))()
  const runId = makeRunId(nowDate)
  const generatedAt = nowDate.toISOString()
  let cwdReal
  try {
    cwdReal = fs.realpathSync.native(cwd)
  } catch {
    stderr('release: cwd 不存在')
    return EXIT.EXECUTION
  }
  const git = createGitAdapter({
    cwd: cwdReal,
    role: '<internal-root>',
    recorder: deps.recorder ?? null,
    spawnImpl: deps.spawnImpl
  })
  const roles = {
    [cwdReal]: '<internal-root>',
    [cwdReal.split(path.sep).join('/')]: '<internal-root>'
  }
  const tool = { node: process.version, git: null, release: 'scripts/release.mjs' }
  let roots = null
  let frozen = null
  let stagePolicy = null
  const stage = args.op === 'prepare' ? 'prepare' : args.stage
  const context = {
    releaseId: args.releaseId,
    runId,
    generatedAt,
    tool,
    source: null,
    candidateDigest: null,
    policySha256: null,
    registrySha256: null
  }

  const finish = (policy, results, extraContext = {}) => {
    const report = buildStageReport({
      policy,
      stage,
      results,
      context: { ...context, ...extraContext }
    })
    let written = null
    try {
      written = writeReport({ reportsDir: roots.reportsDir, report, roles })
    } catch (e) {
      stderr(`release: ${e.message}`)
      return EXIT.EXECUTION
    }
    stdout(`report: ${path.relative(cwdReal, written.jsonPath).split(path.sep).join('/')}`)
    stdout(`exit: ${report.exitCode}${report.admission ? ` ${report.admission}` : ''}`)
    return report.exitCode
  }
  const finishError = (policy, error) => {
    const report = buildErrorReport({ policy, stage, context, error })
    try {
      const written = writeReport({ reportsDir: roots.reportsDir, report, roles })
      stdout(`report: ${path.relative(cwdReal, written.jsonPath).split(path.sep).join('/')}`)
    } catch (e) {
      stderr(`release: ${e.message}`)
    }
    stderr(`release: ERROR ${error.code ?? ''} ${redactValue(error.message, roles)}`)
    return EXIT.EXECUTION
  }

  try {
    tool.git = gitVersion(git)
    readInternalRoot(git, cwdReal)
    // 受控根需要 policy.controlledRoot 与报告目录:优先用工作区 policy;工作区版本不合法时退回 main 上已提交的版本
    // (随后 freezeSource 会把两者的差异记为 FAIL)。两者都不可用 → 无目录可报告,执行错误 3。
    const wtPolicy = readFileOrNull(path.join(cwdReal, ...POLICY_PATH.split('/')))
    if (!wtPolicy) throw new ReleaseExecutionError('POLICY_MISSING', `${POLICY_PATH} 不存在`)
    const wtParsed = parsePolicyBuffer(wtPolicy)
    if (wtParsed.errors.length === 0) stagePolicy = wtParsed.policy
    else {
      const mainCommit = resolveCommit(git, 'refs/heads/main')
      const committedBlob = mainCommit ? blobOidAt(git, mainCommit, POLICY_PATH) : null
      if (committedBlob) {
        const committed = parsePolicyBuffer(readBlobs(git, [committedBlob]).map.get(committedBlob))
        if (committed.errors.length === 0) stagePolicy = committed.policy
      }
      if (!stagePolicy)
        throw new ReleaseExecutionError(
          'POLICY_INVALID',
          `${POLICY_PATH} 不合法且 main 上无可用版本:${wtParsed.errors.slice(0, 5).join(',')}`
        )
    }
    roots = resolveReleaseRoot({
      internalRoot: cwdReal,
      controlledRoot: stagePolicy.controlledRoot,
      releaseId: args.releaseId
    })
    context.policySha256 = wtParsed.sha256

    frozen = freezeSource({ git, cwdReal, policyPathInTree: POLICY_PATH })
    const policy = frozen.policy ?? stagePolicy
    context.source = { commit: frozen.commit, tree: frozen.tree }
    context.policySha256 = frozen.policySha256 ?? context.policySha256
    context.registrySha256 = frozen.registrySha256

    const results = new Map()
    const sourceSub = [...frozen.subchecks]
    results.set('source', {
      subchecks: sourceSub,
      command: 'git(read-only)',
      exitCode: 0,
      evidence: []
    })
    const frozenOk = frozen.subchecks.every((s) => s.status === STATUS.PASS)

    if (!frozen.policy) {
      // 规则不可用:同步与期望清单都无法计算
      results.set('sync', {
        subchecks: [
          { id: 'registry-shape', status: STATUS.UNCHECKED, reasonCode: 'POLICY_UNAVAILABLE' }
        ]
      })
      return finish(policy, results)
    }

    const sync = checkSync({
      git,
      root: cwdReal,
      commit: frozen.commit,
      registry: frozen.registry,
      registryErrors: frozen.registryErrors
    })
    results.set('sync', {
      subchecks: sync.subchecks,
      command: 'git(read-only)',
      exitCode: 0,
      evidence: ['source.json'],
      location: policy.publicDocuments.registry,
      documents: sync.documents
    })
    const syncOk = sync.subchecks.every((s) => s.status === STATUS.PASS)

    const expected = deriveExpected({ git, frozen })
    sourceSub.push(...expected.subchecks)
    const derived = expected.derived
    context.candidateDigest = derived.digest

    if (args.op === 'prepare')
      return await runPrepare({
        git,
        roots,
        frozen,
        derived,
        policy,
        results,
        sourceSub,
        frozenOk,
        syncOk,
        runId,
        generatedAt,
        tool,
        args,
        finish,
        stdout
      })
    return await runCheck({
      git,
      cwdReal,
      roots,
      frozen,
      derived,
      policy,
      results,
      sourceSub,
      args,
      finish,
      deps,
      runId,
      generatedAt
    })
  } catch (err) {
    if (err instanceof ReleaseBoundaryError) {
      stderr(`release: REJECTED ${err.code} ${redactValue(err.message, roles)}`)
      if (roots && stagePolicy) {
        const results = new Map()
        results.set('source', {
          subchecks: [
            {
              id: 'path-safety',
              status: STATUS.FAIL,
              reasonCode: err.code,
              detail: redactValue(err.detail, roles)
            }
          ]
        })
        return finish(stagePolicy, results)
      }
      return err.code === 'RELEASE_ID_UNSAFE' ? EXIT.INCOMPLETE : EXIT.VIOLATION
    }
    const error =
      err instanceof ReleaseExecutionError
        ? err
        : Object.assign(new Error(err && err.message ? err.message : String(err)), {
            code: err && err.code ? err.code : 'UNEXPECTED',
            detail: null
          })
    if (roots && stagePolicy) return finishError(stagePolicy, error)
    stderr(`release: ERROR ${error.code ?? ''} ${redactValue(error.message, roles)}`)
    return EXIT.EXECUTION
  }
}

async function runPrepare({
  git,
  roots,
  frozen,
  derived,
  policy,
  results,
  sourceSub,
  frozenOk,
  syncOk,
  runId,
  generatedAt,
  tool,
  args,
  finish,
  stdout
}) {
  const existingSource = readJsonOrNull(roots.sourceJson)
  const existingManifest = readJsonOrNull(roots.manifestJson)
  const candidateExists = fs.existsSync(roots.candidateDir)
  const foreign = listForeignStaging(roots.releaseReal, runId)
  if (foreign.length) {
    // 不属于本轮的暂存目录:只报告、不删除、不继续构树(它可能是另一进程正在写的半成品)
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'FOREIGN_STAGING_PRESENT',
      detail: { staging: foreign }
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results)
  }

  if (existingSource || existingManifest || candidateExists) {
    // 同 ID 重跑:只在来源 / 规则 / 登记 / 候选内容一致时复验并追加报告
    if (
      !existingSource ||
      existingSource.__parseError ||
      !existingManifest ||
      existingManifest.__parseError ||
      !candidateExists
    ) {
      sourceSub.push({
        id: 'candidate-matches-expected',
        status: STATUS.FAIL,
        reasonCode: 'RELEASE_ID_CONFLICT',
        detail: {
          reason: 'partial or unreadable previous run',
          hasSource: Boolean(existingSource),
          hasManifest: Boolean(existingManifest),
          hasCandidate: candidateExists
        }
      })
      sourceSub.push({
        id: 'source-reverified',
        status: STATUS.UNCHECKED,
        reasonCode: 'NOT_REACHED'
      })
      return finish(policy, results)
    }
    if (existingSource.commit !== frozen.commit) {
      sourceSub.push({
        id: 'candidate-matches-expected',
        status: STATUS.FAIL,
        reasonCode: 'SOURCE_MOVED',
        detail: { recorded: existingSource.commit, current: frozen.commit }
      })
      sourceSub.push({
        id: 'source-reverified',
        status: STATUS.UNCHECKED,
        reasonCode: 'NOT_REACHED'
      })
      return finish(policy, results)
    }
    const same =
      existingSource.policy?.sha256 === frozen.policySha256 &&
      existingSource.registry?.sha256 === frozen.registrySha256 &&
      existingSource.candidate?.digest === derived.digest &&
      existingManifest.digest === derived.digest
    if (!same) {
      sourceSub.push({
        id: 'candidate-matches-expected',
        status: STATUS.FAIL,
        reasonCode: 'RELEASE_ID_CONFLICT',
        detail: {
          recordedDigest: existingSource.candidate?.digest ?? null,
          expectedDigest: derived.digest
        }
      })
      sourceSub.push({
        id: 'source-reverified',
        status: STATUS.UNCHECKED,
        reasonCode: 'NOT_REACHED'
      })
      return finish(policy, results)
    }
    const actual = walkCandidate(roots.candidateDir)
    const cmp = compareCandidate(derived.entries, actual)
    if (!cmp.ok)
      sourceSub.push({
        id: 'candidate-matches-expected',
        status: STATUS.FAIL,
        reasonCode: 'RELEASE_ID_CONFLICT',
        detail: { reason: 'existing candidate differs from expected manifest', ...cmp }
      })
    else
      sourceSub.push({
        id: 'candidate-matches-expected',
        status: STATUS.PASS,
        reasonCode: 'REVERIFIED_EXISTING',
        detail: { entries: actual.entries.length, digest: derived.digest }
      })
    const re = reverify(git, frozen)
    sourceSub.push(re)
    const reCode = finish(policy, results, { candidateDigest: derived.digest })
    if (reCode === EXIT.ADMITTED) stdout('candidate-prepared')
    return reCode
  }

  if (!frozenOk || !syncOk || !derived.digest || sourceSub.some((s) => s.status === STATUS.FAIL)) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.UNCHECKED,
      reasonCode: 'NOT_BUILT_PRECONDITION_FAILED'
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results)
  }

  // 写入前复验来源
  const pre = reverify(git, frozen)
  if (pre.status !== STATUS.PASS) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.UNCHECKED,
      reasonCode: 'NOT_BUILT_SOURCE_CHANGED'
    })
    sourceSub.push(pre)
    return finish(policy, results)
  }
  const written = writeCandidate({
    roots,
    runId,
    releaseId: args.releaseId,
    expectedEntries: derived.entries,
    blobs: derived.blobs
  })
  const actual = walkCandidate(roots.candidateDir)
  const cmp = compareCandidate(derived.entries, actual)
  if (!cmp.ok) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'CANDIDATE_VERIFY_FAILED',
      detail: cmp
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results)
  }
  const post = reverify(git, frozen)
  if (post.status !== STATUS.PASS) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'SOURCE_CHANGED',
      detail: post.detail
    })
    sourceSub.push(post)
    return finish(policy, results)
  }
  const packageVersion = packageVersionAt(git, frozen.commit)
  const src = sourceRecord({
    frozen,
    derived,
    releaseId: args.releaseId,
    runId,
    now: generatedAt,
    tool,
    packageVersion
  })
  const man = manifestRecord({ frozen, derived, releaseId: args.releaseId })
  fs.writeFileSync(roots.sourceJson, stableJson(src), { flag: 'wx' })
  fs.writeFileSync(roots.manifestJson, stableJson(man), { flag: 'wx' })
  fs.mkdirSync(roots.evidenceDir, { recursive: true })
  sourceSub.push({
    id: 'candidate-matches-expected',
    status: STATUS.PASS,
    reasonCode: null,
    detail: {
      entries: written.written,
      digest: derived.digest,
      bytes: derived.stats.totalBytes,
      strippedTotal: derived.stats.strippedTotal
    }
  })
  sourceSub.push(post)
  const code = finish(policy, results, { candidateDigest: derived.digest })
  if (code === EXIT.ADMITTED) stdout('candidate-prepared')
  return code
}

/** 来源复验:commit / 工作区 / 规则 / 登记四项与冻结时一致。 */
function reverify(git, frozen) {
  const commit = resolveCommit(git, 'refs/heads/main')
  const head = resolveCommit(git, 'HEAD')
  const status = worktreeStatus(git)
  const policyBlob = blobOidAt(git, commit ?? 'HEAD', POLICY_PATH)
  const registryBlob = frozen.policy
    ? blobOidAt(git, commit ?? 'HEAD', frozen.policy.publicDocuments.registry)
    : null
  const problems = []
  if (commit !== frozen.commit) problems.push({ what: 'main', frozen: frozen.commit, now: commit })
  if (head !== frozen.commit) problems.push({ what: 'HEAD', frozen: frozen.commit, now: head })
  if (!status.clean)
    problems.push({
      what: 'worktree',
      changed: status.changed.slice(0, 20),
      untracked: status.untracked.slice(0, 20)
    })
  if (policyBlob !== frozen.policyBlob)
    problems.push({ what: 'policy-blob', frozen: frozen.policyBlob, now: policyBlob })
  if (registryBlob !== frozen.registryBlob)
    problems.push({ what: 'registry-blob', frozen: frozen.registryBlob, now: registryBlob })
  if (problems.length)
    return {
      id: 'source-reverified',
      status: STATUS.FAIL,
      reasonCode: 'SOURCE_CHANGED',
      detail: { problems }
    }
  return { id: 'source-reverified', status: STATUS.PASS, reasonCode: null, detail: null }
}

async function runCheck({
  git,
  cwdReal,
  roots,
  frozen,
  derived,
  policy,
  results,
  sourceSub,
  args,
  finish,
  deps,
  runId,
  generatedAt
}) {
  const existingSource = readJsonOrNull(roots.sourceJson)
  const existingManifest = readJsonOrNull(roots.manifestJson)
  const candidateExists = fs.existsSync(roots.candidateDir)
  if (
    !existingSource ||
    existingSource.__parseError ||
    !existingManifest ||
    existingManifest.__parseError ||
    !candidateExists
  ) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.UNCHECKED,
      reasonCode: 'CANDIDATE_NOT_PREPARED',
      detail: {
        hasSource: Boolean(existingSource),
        hasManifest: Boolean(existingManifest),
        hasCandidate: candidateExists
      }
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results)
  }
  // 冻结来源以 source.json 记录为准;当前 main 若已移动 → SOURCE_MOVED(不是文档漂移)
  const recordedCommit = existingSource.commit
  if (recordedCommit !== frozen.commit) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'SOURCE_MOVED',
      detail: { recorded: recordedCommit, current: frozen.commit }
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results, { candidateDigest: existingSource.candidate?.digest ?? null })
  }
  if (
    existingSource.policy?.sha256 !== frozen.policySha256 ||
    existingSource.registry?.sha256 !== frozen.registrySha256
  ) {
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'FROZEN_INPUT_MISMATCH',
      detail: {
        recordedPolicy: existingSource.policy?.sha256 ?? null,
        currentPolicy: frozen.policySha256,
        recordedRegistry: existingSource.registry?.sha256 ?? null,
        currentRegistry: frozen.registrySha256
      }
    })
    sourceSub.push({ id: 'source-reverified', status: STATUS.UNCHECKED, reasonCode: 'NOT_REACHED' })
    return finish(policy, results)
  }
  // 期望清单由冻结 blobs 重新派生,与记录摘要及实际候选分别比对(不信任可被一同改写的 manifest)
  const actual = walkCandidate(roots.candidateDir)
  const cmp = compareCandidate(derived.entries, actual)
  const digestMatchesRecorded =
    derived.digest !== null &&
    derived.digest === existingSource.candidate?.digest &&
    derived.digest === existingManifest.digest
  if (!digestMatchesRecorded)
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'RECORDED_DIGEST_MISMATCH',
      detail: {
        expected: derived.digest,
        recordedSource: existingSource.candidate?.digest ?? null,
        recordedManifest: existingManifest.digest ?? null,
        ...cmp
      }
    })
  else if (!cmp.ok)
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.FAIL,
      reasonCode: 'CANDIDATE_TAMPERED',
      detail: cmp
    })
  else
    sourceSub.push({
      id: 'candidate-matches-expected',
      status: STATUS.PASS,
      reasonCode: null,
      detail: { entries: actual.entries.length, digest: derived.digest }
    })
  sourceSub.push(reverify(git, frozen))

  // public-history(6a 接口):无 --public-repo → PENDING;有 → 只读检查 + 证据落盘
  const ph = publicHistoryResult({
    git,
    cwdReal,
    roots,
    policy,
    derived,
    args,
    deps,
    runId,
    generatedAt
  })
  results.set('public-history', ph.result)

  // owner = 6b 的 11 项:遍历真实候选、读取 evidence/ 记录、只读查公开仓库;扫描器源码取自冻结 blob
  const scannerEntry = derived.entries.find((e) => e.path === 'scripts/scan-secrets.mjs')
  const scannerBuf = scannerEntry ? derived.blobs.get(scannerEntry.blob) : null
  runCandidateChecks({
    policy,
    roots,
    internalRoot: cwdReal,
    frozen,
    candidateDigest: derived.digest,
    publicRepo: ph.publicRepo,
    runId,
    generatedAt,
    roles: {
      [cwdReal]: '<internal-root>',
      ...(ph.publicReal ? { [ph.publicReal]: '<public-root>' } : {})
    },
    scannerSource: scannerBuf ? scannerBuf.toString('utf8') : null,
    results
  })

  return finish(policy, results, { candidateDigest: derived.digest })
}

function publicHistoryResult({
  git,
  cwdReal,
  roots,
  policy,
  derived,
  args,
  deps,
  runId,
  generatedAt
}) {
  const def = policy.checks.find((c) => c.id === 'public-history')
  const pendingAll = (reasonCode, detail = null) => ({
    result: {
      subchecks: def.subchecks.map((id) => ({ id, status: STATUS.PENDING, reasonCode, detail })),
      command: null,
      exitCode: null,
      evidence: []
    },
    publicRepo: null,
    publicReal: null
  })
  if (!args.publicRepo) return pendingAll('PUBLIC_REPO_NOT_PROVIDED')
  let publicReal
  try {
    publicReal = fs.realpathSync.native(args.publicRepo)
  } catch {
    return pendingAll('PUBLIC_REPO_NOT_FOUND')
  }
  if (
    publicReal === cwdReal ||
    publicReal.startsWith(cwdReal + path.sep) ||
    cwdReal.startsWith(publicReal + path.sep)
  )
    return {
      result: {
        subchecks: def.subchecks.map((id) => ({
          id,
          status: id === 'repository-independent' ? STATUS.FAIL : STATUS.UNCHECKED,
          reasonCode: 'PUBLIC_REPO_OVERLAPS_INTERNAL_ROOT'
        })),
        command: null,
        exitCode: null,
        evidence: []
      },
      publicRepo: null,
      publicReal: null
    }
  const publicGit = createGitAdapter({
    cwd: publicReal,
    role: '<public-root>',
    recorder: deps.recorder ?? null,
    spawnImpl: deps.spawnImpl
  })
  let publicLayout
  try {
    publicLayout = probePublicLayout(publicReal, publicGit)
  } catch (e) {
    if (e instanceof ReleaseExecutionError)
      return pendingAll('PUBLIC_REPO_NOT_A_REPOSITORY', { code: e.code })
    throw e
  }
  const internalLayout = repositoryLayout(git)
  const baselinePath = path.join(roots.evidenceDir, 'public-baseline.json')
  const baseline = readJsonOrNull(baselinePath)
  const baselineErrors =
    baseline === null
      ? null
      : baseline.__parseError
        ? ['baseline-unparseable']
        : validateBaseline(baseline)
  const res = checkPublicHistory({
    publicGit,
    internalGit: git,
    publicLayout,
    internalLayout,
    baseline: baselineErrors && baselineErrors.length === 0 ? baseline : null,
    baselineErrors,
    candidateDigest: derived.digest,
    candidateEntries: derived.entries,
    policy
  })
  fs.mkdirSync(roots.evidenceDir, { recursive: true })
  const evidenceName = `public-git.${runId}.json`
  const evidence = {
    schemaVersion: 1,
    kind: 'public-git',
    runId,
    generatedAt,
    publicRoot: '<public-root>',
    publicCommit: res.publicCommit,
    chainLength: res.chainLength,
    tags: res.tags,
    baselineFile: 'evidence/public-baseline.json',
    baselineErrors,
    subchecks: res.subchecks
  }
  fs.writeFileSync(
    path.join(roots.evidenceDir, evidenceName),
    stableJson(
      redactValue(evidence, { [publicReal]: '<public-root>', [cwdReal]: '<internal-root>' })
    ),
    { flag: 'wx' }
  )
  return {
    result: {
      subchecks: res.subchecks,
      command: 'git(read-only, public)',
      exitCode: 0,
      evidence: [`evidence/${evidenceName}`, 'evidence/public-baseline.json'],
      location: '<public-root>'
    },
    publicRepo: {
      git: publicGit,
      tip: res.publicCommit,
      baseline: baselineErrors && baselineErrors.length === 0 ? baseline : null
    },
    publicReal
  }
}

// ── 进程入口 ────────────────────────────────────────────────────────────────
const isDirectRun = (() => {
  try {
    return (
      process.argv[1] &&
      import.meta.url === pathToFileURL(fs.realpathSync.native(process.argv[1])).href
    )
  } catch {
    return false
  }
})()
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`release: fatal ${err && err.message ? err.message : String(err)}\n`)
      process.exit(EXIT.EXECUTION)
    }
  )
}
