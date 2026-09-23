import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mapAria2Status, type DownloadStatus } from './taskModel'

test('mapAria2Status maps aria2 statuses to the DownLord five-state subset', () => {
  const cases: Array<[string, DownloadStatus]> = [
    ['active', 'downloading'],
    ['paused', 'paused'],
    ['waiting', 'queued'],
    ['complete', 'completed'],
    ['error', 'error'],
    ['removed', 'error']
  ]

  for (const [rawStatus, expected] of cases) {
    assert.equal(mapAria2Status(rawStatus), expected)
  }
})
