import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, runInNewContext } from 'node:vm'

type Entry = {
  rule: string
  file: string
  sha: string
  desc: string
  verdict: string
  why: string
  scope?: string
}
type Hit = {
  rule: string
  file: string
  sha: string
  where: string
  source?: { kind: string; blob?: string; inputSha256?: string }
}
type HistoryInput = { file: string; text: string | Buffer; type?: string }
type Skipped = { file: string; reason: string; bytes?: number; blob?: string }
type Coverage = {
  maxBytes: number
  workspace: { candidateFiles: number; scannedFiles: number; skipped: Skipped[] }
  history: { listedObjects: number; uniqueBlobs: number; scannedBlobs: number; skipped: Skipped[] }
}
type Options = {
  files?: Record<string, string | Buffer>
  tracked?: string[]
  untracked?: string[]
  history?: HistoryInput[]
  registry?: Entry[]
  gitFailure?: string
  unreadable?: string
  /** Served to readFileSync/statSync only; never tracked, walked or scanned (policy, proofs). */
  hidden?: Record<string, string | Buffer>
  /** Sole release policy text; undefined = real policy from disk, null = absent. */
  policy?: string | null
  /** Identity override for the isolated run (default: the fixture operator). */
  username?: string
  /** Make the index enumeration (ls-files -s) fail so the source set cannot be verified. */
  sourceSetFailure?: boolean
}
type DispositionRecord = {
  rule: string
  file: string
  sha?: string
  status: string
  problems: string[]
  disposed: { workspace: number; history: number }
}
type DispositionState = {
  path: string | null
  status: string
  sha256: string | null
  problems: { code: string }[]
  records: DispositionRecord[]
  sourceSet: { sha256?: string; count?: number; error?: string } | null
}
type ScanResult = {
  exitCode: number
  executionError: string | null
  open: Hit[]
  stale: Entry[]
  findings: Hit[]
  ackSeen: { key: string; hits: Hit[] }[]
  coverage: Coverage | null
  logs: string
  commands: string[][]
  reads: string[]
  internalDispositions: DispositionState | null
  policyError: string | null
}
const scannerSource = readFileSync(new URL('./scan-secrets.mjs', import.meta.url), 'utf8')
const POLICY_FILE = 'scripts/release-policy.json'
const realPolicyPath = fileURLToPath(new URL('./release-policy.json', import.meta.url))
const realPolicyText = readFileSync(realPolicyPath, 'utf8')
const blobOid = (buffer: Buffer): string =>
  createHash('sha1')
    .update('blob ' + buffer.length + String.fromCharCode(0))
    .update(buffer)
    .digest('hex')
const registryPattern = /const ADJUDICATED = (\[[\s\S]*?\n\])/
const registryMatch = scannerSource.match(registryPattern)
assert.ok(registryMatch, 'The exact-instance registry must remain inspectable')
const registry = JSON.parse(JSON.stringify(runInNewContext(registryMatch[1]))) as Entry[]
const digest = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const shortHash = (s: string): string => digest(s).slice(0, 12)
const key = (r: Pick<Entry, 'rule' | 'file' | 'sha'>): string => [r.rule, r.file, r.sha].join('|')
const virtualRoot = '/FixtureLab/Workspace/SourceRepo'
const NULSEP = String.fromCharCode(0)
const virtualUser = 'fixture-operator'
const locatorFile = 'src/main/binaries/locator.test.ts'
const inboundFile = 'src/main/bt/inboundDiagnosis.test.ts'
const probeFile = 'src/probe/scanner-fixture.ts'
const v6 = (...groups: string[]): string => groups.join(':')
const fullV6 = v6('2abc', '1357', '2468', 'acdc', '1a2b', '3c4d', '5e6f', '1234')
const prefixV6 = v6('2abc', '1357', '2468', 'acdc', '', '1')
const docV6 = v6('2001', 'db8', '1234', '5678', '9abc', 'def0', '1234', '5678')
const docPrefixV6 = v6('2001', 'db8', '1234', '5678', '', '1')
const falseKeys = ['eb709fb88435', '7949f53b4fd0', '31c8ed0d2b19']
const falseEntries = registry.filter(
  (r) => r.rule === 'R12' && r.file === inboundFile && falseKeys.includes(r.sha)
)
const inboundSource = readFileSync(
  new URL('../src/main/bt/inboundDiagnosis.test.ts', import.meta.url),
  'utf8'
)
const inboundLiterals = [...inboundSource.matchAll(/'([0-9a-fA-F:]+)'/g)].map((m) => m[1])
const falseValues = falseEntries.map((r) => {
  const value = inboundLiterals.find((s) => shortHash(s) === r.sha)
  assert.ok(value, 'A preserved transition-address fixture is missing: ' + r.sha)
  return value
})
const removedFour = [
  { rule: 'R10', file: locatorFile, sha: '39115dd5c160' },
  { rule: 'R11', file: locatorFile, sha: '35daaebcd715' },
  { rule: 'R12', file: inboundFile, sha: 'a885246e0c2b' },
  { rule: 'R12', file: inboundFile, sha: 'e2e136951369' }
]

/** Execute the real default reading/classification/reporting chain. Only I/O, identity,
 * and an exact fixture registry are isolated; no rule or classification is replaced.
 * Git responses are read-only models: no bad commits, candidate CLI, or real identities. */
function runScanner(options: Options = {}): ScanResult {
  const files = new Map(
    Object.entries(options.files ?? {}).map(([file, text]) => [file, Buffer.from(text)])
  )
  const hidden = new Map(
    Object.entries(options.hidden ?? {}).map(([file, text]) => [file, Buffer.from(text)])
  )
  if (options.policy !== null && !files.has(POLICY_FILE) && !hidden.has(POLICY_FILE))
    hidden.set(POLICY_FILE, Buffer.from(options.policy ?? realPolicyText))
  const tracked = options.tracked ?? [...files.keys()]
  const untracked = options.untracked ?? []
  const rows = (options.history ?? []).map((row) => {
    const buffer = Buffer.from(row.text)
    const type = row.type ?? 'blob'
    const oid = createHash('sha1')
      .update(type + ' ' + buffer.length + String.fromCharCode(0))
      .update(buffer)
      .digest('hex')
    return { ...row, buffer, type, oid }
  })
  const commands: string[][] = []
  const reads: string[] = []
  const relativeFile = (file: string): string => {
    const rel = path.posix.relative(virtualRoot, file)
    assert.ok(
      rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel),
      'Fixture read escaped its root'
    )
    return rel
  }
  const getFile = (file: string): Buffer => {
    const rel = relativeFile(file)
    if (rel === options.unreadable)
      throw Object.assign(new Error('Synthetic read failure'), { code: 'EACCES' })
    const buffer = files.get(rel) ?? hidden.get(rel)
    if (!buffer) throw Object.assign(new Error('Synthetic missing input'), { code: 'ENOENT' })
    return buffer
  }
  const git = (
    command: string,
    args: string[],
    opts: { cwd: string; input?: Buffer }
  ): { status: number; stdout: string | Buffer; stderr: string | Buffer } => {
    assert.equal(command, 'git')
    assert.equal(opts.cwd, virtualRoot)
    commands.push(args)
    if (options.gitFailure === args[0])
      return {
        status: 128,
        stdout: args[0] === 'cat-file' ? Buffer.alloc(0) : '',
        stderr: 'Synthetic git failure'
      }
    if (JSON.stringify(args) === JSON.stringify(['ls-files', '-z']))
      return { status: 0, stdout: tracked.join('\0'), stderr: '' }
    if (
      JSON.stringify(args) === JSON.stringify(['ls-files', '--others', '--exclude-standard', '-z'])
    )
      return { status: 0, stdout: untracked.join('\0'), stderr: '' }
    if (JSON.stringify(args) === JSON.stringify(['rev-list', '--objects', '--all']))
      return { status: 0, stdout: rows.map((r) => r.oid + ' ' + r.file).join('\n'), stderr: '' }
    if (JSON.stringify(args) === JSON.stringify(['ls-files', '-s', '-z']))
      return options.sourceSetFailure
        ? { status: 128, stdout: '', stderr: 'Synthetic index failure' }
        : {
            status: 0,
            stdout: tracked
              .map(
                (file) => '100644 ' + blobOid(files.get(file) ?? Buffer.alloc(0)) + ' 0\t' + file
              )
              .join(NULSEP),
            stderr: ''
          }
    if (JSON.stringify(args) === JSON.stringify(['cat-file', '--batch'])) {
      const requested = opts.input!.toString('utf8').trim().split('\n').filter(Boolean)
      return {
        status: 0,
        stdout: Buffer.concat(
          requested.map((oid) => {
            const row = rows.find((r) => r.oid === oid)
            assert.ok(row, 'Every requested historical object must exist')
            return Buffer.concat([
              Buffer.from(oid + ' ' + row.type + ' ' + row.buffer.length + '\n'),
              row.buffer,
              Buffer.from('\n')
            ])
          })
        ),
        stderr: Buffer.alloc(0)
      }
    }
    throw new Error('Unmodeled Git command: ' + args.join(' '))
  }
  const logs: string[] = []
  const exitSignal = Symbol('fixture process exit')
  let exitCode = 0
  let executionError: string | null = null
  const ctx = createContext({
    Buffer,
    createHash,
    isIP,
    spawnSync: git,
    readFileSync: (file: string) => {
      reads.push(relativeFile(file))
      return getFile(file)
    },
    statSync: (file: string) => ({ size: getFile(file).length }),
    readdirSync: (dir: string) => {
      const rel = relativeFile(dir)
      const prefix = rel ? rel + '/' : ''
      const names = new Map<string, boolean>()
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length),
          parts = rest.split('/')
        names.set(parts[0], parts.length > 1)
      }
      return [...names].map(([name, directory]) => ({ name, isDirectory: () => directory }))
    },
    join: path.posix.join,
    relative: path.posix.relative,
    sep: '/',
    userInfo: () => ({ username: options.username ?? virtualUser }),
    process: {
      cwd: () => virtualRoot,
      exit: (code: number) => {
        exitCode = code
        throw exitSignal
      }
    },
    console: { log: (...args: unknown[]) => logs.push(args.join(' ')) }
  })
  const executable = scannerSource
    .replace(/^import .+$/gm, '')
    .replace(registryPattern, 'const ADJUDICATED = ' + JSON.stringify(options.registry ?? []))
  try {
    runInContext(executable, ctx, { filename: 'isolated-default-scanner.mjs', timeout: 10000 })
  } catch (error) {
    if (error !== exitSignal) {
      executionError = error instanceof Error ? error.message : String(error)
      exitCode = 1
    }
  }
  // Early execution errors must not be mistaken for a classified open/stale result.
  if (executionError)
    return {
      exitCode,
      executionError,
      open: [] as Hit[],
      stale: [] as Entry[],
      findings: [] as Hit[],
      ackSeen: [] as { key: string; hits: Hit[] }[],
      coverage: null as Coverage | null,
      logs: logs.join('\n'),
      commands,
      reads,
      internalDispositions: null,
      policyError: null
    }
  const state = JSON.parse(
    JSON.stringify(
      runInContext(
        '({ open, stale, findings, ackSeen: [...ackSeen].map(([key, bucket]) => ({ key, hits: bucket.hits })), coverage: typeof coverage === "undefined" ? null : coverage, internalDispositions: typeof internalDispositions === "undefined" ? null : internalDispositions, policyError: typeof policyState === "undefined" ? null : policyState.error })',
        ctx
      )
    )
  ) as {
    open: Hit[]
    stale: Entry[]
    findings: Hit[]
    ackSeen: { key: string; hits: Hit[] }[]
    coverage: Coverage | null
    internalDispositions: DispositionState | null
    policyError: string | null
  }
  return { ...state, exitCode, executionError, logs: logs.join('\n'), commands, reads }
}
function clean(report: ReturnType<typeof runScanner>): void {
  assert.equal(report.executionError, null)
  assert.equal(report.exitCode, 0)
  assert.deepEqual(report.open, [])
  assert.deepEqual(report.stale, [])
}
function openAt(
  report: ReturnType<typeof runScanner>,
  rule: string,
  file: string,
  value: string,
  count = 1
): void {
  assert.equal(report.executionError, null)
  assert.equal(report.exitCode, 1)
  assert.equal(report.stale.length, 0, 'Stale-only exit1 is not a positive sensitive hit')
  assert.equal(report.open.length, count)
  assert.ok(
    report.open.every((r) => r.rule === rule && r.file === file && r.sha === shortHash(value))
  )
}
function syntheticEntry(rule: string, file: string, value: string): Entry {
  return {
    rule,
    file,
    sha: shortHash(value),
    desc: 'Isolated synthetic pairing fixture',
    verdict: 'synthetic-only',
    why: 'Never used in the production registry'
  }
}
const trueEntries = [
  syntheticEntry('R10', locatorFile, virtualUser),
  syntheticEntry('R11', locatorFile, "'FixtureLab', 'Workspace', 'SourceRepo'"),
  syntheticEntry('R12', inboundFile, fullV6),
  syntheticEntry('R12', inboundFile, prefixV6)
]
function pairedFiles(
  dirty = { user: false, root: false, full: false, prefix: false }
): Record<string, string> {
  return {
    [locatorFile]: [
      ...Array(4).fill(
        "join('C:', 'Users', '" + (dirty.user ? virtualUser : 'test-user') + "', 'AppData')"
      ),
      ...Array(3).fill(
        'join(' +
          (dirty.root
            ? "'FixtureLab', 'Workspace', 'SourceRepo'"
            : "'ExampleLab', 'Examples', 'SampleProject'") +
          ')'
      )
    ].join('\n'),
    [inboundFile]: [
      ...Array(2).fill(dirty.full ? fullV6 : docV6),
      ...Array(4).fill(dirty.prefix ? prefixV6 : docPrefixV6),
      ...falseValues
    ].join('\n')
  }
}
function pairingFailures(candidate: Entry[]): string[] {
  const failures: string[] = []
  for (const expected of falseEntries) {
    const row = candidate.find((r) => key(r) === key(expected))
    if (!row) failures.push('MISSING:' + key(expected))
    else if (JSON.stringify(row) !== JSON.stringify(expected))
      failures.push('CHANGED_SCOPE_OR_SEMANTICS:' + key(expected))
  }
  for (const row of candidate)
    if (!falseEntries.some((r) => key(r) === key(row))) failures.push('UNEXPECTED:' + key(row))
  return failures
}

