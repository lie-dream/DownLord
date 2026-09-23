// scripts/release/report.mjs
// 报告结构、状态聚合与退出码语义(设计 §3.4)。只做纯计算与受控落盘,不含任何检查逻辑。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR',
  UNCHECKED: 'UNCHECKED',
  PENDING: 'PENDING',
  DEFERRED_PUSH_LINK: 'DEFERRED_PUSH_LINK',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
})
export const STATUS_LIST = Object.freeze(Object.values(STATUS))

export const EXIT = Object.freeze({ ADMITTED: 0, VIOLATION: 1, INCOMPLETE: 2, EXECUTION: 3 })

/** 单个状态 → 退出码贡献。DEFERRED_PUSH_LINK 只在 pre-push 视为可准入,其余阶段按未齐(2)。 */
export function exitForStatus(status, stage) {
  switch (status) {
    case STATUS.PASS:
    case STATUS.NOT_APPLICABLE:
      return EXIT.ADMITTED
    case STATUS.DEFERRED_PUSH_LINK:
      return stage === 'pre-push' ? EXIT.ADMITTED : EXIT.INCOMPLETE
    case STATUS.FAIL:
      return EXIT.VIOLATION
    case STATUS.ERROR:
      return EXIT.EXECUTION
    case STATUS.UNCHECKED:
    case STATUS.PENDING:
      return EXIT.INCOMPLETE
    default:
      return EXIT.EXECUTION
  }
}

/** 多问题聚合:3 → 1 → 2 → 0。全部条目保留,聚合只决定退出码。 */
export function aggregateExit(codes) {
  if (codes.includes(EXIT.EXECUTION)) return EXIT.EXECUTION
  if (codes.includes(EXIT.VIOLATION)) return EXIT.VIOLATION
  if (codes.includes(EXIT.INCOMPLETE)) return EXIT.INCOMPLETE
  return EXIT.ADMITTED
}

const SEVERITY = Object.freeze({
  ERROR: 6,
  FAIL: 5,
  UNCHECKED: 4,
  PENDING: 3,
  DEFERRED_PUSH_LINK: 2,
  NOT_APPLICABLE: 1,
  PASS: 0
})
/** 状态严重度(未知状态按最严重处理,后续会被判 INVALID_STATUS → ERROR)。 */
export function severity(status) {
  return SEVERITY[status] ?? 7
}

/** 子项 → 检查项状态:同一优先级 ERROR > FAIL > UNCHECKED/PENDING > DEFERRED > PASS;空子项 = UNCHECKED。 */
export function aggregateCheckStatus(subchecks, stage) {
  if (!subchecks || subchecks.length === 0) return STATUS.UNCHECKED
  const statuses = subchecks.map((s) => s.status)
  if (statuses.includes(STATUS.ERROR)) return STATUS.ERROR
  if (statuses.includes(STATUS.FAIL)) return STATUS.FAIL
  if (statuses.includes(STATUS.UNCHECKED)) return STATUS.UNCHECKED
  if (statuses.includes(STATUS.PENDING)) return STATUS.PENDING
  if (statuses.includes(STATUS.DEFERRED_PUSH_LINK))
    return stage === 'pre-push' ? STATUS.DEFERRED_PUSH_LINK : STATUS.PENDING
  if (statuses.every((s) => s === STATUS.NOT_APPLICABLE)) return STATUS.NOT_APPLICABLE
  return STATUS.PASS
}

/**
 * 按策略的检查目录构造阶段报告:每个目录项必须有结果;缺结果 = UNCHECKED;
 * 阶段规则为 not-applicable 的项显式 NOT_APPLICABLE(带理由),不允许操作员自定 NOT_APPLICABLE。
 * results: Map<checkId, { subchecks:[{id,status,reasonCode,detail}], command, exitCode, evidence, location }>
 */
