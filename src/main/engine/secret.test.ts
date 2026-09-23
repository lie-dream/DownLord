import { test } from 'node:test'
import assert from 'node:assert/strict'

import { generateSecret } from './secret'

test('generateSecret uses the injected crypto module for a 32 byte hex token', () => {
  const calls: string[] = []
  const fakeCrypto = {
    randomBytes(size: number) {
      calls.push(`randomBytes:${size}`)
      return {
        toString(encoding: BufferEncoding) {
          calls.push(`toString:${encoding}`)
          return 'a'.repeat(64)
        }
      }
    }
  } as unknown as typeof import('crypto')

  assert.equal(generateSecret(fakeCrypto), 'a'.repeat(64))
  assert.deepEqual(calls, ['randomBytes:32', 'toString:hex'])
})
