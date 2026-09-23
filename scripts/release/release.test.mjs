// scripts/release/release.test.mjs
// Named cases for the release CLI skeleton (v1.0 Task 5 Step 6a): I-01 / I-02 / I-03 / I-04 / I-05 / I-06 / I-12 / I-16.
//   run all:    npm run test:release            (= node --test scripts/release/release.test.mjs)
//   run one:    node --test --test-name-pattern='^I-02/' scripts/release/release.test.mjs
// Fixtures are throw-away git repositories under .tmp-probe/task5-fixtures/step6a-<case>-<random>/ and are removed
// when the file finishes (set RELEASE_TEST_KEEP_FIXTURES=1 to keep them). No real history is rewritten: every
// negative Git shape is either a synthetic fixture repository or a stubbed command response.
// Every negative case asserts the concrete reason code / location, never only "it did not throw".
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  MANIFEST_DIGEST_KIND,
  OWNER_MARKER,
  READ_ONLY_GIT_SUBCOMMANDS,
  ReleaseBoundaryError,
  ReleaseExecutionError,
  checkPublicHistory,
  classifyPath,
  compareCandidate,
  createGitAdapter,
  deriveExpectedManifest,
  isSafeReleaseId,
  listForeignStaging,
  manifestDigest,
  posixPathProblems,
  resolveReleaseRoot,
  validateBaseline,
  validatePolicy,
  validateRegistry,
  walkCandidate,
  writeCandidate
} from './source.mjs'
import {
  EXIT,
  STATUS,
  aggregateExit,
  buildStageReport,
  exitForStatus,
  redact,
  redactValue,
  runId,
  writeReport
} from './report.mjs'
import { POLICY_PATH, main, parseArgs } from '../release.mjs'
import {
  REQUIRED_DELTA_ITEMS,
  checkCandidateBoundary,
  checkCandidateSecrets,
  checkExternalLinks,
  checkInternalGate,
  checkInternalMarkers,
  checkLicenseMaterials,
  checkLocalLinks,
  checkManualChecks,
  checkMetadataContract,
  checkPublicMetadata,
  checkValidationDelta,
  extractLinks,
  findMarkerOccurrences,
  headingAnchors,
  loadCandidateFiles,
  registryApplicability,
  runCandidateSecrets,
  validateLiteralPositions
} from './checks.mjs'

// ── environment ─────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const FIXTURE_ROOT = path.join(REPO_ROOT, '.tmp-probe', 'task5-fixtures')
const REAL_POLICY_BUF = fs.readFileSync(path.join(REPO_ROOT, ...POLICY_PATH.split('/')))
const REAL_POLICY = JSON.parse(REAL_POLICY_BUF.toString('utf8'))
const REAL_SCANNER_BUF = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs'))
const MAINTAINER = REAL_POLICY.publicGit.maintainer
// Synthetic GPL body carrying the structural markers the notices check looks for (terms 0-17, end marker, how-to-apply).
const GPL_BODY =
  'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\n0. Definitions.\n1. Source Code.\n17. Interpretation of Sections 15 and 16.\n\nEND OF TERMS AND CONDITIONS\n\nHow to Apply These Terms to Your New Programs\n\n<http://www.gnu.org/philosophy/why-not-lgpl.html>.\n'
const TPL_BODY =
  'yt-dlp third party licences\n\nGNU Readline | GPL-3.0-or-later\n\n' +
  GPL_BODY +
  '\ncertifi | MPL-2.0\n'
const ELECTRON_BUILDER_YML =
  "appId: fixture\nfiles:\n  - '!publish{,/**/*}'\nextraResources:\n  - from: resources/bin\n    to: bin\n    filter:\n      - 'license-notices/**/*'\n      - 'license-provenance.json'\n  - from: THIRD-PARTY-NOTICES.md\n    to: THIRD-PARTY-NOTICES.md\npublish:\n  provider: github\n  owner: lie-dream\n  repo: DownLord\n"
