import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseResolveProxy } from './systemProxy'

// ==================== parseResolveProxy(session.resolveProxy 串 → 引擎地址,spec §3.2)====================

test('parseResolveProxy maps PROXY h:p → http:// (spec §3.2)', () => {
  assert.equal(parseResolveProxy('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890')
})

test('parseResolveProxy maps SOCKS5 / SOCKS h:p → socks5:// (spec §3.2)', () => {
  assert.equal(parseResolveProxy('SOCKS5 127.0.0.1:7891'), 'socks5://127.0.0.1:7891')
  assert.equal(parseResolveProxy('SOCKS 127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
})

test('parseResolveProxy maps SOCKS4 h:p → socks4:// (spec §3.2)', () => {
  assert.equal(parseResolveProxy('SOCKS4 1.2.3.4:1080'), 'socks4://1.2.3.4:1080')
})

test('parseResolveProxy maps DIRECT → null (spec §3.2)', () => {
  assert.equal(parseResolveProxy('DIRECT'), null)
})

test('parseResolveProxy takes first non-DIRECT node from multi-proxy list (spec §3.2)', () => {
  assert.equal(parseResolveProxy('PROXY a:1;PROXY b:2;DIRECT'), 'http://a:1')
  // 首个为 DIRECT 时跳过取下一个非 DIRECT 节点
  assert.equal(parseResolveProxy('DIRECT;SOCKS5 x:9'), 'socks5://x:9')
})

test('parseResolveProxy returns null for empty / blank string', () => {
  assert.equal(parseResolveProxy(''), null)
  assert.equal(parseResolveProxy('   '), null)
})

test('parseResolveProxy returns null for malformed / unknown-scheme strings', () => {
  assert.equal(parseResolveProxy('garbage'), null)
  assert.equal(parseResolveProxy('PROXY'), null) // 缺 host:port
  assert.equal(parseResolveProxy('PROXY nohostport'), null) // 无端口
  assert.equal(parseResolveProxy('WEIRD 1.2.3.4:8'), null) // 未知协议
})
