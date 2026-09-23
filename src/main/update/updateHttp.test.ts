import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from 'electron'

import { ElectronUpdateHttpClient, UPDATE_USER_AGENT, type UpdateNetLike } from './updateHttp'

/** fake session:记录 setProxy 调用参数(仅测 configureProxy 纯映射,不碰真实 Electron) */
function createFakeSession(): { setProxyCalls: Array<{ proxyRules: string }> } & {
  setProxy(config: { proxyRules: string }): Promise<void>
} {
  return {
    setProxyCalls: [],
    async setProxy(config: { proxyRules: string }): Promise<void> {
      this.setProxyCalls.push(config)
    }
  }
}

/** net 桩(configureProxy 不触发请求,给个占位满足类型) */
const fakeNet: UpdateNetLike = {
  request() {
    throw new Error('net.request 不应被 configureProxy 调用')
  }
}

function makeClient(session: ReturnType<typeof createFakeSession>): ElectronUpdateHttpClient {
  return new ElectronUpdateHttpClient({
    session: session as unknown as Session,
    net: fakeNet
  })
}

test('configureProxy(effectiveUrl 非空)→ setProxy({proxyRules: 该地址})(spec §3.3)', async () => {
  const session = createFakeSession()
  const client = makeClient(session)
  await client.configureProxy('http://127.0.0.1:7890')
  assert.deepEqual(session.setProxyCalls, [{ proxyRules: 'http://127.0.0.1:7890' }])
})

test('configureProxy(null)→ setProxy({proxyRules: "direct://"})(显式直连)', async () => {
  const session = createFakeSession()
  const client = makeClient(session)
  await client.configureProxy(null)
  assert.deepEqual(session.setProxyCalls, [{ proxyRules: 'direct://' }])
})

test('默认 User-Agent 常量(GitHub 强制要求)', () => {
  assert.equal(UPDATE_USER_AGENT, 'DownLord-Updater')
})