const DEV_UPDATE_YML = 'provider: github\nowner: lie-dream\nrepo: DownLord\n'
// Files that carry exact-instance registry entries are copied byte for byte so the fixture candidate
// exercises the real applicability computation (applied / retired) instead of a synthetic stale set.
const REAL_BYTES = Object.fromEntries(
  [
    'package-lock.json',
    'THIRD-PARTY-NOTICES.md',
    'extension/manifest.json',
    'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt'
  ].map((p) => [p, fs.readFileSync(path.join(REPO_ROOT, ...p.split('/')))])
)
const vmEval = (src) => runInNewContext(src)
const KEEP = process.env.RELEASE_TEST_KEEP_FIXTURES === '1'
const FIXTURES = []
const TEMP_DIRS = []

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const TEXT = (s) => Buffer.from(s, 'utf8')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    shell: false,
    windowsHide: true
  })
  if (res.error) throw res.error
  if (res.status !== 0 && !opts.allowFail)
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`)
  return res
}
const rev = (cwd, ref) => git(cwd, ['rev-parse', '--verify', ref]).stdout.trim()

function writeFiles(root, files) {
  for (const [rel, buf] of files) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
  }
}

// Internal sources deliberately carry internal markers so the overlay test can prove they never reach the candidate.
const INTERNAL_SOURCES = {
  'CLAUDE.md': '# CLAUDE (internal)\n\nSee docs/v1.0/superpowers/plans/x.md and docs/TODO.md.\n',
  'CONTEXT.md': '# CONTEXT (internal)\n\nInternal glossary with /grill-with-docs entry.\n',
  'docs/PRD.md': '# PRD (internal)\n\nInternal PRD, see docs/CURRENT_MILESTONE.md.\n',
  'docs/ARCHITECTURE.md':
    '# ARCHITECTURE (internal)\n\nInternal architecture, see docs/progress.md.\n',
  'docs/DESIGN.md': '# DESIGN (internal)\n\nInternal design, see docs/grill-templates.md.\n'
}
const PUBLIC_SOURCES = {
  'publish/CLAUDE.md':
    '# CLAUDE (public)\n\nPublic collaboration rules only. Every Task has a plan.\n',
  'publish/CONTEXT.md':
    '# CONTEXT (public)\n\nPublic glossary.\n\n### 开源发布(v1.0 起)\n\n**候选树**: main − 剥离 + `publish/` 覆盖。\n',
  'publish/docs/PRD.md':
    '# PRD (public)\n\nPublic product definition. See [design](DESIGN.md#design-public).\n',
  'publish/docs/ARCHITECTURE.md': '# ARCHITECTURE (public)\n\nPublic architecture.\n',
  'publish/docs/DESIGN.md': '# DESIGN (public)\n\n## Design (public)\n\nPublic design rules.\n'
}
// Paths that D14 / the user decision strip; each must be present in the fixture and absent from the candidate.
const STRIPPED_SAMPLES = [
  'docs/v0.1/old.md',
  'docs/v0.2/old.md',
  'docs/v0.3/old.md',
  'docs/v0.4/old.md',
  'docs/v1.0/superpowers/plans/x.md',
  'docs/TODO.md',
  'docs/progress.md',
  'docs/CURRENT_MILESTONE.md',
  'docs/grill-templates.md',
  'prototype-downlord.html',
  '.codex/README.md',
  '.codex/config.toml',
  '.codex/scanner-internal-dispositions.json',
  '.codex/hooks/load-context.txt',
  'docs/codex/superpowers/2026-09-10-codex-context-routing.md'
]
// Paths outside every rule that must survive (the "docs/v2.0" control from I-03).
const KEPT_SAMPLES = [
  'docs/v2.0/example.md',
  'docs/v10/notes.md',
  'src/main/index.ts',
  'src/renderer/index.ts',
  'src/preload/index.ts',
  'src/shared/types.ts',
  'extension/src/index.ts',
  'scripts/release/source.mjs',
  'tests/helpers/h.ts',
  'resources/bin/license-notices/aria2/COPYING.txt',
  'resources/bin/license-notices/ffmpeg/LICENSE.txt',
  'resources/bin/license-notices/yt-dlp/LICENSE.txt'
]

function baseFiles(policyBuf) {
  const files = new Map()
  const put = (p, b) => files.set(p, Buffer.isBuffer(b) ? b : TEXT(b))
  for (const p of REAL_POLICY.requiredTargets.files) {
    if (p === POLICY_PATH) put(p, policyBuf)
    else if (p === 'eslint.config.mjs') put(p, 'export default []\n')
    else if (/\.(png|ico|icns)$/.test(p)) put(p, PNG)
    else if (p === 'scripts/scan-secrets.mjs') put(p, REAL_SCANNER_BUF)
    else if (/\.(mjs|ts)$/.test(p)) put(p, 'export {}\n')
    else if (p === 'package.json')
      put(
        p,
        JSON.stringify(
          {
            name: 'fixture',
            version: '1.0.0',
            author: 'lie-dream',
            engines: { node: '>=22.12', npm: '>=11' }
          },
          null,
          2
        ) + '\n'
      )
    else if (p === 'electron-builder.yml') put(p, ELECTRON_BUILDER_YML)
    else if (p === 'dev-app-update.yml') put(p, DEV_UPDATE_YML)
    else if (p === 'README.md')
      put(
        p,
        '# Fixture\n\nSee [PRD](docs/PRD.md) and [design](./docs/DESIGN.md#design-public).\n\n![main](docs/assets/screenshots/main-window.png)\n\nUpstream: https://example.com/upstream\n'
      )
    else if (p === 'resources/bin/yt-dlp-LICENSE.txt') put(p, GPL_BODY)
    else if (p in REAL_BYTES) put(p, REAL_BYTES[p])
    else if (p === '.gitignore') put(p, '/.tmp-probe/\nnode_modules/\ndist/\nout/\n')
    else if (p === '.gitattributes') put(p, '* -text\n')
    else if (/tsconfig.*\.json$/.test(p)) put(p, '{}\n')
    else if (p === 'resources/bin/license-provenance.json') continue
    else if (p in INTERNAL_SOURCES) put(p, INTERNAL_SOURCES[p])
    else put(p, `fixture ${p}\n`)
  }
  for (const p of STRIPPED_SAMPLES) put(p, `internal ${p}\n`)
  for (const p of KEPT_SAMPLES) put(p, /\.(mjs|ts)$/.test(p) ? 'export {}\n' : `kept ${p}\n`)
  for (const [rp, rb] of Object.entries(REAL_BYTES)) if (!files.has(rp)) put(rp, rb)
  put('resources/bin/license-notices/yt-dlp/tpl-fixture.txt', TPL_BODY)
  const materials = [
    'resources/bin/aria2-LICENSE.txt',
    'resources/bin/ffmpeg-LICENSE.txt',
    'resources/bin/yt-dlp-LICENSE.txt',
    'resources/bin/license-notices/aria2/COPYING.txt',
    'resources/bin/license-notices/ffmpeg/LICENSE.txt',
    'resources/bin/license-notices/yt-dlp/LICENSE.txt',
    'resources/bin/license-notices/yt-dlp/tpl-fixture.txt',
    'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt'
  ].map((p) => ({
    path: p,
    packagedPath: p.replace('resources/', ''),
    sha256: sha256(files.get(p)),
    transformation: p.endsWith('yt-dlp-LICENSE.txt')
      ? 'byte-range extraction'
      : 'verbatim byte copy'
  }))
  const tplStart = TPL_BODY.indexOf(GPL_BODY)
  put(
    'resources/bin/license-provenance.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        notices: { source: 'THIRD-PARTY-NOTICES.md', packagedPath: 'THIRD-PARTY-NOTICES.md' },
        materials,
        gplExtraction: {
          sourcePath: 'resources/bin/license-notices/yt-dlp/tpl-fixture.txt',
          sourceSha256: sha256(TEXT(TPL_BODY)),
          targetPath: 'resources/bin/yt-dlp-LICENSE.txt',
          startInclusive: tplStart,
          endExclusive: tplStart + Buffer.byteLength(GPL_BODY),
          extractedSha256: sha256(TEXT(GPL_BODY))
        }
      },
      null,
      2
    ) + '\n'
  )
  return files
}

function publicFiles() {
  const files = new Map()
  for (const [p, s] of Object.entries(PUBLIC_SOURCES)) files.set(p, TEXT(s))
  return files
}

function registryFor(baseCommit, pub) {
  return {
    schemaVersion: 1,
    documents: REAL_POLICY.publicDocuments.documents.map((d) => ({
      sourcePath: d.sourcePath,
      publicPath: d.publicPath,
      targetPath: d.targetPath,
      baseCommit,
      publicSha256: sha256(pub.get(d.publicPath))
    }))
  }
}
const registryBuf = (registry) => TEXT(JSON.stringify(registry, null, 2) + '\n')

/**
 * Two-commit fixture: commit "base" holds every required target plus stripped/kept samples;
 * commit "publish" adds the five public overlays and publish/sync-base.json whose baseCommit is "base".
 * The registry is therefore committed after the commit it points at, exactly like the real repository.
 */
function createFixture(caseId, opts = {}) {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, `step6a-${caseId}-`))
  const root = path.join(dir, 'repo')
  fs.mkdirSync(root)
  initRepo(root)
  const files = baseFiles(opts.policyBuf ?? REAL_POLICY_BUF)
  if (opts.mutateBase) opts.mutateBase(files)
  writeFiles(root, files)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  const base = rev(root, 'HEAD')
  const pub = publicFiles()
  writeFiles(root, pub)
  const registry = opts.registry
    ? opts.registry(base, pub, registryFor(base, pub))
    : registryFor(base, pub)
  writeFiles(root, new Map([['publish/sync-base.json', registryBuf(registry)]]))
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'publish'])
  const fx = {
    dir,
    root,
    base,
    head: rev(root, 'HEAD'),
    files,
    pub,
    registry,
    git: (args, o) => git(root, args, o),
    rev: (ref) => rev(root, ref),
    abs: (rel) => path.join(root, ...rel.split('/')),
    write(rel, content) {
      writeFiles(root, new Map([[rel, Buffer.isBuffer(content) ? content : TEXT(content)]]))
    },
    read(rel) {
      return fs.readFileSync(path.join(root, ...rel.split('/')))
    },
    commit(msg) {
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '--allow-empty', '-m', msg])
      fx.head = rev(root, 'HEAD')
      return fx.head
    },
    releaseDir: (id) => path.join(root, '.tmp-probe', 'releases', id)
  }
  FIXTURES.push(fx)
  return fx
}

function initRepo(root) {
  git(root, ['init', '-q', '-b', 'main'])
  for (const [k, v] of Object.entries({
    'user.name': MAINTAINER.name,
    'user.email': MAINTAINER.email,
    'core.autocrlf': 'false',
    'core.symlinks': 'false',
    'commit.gpgsign': 'false',
    'core.quotepath': 'false'
  }))
    git(root, ['config', k, v])
}

// Deterministic, strictly increasing clock so every run gets its own run-id and report file.
let tick = 0
function nextClock() {
  const t = Date.UTC(2026, 8, 19, 0, 0, 0, 0) + tick++ * 1000
  return () => new Date(t)
}

function listReports(fx, id) {
  const dir = path.join(fx.releaseDir(id), 'reports')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
}

/** Run the CLI in-process against a fixture; returns exit code, captured output, git recorder and the new report. */
async function runCli(fx, argv, extra = {}) {
  const id = argv[argv.indexOf('--release-id') + 1]
  const before = new Set(listReports(fx, id))
  const out = []
  const err = []
  const recorder = []
  const code = await main(argv, {
    cwd: fx.root,
    recorder,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: nextClock(),
    ...extra
  })
  const created = listReports(fx, id).filter((n) => !before.has(n))
  assert.ok(created.length <= 1, `at most one report per run, got ${created.join(',')}`)
  const reportPath = created.length ? path.join(fx.releaseDir(id), 'reports', created[0]) : null
  const reportText = reportPath ? fs.readFileSync(reportPath, 'utf8') : null
  const report = reportText ? JSON.parse(reportText) : null
  return { code, out, err, recorder, report, reportText, reportPath }
}

const check = (report, id) => report.checks.find((c) => c.id === id)
const sub = (report, checkId, subId) => check(report, checkId).subchecks.find((s) => s.id === subId)
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const sourceJson = (fx, id) => readJson(path.join(fx.releaseDir(id), 'source.json'))
const manifestJson = (fx, id) => readJson(path.join(fx.releaseDir(id), 'candidate-manifest.json'))
const candidateDir = (fx, id) => path.join(fx.releaseDir(id), 'candidate')

/** Content snapshot of a directory (relative POSIX path -> sha256), optionally skipping some relative prefixes. */
function snapshotDir(dir, skip = []) {
  const map = new Map()
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name
      if (skip.some((s) => r === s || r.startsWith(s + '/'))) continue
      const a = path.join(abs, d.name)
      const st = fs.lstatSync(a)
      if (st.isSymbolicLink()) map.set(r, 'symlink')
      else if (st.isDirectory()) walk(a, r)
      else map.set(r, sha256(fs.readFileSync(a)))
    }
  }
  walk(dir, '')
  return map
}
// Internal fixture snapshot: the release working root is the only legitimate write target; `git status` may refresh
// the stat cache in .git/index (documented Git behaviour), so the index file is excluded while refs/objects/HEAD are not.
const snapshotInternal = (fx) => snapshotDir(fx.root, ['.tmp-probe', '.git/index', '.git/logs'])
function assertSameSnapshot(a, b, label) {
  const diff = []
  for (const [k, v] of a) if (b.get(k) !== v) diff.push(`changed/removed: ${k}`)
  for (const k of b.keys()) if (!a.has(k)) diff.push(`added: ${k}`)
  assert.deepEqual(diff, [], `${label}: unexpected changes`)
}

function writeBaseline(fx, id, baseline) {
  const dir = path.join(fx.releaseDir(id), 'evidence')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'public-baseline.json')
  if (baseline === null) fs.rmSync(p, { force: true })
  else fs.writeFileSync(p, JSON.stringify(baseline, null, 2) + '\n')
}
const BASELINE_ROOT = {
  schemaVersion: 1,
  previousPublicCommit: null,
  tags: [],
  confirmedBy: 'fixture',
  confirmedAt: '2026-09-19T00:00:00Z'
}

function makePublicRepo(fx, name, candidate) {
  const pub = path.join(fx.dir, name)
  fs.mkdirSync(pub)
  initRepo(pub)
  if (candidate) {
    fs.cpSync(candidate, pub, { recursive: true })
    git(pub, ['add', '-A'])
    git(pub, ['commit', '-q', '-m', 'public snapshot'])
  }
  return pub
}

function removeLink(p) {
  try {
    fs.rmdirSync(p)
  } catch {
    fs.unlinkSync(p)
  }
}

after(() => {
  for (const fx of FIXTURES) {
    try {
      git(fx.root, ['worktree', 'prune'], { allowFail: true })
    } catch {
      /* fixture may already be gone */
    }
    if (!KEEP) fs.rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  for (const d of TEMP_DIRS)
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

// ════════════════════════════════════════════════════════════════════════════
// I-02 — source freeze, candidate re-verification, controlled root
// ════════════════════════════════════════════════════════════════════════════
const fxA = createFixture('main')
const RID = 'rel-1'
let happy = null
let happySnapshot = null

test('I-02/prepare from a clean committed main builds the candidate from frozen blobs', async () => {
  const before = snapshotInternal(fxA)
  happy = await runCli(fxA, ['prepare', '--release-id', RID])
  assert.equal(happy.code, EXIT.ADMITTED, happy.err.join('\n'))
  assert.ok(happy.out.includes('candidate-prepared'), 'admission marker printed')
  assert.equal(happy.report.stage, 'prepare')
  assert.equal(happy.report.admission, 'candidate-prepared')
  assert.equal(check(happy.report, 'source').status, STATUS.PASS)
  assert.equal(check(happy.report, 'sync').status, STATUS.PASS)
  const src = sourceJson(fxA, RID)
  assert.equal(src.commit, fxA.head)
  assert.equal(src.branch, 'refs/heads/main')
  assert.equal(src.tree, fxA.rev('HEAD^{tree}'))
  assert.equal(src.internalRoot, '<internal-root>')
  assert.equal(src.policy.sha256, sha256(REAL_POLICY_BUF))
  assert.equal(src.registry.sha256, sha256(fxA.read('publish/sync-base.json')))
  assert.equal(src.packageVersion, '1.0.0')
  assert.ok(fs.existsSync(candidateDir(fxA, RID)))
  assert.ok(!fs.existsSync(path.join(candidateDir(fxA, RID), '.git')), 'candidate carries no .git')
  assert.ok(!fs.existsSync(path.join(candidateDir(fxA, RID), OWNER_MARKER)), 'owner marker removed')
  const top = fs.readdirSync(fxA.releaseDir(RID)).sort()
  assert.deepEqual(top, [
    'candidate',
    'candidate-manifest.json',
    'evidence',
    'reports',
    'source.json'
  ])
  assertSameSnapshot(before, snapshotInternal(fxA), 'internal source after prepare')
  happySnapshot = snapshotDir(candidateDir(fxA, RID))
})

test('I-02/manifest is byte-ordered, records mode/blob/sha256/bytes and its digest is not a tree oid', () => {
  const man = manifestJson(fxA, RID)
  const src = sourceJson(fxA, RID)
  const paths = man.entries.map((e) => e.path)
  assert.deepEqual(paths, [...paths].sort(byteOrder))
  for (const e of man.entries) {
    assert.equal(e.mode, '100644')
    assert.match(e.blob, /^[0-9a-f]{40}$/)
    assert.match(e.sha256, /^[0-9a-f]{64}$/)
    assert.equal(typeof e.bytes, 'number')
  }
  assert.equal(man.digestKind, MANIFEST_DIGEST_KIND)
  assert.equal(man.digest, manifestDigest(man.entries))
  assert.equal(src.candidate.digest, man.digest)
  assert.equal(happy.report.candidateDigest, man.digest)
  assert.notEqual(man.digest, src.tree)
  const walked = walkCandidate(candidateDir(fxA, RID))
  assert.deepEqual(walked.anomalies, [])
  assert.ok(compareCandidate(man.entries, walked).ok)
  assert.equal(walked.entries.length, man.entries.length)
})

test('I-02/report is redacted: no absolute internal path, source and hashes are recorded', () => {
  assert.ok(!happy.reportText.includes(fxA.root), 'backslash form absent')
  assert.ok(!happy.reportText.includes(fxA.root.split(path.sep).join('/')), 'slash form absent')
  assert.equal(happy.report.source.commit, fxA.head)
  assert.equal(happy.report.policySha256, sha256(REAL_POLICY_BUF))
  assert.equal(happy.report.registrySha256, sha256(fxA.read('publish/sync-base.json')))
  assert.ok(fs.existsSync(happy.reportPath.replace(/\.json$/, '.md')), 'markdown twin written')
})

test('I-02/same id with the same input only re-verifies and appends a report', async () => {
  const before = snapshotDir(candidateDir(fxA, RID))
  const res = await runCli(fxA, ['prepare', '--release-id', RID])
  assert.equal(res.code, EXIT.ADMITTED, res.err.join('\n'))
  assert.equal(
    sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
    'REVERIFIED_EXISTING'
  )
  assert.equal(sub(res.report, 'source', 'source-reverified').status, STATUS.PASS)
  assert.ok(res.out.includes('candidate-prepared'))
  assert.equal(listReports(fxA, RID).length, 2)
  assertSameSnapshot(before, snapshotDir(candidateDir(fxA, RID)), 'candidate after re-run')
})

test('I-02/a different id derives again and never deletes the earlier candidate', async () => {
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-2'])
  assert.equal(res.code, EXIT.ADMITTED, res.err.join('\n'))
  assert.ok(fs.existsSync(candidateDir(fxA, RID)))
  assert.ok(fs.existsSync(candidateDir(fxA, 'rel-2')))
  assert.equal(sourceJson(fxA, 'rel-2').candidate.digest, sourceJson(fxA, RID).candidate.digest)
  assertSameSnapshot(happySnapshot, snapshotDir(candidateDir(fxA, RID)), 'first candidate')
})

test('I-02/check on a never-prepared id is UNCHECKED and exits 2', async () => {
  const res = await runCli(fxA, ['check', '--release-id', 'rel-none', '--stage', 'pre-push'])
  assert.equal(res.code, EXIT.INCOMPLETE)
  assert.equal(
    sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
    'CANDIDATE_NOT_PREPARED'
  )
  assert.equal(res.report.admission, null)
})

test('I-02/check rebuilds the expected manifest from frozen blobs and detects a tampered candidate file', async () => {
  const target = path.join(candidateDir(fxA, RID), 'README.md')
  const original = fs.readFileSync(target)
  fs.writeFileSync(target, Buffer.concat([original, TEXT('tampered\n')]))
  const bad = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
  assert.equal(bad.code, EXIT.VIOLATION)
  const s = sub(bad.report, 'source', 'candidate-matches-expected')
  assert.equal(s.reasonCode, 'CANDIDATE_TAMPERED')
  assert.deepEqual(s.detail.modified, ['README.md'])
  fs.writeFileSync(target, original)
  const good = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
  assert.equal(sub(good.report, 'source', 'candidate-matches-expected').status, STATUS.PASS)
})

test('I-02/an extra delivery file or a reparse point inside the candidate is detected', async () => {
  if (!fs.existsSync(candidateDir(fxA, RID))) await runCli(fxA, ['prepare', '--release-id', RID])
  // a stripped internal file pushed back into the candidate by hand is caught even though the manifest was clean
  const extra = path.join(candidateDir(fxA, RID), 'docs', 'TODO.md')
  fs.writeFileSync(extra, 'internal backlog re-inserted by hand')
  const r1 = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
  assert.equal(r1.code, EXIT.VIOLATION)
  assert.equal(
    sub(r1.report, 'source', 'candidate-matches-expected').reasonCode,
    'CANDIDATE_TAMPERED'
  )
  assert.deepEqual(sub(r1.report, 'source', 'candidate-matches-expected').detail.extra, [
    'docs/TODO.md'
  ])
  fs.rmSync(extra)
  const target = path.join(fxA.dir, 'junction-target')
  fs.mkdirSync(target)
  const link = path.join(candidateDir(fxA, RID), 'linked')
  fs.symlinkSync(target, link, 'junction')
  try {
    const r2 = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
    const s = sub(r2.report, 'source', 'candidate-matches-expected')
    assert.equal(s.reasonCode, 'CANDIDATE_TAMPERED')
    assert.equal(s.detail.anomalies[0].kind, 'symlink-or-reparse-point')
    assert.equal(s.detail.anomalies[0].path, 'linked')
  } finally {
    removeLink(link)
  }
  const r3 = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
  assert.equal(sub(r3.report, 'source', 'candidate-matches-expected').status, STATUS.PASS)
})

test('I-02/candidate and manifest tampered together still fail against the frozen blobs', async () => {
  const id = 'rel-2'
  const target = path.join(candidateDir(fxA, id), 'LICENSE')
  const forged = TEXT('forged licence\n')
  fs.writeFileSync(target, forged)
  const manPath = path.join(fxA.releaseDir(id), 'candidate-manifest.json')
  const srcPath = path.join(fxA.releaseDir(id), 'source.json')
  const man = readJson(manPath)
  const entry = man.entries.find((e) => e.path === 'LICENSE')
  entry.sha256 = sha256(forged)
  entry.bytes = forged.length
  man.digest = manifestDigest(man.entries)
  const src = readJson(srcPath)
  src.candidate.digest = man.digest
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n')
  fs.writeFileSync(srcPath, JSON.stringify(src, null, 2) + '\n')
  const res = await runCli(fxA, ['check', '--release-id', id, '--stage', 'pre-push'])
  assert.equal(res.code, EXIT.VIOLATION)
  const s = sub(res.report, 'source', 'candidate-matches-expected')
  assert.equal(s.reasonCode, 'RECORDED_DIGEST_MISMATCH')
  assert.deepEqual(s.detail.modified, ['LICENSE'])
  assert.notEqual(s.detail.expected, man.digest)
})

test('I-02/dirty worktree blocks preparation and nothing is built', async () => {
  fxA.write('untracked-note.txt', 'dirty\n')
  try {
    const res = await runCli(fxA, ['prepare', '--release-id', 'rel-dirty'])
    assert.equal(res.code, EXIT.VIOLATION)
    assert.equal(sub(res.report, 'source', 'clean-worktree').reasonCode, 'WORKTREE_DIRTY')
    assert.deepEqual(sub(res.report, 'source', 'clean-worktree').detail.untracked, [
      'untracked-note.txt'
    ])
    assert.equal(
      sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
      'NOT_BUILT_PRECONDITION_FAILED'
    )
    assert.ok(!res.out.includes('candidate-prepared'))
    assert.ok(!fs.existsSync(candidateDir(fxA, 'rel-dirty')))
    assert.deepEqual(fs.readdirSync(fxA.releaseDir('rel-dirty')), ['reports'])
  } finally {
    fs.rmSync(fxA.abs('untracked-note.txt'))
  }
})

test('I-02/not on main blocks preparation', async () => {
  fxA.git(['checkout', '-q', '-b', 'feature'])
  try {
    const res = await runCli(fxA, ['prepare', '--release-id', 'rel-branch'])
    assert.equal(res.code, EXIT.VIOLATION)
    assert.equal(sub(res.report, 'source', 'on-main').reasonCode, 'NOT_ON_MAIN')
    assert.equal(sub(res.report, 'source', 'on-main').detail.branch, 'refs/heads/feature')
    assert.ok(!fs.existsSync(candidateDir(fxA, 'rel-branch')))
  } finally {
    fxA.git(['checkout', '-q', 'main'])
    fxA.git(['branch', '-q', '-D', 'feature'])
  }
})

test('I-02/main moved after prepare is SOURCE_MOVED on check, never SYNC_DRIFT', async () => {
  fxA.write('src/main/index.ts', 'export {}\n// unrelated code change\n')
  fxA.commit('code change')
  const res = await runCli(fxA, ['check', '--release-id', RID, '--stage', 'pre-push'])
  assert.equal(res.code, EXIT.VIOLATION)
  const s = sub(res.report, 'source', 'candidate-matches-expected')
  assert.equal(s.reasonCode, 'SOURCE_MOVED')
  assert.equal(s.detail.recorded, sourceJson(fxA, RID).commit)
  assert.equal(s.detail.current, fxA.head)
  assert.equal(check(res.report, 'sync').status, STATUS.PASS)
  assert.ok(!res.reportText.includes('SYNC_DRIFT'))
  assert.ok(fs.existsSync(candidateDir(fxA, RID)), 'old candidate kept')
})

test('I-02/unsafe release ids are rejected before anything is created', async () => {
  for (const bad of ['a/b', 'a\\b', '..', '.git', '-x', 'a'.repeat(65), 'x y', '']) {
    assert.equal(isSafeReleaseId(bad), false, bad)
    assert.ok(parseArgs(['prepare', '--release-id', bad]).error, bad)
  }
  const res = await runCli(fxA, ['prepare', '--release-id', '../escape'])
  assert.equal(res.code, EXIT.INCOMPLETE)
  assert.equal(res.report, null)
  assert.ok(!fs.existsSync(path.join(fxA.root, '.tmp-probe', 'escape')))
  assert.throws(
    () =>
      resolveReleaseRoot({
        internalRoot: fxA.root,
        controlledRoot: '.tmp-probe/releases/',
        releaseId: '../x'
      }),
    (e) => e instanceof ReleaseBoundaryError && e.code === 'RELEASE_ID_UNSAFE'
  )
})

test('I-02/release root refuses reparse points and never writes through them', async () => {
  const target = path.join(fxA.dir, 'reparse-target')
  fs.mkdirSync(target)
  const link = fxA.releaseDir('rel-link')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, 'junction')
  try {
    const res = await runCli(fxA, ['prepare', '--release-id', 'rel-link'])
    assert.equal(res.code, EXIT.VIOLATION)
    assert.ok(
      res.err.some((l) => l.includes('REJECTED REPARSE_POINT')),
      res.err.join('\n')
    )
    assert.deepEqual(fs.readdirSync(target), [], 'nothing written through the link')
  } finally {
    removeLink(link)
  }
})

test('I-02/symlink and gitlink tree entries block preparation', async () => {
  const fx = createFixture('tree-entries')
  const blob = fx.git(['hash-object', '-w', '--stdin'], { input: 'target' }).stdout.trim()
  fx.git(['update-index', '--add', '--cacheinfo', `120000,${blob},link-entry`])
  fx.git(['update-index', '--add', '--cacheinfo', `160000,${fx.head},sub-entry`])
  fx.git(['commit', '-q', '-m', 'odd entries'])
  fx.git(['checkout', '-q', '--', 'link-entry'])
  fs.mkdirSync(fx.abs('sub-entry'))
  fx.head = fx.rev('HEAD')
  const res = await runCli(fx, ['prepare', '--release-id', 'odd'])
  assert.equal(res.code, EXIT.VIOLATION, res.err.join('\n'))
  assert.equal(
    sub(res.report, 'source', 'clean-worktree').status,
    STATUS.PASS,
    'fixture itself is clean'
  )
  const s = sub(res.report, 'source', 'tree-entries-supported')
  assert.equal(s.status, STATUS.FAIL)
  const codes = s.detail.items.map((i) => `${i.reasonCode}:${i.path}`).sort()
  assert.deepEqual(codes, ['GITLINK_ENTRY:sub-entry', 'SYMLINK_ENTRY:link-entry'])
  assert.ok(!fs.existsSync(candidateDir(fx, 'odd')))
})

test('I-02/synthetic unsafe paths, case collisions and file-directory conflicts are findings', () => {
  const blob = (p) => ({ mode: '100644', type: 'blob', oid: sha256(p).slice(0, 40), path: p })
  const entries = [
    blob('README.md'),
    blob('readme.md'),
    blob('docs'),
    blob('docs/x.md'),
    blob('Docs/TODO.md'),
    blob('a/../b.md'),
    blob('x/CON.txt'),
    blob('C:/win.md'),
    blob('trail /y.md')
  ]
  const readBlob = (oids) => ({ map: new Map(oids.map((o) => [o, TEXT('x')])), missing: [] })
  const d = deriveExpectedManifest({
    treeEntries: entries,
    policy: REAL_POLICY,
    registry: null,
    readBlob
  })
  const safety = d.findings.filter((f) => f.subcheck === 'path-safety')
  const codes = safety.map((f) => f.reasonCode)
  assert.ok(codes.includes('CASE_COLLISION'))
  assert.ok(codes.includes('FILE_DIRECTORY_CONFLICT'))
  assert.ok(codes.includes('CASE_VARIANT_OF_RULE_PATH'))
  const unsafe = safety
    .filter((f) => f.reasonCode === 'PATH_UNSAFE')
    .map((f) => f.detail.path)
    .sort()
  assert.deepEqual(unsafe, ['C:/win.md', 'a/../b.md', 'trail /y.md', 'x/CON.txt'])
  assert.ok(!d.entries.some((e) => e.path === 'a/../b.md'))
  assert.deepEqual(posixPathProblems('a/../b.md'), ['dot-segment'])
  assert.deepEqual(posixPathProblems('\\\\srv\\share'), ['backslash', 'unc'])
  assert.ok(posixPathProblems('docs/').includes('file-trailing-slash'))
  assert.deepEqual(posixPathProblems('docs', { directory: true }), [
    'directory-missing-trailing-slash'
  ])
})

test('I-02/source read failure is an execution error 3', async () => {
  const spawnImpl = () => ({
    error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  })
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-nogit'], { spawnImpl })
  assert.equal(res.code, EXIT.EXECUTION)
  assert.ok(
    res.err.some((l) => l.includes('GIT_SPAWN_FAILED')),
    res.err.join('\n')
  )
  assert.ok(!fs.existsSync(fxA.releaseDir('rel-nogit')))
  const failing = (program, args, opts) =>
    args[0] === 'cat-file'
      ? {
          status: 128,
          stdout: opts.encoding === null ? Buffer.alloc(0) : '',
          stderr: 'fatal: injected'
        }
      : spawnSync(program, args, opts)
  const res2 = await runCli(fxA, ['prepare', '--release-id', 'rel-catfail'], { spawnImpl: failing })
  assert.equal(res2.code, EXIT.EXECUTION)
  assert.equal(res2.report.exitCode, EXIT.EXECUTION)
  assert.equal(res2.report.error.code, 'GIT_COMMAND_FAILED')
  assert.equal(check(res2.report, 'source').status, STATUS.ERROR)
  assert.ok(!fs.existsSync(candidateDir(fxA, 'rel-catfail')))
})

// ════════════════════════════════════════════════════════════════════════════
// I-03 — one policy controls precise strip / keep
// ════════════════════════════════════════════════════════════════════════════
test('I-03/policy strips exactly the D14 set plus the codex directories and keeps docs/v2.0/example.md', () => {
  const paths = new Set(manifestJson(fxA, RID).entries.map((e) => e.path))
  for (const p of STRIPPED_SAMPLES) assert.ok(!paths.has(p), `stripped: ${p}`)
  for (const p of KEPT_SAMPLES) assert.ok(paths.has(p), `kept: ${p}`)
  for (const p of REAL_POLICY.requiredTargets.files) assert.ok(paths.has(p), `required: ${p}`)
  assert.ok(!paths.has('AGENTS.md'))
  assert.ok(!paths.has('publish/sync-base.json'))
  const byRule = sourceJson(fxA, RID).candidate.strippedByRule
  assert.deepEqual(
    Object.keys(byRule).sort(),
    REAL_POLICY.stripPaths.map((r) => r.id).sort(),
    'every strip rule stripped at least one fixture path'
  )
  assert.equal(sourceJson(fxA, RID).candidate.strippedTotal, STRIPPED_SAMPLES.length + 6)
})

test('I-03/old ^docs/v\\d expression is not the rule: only literal policy paths strip', () => {
  assert.equal(classifyPath('docs/v2.0/example.md', REAL_POLICY).stripped, null)
  assert.equal(classifyPath('docs/v10/notes.md', REAL_POLICY).stripped, null)
  assert.equal(classifyPath('docs/v0.10/x.md', REAL_POLICY).stripped, null)
  assert.equal(classifyPath('docs/v1.0/x.md', REAL_POLICY).stripped.id, 'S-05')
  assert.equal(classifyPath('docs/v0.4/x.md', REAL_POLICY).stripped.id, 'S-04')
  assert.equal(classifyPath('docs/TODO.md', REAL_POLICY).stripped.id, 'S-06')
  assert.equal(classifyPath('docs/TODO.md.bak', REAL_POLICY).stripped, null)
  assert.equal(classifyPath('publish/docs/PRD.md', REAL_POLICY).stripped.id, 'S-11')
  assert.equal(classifyPath('.codex/hooks/x.mjs', REAL_POLICY).stripped.id, 'S-12')
  assert.equal(classifyPath('docs/codex/x.md', REAL_POLICY).stripped.id, 'S-13')
  assert.equal(classifyPath('AGENTS.md', REAL_POLICY).forbidden.id, 'F-01')
  assert.equal(classifyPath('node_modules/x/package.json', REAL_POLICY).forbidden.id, 'F-03')
  assert.equal(classifyPath('Docs/TODO.md', REAL_POLICY).caseVariantOf.id, 'S-06')
  assert.equal(REAL_POLICY.pathSemantics.noPatterns, true)
  for (const r of [...REAL_POLICY.stripPaths, ...REAL_POLICY.forbiddenCandidatePaths])
    assert.doesNotMatch(r.path, /[*?[\]{}]/, `${r.id} literal`)
})

test('I-03/candidate targets are overlaid with the reviewed public documents, never the internal originals', () => {
  const man = manifestJson(fxA, RID)
  for (const d of REAL_POLICY.publicDocuments.documents) {
    const entry = man.entries.find((e) => e.path === d.targetPath)
    assert.equal(entry.origin, `overlay:${d.publicPath}`)
    const bytes = fs.readFileSync(path.join(candidateDir(fxA, RID), ...d.targetPath.split('/')))
    assert.deepEqual(bytes, fxA.pub.get(d.publicPath))
    assert.notDeepEqual(bytes, TEXT(INTERNAL_SOURCES[d.sourcePath]))
  }
  const claude = fs.readFileSync(path.join(candidateDir(fxA, RID), 'CLAUDE.md'), 'utf8')
  assert.ok(!claude.includes('docs/v1.0/'))
  assert.equal(sourceJson(fxA, RID).publicDocuments.length, 5)
})

test('I-03/policy and registry hashes recorded in source.json match the frozen blobs', () => {
  const src = sourceJson(fxA, RID)
  assert.equal(src.policy.path, POLICY_PATH)
  assert.equal(src.policy.blob, fxA.rev(`${src.commit}:${POLICY_PATH}`))
  assert.equal(src.registry.path, 'publish/sync-base.json')
  assert.equal(src.registry.blob, fxA.rev(`${src.commit}:publish/sync-base.json`))
})

test('I-03/tracked AGENTS.md or dependency files are forbidden tracked input', async () => {
  const fx = createFixture('forbidden')
  fx.write('AGENTS.md', 'stale agents file\n')
  fx.write('node_modules/x/package.json', '{}\n')
  fx.git(['add', '-f', 'AGENTS.md', 'node_modules/x/package.json'])
  fx.commit('forbidden inputs')
  const res = await runCli(fx, ['prepare', '--release-id', 'forb'])
  assert.equal(res.code, EXIT.VIOLATION)
  const s = sub(res.report, 'source', 'forbidden-tracked-input')
  assert.equal(s.status, STATUS.FAIL)
  const items = s.detail.items.map((i) => `${i.rule}:${i.path}`).sort()
  assert.deepEqual(items, ['F-01:AGENTS.md', 'F-03:node_modules/x/package.json'])
  assert.ok(!fs.existsSync(candidateDir(fx, 'forb')))
})

test('I-03/missing required target or short required directory blocks preparation', async () => {
  const fx = createFixture('required')
  fx.git(['rm', '-q', 'README.md', 'tests/helpers/h.ts'])
  fx.commit('drop required')
  const res = await runCli(fx, ['prepare', '--release-id', 'req'])
  assert.equal(res.code, EXIT.VIOLATION)
  const s = sub(res.report, 'source', 'required-targets')
  const missing = s.detail.items.find((i) => i.reasonCode === 'REQUIRED_TARGET_MISSING')
  assert.deepEqual(missing.files, ['README.md'])
  const short = s.detail.items.find((i) => i.reasonCode === 'REQUIRED_DIRECTORY_SHORT')
  assert.equal(short.directory, 'tests/helpers/')
  assert.ok(!fs.existsSync(candidateDir(fx, 'req')))
})

test('I-03/licence materials must match the provenance registry byte for byte', async () => {
  const fx = createFixture('provenance')
  fx.write('resources/bin/ffmpeg-LICENSE.txt', 'altered licence text\n')
  fx.commit('alter licence bytes')
  const res = await runCli(fx, ['prepare', '--release-id', 'prov'])
  assert.equal(res.code, EXIT.VIOLATION)
  const item = sub(res.report, 'source', 'required-targets').detail.items.find(
    (i) => i.reasonCode === 'PROVENANCE_MATERIAL_MISMATCH'
  )
  assert.deepEqual(item.materials, [
    { path: 'resources/bin/ffmpeg-LICENSE.txt', reason: 'sha256-mismatch' }
  ])
})

test('I-03/policy validation rejects patterns, duplicates, bad kinds, bad roots and missing sections', () => {
  assert.deepEqual(validatePolicy(REAL_POLICY), [])
  const clone = () => JSON.parse(REAL_POLICY_BUF.toString('utf8'))
  let p = clone()
  p.stripPaths.push({ id: 'S-99', kind: 'directory', path: 'docs/v*/' })
  assert.ok(validatePolicy(p).some((e) => e.startsWith('stripPaths-path-not-literal:S-99')))
  p = clone()
  p.stripPaths.push({ id: 'S-01', kind: 'file', path: 'x.md' })
  assert.ok(validatePolicy(p).includes('stripPaths-bad-or-duplicate-id'))
  p = clone()
  p.forbiddenCandidatePaths.push({ id: 'F-99', kind: 'glob', path: 'x.md' })
  assert.ok(validatePolicy(p).includes('forbiddenCandidatePaths-bad-kind:F-99'))
  p = clone()
  delete p.checks
  assert.ok(validatePolicy(p).includes('missing:checks'))
  p = clone()
  p.schemaVersion = 2
  assert.ok(validatePolicy(p).includes('schemaVersion-not-1'))
  p = clone()
  p.controlledRoot = 'D:/anywhere/'
  assert.ok(validatePolicy(p).includes('controlledRoot-invalid'))
  p = clone()
  p.admissionLabels.prepare = 'push-admissible'
  assert.ok(validatePolicy(p).includes('admissionLabels-invalid'))
  p = clone()
  p.checks[0].stages['pre-push'] = 'optional'
  assert.ok(validatePolicy(p).some((e) => e.startsWith('checks-stage-value-invalid:source')))
})

test('I-03/policy in the frozen commit must equal the working tree and be valid', async () => {
  const fx = createFixture('policy-frozen')
  const policyAbs = fx.abs(POLICY_PATH)
  const original = fs.readFileSync(policyAbs)
  fs.writeFileSync(policyAbs, Buffer.concat([original, TEXT('\n')]))
  const differs = await runCli(fx, ['prepare', '--release-id', 'pol-1'])
  assert.equal(differs.code, EXIT.VIOLATION)
  assert.equal(sub(differs.report, 'source', 'policy-frozen').reasonCode, 'POLICY_WORKTREE_DIFFERS')
  fs.writeFileSync(policyAbs, original)
  const broken = JSON.parse(original.toString('utf8'))
  broken.stripPaths.push({ id: 'S-99', kind: 'directory', path: 'docs/v*/' })
  fs.writeFileSync(policyAbs, JSON.stringify(broken, null, 2) + '\n')
  fx.commit('commit invalid policy')
  fs.writeFileSync(policyAbs, original)
  const invalidCommitted = await runCli(fx, ['prepare', '--release-id', 'pol-2'])
  assert.equal(invalidCommitted.code, EXIT.VIOLATION)
  assert.equal(sub(invalidCommitted.report, 'source', 'policy-frozen').reasonCode, 'POLICY_INVALID')
  assert.equal(
    sub(invalidCommitted.report, 'source', 'registry-frozen').reasonCode,
    'POLICY_UNAVAILABLE'
  )
  fs.writeFileSync(policyAbs, JSON.stringify(broken, null, 2) + '\n')
  const bothInvalid = await runCli(fx, ['prepare', '--release-id', 'pol-3'])
  assert.equal(bothInvalid.code, EXIT.EXECUTION)
  assert.ok(bothInvalid.err.some((l) => l.includes('POLICY_INVALID')))
  assert.ok(!fs.existsSync(fx.releaseDir('pol-3')))
  fs.writeFileSync(policyAbs, TEXT('{ not json'))
  const unparseable = await runCli(fx, ['prepare', '--release-id', 'pol-4'])
  assert.equal(unparseable.code, EXIT.EXECUTION)
  assert.ok(unparseable.err.some((l) => l.includes('POLICY_PARSE')))
})

// ════════════════════════════════════════════════════════════════════════════
// I-04 — internal markers are precise; exemptions are position-scoped
// ════════════════════════════════════════════════════════════════════════════
test('I-04/policy markers are precise paths, segments or tokens, never ordinary words', () => {
  const kinds = new Set(['path-prefix', 'path', 'path-segment', 'token'])
  const ordinary = new Set(['Task', 'plan', 'spec', 'review', 'task', 'Plan', 'Spec', 'Review'])
  for (const m of REAL_POLICY.internalMarkers.markers) {
    assert.ok(kinds.has(m.kind), `${m.id} kind`)
    assert.ok(!ordinary.has(m.value), `${m.id} is not an ordinary word`)
    assert.ok(
      m.value.includes('/') || m.value.includes('.'),
      `${m.id} is path-like or a slash token`
    )
    if (m.kind === 'path-prefix') assert.ok(m.value.endsWith('/'), `${m.id} prefix ends with /`)
  }
  const ids = REAL_POLICY.internalMarkers.markers.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
  const values = new Set(REAL_POLICY.internalMarkers.markers.map((m) => m.value))
  for (const r of REAL_POLICY.stripPaths)
    assert.ok(values.has(r.path), `strip rule ${r.id} has a marker`)
})

test('I-04/literal exemptions are bound to declared positions, never a whole file or directory', () => {
  const positions = REAL_POLICY.internalMarkers.allowedLiteralPositions
  assert.ok(positions.length >= 1)
  const kinds = new Set(Object.keys(REAL_POLICY.internalMarkers.positionKinds))
  const markerIds = new Set(REAL_POLICY.internalMarkers.markers.map((m) => m.id))
  for (const p of positions) {
    assert.equal(typeof p.file, 'string')
    assert.ok(!p.file.endsWith('/'), 'files only, no directories')
    assert.ok(Array.isArray(p.positions) && p.positions.length > 0, `${p.file} position kinds`)
    for (const k of p.positions) assert.ok(kinds.has(k), `${p.file}: unknown position kind ${k}`)
    assert.ok(Array.isArray(p.markers) && p.markers.length > 0, `${p.file} markers`)
    for (const m of p.markers) assert.ok(m === '*' || markerIds.has(m), `${p.file}: marker ${m}`)
    if (p.positions.includes('json-pointer'))
      assert.ok(
        p.jsonPointerPrefixes.every((x) => x.startsWith('/')),
        `${p.file} pointers`
      )
    if (p.positions.includes('prose-term'))
      assert.ok(Number.isInteger(p.maxOccurrences) && p.maxOccurrences <= 3 && p.section)
    assert.ok(!('wholeFile' in p))
  }
  assert.deepEqual(validateLiteralPositions(positions), [])
  // the schema itself refuses whole-file / directory / unknown-kind declarations
  assert.ok(
    validateLiteralPositions([{ file: 'src/', positions: ['code-comment'], markers: ['M-06'] }])
      .length
  )
  assert.ok(
    validateLiteralPositions([{ file: 'a.ts', positions: ['whole-file'], markers: ['M-06'] }])
      .length
  )
  assert.ok(
    validateLiteralPositions([{ file: 'a.ts', positions: ['code-comment'], markers: [] }]).length
  )
  assert.match(
    REAL_POLICY.internalMarkers.exemptionRule,
    /no directory, file or rule-wide exemption/
  )
  assert.match(REAL_POLICY.internalMarkers.exemptionRule, /secrets rules are never exempted/)
})

test('I-04/the five committed public overlays carry no internal marker except the documented publish/ term', () => {
  const hits = []
  for (const d of REAL_POLICY.publicDocuments.documents) {
    const text = fs.readFileSync(path.join(REPO_ROOT, ...d.publicPath.split('/')), 'utf8')
    for (const m of REAL_POLICY.internalMarkers.markers) {
      const n = text.split(m.value).length - 1
      if (n) hits.push({ file: d.publicPath, marker: m.id, value: m.value, n })
    }
  }
  const unexpected = hits.filter((h) => !(h.marker === 'M-11' && h.file === 'publish/CONTEXT.md'))
  assert.deepEqual(unexpected, [], 'public overlays are marker-free')
  // positive control: the internal originals of the same five documents do contain markers
  let controlHits = 0
  for (const d of REAL_POLICY.publicDocuments.documents) {
    const text = fs.readFileSync(path.join(REPO_ROOT, ...d.sourcePath.split('/')), 'utf8')
    for (const m of REAL_POLICY.internalMarkers.markers)
      controlHits += text.split(m.value).length - 1
  }
  assert.ok(controlHits > 0, 'positive control: internal sources contain markers')
})

// ════════════════════════════════════════════════════════════════════════════
// I-05 — sync drift by content, not by commit count
// ════════════════════════════════════════════════════════════════════════════
test('I-05/normal-unrelated-code-commit', async () => {
  // fxA already carries the unrelated "code change" commit made in the SOURCE_MOVED case.
  assert.notEqual(fxA.head, fxA.rev('HEAD~1'))
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-after-code'])
  assert.equal(res.code, EXIT.ADMITTED, res.err.join('\n'))
  assert.equal(check(res.report, 'sync').status, STATUS.PASS)
  for (const doc of check(res.report, 'sync').documents) {
    assert.equal(doc.status, 'PASS', doc.sourcePath)
    assert.equal(doc.sourceBlobAtBase, doc.sourceBlobAtCommit)
  }
  assert.ok(!res.reportText.includes('SYNC_DRIFT'))
})

test('I-05/fail-one-internal-source-changed', async () => {
  const marker = 'SECRET-MARKER-PRD-7f3a'
  fxA.write('docs/PRD.md', `# PRD (internal)\n\nchanged ${marker}\n`)
  fxA.commit('prd change')
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-drift'])
  assert.equal(res.code, EXIT.VIOLATION)
  const s = sub(res.report, 'sync', 'source-blob-unchanged-vs-base')
  assert.equal(s.reasonCode, 'SYNC_DRIFT')
  assert.equal(s.detail.drift.length, 1)
  assert.equal(s.detail.drift[0].path, 'docs/PRD.md')
  assert.equal(typeof s.detail.drift[0].firstDifferingLine, 'number')
  assert.equal(typeof s.detail.drift[0].frozenBytes, 'number')
  assert.ok(!res.reportText.includes(marker), 'diff content is not printed')
  const docs = check(res.report, 'sync').documents
  assert.deepEqual(
    docs.filter((d) => d.status === 'FAIL').map((d) => d.sourcePath),
    ['docs/PRD.md']
  )
  assert.equal(docs.filter((d) => d.status === 'PASS').length, 4)
  assert.equal(
    sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
    'NOT_BUILT_PRECONDITION_FAILED'
  )
  assert.ok(!fs.existsSync(candidateDir(fxA, 'rel-drift')))
})

