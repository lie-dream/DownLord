import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { Task, TaskStatus } from '../../shared/ipc'
import {
  batchUpdateStatus,
  deleteTask,
  findBySource,
  getTask,
  insertTask,
  listTasks,
  updateTask,
  type TaskDaoDatabase
} from './taskDao'

interface TestStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

type TaskRow = {
  id: string
  kind: Task['kind']
  source: string
  status: TaskStatus
  filename: string
  savePath: string
  category: string | null
  totalBytes: number
  downloadedBytes: number
  videoMeta: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  torrentMeta: string | null
}

const TASK_COLUMNS: Array<keyof TaskRow> = [
  'id',
  'kind',
  'source',
  'status',
  'filename',
  'savePath',
  'category',
  'totalBytes',
  'downloadedBytes',
  'videoMeta',
  'error',
  'createdAt',
  'startedAt',
  'completedAt',
  'torrentMeta'
]

class MockStatement implements TestStatement {
  constructor(
    private readonly handlers: {
      get?: (...params: unknown[]) => unknown
      run?: (...params: unknown[]) => unknown
      all?: (...params: unknown[]) => unknown[]
    }
  ) {}

  get(...params: unknown[]): unknown {
    return this.handlers.get?.(...params)
  }

  run(...params: unknown[]): unknown {
    return this.handlers.run?.(...params)
  }

  all(...params: unknown[]): unknown[] {
    return this.handlers.all?.(...params) ?? []
  }
}

class MockTaskDb implements TaskDaoDatabase {
  private rows: TaskRow[] = []
  failOnUpdate?: (id: string, updates: Partial<TaskRow>) => Error | null

  prepare(sql: string): TestStatement {
    if (sql.startsWith('INSERT INTO tasks')) {
      return new MockStatement({
        run: (...params) => {
          const row = Object.fromEntries(
            TASK_COLUMNS.map((column, index) => [column, params[index]])
          ) as TaskRow
          this.rows.push(row)
        }
      })
    }

    if (sql === 'SELECT * FROM tasks WHERE id = ?') {
      return new MockStatement({
        get: (id) => this.rows.find((row) => row.id === id)
      })
    }

    if (sql.startsWith('UPDATE tasks SET ')) {
      return new MockStatement({
        run: (...params) => this.updateFromSql(sql, params)
      })
    }

    if (sql === 'DELETE FROM tasks WHERE id = ?') {
      return new MockStatement({
        run: (id) => {
          this.rows = this.rows.filter((row) => row.id !== id)
        }
      })
    }

    // #29(v0.3 Task 4):findBySource 精确等值查(真实库走 idx_tasks_source);mock 按 source 精确过滤
    if (sql === 'SELECT * FROM tasks WHERE source = ?') {
      return new MockStatement({
        all: (source) => this.rows.filter((row) => row.source === source)
      })
    }

    if (sql.startsWith('SELECT * FROM tasks')) {
      return new MockStatement({
        all: (...params) => this.listFromSql(sql, params)
      })
    }

    throw new Error(`Unexpected SQL in taskDao test: ${sql}`)
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return (...args) => {
      const snapshot = this.rows.map((row) => ({ ...row }))

      try {
        return fn(...args)
      } catch (error) {
        this.rows = snapshot
        throw error
      }
    }
  }

  private updateFromSql(sql: string, params: unknown[]): void {
    const assignments =
      sql
        .match(/^UPDATE tasks SET (.+) WHERE id = \?$/)
        ?.at(1)
        ?.split(', ')
        .map((assignment) => assignment.split(' = ')[0] as keyof TaskRow) ?? []
    const id = params[assignments.length] as string
    const updates = Object.fromEntries(
      assignments.map((column, index) => [column, params[index]])
    ) as Partial<TaskRow>
    const failure = this.failOnUpdate?.(id, updates)

    if (failure) {
      throw failure
    }

    const row = this.rows.find((item) => item.id === id)

    if (row) {
      Object.assign(row, updates)
    }
  }

  private listFromSql(sql: string, params: unknown[]): TaskRow[] {
    let rows = [...this.rows]
    let paramIndex = 0

    if (sql.includes('status IN')) {
      const statusPlaceholderCount =
        sql.match(/status IN \(([^)]*)\)/)?.[1].match(/\?/g)?.length ?? 0
      const statuses = params.slice(paramIndex, paramIndex + statusPlaceholderCount)
      paramIndex += statusPlaceholderCount
      rows = rows.filter((row) => statuses.includes(row.status))
    }

    if (sql.includes('category = ?')) {
      const category = params[paramIndex]
      rows = rows.filter((row) => row.category === category)
    }

    return rows.sort((a, b) => b.createdAt - a.createdAt)
  }
}

