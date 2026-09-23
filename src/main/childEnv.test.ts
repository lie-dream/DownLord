import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripProxyEnv } from './childEnv'
import { ytdlpSpawnEnv } from './video/ytdlpEnv'

test('stripProxyEnv 剔除大小写各形代理变量,保留其余(2026-07-09 代理修复)', () => {
  const out = stripProxyEnv({
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://x:1',
    no_proxy: 'localhost',
    PATH: 'C:/bin',
    LANG: 'zh_CN'
  })
  assert.equal(out.HTTP_PROXY, undefined)
  assert.equal(out.https_proxy, undefined)
  assert.equal(out.ALL_PROXY, undefined)
  assert.equal(out.no_proxy, undefined)
  assert.equal(out.PATH, 'C:/bin')
  assert.equal(out.LANG, 'zh_CN')
})

test('stripProxyEnv 不改动传入对象(纯函数)', () => {
  const base = { HTTP_PROXY: 'http://x:1', KEEP: '1' }
  const out = stripProxyEnv(base)
  assert.equal(base.HTTP_PROXY, 'http://x:1')
  assert.equal(out.KEEP, '1')
})

test('ytdlpSpawnEnv = 代理净化 + Python stdio UTF-8', () => {
  const out = ytdlpSpawnEnv({ HTTP_PROXY: 'http://127.0.0.1:7890', PATH: 'C:/bin' })
  assert.equal(out.HTTP_PROXY, undefined)
  assert.equal(out.PATH, 'C:/bin')
  assert.equal(out.PYTHONIOENCODING, 'utf-8')
  assert.equal(out.PYTHONUTF8, '1')
})
