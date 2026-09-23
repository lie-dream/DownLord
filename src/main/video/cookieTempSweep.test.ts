import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { sweepCookieTempDir, type CookieTempSweepFs } from './cookieTempSweep'

/**
 * N7 —— 启动清扫(spec §8.1,fake fs):
 * 只删匹配名、**不匹配名留下** / 目录缺失时建之 / 计数 / 单条失败不中断。
 */

interface FakeFsState {
  exists: boolean
  entries: string[]
  removed: string[]
  mkdirs: { path: string; options: { recursive: boolean } }[]
  failOn?: string
}

function fakeFs(state: FakeFsState): CookieTempSweepFs {
  return {
    existsSync: () => state.exists,
    mkdirSync(path, options) {
      state.mkdirs.push({ path, options })
    },
    readdirSync: () => state.entries,
    rmSync(path) {
      if (state.failOn !== undefined && path.endsWith(state.failOn)) {
        throw new Error('EPERM: operation not permitted')
      }
      state.removed.push(path)
    }
  }
}

const HEX_A = 'a'.repeat(32)
const HEX_B = 'b'.repeat(32)
const HEX_C = 'c'.repeat(32)
const DIR = join('C:', 'ud', 'cookies-tmp')

test('N7 只删匹配名、不匹配名留下(绝不 rm -rf 整个目录)', () => {
  const state: FakeFsState = {
    exists: true,
    entries: [
      `ck-${HEX_A}.txt`,
      `ck-${HEX_B}.txt`,
      'settings.json', // 别人的东西 —— 万一路径配歪了,这一条就是护栏
      'ck-short.txt', // 长度不足 32
      `ck-${'A'.repeat(32)}.txt`, // 大写十六进制:不是我们产的名字
      `ck-${HEX_C}.txt.bak`, // 后缀不对
      `notck-${HEX_C}.txt` // 前缀不对
    ],
    removed: [],
    mkdirs: []
  }

  sweepCookieTempDir(fakeFs(state), DIR)

  assert.deepEqual(state.removed, [join(DIR, `ck-${HEX_A}.txt`), join(DIR, `ck-${HEX_B}.txt`)])
})

test('N7 计数正确(removed = 实际删掉的条数)', () => {
  const state: FakeFsState = {
    exists: true,
    entries: [`ck-${HEX_A}.txt`, 'settings.json', `ck-${HEX_B}.txt`, `ck-${HEX_C}.txt`],
    removed: [],
    mkdirs: []
  }

  assert.deepEqual(sweepCookieTempDir(fakeFs(state), DIR), { removed: 3 })
})

test('N7 目录不存在 → mkdirSync(recursive:true) 建之,removed = 0', () => {
  const state: FakeFsState = { exists: false, entries: [], removed: [], mkdirs: [] }

  assert.deepEqual(sweepCookieTempDir(fakeFs(state), DIR), { removed: 0 })
  assert.deepEqual(state.mkdirs, [{ path: DIR, options: { recursive: true } }])
  assert.deepEqual(state.removed, [])
})

test('N7 目录存在时不建目录(正向对照:上一条的 mkdir 不是无条件调用的)', () => {
  const state: FakeFsState = { exists: true, entries: [], removed: [], mkdirs: [] }

  assert.deepEqual(sweepCookieTempDir(fakeFs(state), DIR), { removed: 0 })
  assert.deepEqual(state.mkdirs, [])
})

test('N7 单条删除失败不中断、不抛,失败的那条不计数', () => {
  const state: FakeFsState = {
    exists: true,
    entries: [`ck-${HEX_A}.txt`, `ck-${HEX_B}.txt`, `ck-${HEX_C}.txt`],
    removed: [],
    mkdirs: [],
    failOn: `ck-${HEX_B}.txt`
  }

  let result: { removed: number } | undefined
  assert.doesNotThrow(() => {
    result = sweepCookieTempDir(fakeFs(state), DIR)
  })

  // 中间那条炸了,后面那条照删 —— 「不中断」的实证
  assert.deepEqual(state.removed, [join(DIR, `ck-${HEX_A}.txt`), join(DIR, `ck-${HEX_C}.txt`)])
  assert.deepEqual(result, { removed: 2 })
})