test('I-05/fail-uncommitted-source-change', async () => {
  fxA.write('CONTEXT.md', INTERNAL_SOURCES['CONTEXT.md'] + '\nuncommitted edit\n')
  try {
    const res = await runCli(fxA, ['prepare', '--release-id', 'rel-uncommitted'])
    assert.equal(res.code, EXIT.VIOLATION)
    const s = sub(res.report, 'sync', 'working-tree-source-unchanged')
    assert.equal(s.reasonCode, 'SYNC_DRIFT_UNCOMMITTED')
    assert.deepEqual(s.detail.paths, ['CONTEXT.md'])
    assert.equal(sub(res.report, 'source', 'clean-worktree').reasonCode, 'WORKTREE_DIRTY')
  } finally {
    fxA.git(['checkout', '-q', '--', 'CONTEXT.md'])
  }
})

test('I-05/base commit that does not exist is PENDING, never PASS', async () => {
  const fx = createFixture('base-missing', {
    registry: (base, pub, reg) => ({
      ...reg,
      documents: reg.documents.map((d) => ({
        ...d,
        baseCommit: '0123456789abcdef0123456789abcdef01234567'
      }))
    })
  })
  const res = await runCli(fx, ['prepare', '--release-id', 'nobase'])
  assert.equal(res.code, EXIT.INCOMPLETE)
  assert.equal(sub(res.report, 'sync', 'base-commit-resolvable').status, STATUS.PENDING)
  assert.equal(
    sub(res.report, 'sync', 'base-commit-resolvable').reasonCode,
    'BASE_COMMIT_UNRESOLVABLE'
  )
  assert.equal(sub(res.report, 'sync', 'source-blob-unchanged-vs-base').status, STATUS.PENDING)
  assert.ok(!fs.existsSync(candidateDir(fx, 'nobase')))
})

// ════════════════════════════════════════════════════════════════════════════
// I-06 — public hash and sync baseline change only by human review
// ════════════════════════════════════════════════════════════════════════════
test('I-06/fail-public-hash-mismatch', async () => {
  // restore PRD to the base content so this case isolates the public hash; registry stays as committed
  fxA.write('docs/PRD.md', INTERNAL_SOURCES['docs/PRD.md'])
  fxA.write('publish/CLAUDE.md', PUBLIC_SOURCES['publish/CLAUDE.md'] + '!')
  fxA.commit('restore prd, edit public claude one byte')
  const registryBefore = fxA.read('publish/sync-base.json')
  const publicBefore = fxA.read('publish/CLAUDE.md')
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-hash'])
  assert.equal(res.code, EXIT.VIOLATION)
  assert.equal(
    sub(res.report, 'sync', 'source-blob-unchanged-vs-base').status,
    STATUS.PASS,
    'no drift after restore'
  )
  const s = sub(res.report, 'sync', 'public-hash-matches')
  assert.equal(s.reasonCode, 'PUBLIC_HASH_MISMATCH')
  assert.deepEqual(
    s.detail.mismatches.map((m) => m.path),
    ['publish/CLAUDE.md']
  )
  assert.equal(s.detail.mismatches[0].actual, sha256(publicBefore))
  assert.deepEqual(fxA.read('publish/sync-base.json'), registryBefore, 'registry bytes unchanged')
  assert.deepEqual(fxA.read('publish/CLAUDE.md'), publicBefore, 'public bytes unchanged')
  assert.ok(!fs.existsSync(candidateDir(fxA, 'rel-hash')))
})

test('I-06/uncommitted public file change fails and is never written back', async () => {
  const before = fxA.read('publish/docs/PRD.md')
  fxA.write('publish/docs/PRD.md', before.toString('utf8') + 'private edit\n')
  try {
    const res = await runCli(fxA, ['prepare', '--release-id', 'rel-pubwt'])
    assert.equal(res.code, EXIT.VIOLATION)
    const doc = check(res.report, 'sync').documents.find(
      (d) => d.publicPath === 'publish/docs/PRD.md'
    )
    assert.ok(doc.reasonCodes.includes('PUBLIC_FILE_UNCOMMITTED_CHANGE'))
    assert.ok(
      fxA.read('publish/docs/PRD.md').toString('utf8').endsWith('private edit\n'),
      'not reverted by the tool'
    )
  } finally {
    fxA.git(['checkout', '-q', '--', 'publish/docs/PRD.md'])
  }
})

test('I-06/fail-registry-agents', async () => {
  const fx = createFixture('registry-agents', {
    registry: (base, pub, reg) => ({
      ...reg,
      documents: reg.documents.map((d) =>
        d.targetPath === 'CLAUDE.md' ? { ...d, targetPath: 'AGENTS.md' } : d
      )
    })
  })
  const unit = validateRegistry(fx.registry, REAL_POLICY)
  assert.ok(unit.includes('row0-target-forbidden:AGENTS.md'), unit.join(','))
  const res = await runCli(fx, ['prepare', '--release-id', 'agents'])
  assert.equal(res.code, EXIT.VIOLATION)
  assert.equal(sub(res.report, 'sync', 'registry-shape').reasonCode, 'REGISTRY_INVALID')
  assert.ok(
    sub(res.report, 'sync', 'registry-shape').detail.errors.includes(
      'row0-target-forbidden:AGENTS.md'
    )
  )
  assert.ok(!fs.existsSync(candidateDir(fx, 'agents')))
})

test('I-06/fail-registry-head-or-short-oid', () => {
  const reg = registryFor(fxA.base, fxA.pub)
  reg.documents[0].baseCommit = 'HEAD'
  reg.documents[1].baseCommit = fxA.base.slice(0, 7)
  const errors = validateRegistry(reg, REAL_POLICY)
  assert.ok(errors.includes('row0-baseCommit-not-full-oid:HEAD'))
  assert.ok(errors.includes(`row1-baseCommit-not-full-oid:${fxA.base.slice(0, 7)}`))
  assert.equal(errors.length, 2)
})

test('I-06/fail-registry-missing-row-or-duplicate-target', () => {
  const four = registryFor(fxA.base, fxA.pub)
  four.documents.pop()
  const e1 = validateRegistry(four, REAL_POLICY)
  assert.ok(e1.includes('documents-count:4!=5'))
  assert.ok(e1.includes('policy-document-missing-in-registry:CONTEXT.md'))
  const dup = registryFor(fxA.base, fxA.pub)
  dup.documents[4] = { ...dup.documents[0] }
  const e2 = validateRegistry(dup, REAL_POLICY)
  assert.ok(e2.some((e) => e.startsWith('row4-sourcePath-duplicate')))
  assert.ok(e2.some((e) => e.startsWith('row4-targetPath-duplicate')))
})

test('I-06/registry paths must be repository-relative POSIX and rows exactly the five keys', () => {
  const reg = registryFor(fxA.base, fxA.pub)
  reg.documents[0].sourcePath = 'D:/Software/CLAUDE.md'
  reg.documents[1].publicPath = 'publish\\docs\\PRD.md'
  reg.documents[2].reviewedBy = 'someone'
  reg.documents[3].publicSha256 = 'abc'
  const errors = validateRegistry(reg, REAL_POLICY)
  assert.ok(errors.some((e) => e.startsWith('row0-sourcePath-invalid:drive-letter')))
  assert.ok(errors.some((e) => e.startsWith('row1-publicPath-invalid:backslash')))
  assert.ok(errors.some((e) => e.startsWith('row2-keys:')))
  assert.ok(errors.includes('row3-publicSha256-invalid'))
  assert.ok(
    validateRegistry({ schemaVersion: 2, documents: [] }, REAL_POLICY).includes(
      'schemaVersion-mismatch'
    )
  )
  assert.deepEqual(validateRegistry(registryFor(fxA.base, fxA.pub), REAL_POLICY), [])
})

test('I-06/fail-script-auto-refreshes-registry', async () => {
  const fx = createFixture('no-autofix', {
    registry: (base, pub, reg) => ({
      ...reg,
      documents: reg.documents.map((d) => ({ ...d, publicSha256: '0'.repeat(64) }))
    })
  })
  const before = snapshotInternal(fx)
  const prep = await runCli(fx, ['prepare', '--release-id', 'autofix'])
  assert.equal(prep.code, EXIT.VIOLATION)
  assert.equal(sub(prep.report, 'sync', 'public-hash-matches').reasonCode, 'PUBLIC_HASH_MISMATCH')
  const chk = await runCli(fx, ['check', '--release-id', 'autofix', '--stage', 'pre-push'])
  // unprepared candidate (UNCHECKED -> 2) plus broken registry (FAIL -> 1): 1 wins by the 3 -> 1 -> 2 rule
  assert.equal(chk.code, EXIT.VIOLATION)
  assert.equal(sub(chk.report, 'sync', 'public-hash-matches').reasonCode, 'PUBLIC_HASH_MISMATCH')
  assert.equal(
    sub(chk.report, 'source', 'candidate-matches-expected').reasonCode,
    'CANDIDATE_NOT_PREPARED'
  )
  assert.equal(chk.report.admission, null)
  assertSameSnapshot(before, snapshotInternal(fx), 'registry and public files after failing runs')
  assert.equal(fx.git(['status', '--porcelain']).stdout, '')
})

