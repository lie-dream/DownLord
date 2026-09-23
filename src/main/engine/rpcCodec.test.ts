import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRpcRequest, parseProgress, parseRpcResponse, RpcError } from './rpcCodec'

test('buildRpcRequest injects the aria2 token as the first param', () => {
  const request = buildRpcRequest('aria2.addUri', [['https://example.test/file.zip']], {
    secret: 'rpc-secret',
    id: '7'
  })

  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: '7',
    method: 'aria2.addUri',
    params: ['token:rpc-secret', ['https://example.test/file.zip']]
  })
})

test('parseRpcResponse returns result responses', () => {
  const result = parseRpcResponse({
    jsonrpc: '2.0',
    id: '7',
    result: 'gid-123'
  })

  assert.equal(result, 'gid-123')
})

test('parseRpcResponse throws structured RPC errors', () => {
  assert.throws(
    () =>
      parseRpcResponse({
        jsonrpc: '2.0',
        id: '7',
        error: {
          code: 1,
          message: 'Unauthorized',
          data: { method: 'aria2.addUri' }
        }
      }),
    (error) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.name, 'RpcError')
      assert.equal(error.code, 1)
      assert.equal(error.message, 'Unauthorized')
      assert.deepEqual(error.data, { method: 'aria2.addUri' })
      return true
    }
  )
})

test('parseProgress parses aria2 string fields and normalizes active status', () => {
  const progress = parseProgress(
    {
      gid: '1234567890abcdef',
      status: 'active',
      totalLength: '1048576',
      completedLength: '262144',
      downloadSpeed: '65536',
      connections: '8'
    },
    'task-1'
  )

  assert.deepEqual(progress, {
    id: 'task-1',
    status: 'downloading',
    totalBytes: 1048576,
    downloadedBytes: 262144,
    speed: 65536,
    connections: 8
  })
})

test('parseProgress preserves unknown total size and aria2 error code', () => {
  const progress = parseProgress(
    {
      gid: 'abcdef1234567890',
      status: 'error',
      totalLength: '0',
      completedLength: '4096',
      downloadSpeed: '0',
      connections: '0',
      errorCode: '3'
    },
    'task-error'
  )

  assert.deepEqual(progress, {
    id: 'task-error',
    status: 'error',
    totalBytes: 0,
    downloadedBytes: 4096,
    speed: 0,
    connections: 0,
    errorCode: '3'
  })
})

test('parseProgress: errorMessage 存在 → 透传;缺失 / 空串 → 不设(真机修订 2026-07-27 · Task 4 §13)', () => {
  const withMsg = parseProgress(
    {
      gid: 'g1',
      status: 'error',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '0',
      errorCode: '1',
      errorMessage: 'SSL/TLS handshake failure: Error: 目标主要名称不正确。\r\n(80090322)'
    },
    'task-tls'
  )
  assert.equal(withMsg.errorCode, '1')
  assert.match(withMsg.errorMessage ?? '', /SSL\/TLS handshake failure/)

  // 缺失(旧 aria2 / 正常帧)与空串均不设 → 映射侧回落原文案,逐字节零回归
  const noMsg = parseProgress(
    {
      gid: 'g2',
      status: 'error',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '0',
      errorCode: '1'
    },
    'task-nomsg'
  )
  assert.ok(!('errorMessage' in noMsg), '缺失 → 键不存在')
  const emptyMsg = parseProgress(
    {
      gid: 'g3',
      status: 'error',
      totalLength: '0',
      completedLength: '0',
      downloadSpeed: '0',
      connections: '0',
      errorCode: '1',
      errorMessage: ''
    },
    'task-empty'
  )
  assert.ok(!('errorMessage' in emptyMsg), '空串 → 键不存在')
})

test('parseProgress: BT 富进度键存在 → numSeeders/uploadSpeed/uploadLength 进可选字段(v0.3 Task 3)', () => {
  const progress = parseProgress(
    {
      gid: 'bt01',
      status: 'active',
      totalLength: '1000',
      completedLength: '1000',
      downloadSpeed: '0',
      connections: '12',
      numSeeders: '5',
      uploadSpeed: '2048',
      uploadLength: '500000'
    },
    'task-bt'
  )

  assert.deepEqual(progress, {
    id: 'task-bt',
    status: 'downloading', // active → downloading
    totalBytes: 1000,
    downloadedBytes: 1000,
    speed: 0,
    connections: 12,
    numSeeders: 5,
    uploadSpeed: 2048,
    uploadLength: 500000
  })
})

test('parseProgress: http 帧无 BT 键 → 不含 numSeeders/uploadSpeed/uploadLength(保持干净,零回归)', () => {
  const progress = parseProgress(
    {
      gid: 'http01',
      status: 'active',
      totalLength: '1000',
      completedLength: '500',
      downloadSpeed: '100',
      connections: '4'
    },
    'task-http'
  )

  assert.equal('numSeeders' in progress, false)
  assert.equal('uploadSpeed' in progress, false)
  assert.equal('uploadLength' in progress, false)
})
