import { test } from 'node:test'
import assert from 'node:assert'
import { RpcClient } from './rpcClient'

/**
 * rpcClient 单元测试（mock fetch，不碰真实网络）
 */

test('RpcClient - 成功响应', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: { version: '1.36.0' }
      }),
      { status: 200 }
    )
  }

  const client = new RpcClient(
    { fetch: mockFetch as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  const result = await client.getVersion()
  assert.ok(result, '应该返回结果')
})

test('RpcClient - RPC 错误响应', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 1, message: 'GID not found' }
      }),
      { status: 200 }
    )
  }

  const client = new RpcClient(
    { fetch: mockFetch as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await assert.rejects(
    async () => {
      await client.getVersion()
    },
    (err: Error) => {
      // code 1 + not found → 「下载任务不存在:<原始消息>」(2026-07-09 细分,不再笼统「参数错误」)
      assert.ok(err.message.includes('任务不存在'), '应该映射为可读中文')
      return true
    }
  )
})

test('RpcClient - HTTP 非 2xx', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response('Not Found', { status: 404 })
  }

  const client = new RpcClient(
    { fetch: mockFetch as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await assert.rejects(
    async () => {
      await client.getVersion()
    },
    (err: Error) => {
      assert.ok(err.message.includes('HTTP 404'), '应该包含 HTTP 状态码')
      return true
    }
  )
})

test('RpcClient - addUri 方法', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: '2089b05ecca3d829'
      }),
      { status: 200 }
    )
  }

  const client = new RpcClient(
    { fetch: mockFetch as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  const gid = await client.addUri(['http://example.com/file.zip'], { dir: '/tmp' })
  assert.strictEqual(gid, '2089b05ecca3d829', '应该返回 gid')
})

test('RpcClient - 方法封装覆盖', async () => {
  let lastMethod = ''

  const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string)
    lastMethod = body.method
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: 'ok'
      }),
      { status: 200 }
    )
  }

  const client = new RpcClient(
    { fetch: mockFetch as unknown as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await client.pause('gid123')
  assert.strictEqual(lastMethod, 'aria2.pause')

  await client.forcePause('gid123')
  assert.strictEqual(lastMethod, 'aria2.forcePause')

  await client.unpause('gid123')
  assert.strictEqual(lastMethod, 'aria2.unpause')

  await client.remove('gid123')
  assert.strictEqual(lastMethod, 'aria2.remove')

  await client.tellStatus('gid123')
  assert.strictEqual(lastMethod, 'aria2.tellStatus')

  await client.tellActive()
  assert.strictEqual(lastMethod, 'aria2.tellActive')

  await client.tellWaiting(0, 10)
  assert.strictEqual(lastMethod, 'aria2.tellWaiting')

  await client.tellStopped(0, 10)
  assert.strictEqual(lastMethod, 'aria2.tellStopped')

  await client.shutdown()
  assert.strictEqual(lastMethod, 'aria2.shutdown')

  await client.forceShutdown()
  assert.strictEqual(lastMethod, 'aria2.forceShutdown')
})

test('RpcClient - changeGlobalOption 断言 method / params(v0.2 Task 2 全局限速)', async () => {
  let lastMethod = ''
  let lastParams: unknown[] = []

  const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string)
    lastMethod = body.method
    lastParams = body.params
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'OK' }), {
      status: 200
    })
  }

  const client = new RpcClient(
    { fetch: mockFetch as unknown as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await client.changeGlobalOption({ 'max-overall-download-limit': '500K' })
  assert.strictEqual(lastMethod, 'aria2.changeGlobalOption')
  // params = [token, options];token 首位(secret),options 为末位对象
  assert.deepEqual(lastParams.at(-1), { 'max-overall-download-limit': '500K' })
})

test('RpcClient - changeOption 断言 method / params(gid + options)(v0.2 Task 2 单任务限速)', async () => {
  let lastMethod = ''
  let lastParams: unknown[] = []

  const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string)
    lastMethod = body.method
    lastParams = body.params
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'OK' }), {
      status: 200
    })
  }

  const client = new RpcClient(
    { fetch: mockFetch as unknown as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await client.changeOption('gid123', { 'max-download-limit': '256K' })
  assert.strictEqual(lastMethod, 'aria2.changeOption')
  // params = [token, gid, options];gid 与 options 为尾部两项
  assert.deepEqual(lastParams.slice(-2), ['gid123', { 'max-download-limit': '256K' }])
})

test('RpcClient - addTorrent 断言 method / params([base64, uris, options])(v0.3 Task 1 · spec §4.1)', async () => {
  let lastMethod = ''
  let lastParams: unknown[] = []

  const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string)
    lastMethod = body.method
    lastParams = body.params
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'btgid001' }), {
      status: 200
    })
  }

  const client = new RpcClient(
    { fetch: mockFetch as unknown as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  const gid = await client.addTorrent('dG9ycmVudA==', [], { dir: '/tmp', 'seed-time': '0' })
  assert.strictEqual(gid, 'btgid001', '应该返回 gid')
  assert.strictEqual(lastMethod, 'aria2.addTorrent')
  // params = [token, base64, uris, options];token 首位(secret 注入),尾部三项为 addTorrent 实参
  assert.deepEqual(lastParams.slice(-3), ['dG9ycmVudA==', [], { dir: '/tmp', 'seed-time': '0' }])
})

test('RpcClient - addTorrent 缺省 uris / options → [[], {}](v0.3 Task 1)', async () => {
  let lastParams: unknown[] = []

  const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string)
    lastParams = body.params
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'g' }), {
      status: 200
    })
  }

  const client = new RpcClient(
    { fetch: mockFetch as unknown as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await client.addTorrent('QQ==')
  assert.deepEqual(lastParams.slice(-3), ['QQ==', [], {}])
})
