/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import type { ProxyStatus } from '../../../shared/ipc'
import StatusBar from './StatusBar'

afterEach(cleanup)

test('展示全局速度 + 活动 / 排队数 + 代理占位', () => {
  render(
    <StatusBar stats={{ totalSpeed: 1048576, activeCount: 2, queuedCount: 1, totalUpload: 0 }} />
  )
  assert.ok(screen.getByText(/1\.0 MB\/s/))
  assert.ok(screen.getByText(/2 个下载中/))
  assert.ok(screen.getByText(/1 排队/))
  assert.ok(screen.getByText(/代理/))
})

test('零速度显示 0 B/s', () => {
  render(<StatusBar stats={{ totalSpeed: 0, activeCount: 0, queuedCount: 0, totalUpload: 0 }} />)
  assert.ok(screen.getByText(/0 B\/s/))
})

// v0.3 Task 3 — 聚合上行:仅 totalUpload>0 时显示 ↑ 上行项(克制)
test('totalUpload=0:不显示上行项(状态栏保持简洁)', () => {
  const { container } = render(
    <StatusBar stats={{ totalSpeed: 1024, activeCount: 1, queuedCount: 0, totalUpload: 0 }} />
  )
  // 仅一个速度项(下行);无第二个上行 s-item(下行 + 活动/排队 + 代理 = 3 个 s-item)
  assert.equal(container.querySelectorAll('.s-item').length, 3)
})

test('totalUpload>0:显示 ↑ 聚合上行项', () => {
  const { container } = render(
    <StatusBar stats={{ totalSpeed: 1024, activeCount: 0, queuedCount: 0, totalUpload: 524288 }} />
  )
  // 多一个上行 s-item(下行 + 上行 + 活动/排队 + 代理 = 4 个)
  assert.equal(container.querySelectorAll('.s-item').length, 4)
  assert.ok(screen.getByText(/512\.0 KB\/s/))
})

test('未传 proxyStatus:中性占位(代理:… + off 圆点)', () => {
  const { container } = render(
    <StatusBar stats={{ totalSpeed: 0, activeCount: 0, queuedCount: 0, totalUpload: 0 }} />
  )
  assert.ok(screen.getByText(/代理:…/))
  assert.ok(container.querySelector('.proxy-dot.off'))
})

test('proxyStatus 驱动状态栏文本与圆点类名(ok / warn / off)', () => {
  const stats = { totalSpeed: 0, activeCount: 0, queuedCount: 0, totalUpload: 0 }
  const mk = (over: Partial<ProxyStatus>): ProxyStatus => ({
    mode: 'system',
    label: '直连',
    dot: 'off',
    effectiveUrl: null,
    ...over
  })

  // ok:已连接 → success 圆点
  const ok = render(
    <StatusBar stats={stats} proxyStatus={mk({ label: '跟随系统(已连接)', dot: 'ok' })} />
  )
  assert.ok(screen.getByText(/已连接/))
  assert.ok(ok.container.querySelector('.proxy-dot.ok'))
  cleanup()

  // warn:地址无效 → warning 圆点
  const warn = render(
    <StatusBar
      stats={stats}
      proxyStatus={mk({ mode: 'manual', label: '手动代理(地址无效)', dot: 'warn' })}
    />
  )
  assert.ok(screen.getByText(/地址无效/))
  assert.ok(warn.container.querySelector('.proxy-dot.warn'))
  cleanup()

  // off:直连 → 中性圆点
  const off = render(
    <StatusBar stats={stats} proxyStatus={mk({ mode: 'direct', label: '直连', dot: 'off' })} />
  )
  assert.ok(screen.getByText(/直连/))
  assert.ok(off.container.querySelector('.proxy-dot.off'))
})
