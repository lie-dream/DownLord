import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findFreePort } from './port'

test('findFreePort asks the injected net module for an ephemeral port and closes the server', async () => {
  const calls: string[] = []
  const fakeServer = {
    listen(port: number, callback?: () => void) {
      calls.push(`listen:${port}`)
      callback?.()
      return fakeServer
    },
    address() {
      calls.push('address')
      return { address: '127.0.0.1', family: 'IPv4', port: 49152 }
    },
    close(callback?: (error?: Error) => void) {
      calls.push('close')
      callback?.()
      return fakeServer
    },
    once() {
      return fakeServer
    }
  }
  const fakeNet = {
    createServer() {
      calls.push('createServer')
      return fakeServer
    }
  } as unknown as typeof import('net')

  await assert.doesNotReject(async () => {
    const port = await findFreePort(fakeNet)
    assert.equal(port, 49152)
  })
  assert.deepEqual(calls, ['createServer', 'listen:0', 'address', 'close'])
})
