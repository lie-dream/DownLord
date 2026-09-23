import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildProxyStatus } from './proxyStatus'
import type { ProxyConfig, ProxyResolved } from '../../shared/ipc'

const config = (mode: ProxyConfig['mode'], manualUrl: string | null = null): ProxyConfig => ({
  mode,
  manualUrl
})
const resolved = (
  mode: ProxyConfig['mode'],
  effectiveUrl: string | null,
  systemDetected: string | null = null
): ProxyResolved => ({
  mode,
  effectiveUrl,
  systemDetected
})

// ==================== buildProxyStatus(spec §5.1 七情形表)====================

test('1. direct → 直连 / off', () => {
  const s = buildProxyStatus(config('direct'), resolved('direct', null), null)
  assert.equal(s.label, '直连')
  assert.equal(s.dot, 'off')
  assert.equal(s.effectiveUrl, null)
})

test('2. system + 读到代理 + 探测通 → 跟随系统(已连接) / ok', () => {
  const s = buildProxyStatus(
    config('system'),
    resolved('system', 'http://127.0.0.1:7890', 'http://127.0.0.1:7890'),
    'ok'
  )
  assert.equal(s.label, '跟随系统(已连接)')
  assert.equal(s.dot, 'ok')
  assert.equal(s.effectiveUrl, 'http://127.0.0.1:7890')
})

test('3. system + 读到代理 + 探测不通 → 跟随系统(代理未响应) / warn', () => {
  const s = buildProxyStatus(
    config('system'),
    resolved('system', 'http://127.0.0.1:7890', 'http://127.0.0.1:7890'),
    'fail'
  )
  assert.equal(s.label, '跟随系统(代理未响应)')
  assert.equal(s.dot, 'warn')
})

test('4. system + 系统未设代理 → 跟随系统(系统未设代理 · 直连) / off', () => {
  const s = buildProxyStatus(config('system'), resolved('system', null, null), null)
  assert.equal(s.label, '跟随系统(系统未设代理 · 直连)')
  assert.equal(s.dot, 'off')
  assert.equal(s.effectiveUrl, null)
})

test('5. manual + 校验通过 + 探测通 → 手动代理(已连接) / ok', () => {
  const s = buildProxyStatus(
    config('manual', 'http://127.0.0.1:7890'),
    resolved('manual', 'http://127.0.0.1:7890'),
    'ok'
  )
  assert.equal(s.label, '手动代理(已连接)')
  assert.equal(s.dot, 'ok')
})

test('6. manual + 校验通过 + 探测不通 → 手动代理(未响应) / warn', () => {
  const s = buildProxyStatus(
    config('manual', 'http://127.0.0.1:7890'),
    resolved('manual', 'http://127.0.0.1:7890'),
    'fail'
  )
  assert.equal(s.label, '手动代理(未响应)')
  assert.equal(s.dot, 'warn')
})

test('7. manual + 校验失败(effectiveUrl null)→ 手动代理(地址无效) / warn', () => {
  const s = buildProxyStatus(config('manual', 'not-a-proxy'), resolved('manual', null), null)
  assert.equal(s.label, '手动代理(地址无效)')
  assert.equal(s.dot, 'warn')
  assert.equal(s.effectiveUrl, null)
})

test('文案不含规避封锁措辞(诚实,PRD §4.4)', () => {
  const labels = [
    buildProxyStatus(config('direct'), resolved('direct', null), null).label,
    buildProxyStatus(config('system'), resolved('system', 'http://x:1', 'http://x:1'), 'ok').label,
    buildProxyStatus(config('manual', 'http://x:1'), resolved('manual', 'http://x:1'), 'ok').label
  ]
  for (const label of labels) {
    assert.doesNotMatch(label, /翻墙|突破封锁|加速墙外|保证可用/)
  }
})