test('Step3.5/I-07 original 21, target three, other 18 and removed four stay independent', () => {
  assert.equal(
    digest(JSON.stringify(registry.slice(0, 21))),
    'f30ba4ea98a66500f22e582ff7e3e9d4220b15bcaa786ebb00d24d762b12fac1'
  )
  assert.equal(
    digest(JSON.stringify(falseEntries)),
    'aaa3097edbb1492da6525798d96ad79b99fba0cddfe0743eb3f7fadbbddeb9ca'
  )
  assert.equal(
    digest(
      JSON.stringify(
        registry.slice(0, 21).filter((r) => !falseEntries.some((f) => key(f) === key(r)))
      )
    ),
    '0d32b3eb8a0a4ae956ae06f5447b88ef4efe1a4832501356b7170801cb89c4a0'
  )
  assert.ok(removedFour.every((r) => !registry.some((a) => key(a) === key(r))))
  assert.equal(falseValues.length, 3)
  assert.ok(falseValues.every((value) => isIP(value) === 6))
  const report = runScanner({ files: pairedFiles(), registry: falseEntries })
  clean(report)
  assert.equal(report.ackSeen.length, 3)
  assert.deepEqual(pairingFailures(falseEntries), [])
})
test('Step3.5/I-07 changing values alone leaves exactly four stale keys', () => {
  const report = runScanner({ files: pairedFiles(), registry: [...trueEntries, ...falseEntries] })
  assert.equal(report.exitCode, 1)
  assert.equal(report.open.length, 0)
  assert.deepEqual(report.stale.map(key).sort(), trueEntries.map(key).sort())
})
test('Step3.5/I-07 deleting registrations alone leaves 13 open in 4/3/2/4 groups', () => {
  const report = runScanner({
    files: pairedFiles({ user: true, root: true, full: true, prefix: true }),
    registry: falseEntries
  })
  assert.equal(report.exitCode, 1)
  assert.equal(report.stale.length, 0)
  assert.equal(report.open.length, 13)
  assert.deepEqual(
    trueEntries.map((r) => report.open.filter((h) => key(h) === key(r)).length),
    [4, 3, 2, 4]
  )
})
test('Step3.5/I-07 missed compressed same-prefix leaves four specific R12/open', () => {
  openAt(
    runScanner({
      files: pairedFiles({ user: false, root: false, full: false, prefix: true }),
      registry: falseEntries
    }),
    'R12',
    inboundFile,
    prefixV6,
    4
  )
})
test('Step3.5/I-07 deleting a preserved false positive fails scan and exact pairing', () => {
  const candidate = falseEntries.slice(1)
  openAt(
    runScanner({ files: pairedFiles(), registry: candidate }),
    'R12',
    inboundFile,
    falseValues[0]
  )
  assert.deepEqual(pairingFailures(candidate), ['MISSING:' + key(falseEntries[0])])
})
test('Step3.5/I-07 wildcard or metadata expansion is not an exact paired registration', () => {
  const wildcard = structuredClone(falseEntries)
  wildcard[0].file = 'src/main/bt/**'
  const report = runScanner({ files: pairedFiles(), registry: wildcard })
  assert.equal(report.exitCode, 1)
  assert.deepEqual(report.open.map(key), [key(falseEntries[0])])
  assert.deepEqual(report.stale.map(key), [key(wildcard[0])])
  assert.equal(pairingFailures(wildcard).length, 2)
  const expanded = structuredClone(falseEntries)
  expanded[0].scope = 'entire-rule'
  clean(runScanner({ files: pairedFiles(), registry: expanded }))
  assert.deepEqual(pairingFailures(expanded), [
    'CHANGED_SCOPE_OR_SEMANTICS:' + key(falseEntries[0])
  ])
  const extra = syntheticEntry('R12', inboundFile, v6('3abc', '1234', '5678', 'abcd', '', '1'))
  const extraFiles = pairedFiles()
  extraFiles[inboundFile] += '\n' + v6('3abc', '1234', '5678', 'abcd', '', '1')
  clean(runScanner({ files: extraFiles, registry: [...falseEntries, extra] }))
  assert.deepEqual(pairingFailures([...falseEntries, extra]), ['UNEXPECTED:' + key(extra)])
})

const ffmpegFile = 'resources/bin/license-notices/ffmpeg/doc/ffmpeg-filters.html'
const ffmpegParameters = [
  ['compand', 'compand=0|0:1|1:-90/-900|-70/-70|-30/-9|0/-3:6:0:0:0'],
  ['boxblur_opencl', 'boxblur_opencl=2:1:4:5:3:7'],
  ['erosion_opencl', 'erosion_opencl=30:40:50:coordinates=231'],
  ['dilation_opencl', 'dilation_opencl=30:40:50:coordinates=231'],
  ['pad', '[splitout2] pad=200:200:100:100 [padout];']
]
for (const [name, text] of ffmpegParameters)
  test('Step3.5/R12 FFmpeg parameter is not IPv6: ' + name, () => {
    clean(runScanner({ files: { [ffmpegFile]: text } }))
    openAt(runScanner({ files: { [ffmpegFile]: text + '\n' + fullV6 } }), 'R12', ffmpegFile, fullV6)
    clean(runScanner({ files: { [ffmpegFile]: text } }))
  })
for (const [name, value] of [
  ['first2-full', fullV6],
  ['first3-compressed', v6('3abc', '1357', '2468', 'acdc', '', '1')],
  ['four-nonempty-valid', v6('2abc', '1', '2', '', '3')],
  ['paired-prefix', prefixV6]
])
  test('Step3.5/R12 current synthetic positive and recovery: ' + name, () => {
    clean(runScanner({ files: { [probeFile]: '// clean' } }))
    const report = runScanner({ files: { [probeFile]: value } })
    openAt(report, 'R12', probeFile, value)
    assert.equal(report.open[0].where, ':1')
    clean(runScanner({ files: { [probeFile]: '// removed' } }))
  })
for (const [name, value] of [
  ['documentation', docV6],
  ['padded-documentation', v6('2001', '0db8', '1234', '5678', '', '1')],
  ['two-groups', v6('2abc', '', '1')],
  ['three-groups', v6('2abc', '1', '', '2')],
  ['time', v6('23', '59', '59')],
  ['outside-global-prefix', v6('4abc', '1234', '5678', 'abcd', '', '1')],
  // The old E3 four-group uncompressed string was not an address. Keep >=4 groups,
  // but test valid compression above instead of preserving that regex false positive.
  ['incomplete-without-compression', v6('2abc', '1', '2', '3')],
  ['multiple-compressions', v6('2abc', '', '1', '', '2', '', '3')]
])
  test('Step3.5/R12 negative control: ' + name, () =>
    clean(runScanner({ files: { [probeFile]: value } }))
  )
test('Step3.5/R12 history-only and stripped inputs are not positive probes', () => {
  clean(
    runScanner({
      history: [
        { file: probeFile, text: fullV6 },
        { file: 'src/probe/duplicate.ts', text: fullV6 }
      ]
    })
  )
  clean(runScanner({ files: { 'docs/v1.0/scanner-fixture.md': fullV6 } }))
})