function createTestDb(): MockTaskDb {
  return new MockTaskDb()
}

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

test('taskDao inserts, reads, updates, and deletes a task round-trip', () => {
  const db = createTestDb()
  const task = makeTask()

  assert.deepEqual(insertTask(db, task), task)
  assert.deepEqual(getTask(db, task.id), task)

  updateTask(db, task.id, {
    status: 'downloading',
    totalBytes: 2048,
    downloadedBytes: 128,
    startedAt: 1200
  })

  assert.deepEqual(getTask(db, task.id), {
    ...task,
    status: 'downloading',
    totalBytes: 2048,
    downloadedBytes: 128,
    startedAt: 1200
  })

  deleteTask(db, task.id)

  assert.equal(getTask(db, task.id), null)
})

test('taskDao listTasks filters by status and category while sorting newest first', () => {
  const db = createTestDb()
  const oldVideo = makeTask({
    id: 'old-video',
    status: 'completed',
    category: 'video',
    createdAt: 100
  })
  const newVideo = makeTask({
    id: 'new-video',
    status: 'queued',
    category: 'video',
    createdAt: 300
  })
  const middleAudio = makeTask({
    id: 'middle-audio',
    status: 'queued',
    category: 'audio',
    createdAt: 200
  })

  insertTask(db, oldVideo)
  insertTask(db, newVideo)
  insertTask(db, middleAudio)

  assert.deepEqual(
    listTasks(db).map((task) => task.id),
    ['new-video', 'middle-audio', 'old-video']
  )
  assert.deepEqual(
    listTasks(db, { status: 'queued' }).map((task) => task.id),
    ['new-video', 'middle-audio']
  )
  assert.deepEqual(
    listTasks(db, { status: ['queued', 'completed'], category: 'video' }).map((task) => task.id),
    ['new-video', 'old-video']
  )
})

test('taskDao batchUpdateStatus rolls back the whole batch when one update fails', () => {
  const db = createTestDb()
  const first = makeTask({ id: 'first', createdAt: 100 })
  const second = makeTask({ id: 'second', createdAt: 200 })
  insertTask(db, first)
  insertTask(db, second)

  db.failOnUpdate = (id, updates) =>
    id === 'second' && updates.status === 'completed' ? new Error('second update failed') : null

  assert.throws(() => {
    batchUpdateStatus(db, ['first', 'second'], 'completed')
  }, /second update failed/)

  assert.equal(getTask(db, 'first')?.status, 'queued')
  assert.equal(getTask(db, 'second')?.status, 'queued')

  batchUpdateStatus(db, ['first', 'second'], 'downloading' as TaskStatus)

  assert.equal(getTask(db, 'first')?.status, 'downloading')
  assert.equal(getTask(db, 'second')?.status, 'downloading')
})

test('taskDao 行级 videoMeta JSON 损坏 → 该行退化 null,不放大为 listTasks / getTask 整体失败', () => {
  const db = createTestDb()
  insertTask(db, makeTask({ id: 'ok', createdAt: 200 }))

  // 直接经 INSERT 塞入坏 JSON(绕过 serializeVideoMeta):模拟外部编辑 / 局部损坏——
  // PRAGMA quick_check 只校验 B-tree 结构,校验不到应用层 JSON,这类行会存在
  const broken = makeTask({ id: 'broken', kind: 'video', createdAt: 100 })
  db.prepare('INSERT INTO tasks (mock)').run(
    broken.id,
    broken.kind,
    broken.source,
    broken.status,
    broken.filename,
    broken.savePath,
    broken.category,
    broken.totalBytes,
    broken.downloadedBytes,
    '{not-valid-json', // videoMeta 列:非法 JSON
    broken.error,
    broken.createdAt,
    broken.startedAt,
    broken.completedAt,
    broken.torrentMeta
  )

  // 修复前:一行坏 JSON 让 listTasks 整体抛出(任务列表永远拉不到);修复后:该行 videoMeta 退化 null
  const tasks = listTasks(db)
  assert.equal(tasks.length, 2, '坏行不吞掉整个列表')
  assert.equal(tasks.find((t) => t.id === 'broken')?.videoMeta, null, '坏 videoMeta 退化为 null')
  assert.equal(getTask(db, 'broken')?.videoMeta, null, 'getTask 同样退化不抛')
})