// ════════════════════════════════════════════════════════════════════════════
// I-12 — report completeness and exit-code semantics
// ════════════════════════════════════════════════════════════════════════════
test('I-12/prepare report lists every catalogue item with id, rule, status, source, hashes, command, exit, location and evidence', () => {
  const rep = happy.report
  assert.equal(rep.checks.length, REAL_POLICY.checks.length)
  assert.deepEqual(rep.requiredChecks, ['source', 'sync'])
  for (const c of rep.checks) {
    for (const k of [
      'id',
      'stageRule',
      'status',
      'subchecks',
      'command',
      'exitCode',
      'location',
      'evidence',
      'source',
      'candidateDigest'
    ])
      assert.ok(k in c, `${c.id}.${k}`)
    const def = REAL_POLICY.checks.find((d) => d.id === c.id)
    assert.deepEqual(
      c.subchecks.map((s) => s.id).slice(0, def.subchecks.length),
      def.subchecks,
      `${c.id} subchecks complete`
    )
  }
  const na = rep.checks.filter((c) => c.status === STATUS.NOT_APPLICABLE)
  assert.equal(na.length, REAL_POLICY.checks.length - 2)
  assert.ok(na.every((c) => c.reasonCode === 'NOT_PART_OF_PREPARE'))
  assert.equal(rep.counts.PASS, 2)
  assert.equal(rep.exitCode, 0)
  assert.match(rep.admissionNote, /no stage checks are implied/)
})

// A clean fixture whose candidate stays valid for the stage-level cases (fxA has moved on by now).
const fxS = createFixture('stages')
const SID = 'stage-1'

test('I-12/pre-push on a prepared candidate without operator evidence is not push-admissible: candidate checks pass, evidence checks are pending', async () => {
  const prep = await runCli(fxS, ['prepare', '--release-id', SID])
  assert.equal(prep.code, EXIT.ADMITTED, prep.err.join(' | '))
  const res = await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-push'])
  assert.equal(
    res.code,
    EXIT.INCOMPLETE,
    JSON.stringify(
      res.report.checks
        .filter((c) => c.status === STATUS.FAIL || c.status === STATUS.ERROR)
        .map((c) => c.subchecks)
    )
  )
  assert.equal(res.report.admission, null)
  assert.ok(!res.out.some((l) => l.includes('push-admissible')))
  assert.equal(check(res.report, 'source').status, STATUS.PASS)
  assert.equal(check(res.report, 'sync').status, STATUS.PASS)
  assert.equal(check(res.report, 'public-history').status, STATUS.PENDING)
  assert.equal(
    sub(res.report, 'public-history', 'baseline-present').reasonCode,
    'PUBLIC_REPO_NOT_PROVIDED'
  )
  // every owner-6b item now carries a real result; none is left at NO_RESULT
  const owner6b = REAL_POLICY.checks
    .filter((c) => c.owner === '6b' && c.stages['pre-push'] === 'required')
    .map((c) => c.id)
  for (const id of owner6b) assert.notEqual(check(res.report, id).reasonCode, 'NO_RESULT', id)
  for (const id of [
    'candidate-boundary',
    'internal-markers',
    'candidate-secrets',
    'local-links',
    'metadata-contract',
    'license-materials'
  ])
    assert.equal(
      check(res.report, id).status,
      STATUS.PASS,
      `${id}: ${JSON.stringify(check(res.report, id).subchecks)}`
    )
  assert.equal(check(res.report, 'public-metadata').status, STATUS.PENDING)
  assert.equal(check(res.report, 'internal-gate').status, STATUS.PENDING)
  assert.equal(check(res.report, 'manual-checks').status, STATUS.PENDING)
  assert.equal(check(res.report, 'validation-delta').status, STATUS.UNCHECKED)
  assert.equal(check(res.report, 'external-links').status, STATUS.UNCHECKED)
  assert.equal(
    sub(res.report, 'external-links', 'per-url-result').reasonCode,
    'EXTERNAL_EVIDENCE_MISSING'
  )
  const deferred = res.report.checks.filter((c) => c.status === STATUS.NOT_APPLICABLE)
  assert.ok(deferred.every((c) => c.reasonCode === 'DEFERRED_TO_PRE_RELEASE'))
  assert.equal(deferred.length, 5)
  // evidence files of this run are written once, redacted and bound to the candidate digest
  const evDir = path.join(fxS.releaseDir(SID), 'evidence')
  const written = fs.readdirSync(evDir).filter((n) => n.includes(res.report.runId))
  assert.ok(written.length >= 7, written.join(','))
  for (const n of written) {
    const text = fs.readFileSync(path.join(evDir, n), 'utf8')
    assert.ok(!text.includes(fxS.root.split(path.sep).join('/')), `${n} leaks the fixture root`)
    assert.equal(JSON.parse(text).candidateDigest, sourceJson(fxS, SID).candidate.digest)
  }
})

test('I-12/pre-release additionally requires the post-push items and stays unchecked without them', async () => {
  const res = await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-release'])
  assert.equal(res.code, EXIT.INCOMPLETE)
  assert.equal(res.report.admission, null)
  assert.equal(res.report.checks.filter((c) => c.status === STATUS.NOT_APPLICABLE).length, 0)
  for (const id of [
    'public-ci',
    'artifact-origin',
    'package-materials',
    'security-channel',
    'task6-acceptance'
  ])
    assert.equal(check(res.report, id).status, STATUS.UNCHECKED, id)
  assert.ok(res.report.requiredChecks.includes('artifact-origin'))
})

const ctx = {
  releaseId: 'unit',
  runId: '20260919T000000000Z',
  generatedAt: '2026-09-19T00:00:00.000Z',
  tool: null
}
const passing = (id) => ({
  subchecks: REAL_POLICY.checks
    .find((c) => c.id === id)
    .subchecks.map((s) => ({ id: s, status: 'PASS', reasonCode: null, detail: null }))
})
const fullPass = (stage) => {
  const results = new Map()
  for (const c of REAL_POLICY.checks)
    if (stage === 'prepare' ? c.prepare : c.stages[stage] === 'required')
      results.set(c.id, passing(c.id))
  return results
}

test('I-12/a complete passing result set admits each stage with its own label only', () => {
  for (const [stage, label] of [
    ['prepare', 'candidate-prepared'],
    ['pre-push', 'push-admissible'],
    ['pre-release', 'release-admissible']
  ]) {
    const rep = buildStageReport({
      policy: REAL_POLICY,
      stage,
      results: fullPass(stage),
      context: ctx
    })
    assert.equal(rep.exitCode, 0, stage)
    assert.equal(rep.admission, label)
  }
})

test('I-12/missing check or subcheck is UNCHECKED and exit 2, never a silent pass', () => {
  const results = fullPass('pre-push')
  results.delete('sync')
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(rep.exitCode, 2)
  assert.equal(check(rep, 'sync').status, STATUS.UNCHECKED)
  assert.equal(check(rep, 'sync').reasonCode, 'NO_RESULT')
  const results2 = fullPass('pre-push')
  results2.get('source').subchecks.pop()
  const rep2 = buildStageReport({
    policy: REAL_POLICY,
    stage: 'pre-push',
    results: results2,
    context: ctx
  })
  assert.equal(rep2.exitCode, 2)
  assert.equal(sub(rep2, 'source', 'source-reverified').reasonCode, 'SUBCHECK_MISSING')
})

test('I-12/an empty passed:true result never counts as PASS', () => {
  const results = fullPass('pre-push')
  results.set('source', { passed: true, subchecks: [] })
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(check(rep, 'source').status, STATUS.UNCHECKED)
  assert.equal(rep.exitCode, 2)
})

test('I-12/operator NOT_APPLICABLE on a required check is rejected with exit 1', () => {
  const results = fullPass('pre-push')
  results.set('sync', {
    subchecks: REAL_POLICY.checks
      .find((c) => c.id === 'sync')
      .subchecks.map((s) => ({ id: s, status: 'NOT_APPLICABLE' }))
  })
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(check(rep, 'sync').status, STATUS.FAIL)
  assert.equal(check(rep, 'sync').reasonCode, 'OPERATOR_NOT_APPLICABLE_REJECTED')
  assert.equal(rep.exitCode, 1)
  const results2 = fullPass('pre-push')
  results2.set('sync', { ...passing('sync'), operatorNotApplicable: true })
  const rep2 = buildStageReport({
    policy: REAL_POLICY,
    stage: 'pre-push',
    results: results2,
    context: ctx
  })
  assert.equal(check(rep2, 'sync').status, STATUS.FAIL)
  assert.equal(rep2.exitCode, 1)
})

test('I-12/mixed outcomes keep every entry and aggregate 3 over 1 over 2', () => {
  assert.equal(aggregateExit([2, 1, 3]), 3)
  assert.equal(aggregateExit([2, 1]), 1)
  assert.equal(aggregateExit([0, 2]), 2)
  assert.equal(aggregateExit([0, 0]), 0)
  const results = fullPass('pre-push')
  results.get('sync').subchecks[0].status = 'FAIL'
  results.get('local-links').subchecks[0].status = 'ERROR'
  results.delete('manual-checks')
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(rep.exitCode, 3)
  assert.equal(check(rep, 'sync').status, STATUS.FAIL)
  assert.equal(check(rep, 'local-links').status, STATUS.ERROR)
  assert.equal(check(rep, 'manual-checks').status, STATUS.UNCHECKED)
  assert.equal(rep.counts.FAIL, 1)
  assert.equal(rep.counts.ERROR, 1)
  assert.equal(rep.counts.UNCHECKED, 1)
  assert.equal(rep.checks.length, REAL_POLICY.checks.length)
})

test('I-12/duplicate subcheck ids keep the most severe status', () => {
  const results = fullPass('pre-push')
  results
    .get('source')
    .subchecks.push({ id: 'candidate-matches-expected', status: 'FAIL', reasonCode: 'X' })
  results
    .get('source')
    .subchecks.push({ id: 'candidate-matches-expected', status: 'UNCHECKED', reasonCode: 'Y' })
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(sub(rep, 'source', 'candidate-matches-expected').status, STATUS.FAIL)
  assert.equal(rep.exitCode, 1)
})

test('I-12/DEFERRED_PUSH_LINK admits only at pre-push and PENDING never admits', () => {
  assert.equal(exitForStatus('DEFERRED_PUSH_LINK', 'pre-push'), 0)
  assert.equal(exitForStatus('DEFERRED_PUSH_LINK', 'pre-release'), 2)
  assert.equal(exitForStatus('PENDING', 'pre-push'), 2)
  assert.equal(exitForStatus('UNCHECKED', 'pre-push'), 2)
  assert.equal(exitForStatus('FAIL', 'pre-push'), 1)
  assert.equal(exitForStatus('ERROR', 'pre-push'), 3)
  assert.equal(exitForStatus('bogus', 'pre-push'), 3)
})

test('I-12/invalid status or unknown check id is ERROR and exit 3', () => {
  const results = fullPass('pre-push')
  results.get('sync').subchecks[0].status = 'OK'
  const rep = buildStageReport({ policy: REAL_POLICY, stage: 'pre-push', results, context: ctx })
  assert.equal(sub(rep, 'sync', 'registry-shape').status, STATUS.ERROR)
  assert.equal(sub(rep, 'sync', 'registry-shape').reasonCode, 'INVALID_STATUS')
  assert.equal(rep.exitCode, 3)
  const results2 = fullPass('pre-push')
  results2.set('bogus-check', passing('sync'))
  const rep2 = buildStageReport({
    policy: REAL_POLICY,
    stage: 'pre-push',
    results: results2,
    context: ctx
  })
  assert.equal(check(rep2, 'bogus-check').reasonCode, 'UNKNOWN_CHECK_ID')
  assert.equal(rep2.exitCode, 3)
})

test('I-12/unknown operation, argument, stage, --force or missing release id exit 2 from the real process', () => {
  const cli = path.join(REPO_ROOT, 'scripts', 'release.mjs')
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: fxA.root,
      encoding: 'utf8',
      windowsHide: true
    })
  for (const args of [
    ['bogus'],
    ['prepare'],
    ['prepare', '--release-id', 'x', '--force'],
    ['prepare', '--release-id', 'x', '--stage', 'pre-push'],
    ['check', '--release-id', 'x'],
    ['check', '--release-id', 'x', '--stage', 'nope'],
    ['check', '--release-id', 'x', '--stage', 'pre-push', '--public-repo'],
    ['check', '--release-id', 'x', '--release-id', 'y', '--stage', 'pre-push']
  ]) {
    const res = run(args)
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`)
    assert.match(res.stderr, /^release: /)
    assert.ok(res.stderr.includes('usage:'))
  }
  assert.deepEqual(parseArgs(['check', '--release-id=abc', '--stage=pre-release']), {
    op: 'check',
    releaseId: 'abc',
    stage: 'pre-release',
    publicRepo: null
  })
})

test('I-12/report write failure is an execution error and no admission marker is printed', async () => {
  const id = 'rel-noreport'
  fs.mkdirSync(fxA.releaseDir(id), { recursive: true })
  fs.writeFileSync(path.join(fxA.releaseDir(id), 'reports'), 'not a directory')
  const out = []
  const err = []
  const code = await main(['prepare', '--release-id', id], {
    cwd: fxA.root,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: nextClock()
  })
  assert.equal(code, EXIT.EXECUTION)
  assert.ok(
    err.some(
      (l) => l.includes('REPORT_WRITE_FAILED') || l.includes('EEXIST') || l.includes('ENOTDIR')
    ),
    err.join('\n')
  )
  assert.ok(!out.includes('candidate-prepared'))
})

test('I-12/reports are append-only: the same run id is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-report-'))
  TEMP_DIRS.push(dir)
  const report = buildStageReport({
    policy: REAL_POLICY,
    stage: 'prepare',
    results: fullPass('prepare'),
    context: ctx
  })
  const first = writeReport({ reportsDir: dir, report })
  assert.ok(fs.existsSync(first.jsonPath))
  assert.ok(fs.existsSync(first.mdPath))
  assert.throws(
    () => writeReport({ reportsDir: dir, report }),
    (e) => e.code === 'REPORT_WRITE_FAILED'
  )
  assert.equal(runId(new Date(Date.UTC(2026, 8, 19, 1, 2, 3, 4))), '20260919T010203004Z')
})

test('I-12/redaction hides machine paths, ipv6 and secret-like keys but keeps urls and roles', () => {
  const roles = { 'D:\\Software\\repo': '<internal-root>', 'D:/Software/repo': '<internal-root>' }
  assert.equal(
    redact('at D:\\Software\\repo\\x.md and D:/Software/repo/y', roles),
    'at <internal-root>\\x.md and <internal-root>/y'
  )
  assert.equal(
    redact('see https://github.com/lie-dream/DownLord ok'),
    'see https://github.com/lie-dream/DownLord ok'
  )
  assert.equal(redact('C:\\Users\\me\\p and \\\\srv\\share\\f'), '<absolute-path> and <unc-path>')
  assert.equal(redact('addr 2001:db8:1:2:3:4:5:6 end'), 'addr <ipv6-redacted> end')
  const v = redactValue({ token: 'abc', nested: { cookie: 'x', path: 'E:/tmp/z' }, list: ['C:/a'] })
  assert.deepEqual(v, {
    token: '<redacted>',
    nested: { cookie: '<redacted>', path: '<absolute-path>' },
    list: ['<absolute-path>']
  })
})

// ════════════════════════════════════════════════════════════════════════════
// I-16 — the entry only builds trees and checks; no repair, no write capability
// ════════════════════════════════════════════════════════════════════════════
test('I-16/every git call observed during prepare and check is a whitelisted read-only query with array arguments', async () => {
  const runs = [
    happy.recorder,
    (await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-push'])).recorder
  ]
  const forbidden = new Set([
    'commit',
    'push',
    'tag',
    'checkout',
    'add',
    'rm',
    'reset',
    'worktree',
    'clone',
    'init',
    'fetch',
    'pull',
    'merge',
    'rebase',
    'branch',
    'update-ref',
    'update-index',
    'stash',
    'gc',
    'prune'
  ])
  for (const rec of runs) {
    assert.ok(rec.length > 5, 'git was actually consulted')
    for (const call of rec) {
      assert.equal(call.program, 'git')
      assert.ok(Array.isArray(call.args))
      assert.ok(READ_ONLY_GIT_SUBCOMMANDS.includes(call.args[0]), call.args.join(' '))
      assert.ok(!forbidden.has(call.args[0]))
      for (const a of call.args)
        assert.ok(
          !['-w', '--write', '-f', '--force', '-d', '--delete'].includes(a),
          call.args.join(' ')
        )
      assert.equal(call.cwdRole, '<internal-root>')
    }
    assert.ok(!rec.some((c) => c.program === 'npm'))
  }
})

test('I-16/adapter refuses write subcommands, write flags and shell strings before spawning', () => {
  const spy = []
  const git = createGitAdapter({
    cwd: fxA.root,
    role: '<internal-root>',
    spawnImpl: (...a) => (spy.push(a), { status: 0, stdout: '', stderr: '' })
  })
  for (const args of [
    ['commit', '-m', 'x'],
    ['push'],
    ['tag', 'v1'],
    ['checkout', 'main'],
    ['worktree', 'add', 'x'],
    ['init'],
    ['clone', 'x']
  ])
    assert.throws(
      () => git.run(args),
      (e) => e instanceof ReleaseBoundaryError && e.code === 'GIT_SUBCOMMAND_NOT_ALLOWED',
      args.join(' ')
    )
  for (const args of [
    ['hash-object', '-w', '--stdin'],
    ['rev-parse', '--force'],
    ['for-each-ref', '-d']
  ])
    assert.throws(
      () => git.run(args),
      (e) => e.code === 'GIT_ARG_NOT_ALLOWED',
      args.join(' ')
    )
  assert.throws(
    () => git.run('rev-parse HEAD'),
    (e) => e.code === 'GIT_ARGS_INVALID'
  )
  assert.throws(
    () => git.run([]),
    (e) => e.code === 'GIT_ARGS_INVALID'
  )
  assert.equal(spy.length, 0, 'nothing was spawned')
  git.run(['rev-parse', 'HEAD'])
  assert.equal(spy.length, 1)
  assert.equal(spy[0][0], 'git')
  assert.deepEqual(spy[0][1], ['rev-parse', 'HEAD'])
  assert.equal(spy[0][2].shell, false)
  assert.equal(spy[0][2].cwd, fxA.root)
})

test('I-16/failing runs leave the internal source, public files and registry untouched and write only under the release root', async () => {
  const before = snapshotInternal(fxA)
  const head = fxA.head
  fxA.write('publish/CLAUDE.md', PUBLIC_SOURCES['publish/CLAUDE.md'] + '!!')
  const res = await runCli(fxA, ['prepare', '--release-id', 'rel-sidefx'])
  assert.equal(res.code, EXIT.VIOLATION)
  assert.equal(
    fxA.git(['status', '--porcelain']).stdout.trimEnd(),
    ' M publish/CLAUDE.md',
    'only the injected dirt'
  )
  fxA.git(['checkout', '-q', '--', 'publish/CLAUDE.md'])
  assertSameSnapshot(before, snapshotInternal(fxA), 'internal source after failing prepare')
  assert.equal(fxA.head, head)
  assert.equal(fxA.rev('HEAD'), head)
  assert.deepEqual(fs.readdirSync(fxA.releaseDir('rel-sidefx')), ['reports'])
})

test('I-16/foreign staging is reported and left alone; a failed write removes only its own staging directory', async () => {
  const id = 'rel-staging'
  const roots = resolveReleaseRoot({
    internalRoot: fxA.root,
    controlledRoot: '.tmp-probe/releases/',
    releaseId: id
  })
  const foreign = path.join(roots.releaseReal, '.staging-20260101T000000000Z')
  fs.mkdirSync(foreign)
  fs.writeFileSync(
    path.join(foreign, OWNER_MARKER),
    JSON.stringify({ releaseId: id, runId: 'other', pid: 0 })
  )
  fs.writeFileSync(path.join(foreign, 'half.txt'), 'half written by someone else')
  assert.deepEqual(listForeignStaging(roots.releaseReal, 'mine'), ['.staging-20260101T000000000Z'])
  const res = await runCli(fxA, ['prepare', '--release-id', id])
  assert.equal(res.code, EXIT.VIOLATION)
  assert.equal(
    sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
    'FOREIGN_STAGING_PRESENT'
  )
  assert.ok(fs.existsSync(path.join(foreign, 'half.txt')), 'foreign staging not deleted')
  assert.ok(!fs.existsSync(roots.candidateDir))
  const entries = [
    { path: 'a.md', mode: '100644', blob: 'missing-blob', sha256: sha256('a'), bytes: 1 }
  ]
  assert.throws(
    () =>
      writeCandidate({
        roots,
        runId: '20260919T000000999Z',
        releaseId: id,
        expectedEntries: entries,
        blobs: new Map()
      }),
    (e) => e instanceof ReleaseExecutionError && e.code === 'BLOB_MISSING'
  )
  assert.ok(
    !fs.existsSync(path.join(roots.releaseReal, '.staging-20260919T000000999Z')),
    'own staging removed'
  )
  assert.ok(fs.existsSync(path.join(foreign, 'half.txt')), 'foreign staging still untouched')
  assert.ok(!fs.existsSync(roots.candidateDir))
  assert.throws(
    () =>
      writeCandidate({
        roots,
        runId: 'r',
        releaseId: id,
        expectedEntries: [{ path: '../esc.md', mode: '100644', blob: 'b', sha256: 'x', bytes: 1 }],
        blobs: new Map([['b', TEXT('x')]])
      }),
    (e) => e instanceof ReleaseBoundaryError && e.code === 'PATH_ESCAPE'
  )
  assert.ok(!fs.existsSync(path.join(roots.releaseReal, 'esc.md')))
})

test('I-16/the release modules import no shell, package or network capability', () => {
  const files = [
    'scripts/release.mjs',
    'scripts/release/source.mjs',
    'scripts/release/report.mjs',
    'scripts/release/checks.mjs'
  ]
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, ...f.split('/')), 'utf8')
    assert.doesNotMatch(
      text,
      /(?<![.\w])(execSync|execFileSync|exec|execFile|spawn)\s*\(/,
      `${f}: only spawnSync`
    )
    assert.doesNotMatch(text, /shell:\s*true/, f)
    assert.doesNotMatch(text, /['"`]npm(\.cmd)?['"`]/, `${f}: no npm invocation`)
    assert.doesNotMatch(text, /node:(http|https|net|dgram)/, `${f}: no network module`)
    assert.doesNotMatch(text, /electron-builder(?!\.yml)|\bpackage\s*\(/, `${f}: no packaging call`)
  }
  const sourceText = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'release', 'source.mjs'),
    'utf8'
  )
  assert.equal(
    (sourceText.match(/spawnSync\(/g) ?? []).length,
    0,
    'spawnSync is only referenced as the default adapter, never called directly'
  )
  assert.ok(
    !fs
      .readFileSync(path.join(REPO_ROOT, 'scripts', 'release.mjs'), 'utf8')
      .includes('child_process')
  )
})