// These are the individually reverified E3 public/synthetic match bytes, not secrets.
// Runtime decoding prevents regression fixture literals becoming scanner self-hits.
// No directory, domain, rule, test-face, or extension wildcard is introduced.
const publicInstances = [
  {
    id: 6,
    rule: 'R4',
    file: '.codex/hooks/load-context-docs.test.mjs',
    sha: '991ef87df7ba',
    category: 'synthetic-test',
    valueHex:
      '736563726574203d2027505249564154452d434f4d4d414e442d4e4f542d544f2d42452d4c4f4747454427'
  },
  {
    id: 9,
    rule: 'R7',
    file: 'THIRD-PARTY-NOTICES.md',
    sha: '8dc7a4227947',
    category: 'upstream-public-materials',
    valueHex: '656179406372797074736f66742e636f6d'
  },
  {
    id: 13,
    rule: 'R7',
    file: 'docs/v1.0/prompt/task5-opensource-release-prep-plan.md',
    sha: '3faf2d391109',
    category: 'public-noreply',
    valueHex:
      '3131323730383431342b6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 14,
    rule: 'R7',
    file: 'docs/v1.0/superpowers/plans/2026-09-13-task5-release-prep-plan.md',
    sha: '3faf2d391109',
    category: 'public-noreply',
    valueHex:
      '3131323730383431342b6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 15,
    rule: 'R7',
    file: 'docs/v1.0/superpowers/reviews/2026-09-01-task2-pu2-ci-evidence.md',
    sha: '789a82b2f15a',
    category: 'public-noreply',
    valueHex: '6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 17,
    rule: 'R7',
    file: 'docs/v1.0/superpowers/specs/2026-09-13-task5-invariants.md',
    sha: '3faf2d391109',
    category: 'public-noreply',
    valueHex:
      '3131323730383431342b6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 18,
    rule: 'R7',
    file: 'docs/v1.0/superpowers/specs/2026-09-13-task5-release-prep-design.md',
    sha: '3faf2d391109',
    category: 'public-noreply',
    valueHex:
      '3131323730383431342b6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 78,
    rule: 'R7',
    file: 'scripts/release-policy.json',
    sha: '3faf2d391109',
    category: 'public-noreply',
    valueHex:
      '3131323730383431342b6c69652d647265616d4075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 19,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '73b0d78e7a52',
    category: 'upstream-public-materials',
    valueHex: '74617473756869726f2e7440676d61696c2e636f6d'
  },
  {
    id: 20,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '06899de277f6',
    category: 'upstream-public-materials',
    valueHex:
      '3430343631302b74617473756869726f2d744075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 21,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '3c205d8fc749',
    category: 'upstream-public-materials',
    valueHex: '6e6f7265706c79406769746875622e636f6d'
  },
  {
    id: 22,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '5fb691953db1',
    category: 'upstream-public-materials',
    valueHex: '33363835393538382b61313334363035344075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 23,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '2b9590b92eab',
    category: 'upstream-public-materials',
    valueHex: '65676f72656e61722d64657640706f7374656f2e6e6574'
  },
  {
    id: 24,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'df8aca96f007',
    category: 'upstream-public-materials',
    valueHex: '796978696e626340666f786d61696c2e636f6d'
  },
  {
    id: 25,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'b706176186ef',
    category: 'upstream-public-materials',
    valueHex: '616d70686574616d616368696e6540676d61696c2e636f6d'
  },
  {
    id: 26,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'ded123193d9d',
    category: 'upstream-public-materials',
    valueHex: '68696d696b6f6640676d61696c2e636f6d'
  },
  {
    id: 27,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '9b6863e6b854',
    category: 'upstream-public-materials',
    valueHex: '6865726e616e2e632e6d617274696e657a40676d61696c2e636f6d'
  },
  {
    id: 28,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '509259eb2a2f',
    category: 'upstream-public-materials',
    valueHex: '49547269736b544940676d61696c2e636f6d'
  },
  {
    id: 29,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '8b8f719dc9d2',
    category: 'upstream-public-materials',
    valueHex: '636172736f6e7a68754074656e63656e742e636f6d'
  },
  {
    id: 30,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'cd5cd8d4c0a0',
    category: 'upstream-public-materials',
    valueHex: '6b656c736f6e406b697769782e6f7267'
  },
  {
    id: 31,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'ae4d1dae7556',
    category: 'upstream-public-materials',
    valueHex: '726963686172646e69617340676d61696c2e636f6d'
  },
  {
    id: 32,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '26fc824771f7',
    category: 'upstream-public-materials',
    valueHex: '33323836313437362b4648304075736572732e6e6f7265706c792e6769746875622e636f6d'
  },
  {
    id: 33,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '1ed31b0ffc30',
    category: 'upstream-public-materials',
    valueHex: '6e6b683034373240686f746d61696c2e636f6d'
  },
  {
    id: 34,
    rule: 'R8',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'cbb14683a7aa',
    category: 'upstream-public-materials',
    valueHex: '2f686f6d652f65676f72656e61722f'
  },
  {
    id: 35,
    rule: 'R9',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'c5eb5a4cc76a',
    category: 'upstream-public-materials',
    valueHex: '3139322e3136382e312e31'
  },
  {
    id: 36,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: '91ebb2ac5811',
    category: 'upstream-public-materials',
    valueHex: '6f70656e73736c2d636f7265406f70656e73736c2e6f7267'
  },
  {
    id: 37,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: '8dc7a4227947',
    category: 'upstream-public-materials',
    valueHex: '656179406372797074736f66742e636f6d'
  },
  {
    id: 38,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: 'bd85be195d29',
    category: 'upstream-public-materials',
    valueHex: '746a68406372797074736f66742e636f6d'
  },
  {
    id: 39,
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/README.html',
    sha: 'af0449c16d4d',
    category: 'upstream-public-materials',
    valueHex: '676f6f6467657240707974686f6e2e6f7267'
  },
  {
    id: 40,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/developer.html',
    sha: 'c7f2ffdcf0b2',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d646576656c4066666d7065672e6f7267'
  },
  {
    id: 41,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: 'aa173b67be6a',
    category: 'upstream-public-materials',
    valueHex: '6661746540666174652e66666d7065672e6f7267'
  },
  {
    id: 42,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: 'd0c46d919351',
    category: 'upstream-public-materials',
    valueHex: '666174652d61646d696e4066666d7065672e6f7267'
  },
  {
    id: 43,
    rule: 'R8',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: '7f1527bf8965',
    category: 'upstream-public-materials',
    valueHex: '2f686f6d652f73616d706c65732f'
  },
  {
    id: 48,
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffmpeg-formats.html',
    sha: '0387f8c569a2',
    category: 'upstream-public-materials',
    valueHex: '31302e302e312e323535'
  },
  {
    id: 49,
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffmpeg.html',
    sha: 'ff13fcc2ae8b',
    category: 'upstream-public-materials',
    valueHex: '3139322e3136382e302e34'
  },
  {
    id: 50,
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffplay.html',
    sha: 'ff13fcc2ae8b',
    category: 'upstream-public-materials',
    valueHex: '3139322e3136382e302e34'
  },
  {
    id: 51,
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffprobe.html',
    sha: 'ff13fcc2ae8b',
    category: 'upstream-public-materials',
    valueHex: '3139322e3136382e302e34'
  },
  {
    id: 52,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'e0dbf78908d1',
    category: 'upstream-public-materials',
    valueHex: '67697440736f757263652e66666d7065672e6f7267'
  },
  {
    id: 53,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: '89b6ce958b19',
    category: 'upstream-public-materials',
    valueHex: '6769744066666d7065672e6f7267'
  },
  {
    id: 54,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'c7f2ffdcf0b2',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d646576656c4066666d7065672e6f7267'
  },
  {
    id: 55,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'fe2fb8becf38',
    category: 'upstream-public-materials',
    valueHex: '68756d616e407365727665722e636f6d'
  },
  {
    id: 56,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'ef7196ce213c',
    category: 'upstream-public-materials',
    valueHex: '726f6f744066666d7065672e6f7267'
  },
  {
    id: 57,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'a0f0a74af3a7',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d757365724066666d7065672e6f7267'
  },
  {
    id: 58,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: '7951d1c23785',
    category: 'upstream-public-materials',
    valueHex: '6c696261762d757365724066666d7065672e6f7267'
  },
  {
    id: 59,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'c7f2ffdcf0b2',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d646576656c4066666d7065672e6f7267'
  },
  {
    id: 60,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: '828ed3e40b6c',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d757365722d726571756573744066666d7065672e6f7267'
  },
  {
    id: 61,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'dda596d51125',
    category: 'upstream-public-materials',
    valueHex: '66666d7065672d757365722d6f776e65724066666d7065672e6f7267'
  },
  {
    id: 62,
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/style.min.css',
    sha: '05dd11d43a77',
    category: 'upstream-public-materials',
    valueHex: '646230636f6d70616e7940676d61696c2e636f6d'
  },
  {
    id: 63,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/README.md',
    sha: 'db015cdc4faa',
    category: 'upstream-public-materials',
    valueHex: '6d796163636f756e7440676d61696c2e636f6d'
  },
  {
    id: 64,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '4bafcb8c075f',
    category: 'upstream-public-materials',
    valueHex: '6a7365776172644061636d2e6f7267'
  },
  {
    id: 65,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '59190f05e806',
    category: 'upstream-public-materials',
    valueHex: '6a6c6f757040677a69702e6f7267'
  },
  {
    id: 66,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '3c51116159b6',
    category: 'upstream-public-materials',
    valueHex: '6d61646c657240616c756d6e692e63616c746563682e656475'
  },
  {
    id: 67,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '5914717faf21',
    category: 'upstream-public-materials',
    valueHex: '6d69747961353740676d61696c2e636f6d'
  },
  {
    id: 68,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: 'bfb44e6ce4e8',
    category: 'upstream-public-materials',
    valueHex: '646176696440626f6e6e65742e6363'
  },
  {
    id: 69,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: '91ebb2ac5811',
    category: 'upstream-public-materials',
    valueHex: '6f70656e73736c2d636f7265406f70656e73736c2e6f7267'
  },
  {
    id: 70,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: '8dc7a4227947',
    category: 'upstream-public-materials',
    valueHex: '656179406372797074736f66742e636f6d'
  },
  {
    id: 71,
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: 'bd85be195d29',
    category: 'upstream-public-materials',
    valueHex: '746a68406372797074736f66742e636f6d'
  }
]
function anotherValue(rule: string): string {
  if (rule === 'R4') return ['sec', 'ret'].join('') + " = 'scanner-synthetic-other-value'"
  if (rule === 'R7') return ['scanner-negative-only', 'mail.scan-fixture.net'].join('@')
  if (rule === 'R8') return ['C:', 'Users', 'fixture-other-person'].join(String.fromCharCode(92))
  if (rule === 'R9') return [10, 93, 27, 41].join('.')
  throw new Error('Unexpected public-instance rule')
}
/** The registered instance in the sole policy file must be exercised inside a valid policy document. */
function policyDocument(values: string[]): string {
  const policy = JSON.parse(realPolicyText) as { publicGit: { maintainer: { email: string } } }
  policy.publicGit.maintainer.email = values[0]
  return JSON.stringify({ ...policy, fixtureNotes: values.slice(1) }, null, 2) + '\n'
}
for (const row of publicInstances)
  test('Step3.5/exact nonsecret instance ' + row.id + ' / ' + row.rule, () => {
    const value = Buffer.from(row.valueHex, 'hex').toString('utf8')
    assert.equal(shortHash(value), row.sha)
    const wrap = (parts: string[]): string =>
      row.file === POLICY_FILE ? policyDocument(parts) : parts.join('\n')
    const acknowledgements = registry.filter((r) => key(r) === key(row))
    assert.equal(
      acknowledgements.length,
      1,
      'The individually verified nonsecret key must be registered exactly once'
    )
    const base = {
      files: { [row.file]: wrap([value]) },
      history: [{ file: row.file, text: wrap([value]) }],
      registry: acknowledgements
    }
    const before = runScanner(base)
    clean(before)
    assert.equal(
      before.ackSeen[0].hits.length,
      2,
      'Current and one deduplicated history blob both apply'
    )
    const other = anotherValue(row.rule)
    openAt(
      runScanner({ ...base, files: { [row.file]: wrap([value, other]) } }),
      row.rule,
      row.file,
      other
    )
    const drifted = runScanner({ files: { [row.file]: wrap([other]) }, registry: acknowledgements })
    assert.equal(drifted.exitCode, 1)
    assert.deepEqual(drifted.open.map(key), [
      key({ rule: row.rule, file: row.file, sha: shortHash(other) })
    ])
    assert.deepEqual(drifted.stale.map(key), [key(row)])
    clean(runScanner(base))
  })
