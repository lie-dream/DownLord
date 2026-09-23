/// <reference types="node" />

import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { DownLordApi, ProxyConfig, ProxyStatus } from '../../../shared/ipc'
import ProxySettings from './ProxySettings'

afterEach(cleanup)

// 最小 window.api 桩:仅实现 ProxySettings 用到的 getProxyConfig / setProxyConfig。
// setProxyConfig 模拟主进程校验语义(spec §2.4):manual 档地址须含协议 + host:port,否则 effectiveUrl=null。
function setupApi(over: Partial<DownLordApi> = {}): { calls: ProxyConfig[] } {
  const calls: ProxyConfig[] = []
  const api = {
    getProxyConfig: async (): Promise<ProxyConfig> => ({ mode: 'system', manualUrl: null }),
    setProxyConfig: async (config: ProxyConfig): Promise<ProxyStatus> => {
      calls.push(config)
      const valid =
        config.mode === 'manual' &&
        /^(https?|socks[45]?):\/\/[^\s/]+:\d+/.test(config.manualUrl ?? '')
      const effectiveUrl = config.mode === 'manual' ? (valid ? config.manualUrl : null) : null
      return { mode: config.mode, label: 'x', dot: valid ? 'ok' : 'off', effectiveUrl }
    },
    ...over
  } as unknown as DownLordApi
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  return { calls }
}

const rowOf = (title: string): Element | null => screen.getByText(title).closest('.radio-row')

test('挂载读 getProxyConfig:默认 system 档选中', async () => {
  setupApi()
  render(<ProxySettings />)
  await waitFor(() => assert.ok(rowOf('跟随系统代理')?.classList.contains('sel')))
  // 「推荐」标签在第一档
  assert.ok(screen.getByText('推荐'))
  // 未选中档无 sel
  assert.equal(rowOf('不使用代理(直连)')?.classList.contains('sel'), false)
})

test('挂载读到 manual 配置:回填地址并展开输入', async () => {
  setupApi({
    getProxyConfig: async () => ({ mode: 'manual', manualUrl: 'http://127.0.0.1:7890' })
  })
  render(<ProxySettings />)
  const input = (await screen.findByPlaceholderText(/127\.0\.0\.1/)) as HTMLInputElement
  assert.equal(input.value, 'http://127.0.0.1:7890')
})

test('选「不使用代理(直连)」→ setProxyConfig({direct,null}) 且该档选中', async () => {
  const { calls } = setupApi()
  render(<ProxySettings />)
  await waitFor(() => assert.ok(rowOf('跟随系统代理')?.classList.contains('sel')))

  fireEvent.click(screen.getByText('不使用代理(直连)'))
  await waitFor(() => assert.ok(rowOf('不使用代理(直连)')?.classList.contains('sel')))
  assert.deepEqual(calls.at(-1), { mode: 'direct', manualUrl: null })
})

test('选「手动指定代理」展开输入;填非法地址 blur → 无效态可见、不静默', async () => {
  const { calls } = setupApi()
  render(<ProxySettings />)
  await waitFor(() => assert.ok(rowOf('跟随系统代理')?.classList.contains('sel')))

  fireEvent.click(screen.getByText('手动指定代理'))
  const input = (await screen.findByPlaceholderText(/127\.0\.0\.1/)) as HTMLInputElement

  fireEvent.change(input, { target: { value: 'not-a-proxy' } })
  fireEvent.blur(input)

  await waitFor(() => assert.ok(input.classList.contains('invalid')))
  assert.ok(screen.getByText(/地址无效/))
  assert.deepEqual(calls.at(-1), { mode: 'manual', manualUrl: 'not-a-proxy' })
})

test('手动填合法 http 地址 blur → setProxyConfig 透传、无无效态', async () => {
  const { calls } = setupApi()
  render(<ProxySettings />)
  await waitFor(() => assert.ok(rowOf('跟随系统代理')?.classList.contains('sel')))

  fireEvent.click(screen.getByText('手动指定代理'))
  const input = (await screen.findByPlaceholderText(/127\.0\.0\.1/)) as HTMLInputElement

  fireEvent.change(input, { target: { value: 'http://127.0.0.1:7890' } })
  fireEvent.blur(input)

  await waitFor(() => assert.equal(calls.at(-1)?.manualUrl, 'http://127.0.0.1:7890'))
  assert.equal(input.classList.contains('invalid'), false)
  assert.equal(screen.queryByText(/地址无效/), null)
})