// ════════════════════════════════════════════════════════════════════════════
// I-01 — public history independence, parent chain, tags (real temporary repositories + stubbed responses)
// ════════════════════════════════════════════════════════════════════════════
const fxP = createFixture('public')
const PID = 'pub-1'
let publicOk = null

test('I-01/first public commit without parent whose tree equals the candidate passes every public-history subcheck', async () => {
  const prep = await runCli(fxP, ['prepare', '--release-id', PID])
  assert.equal(prep.code, EXIT.ADMITTED, prep.err.join('\n'))
  publicOk = makePublicRepo(fxP, 'public', candidateDir(fxP, PID))
  writeBaseline(fxP, PID, BASELINE_ROOT)
  const before = snapshotDir(publicOk)
  const res = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(res.code, EXIT.INCOMPLETE, 'owner-6b checks are still unchecked')
  const ph = check(res.report, 'public-history')
  assert.equal(ph.status, STATUS.PASS, JSON.stringify(ph.subchecks))
  assert.equal(ph.subchecks.length, 10)
  assert.equal(
    sub(res.report, 'public-history', 'parent-matches-baseline').detail.root,
    rev(publicOk, 'HEAD')
  )
  assert.equal(
    sub(res.report, 'public-history', 'content-matches-candidate').detail.digest,
    sourceJson(fxP, PID).candidate.digest
  )
  assert.equal(ph.location, '<public-root>')
  const evidenceName = ph.evidence.find((e) => e.startsWith('evidence/public-git.'))
  const evidence = readJson(path.join(fxP.releaseDir(PID), ...evidenceName.split('/')))
  assert.equal(evidence.publicRoot, '<public-root>')
  assert.equal(evidence.publicCommit, rev(publicOk, 'HEAD'))
  assert.equal(evidence.chainLength, 1)
  assert.ok(!JSON.stringify(evidence).includes(publicOk.split(path.sep).join('/')))
  assertSameSnapshot(before, snapshotDir(publicOk), 'public repository including .git after check')
  const publicCalls = res.recorder.filter((c) => c.cwdRole === '<public-root>')
  assert.ok(publicCalls.length > 0)
  for (const c of publicCalls)
    assert.ok(READ_ONLY_GIT_SUBCOMMANDS.includes(c.args[0]), c.args.join(' '))
})

test('I-01/missing baseline or an empty public repository is PENDING, never assumed empty or passed', async () => {
  writeBaseline(fxP, PID, null)
  const res = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(res.code, EXIT.INCOMPLETE)
  assert.equal(sub(res.report, 'public-history', 'baseline-present').reasonCode, 'BASELINE_MISSING')
  assert.equal(sub(res.report, 'public-history', 'parent-matches-baseline').status, STATUS.PENDING)
  assert.equal(sub(res.report, 'public-history', 'tags-unmoved').status, STATUS.PENDING)
  assert.ok(!check(res.report, 'public-history').subchecks.some((s) => s.status === STATUS.FAIL))
  const empty = makePublicRepo(fxP, 'public-empty', null)
  writeBaseline(fxP, PID, BASELINE_ROOT)
  const res2 = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    empty
  ])
  assert.equal(
    sub(res2.report, 'public-history', 'public-commit-present').reasonCode,
    'NO_PUBLIC_COMMIT'
  )
  assert.equal(
    sub(res2.report, 'public-history', 'content-matches-candidate').status,
    STATUS.PENDING
  )
  const missing = path.join(fxP.dir, 'does-not-exist')
  const res3 = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    missing
  ])
  assert.equal(
    sub(res3.report, 'public-history', 'repository-independent').reasonCode,
    'PUBLIC_REPO_NOT_FOUND'
  )
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-nonrepo-'))
  TEMP_DIRS.push(plain)
  const res4 = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    plain
  ])
  assert.equal(
    sub(res4.report, 'public-history', 'repository-independent').reasonCode,
    'PUBLIC_REPO_NOT_A_REPOSITORY'
  )
  assert.equal(check(res4.report, 'public-history').status, STATUS.PENDING)
})

test('I-01/a first commit with a parent, a wrong previous parent and a merge commit all fail', async () => {
  git(publicOk, ['commit', '-q', '--allow-empty', '-m', 'public v2'])
  const first = rev(publicOk, 'HEAD~1')
  const second = rev(publicOk, 'HEAD')
  writeBaseline(fxP, PID, { ...BASELINE_ROOT, previousPublicCommit: first })
  const ok = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(sub(ok.report, 'public-history', 'parent-matches-baseline').status, STATUS.PASS)
  assert.equal(sub(ok.report, 'public-history', 'linear-single-parent-chain').detail.length, 2)
  writeBaseline(fxP, PID, BASELINE_ROOT)
  const rootParent = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(
    sub(rootParent.report, 'public-history', 'parent-matches-baseline').reasonCode,
    'FIRST_COMMIT_HAS_PARENT'
  )
  assert.equal(rootParent.code, EXIT.VIOLATION)
  writeBaseline(fxP, PID, {
    ...BASELINE_ROOT,
    previousPublicCommit: '0123456789abcdef0123456789abcdef01234567'
  })
  const wrong = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(
    sub(wrong.report, 'public-history', 'parent-matches-baseline').reasonCode,
    'PARENT_NOT_PREVIOUS_PUBLIC'
  )
  git(publicOk, ['checkout', '-q', '-b', 'side'])
  git(publicOk, ['commit', '-q', '--allow-empty', '-m', 'side'])
  git(publicOk, ['checkout', '-q', 'main'])
  git(publicOk, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
  writeBaseline(fxP, PID, { ...BASELINE_ROOT, previousPublicCommit: second })
  const merged = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    publicOk
  ])
  assert.equal(
    sub(merged.report, 'public-history', 'linear-single-parent-chain').reasonCode,
    'MERGE_COMMIT_IN_PUBLIC_CHAIN'
  )
  assert.deepEqual(
    sub(merged.report, 'public-history', 'linear-single-parent-chain').detail.commits,
    [rev(publicOk, 'HEAD')]
  )
  assert.equal(
    sub(merged.report, 'public-history', 'parent-matches-baseline').reasonCode,
    'PARENT_NOT_PREVIOUS_PUBLIC'
  )
  assert.equal(merged.code, EXIT.VIOLATION)
})

test('I-01/existing tags must keep object and target; the tool never moves or creates tags', async () => {
  const pubTag = makePublicRepo(fxP, 'public-tag', candidateDir(fxP, PID))
  git(pubTag, ['tag', 'v1.0.0'])
  const tip = rev(pubTag, 'HEAD')
  writeBaseline(fxP, PID, {
    ...BASELINE_ROOT,
    tags: [{ name: 'v1.0.0', objectId: tip, targetId: tip }]
  })
  const ok = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    pubTag
  ])
  assert.equal(sub(ok.report, 'public-history', 'tags-unmoved').status, STATUS.PASS)
  const other = '0123456789abcdef0123456789abcdef01234567'
  writeBaseline(fxP, PID, {
    ...BASELINE_ROOT,
    tags: [
      { name: 'v1.0.0', objectId: other, targetId: other },
      { name: 'v0.9.0', objectId: other, targetId: other }
    ]
  })
  const moved = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    pubTag
  ])
  const s = sub(moved.report, 'public-history', 'tags-unmoved')
  assert.equal(s.reasonCode, 'TAG_MOVED_OR_MISSING')
  assert.deepEqual(
    s.detail.moved.map((m) => m.name),
    ['v1.0.0']
  )
  assert.deepEqual(s.detail.missing, ['v0.9.0'])
  assert.equal(
    git(pubTag, ['for-each-ref', 'refs/tags']).stdout.trim().split('\n').length,
    1,
    'tags untouched'
  )
  assert.equal(rev(pubTag, 'v1.0.0'), tip)
  assert.ok(
    validateBaseline({
      ...BASELINE_ROOT,
      tags: [{ name: 'x', objectId: 'short', targetId: tip }]
    }).some((e) => e.startsWith('tag-invalid'))
  )
  assert.ok(
    validateBaseline({ ...BASELINE_ROOT, previousPublicCommit: 'HEAD' }).includes(
      'previousPublicCommit-invalid'
    )
  )
  assert.ok(validateBaseline({ ...BASELINE_ROOT, confirmedBy: '' }).includes('confirmedBy-missing'))
  assert.deepEqual(validateBaseline(BASELINE_ROOT), [])
})

test('I-01/a clone of the internal repository shares internal commits and fails; alternates and worktrees are not independent', async () => {
  writeBaseline(fxP, PID, BASELINE_ROOT)
  const clone = path.join(fxP.dir, 'public-clone')
  git(fxP.dir, ['clone', '-q', '--no-hardlinks', fxP.root, clone])
  const res = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    clone
  ])
  assert.equal(res.code, EXIT.VIOLATION)
  assert.equal(
    sub(res.report, 'public-history', 'repository-independent').status,
    STATUS.PASS,
    'own .git, not inside the internal root'
  )
  const shared = sub(res.report, 'public-history', 'no-internal-commit-intersection')
  assert.equal(shared.reasonCode, 'INTERNAL_OBJECT_SHARED')
  assert.ok(shared.detail.commits.includes(fxP.head))
  assert.equal(
    sub(res.report, 'public-history', 'parent-matches-baseline').reasonCode,
    'FIRST_COMMIT_HAS_PARENT'
  )
  const content = sub(res.report, 'public-history', 'content-matches-candidate')
  assert.equal(content.reasonCode, 'CONTENT_MISMATCH')
  assert.ok(
    content.detail.extra.includes('docs/TODO.md'),
    'stripped internal file present in the clone tree'
  )
  const alt = path.join(fxP.dir, 'public-alt')
  git(fxP.dir, ['clone', '-q', '--shared', fxP.root, alt])
  const res2 = await runCli(fxP, [
    'check',
    '--release-id',
    PID,
    '--stage',
    'pre-push',
    '--public-repo',
    alt
  ])
  assert.equal(sub(res2.report, 'public-history', 'no-alternates').reasonCode, 'ALTERNATES_PRESENT')
  const wt = path.join(fxP.dir, 'public-wt')
  fxP.git(['worktree', 'add', '-q', '--detach', wt, 'main'])
  try {
    const res3 = await runCli(fxP, [
      'check',
      '--release-id',
      PID,
      '--stage',
      'pre-push',
      '--public-repo',
      wt
    ])
    const indep = sub(res3.report, 'public-history', 'repository-independent')
    assert.equal(indep.reasonCode, 'PUBLIC_REPO_NOT_INDEPENDENT')
    assert.ok(indep.detail.problems.includes('common-dir-differs(worktree)'))
    assert.ok(indep.detail.problems.includes('shares-internal-git-dir'))
    assert.equal(
      sub(res3.report, 'public-history', 'branch-is-main').reasonCode,
      'PUBLIC_BRANCH_NOT_MAIN'
    )
  } finally {
    fxP.git(['worktree', 'remove', '--force', wt])
  }
  const inside = path.join(fxP.root, 'nested-public')
  fs.mkdirSync(inside)
  try {
    const res4 = await runCli(fxP, [
      'check',
      '--release-id',
      PID,
      '--stage',
      'pre-push',
      '--public-repo',
      inside
    ])
    assert.equal(
      sub(res4.report, 'public-history', 'repository-independent').reasonCode,
      'PUBLIC_REPO_OVERLAPS_INTERNAL_ROOT'
    )
    assert.equal(sub(res4.report, 'public-history', 'repository-independent').status, STATUS.FAIL)
  } finally {
    fs.rmdirSync(inside)
  }
})

test('I-01/stubbed read-only responses: merge parent, internal parent and moved tag are detected without touching any repository', () => {
  const T = 'a'.repeat(40)
  const P1 = 'b'.repeat(40)
  const P2 = 'c'.repeat(40)
  const BLOB = 'd'.repeat(40)
  const TAG_OBJ = 'e'.repeat(40)
  const content = TEXT('hello\n')
  const calls = []
  const reply = (opts, text) => ({
    status: 0,
    stdout: opts.encoding === null ? Buffer.from(text) : text,
    stderr: ''
  })
  const spawnImpl = (program, args, opts) => {
    calls.push({ program, args: [...args], cwd: opts.cwd, shell: opts.shell })
    const key = args.join(' ')
    if (key === 'symbolic-ref -q HEAD') return reply(opts, 'refs/heads/main\n')
    if (key.startsWith('rev-parse --verify -q --end-of-options refs/heads/main^{commit}'))
      return reply(opts, `${T}\n`)
    if (key === `rev-list --parents ${T}`) return reply(opts, `${T} ${P1} ${P2}\n${P1}\n${P2}\n`)
    if (key === 'cat-file --batch-check') {
      const asked = String(opts.input).trim().split('\n')
      return reply(
        opts,
        asked.map((o) => (o === P1 ? `${o} commit 200` : `${o} missing`)).join('\n') + '\n'
      )
    }
    if (key === `ls-tree -r -z --full-tree ${T}`)
      return reply(opts, `100644 blob ${BLOB}\tREADME.md\0`)
    if (key === 'cat-file --batch')
      return {
        status: 0,
        stdout: Buffer.concat([TEXT(`${BLOB} blob ${content.length}\n`), content, TEXT('\n')]),
        stderr: ''
      }
    if (args[0] === 'for-each-ref') return reply(opts, `v1.0.0\0${TAG_OBJ}\0tag\0${T}\n`)
    return {
      status: 1,
      stdout: opts.encoding === null ? Buffer.alloc(0) : '',
      stderr: `unhandled ${key}`
    }
  }
  const publicGit = createGitAdapter({ cwd: 'X:/public', role: '<public-root>', spawnImpl })
  const internalGit = createGitAdapter({ cwd: 'X:/internal', role: '<internal-root>', spawnImpl })
  const layout = {
    toplevel: 'X:/public',
    gitDir: 'X:/public/.git',
    commonDir: 'X:/public/.git',
    gitDirIsDirectory: true,
    hasAlternates: false
  }
  const internalLayout = {
    toplevel: 'X:/internal',
    gitDir: 'X:/internal/.git',
    commonDir: 'X:/internal/.git',
    insideWorkTree: true
  }
  const candidateEntries = [
    { path: 'README.md', mode: '100644', sha256: sha256(content), bytes: content.length }
  ]
  const baseline = {
    ...BASELINE_ROOT,
    previousPublicCommit: P1,
    tags: [{ name: 'v1.0.0', objectId: 'f'.repeat(40), targetId: T }]
  }
  const res = checkPublicHistory({
    publicGit,
    internalGit,
    publicLayout: layout,
    internalLayout,
    baseline,
    baselineErrors: [],
    candidateDigest: manifestDigest(candidateEntries),
    candidateEntries,
    policy: REAL_POLICY
  })
  const by = Object.fromEntries(res.subchecks.map((s) => [s.id, s]))
  assert.equal(by['repository-independent'].status, 'PASS')
  assert.equal(by['no-alternates'].status, 'PASS')
  assert.equal(by['branch-is-main'].status, 'PASS')
  assert.equal(by['public-commit-present'].detail.commit, T)
  assert.equal(by['parent-matches-baseline'].reasonCode, 'PARENT_NOT_PREVIOUS_PUBLIC')
  assert.deepEqual(by['linear-single-parent-chain'].detail.commits, [T])
  assert.deepEqual(by['no-internal-commit-intersection'].detail.commits, [P1])
  assert.equal(by['tags-unmoved'].reasonCode, 'TAG_MOVED_OR_MISSING')
  assert.equal(by['content-matches-candidate'].status, 'PASS')
  assert.equal(res.chainLength, 3)
  assert.ok(
    calls.every(
      (c) =>
        c.program === 'git' && c.shell === false && READ_ONLY_GIT_SUBCOMMANDS.includes(c.args[0])
    )
  )
  const layoutWt = {
    ...layout,
    gitDirIsDirectory: false,
    commonDir: 'X:/internal/.git',
    hasAlternates: true
  }
  const res2 = checkPublicHistory({
    publicGit,
    internalGit,
    publicLayout: layoutWt,
    internalLayout,
    baseline,
    baselineErrors: [],
    candidateDigest: null,
    candidateEntries: [],
    policy: REAL_POLICY
  })
  const by2 = Object.fromEntries(res2.subchecks.map((s) => [s.id, s]))
  assert.equal(by2['repository-independent'].reasonCode, 'PUBLIC_REPO_NOT_INDEPENDENT')
  assert.deepEqual(by2['repository-independent'].detail.problems.sort(), [
    'common-dir-differs(worktree)',
    'git-is-not-a-directory(worktree-or-file)',
    'shares-internal-git-dir'
  ])
  assert.equal(by2['no-alternates'].reasonCode, 'ALTERNATES_PRESENT')
  assert.equal(by2['content-matches-candidate'].reasonCode, 'CANDIDATE_DIGEST_MISSING')
})

// ════════════════════════════════════════════════════════════════════════════
// Step 6b — candidate checks (owner 6b): I-03 / I-04 / I-07 / I-08 / I-09 / I-10 / I-11 / I-13 / I-14 / I-17 / I-18 / I-19 / I-20
// Every case runs a normal input and a deliberately broken input on the same checker and asserts the located result.
// ════════════════════════════════════════════════════════════════════════════
const cand = () => loadCandidateFiles(candidateDir(fxS, SID))
const cloneFiles = (files) => new Map(files)
const subOf = (res, id) => res.subchecks.find((s) => s.id === id)
const statusMap = (res) => Object.fromEntries(res.subchecks.map((s) => [s.id, s.status]))
const REAL_ROOT_SEGMENTS = fxS.root.split(path.sep).filter(Boolean)
const FIX_USER = 'fixture-operator-name'
const secretsOn = (files, extra = {}) =>
  checkCandidateSecrets({
    policy: REAL_POLICY,
    files,
    scannerSource: REAL_SCANNER_BUF.toString('utf8'),
    internalRoot: fxS.root,
    username: FIX_USER,
    ...extra
  })
const V6_FULL = ['2abc', '1357', '2468', 'acdc', '1a2b', '3c4d', '5e6f', '1234'].join(':')
const V6_DOC = ['2001', 'db8', '1234', '5678', '9abc', 'def0', '1234', '5678'].join(':')
const V6_SHORT = ['2abc', '1357', '', '1'].join(':')