export function buildStageReport({ policy, stage, results, context }) {
  const checks = []
  const known = new Set(policy.checks.map((c) => c.id))
  for (const def of policy.checks) {
    const rule =
      stage === 'prepare' ? (def.prepare ? 'required' : 'not-applicable') : def.stages[stage]
    const res = results.get(def.id)
    let status
    let subchecks
    let reasonCode = null
    if (rule === 'not-applicable') {
      status = STATUS.NOT_APPLICABLE
      reasonCode =
        stage === 'prepare'
          ? 'NOT_PART_OF_PREPARE'
          : `DEFERRED_TO_${def.stages['pre-release'] === 'required' ? 'PRE_RELEASE' : 'LATER_STAGE'}`
      subchecks = def.subchecks.map((id) => ({
        id,
        status: STATUS.NOT_APPLICABLE,
        reasonCode,
        detail: null
      }))
      if (res && res.subchecks && res.subchecks.some((s) => s.status !== STATUS.NOT_APPLICABLE)) {
        // 后置项若有真实结果,可见但不参与准入;仍不得冒充 PASS 的阶段结论
        subchecks = res.subchecks
        status = STATUS.NOT_APPLICABLE
        reasonCode = 'RESULT_VISIBLE_NOT_COUNTED'
      }
    } else if (!res) {
      status = STATUS.UNCHECKED
      reasonCode = 'NO_RESULT'
      subchecks = def.subchecks.map((id) => ({
        id,
        status: STATUS.UNCHECKED,
        reasonCode: 'NO_RESULT',
        detail: null
      }))
    } else {
      // 同一子项若出现多条结果,保留最严重的一条(ERROR > FAIL > UNCHECKED > PENDING > DEFERRED > NOT_APPLICABLE > PASS),
      // 避免后写入的 UNCHECKED 把先前的 FAIL 盖掉
      const byId = new Map()
      for (const s of res.subchecks ?? []) {
        const prev = byId.get(s.id)
        byId.set(s.id, prev && severity(prev.status) >= severity(s.status) ? prev : s)
      }
      subchecks = def.subchecks.map(
        (id) =>
          byId.get(id) ?? {
            id,
            status: STATUS.UNCHECKED,
            reasonCode: 'SUBCHECK_MISSING',
            detail: null
          }
      )
      const unknownSub = (res.subchecks ?? []).filter((s) => !def.subchecks.includes(s.id))
      for (const s of unknownSub)
        subchecks.push({ ...s, reasonCode: s.reasonCode ?? 'EXTRA_SUBCHECK' })
      for (const s of subchecks)
        if (!STATUS_LIST.includes(s.status)) {
          s.detail = { invalidStatus: s.status }
          s.status = STATUS.ERROR
          s.reasonCode = 'INVALID_STATUS'
        }
      if (res.operatorNotApplicable) {
        subchecks.push({
          id: 'operator-not-applicable',
          status: STATUS.FAIL,
          reasonCode: 'OPERATOR_NOT_APPLICABLE_REJECTED',
          detail: null
        })
      }
      status = aggregateCheckStatus(subchecks, stage)
      if (status === STATUS.NOT_APPLICABLE && rule === 'required') {
        status = STATUS.FAIL
        reasonCode = 'OPERATOR_NOT_APPLICABLE_REJECTED'
      }
    }
    checks.push({
      id: def.id,
      title: def.title,
      targetKind: def.targetKind ?? null,
      owner: def.owner ?? null,
      stageRule: rule,
      status,
      reasonCode,
      subchecks,
      command: res?.command ?? null,
      exitCode: res?.exitCode ?? null,
      location: res?.location ?? null,
      evidence: res?.evidence ?? def.evidence ?? [],
      documents: res?.documents ?? undefined,
      source: context.source ?? null,
      candidateDigest: context.candidateDigest ?? null
    })
  }
  for (const id of results.keys())
    if (!known.has(id))
      checks.push({
        id,
        title: '(not in policy catalogue)',
        stageRule: 'unknown',
        status: STATUS.ERROR,
        reasonCode: 'UNKNOWN_CHECK_ID',
        subchecks: [],
        evidence: []
      })

  const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]))
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1
  const exitCode = aggregateExit(checks.map((c) => exitForStatus(c.status, stage)))
  const label = policy.admissionLabels[stage]
  return {
    schemaVersion: 1,
    kind: 'release-stage-report',
    stage,
    releaseId: context.releaseId,
    runId: context.runId,
    generatedAt: context.generatedAt,
    tool: context.tool ?? null,
    source: context.source ?? null,
    candidateDigest: context.candidateDigest ?? null,
    policySha256: context.policySha256 ?? null,
    registrySha256: context.registrySha256 ?? null,
    requiredChecks: policy.checks
      .filter((c) => (stage === 'prepare' ? c.prepare : c.stages[stage] === 'required'))
      .map((c) => c.id),
    checks,
    counts,
    exitCode,
    admission: exitCode === EXIT.ADMITTED ? label : null,
    admissionNote:
      stage === 'prepare'
        ? 'candidate-prepared only means the tree was built from frozen sources; no stage checks are implied'
        : stage === 'pre-push'
          ? 'push-admissible only means source push may proceed; it is not a release approval'
          : 'release-admissible only means release preparation conditions are met; version-level sign-off belongs to Task 6'
  }
}

