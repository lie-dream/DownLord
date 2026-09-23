import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ensureWritableYtDlp, MIN_VALID_YTDLP_BYTES, type WritableFs } from './ensureWritable'

const binDir = 'C:\\app\\resources\\bin'
const userDataDir = 'C:\\Users\\x\\AppData\\Roaming\\DownLord'

interface MockState {
  existing: Set<string>
  sizes: Map<string, number>
  copies: Array<{ src: string; dest: string }>
  mkdirs: string[]
}

function newState(): MockState {
  return { existing: new Set(), sizes: new Map(), copies: [], mkdirs: [] }
}

function makeFs(state: MockState): WritableFs {
  return {
    existsSync: (p) => state.existing.has(p),
    statSync: (p) => ({ size: state.sizes.get(p) ?? 0 }),
    mkdirSync: (p) => {
      state.mkdirs.push(p)
    },
    copyFileSync: (src, dest) => {
      state.copies.push({ src, dest })
      state.existing.add(dest)
      state.sizes.set(dest, state.sizes.get(src) ?? 0)
    }
  }
}

/** 用一次空 state 调用拿到真实 source / target 路径,便于后续用例构造 state。 */
function resolvePaths(): { source: string; target: string } {
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(newState()) })
  return { source: r.source, target: r.target }
}

const { source, target } = resolvePaths()

test('可写区无副本 + 内置源存在 → copied(首次拷贝)', () => {
  const state = newState()
  state.existing.add(source)
  state.sizes.set(source, 18_000_000)
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(state) })
  assert.equal(r.action, 'copied')
  assert.equal(state.copies.length, 1)
  assert.deepEqual(state.copies[0], { src: source, dest: target })
})

test('副本已存在且有效(≥ 阈值)→ skipped(尊重热更新版本,不覆盖)', () => {
  const state = newState()
  state.existing.add(source)
  state.sizes.set(source, 18_000_000)
  state.existing.add(target)
  state.sizes.set(target, 20_000_000) // 比内置更大(模拟用户热更新的新版本)
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(state) })
  assert.equal(r.action, 'skipped')
  assert.equal(state.copies.length, 0, '有效副本不应被覆盖')
})

test('占位 / 损坏副本(12 字节 < 阈值)+ 源存在 → replaced(修复 spawn UNKNOWN 根因)', () => {
  const state = newState()
  state.existing.add(source)
  state.sizes.set(source, 18_000_000)
  state.existing.add(target)
  state.sizes.set(target, 12) // Task 1 "placeholder" 12 字节
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(state) })
  assert.equal(r.action, 'replaced')
  assert.equal(state.copies.length, 1, '坏副本应被内置覆盖重拷')
  assert.deepEqual(state.copies[0], { src: source, dest: target })
  assert.equal(state.sizes.get(target), 18_000_000, '副本已更新为真实大小')
})

test('阈值边界:恰好达阈值 → skipped;差 1 字节 → replaced', () => {
  const s1 = newState()
  s1.existing.add(source)
  s1.sizes.set(source, 18_000_000)
  s1.existing.add(target)
  s1.sizes.set(target, MIN_VALID_YTDLP_BYTES)
  assert.equal(ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(s1) }).action, 'skipped')

  const s2 = newState()
  s2.existing.add(source)
  s2.sizes.set(source, 18_000_000)
  s2.existing.add(target)
  s2.sizes.set(target, MIN_VALID_YTDLP_BYTES - 1)
  assert.equal(ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(s2) }).action, 'replaced')
})

test('内置源缺失 + 无副本 → source-missing(不崩)', () => {
  const state = newState()
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(state) })
  assert.equal(r.action, 'source-missing')
  assert.equal(state.copies.length, 0)
})

test('坏副本 + 内置源也缺失 → source-missing(无源可拷,坏副本保留、不崩)', () => {
  const state = newState()
  state.existing.add(target)
  state.sizes.set(target, 12) // 坏副本存在但无源可替换
  const r = ensureWritableYtDlp({ binDir, userDataDir, fs: makeFs(state) })
  assert.equal(r.action, 'source-missing')
  assert.equal(state.copies.length, 0)
})
