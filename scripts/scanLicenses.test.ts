import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const scanner = join(root, 'scripts/scan-licenses.mjs')
const fixtureRoot = join(root, '.tmp-probe/task5-fixtures')
const acknowledged: [string, string][] = [
  ['@csstools/color-helpers', 'MIT-0'],
  ['@csstools/css-syntax-patches-for-csstree', 'MIT-0'],
  ['caniuse-lite', 'CC-BY-4.0'],
  ['truncate-utf8-bytes', 'WTFPL']
]

function fixture(omitted: string[] = []): string {
  mkdirSync(fixtureRoot, { recursive: true })
  const dir = mkdtempSync(join(fixtureRoot, 'phase1-license-scan-'))
  const rootPackage = {
    name: 'license-scan-fixture',
    version: '1.0.0',
    dependencies: { react: '1.0.0', 'react-dom': '1.0.0', '@fluentui/react-components': '1.0.0' }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(rootPackage))
  const packages: Record<string, object> = { '': rootPackage }
  for (const [name, license] of [
    ...acknowledged,
    ...Object.keys(rootPackage.dependencies).map((name) => [name, 'MIT'] as [string, string])
  ]) {
    if (omitted.includes(name)) continue
    const entry = { name, version: '1.0.0', license }
    const path = `node_modules/${name}`
    mkdirSync(join(dir, path), { recursive: true })
    writeFileSync(join(dir, path, 'package.json'), JSON.stringify(entry))
    packages[path] = entry
  }
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  return dir
}

let scanNumber = 0

function scan(dir: string): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [scanner], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  assert.ifError(result.error)
  const record = { code: result.status, output: result.stdout + result.stderr }
  writeFileSync(join(dir, `scan-result-${++scanNumber}.json`), JSON.stringify(record, null, 2))
  return record
}

function editLock(
  dir: string,
  edit: (lock: { packages: Record<string, Record<string, unknown>> }) => void
): void {
  const path = join(dir, 'package-lock.json')
  const lock = JSON.parse(readFileSync(path, 'utf8'))
  edit(lock)
  writeFileSync(path, JSON.stringify(lock))
}

test('license scanner accepts a complete locked input, without certifying engine artifacts', () => {
  const result = scan(fixture())
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /npm 依赖零未定性许可证/)
  assert.match(result.output, /不验证.*EXE.*包内/)
})

test('license scanner rejects missing locked build input even when every adjudication still matches', () => {
  const dir = fixture()
  editLock(dir, (lock) => {
    lock.packages['node_modules/missing-build-tool'] = {
      version: '1.0.0',
      dev: true,
      license: 'MIT'
    }
  })
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /输入不完整/)
  assert.match(result.output, /missing-build-tool/)
})

test('license scanner rejects a missing applicable optional package but permits another platform', () => {
  const dir = fixture()
  editLock(dir, (lock) => {
    lock.packages['node_modules/other-platform'] = {
      version: '1.0.0',
      optional: true,
      os: [process.platform === 'win32' ? 'darwin' : 'win32']
    }
  })
  assert.equal(scan(dir).code, 0)
  editLock(dir, (lock) => {
    lock.packages['node_modules/current-platform'] = {
      version: '1.0.0',
      optional: true,
      os: [process.platform]
    }
  })
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /current-platform/)
})

test('license scanner rejects installed versions that differ from the lock', () => {
  const dir = fixture()
  const path = join(dir, 'node_modules/react/package.json')
  writeFileSync(path, JSON.stringify({ name: 'react', version: '9.9.9', license: 'MIT' }))
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /版本不匹配/)
})

test('license scanner rejects empty node_modules explicitly, not as a zero-package green report', () => {
  mkdirSync(fixtureRoot, { recursive: true })
  const dir = mkdtempSync(join(fixtureRoot, 'phase1-license-empty-'))
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }))
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'empty', version: '1.0.0' } } })
  )
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /输入不完整/)
  assert.match(result.output, /node_modules.*为空/)
})

