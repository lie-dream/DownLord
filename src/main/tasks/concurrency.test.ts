import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Task } from '../../shared/ipc'
import { dequeueNext } from './concurrency'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'http',
    source: 'https://example.test/file.bin',
    status: 'queued',
    filename: 'file.bin',
    savePath: 'D:\\Downloads\\file.bin',
    category: null,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1000,
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

test('dequeueNext starts the first three queued tasks by FIFO when maxConcurrent is 3', () => {
  const tasks = [5, 1, 3, 2, 4].map((createdAt) =>
    makeTask({ id: `queued-${createdAt}`, createdAt })
  )

  const result = dequeueNext(tasks, 3)

  assert.equal(result.activeCount, 0)
  assert.deepEqual(
    result.toStart.map((task) => task.id),
    ['queued-1', 'queued-2', 'queued-3']
  )
})

test('dequeueNext only fills free slots and returns no tasks when active count is at the limit', () => {
  const tasks = [
    makeTask({ id: 'active-1', status: 'downloading', createdAt: 1 }),
    makeTask({ id: 'active-2', status: 'downloading', createdAt: 2 }),
    makeTask({ id: 'queued-3', createdAt: 3 }),
    makeTask({ id: 'queued-4', createdAt: 4 })
  ]

  assert.deepEqual(
    dequeueNext(tasks, 3).toStart.map((task) => task.id),
    ['queued-3']
  )

  assert.deepEqual(dequeueNext(tasks, 2), {
    toStart: [],
    activeCount: 2
  })
})