test('Step3.5/exact public additions only; real internal keys never enter ADJUDICATED', () => {
  assert.equal(publicInstances.length, 57)
  assert.deepEqual(registry.slice(21).map(key).sort(), publicInstances.map(key).sort())
  assert.equal(new Set(registry.map(key)).size, registry.length)
  assert.ok(registry.slice(21).every((r) => !r.scope && r.verdict === '实例级假阳'))
})
test('Step3.5/public material and test.mjs registrations cannot hide another credential prefix', () => {
  const value = ['gh', 'p_', 'A'.repeat(36)].join('')
  for (const category of ['upstream-public-materials', 'public-noreply', 'synthetic-test']) {
    const row = publicInstances.find((r) => r.category === category)!
    const original = Buffer.from(row.valueHex, 'hex').toString('utf8')
    openAt(
      runScanner({
        files: { [row.file]: original + '\n' + value },
        registry: registry.filter((r) => key(r) === key(row))
      }),
      'R6',
      row.file,
      value
    )
  }
})

test('Step3.5/report history counts one deduplicated blob and 13 matches; oversize current is uncovered', () => {
  const file = 'docs/v1.0/superpowers/specs/2026-09-03-task3-src-domain-design.md'
  const value = ['C:', 'Users', virtualUser].join(String.fromCharCode(92))
  const historical = Array(13).fill(value).join('\n')
  const current = value + '\n' + 'x'.repeat(2 * 1024 * 1024)
  const report = runScanner({
    files: { [file]: current },
    history: [
      { file, text: historical },
      { file: 'docs/v1.0/same-blob.md', text: historical }
    ]
  })
  openAt(report, 'R8', file, value, 13)
  assert.ok(report.open.every((r) => r.where === '(git 历史)'))
  assert.match(report.logs, /git 历史 1 个 blob \/ 13 次匹配/)
  assert.doesNotMatch(report.logs, /git 历史 13 个 blob/)
  assert.ok(report.coverage)
  assert.equal(report.coverage.maxBytes, 2097152)
  assert.equal(report.coverage.workspace.scannedFiles, 0)
  assert.deepEqual(report.coverage.workspace.skipped, [
    { file, reason: 'oversize', bytes: Buffer.byteLength(current) }
  ])
  assert.equal(report.coverage.history.uniqueBlobs, 1)
  assert.equal(report.coverage.history.scannedBlobs, 1)
  assert.ok(!report.reads.includes(file), 'The >2MiB guard must run before content read')
  assert.equal(new Set(report.open.map((r) => r.source?.blob)).size, 1)
  assert.ok(report.open.every((r) => r.source?.inputSha256 === digest(historical)))
})
test('Step3.5/default input chain separates content selection, binary guards and path walking', () => {
  const email = ['scanner-negative-only', 'mail.scan-fixture.net'].join('@')
  const files = {
    'src/clean.ts': '// clean',
    'src/untracked.md': email,
    'out/tracked.md': email,
    'dist/ignored.md': email,
    'image.png': email,
    'binary.dat': Buffer.from([0, 1, 2]),
    '.git/private.key': ''
  }
  const report = runScanner({
    files,
    tracked: ['src/clean.ts', 'out/tracked.md', 'image.png', 'binary.dat'],
    untracked: ['src/untracked.md', 'src/clean.ts']
  })
  assert.equal(report.exitCode, 1)
  assert.deepEqual(report.open.map((r) => r.file).sort(), ['out/tracked.md', 'src/untracked.md'])
  assert.equal(report.stale.length, 0)
  assert.ok(report.coverage)
  assert.equal(report.coverage.workspace.candidateFiles, 5)
  assert.equal(report.coverage.workspace.scannedFiles, 3)
  assert.deepEqual(report.coverage.workspace.skipped.map((r) => [r.file, r.reason]).sort(), [
    ['binary.dat', 'binary-content'],
    ['image.png', 'binary-path']
  ])
  assert.ok(
    report.commands.some(
      (a) =>
        JSON.stringify(a) === JSON.stringify(['ls-files', '--others', '--exclude-standard', '-z'])
    )
  )
  assert.ok(
    report.commands.some(
      (a) => JSON.stringify(a) === JSON.stringify(['rev-list', '--objects', '--all'])
    )
  )
})
test('Step3.5/report historical non-blobs, binary and oversize objects are not scanned blobs', () => {
  const report = runScanner({
    history: [
      { file: 'tree-entry', text: Buffer.from([0, 1]), type: 'tree' },
      { file: 'binary.dat', text: Buffer.from([0, 2]) },
      { file: 'large.md', text: 'x'.repeat(2097153) },
      { file: 'small.md', text: 'clean' }
    ]
  })
  clean(report)
  assert.ok(report.coverage)
  assert.equal(report.coverage.history.uniqueBlobs, 3)
  assert.equal(report.coverage.history.scannedBlobs, 1)
  assert.deepEqual(report.coverage.history.skipped.map((r) => r.reason).sort(), [
    'binary-content',
    'non-blob',
    'oversize'
  ])
})
test('Step3.5/report does not repeat identity, private match text or credential fingerprints', () => {
  const credential = ['gh', 'p_', 'B'.repeat(36)].join('')
  const privatePath = ['C:', 'Users', virtualUser].join(String.fromCharCode(92))
  const report = runScanner({ files: { [probeFile]: [credential, privatePath].join('\n') } })
  assert.equal(report.exitCode, 1)
  assert.ok(report.open.some((r) => r.rule === 'R6'))
  assert.ok(report.open.some((r) => r.rule === 'R8'))
  assert.ok(!report.logs.includes(credential) && !report.logs.includes(shortHash(credential)))
  assert.ok(!report.logs.includes(privatePath) && !report.logs.includes(virtualUser))
})
for (const command of ['ls-files', 'rev-list', 'cat-file'])
  test('Step3.5/execution error is not a clean scan: git ' + command, () => {
    const report = runScanner({
      gitFailure: command,
      history: [{ file: 'history.md', text: 'clean' }]
    })
    assert.equal(report.exitCode, 1)
    assert.equal(
      report.executionError,
      null,
      'The CLI must contain input errors, not throw a stack'
    )
    const summary = scannerSummary(report.logs)
    assert.equal(summary.status, 'ERROR')
    assert.ok(summary.inputErrors.length > 0)
    assert.ok(!report.logs.includes('✅ 零未定性命中'))
  })
test('Step3.5/execution error is distinct from open/stale when current input cannot be read', () => {
  const report = runScanner({ files: { [probeFile]: 'clean' }, unreadable: probeFile })
  assert.equal(report.exitCode, 1)
  assert.deepEqual(report.open, [])
  assert.deepEqual(report.stale, [])
  assert.match(report.logs, /执行错误/)
  assert.ok(!report.logs.includes('✅ 零未定性命中'))
})

test('Step3.5/default history binary alias does not suppress the same blob under a text path', () => {
  const email = ['scanner-negative-only', 'mail.scan-fixture.net'].join('@')
  const file = 'docs/v1.0/same-blob-text.md'
  const report = runScanner({
    history: [
      { file: 'image.png', text: email },
      { file, text: email }
    ]
  })
  openAt(report, 'R7', file, email)
  assert.equal(report.open[0].where, '(git 历史)')
  assert.ok(report.coverage)
  assert.equal(report.coverage.history.uniqueBlobs, 1)
  assert.equal(report.coverage.history.scannedBlobs, 1)
})

/** Parse the actual CLI report rather than the fixture's in-memory classification state. */
function scannerSummary(logs: string): {
  status: string
  inputErrors: unknown[]
  open: Record<string, unknown>[]
  stale: Record<string, unknown>[]
  coverage: Coverage
} {
  const line = logs.split('\n').find((row) => row.startsWith('SCAN_SUMMARY '))
  assert.ok(line, 'A complete structured scanner report is required')
  return JSON.parse(line.slice('SCAN_SUMMARY '.length))
}