test('license scanner still fails open and stale exact adjudications', () => {
  const dir = fixture()
  const path = join(dir, 'node_modules/@csstools/color-helpers/package.json')
  writeFileSync(
    path,
    JSON.stringify({ name: '@csstools/color-helpers', version: '1.0.0', license: 'GPL-3.0-only' })
  )
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /未定性 1 个包/)
  assert.match(result.output, /登记表失效 1 条/)
})
test('engine static registration distinguishes yt-dlp source Unlicense from the shipped GPL executable', () => {
  const result = scan(fixture())
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /yt-dlp\.exe\s+2026\.07\.04\s+——\s+GPL-3\.0-or-later/)
  assert.match(result.output, /源码许可:Unlicense/)
  assert.doesNotMatch(result.output, /2026\.06\.09|GPL 传染性的常规隔离/)
})

function declareDependencies(dir: string, path: string, fields: Record<string, unknown>): void {
  const manifest = join(dir, path, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  Object.assign(pkg, fields)
  writeFileSync(manifest, JSON.stringify(pkg))
  editLock(dir, (lock) => Object.assign(lock.packages[path], fields))
}

function addLeaf(dir: string, path: string): void {
  const pkg = { name: 'fixture-leaf', version: '1.0.0', license: 'MIT' }
  mkdirSync(join(dir, path), { recursive: true })
  writeFileSync(join(dir, path, 'package.json'), JSON.stringify(pkg))
  editLock(dir, (lock) => {
    lock.packages[path] = pkg
  })
}

test('license scanner rejects a root required dependency missing from both lock entries and disk', () => {
  const result = scan(fixture(['react']))
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /必需依赖.*react/)
})

test('license scanner rejects a root dev dependency missing from both lock entries and disk', () => {
  const dir = fixture()
  declareDependencies(dir, '', { devDependencies: { 'missing-build-input': '1.0.0' } })
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /必需依赖.*missing-build-input/)
})

test('license scanner rejects a transitive required dependency missing from both lock and disk', () => {
  const dir = fixture()
  declareDependencies(dir, 'node_modules/react', { dependencies: { 'fixture-leaf': '1.0.0' } })
  const result = scan(dir)
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, new RegExp('必需依赖.*node_modules/react.*fixture-leaf'))
})

test('license scanner uses npm parent resolution, accepting hoisted and nested packages but not a sibling', () => {
  for (const [location, expected] of [
    ['node_modules/fixture-leaf', 0],
    ['node_modules/react/node_modules/fixture-leaf', 0],
    ['node_modules/react-dom/node_modules/fixture-leaf', 1]
  ] as const) {
    const dir = fixture()
    declareDependencies(dir, 'node_modules/react', { dependencies: { 'fixture-leaf': '1.0.0' } })
    addLeaf(dir, location)
    const result = scan(dir)
    assert.equal(result.code, expected, location + '\n' + result.output)
    if (expected === 1) assert.match(result.output, /必需依赖.*fixture-leaf/)
  }
})

test('license scanner distinguishes required peers from optional peers and incompatible optional dependencies', () => {
  const dir = fixture()
  declareDependencies(dir, 'node_modules/react', {
    dependencies: { 'other-platform': '1.0.0' },
    optionalDependencies: { 'other-platform': '1.0.0' },
    peerDependencies: { 'absent-peer': '1.0.0' },
    peerDependenciesMeta: { 'absent-peer': { optional: true } }
  })
  editLock(dir, (lock) => {
    lock.packages['node_modules/other-platform'] = {
      version: '1.0.0',
      optional: true,
      os: [process.platform === 'win32' ? 'darwin' : 'win32']
    }
  })
  const allowed = scan(dir)
  assert.equal(allowed.code, 0, allowed.output)
  declareDependencies(dir, 'node_modules/react', { peerDependenciesMeta: {} })
  const rejected = scan(dir)
  assert.equal(rejected.code, 1, rejected.output)
  assert.match(rejected.output, /必需依赖.*absent-peer/)
})

for (const linkName of ['linked-package', '@linked-scope']) {
  test('license scanner explicitly rejects an actual package link: ' + linkName, () => {
    const dir = fixture()
    const source = join(dir, 'link-source')
    mkdirSync(source)
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'linked-package', version: '1.0.0', license: 'GPL-3.0-only' })
    )
    // Both ends remain inside this isolated fixture; no external traversal or cleanup.
    symlinkSync(
      source,
      join(dir, 'node_modules', linkName),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const result = scan(dir)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /链接.*无法核定/)
    assert.match(result.output, new RegExp(linkName))
  })
}