test('I-03/candidate-boundary passes on the prepared candidate and fails on injected residue, forbidden path, .git, missing target and case variant', () => {
  const { files, anomalies } = cand()
  const ok = checkCandidateBoundary({ policy: REAL_POLICY, files, anomalies })
  assert.deepEqual(statusMap(ok), {
    'no-strip-residue': 'PASS',
    'required-targets-present': 'PASS',
    'no-forbidden-paths': 'PASS',
    'no-git-directory': 'PASS'
  })
  assert.equal(subOf(ok, 'no-strip-residue').detail.checkedEntries, files.size)
  for (const [inject, subId, code] of [
    ['docs/TODO.md', 'no-strip-residue', 'STRIP_RESIDUE'],
    ['docs/v1.0/superpowers/x.md', 'no-strip-residue', 'STRIP_RESIDUE'],
    ['.codex/scanner-internal-dispositions.json', 'no-strip-residue', 'STRIP_RESIDUE'],
    ['docs/codex/x.md', 'no-strip-residue', 'STRIP_RESIDUE'],
    ['publish/sync-base.json', 'no-strip-residue', 'STRIP_RESIDUE'],
    ['AGENTS.md', 'no-forbidden-paths', 'FORBIDDEN_PATH_PRESENT'],
    ['node_modules/x/index.js', 'no-forbidden-paths', 'FORBIDDEN_PATH_PRESENT'],
    ['Docs/TODO.md', 'no-strip-residue', 'CASE_VARIANT_OF_RULE_PATH']
  ]) {
    const f = cloneFiles(files)
    f.set(inject, TEXT('injected\n'))
    const bad = checkCandidateBoundary({ policy: REAL_POLICY, files: f, anomalies })
    assert.equal(subOf(bad, subId).status, STATUS.FAIL, inject)
    assert.equal(subOf(bad, subId).reasonCode, code, inject)
  }
  const missing = cloneFiles(files)
  missing.delete('LICENSE')
  const m = checkCandidateBoundary({ policy: REAL_POLICY, files: missing, anomalies })
  assert.equal(subOf(m, 'required-targets-present').reasonCode, 'REQUIRED_TARGET_MISSING')
  assert.deepEqual(subOf(m, 'required-targets-present').detail.missingFiles, ['LICENSE'])
  const g = checkCandidateBoundary({
    policy: REAL_POLICY,
    files,
    anomalies: [{ path: '.git', kind: 'git-directory' }]
  })
  assert.equal(subOf(g, 'no-git-directory').reasonCode, 'GIT_DIRECTORY_PRESENT')
  // docs/v2.0 control stays allowed
  const v2 = cloneFiles(files)
  v2.set('docs/v2.0/example.md', TEXT('future\n'))
  assert.equal(
    subOf(checkCandidateBoundary({ policy: REAL_POLICY, files: v2, anomalies }), 'no-strip-residue')
      .status,
    STATUS.PASS
  )
})

test('I-03/a stripped file injected into the real candidate directory fails the stage even though the manifest was clean', async () => {
  const injected = path.join(candidateDir(fxS, SID), 'docs', 'TODO.md')
  fs.writeFileSync(injected, 'internal backlog\n')
  try {
    const res = await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-push'])
    assert.equal(res.code, EXIT.VIOLATION)
    assert.equal(
      sub(res.report, 'candidate-boundary', 'no-strip-residue').reasonCode,
      'STRIP_RESIDUE'
    )
    assert.equal(
      sub(res.report, 'source', 'candidate-matches-expected').reasonCode,
      'CANDIDATE_TAMPERED'
    )
  } finally {
    fs.rmSync(injected)
  }
  const back = await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-push'])
  assert.equal(check(back.report, 'candidate-boundary').status, STATUS.PASS)
})

test('I-04/internal markers: prose must be clean, ordinary words pass, boundary-aware matching, declared code positions only', () => {
  const { files } = cand()
  const ok = checkInternalMarkers({ policy: REAL_POLICY, files })
  assert.deepEqual(statusMap(ok), { 'prose-clean': 'PASS', 'literal-positions-only': 'PASS' })
  // ordinary words are never markers
  const words = cloneFiles(files)
  words.set('docs/notes.md', TEXT('# Task plan\n\nThis Task has a plan, a spec and a review.\n'))
  assert.equal(
    subOf(checkInternalMarkers({ policy: REAL_POLICY, files: words }), 'prose-clean').status,
    STATUS.PASS
  )
  // internal reference in prose fails with location
  const prose = cloneFiles(files)
  prose.set(
    'docs/notes.md',
    TEXT('# Notes\n\nSee docs/TODO.md #12 and docs/v1.0/superpowers/specs/x.md.\n')
  )
  const bad = checkInternalMarkers({ policy: REAL_POLICY, files: prose })
  assert.equal(subOf(bad, 'prose-clean').reasonCode, 'INTERNAL_MARKER_IN_PROSE')
  assert.deepEqual(
    subOf(bad, 'prose-clean').detail.hits.map((h) => [h.path, h.line, h.marker]),
    [
      ['docs/notes.md', 3, 'M-05'],
      ['docs/notes.md', 3, 'M-06'],
      ['docs/notes.md', 3, 'M-15']
    ]
  )
  // token marker and memory path in prose
  const tok = cloneFiles(files)
  tok.set('README.md', TEXT('# X\n\nrun /grill-with-docs and read .claude/projects/x\n'))
  const t = checkInternalMarkers({ policy: REAL_POLICY, files: tok })
  assert.deepEqual(
    subOf(t, 'prose-clean')
      .detail.hits.map((h) => h.marker)
      .sort(),
    ['M-16', 'M-17']
  )
  // boundary: electron-publish/ is not publish/
  const lock = cloneFiles(files)
  lock.set(
    'package-lock.json',
    TEXT(
      '{\n  "packages": { "node_modules/electron-publish/x": { "resolved": "https://registry.npmjs.org/electron-publish/-/electron-publish-1.tgz" } }\n}\n'
    )
  )
  assert.equal(
    subOf(checkInternalMarkers({ policy: REAL_POLICY, files: lock }), 'literal-positions-only')
      .status,
    STATUS.PASS
  )
  assert.deepEqual(
    findMarkerOccurrences('a electron-publish/ b publish/ c', {
      kind: 'path-prefix',
      value: 'publish/'
    }),
    [22]
  )
  assert.deepEqual(
    findMarkerOccurrences('x/grill-with-docs-extra /grill-with-docs', {
      kind: 'token',
      value: '/grill-with-docs'
    }),
    [24]
  )
  // declared code comment position passes; the same marker in an undeclared file fails
  const decl = cloneFiles(files)
  decl.set(
    'extension/src/buildId.ts',
    TEXT('/** build id (docs/TODO.md #53) */\nexport const x = 1\n')
  )
  assert.equal(
    subOf(checkInternalMarkers({ policy: REAL_POLICY, files: decl }), 'literal-positions-only')
      .status,
    STATUS.PASS
  )
  const undecl = cloneFiles(files)
  undecl.set('src/main/other.ts', TEXT('// see docs/TODO.md #53\nexport const x = 1\n'))
  const u = checkInternalMarkers({ policy: REAL_POLICY, files: undecl })
  assert.equal(
    subOf(u, 'literal-positions-only').reasonCode,
    'INTERNAL_MARKER_OUTSIDE_DECLARED_POSITION'
  )
  assert.equal(subOf(u, 'literal-positions-only').detail.hits[0].reason, 'NO_DECLARED_POSITION')
  // declared file but marker in code (not a comment) fails
  const codepos = cloneFiles(files)
  codepos.set('extension/src/buildId.ts', TEXT("export const p = 'docs/TODO.md'\n"))
  const c = checkInternalMarkers({ policy: REAL_POLICY, files: codepos })
  assert.equal(subOf(c, 'literal-positions-only').detail.hits[0].reason, 'POSITION_NOT_DECLARED')
  assert.equal(subOf(c, 'literal-positions-only').detail.hits[0].position, 'string')
})

test('I-04/policy JSON literals only at declared pointers; the same value elsewhere in the same file fails; unparseable JSON is ERROR', () => {
  const { files } = cand()
  const pol = JSON.parse(files.get(POLICY_PATH).toString('utf8'))
  pol.description = 'never mention docs/TODO.md here'
  const f = cloneFiles(files)
  f.set(POLICY_PATH, TEXT(JSON.stringify(pol, null, 2) + '\n'))
  const bad = checkInternalMarkers({ policy: REAL_POLICY, files: f })
  const hit = subOf(bad, 'literal-positions-only').detail.hits.find((h) => h.path === POLICY_PATH)
  assert.equal(hit.reason, 'JSON_POINTER_OUTSIDE_ALLOWED')
  assert.equal(hit.pointer, '/description')
  const broken = cloneFiles(files)
  broken.set(POLICY_PATH, TEXT('{ "stripPaths": [ { "path": "docs/TODO.md" '))
  const e = checkInternalMarkers({ policy: REAL_POLICY, files: broken })
  assert.equal(subOf(e, 'prose-clean').status, STATUS.ERROR)
  assert.equal(subOf(e, 'literal-positions-only').reasonCode, 'PARSE_ERROR')
})

test('I-04/prose-term for the public glossary is bounded to its section and count; a fourth or out-of-section occurrence fails', () => {
  const { files } = cand()
  const base = files.get('CONTEXT.md').toString('utf8')
  const four = cloneFiles(files)
  four.set(
    'CONTEXT.md',
    TEXT(
      base +
        '\n**候选树 2**: `publish/` again.\n**候选树 3**: `publish/` again.\n**候选树 4**: `publish/` again.\n'
    )
  )
  const b = checkInternalMarkers({ policy: REAL_POLICY, files: four })
  assert.equal(subOf(b, 'prose-clean').reasonCode, 'INTERNAL_MARKER_IN_PROSE')
  assert.equal(subOf(b, 'prose-clean').detail.hits[0].reason, 'PROSE_TERM_EXCEEDED')
  const outside = cloneFiles(files)
  outside.set('CONTEXT.md', TEXT('# CONTEXT\n\nsee publish/ here\n\n' + base))
  const o = checkInternalMarkers({ policy: REAL_POLICY, files: outside })
  assert.equal(subOf(o, 'prose-clean').detail.hits[0].reason, 'PROSE_TERM_OUTSIDE_SECTION')
})

test('I-04/a synthetic secret next to allowed rule literals in a declared file is still caught by the secrets check (no whole-file exemption)', () => {
  const { files } = cand()
  const f = cloneFiles(files)
  const src = files.get('scripts/scan-secrets.mjs').toString('utf8')
  const pem = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('')
  f.set('scripts/scan-secrets.mjs', TEXT(src + '\n// ' + pem + '\n'))
  assert.equal(
    subOf(checkInternalMarkers({ policy: REAL_POLICY, files: f }), 'literal-positions-only').status,
    STATUS.PASS
  )
  const s = secretsOn(f)
  assert.equal(subOf(s, 'open-empty').status, STATUS.FAIL)
  const g = subOf(s, 'open-empty').detail.summary.find((x) => x.file === 'scripts/scan-secrets.mjs')
  assert.equal(g.rule, 'R1')
  assert.equal(g.fingerprintRedacted, true, 'credential-shaped hits never expose a fingerprint')
})

test('I-07/the scanner registry pairs: four real entries removed, three exact false positives kept, no true internal key registered', () => {
  const src = REAL_SCANNER_BUF.toString('utf8')
  const reg = JSON.parse(
    JSON.stringify(vmEval(src.match(/const ADJUDICATED = (\[[\s\S]*?\n\])/)[1]))
  )
  const keys = new Set(reg.map((a) => `${a.rule}|${a.file}|${a.sha}`))
  for (const k of [
    'R10|src/main/binaries/locator.test.ts|39115dd5c160',
    'R11|src/main/binaries/locator.test.ts|35daaebcd715',
    'R12|src/main/bt/inboundDiagnosis.test.ts|a885246e0c2b',
    'R12|src/main/bt/inboundDiagnosis.test.ts|e2e136951369'
  ])
    assert.ok(!keys.has(k), `removed entry must stay removed: ${k}`)
  for (const sha of ['eb709fb88435', '7949f53b4fd0', '31c8ed0d2b19'])
    assert.ok(keys.has(`R12|src/main/bt/inboundDiagnosis.test.ts|${sha}`), sha)
  for (const a of reg) {
    assert.ok(!('scope' in a), 'no internal-scope record inside the public registry')
    assert.ok(!/\.codex\/scanner-internal-dispositions/.test(a.file))
  }
  assert.equal(new Set(keys).size, reg.length)
})

test('I-07/I-08 candidate secrets: explicit file set + original identity, R12 true hit located, doc prefix / short / stripped are controls, registry applicability per entry', () => {
  const { files } = cand()
  const clean = secretsOn(files)
  assert.deepEqual(statusMap(clean), {
    'identity-context-present': 'PASS',
    'open-empty': 'PASS',
    'stale-empty': 'PASS',
    'coverage-listed': 'PASS'
  })
  assert.equal(
    subOf(clean, 'identity-context-present').detail.rootSegments,
    REAL_ROOT_SEGMENTS.length
  )
  assert.equal(subOf(clean, 'coverage-listed').detail.candidateFiles, files.size)
  assert.ok(
    subOf(clean, 'coverage-listed').detail.skipped > 0,
    'binary paths are listed as skipped, not hidden'
  )
  const counts = subOf(clean, 'stale-empty').detail.counts
  assert.ok(
    counts['retired:stripped:S-05'] >= 1,
    'entries for stripped docs/v1.0 files are retired, not stale'
  )
  assert.ok(counts['retired:not-in-candidate'] >= 1)
  assert.ok(counts.applied >= 1)
  assert.ok(!('stale-in-candidate' in counts))
  // R12 true hit in a retained file
  const hit = cloneFiles(files)
  hit.set('src/main/probe.ts', TEXT(`export const addr = '${V6_FULL}'\n`))
  const r = secretsOn(hit)
  assert.equal(subOf(r, 'open-empty').reasonCode, 'OPEN_FINDINGS')
  assert.deepEqual(
    subOf(r, 'open-empty').detail.summary.map((g) => [g.rule, g.file, g.currentLocations]),
    [['R12', 'src/main/probe.ts', [':1']]]
  )
  assert.equal(subOf(r, 'stale-empty').status, STATUS.PASS, 'a real hit is open, never stale')
  // controls: documentation prefix, too short, stripped path (skipped by release face), history-only does not exist for a candidate
  for (const [p, v] of [
    ['src/main/probe.ts', V6_DOC],
    ['src/main/probe.ts', V6_SHORT],
    ['docs/v1.0/probe.md', V6_FULL]
  ]) {
    const c = cloneFiles(files)
    c.set(p, TEXT(`${v}\n`))
    assert.equal(subOf(secretsOn(c), 'open-empty').status, STATUS.PASS, `${p} ${v}`)
  }
  // remove → back to clean
  assert.equal(subOf(secretsOn(files), 'open-empty').status, STATUS.PASS)
  // R10 / R11 use the original identity, not the candidate root
  const u = cloneFiles(files)
  u.set('src/main/who.ts', TEXT(`export const who = '${FIX_USER}'\n`))
  assert.deepEqual(
    subOf(secretsOn(u), 'open-empty').detail.summary.map((g) => g.rule),
    ['R10']
  )
  const seg = REAL_ROOT_SEGMENTS.slice(0, 3)
    .map((s) => `'${s}'`)
    .join(', ')
  const rp = cloneFiles(files)
  rp.set('src/main/where.ts', TEXT(`export const p = join(${seg})\n`))
  assert.deepEqual(
    subOf(secretsOn(rp), 'open-empty').detail.summary.map((g) => g.rule),
    ['R11']
  )
  // identity unavailable → PENDING, never PASS
  const anon = secretsOn(files, { username: 'u' })
  assert.equal(subOf(anon, 'identity-context-present').status, STATUS.PENDING)
  assert.equal(subOf(anon, 'identity-context-present').reasonCode, 'IDENTITY_CONTEXT_UNAVAILABLE')
  // stale in candidate: registry entry for a present file that no longer matches
  const st = registryApplicability({
    policy: REAL_POLICY,
    files,
    registry: [
      { rule: 'R7', file: 'THIRD-PARTY-NOTICES.md', sha: 'ffffffffffff' },
      { rule: 'R8', file: 'docs/v0.1/x.md', sha: 'aaaaaaaaaaaa' },
      { rule: 'R4', file: '.codex/hooks/x.test.mjs', sha: 'bbbbbbbbbbbb' },
      { rule: 'R9', file: 'src/main/gone.ts', sha: 'cccccccccccc' }
    ],
    ackSeen: []
  })
  assert.deepEqual(
    st.map((x) => x.applicability),
    [
      'stale-in-candidate',
      'retired:stripped:S-01',
      'retired:stripped:S-12',
      'retired:not-in-candidate'
    ]
  )
  assert.ok(
    !('sha' in st[2]) && st[2].fingerprintRedacted === true,
    'credential-shaped registry rows never expose the fingerprint'
  )
  // missing scanner source is an execution error, never zero hits
  const err = checkCandidateSecrets({
    policy: REAL_POLICY,
    files,
    scannerSource: null,
    internalRoot: fxS.root,
    username: FIX_USER
  })
  assert.ok(
    err.subchecks.every(
      (s) => s.status === STATUS.ERROR && s.reasonCode === 'SCANNER_EXECUTION_ERROR'
    )
  )
})

test('I-07/I-08 an internal disposition carrier never reaches the candidate scan: it is a forbidden path and is never loaded or inherited', () => {
  const { files, anomalies } = cand()
  const carrier = {
    schemaVersion: 1,
    records: [
      {
        recordType: 'real-internal-noncredential',
        scope: 'internal-original-workspace',
        key: {
          rule: 'R12',
          file: 'src/main/probe.ts',
          matchedTextSha12: sha256(TEXT(V6_FULL)).slice(0, 12)
        },
        approval: { reviewer: 'user' }
      }
    ]
  }
  const f = cloneFiles(files)
  f.set('.codex/scanner-internal-dispositions.json', TEXT(JSON.stringify(carrier)))
  f.set('src/main/probe.ts', TEXT(`export const addr = '${V6_FULL}'\n`))
  const b = checkCandidateBoundary({ policy: REAL_POLICY, files: f, anomalies })
  assert.equal(subOf(b, 'no-strip-residue').reasonCode, 'STRIP_RESIDUE')
  const s = secretsOn(f)
  assert.equal(
    subOf(s, 'open-empty').reasonCode,
    'OPEN_FINDINGS',
    'an approved internal record never suppresses a candidate hit'
  )
  assert.equal(s.evidenceBody.internalDispositionsLoaded, false)
  assert.ok(
    !REAL_SCANNER_BUF.toString('utf8').includes('scanner-internal-dispositions'),
    'the candidate scan never loads or inherits the carrier; only the workspace scanner consumes it via policy F-08'
  )
  assert.ok(
    !fs
      .readFileSync(path.join(REPO_ROOT, 'scripts', 'release', 'checks.mjs'), 'utf8')
      .includes('scanner-internal-dispositions')
  )
})

test('I-09/public metadata: maintainer identity passes; private committer, private tagger, internal path in a message fail; lightweight tags are recorded; no repository is PENDING', () => {
  const pub = makePublicRepo(fxS, 'meta-public', candidateDir(fxS, SID))
  const pgit = createGitAdapter({ cwd: pub, role: '<public-root>' })
  const tip = rev(pub, 'HEAD')
  const ok = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip,
    baseline: BASELINE_ROOT,
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.deepEqual(statusMap(ok), {
    author: 'PASS',
    committer: 'PASS',
    tagger: 'PASS',
    'message-content': 'PASS'
  })
  git(pub, ['tag', 'v0-light'])
  const light = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip,
    baseline: BASELINE_ROOT,
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.equal(subOf(light, 'tagger').status, STATUS.PASS)
  assert.deepEqual(subOf(light, 'tagger').detail, { annotated: 0, lightweight: 1 })
  // private committer email
  fs.writeFileSync(path.join(pub, 'x.txt'), 'x\n')
  git(pub, ['add', '-A'])
  git(pub, [
    '-c',
    'user.email=someone@private.example.invalid',
    '-c',
    'user.name=lie-dream',
    'commit',
    '-q',
    '-m',
    'private committer'
  ])
  const bad = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip: rev(pub, 'HEAD'),
    baseline: BASELINE_ROOT,
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.equal(subOf(bad, 'committer').reasonCode, 'COMMITTER_IDENTITY_MISMATCH')
  assert.equal(subOf(bad, 'author').reasonCode, 'AUTHOR_IDENTITY_MISMATCH')
  assert.ok(
    !JSON.stringify(bad).includes('private.example.invalid'),
    'the report never echoes the private address'
  )
  // message with internal path + machine username
  git(pub, ['commit', '-q', '--allow-empty', '-m', `see docs/TODO.md #1 on ${FIX_USER}`])
  const msg = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip: rev(pub, 'HEAD'),
    baseline: BASELINE_ROOT,
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.equal(subOf(msg, 'message-content').reasonCode, 'MESSAGE_PRIVACY_PROBLEM')
  assert.deepEqual(
    subOf(msg, 'message-content')
      .detail.problems[0].problems.map((p) => p.kind)
      .sort(),
    ['internal-marker', 'machine-username']
  )
  // annotated tag with private tagger
  git(pub, [
    '-c',
    'user.email=tagger@private.example.invalid',
    '-c',
    'user.name=lie-dream',
    'tag',
    '-a',
    'v1-annotated',
    '-m',
    'release'
  ])
  const tg = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip: rev(pub, 'HEAD'),
    baseline: BASELINE_ROOT,
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.equal(subOf(tg, 'tagger').reasonCode, 'TAGGER_IDENTITY_MISMATCH')
  // baseline stops the walk at the previous public commit
  const stop = checkPublicMetadata({
    policy: REAL_POLICY,
    publicGit: pgit,
    tip: rev(pub, 'HEAD'),
    baseline: { ...BASELINE_ROOT, previousPublicCommit: rev(pub, 'HEAD~1') },
    machineUser: FIX_USER,
    repoSegments: REAL_ROOT_SEGMENTS
  })
  assert.equal(
    subOf(stop, 'committer').status,
    STATUS.PASS,
    'commits at or before the baseline are not re-checked'
  )
  assert.equal(subOf(stop, 'message-content').reasonCode, 'MESSAGE_PRIVACY_PROBLEM')
  const none = checkPublicMetadata({ policy: REAL_POLICY, publicGit: null })
  assert.ok(
    none.subchecks.every(
      (s) => s.status === STATUS.PENDING && s.reasonCode === 'PUBLIC_REPO_NOT_PROVIDED'
    )
  )
})