test('taskDao torrentMeta 序列化 / 解析往返(仿 videoMeta;torrent 任务落 name/infoHash/files)', () => {
  const db = createTestDb()
  const torrentTask = makeTask({
    id: 'bt-1',
    kind: 'torrent',
    source: 'magnet:?xt=urn:btih:abc',
    filename: 'Some Release',
    torrentMeta: {
      name: 'Some Release',
      infoHash: 'abc123',
      files: [
        { path: 'Some Release/a.mkv', length: 1024, selected: true },
        { path: 'Some Release/b.srt', length: 8, selected: true }
      ]
    }
  })

  // 插入 → 读回:torrentMeta 逐字段往返一致
  assert.deepEqual(insertTask(db, torrentTask), torrentTask)
  assert.deepEqual(getTask(db, torrentTask.id), torrentTask)

  // updateTask 亦经序列化(非落成 [object Object]):改写 torrentMeta 后读回一致
  const updated = {
    name: 'Some Release',
    infoHash: 'abc123',
    files: [{ path: 'Some Release/a.mkv', length: 1024, selected: false }]
  }
  updateTask(db, torrentTask.id, { torrentMeta: updated })
  assert.deepEqual(getTask(db, torrentTask.id)?.torrentMeta, updated)

  // null 往返:http/video 任务 torrentMeta 恒 null,读回仍 null
  const httpTask = makeTask({ id: 'http-1' })
  insertTask(db, httpTask)
  assert.equal(getTask(db, 'http-1')?.torrentMeta, null)
})

// ==================== findBySource(v0.3 Task 4 · #29 · spec §4)====================

test('taskDao findBySource 精确命中同源:只返回该 source 的行,不误伤其他 source', () => {
  const db = createTestDb()
  insertTask(db, makeTask({ id: 'a', source: 'https://x/a.zip', savePath: 'D:\\D\\a.zip' }))
  insertTask(db, makeTask({ id: 'b', source: 'https://x/b.zip', savePath: 'D:\\D\\b.zip' }))

  const hits = findBySource(db, 'https://x/a.zip')
  assert.equal(hits.length, 1, '仅命中同源一行')
  assert.deepEqual(
    hits[0],
    getTask(db, 'a'),
    '投影与 getTask 一致(复用 rowToTask:speed=0 / videoMeta 解析)'
  )
})

test('taskDao findBySource 同源多行全返回(同 URL 不同清晰度 / 不同落点),供查重逐条判定', () => {
  const db = createTestDb()
  const source = 'https://y/watch?v=1'
  insertTask(
    db,
    makeTask({
      id: 'v1080',
      kind: 'video',
      source,
      status: 'completed',
      filename: 'V [1080p].mp4',
      savePath: 'D:\\Videos\\V [1080p].mp4',
      videoMeta: {
        title: 'V',
        selectedFormat: 'best',
        postProcess: 'merge',
        playlistIndex: -1,
        qualityLabel: '1080P'
      }
    })
  )
  insertTask(
    db,
    makeTask({
      id: 'v720',
      kind: 'video',
      source,
      status: 'downloading',
      filename: 'V [720p].mp4',
      savePath: 'D:\\Videos\\V [720p].mp4'
    })
  )
  insertTask(db, makeTask({ id: 'other', source: 'https://y/watch?v=2' }))

  const hits = findBySource(db, source)
  assert.deepEqual(hits.map((t) => t.id).sort(), ['v1080', 'v720'], '同源两行全命中')
  assert.equal(
    hits.find((t) => t.id === 'v1080')?.videoMeta?.qualityLabel,
    '1080P',
    'videoMeta 正常解析'
  )
})

test('taskDao findBySource 无命中 → 空数组(不抛、不退化为全量)', () => {
  const db = createTestDb()
  insertTask(db, makeTask({ id: 'a', source: 'https://x/a.zip' }))

  assert.deepEqual(findBySource(db, 'https://nope/none'), [], '无同源记录 → []')
  assert.deepEqual(findBySource(createTestDb(), 'https://x/a.zip'), [], '空库 → []')
})

test('taskDao 行级 torrentMeta JSON 损坏 → 该行退化 null,不放大为整体失败(仿 videoMeta)', () => {
  const db = createTestDb()
  insertTask(db, makeTask({ id: 'ok', createdAt: 200 }))

  const broken = makeTask({ id: 'broken-bt', kind: 'torrent', createdAt: 100 })
  db.prepare('INSERT INTO tasks (mock)').run(
    broken.id,
    broken.kind,
    broken.source,
    broken.status,
    broken.filename,
    broken.savePath,
    broken.category,
    broken.totalBytes,
    broken.downloadedBytes,
    broken.videoMeta,
    broken.error,
    broken.createdAt,
    broken.startedAt,
    broken.completedAt,
    '{not-valid-json' // torrentMeta 列:非法 JSON
  )

  const tasks = listTasks(db)
  assert.equal(tasks.length, 2, '坏行不吞掉整个列表')
  assert.equal(
    tasks.find((t) => t.id === 'broken-bt')?.torrentMeta,
    null,
    '坏 torrentMeta 退化为 null'
  )
  assert.equal(getTask(db, 'broken-bt')?.torrentMeta, null, 'getTask 同样退化不抛')
})