for (const [name, groups] of [
  ['six hextets', ['2abc', '1357', '2468', 'acdc', '1a2b', '3c4d']],
  ['four hextets with compression', ['2abc', '1357', '2468', 'acdc', '']]
] as const) {
  test('Step3.5/review mixed IPv4 tail keeps its complete R12 key: ' + name, () => {
    const address = v6(...groups, ['192', '0', '2', '1'].join('.'))
    assert.equal(isIP(address), 6)
    clean(runScanner())
    for (const text of [address, 'address = ' + address + '.']) {
      openAt(runScanner({ files: { [probeFile]: text } }), 'R12', probeFile, address)
    }
    clean(runScanner({ files: { [probeFile]: '// removed mixed-address fixture' } }))
  })
}
for (const [name, address] of [
  [
    'three nonempty hextets is still too short',
    v6('2abc', '1357', '2468', '', ['192', '0', '2', '1'].join('.'))
  ],
  [
    'invalid dotted octet is not a truncated positive',
    v6('2abc', '1357', '2468', 'acdc', '', ['999', '0', '2', '1'].join('.'))
  ],
  [
    'documentation prefix with dotted tail',
    v6('2001', 'db8', '1357', '2468', '', ['192', '0', '2', '1'].join('.'))
  ]
]) {
  test('Step3.5/review mixed IPv4-tail negative: ' + name, () => {
    clean(runScanner({ files: { [probeFile]: address } }))
  })
}
for (const [rule, value] of [
  ['R9', ['10', '93', '27', '41'].join('.')],
  ['R7', ['synthetic-password-value', 'mail.scan-fixture.net'].join('@')]
]) {
  test(
    'Step3.5/review credential overlap cannot leak through ' + rule + ' or source hashes',
    () => {
      const text = "const password = '" + value + "'"
      const report = runScanner({
        files: { [probeFile]: text },
        history: [{ file: probeFile, text }]
      })
      assert.equal(report.exitCode, 1)
      assert.deepEqual([...new Set(report.open.map((row) => row.rule))].sort(), ['R4', rule].sort())
      assert.equal(report.open.filter((row) => row.rule === rule).length, 2)
      const blob = report.open.find((row) => row.source?.kind === 'history-content')?.source?.blob
      assert.ok(blob)
      for (const secretOrFingerprint of [
        value,
        shortHash(value),
        shortHash(text),
        digest(text),
        blob
      ]) {
        assert.ok(
          !report.logs.includes(secretOrFingerprint),
          'All report exits must redact credential-associated fingerprints'
        )
      }
      const summary = scannerSummary(report.logs)
      for (const row of summary.open) {
        assert.ok(!('sha' in row) && !('currentInputSha256' in row) && !('historySources' in row))
      }
    }
  )
}
test('Step3.5/review credential-tainted acknowledged and stale rows do not reprint fingerprints', () => {
  const value = ['10', '93', '27', '41'].join('.')
  const text = "const password = '" + value + "'"
  for (const rule of ['R9', 'R7']) {
    const report = runScanner({
      files: { [probeFile]: text },
      registry: [
        {
          rule,
          file: probeFile,
          sha: shortHash(value),
          desc: 'synthetic report-only control',
          verdict: 'fixture',
          why: 'not a production registration'
        }
      ]
    })
    assert.equal(report.exitCode, 1)
    assert.ok(
      report.open.some((row) => row.rule === 'R4'),
      'Another rule registration must not acknowledge a credential'
    )
    assert.equal(report.stale.length, rule === 'R7' ? 1 : 0)
    assert.ok(
      !report.logs.includes(shortHash(value)),
      'Acknowledged/stale output is not a fingerprint side channel'
    )
    for (const row of scannerSummary(report.logs).stale) assert.ok(!('sha' in row))
  }
})
test('Step3.5/review binary alias coverage cannot expose a credential blob fingerprint', () => {
  const token = ['gh', 'p_', 'Y'.repeat(36)].join('')
  const file = 'docs/v1.0/synthetic-token-history.md'
  const report = runScanner({
    history: [
      { file: 'image.png', text: token },
      { file, text: token }
    ]
  })
  openAt(report, 'R6', file, token)
  const blob = report.open[0].source?.blob
  assert.ok(blob)
  assert.ok(
    report.coverage && report.coverage.history.scannedBlobs === 1,
    'Do not suppress the later text alias'
  )
  for (const secretOrFingerprint of [token, shortHash(token), digest(token), blob]) {
    assert.ok(
      !report.logs.includes(secretOrFingerprint),
      'Coverage must obey the same fingerprint redaction as findings'
    )
  }
  const skipped = scannerSummary(report.logs).coverage.history.skipped.find(
    (row) => row.reason === 'binary-path'
  )
  assert.ok(skipped && !('blob' in skipped))
})

test('Step3.5/review cross-source redaction reaches a fixed point regardless of input order', () => {
  const first = ['10', '93', '27', '41'].join('.')
  const shared = ['10', '84', '26', '19'].join('.')
  const last = ['10', '65', '17', '83'].join('.')
  const a = "const password = '" + first + "'"
  const b = [first, shared].join('\n')
  const c = [shared, last].join('\n')
  const report = runScanner({
    files: {
      'docs/redaction-c.txt': c,
      'docs/redaction-b.txt': b,
      [probeFile]: a
    }
  })
  assert.equal(report.exitCode, 1)
  assert.equal(report.open.filter((row) => row.rule === 'R4').length, 1)
  assert.equal(report.open.filter((row) => row.rule === 'R9').length, 5)
  assert.deepEqual(report.stale, [])
  for (const value of [first, shared, last, a, b, c]) {
    assert.ok(
      !report.logs.includes(shortHash(value)) && !report.logs.includes(digest(value)),
      'A linked input must not re-expose match or source fingerprints through another finding'
    )
  }
  for (const row of scannerSummary(report.logs).open) {
    assert.equal(row.fingerprintRedacted, true)
    assert.ok(!('sha' in row) && !('currentInputSha256' in row) && !('historySources' in row))
  }
})

test('Step3.5/review cross-source historical and binary-alias fingerprints are redacted', () => {
  const value = ['10', '93', '27', '41'].join('.')
  const unrelated = ['10', '84', '26', '19'].join('.')
  const current = "const password = '" + value + "'"
  const historical = [value, unrelated].join('\n')
  const historyFile = 'docs/v1.0/cross-source-history.md'
  const report = runScanner({
    files: { [probeFile]: current },
    history: [
      { file: 'history-alias.png', text: historical },
      { file: historyFile, text: historical }
    ]
  })
  assert.equal(report.exitCode, 1)
  assert.equal(report.open.filter((row) => row.rule === 'R4').length, 1)
  assert.equal(report.open.filter((row) => row.rule === 'R9').length, 3)
  const blob = report.open.find((row) => row.file === historyFile)?.source?.blob
  assert.ok(blob)
  assert.equal(report.coverage?.history.scannedBlobs, 1)
  for (const fingerprint of [
    shortHash(value),
    shortHash(unrelated),
    digest(current),
    digest(historical),
    blob
  ]) {
    assert.ok(
      !report.logs.includes(fingerprint),
      'Cross-source coverage is not a fingerprint side channel'
    )
  }
  const skipped = scannerSummary(report.logs).coverage.history.skipped.find(
    (row) => row.reason === 'binary-path'
  )
  assert.ok(skipped && !('blob' in skipped))
})

/** Independent Node CLI: no outer catch that can mask Node's default stderr stack.
 * Only the imports/I/O boundary and fixture registry are replaced; the production
 * scanner's default control flow, error handling and process exit run unmodified.
 * No actual git executable, commit, working-tree content, or identity is used. */
