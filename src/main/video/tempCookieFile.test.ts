import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { createCookieFileLease, type CookieFileLeaseDeps } from './tempCookieFile'
import type { NetscapeCookieGroup } from './netscapeCookies'

/**
 * N6 —— 临时文件租约(spec §8.1,fake fs):
 * 随机名形状 / `mode` 传参 / `release` 幂等 / 删除失败不抛。
 *
 * ⚠️ 「文件确实被删」的**真 fs 断言**属 I-C1 / I-C2 / I-C2b(spec §4.6),在 Phase 2 接线后落地 ——
 * 那三条必须用真临时目录,fake fs 证不了「文件被删了」。本节只管本模块自己的行为契约。
 */

interface Recorded {
  writes: { path: string; data: string; options: { encoding: string; mode: number } }[]
  removes: { path: string; options: { force: boolean } }[]
}

function fakeDeps(
  hex = 'a'.repeat(32),
  onRemove?: (path: string) => void
): { deps: CookieFileLeaseDeps; rec: Recorded } {
  const rec: Recorded = { writes: [], removes: [] }
  return {
    rec,
    deps: {
      writeFileSync(path, data, options) {
        rec.writes.push({ path, data, options })
      },
      rmSync(path, options) {
        rec.removes.push({ path, options })
        onRemove?.(path)
      },
      randomHex(bytes) {
        assert.equal(bytes, 16, '随机部分必须是 16 字节 → 32 个十六进制字符')
        return hex
      }
    }
  }
}

const GROUPS: NetscapeCookieGroup[] = [
  {
    host: 'www.example.com',
    cookies: [
      { name: 'sid', value: 'abc', domain: 'www.example.com', path: '/', secure: true, httpOnly: true }
    ]
  }
]

test('N6 文件名形状 ck-<32hex>.txt,落在给定目录下', () => {
  const { deps } = fakeDeps()
  const lease = createCookieFileLease(deps, join('C:', 'ud', 'cookies-tmp'), ['www.example.com'], GROUPS)

  assert.equal(lease.path, join('C:', 'ud', 'cookies-tmp', `ck-${'a'.repeat(32)}.txt`))
  // 与 sweepCookieTempDir 的清扫正则同源 —— 两边对不上,残留就永远清不掉
  assert.match(lease.path.split(/[\\/]/).pop() ?? '', /^ck-[0-9a-f]{32}\.txt$/)
})

test('N6 写入 utf8 + mode 0o600,内容 = toNetscapeCookieFile 的产出', () => {
  const { deps, rec } = fakeDeps()
  createCookieFileLease(deps, 'dir', ['www.example.com'], GROUPS)

  assert.equal(rec.writes.length, 1)
  assert.deepEqual(rec.writes[0].options, { encoding: 'utf8', mode: 0o600 })
  assert.equal(
    rec.writes[0].data,
    '# Netscape HTTP Cookie File\n#HttpOnly_www.example.com\tFALSE\t/\tTRUE\t0\tsid\tabc\n'
  )
})

test('N6 hosts 原样带上且为副本(调用方改自己那份不影响租约)', () => {
  const { deps } = fakeDeps()
  const mine = ['a.example.com']
  const lease = createCookieFileLease(deps, 'dir', mine, GROUPS)
  mine.push('b.example.com')

  assert.deepEqual(lease.hosts, ['a.example.com'])
})

test('N6 release 幂等:调三次只删一次', () => {
  const { deps, rec } = fakeDeps()
  const lease = createCookieFileLease(deps, 'dir', [], GROUPS)

  lease.release()
  lease.release()
  lease.release()

  assert.equal(rec.removes.length, 1)
  assert.deepEqual(rec.removes[0], { path: lease.path, options: { force: true } })
})

test('N6 删除失败只吞异常不抛(删不掉的临时文件不该让用户的下载失败)', () => {
  const { deps, rec } = fakeDeps('b'.repeat(32), () => {
    throw new Error('EBUSY: resource busy or locked')
  })
  const lease = createCookieFileLease(deps, 'dir', [], GROUPS)

  assert.doesNotThrow(() => lease.release())
  assert.equal(rec.removes.length, 1, '尝试过删除(不是压根没调)')
  // 幂等标志在抛异常时也已置位:不会因为失败就反复重试
  lease.release()
  assert.equal(rec.removes.length, 1)
})

test('N6 建租约时就写盘一次(不是懒到第一次读才写)', () => {
  const { deps, rec } = fakeDeps()
  assert.equal(rec.writes.length, 0)
  createCookieFileLease(deps, 'dir', [], GROUPS)
  assert.equal(rec.writes.length, 1)
})
