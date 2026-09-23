/**
 * proxyProbe 单测(Task 7 · spec §5.2)。
 *
 * 注入 fake `ConnectFn` 模拟 connect / timeout / error,不碰真实网络;验证:
 * - 探测结果映射(connect→true / timeout→false / error→false)+ 无论结果都 destroy 释放;
 * - 首个事件即定胜负(后续事件不二次 resolve);
 * - 探测目标 host:port 正确传给连接器(只连该端口);
 * - parseHostPort 从规整地址拆 host:port,忽略认证段,非法 → null。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probe, parseHostPort, type ConnectFn, type ProbeSocket } from './proxyProbe'

/** fake socket:记录事件监听器 + destroy 标记,供测试手动 emit 触发 */
function fakeSocket(): {
  sock: ProbeSocket
  emit(event: 'connect' | 'timeout' | 'error'): void
  destroyed(): boolean
} {
  const listeners: Partial<Record<string, () => void>> = {}
  let destroyed = false
  return {
    sock: {
      setTimeout() {
        /* fake socket:超时由用例手动触发 listeners.timeout,无需真实计时 */
      },
      once(event, listener) {
        listeners[event] = listener
      },
      destroy() {
        destroyed = true
      }
    },
    emit(event) {
      listeners[event]?.()
    },
    destroyed: () => destroyed
  }
}

test('probe: connect 事件 → true,目标 host:port 正确,destroy 释放', async () => {
  const f = fakeSocket()
  let gotPort = -1
  let gotHost = ''
  const connect: ConnectFn = (port, host) => {
    gotPort = port
    gotHost = host
    return f.sock
  }
  const p = probe('127.0.0.1', 7890, connect)
  f.emit('connect')
  assert.equal(await p, true)
  assert.equal(gotPort, 7890, '只连 effectiveUrl 的端口')
  assert.equal(gotHost, '127.0.0.1', '只连 effectiveUrl 的 host')
  assert.ok(f.destroyed(), '探测后 destroy 释放')
})

test('probe: timeout → false 且 destroy', async () => {
  const f = fakeSocket()
  const connect: ConnectFn = () => f.sock
  const p = probe('127.0.0.1', 7890, connect)
  f.emit('timeout')
  assert.equal(await p, false)
  assert.ok(f.destroyed())
})

test('probe: error(拒绝 / 不可达)→ false 且 destroy', async () => {
  const f = fakeSocket()
  const connect: ConnectFn = () => f.sock
  const p = probe('127.0.0.1', 7890, connect)
  f.emit('error')
  assert.equal(await p, false)
  assert.ok(f.destroyed())
})

test('probe: 首个事件定胜负,后续事件不二次 resolve', async () => {
  const f = fakeSocket()
  const connect: ConnectFn = () => f.sock
  const p = probe('127.0.0.1', 7890, connect)
  f.emit('connect')
  f.emit('error') // 已 settled,忽略
  f.emit('timeout')
  assert.equal(await p, true, '已连通则保持 true')
})

test('parseHostPort: http 代理 → host:port', () => {
  assert.deepEqual(parseHostPort('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 })
})

test('parseHostPort: socks5 含认证 → 忽略账号密码,只取 host:port', () => {
  assert.deepEqual(parseHostPort('socks5://user:pass@10.0.0.1:1080'), {
    host: '10.0.0.1',
    port: 1080
  })
})

test('parseHostPort: 标准端口(:80/:443)被 WHATWG URL 规范化为空 → 按协议补回,不再误判非法', () => {
  // 修复前 `http://…:80` 的 u.port==='' → Number('')=0 → null,标准端口代理恒「未响应」误报
  assert.deepEqual(parseHostPort('http://proxy.local:80'), { host: 'proxy.local', port: 80 })
  assert.deepEqual(parseHostPort('https://proxy.local:443'), { host: 'proxy.local', port: 443 })
  // http 缺端口经同一默认表补 80(上游 validateManualUrl 已强制端口,此分支实际不可达,语义自洽即可)
  assert.deepEqual(parseHostPort('http://127.0.0.1'), { host: '127.0.0.1', port: 80 })
})

test('parseHostPort: 缺端口(无协议默认)/ 非法串 → null', () => {
  assert.equal(parseHostPort('socks5://127.0.0.1'), null, 'socks 无默认端口,缺端口 → null')
  assert.equal(parseHostPort('not-a-url'), null, '非法串 → null')
  assert.equal(parseHostPort(''), null, '空串 → null')
})