test('I-10/local links: every syntax counted, unicode and duplicate anchors resolve, missing / case / stripped / machine-absolute fail, code blocks ignored, verbatim upstream listed separately', () => {
  const md = [
    '# 概览 与 说明',
    '',
    '## Setup',
    '## Setup',
    '<a id="custom-id"></a>',
    '',
    'inline [a](docs/PRD.md) image ![i](docs/assets/screenshots/main-window.png) ref [b][r1] auto <https://example.com/x> html <a href="docs/DESIGN.md#design-public">d</a> <img src="/icon.png">',
    '',
    '[r1]: docs/ARCHITECTURE.md',
    '',
    'anchors [z](#概览-与-说明) [s](#setup-1) [c](#custom-id) [enc](#%E6%A6%82%E8%A7%88-%E4%B8%8E-%E8%AF%B4%E6%98%8E) self [t](#setup)',
    '',
    '```',
    '[never](docs/missing-in-code-block.md)',
    '```',
    '',
    'and `[inline code](docs/also-missing.md)` stays inert'
  ].join('\n')
  const { files } = cand()
  const f = cloneFiles(files)
  f.set('links.md', TEXT(md))
  const ok = checkLocalLinks({ policy: REAL_POLICY, files: f })
  assert.deepEqual(statusMap(ok), {
    'all-syntaxes-parsed': 'PASS',
    'targets-exist': 'PASS',
    'case-matches': 'PASS',
    'no-stripped-targets': 'PASS',
    'no-machine-absolute': 'PASS'
  })
  const counts = subOf(ok, 'all-syntaxes-parsed').detail.syntaxCounts
  for (const k of [
    'markdown-inline',
    'markdown-reference',
    'markdown-image',
    'markdown-autolink',
    'html-anchor',
    'html-img'
  ])
    assert.ok(counts[k] >= 1, `${k} parsed: ${JSON.stringify(counts)}`)
  // static entry files: a root-relative script src resolves against the declared renderer root, a declared build
  // output is recorded (not missing); the same references in an undeclared html file are candidate defects
  const entry = cloneFiles(files)
  entry.set(
    'src/renderer/index.html',
    TEXT(
      '<!doctype html>\n<!-- <script src="ignored-in-comment.js"></script> -->\n<script type="module" src="/src/main.tsx"></script>\n'
    )
  )
  entry.set('src/renderer/src/main.tsx', TEXT('export {}\n'))
  entry.set('extension/src/popup/popup.html', TEXT('<script src="popup.js"></script>\n'))
  const e1 = checkLocalLinks({ policy: REAL_POLICY, files: entry })
  assert.equal(
    subOf(e1, 'targets-exist').status,
    STATUS.PASS,
    JSON.stringify(e1.evidenceBody.missing)
  )
  assert.equal(subOf(e1, 'all-syntaxes-parsed').status, STATUS.PASS)
  assert.ok(subOf(e1, 'all-syntaxes-parsed').detail.syntaxCounts['html-script-src'] >= 2)
  assert.deepEqual(
    e1.evidenceBody.buildOutputs.map((b) => [b.path, b.target]),
    [['extension/src/popup/popup.html', 'popup.js']]
  )
  entry.set(
    'docs/other.html',
    TEXT('<script src="popup.js"></script><link href="/src/main.tsx">\n')
  )
  const e2 = checkLocalLinks({ policy: REAL_POLICY, files: entry })
  assert.equal(subOf(e2, 'targets-exist').reasonCode, 'LINK_TARGET_MISSING')
  assert.deepEqual(
    subOf(e2, 'targets-exist')
      .detail.missing.map((m) => m.resolved)
      .sort(),
    ['docs/popup.js', 'src/main.tsx']
  )
  entry.delete('docs/other.html')
  // unparsed reference types present in a covered document → UNCHECKED, never PASS
  entry.set('docs/media.md', TEXT('# m\n\n<video src="clip.mp4"></video>\n'))
  const e3 = checkLocalLinks({ policy: REAL_POLICY, files: entry })
  assert.equal(subOf(e3, 'all-syntaxes-parsed').status, STATUS.UNCHECKED)
  assert.equal(subOf(e3, 'all-syntaxes-parsed').reasonCode, 'UNPARSED_REFERENCE_PRESENT')
  assert.deepEqual(
    subOf(e3, 'all-syntaxes-parsed').detail.unparsed.map((u) => [u.path, u.kind, u.tag]),
    [['docs/media.md', 'markdown-html-block-other', 'video']]
  )
  entry.delete('docs/media.md')
  entry.set('src/renderer/index.html', TEXT('<style>a { background: url(x.png) }</style>\n'))
  assert.equal(
    subOf(checkLocalLinks({ policy: REAL_POLICY, files: entry }), 'all-syntaxes-parsed').detail
      .unparsed[0].kind,
    'css-url'
  )
  // the same media reference inside inline code or a fenced block is inert
  entry.set(
    'src/renderer/index.html',
    TEXT('<script type="module" src="/src/main.tsx"></script>\n')
  )
  entry.set(
    'docs/inert.md',
    TEXT('# i\n\n`<video src="clip.mp4">`\n\n```\n<iframe src="x">\n```\n')
  )
  assert.equal(
    subOf(checkLocalLinks({ policy: REAL_POLICY, files: entry }), 'all-syntaxes-parsed').status,
    STATUS.PASS
  )
  assert.ok(Array.isArray(subOf(ok, 'all-syntaxes-parsed').detail.unparsedReferenceTypes))
  assert.ok(ok.external.some((e) => e.url === 'https://example.com/x'))
  assert.deepEqual(
    [...headingAnchors('# A b\n# A b\n## 中文 标题!\n<span id="x1"></span>')].sort(),
    ['a-b', 'a-b-1', 'x1', '中文-标题']
  )
  const links = extractLinks('links.md', md)
  assert.ok(!links.some((l) => (l.target ?? '').includes('missing-in-code-block')))
  assert.ok(!links.some((l) => (l.target ?? '').includes('also-missing')))
  for (const [body, subId, code, extra] of [
    [
      '[m](docs/nope.md)',
      'targets-exist',
      'LINK_TARGET_MISSING',
      (d) => d.missing[0].resolved === 'docs/nope.md'
    ],
    [
      '[a](docs/PRD.md#no-such-anchor)',
      'targets-exist',
      'LINK_TARGET_MISSING',
      (d) => d.missing[0].reason === 'ANCHOR_MISSING'
    ],
    [
      '[c](docs/prd.md)',
      'case-matches',
      'LINK_TARGET_CASE_MISMATCH',
      (d) => d.caseMismatch[0].actual === 'docs/PRD.md'
    ],
    [
      '[s](docs/TODO.md)',
      'no-stripped-targets',
      'LINK_TARGET_STRIPPED',
      (d) => d.stripped[0].rule === 'S-06'
    ],
    [
      '[s](/publish/CLAUDE.md)',
      'no-stripped-targets',
      'LINK_TARGET_STRIPPED',
      (d) => d.stripped[0].rule === 'S-11'
    ],
    [
      '[w](C:\\Users\\someone\\x.md)',
      'no-machine-absolute',
      'LINK_TARGET_MACHINE_ABSOLUTE',
      (d) => d.machineAbs[0].form === 'windows-drive'
    ],
    [
      '[u](\\\\server\\share\\x.md)',
      'no-machine-absolute',
      'LINK_TARGET_MACHINE_ABSOLUTE',
      (d) => d.machineAbs[0].form === 'unc'
    ],
    [
      '[f](file:///D:/x.md)',
      'no-machine-absolute',
      'LINK_TARGET_MACHINE_ABSOLUTE',
      (d) => d.machineAbs[0].form === 'file-uri'
    ],
    [
      '[r][undefined-ref]',
      'all-syntaxes-parsed',
      'UNRESOLVED_REFERENCE',
      (d) => d.unresolved[0].reference === 'undefined-ref'
    ]
  ]) {
    const g = cloneFiles(files)
    g.set('bad.md', TEXT(`# bad\n\n${body}\n`))
    const r = checkLocalLinks({ policy: REAL_POLICY, files: g })
    assert.equal(subOf(r, subId).status, STATUS.FAIL, body)
    assert.equal(subOf(r, subId).reasonCode, code, body)
    assert.ok(extra(subOf(r, subId).detail), body)
  }
  // verbatim upstream material (a parsed html document registered as verbatim byte copy):
  // missing targets inside it are listed, not counted; machine-absolute forms still fail
  const upstreamHtml = 'resources/bin/license-notices/aria2/README.html'
  const up = cloneFiles(files)
  const regUp = JSON.parse(files.get('resources/bin/license-provenance.json').toString('utf8'))
  regUp.materials.push({
    path: upstreamHtml,
    packagedPath: upstreamHtml.replace('resources/', ''),
    sha256: '0'.repeat(64),
    transformation: 'verbatim byte copy'
  })
  up.set('resources/bin/license-provenance.json', TEXT(JSON.stringify(regUp, null, 2) + '\n'))
  up.set(
    upstreamHtml,
    TEXT('<p>see <a href="CONTRIBUTING.md">x</a> and <a href="README.mingw">r</a></p>\n')
  )
  const r1 = checkLocalLinks({ policy: REAL_POLICY, files: up })
  assert.equal(subOf(r1, 'targets-exist').status, STATUS.PASS)
  assert.ok(r1.evidenceBody.upstreamVerbatim.files.includes(upstreamHtml))
  assert.equal(r1.evidenceBody.upstreamVerbatim.missing.length, 2)
  assert.ok(!r1.evidenceBody.missing.some((m) => m.path === upstreamHtml))
  // the same html file outside the verbatim set is a candidate defect
  const notUp = cloneFiles(up)
  notUp.set(
    'resources/bin/license-provenance.json',
    files.get('resources/bin/license-provenance.json')
  )
  assert.equal(
    subOf(checkLocalLinks({ policy: REAL_POLICY, files: notUp }), 'targets-exist').reasonCode,
    'LINK_TARGET_MISSING'
  )
  up.set(upstreamHtml, TEXT('<a href="C:\\Users\\a\\b.md">x</a>\n'))
  assert.equal(
    subOf(checkLocalLinks({ policy: REAL_POLICY, files: up }), 'no-machine-absolute').status,
    STATUS.FAIL
  )
})

test('I-11/external links: pending without evidence, per-url results required, deferred push links only when exact, admitted at pre-push but not pre-release', () => {
  const external = [
    { path: 'README.md', line: 3, syntax: 'markdown-inline', url: 'https://example.com/upstream' },
    {
      path: 'SECURITY.md',
      line: 9,
      syntax: 'markdown-inline',
      url: 'https://github.com/lie-dream/DownLord/security/advisories/new'
    }
  ]
  const digest = sourceJson(fxS, SID).candidate.digest
  const none = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: null,
    candidateDigest: digest
  })
  assert.equal(subOf(none, 'per-url-result').status, STATUS.PENDING)
  assert.equal(subOf(none, 'per-url-result').reasonCode, 'EXTERNAL_EVIDENCE_MISSING')
  const ev = (results, extra = {}) => ({
    schemaVersion: 1,
    candidateDigest: digest,
    results,
    ...extra
  })
  const passRow = (url) => ({
    url,
    status: 'PASS',
    checkedAt: '2026-09-19T00:00:00Z',
    checkedBy: 'operator',
    httpStatus: 200,
    finalUrl: url
  })
  const all = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev(external.map((e) => passRow(e.url))),
    candidateDigest: digest
  })
  assert.deepEqual(statusMap(all), { 'per-url-result': 'PASS', 'deferred-entries-exact': 'PASS' })
  const partial = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev([passRow(external[0].url)]),
    candidateDigest: digest
  })
  assert.equal(subOf(partial, 'per-url-result').status, STATUS.PENDING)
  assert.equal(
    subOf(partial, 'per-url-result').detail.results.find((r) => r.url === external[1].url)
      .reasonCode,
    'URL_RESULT_MISSING'
  )
  const unbound = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev(external.map((e) => ({ url: e.url, status: 'PASS' }))),
    candidateDigest: digest
  })
  assert.equal(
    subOf(unbound, 'per-url-result').status,
    STATUS.PENDING,
    'a PASS without checkedAt/checkedBy is not a result'
  )
  const failed = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev([
      passRow(external[0].url),
      { ...passRow(external[1].url), status: 'FAIL', httpStatus: 404 }
    ]),
    candidateDigest: digest
  })
  assert.equal(subOf(failed, 'per-url-result').status, STATUS.FAIL)
  const errored = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev([passRow(external[0].url), { ...passRow(external[1].url), status: 'ERROR' }]),
    candidateDigest: digest
  })
  assert.equal(subOf(errored, 'per-url-result').status, STATUS.ERROR)
  const mismatch = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev(
      external.map((e) => passRow(e.url)),
      { candidateDigest: 'x' }
    ),
    candidateDigest: digest
  })
  assert.equal(subOf(mismatch, 'per-url-result').reasonCode, 'EXTERNAL_EVIDENCE_CANDIDATE_MISMATCH')
  const invalid = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: { __parseError: true },
    candidateDigest: digest
  })
  assert.equal(subOf(invalid, 'per-url-result').status, STATUS.ERROR)
  // deferred: exact registration in policy + dependsOnPush → DEFERRED_PUSH_LINK; not registered / host-wide / release asset → FAIL
  const deferredPolicy = JSON.parse(JSON.stringify(REAL_POLICY))
  deferredPolicy.linkRules.externalLinks.deferredPushLinks = [external[1].url]
  const deferredRow = {
    url: external[1].url,
    status: 'DEFERRED_PUSH_LINK',
    checkedAt: '2026-09-19T00:00:00Z',
    checkedBy: 'operator',
    dependsOnPush: true
  }
  const def = checkExternalLinks({
    policy: deferredPolicy,
    external,
    evidence: ev([passRow(external[0].url), deferredRow]),
    candidateDigest: digest
  })
  assert.equal(subOf(def, 'per-url-result').status, STATUS.DEFERRED_PUSH_LINK)
  assert.equal(subOf(def, 'deferred-entries-exact').status, STATUS.PASS)
  const notExact = checkExternalLinks({
    policy: REAL_POLICY,
    external,
    evidence: ev([passRow(external[0].url), deferredRow]),
    candidateDigest: digest
  })
  assert.equal(subOf(notExact, 'deferred-entries-exact').reasonCode, 'DEFERRED_ENTRY_NOT_EXACT')
  for (const badUrl of [
    'https://github.com/lie-dream/DownLord/releases/download/v1.0.0/x.exe',
    'https://github.com/lie-dream/*',
    'https://github.com/other/DownLord/x'
  ]) {
    const p2 = JSON.parse(JSON.stringify(REAL_POLICY))
    p2.linkRules.externalLinks.deferredPushLinks = [badUrl]
    const ext2 = [{ path: 'README.md', line: 1, syntax: 'markdown-inline', url: badUrl }]
    const r = checkExternalLinks({
      policy: p2,
      external: ext2,
      evidence: ev([{ ...deferredRow, url: badUrl }]),
      candidateDigest: digest
    })
    assert.equal(subOf(r, 'deferred-entries-exact').status, STATUS.FAIL, badUrl)
  }
  // stage aggregation: DEFERRED admits pre-push only
  for (const [stage, exit] of [
    ['pre-push', 0],
    ['pre-release', 2]
  ]) {
    const results = fullPass(stage)
    results.set('external-links', { subchecks: def.subchecks })
    const rep = buildStageReport({ policy: REAL_POLICY, stage, results, context: ctx })
    assert.equal(rep.exitCode, exit, stage)
  }
})

test('I-13/I-14 licence materials: registry hashes verified byte for byte; missing, altered, conflated extraction hash, incomplete GPL text and missing notices copy all fail', () => {
  const { files } = cand()
  const ok = checkLicenseMaterials({ policy: REAL_POLICY, files })
  assert.deepEqual(statusMap(ok), {
    'materials-present': 'PASS',
    'hashes-match-provenance': 'PASS',
    'notices-consistent': 'PASS'
  })
  assert.ok(ok.evidenceBody.materials.length >= 6)
  const reg = JSON.parse(files.get('resources/bin/license-provenance.json').toString('utf8'))
  const withReg = (mutate) => {
    const f = cloneFiles(files)
    const r = JSON.parse(JSON.stringify(reg))
    mutate(f, r)
    f.set('resources/bin/license-provenance.json', TEXT(JSON.stringify(r, null, 2) + '\n'))
    return checkLicenseMaterials({ policy: REAL_POLICY, files: f })
  }
  const missing = cloneFiles(files)
  missing.delete('resources/bin/aria2-LICENSE.txt')
  assert.equal(
    subOf(checkLicenseMaterials({ policy: REAL_POLICY, files: missing }), 'materials-present')
      .reasonCode,
    'LICENSE_MATERIAL_MISSING'
  )
  const altered = cloneFiles(files)
  altered.set('resources/bin/aria2-LICENSE.txt', TEXT('changed\n'))
  const a = checkLicenseMaterials({ policy: REAL_POLICY, files: altered })
  assert.equal(subOf(a, 'hashes-match-provenance').reasonCode, 'LICENSE_MATERIAL_HASH_MISMATCH')
  assert.equal(
    subOf(a, 'hashes-match-provenance').detail.mismatch[0].path,
    'resources/bin/aria2-LICENSE.txt'
  )
  const conflated = withReg((f, r) => {
    r.gplExtraction.extractedSha256 = r.gplExtraction.sourceSha256
  })
  assert.ok(
    subOf(conflated, 'notices-consistent').detail.problems.some(
      (p) =>
        p.kind === 'gpl-extraction-target-mismatch' || p.kind === 'gpl-extraction-hash-conflated'
    )
  )
  const incomplete = withReg((f, r) => {
    f.set('resources/bin/yt-dlp-LICENSE.txt', TEXT('GNU GENERAL PUBLIC LICENSE\n0. Definitions.\n'))
    r.gplExtraction.extractedSha256 = sha256(TEXT('GNU GENERAL PUBLIC LICENSE\n0. Definitions.\n'))
    r.materials.find((m) => m.path === 'resources/bin/yt-dlp-LICENSE.txt').sha256 =
      r.gplExtraction.extractedSha256
  })
  assert.ok(
    subOf(incomplete, 'notices-consistent').detail.problems.some(
      (p) => p.kind === 'gpl-extraction-incomplete'
    )
  )
  const noCopy = cloneFiles(files)
  noCopy.set(
    'electron-builder.yml',
    TEXT('appId: x\nextraResources:\n  - from: resources/bin\n    to: bin\n')
  )
  assert.ok(
    subOf(
      checkLicenseMaterials({ policy: REAL_POLICY, files: noCopy }),
      'notices-consistent'
    ).detail.problems.some((p) => p.kind === 'extra-resources-missing')
  )
  const unparseable = cloneFiles(files)
  unparseable.set('resources/bin/license-provenance.json', TEXT('{ not json'))
  assert.ok(
    checkLicenseMaterials({ policy: REAL_POLICY, files: unparseable }).subchecks.every(
      (s) => s.status === STATUS.FAIL && s.reasonCode === 'PROVENANCE_REGISTRY_UNPARSEABLE'
    )
  )
})