/** 执行错误报告(启动 / 解析 / 落盘失败):所有目录项 ERROR 或 UNCHECKED,退出 3。 */
export function buildErrorReport({ policy, stage, context, error }) {
  const results = new Map()
  const report = buildStageReport({ policy, stage, results, context })
  for (const c of report.checks) {
    if (c.stageRule === 'required') {
      c.status = STATUS.ERROR
      c.reasonCode = error.code ?? 'EXECUTION_ERROR'
      c.subchecks = c.subchecks.map((s) => ({
        ...s,
        status: STATUS.ERROR,
        reasonCode: error.code ?? 'EXECUTION_ERROR'
      }))
    }
  }
  report.counts = Object.fromEntries(
    STATUS_LIST.map((s) => [s, report.checks.filter((c) => c.status === s).length])
  )
  report.exitCode = EXIT.EXECUTION
  report.admission = null
  report.error = {
    code: error.code ?? 'EXECUTION_ERROR',
    message: redact(error.message ?? String(error)),
    detail: redactValue(error.detail ?? null)
  }
  return report
}

// ── 脱敏 ────────────────────────────────────────────────────────────────────
const SECRET_KEY_RE =
  /(token|cookie|secret|password|passwd|authorization|api[-_]?key|private[-_]?key)/i
const V6_RE = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{0,4}\b/gi
const WIN_ABS_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`)\]]+/g
const UNC_RE = /\\\\[^\s"'`)\]]+/g

export function redact(text, roles = {}) {
  if (typeof text !== 'string') return text
  let out = text
  for (const [real, role] of Object.entries(roles)) if (real) out = out.split(real).join(role)
  out = out
    .replace(V6_RE, '<ipv6-redacted>')
    .replace(UNC_RE, '<unc-path>')
    .replace(WIN_ABS_RE, '<absolute-path>')
  return out
}

export function redactValue(value, roles = {}, keyHint = '') {
  if (value === null || value === undefined) return value
  if (typeof value === 'string')
    return SECRET_KEY_RE.test(keyHint) ? '<redacted>' : redact(value, roles)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => redactValue(v, roles, keyHint))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value))
      out[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : redactValue(v, roles, k)
    return out
  }
  return String(value)
}

// ── 落盘 ────────────────────────────────────────────────────────────────────
export function runId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${p(now.getUTCMilliseconds(), 3)}Z`
}

export function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

/** 报告 JSON + 同名 MD;只用 wx 写新文件,绝不覆盖既有运行记录。 */
export function writeReport({ reportsDir, report, roles = {} }) {
  const base = `${report.runId}-${report.stage}`
  const jsonPath = path.join(reportsDir, `${base}.json`)
  const mdPath = path.join(reportsDir, `${base}.md`)
  const safe = redactValue(report, roles)
  const json = stableJson(safe)
  try {
    fs.mkdirSync(reportsDir, { recursive: true })
    fs.writeFileSync(jsonPath, json, { flag: 'wx' })
    fs.writeFileSync(mdPath, renderMarkdown(safe), { flag: 'wx' })
  } catch (e) {
    const err = new Error(`报告落盘失败:${e.code ?? e.message}`)
    err.code = 'REPORT_WRITE_FAILED'
    throw err
  }
  return { jsonPath, mdPath, sha256: createHash('sha256').update(json).digest('hex') }
}

export function renderMarkdown(report) {
  const lines = []
  lines.push(`# release ${report.stage} — ${report.releaseId} — run ${report.runId}`)
  lines.push('')
  lines.push(`- exit: **${report.exitCode}**  admission: **${report.admission ?? '(none)'}**`)
  lines.push(
    `- source: ${report.source ? `${report.source.commit} (tree ${report.source.tree})` : '(none)'}`
  )
  lines.push(`- candidateDigest: ${report.candidateDigest ?? '(none)'}`)
  lines.push(
    `- policySha256: ${report.policySha256 ?? '(none)'}  registrySha256: ${report.registrySha256 ?? '(none)'}`
  )
  lines.push(
    `- counts: ${Object.entries(report.counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`
  )
  lines.push(`- note: ${report.admissionNote}`)
  if (report.error) lines.push(`- error: ${report.error.code} ${report.error.message}`)
  lines.push('')
  lines.push('| check | rule | status | reason | subchecks |')
  lines.push('|---|---|---|---|---|')
  for (const c of report.checks) {
    const subs = c.subchecks
      .map((s) => `${s.id}:${s.status}${s.reasonCode ? `(${s.reasonCode})` : ''}`)
      .join('<br>')
    lines.push(`| ${c.id} | ${c.stageRule} | ${c.status} | ${c.reasonCode ?? ''} | ${subs} |`)
  }
  lines.push('')
  return lines.join('\n') + '\n'
}
