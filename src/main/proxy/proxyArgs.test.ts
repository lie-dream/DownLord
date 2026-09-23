import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  validateManualUrl,
  resolveEffectiveProxy,
  toAria2ProxyOption,
  toYtdlpProxyArgs
} from './proxyArgs'
import type { ProxyConfig } from '../../shared/ipc'

// ==================== validateManualUrl(合法 / 非法判定,spec §3.4 / §8.1)====================

test('validateManualUrl accepts http / https / socks5 / socks4', () => {
  assert.equal(validateManualUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(
    validateManualUrl('https://proxy.example.com:8080'),
    'https://proxy.example.com:8080'
  )
  assert.equal(validateManualUrl('socks5://127.0.0.1:7891'), 'socks5://127.0.0.1:7891')
  assert.equal(validateManualUrl('socks4://1.2.3.4:1080'), 'socks4://1.2.3.4:1080')
})

test('validateManualUrl accepts credentials (user:pass@host:port,原样透传)', () => {
  assert.equal(
    validateManualUrl('http://user:pass@127.0.0.1:7890'),
    'http://user:pass@127.0.0.1:7890'
  )
})

test('validateManualUrl trims surrounding whitespace', () => {
  assert.equal(validateManualUrl('  http://127.0.0.1:7890  '), 'http://127.0.0.1:7890')
})

test('validateManualUrl normalizes bare host:port to http://(Clash 惯用写法,真机 2026-07-08)', () => {
  assert.equal(validateManualUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(validateManualUrl('  proxy.lan:8080 '), 'http://proxy.lan:8080')
  assert.equal(validateManualUrl('user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890')
})

test('validateManualUrl rejects unsupported scheme / bare host without port', () => {
  assert.equal(validateManualUrl('ftp://127.0.0.1:7890'), null)
  assert.equal(validateManualUrl('127.0.0.1'), null)
})

test('validateManualUrl rejects missing port', () => {
  assert.equal(validateManualUrl('http://127.0.0.1'), null)
})

test('validateManualUrl rejects empty / blank', () => {
  assert.equal(validateManualUrl(''), null)
  assert.equal(validateManualUrl('   '), null)
})

test('validateManualUrl rejects injection / control chars and embedded whitespace', () => {
  assert.equal(validateManualUrl('http://127.0.0.1:7890 rm -rf'), null)
  // 嵌入式控制字符(中间换行 / 制表)不被 trim 规整掉 → 拒绝
  assert.equal(validateManualUrl(`http://127.0.0.1${String.fromCharCode(10)}:7890`), null)
  assert.equal(validateManualUrl(`http://127.0.0.1:${String.fromCharCode(0)}7890`), null)
})

test('validateManualUrl rejects out-of-range port', () => {
  assert.equal(validateManualUrl('http://127.0.0.1:99999'), null)
  assert.equal(validateManualUrl('http://127.0.0.1:0'), null)
})

// ==================== resolveEffectiveProxy(三档矩阵,spec §2.4)====================

const cfg = (mode: ProxyConfig['mode'], manualUrl: string | null = null): ProxyConfig => ({
  mode,
  manualUrl
})

test('resolveEffectiveProxy: direct → null regardless of systemDetected', () => {
  assert.equal(resolveEffectiveProxy(cfg('direct'), 'http://1.2.3.4:8'), null)
  assert.equal(resolveEffectiveProxy(cfg('direct'), null), null)
})

test('resolveEffectiveProxy: system + 读到代理 → 该地址', () => {
  assert.equal(
    resolveEffectiveProxy(cfg('system'), 'http://127.0.0.1:7890'),
    'http://127.0.0.1:7890'
  )
})

test('resolveEffectiveProxy: system + 未读到(DIRECT / 未设)→ null', () => {
  assert.equal(resolveEffectiveProxy(cfg('system'), null), null)
})

test('resolveEffectiveProxy: manual + 合法 → 规整后地址', () => {
  assert.equal(
    resolveEffectiveProxy(cfg('manual', '  socks5://127.0.0.1:7891 '), null),
    'socks5://127.0.0.1:7891'
  )
})

test('resolveEffectiveProxy: manual + 非法 / 空 → null(不进 effectiveUrl)', () => {
  assert.equal(resolveEffectiveProxy(cfg('manual', 'not-a-proxy'), null), null)
  assert.equal(resolveEffectiveProxy(cfg('manual', null), null), null)
})

// ==================== toAria2ProxyOption / toYtdlpProxyArgs(含 null→显式空串,spec §4.1 / §4.2)====================

test('toAria2ProxyOption: 有值 → 透传 all-proxy', () => {
  assert.deepEqual(toAria2ProxyOption('http://127.0.0.1:7890'), {
    'all-proxy': 'http://127.0.0.1:7890'
  })
})

test('toAria2ProxyOption: null → 显式空串关闭(不省略字段)', () => {
  assert.deepEqual(toAria2ProxyOption(null), { 'all-proxy': '' })
})

test('toYtdlpProxyArgs: 有值 → [--proxy, url]', () => {
  assert.deepEqual(toYtdlpProxyArgs('socks5://127.0.0.1:7891'), [
    '--proxy',
    'socks5://127.0.0.1:7891'
  ])
})

test('toYtdlpProxyArgs: null → [--proxy, ""] 显式空串(屏蔽环境代理,不空数组)', () => {
  assert.deepEqual(toYtdlpProxyArgs(null), ['--proxy', ''])
})