const gateRun = (exitCode, extra = {}) => ({
  command: 'npm run x',
  exitCode,
  status: exitCode === 0 ? 'PASS' : 'FAIL',
  startedAt: '2026-09-19T00:00:00Z',
  finishedAt: '2026-09-19T00:01:00Z',
  ...extra
})
const gateEvidenceFor = (commit, mutate = () => {}) => {
  const ev = {
    schemaVersion: 1,
    commit,
    runs: {
      gate: gateRun(0),
      'scan-secrets': gateRun(0),
      'scan-licenses': gateRun(0),
      'audit-todo': gateRun(0)
    }
  }
  mutate(ev)
  return ev
}
const releaseTestsFor = (commit, mutate = () => {}) => {
  const ev = {
    schemaVersion: 1,
    commit,
    command: 'npm run test:release',
    exitCode: 0,
    counts: { tests: 90, pass: 90, fail: 0, skipped: 0 },
    finishedAt: '2026-09-19T00:02:00Z'
  }
  mutate(ev)
  return ev
}
const deltaFor = (commit, digest, mutate = () => {}) => {
  const ev = {
    schemaVersion: 1,
    commit,
    candidateDigest: digest,
    items: REQUIRED_DELTA_ITEMS.map((id) => ({
      id,
      object: 'fixture',
      input: 'fixture',
      canRun: id !== 'todo-stripped-candidate' && id !== 'prompt-stripped-candidate',
      coverage: 'fixture',
      conclusion: 'fixture',
      timepoint: '2026-09-19',
      evidence: 'fixture',
      pushBlocker: false,
      resolved: true
    }))
  }
  mutate(ev)
  return ev
}

test('I-17/internal gate and release-test evidence: missing is PENDING, bound to another commit fails, exit 1 fails, execution error is ERROR, counts must be real', () => {
  const commit = sourceJson(fxS, SID).commit
  const none = checkInternalGate({ gateEvidence: null, releaseTestsEvidence: null, commit })
  assert.ok(none.subchecks.every((s) => s.status === STATUS.PENDING))
  const ok = checkInternalGate({
    gateEvidence: gateEvidenceFor(commit),
    releaseTestsEvidence: releaseTestsFor(commit),
    commit
  })
  assert.ok(
    ok.subchecks.every((s) => s.status === STATUS.PASS),
    JSON.stringify(ok.subchecks)
  )
  const other = checkInternalGate({
    gateEvidence: gateEvidenceFor('0'.repeat(40)),
    releaseTestsEvidence: releaseTestsFor('0'.repeat(40)),
    commit
  })
  assert.ok(other.subchecks.every((s) => s.reasonCode === 'EVIDENCE_COMMIT_MISMATCH'))
  const failed = checkInternalGate({
    gateEvidence: gateEvidenceFor(commit, (e) => (e.runs['scan-secrets'] = gateRun(1))),
    releaseTestsEvidence: releaseTestsFor(commit),
    commit
  })
  assert.equal(subOf(failed, 'scan-secrets').status, STATUS.FAIL)
  assert.equal(subOf(failed, 'gate').status, STATUS.PASS)
  const enoent = checkInternalGate({
    gateEvidence: gateEvidenceFor(
      commit,
      (e) => (e.runs['audit-todo'] = gateRun(1, { status: 'ERROR', error: 'ENOENT docs/TODO.md' }))
    ),
    releaseTestsEvidence: releaseTestsFor(commit),
    commit
  })
  assert.equal(subOf(enoent, 'audit-todo').status, STATUS.ERROR)
  assert.equal(subOf(enoent, 'audit-todo').reasonCode, 'RUN_EXECUTION_ERROR')
  const missingRun = checkInternalGate({
    gateEvidence: gateEvidenceFor(commit, (e) => delete e.runs['scan-licenses']),
    releaseTestsEvidence: releaseTestsFor(commit),
    commit
  })
  assert.equal(subOf(missingRun, 'scan-licenses').status, STATUS.PENDING)
  const fake = checkInternalGate({
    gateEvidence: gateEvidenceFor(commit),
    releaseTestsEvidence: releaseTestsFor(
      commit,
      (e) => (e.counts = { tests: 0, pass: 0, fail: 0 })
    ),
    commit
  })
  assert.equal(subOf(fake, 'test-release').reasonCode, 'RELEASE_TESTS_COUNTS_INVALID')
  const invalid = checkInternalGate({
    gateEvidence: { passed: true },
    releaseTestsEvidence: { passed: true },
    commit
  })
  assert.ok(invalid.subchecks.every((s) => s.status === STATUS.ERROR))
})

test('I-17/validation delta: every required item listed with its fields; a candidate contradiction or an unresolved push blocker fails', () => {
  const commit = sourceJson(fxS, SID).commit
  const digest = sourceJson(fxS, SID).candidate.digest
  const { files } = cand()
  const none = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: null,
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(subOf(none, 'delta-items-listed').status, STATUS.PENDING)
  assert.deepEqual(subOf(none, 'delta-items-listed').detail.required, [...REQUIRED_DELTA_ITEMS])
  const ok = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor(commit, digest),
    files,
    commit,
    candidateDigest: digest
  })
  assert.deepEqual(statusMap(ok), {
    'delta-items-listed': 'PASS',
    'no-unresolved-push-blocker': 'PASS'
  })
  const missing = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor(commit, digest, (e) => e.items.splice(0, 1)),
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(subOf(missing, 'delta-items-listed').reasonCode, 'DELTA_ITEM_MISSING')
  assert.deepEqual(subOf(missing, 'delta-items-listed').detail.missing, ['internal-gate'])
  const fieldless = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor(commit, digest, (e) => delete e.items[3].coverage),
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(
    subOf(fieldless, 'delta-items-listed').detail.incomplete[0].id,
    REQUIRED_DELTA_ITEMS[3]
  )
  const lie = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor(
      commit,
      digest,
      (e) => (e.items.find((i) => i.id === 'todo-stripped-candidate').canRun = true)
    ),
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(subOf(lie, 'delta-items-listed').reasonCode, 'DELTA_CONTRADICTS_CANDIDATE')
  const blocker = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor(commit, digest, (e) =>
      Object.assign(e.items[0], { pushBlocker: true, resolved: false })
    ),
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(subOf(blocker, 'no-unresolved-push-blocker').reasonCode, 'UNRESOLVED_PUSH_BLOCKER')
  const moved = checkValidationDelta({
    policy: REAL_POLICY,
    evidence: deltaFor('0'.repeat(40), digest),
    files,
    commit,
    candidateDigest: digest
  })
  assert.equal(subOf(moved, 'delta-items-listed').reasonCode, 'EVIDENCE_COMMIT_MISMATCH')
})

test('I-17/the real TODO audit: missing TODO is an uncaught ENOENT (non-zero), missing prompt directory is pending (exit 0), a prompt without the number is one-way (exit 1)', () => {
  const auditScript = path.join(REPO_ROOT, 'scripts', 'audit-todo-assignments.mjs')
  const run = (cwd) =>
    spawnSync(process.execPath, [auditScript], { cwd, encoding: 'utf8', windowsHide: true })
  const noTodo = run(candidateDir(fxS, SID))
  assert.notEqual(noTodo.status, 0)
  assert.match(noTodo.stderr, /ENOENT/)
  const tmp = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'step6b-audit-'))
  TEMP_DIRS.push(tmp)
  const todo = ['# TODO', '', '### 7. 示例 — 🚧 v9.9 Task 3 指派', '', '- 说明', ''].join('\n')
  writeFiles(tmp, new Map([['docs/TODO.md', TEXT(todo)]]))
  const pending = run(tmp)
  assert.equal(pending.status, 0)
  assert.match(pending.stdout, /待认领 1 条/)
  writeFiles(tmp, new Map([['docs/v9.9/prompt/task3-x.md', TEXT('# prompt without the number\n')]]))
  const oneWay = run(tmp)
  assert.equal(oneWay.status, 1)
  assert.match(oneWay.stdout, /单向指针 1 条/)
  writeFiles(
    tmp,
    new Map([['docs/v9.9/prompt/task3-x.md', TEXT('# prompt\n\n认领的 backlog #7\n')]])
  )
  assert.equal(run(tmp).status, 0)
})

test('I-18/candidate hygiene: every forbiddenInPackage path is already a strip or forbidden rule and none of them survives in the candidate', () => {
  const { files } = cand()
  for (const p of REAL_POLICY.artifactRules.forbiddenInPackage) {
    const cls = classifyPath(p.endsWith('/') ? p + 'x' : p, REAL_POLICY)
    assert.ok(cls.stripped || cls.forbidden, `${p} must be covered by the strip / forbidden rules`)
    assert.ok(![...files.keys()].some((f) => f === p || f.startsWith(p)), p)
  }
  assert.ok(
    ![...files.keys()].some(
      (f) =>
        f.startsWith('.tmp-probe/') || f.startsWith('publish/') || f.startsWith('node_modules/')
    )
  )
})

test('I-19/metadata contract: version, lock, author, engines and update targets; each broken field is located', () => {
  const { files } = cand()
  const ok = checkMetadataContract({ policy: REAL_POLICY, files })
  assert.deepEqual(statusMap(ok), {
    'package-version': 'PASS',
    'lock-version': 'PASS',
    author: 'PASS',
    'engines-npm': 'PASS',
    'update-targets': 'PASS'
  })
  const pkg = JSON.parse(files.get('package.json').toString('utf8'))
  const withPkg = (mut) => {
    const f = cloneFiles(files)
    const p = JSON.parse(JSON.stringify(pkg))
    mut(p, f)
    f.set('package.json', TEXT(JSON.stringify(p, null, 2) + '\n'))
    return checkMetadataContract({ policy: REAL_POLICY, files: f })
  }
  assert.equal(
    subOf(
      withPkg((p) => (p.version = '1.0.0-rc.1')),
      'package-version'
    ).reasonCode,
    'PACKAGE_VERSION_INVALID'
  )
  assert.equal(
    subOf(
      withPkg((p) => (p.version = '1.0.1')),
      'lock-version'
    ).reasonCode,
    'LOCK_VERSION_MISMATCH'
  )
  const a = withPkg((p) => (p.author = 'lie-dream <someone@private.example.invalid>'))
  assert.equal(subOf(a, 'author').reasonCode, 'AUTHOR_FIELD_MISMATCH')
  assert.ok(!JSON.stringify(a).includes('private.example.invalid'))
  assert.equal(
    subOf(
      withPkg((p) => (p.engines.npm = '>=10')),
      'engines-npm'
    ).reasonCode,
    'ENGINES_NPM_MISMATCH'
  )
  const owner = withPkg((p, f) =>
    f.set('dev-app-update.yml', TEXT('provider: github\nowner: someone-else\nrepo: DownLord\n'))
  )
  assert.equal(subOf(owner, 'update-targets').reasonCode, 'UPDATE_TARGET_MISMATCH')
  assert.equal(subOf(owner, 'update-targets').detail.problems[0].file, 'dev-app-update.yml')
  const manifest = withPkg((p, f) =>
    f.set('extension/manifest.json', TEXT('{ "manifest_version": 3, "version": "1.0.0" }\n'))
  )
  assert.equal(
    subOf(manifest, 'update-targets').detail.problems[0].reason,
    'source-manifest-must-not-carry-version'
  )
  const lockBroken = cloneFiles(files)
  lockBroken.set('package-lock.json', TEXT('{ broken'))
  assert.equal(
    subOf(checkMetadataContract({ policy: REAL_POLICY, files: lockBroken }), 'lock-version').status,
    STATUS.ERROR
  )
})

const manualFor = (files, digest, mutate = () => {}) => {
  const row = (p, extra = {}) => ({ path: p, sha256: sha256(files.get(p)), ...extra })
  const ev = {
    schemaVersion: 1,
    reviews: [
      {
        id: 'public-documents',
        reviewer: 'lie-dream',
        reviewedAt: '2026-09-19',
        candidateDigest: digest,
        result: 'PASS',
        files: REAL_POLICY.publicDocuments.documents.map((d) => row(d.targetPath))
      },
      {
        id: 'readme-community',
        reviewer: 'lie-dream',
        reviewedAt: '2026-09-19',
        candidateDigest: digest,
        result: 'PASS',
        files: [
          'README.md',
          'SECURITY.md',
          'CHANGELOG.md',
          'LICENSE',
          'THIRD-PARTY-NOTICES.md',
          'extension/README.md'
        ]
          .filter((p) => files.has(p))
          .map((p) => row(p))
      },
      {
        id: 'screenshots',
        reviewer: 'lie-dream',
        reviewedAt: '2026-09-19',
        candidateDigest: digest,
        result: 'PASS',
        files: [...files.keys()]
          .filter((p) => p.startsWith('docs/assets/screenshots/') && p.endsWith('.png'))
          .map((p) =>
            row(p, { privacy: 'reviewed', metadataReviewed: true, source: 'real-capture' })
          )
      }
    ]
  }
  mutate(ev)
  return ev
}

test('I-20/manual reviews: bound to content hashes and a human reviewer; stale hash, automated reviewer, missing privacy fields, synthetic source and non-PASS result all fail', () => {
  const { files } = cand()
  const digest = sourceJson(fxS, SID).candidate.digest
  const none = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: null,
    candidateDigest: digest
  })
  assert.ok(none.subchecks.every((s) => s.status === STATUS.PENDING))
  const ok = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest),
    candidateDigest: digest
  })
  assert.deepEqual(statusMap(ok), {
    'public-documents-reviewed': 'PASS',
    'readme-community-reviewed': 'PASS',
    'screenshots-reviewed': 'PASS'
  })
  const stale = cloneFiles(files)
  stale.set('README.md', TEXT('# changed after review\n'))
  const st = checkManualChecks({
    policy: REAL_POLICY,
    files: stale,
    evidence: manualFor(files, digest),
    candidateDigest: digest
  })
  assert.equal(subOf(st, 'readme-community-reviewed').reasonCode, 'REVIEW_STALE')
  assert.equal(subOf(st, 'public-documents-reviewed').status, STATUS.PASS)
  const ai = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest, (e) => (e.reviews[2].reviewer = 'Claude (assistant)')),
    candidateDigest: digest
  })
  assert.equal(subOf(ai, 'screenshots-reviewed').reasonCode, 'REVIEWER_INVALID')
  const noPriv = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest, (e) => e.reviews[2].files.forEach((f) => delete f.privacy)),
    candidateDigest: digest
  })
  assert.equal(subOf(noPriv, 'screenshots-reviewed').reasonCode, 'REVIEW_FIELD_INVALID')
  const synthetic = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest, (e) => (e.reviews[2].files[0].source = 'generated')),
    candidateDigest: digest
  })
  assert.equal(subOf(synthetic, 'screenshots-reviewed').reasonCode, 'REVIEW_FIELD_INVALID')
  const failed = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest, (e) => (e.reviews[0].result = 'FAIL')),
    candidateDigest: digest
  })
  assert.equal(subOf(failed, 'public-documents-reviewed').reasonCode, 'REVIEW_RESULT_NOT_PASS')
  const partial = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, digest, (e) => e.reviews[0].files.pop()),
    candidateDigest: digest
  })
  assert.equal(subOf(partial, 'public-documents-reviewed').reasonCode, 'REVIEW_INCOMPLETE')
  const other = checkManualChecks({
    policy: REAL_POLICY,
    files,
    evidence: manualFor(files, 'other-digest'),
    candidateDigest: digest
  })
  assert.equal(subOf(other, 'screenshots-reviewed').reasonCode, 'REVIEW_CANDIDATE_MISMATCH')
  const noShots = cloneFiles(files)
  for (const p of [...noShots.keys()])
    if (p.startsWith('docs/assets/screenshots/')) noShots.delete(p)
  assert.equal(
    subOf(
      checkManualChecks({
        policy: REAL_POLICY,
        files: noShots,
        evidence: manualFor(files, digest),
        candidateDigest: digest
      }),
      'screenshots-reviewed'
    ).reasonCode,
    'NO_SCREENSHOTS_IN_CANDIDATE'
  )
})

test('I-12/with every operator evidence file and an independent public repository the pre-push stage admits and pre-release still waits for the post-push items', async () => {
  const src = sourceJson(fxS, SID)
  const { files } = cand()
  const evDir = path.join(fxS.releaseDir(SID), 'evidence')
  const pub = makePublicRepo(fxS, 'stage-public', candidateDir(fxS, SID))
  writeBaseline(fxS, SID, BASELINE_ROOT)
  const links = checkLocalLinks({ policy: REAL_POLICY, files })
  const urls = [...new Set(links.external.map((e) => e.url))]
  const write = (name, body) =>
    fs.writeFileSync(path.join(evDir, name), JSON.stringify(body, null, 2) + '\n')
  write('external-links.json', {
    schemaVersion: 1,
    candidateDigest: src.candidate.digest,
    results: urls.map((u) => ({
      url: u,
      status: 'PASS',
      checkedAt: '2026-09-19T00:00:00Z',
      checkedBy: 'operator',
      httpStatus: 200,
      finalUrl: u
    }))
  })
  write('internal-gate.json', gateEvidenceFor(src.commit))
  write('release-tests.json', releaseTestsFor(src.commit))
  write('validation-delta.json', deltaFor(src.commit, src.candidate.digest))
  write('manual-checks.json', manualFor(files, src.candidate.digest))
  const before = snapshotDir(pub)
  const res = await runCli(fxS, [
    'check',
    '--release-id',
    SID,
    '--stage',
    'pre-push',
    '--public-repo',
    pub
  ])
  assert.equal(
    res.code,
    EXIT.ADMITTED,
    JSON.stringify(
      res.report.checks
        .filter((c) => c.status !== STATUS.PASS && c.status !== STATUS.NOT_APPLICABLE)
        .map((c) => [c.id, c.subchecks])
    )
  )
  assert.equal(res.report.admission, 'push-admissible')
  assert.ok(res.out.some((l) => l.includes('push-admissible')))
  assertSameSnapshot(before, snapshotDir(pub), 'public repository untouched by check')
  for (const id of REAL_POLICY.checks
    .filter((c) => c.stages['pre-push'] === 'required')
    .map((c) => c.id))
    assert.equal(check(res.report, id).status, STATUS.PASS, id)
  const rel = await runCli(fxS, [
    'check',
    '--release-id',
    SID,
    '--stage',
    'pre-release',
    '--public-repo',
    pub
  ])
  assert.equal(rel.code, EXIT.INCOMPLETE)
  assert.equal(rel.report.admission, null)
  for (const id of [
    'public-ci',
    'artifact-origin',
    'package-materials',
    'security-channel',
    'task6-acceptance'
  ])
    assert.equal(check(rel.report, id).status, STATUS.UNCHECKED, id)
  // a single stale manual review flips the admitted stage back to FAIL / exit 1
  write(
    'manual-checks.json',
    manualFor(files, src.candidate.digest, (e) => (e.reviews[2].files[0].sha256 = '0'.repeat(64)))
  )
  const again = await runCli(fxS, [
    'check',
    '--release-id',
    SID,
    '--stage',
    'pre-push',
    '--public-repo',
    pub
  ])
  assert.equal(again.code, EXIT.VIOLATION)
  assert.equal(
    sub(again.report, 'manual-checks', 'screenshots-reviewed').reasonCode,
    'REVIEW_STALE'
  )
  for (const n of [
    'external-links.json',
    'internal-gate.json',
    'release-tests.json',
    'validation-delta.json',
    'manual-checks.json'
  ])
    fs.rmSync(path.join(evDir, n))
})

test('I-08/the candidate scan runs the frozen scanner source with the policy strip rules, never the working-tree file', async () => {
  // change the working-tree scanner (uncommitted) → source freeze fails first; the candidate scan must still read the frozen blob
  const scannerPath = fxS.abs('scripts/scan-secrets.mjs')
  const original = fs.readFileSync(scannerPath)
  fs.writeFileSync(scannerPath, Buffer.concat([original, TEXT('\n// working tree edit\n')]))
  try {
    const res = await runCli(fxS, ['check', '--release-id', SID, '--stage', 'pre-push'])
    assert.equal(sub(res.report, 'source', 'clean-worktree').reasonCode, 'WORKTREE_DIRTY')
    assert.equal(
      check(res.report, 'candidate-secrets').status,
      STATUS.PASS,
      'frozen scanner still runs'
    )
  } finally {
    fs.writeFileSync(scannerPath, original)
  }
  const s = runCandidateSecrets({
    scannerSource: REAL_SCANNER_BUF.toString('utf8'),
    policy: REAL_POLICY,
    files: cand().files,
    internalRoot: fxS.root,
    username: FIX_USER
  })
  assert.equal(s.executionError, null)
  assert.deepEqual(
    s.state.rules.filter((r) => r.off),
    []
  )
  assert.equal(s.state.coverage.history.uniqueBlobs, 0, 'no git history is read for a candidate')
})
