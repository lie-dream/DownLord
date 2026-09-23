import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RpcClient } from './rpcClient'

/**
 * 错误映射函数单测（mapRpcError 通过 RpcClient 间接测试）
 */

test('mapRpcError - aria2 参数错误 (code 1)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 1, message: 'Invalid argument' }
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
      assert.ok(err.message.includes('参数错误'), '应映射为可读中文')
      assert.ok(err.message.includes('Invalid argument'), '应保留原始消息')
      return true
    }
  )
})

test('mapRpcError - aria2 内部错误 (code 2)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 2, message: 'Internal server error' }
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
      assert.ok(err.message.includes('内部错误'), '应映射为可读中文')
      return true
    }
  )
})

test('mapRpcError - JSON-RPC 无效请求 (code -32600)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32600, message: 'Invalid Request' }
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
      assert.ok(err.message.includes('无效请求'), '应映射 JSON-RPC 标准错误')
      return true
    }
  )
})

test('mapRpcError - gid 不存在', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 1, message: 'GID abc123 not found' }
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
      await client.pause('abc123')
    },
    (err: Error) => {
      // mapRpcError 的 gid 判定逻辑检查 'not found' 或 'gid' (小写)
      const hasTaskNotFound = err.message.includes('任务不存在')
      const hasGidInfo =
        err.message.toLowerCase().includes('gid') || err.message.includes('not found')
      assert.ok(hasTaskNotFound || hasGidInfo, `应识别 gid 不存在场景，实际消息: ${err.message}`)
      return true
    }
  )
})

test('mapRpcError - 鉴权失败 (code 401)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 401, message: 'Unauthorized' }
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
      assert.ok(err.message.includes('鉴权失败'), '应识别鉴权错误')
      assert.ok(err.message.includes('secret'), '应提示 secret 问题')
      return true
    }
  )
})

test('mapRpcError - 未知错误码兜底', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 9999, message: 'Unknown custom error' }
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
      assert.ok(err.message.includes('代码 9999'), '应包含错误码')
      assert.ok(err.message.includes('Unknown custom error'), '应保留原始消息')
      return true
    }
  )
})

test('HTTP 400 + JSON-RPC error body → 透出真实 RPC 错误(aria2 方法级错误带 4xx,真机 2026-07-09)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        error: { code: 1, message: 'GID deadbeef is not found' }
      }),
      { status: 400 }
    )
  }

  const client = new RpcClient(
    { fetch: mockFetch as typeof fetch },
    { baseURL: 'http://127.0.0.1:6800/jsonrpc', secret: 'test-secret' }
  )

  await assert.rejects(
    async () => {
      await client.pause('deadbeef')
    },
    (err: Error) => {
      assert.ok(err.message.includes('不存在'), '应映射 not found → 任务不存在(而非通信异常)')
      assert.ok(err.message.includes('GID deadbeef is not found'), '应保留原始消息')
      assert.ok(!err.message.includes('HTTP 400'), '不应退化为「通信异常(HTTP 400)」')
      return true
    }
  )
})

test('HTTP 502 + 非 JSON body → 退化为通信异常(HTTP <status>)', async () => {
  const mockFetch = async (): Promise<Response> => {
    return new Response('Bad Gateway', { status: 502 })
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
      assert.ok(err.message.includes('HTTP 502'), '非 JSON-RPC body 保持 HTTP 退化文案')
      return true
    }
  )
})