function runScannerCli(scenario: string): {
  exitCode: number | null
  stdout: string
  stderr: string
} {
  const source = scannerSource
    .replace(/^import .+$/gm, '')
    .replace(registryPattern, 'const ADJUDICATED = []')
  const bootstrap = `
    import { createHash } from 'node:crypto'
    import { readFileSync as fsReadFileSync } from 'node:fs'
    import { isIP } from 'node:net'
    import path from 'node:path'
    import { runInThisContext } from 'node:vm'
    const scenario = ${JSON.stringify(scenario)}
    const root = ${JSON.stringify(virtualRoot)}
    const user = ${JSON.stringify(virtualUser)}
    const policyText = fsReadFileSync(${JSON.stringify(realPolicyPath)}, 'utf8')
    const oid = '0'.repeat(40)
    Object.assign(globalThis, {
      createHash, isIP, join: path.posix.join, relative: path.posix.relative, sep: '/',
      userInfo: () => ({ username: user }),
      readFileSync: (file) => { if (String(file).endsWith('release-policy.json')) return Buffer.from(policyText); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      statSync: () => ({ size: 5 }), readdirSync: () => [],
      spawnSync: (_command, args) => {
        const failure = { status: 128, stdout: '', stderr: root + '/' + user + '/private-input' }
        if (scenario === 'spawn-error') return { ...failure, status: null, error: new Error(failure.stderr) }
        if (scenario === args[0]) return failure
        if (args[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' }
        if (args[0] === 'rev-list') return { status: 0, stdout: scenario === 'clean' ? '' : oid + ' history.md', stderr: '' }
        if (args[0] === 'cat-file') return { status: 0, stdout: Buffer.from(scenario === 'missing-cat-file' ? '' : scenario === 'malformed-cat-file' ? 'truncated header' : oid + ' blob 5\\nclean\\n'), stderr: '' }
        return failure
      }
    })
    process.cwd = () => root
    runInThisContext(${JSON.stringify(source)}, { filename: root + '/' + user + '/scan-secrets.mjs' })
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: bootstrap,
    encoding: 'utf8',
    // npm test runs Electron-as-Node alongside the full suite; allow bounded cold startup,
    // not a different scan limit or weaker error/open/stale assertion.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024
  })
  assert.ifError(result.error)
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}
for (const scenario of [
  'ls-files',
  'rev-list',
  'cat-file',
  'spawn-error',
  'malformed-cat-file',
  'missing-cat-file'
]) {
  test(
    'Step3.5/review real CLI contains input error without stdout/stderr identity leaks: ' +
      scenario,
    () => {
      const result = runScannerCli(scenario)
      assert.equal(result.exitCode, 1)
      assert.equal(result.stderr, '', 'Uncaught native error stacks must not escape the CLI')
      const summary = scannerSummary(result.stdout)
      assert.equal(summary.status, 'ERROR')
      assert.ok(summary.inputErrors.length > 0)
      for (const hidden of [virtualRoot, virtualUser, 'private-input']) {
        assert.ok(!(result.stdout + result.stderr).includes(hidden))
      }
      assert.ok(!result.stdout.includes('✅ 零未定性命中'))
    }
  )
}
test('Step3.5/review real CLI clean recovery still exits zero', () => {
  const result = runScannerCli('clean')
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr, '')
  assert.equal(scannerSummary(result.stdout).status, 'PASS')
})

// ── Step6c:内部受限处置载体(仅原开发机内部工作区;C-1 载体 / C-2 消费失效 / C-3 非递归边界)──
// 记录只配对 R8 / R10 / R11 的真实内部非凭据;每条每次运行都核验批准凭证、精确边界、来源集合与原身份。
// 夹具证据放在未跟踪的合成目录,载体路径 / 覆盖路径 / 登记路径全部从唯一 policy 读取,不在这里写字面量。
type PolicyShape = {
  forbiddenCandidatePaths: { id: string; kind: string; path: string }[]
  stripPaths: { id: string; kind: string; path: string }[]
  publicDocuments: {
    registry: string
    documents: { sourcePath: string; publicPath: string; targetPath: string }[]
  }
}
type Binding = { kind: string; inputSha256: string; blob?: string }
type Boundary = {
  policySha256: string
  exactRuleFieldAndPath: { field: string; path: string }[]
  overlayInputSha256?: string
  proofRef: string
  proofSha256: string
  sourceSetSha256: string
}
type Record6c = {
  recordType: string
  scope: string
  key: { rule: string; file: string; matchedTextSha12: string }
  sourceBindings: Binding[]
  approval: {
    reviewer: string
    approvedAt: string
    proofRef: string
    proofSha256: string
    objectSourceScopeSha256: string
  }
  boundary: Boundary
}
type Fixture = {
  files: Record<string, string>
  history: HistoryInput[]
  hidden: Record<string, string>
  policyText: string
  records: Record6c[]
  proof: {
    schemaVersion: number
    kind: string
    policySha256: string
    sourceSetSha256: string
    identityContextSha256: string
    assertions: Record<string, unknown>[]
  }
  username?: string
  sourceSetFailure?: boolean
}
const realPolicy = JSON.parse(realPolicyText) as PolicyShape
const carrierPath = realPolicy.forbiddenCandidatePaths.find((r) => r.id === 'F-08')!.path
const toolStripPath = realPolicy.stripPaths.find((r) => r.id === 'S-12')!.path
const docsStripPath = realPolicy.stripPaths.find((r) => r.id === 'S-05')!.path
const overlayRow = realPolicy.publicDocuments.documents.find((d) => d.targetPath === 'CLAUDE.md')!
const registryPath = realPolicy.publicDocuments.registry
const identityDigest = (user = virtualUser): string =>
  digest(['downlord-identity-context', user, virtualRoot].join('\n'))
const toolFile = toolStripPath + 'README.md'
const reviewFile = docsStripPath + 'superpowers/reviews/fixture-delivery.md'
const historyOnlyFile = docsStripPath + 'superpowers/specs/fixture-oversize.md'
const evidenceRoot = 'fixture-evidence'
const approvalRef = evidenceRoot + '/approval-submitted.md'
const boundaryRef = evidenceRoot + '/boundary-proof.json'
const internalPath = ['C:', 'Users', virtualUser].join(String.fromCharCode(92))
const APPROVAL_HEADER = 'B items approved by the user on 2026-09-15'
/** Same shape as the real signed checklist: one key literal per item, bindings as appendix table rows. */
function approvalDocument(records: Pick<Record6c, 'key' | 'sourceBindings'>[]): string {
  const lines = [APPROVAL_HEADER, '']
  for (const r of records)
    lines.push(
      '- 精确命中文本键：`' + [r.key.rule, r.key.file, r.key.matchedTextSha12].join('|') + '`'
    )
  lines.push('', '| 组 | 来源 / 次数 | 输入SHA256 | 历史blob |', '|---|---|---|---|')
  records.forEach((r, i) => {
    for (const b of r.sourceBindings)
      lines.push(
        '| ' +
          (i + 1) +
          ' | ' +
          (b.kind === 'workspace' ? '当前 / 1' : '历史 / 1') +
          ' | `' +
          b.inputSha256 +
          '` | ' +
          (b.blob ? '`' + b.blob + '`' : '不适用') +
          ' |'
      )
  })
  return lines.join('\n') + '\n'
}
/** Re-sign the fixture's approval document (simulates a new user-signed checklist). */
function resign(f: Fixture, text: string): void {
  f.hidden[approvalRef] = text
  for (const r of f.records) r.approval.proofSha256 = digest(text)
}
const historyOid = (text: string): string => {
  const buffer = Buffer.from(text)
  return createHash('sha1')
    .update('blob ' + buffer.length + String.fromCharCode(0))
    .update(buffer)
    .digest('hex')
}
/** Independent encoding of the C-3 source set: tracked {path,mode,sha256} minus the carrier, byte-ordered. */
function sourceSetDigest(files: Record<string, string>): string {
  const rows = Object.entries(files)
    .filter(([p]) => p !== carrierPath)
    .map(([p, text]) => ({ path: p, mode: '100644', sha256: digest(text) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
  return digest(JSON.stringify(rows))
}
function objectScope(r: Pick<Record6c, 'key' | 'scope' | 'sourceBindings'>): string {
  return digest(
    JSON.stringify({
      key: { rule: r.key.rule, file: r.key.file, matchedTextSha12: r.key.matchedTextSha12 },
      scope: r.scope,
      sourceBindings: r.sourceBindings.map((b) =>
        b.kind === 'workspace'
          ? { kind: b.kind, inputSha256: b.inputSha256 }
          : { kind: b.kind, inputSha256: b.inputSha256, blob: b.blob }
      )
    })
  )
}
function makeRecord(
  rule: string,
  file: string,
  value: string,
  bindings: Binding[],
  boundary: Omit<Boundary, 'policySha256' | 'proofRef' | 'proofSha256' | 'sourceSetSha256'>,
  ctx: { policySha256: string; sourceSetSha256: string; proofSha256: string }
): Record6c {
  const key = { rule, file, matchedTextSha12: shortHash(value) }
  const scope = 'internal-original-workspace'
  return {
    recordType: 'real-internal-noncredential',
    scope,
    key,
    sourceBindings: bindings,
    approval: {
      reviewer: '用户本人',
      approvedAt: '2026-09-15',
      proofRef: approvalRef,
      proofSha256: '',
      objectSourceScopeSha256: objectScope({ key, scope, sourceBindings: bindings })
    },
    boundary: {
      policySha256: ctx.policySha256,
      ...boundary,
      proofRef: boundaryRef,
      proofSha256: ctx.proofSha256,
      sourceSetSha256: ctx.sourceSetSha256
    }
  }
}
/** Build a complete, valid fixture; `mutate` edits it before the carrier is serialised. */
function dispositionFixture(mutate?: (f: Fixture) => void): Fixture {
  const claude = 'shared memory root for ' + virtualUser + ' only\n'
  const overlay = 'shared memory root is machine-local and not published\n'
  const tool = 'notes\n' + internalPath + '\n'
  const review = 'log\n' + internalPath + '\n'
  const historyText = Array(13).fill(internalPath).join('\n')
  const registry = {
    schemaVersion: 1,
    documents: realPolicy.publicDocuments.documents.map((d) => ({
      sourcePath: d.sourcePath,
      publicPath: d.publicPath,
      targetPath: d.targetPath,
      baseCommit: '0'.repeat(40),
      publicSha256: d.targetPath === 'CLAUDE.md' ? digest(overlay) : digest('')
    }))
  }
  const f: Fixture = {
    files: {
      'CLAUDE.md': claude,
      [overlayRow.publicPath]: overlay,
      [toolFile]: tool,
      [reviewFile]: review,
      [registryPath]: JSON.stringify(registry, null, 2) + '\n',
      'src/main/index.ts': 'export {}\n'
    },
    history: [
      { file: toolFile, text: tool },
      { file: reviewFile, text: review },
      { file: historyOnlyFile, text: historyText }
    ],
    hidden: {},
    policyText: realPolicyText,
    records: [],
    proof: {
      schemaVersion: 1,
      kind: 'internal-disposition-boundary-proof',
      policySha256: '',
      sourceSetSha256: '',
      identityContextSha256: identityDigest(),
      assertions: [
        { path: toolFile, inCandidate: false, field: 'stripPaths', rulePath: toolStripPath },
        {
          path: 'CLAUDE.md',
          inCandidate: true,
          field: 'publicDocuments',
          publicPath: overlayRow.publicPath,
          candidateSha256: digest(overlay)
        },
        { path: reviewFile, inCandidate: false, field: 'stripPaths', rulePath: docsStripPath },
        { path: historyOnlyFile, inCandidate: false, field: 'stripPaths', rulePath: docsStripPath }
      ]
    }
  }
  f.proof.policySha256 = digest(f.policyText)
  f.proof.sourceSetSha256 = sourceSetDigest(f.files)
  const ctx = {
    policySha256: f.proof.policySha256,
    sourceSetSha256: f.proof.sourceSetSha256,
    proofSha256: ''
  }
  const strip = (p: string): Boundary['exactRuleFieldAndPath'] => [{ field: 'stripPaths', path: p }]
  f.records = [
    makeRecord(
      'R8',
      toolFile,
      internalPath,
      [
        { kind: 'workspace', inputSha256: digest(tool) },
        { kind: 'history-content', inputSha256: digest(tool), blob: historyOid(tool) }
      ],
      { exactRuleFieldAndPath: strip(toolStripPath) },
      ctx
    ),
    makeRecord(
      'R10',
      'CLAUDE.md',
      virtualUser,
      [{ kind: 'workspace', inputSha256: digest(claude) }],
      {
        exactRuleFieldAndPath: [{ field: 'publicDocuments', path: 'CLAUDE.md' }],
        overlayInputSha256: digest(overlay)
      },
      ctx
    ),
    makeRecord(
      'R8',
      reviewFile,
      internalPath,
      [
        { kind: 'workspace', inputSha256: digest(review) },
        { kind: 'history-content', inputSha256: digest(review), blob: historyOid(review) }
      ],
      { exactRuleFieldAndPath: strip(docsStripPath) },
      ctx
    ),
    makeRecord(
      'R8',
      historyOnlyFile,
      internalPath,
      [
        { kind: 'history-content', inputSha256: digest(historyText), blob: historyOid(historyText) }
      ],
      { exactRuleFieldAndPath: strip(docsStripPath) },
      ctx
    )
  ]
  resign(f, approvalDocument(f.records))
  if (mutate) mutate(f)
  reprove(f)
  return f
}
/** Re-take the boundary binding for the fixture's current policy text and tracked files. */
function reprove(f: Fixture): void {
  f.proof.policySha256 = digest(f.policyText)
  f.proof.sourceSetSha256 = sourceSetDigest(f.files)
  for (const r of f.records) {
    r.boundary.policySha256 = f.proof.policySha256
    r.boundary.sourceSetSha256 = f.proof.sourceSetSha256
    r.boundary.proofSha256 = ''
  }
}
/** Serialise proof + carrier (proof sha bound into every record unless the fixture overrides it). */
function runDisposition(
  f: Fixture,
  options: {
    carrier?: unknown
    proof?: (p: Fixture['proof']) => Fixture['proof']
    extraFiles?: Record<string, string>
  } = {}
): ScanResult {
  const proof = options.proof ? options.proof(JSON.parse(JSON.stringify(f.proof))) : f.proof
  const proofText = JSON.stringify(proof, null, 2) + '\n'
  const proofSha = digest(proofText)
  for (const r of f.records) if (r.boundary.proofSha256 === '') r.boundary.proofSha256 = proofSha
  const carrier = options.carrier ?? { schemaVersion: 1, records: f.records }
  const files = {
    ...f.files,
    ...(options.extraFiles ?? {}),
    [carrierPath]: JSON.stringify(carrier, null, 2) + '\n'
  }
  const hidden = { ...f.hidden, [boundaryRef]: proofText }
  return runScanner({
    files,
    history: f.history,
    hidden,
    policy: f.policyText,
    username: f.username,
    sourceSetFailure: f.sourceSetFailure
  })
}
const recordOf = (report: ScanResult, file: string): DispositionRecord => {
  const row = report.internalDispositions?.records.find((r) => r.file === file)
  assert.ok(row, 'record for ' + file)
  return row
}
function effectiveAll(report: ScanResult): void {
  assert.equal(report.executionError, null)
  assert.equal(report.exitCode, 0)
  assert.deepEqual(report.open, [])
  assert.deepEqual(report.stale, [])
  assert.equal(report.internalDispositions?.status, 'loaded')
  assert.deepEqual(report.internalDispositions?.problems, [])
  assert.equal(report.internalDispositions?.records.length, 4)
  for (const r of report.internalDispositions!.records) assert.equal(r.status, 'effective', r.file)
}

test('Step6c/release face comes from the sole policy: stripped directories keep R8 but drop R10; docs/v2.0 is not stripped', () => {
  const f = dispositionFixture()
  const report = runDisposition(f)
  effectiveAll(report)
  const rules = (file: string): string[] =>
    report.findings.filter((h) => h.file === file).map((h) => h.rule)
  assert.deepEqual(
    [...new Set(rules(toolFile))],
    ['R8'],
    'R10 is not applicable under a stripped rule'
  )
  assert.deepEqual([...new Set(rules(reviewFile))], ['R8'])
  assert.deepEqual(rules('CLAUDE.md'), ['R10'])
  assert.equal(report.findings.length, 18)
  assert.equal(report.internalDispositions?.sourceSet?.sha256, f.proof.sourceSetSha256)
  const calibration = runScanner({ files: { 'docs/v2.0/example.md': fullV6 } })
  openAt(calibration, 'R12', 'docs/v2.0/example.md', fullV6)
  clean(runScanner({ files: { [toolStripPath + 'notes.md']: fullV6 } }))
})
test('Step6c/policy missing or malformed is an execution error, never a clean scan', () => {
  const missing = runScanner({ files: { [probeFile]: 'clean' }, policy: null })
  assert.equal(missing.exitCode, 1)
  assert.equal(missing.policyError, 'POLICY_UNAVAILABLE')
  assert.equal(scannerSummary(missing.logs).status, 'ERROR')
  const broken = runScanner({ files: { [probeFile]: 'clean' }, policy: '{"schemaVersion":1}' })
  assert.equal(broken.exitCode, 1)
  assert.equal(broken.policyError, 'POLICY_INVALID')
  assert.equal(scannerSummary(broken.logs).status, 'ERROR')
})
test('Step6c/absent carrier changes nothing; hits stay open and the report says absent', () => {
  const f = dispositionFixture()
  const report = runScanner({ files: f.files, history: f.history, hidden: f.hidden })
  assert.equal(report.exitCode, 1)
  assert.equal(report.internalDispositions?.status, 'absent')
  assert.equal(report.open.length, 18)
  assert.deepEqual(report.stale, [])
})
test('Step6c/effective records dispose only bound sources; another sensitive value in the same file stays open', () => {
  const f = dispositionFixture()
  const base = runDisposition(f)
  effectiveAll(base)
  assert.deepEqual(recordOf(base, toolFile).disposed, { workspace: 1, history: 1 })
  assert.deepEqual(recordOf(base, 'CLAUDE.md').disposed, { workspace: 1, history: 0 })
  assert.deepEqual(recordOf(base, historyOnlyFile).disposed, { workspace: 0, history: 13 })
  const email = ['scanner-negative-only', 'mail.scan-fixture.net'].join('@')
  const other = ['C:', 'Users', 'fixture-other-person'].join(String.fromCharCode(92))
  for (const injected of [email, other]) {
    const g = dispositionFixture((x) => {
      x.files[toolFile] = x.files[toolFile] + injected + '\n'
    })
    g.records[0].sourceBindings[0].inputSha256 = digest(g.files[toolFile])
    g.records[0].approval.objectSourceScopeSha256 = objectScope(g.records[0])
    resign(g, approvalDocument(g.records)) // the user signs the rebinding; the other value is still open
    const report = runDisposition(g)
    assert.equal(report.exitCode, 1)
    assert.equal(report.open.length, 1)
    assert.equal(report.open[0].file, toolFile)
    assert.equal(report.open[0].sha, shortHash(injected))
    assert.equal(recordOf(report, toolFile).status, 'effective')
    assert.deepEqual(recordOf(report, toolFile).disposed, { workspace: 1, history: 1 })
  }
})
test('Step6c/input drift: a rewritten source keeps its history disposal but the new workspace hit is open; a vanished object is stale', () => {
  const drifted = dispositionFixture((x) => {
    x.files[toolFile] = x.files[toolFile] + 'appended line\n'
  })
  const report = runDisposition(drifted)
  assert.equal(report.exitCode, 1)
  assert.deepEqual(
    report.open.map((h) => [h.file, h.source?.kind]),
    [[toolFile, 'workspace-content']]
  )
  const row = recordOf(report, toolFile)
  assert.equal(row.status, 'effective')
  assert.deepEqual(row.disposed, { workspace: 0, history: 1 })
  const gone = dispositionFixture((x) => {
    x.files['CLAUDE.md'] = 'shared memory root removed\n'
  })
  const stale = runDisposition(gone)
  assert.equal(stale.exitCode, 1)
  assert.deepEqual(stale.open, [])
  const claude = recordOf(stale, 'CLAUDE.md')
  assert.equal(claude.status, 'stale')
  assert.deepEqual(claude.problems, ['ACTIVE_STALE'])
})
type RejectionCase = {
  name: string
  mutate?: (f: Fixture) => void
  /** Applied after the fixture is re-proved (for bindings that reprove would otherwise restore). */
  after?: (f: Fixture) => void
  proof?: (p: Fixture['proof']) => Fixture['proof']
  file?: string
  openFile?: string
  code: string
}
const rejectionCases: RejectionCase[] = [
  {
    name: 'unknown record field is rejected',
    mutate: (f) => Object.assign(f.records[0], { effective: true }),
    code: 'RECORD_SCHEMA_INVALID'
  },
  {
    name: 'missing approval block is rejected',
    mutate: (f) => delete (f.records[0] as Partial<Record6c>).approval,
    code: 'RECORD_SCHEMA_INVALID'
  },
  {
    name: 'wrong scope is rejected',
    mutate: (f) => (f.records[0].scope = 'candidate'),
    code: 'RECORD_SCHEMA_INVALID'
  },
  {
    name: 'wildcard file key is rejected',
    mutate: (f) => (f.records[0].key.file = toolStripPath + '*'),
    file: toolStripPath + '*',
    code: 'KEY_FILE_INVALID'
  },
  {
    name: 'automated reviewer is rejected',
    mutate: (f) => (f.records[0].approval.reviewer = 'codex'),
    code: 'REVIEWER_INVALID'
  },
  {
    name: 'future approval date is rejected',
    mutate: (f) => (f.records[0].approval.approvedAt = '2099-01-01'),
    code: 'APPROVED_AT_INVALID'
  },
  {
    name: 'approval proof missing',
    mutate: (f) => delete f.hidden[approvalRef],
    code: 'APPROVAL_PROOF_MISSING'
  },
  {
    name: 'approval proof hash mismatch',
    mutate: (f) => (f.records[0].approval.proofSha256 = digest('other')),
    code: 'APPROVAL_PROOF_MISMATCH'
  },
  {
    name: 'object/source/scope digest mismatch',
    mutate: (f) => (f.records[0].approval.objectSourceScopeSha256 = digest('other')),
    code: 'OBJECT_SCOPE_MISMATCH'
  },
  {
    name: 'workspace binding cannot borrow a history approval',
    mutate: (f) => {
      f.records[0].sourceBindings = [
        {
          kind: 'workspace',
          inputSha256: digest(f.files[toolFile]),
          blob: historyOid(f.files[toolFile])
        }
      ]
      f.records[0].approval.objectSourceScopeSha256 = objectScope(f.records[0])
    },
    code: 'RECORD_SCHEMA_INVALID'
  },
  {
    name: 'duplicate source binding is rejected',
    mutate: (f) => {
      f.records[0].sourceBindings.push({ ...f.records[0].sourceBindings[0] })
      f.records[0].approval.objectSourceScopeSha256 = objectScope(f.records[0])
    },
    code: 'DUPLICATE_SOURCE_BINDING'
  },
  {
    name: 'boundary rule not covering the file',
    mutate: (f) =>
      (f.records[0].boundary.exactRuleFieldAndPath = [
        { field: 'stripPaths', path: docsStripPath }
      ]),
    code: 'BOUNDARY_NOT_COVERING_FILE'
  },
  {
    name: 'boundary rule path absent from the policy',
    mutate: (f) =>
      (f.records[0].boundary.exactRuleFieldAndPath = [
        { field: 'stripPaths', path: 'not-a-rule/' }
      ]),
    code: 'BOUNDARY_RULE_NOT_IN_POLICY'
  },
  {
    name: 'package-only boundary is not a source boundary',
    mutate: (f) =>
      (f.records[0].boundary.exactRuleFieldAndPath = [
        { field: 'artifactRules', path: toolStripPath }
      ]),
    code: 'BOUNDARY_NOT_COVERING_FILE'
  },
  {
    name: 'unknown boundary field',
    mutate: (f) =>
      (f.records[0].boundary.exactRuleFieldAndPath = [
        { field: 'requiredTargets', path: toolStripPath }
      ]),
    code: 'RECORD_SCHEMA_INVALID'
  },
  {
    name: 'record bound to another policy digest',
    after: (f) => (f.records[0].boundary.policySha256 = digest('old-policy')),
    code: 'POLICY_CHANGED'
  },
  {
    name: 'record bound to another source set digest',
    after: (f) => (f.records[0].boundary.sourceSetSha256 = digest('old-set')),
    code: 'SOURCE_SET_CHANGED'
  },
  {
    name: 'overlay hash on a stripped-path record is forged',
    mutate: (f) => (f.records[0].boundary.overlayInputSha256 = digest('x')),
    code: 'OVERLAY_NOT_APPLICABLE'
  },
  {
    name: 'overlay record without overlay hash',
    mutate: (f) => delete f.records[1].boundary.overlayInputSha256,
    file: 'CLAUDE.md',
    code: 'OVERLAY_REQUIRED'
  },
  {
    name: 'public overlay bytes changed after review',
    mutate: (f) => (f.files[overlayRow.publicPath] = f.files[overlayRow.publicPath] + 'edited\n'),
    file: 'CLAUDE.md',
    code: 'OVERLAY_INPUT_MISMATCH'
  },
  {
    name: 'registry publicSha256 disagrees with the record',
    mutate: (f) =>
      (f.files[registryPath] = f.files[registryPath].replace(
        digest('shared memory root is machine-local and not published\n'),
        digest('z')
      )),
    file: 'CLAUDE.md',
    code: 'OVERLAY_REGISTRY_MISMATCH'
  },
  {
    name: 'boundary proof missing',
    mutate: (f) => (f.records[0].boundary.proofRef = evidenceRoot + '/missing.json'),
    code: 'BOUNDARY_PROOF_MISSING'
  },
  {
    name: 'boundary proof identity differs',
    proof: (p) => ({ ...p, identityContextSha256: identityDigest('someone-else') }),
    code: 'IDENTITY_MISMATCH'
  },
  {
    name: 'boundary proof lacks an assertion for the file',
    proof: (p) => ({ ...p, assertions: p.assertions.filter((a) => a.path !== toolFile) }),
    code: 'BOUNDARY_PROOF_ASSERTION_MISSING'
  },
  {
    name: 'boundary proof asserts the wrong candidate state',
    proof: (p) => ({
      ...p,
      assertions: p.assertions.map((a) => (a.path === toolFile ? { ...a, inCandidate: true } : a))
    }),
    code: 'BOUNDARY_PROOF_ASSERTION_MISMATCH'
  },
  {
    name: 'boundary proof bound to another policy',
    proof: (p) => ({ ...p, policySha256: digest('other-policy') }),
    code: 'BOUNDARY_PROOF_POLICY_MISMATCH'
  },
  {
    name: 'boundary proof bound to another source set',
    proof: (p) => ({ ...p, sourceSetSha256: digest('other-set') }),
    code: 'BOUNDARY_PROOF_SOURCE_SET_MISMATCH'
  },
  {
    name: 'boundary proof is not the declared kind',
    proof: (p) => ({ ...p, kind: 'something-else' }),
    code: 'BOUNDARY_PROOF_INVALID'
  },
  {
    name: 'identity unavailable (short username)',
    mutate: (f) => (f.username = 'u'),
    code: 'IDENTITY_UNAVAILABLE'
  },
  {
    name: 'source set cannot be enumerated',
    mutate: (f) => (f.sourceSetFailure = true),
    code: 'SOURCE_SET_UNVERIFIABLE'
  }
]
for (const c of rejectionCases)
  test('Step6c/rejects: ' + c.name, () => {
    const fixture = dispositionFixture(c.mutate)
    c.after?.(fixture)
    const report = runDisposition(fixture, { proof: c.proof })
    assert.equal(report.executionError, null)
    assert.equal(report.exitCode, 1)
    const row = recordOf(report, c.file ?? toolFile)
    assert.equal(row.status, 'rejected', JSON.stringify(row))
    assert.ok(row.problems.includes(c.code), row.problems.join(','))
    const openFile = c.openFile ?? (c.file && !c.file.endsWith('*') ? c.file : toolFile)
    assert.ok(
      report.open.some((h) => h.file === openFile),
      'a rejected record never suppresses its hits'
    )
  })
test('Step6c/rejects: rule outside R8/R10/R11 and credential rules are never eligible', () => {
  for (const [rule, value] of [
    ['R12', fullV6],
    ['R7', ['scanner-negative-only', 'mail.scan-fixture.net'].join('@')],
    ['R4', ['sec', 'ret'].join('') + " = 'scanner-synthetic-other-value'"]
  ] as const) {
    const f = dispositionFixture((x) => {
      x.files[probeFile] = value + '\n'
      x.proof.assertions.push({ path: probeFile, inCandidate: false })
    })
    f.records.push(
      makeRecord(
        'R8',
        probeFile,
        value,
        [{ kind: 'workspace', inputSha256: digest(f.files[probeFile]) }],
        { exactRuleFieldAndPath: [{ field: 'stripPaths', path: docsStripPath }] },
        {
          policySha256: f.proof.policySha256,
          sourceSetSha256: f.proof.sourceSetSha256,
          proofSha256: ''
        }
      )
    )
    f.records[4].key.rule = rule
    f.records[4].approval.objectSourceScopeSha256 = objectScope(f.records[4])
    f.records[4].approval.proofSha256 = digest(f.hidden[approvalRef])
    const report = runDisposition(f)
    assert.equal(report.exitCode, 1)
    assert.equal(recordOf(report, probeFile).status, 'rejected')
    assert.ok(recordOf(report, probeFile).problems.includes('RULE_NOT_ELIGIBLE'))
    assert.ok(report.open.some((h) => h.file === probeFile && h.rule === rule))
  }
})
test('Step6c/rejects: duplicate objects, unknown top-level keys and unparseable carriers fail closed', () => {
  const dup = dispositionFixture((x) => x.records.push(JSON.parse(JSON.stringify(x.records[0]))))
  const report = runDisposition(dup)
  assert.equal(report.exitCode, 1)
  assert.ok(
    report.internalDispositions?.records
      .filter((r) => r.file === toolFile)
      .every((r) => r.problems.includes('DUPLICATE_OBJECT'))
  )
  assert.ok(report.open.some((h) => h.file === toolFile))
  const forced = runDisposition(dispositionFixture(), {
    carrier: { schemaVersion: 1, records: [], force: true }
  })
  assert.equal(forced.exitCode, 1)
  assert.equal(forced.internalDispositions?.status, 'invalid')
  assert.deepEqual(
    forced.internalDispositions?.problems.map((p) => p.code),
    ['CARRIER_SCHEMA_INVALID']
  )
  assert.equal(forced.open.length, 18)
  const f = dispositionFixture()
  const broken = runScanner({
    files: { ...f.files, [carrierPath]: '{ not json' },
    history: f.history,
    hidden: f.hidden
  })
  assert.equal(broken.exitCode, 1)
  assert.equal(broken.internalDispositions?.status, 'invalid')
  assert.deepEqual(
    broken.internalDispositions?.problems.map((p) => p.code),
    ['CARRIER_PARSE_ERROR']
  )
})
test('Step6c/source set: any tracked addition or content change invalidates every boundary until re-proved', () => {
  const added = runDisposition(dispositionFixture(), {
    extraFiles: { 'src/main/new.ts': 'export {}\n' }
  })
  assert.equal(added.exitCode, 1)
  for (const r of added.internalDispositions!.records) {
    assert.equal(r.status, 'rejected')
    assert.ok(r.problems.includes('SOURCE_SET_CHANGED'), r.file)
  }
  assert.equal(added.open.length, 18)
  const staleFixture = dispositionFixture()
  staleFixture.files['src/main/index.ts'] = 'export const changed = 1\n'
  const edited = runDisposition(staleFixture)
  assert.equal(edited.exitCode, 1)
  assert.ok(
    edited.internalDispositions!.records.every((r) => r.problems.includes('SOURCE_SET_CHANGED'))
  )
  const reproved = dispositionFixture(
    (x) => (x.files['src/main/index.ts'] = 'export const changed = 1\n')
  )
  effectiveAll(runDisposition(reproved))
})
test('Step6c/candidate-like inputs cannot consume the carrier: no proofs, no F-08 declaration, or a proof that is tracked', () => {
  const f = dispositionFixture()
  for (const r of f.records) r.boundary.proofSha256 = digest('proof-never-present')
  const noProofs = runScanner({
    files: { ...f.files, [carrierPath]: JSON.stringify({ schemaVersion: 1, records: f.records }) },
    history: f.history,
    hidden: {}
  })
  assert.equal(noProofs.exitCode, 1)
  assert.equal(noProofs.open.length, 18)
  for (const r of noProofs.internalDispositions!.records) {
    assert.equal(r.status, 'rejected')
    assert.ok(r.problems.includes('APPROVAL_PROOF_MISSING'))
  }
  const undeclared = {
    ...realPolicy,
    forbiddenCandidatePaths: realPolicy.forbiddenCandidatePaths.filter((r) => r.id !== 'F-08')
  }
  const g = dispositionFixture((x) => (x.policyText = JSON.stringify(undeclared)))
  const report = runDisposition(g)
  assert.equal(report.exitCode, 1)
  assert.equal(report.internalDispositions?.status, 'not-declared')
  assert.equal(report.open.length, 18)
  const tracked = dispositionFixture((x) => {
    x.files[approvalRef] = x.hidden[approvalRef]
    delete x.hidden[approvalRef]
  })
  const leaked = runDisposition(tracked)
  assert.equal(leaked.exitCode, 1)
  assert.ok(
    leaked.internalDispositions!.records.every((r) => r.problems.includes('PROOF_REF_TRACKED'))
  )
})
test('Step6c/report lists the carrier, per-record status and disposal counts without identity, raw text or proof contents', () => {
  const f = dispositionFixture()
  const report = runDisposition(f)
  const summary = scannerSummary(report.logs) as unknown as {
    internalDispositions: DispositionState
    counts: { disposed: number; dispositionProblems: number }
    releaseFace: { stripRules: number; policySha256: string }
  }
  assert.equal(summary.internalDispositions.path, carrierPath)
  assert.equal(summary.internalDispositions.records.length, 4)
  assert.equal(summary.counts.disposed, 18)
  assert.equal(summary.counts.dispositionProblems, 0)
  assert.equal(summary.releaseFace.stripRules, realPolicy.stripPaths.length)
  assert.equal(summary.releaseFace.policySha256, digest(realPolicyText))
  for (const hidden of [virtualUser, virtualRoot, internalPath, APPROVAL_HEADER])
    assert.ok(!report.logs.includes(hidden), 'log must not contain ' + hidden)
  assert.ok(report.logs.includes('内部受限处置'))
})
test('Step6c/approval listing: a binding not listed in the signed text is rejected even when the record is self-consistent and matches the file', () => {
  // Option-B scenario: the file is rewritten, the record is rebound to the new bytes and its object digest
  // recomputed, but the user never signed the new input hash.
  const f = dispositionFixture((x) => {
    x.files[toolFile] = x.files[toolFile] + 'appended after signing\n'
    x.records[0].sourceBindings[0].inputSha256 = digest(x.files[toolFile])
    x.records[0].approval.objectSourceScopeSha256 = objectScope(x.records[0])
  })
  const report = runDisposition(f)
  assert.equal(report.exitCode, 1)
  const row = recordOf(report, toolFile)
  assert.equal(row.status, 'rejected')
  assert.deepEqual(row.problems, ['BINDING_NOT_IN_APPROVAL_PROOF'])
  assert.ok(report.open.some((h) => h.file === toolFile && h.source?.kind === 'workspace-content'))
  assert.deepEqual(row.disposed, { workspace: 0, history: 0 })
})
test('Step6c/approval listing: a hash mentioned only in prose of a re-signed text is not a listed binding; a table row is', () => {
  const build = (): Fixture =>
    dispositionFixture((x) => {
      x.files[toolFile] = x.files[toolFile] + 'appended after signing\n'
      x.records[0].sourceBindings[0].inputSha256 = digest(x.files[toolFile])
      x.records[0].approval.objectSourceScopeSha256 = objectScope(x.records[0])
    })
  const prose = build()
  resign(
    prose,
    prose.hidden[approvalRef] +
      '组1当前文件SHA256=`' +
      digest(prose.files[toolFile]) +
      '`，仅作未覆盖输入标识，不在批准范围。\n'
  )
  const rejected = runDisposition(prose)
  assert.equal(rejected.exitCode, 1)
  assert.deepEqual(recordOf(rejected, toolFile).problems, ['BINDING_NOT_IN_APPROVAL_PROOF'])
  const row = build()
  resign(row, approvalDocument(row.records))
  effectiveAll(runDisposition(row))
})
test('Step6c/approval listing: an object whose key literal is absent from the signed text is rejected', () => {
  const f = dispositionFixture()
  const keyLine =
    '`' +
    [f.records[1].key.rule, f.records[1].key.file, f.records[1].key.matchedTextSha12].join('|') +
    '`'
  assert.ok(f.hidden[approvalRef].includes(keyLine))
  resign(f, f.hidden[approvalRef].replace(keyLine, '`(redacted)`'))
  const report = runDisposition(f)
  assert.equal(report.exitCode, 1)
  const row = recordOf(report, 'CLAUDE.md')
  assert.equal(row.status, 'rejected')
  assert.deepEqual(row.problems, ['OBJECT_NOT_IN_APPROVAL_PROOF'])
  assert.ok(report.open.some((h) => h.file === 'CLAUDE.md'))
  assert.equal(recordOf(report, toolFile).status, 'effective')
})
test('Step6c/approval listing: a history binding needs its blob on the same table row', () => {
  const f = dispositionFixture()
  const doc = f.hidden[approvalRef]
  const blob = f.records[0].sourceBindings[1].blob!
  const rowLine = doc.split('\n').find((l) => l.includes(blob))!
  resign(
    f,
    doc.replace(
      rowLine,
      rowLine.replace('`' + blob + '`', '不适用') + '\n' + '历史blob见另表：`' + blob + '`'
    )
  )
  const report = runDisposition(f)
  assert.equal(report.exitCode, 1)
  assert.deepEqual(recordOf(report, toolFile).problems, ['BINDING_NOT_IN_APPROVAL_PROOF'])
  assert.ok(report.open.some((h) => h.file === toolFile && h.source?.kind === 'history-content'))
})
