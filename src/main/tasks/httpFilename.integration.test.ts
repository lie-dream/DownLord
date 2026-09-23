/** M-011: HTTP 原生取名 → 清洗 / 路由 / 查重 → DB / 进度 / 恢复。 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { basename, dirname, join, sep } from 'node:path'
import type {
  AddUriInput,
  DownloadProgress,
  DuplicateConflict,
  TaskProgress,
  Task
} from '../../shared/ipc'
import type { TaskEngine, TaskManager } from './taskManager'
import type { AppDatabase } from '../db/connection'
import { canLoadSqlite } from '../../../tests/helpers/sqlite'
import { makeTempDir } from '../../../tests/helpers/tmpdir'

const SQLITE_OK = canLoadSqlite()
if (!SQLITE_OK && process.env.CI) throw new Error('M-011 requires node:sqlite')

class FilenameEngine implements TaskEngine {
  readonly probes: Pick<AddUriInput, 'url' | 'dir' | 'headers'>[] = []
  readonly adds: AddUriInput[] = []
  result: string | null = null
  probeError: Error | null = null
  private listeners = new Set<(p: DownloadProgress) => void>()
  async resolveHttpFilename(
    input: Pick<AddUriInput, 'url' | 'dir' | 'headers'>
  ): Promise<string | null> {
    this.probes.push(input)
    if (this.probeError) throw this.probeError
    return this.result
  }
  async addUri(input: AddUriInput): Promise<string> {
    this.adds.push(input)
    return 'engine-' + this.adds.length
  }
  pause(): Promise<void> {
    return Promise.resolve()
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  remove(): Promise<void> {
    return Promise.resolve()
  }
  onProgress(cb: (p: DownloadProgress) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  emit(id: string, extra: Partial<DownloadProgress> = {}): void {
    const p: DownloadProgress = {
      id,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      connections: 0,
      ...extra
    }
    for (const cb of this.listeners) cb(p)
  }
}

interface FilenameHarness {
  root: string
  engine: FilenameEngine
  manager: TaskManager
  files: Set<string>
  trashed: string[]
  ensured: string[]
  conflicts: DuplicateConflict[]
  frames: TaskProgress[]
  hooks: { trash(path: string): Promise<void> }
  create(engine: FilenameEngine): Promise<TaskManager>
  read(id: string): Task | null
  rows(): Task[]
}

async function harness(t: TestContext): Promise<FilenameHarness> {
  let db: AppDatabase | undefined = undefined
  const managers: TaskManager[] = []
  t.after(() => {
    for (const manager of managers) manager.stop()
    db?.close()
  })
  const root = await makeTempDir(t, 'http-filename')
  const dbPath = join(root, 'history.db')
  const { initDatabase } = await import('../db/connection')
  const { seedDefaultCategories } = await import('../db/categoryDao')
  const { getTask, listTasks } = await import('../db/taskDao')
  const { TaskManager } = await import('./taskManager')
  db = initDatabase(dbPath)
  seedDefaultCategories(db)
  const database = db
  const files = new Set<string>()
  const trashed: string[] = []
  const ensured: string[] = []
  const conflicts: DuplicateConflict[] = []
  const frames: TaskProgress[] = []
  const hooks = { trash: async (_p: string): Promise<void> => {} }
  const create = async (engine: FilenameEngine): Promise<TaskManager> => {
    const manager = new TaskManager(
      {
        engine,
        initDatabase: () => database,
        ensureDir: (dir) => {
          ensured.push(dir)
        },
        existsSync: (p) => files.has(p),
        readDir: (dir) => [...files].filter((p) => dirname(p) === dir).map((p) => basename(p)),
        delay: async () => {},
        trashItem: async (p) => {
          trashed.push(p)
          await hooks.trash(p)
          files.delete(p)
        }
      },
      { dbPath, defaultDir: root, maxConcurrent: 3 }
    )
    managers.push(manager)
    manager.onDuplicate((c) => conflicts.push(c))
    manager.onProgress((p) => frames.push(p))
    await manager.start()
    return manager
  }
  const engine = new FilenameEngine()
  const manager = await create(engine)
  return {
    root,
    engine,
    manager,
    files,
    trashed,
    ensured,
    conflicts,
    frames,
    hooks,
    create,
    read: (id: string) => getTask(database, id),
    rows: () => listTasks(database)
  }
}

const SOURCE = 'https://origin.example/redirect-to'

test(
  'M-011 302 最终文件名先于分类/插库/提交确定,正式 out 不再取原 URL',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    h.engine.result = join(h.root, 'payload.zip')
    const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
    assert.equal(h.engine.probes.length, 1)
    assert.equal(h.engine.probes[0].url, SOURCE)
    assert.equal(h.read(id)?.filename, 'payload.zip')
    assert.equal(h.read(id)?.savePath, join(h.root, 'Archives', 'payload.zip'))
    assert.equal(h.read(id)?.category, 'archive')
    assert.deepEqual(h.engine.adds, [
      { url: SOURCE, dir: join(h.root, 'Archives'), filename: 'payload.zip' }
    ])
  }
)

for (const [raw, expected] of [
  ['CON', '_CON'],
  ['COM1.txt', '_COM1.txt'],
  ['report?.pdf', 'report_.pdf'],
  ['report.pdf. ', 'report.pdf'],
  ['..', 'download'],
  ['../outside.pdf', 'outside.pdf']
]) {
  test('M-011 新取名路径仍过唯一清洗: ' + JSON.stringify(raw), { skip: !SQLITE_OK }, async (t) => {
    const h = await harness(t)
    h.engine.result = h.root + sep + raw
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir: join(h.root, 'Chosen')
    })
    assert.equal(h.read(id)?.filename, expected)
    assert.equal(h.read(id)?.savePath, join(h.root, 'Chosen', expected))
    assert.equal(h.engine.adds[0].filename, expected)
  })
}

test('M-011 非空显式名称优先且仍清洗,不调用原生探测', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  h.engine.result = join(h.root, 'server.pdf')
  const id = await h.manager.addTask({ kind: 'http', source: SOURCE, filename: 'mine?.zip' })
  assert.equal(h.read(id)?.filename, 'mine_.zip')
  assert.equal(h.engine.probes.length, 0)
  assert.equal(h.engine.adds[0].filename, 'mine_.zip')
})

test('M-011 空白显式名称按自动取名处理', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  h.engine.result = join(h.root, 'server.pdf')
  const id = await h.manager.addTask({ kind: 'http', source: SOURCE, filename: '   ' })
  assert.equal(h.engine.probes.length, 1)
  assert.equal(h.read(id)?.filename, 'server.pdf')
})

for (const failure of ['null', 'empty', 'throw'] as const) {
  test('M-011 探测失败仍用 URL 兜底继续 GET: ' + failure, { skip: !SQLITE_OK }, async (t) => {
    const h = await harness(t)
    h.engine.result = failure === 'empty' ? '' : null
    h.engine.probeError = failure === 'throw' ? new Error('HEAD not supported') : null
    const source = 'https://origin.example/fallback.zip?q=1'
    const id = await h.manager.addTask({ kind: 'http', source })
    assert.equal(h.engine.probes.length, 1)
    assert.equal(h.read(id)?.filename, 'fallback.zip')
    assert.equal(h.engine.adds[0].filename, 'fallback.zip')
  })
}

test('M-011 原生探测和正式下载均只接受白名单头', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  h.engine.result = join(h.root, 'server.pdf')
  await h.manager.addTask({
    kind: 'http',
    source: SOURCE,
    headers: {
      Referer: 'https://page.example/',
      'User-Agent': 'DownLord-test',
      Cookie: 'private',
      Host: 'evil.example'
    }
  })
  const expected = { Referer: 'https://page.example/', 'User-Agent': 'DownLord-test' }
  assert.deepEqual(h.engine.probes[0].headers, expected)
  assert.deepEqual(h.engine.adds[0].headers, expected)
})

test('M-011 视频和 BT 不走 HTTP 探测', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  await h.manager.addTask({ kind: 'video', source: 'https://youtu.be/example' })
  await h.manager.addTask({ kind: 'torrent', source: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) })
  assert.equal(h.engine.probes.length, 0)
  assert.equal(h.engine.adds.length, 1)
  assert.ok(h.engine.adds[0].torrent)
})

test(
  'M-011 HTTP path-only 帧同步 DB/UI/类别,后续帧保留真实名且重启不再探测',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    h.engine.result = join(h.root, 'old.zip')
    const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
    const actual = join(h.root, 'Archives', 'actual.1.pdf')
    const dirsBefore = [...h.ensured]
    h.engine.emit('engine-1', { savePath: actual })
    assert.equal(h.read(id)?.filename, 'actual.1.pdf')
    assert.equal(h.read(id)?.savePath, actual)
    assert.equal(h.read(id)?.category, 'document')
    h.engine.emit('engine-1', { downloadedBytes: 5, totalBytes: 10 })
    assert.equal(h.frames.at(-1)?.filename, 'actual.1.pdf')
    assert.equal(h.frames.at(-1)?.savePath, actual)
    assert.equal(h.frames.at(-1)?.category, 'document')
    assert.deepEqual(h.ensured, dirsBefore, '路径帧只校正元信息,不迁目录')
    h.manager.stop()
    const next = new FilenameEngine()
    next.result = join(h.root, 'should-not-probe.zip')
    await h.create(next)
    assert.equal(next.probes.length, 0)
    assert.deepEqual(next.adds, [{ url: SOURCE, dir: dirname(actual), filename: 'actual.1.pdf' }])
  }
)

test(
  'M-011 只有旧 control 占名时避让,不读取/清理/复用未知断点',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    h.engine.result = join(h.root, 'payload.zip')
    const old = join(h.root, 'Archives', 'payload.zip')
    h.files.add(old + '.aria2')
    h.files.add(join(dirname(old), 'payload (1).zip.aria2'))
    const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
    assert.equal(h.read(id)?.filename, 'payload (2).zip')
    assert.equal(h.conflicts.length, 0)
    assert.equal(h.files.size, 2)
    assert.deepEqual(h.trashed, [])
  }
)

for (const decision of ['skip', 'open'] as const) {
  test(
    'M-011 原生取名后仍走四决策: ' + decision + ' 零 DB/磁盘写',
    { skip: !SQLITE_OK },
    async (t) => {
      const h = await harness(t)
      h.engine.result = join(h.root, 'payload.zip')
      const old = join(h.root, 'Archives', 'payload.zip')
      h.files.add(old)
      h.files.add(old + '.aria2')
      const before = [...h.files]
      const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
      assert.equal(h.conflicts.length, 1)
      assert.equal(h.rows().length, 0)
      await h.manager.resolveDuplicate({ conflictId: id, decision })
      assert.equal(h.rows().length, 0)
      assert.equal(h.engine.adds.length, 0)
      assert.deepEqual([...h.files], before)
      assert.deepEqual(h.trashed, [])
    }
  )
}

test('M-011 rename 双留并避让候选 data/control/不同源活跃目标', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  h.engine.result = join(h.root, 'payload (2).zip')
  await h.manager.addTask({ kind: 'http', source: SOURCE + '/active' })
  h.engine.result = join(h.root, 'payload.zip')
  const old = join(h.root, 'Archives', 'payload.zip')
  h.files.add(old)
  h.files.add(join(dirname(old), 'payload (1).zip.aria2'))
  const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
  await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
  assert.equal(h.read(id)?.filename, 'payload (3).zip')
  assert.equal(h.files.size, 2)
  assert.deepEqual(h.trashed, [])
})

test(
  'M-011 overwrite 明确授权后旧 data 和伴生 control 一起入回收站再提交',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    h.engine.result = join(h.root, 'payload.zip')
    const oldId = await h.manager.addTask({ kind: 'http', source: SOURCE })
    const old = h.read(oldId)!.savePath
    h.engine.emit('engine-1', { status: 'completed', downloadedBytes: 10, totalBytes: 10 })
    h.files.add(old)
    h.files.add(old + '.aria2')
    const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
    assert.equal(h.read(id), null)
    await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
    assert.deepEqual(h.trashed, [old, old + '.aria2'])
    assert.equal(h.files.size, 0)
    assert.equal(h.read(oldId), null, '仅在回收成功后移除被明确覆盖的旧完成记录')
    assert.equal(h.engine.adds.length, 2)
  }
)

for (const failOn of ['data', 'control'] as const) {
  test(
    'M-011 overwrite 回收失败不下引擎、不删除旧历史: ' + failOn,
    { skip: !SQLITE_OK },
    async (t) => {
      const h = await harness(t)
      h.engine.result = join(h.root, 'payload.zip')
      const oldId = await h.manager.addTask({ kind: 'http', source: SOURCE })
      const old = h.read(oldId)!.savePath
      h.engine.emit('engine-1', { status: 'completed', downloadedBytes: 10, totalBytes: 10 })
      h.files.add(old)
      h.files.add(old + '.aria2')
      h.hooks.trash = async (p) => {
        if (p === old + (failOn === 'control' ? '.aria2' : '')) throw new Error('回收站拒绝')
      }
      const id = await h.manager.addTask({ kind: 'http', source: SOURCE })
      await assert.rejects(
        h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' }),
        /回收站拒绝/
      )
      assert.equal(h.engine.adds.length, 1)
      assert.equal(h.read(id), null)
      assert.equal(h.read(oldId)?.status, 'completed')
      assert.ok(h.files.has(old + '.aria2'))
    }
  )
}

test('M-011 不同源 HTTP 活跃路径不能覆盖,可另选 rename', { skip: !SQLITE_OK }, async (t) => {
  const h = await harness(t)
  h.engine.result = join(h.root, 'payload.zip')
  const first = await h.manager.addTask({ kind: 'http', source: SOURCE })
  const id = await h.manager.addTask({ kind: 'http', source: SOURCE + '/other' })
  assert.equal(h.conflicts.at(-1)?.items[0].existing, 'active')
  await assert.rejects(
    h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' }),
    /路径.*使用/
  )
  assert.equal(h.engine.adds.length, 1)
  assert.equal(h.read(id), null)
  assert.equal(h.read(first)?.filename, 'payload.zip')
  assert.deepEqual(h.trashed, [])
  await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
  assert.equal(h.read(id)?.filename, 'payload (1).zip')
})

test(
  'M-011 并发 overwrite 在首个 await 前预约路径,另一决策不得交错 trash',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    h.engine.result = join(h.root, 'payload.zip')
    const target = join(h.root, 'Archives', 'payload.zip')
    h.files.add(target)
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    t.after(release)
    h.hooks.trash = async () => {
      entered()
      await blocked
    }
    const first = await h.manager.addTask({ kind: 'http', source: SOURCE + '/first' })
    const second = await h.manager.addTask({ kind: 'http', source: SOURCE + '/second' })
    assert.equal(h.conflicts.length, 2, '两个待覆盖目标均先停在冲突队列')
    const pending = h.manager.resolveDuplicate({ conflictId: first, decision: 'overwrite' })
    await inside
    try {
      await assert.rejects(
        h.manager.resolveDuplicate({ conflictId: second, decision: 'overwrite' }),
        /路径.*使用/
      )
      assert.deepEqual(h.trashed, [target])
      await h.manager.resolveDuplicate({ conflictId: second, decision: 'rename' })
      assert.equal(h.read(second)?.filename, 'payload (1).zip')
    } finally {
      release()
      await pending
    }
    assert.equal(h.read(first)?.filename, 'payload.zip')
    assert.equal(h.engine.adds.length, 2)
  }
)

test(
  'M-011 overwrite 也保护同 stem 不同扩展名的旧完成路径,不是只保护新目标',
  { skip: !SQLITE_OK, timeout: 10000 },
  async (t) => {
    const h = await harness(t)
    const oldId = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      filename: 'payload.zip',
      dir: join(h.root, 'shared')
    })
    const old = h.read(oldId)!.savePath
    h.engine.emit('engine-1', { status: 'completed' })
    h.files.add(old)
    h.files.add(old + '.aria2')
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      filename: 'payload.bin',
      dir: join(h.root, 'shared')
    })
    assert.equal(h.conflicts.at(-1)?.items[0].existingPath, old)
    await h.manager.addTask({
      kind: 'http',
      source: SOURCE + '/active',
      filename: 'busy.bin',
      dir: join(h.root, 'shared')
    })
    h.engine.emit('engine-2', { savePath: old })
    await assert.rejects(
      h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' }),
      /路径.*使用/
    )
    assert.deepEqual(h.trashed, [])
    assert.equal(h.engine.adds.length, 2)
    assert.equal(h.read(oldId)?.status, 'completed')
    assert.equal(h.read(id), null)
  }
)

test(
  'M-011 并发 overwrite 的旧同 stem 路径也在 await 前预约',
  { skip: !SQLITE_OK, timeout: 10000 },
  async (t) => {
    const h = await harness(t)
    const oldId = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      filename: 'payload.zip',
      dir: join(h.root, 'shared')
    })
    const old = h.read(oldId)!.savePath
    h.engine.emit('engine-1', { status: 'completed' })
    h.files.add(old)
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    t.after(release)
    h.hooks.trash = async () => {
      entered()
      await blocked
    }
    const first = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      filename: 'payload.bin',
      dir: join(h.root, 'shared')
    })
    const second = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      filename: 'payload.exe',
      dir: join(h.root, 'shared')
    })
    assert.equal(h.conflicts.length, 2, '两个同目录同 stem 冲突均应被 parked')
    const pending = h.manager.resolveDuplicate({ conflictId: first, decision: 'overwrite' })
    await inside
    try {
      // 第二个请求若绕过预约,会再次进入 trash;先捕获结果再放锁,不会泄漏拒绝或堵塞测试。
      const outcome = h.manager
        .resolveDuplicate({ conflictId: second, decision: 'overwrite' })
        .then(
          () => null,
          (err: unknown) => err
        )
      await Promise.resolve()
      const beforeRelease = [...h.trashed]
      release()
      await pending
      const error = await outcome
      assert.deepEqual(beforeRelease, [old], '旧路径也只能由一个覆盖操作持有')
      assert.ok(error instanceof Error)
      assert.match(error.message, /路径.*使用/)
    } finally {
      release()
      await pending
    }
  }
)

// Independent review regressions: file ownership is the full data/control set, not just data.
test(
  'M-011 审查: 活跃 .aria2 后缀数据不可被另一任务当作 control 回收',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    const dir = join(h.root, 'shared')
    const active = await h.manager.addTask({
      kind: 'http',
      source: SOURCE + '/active',
      dir,
      filename: 'payload.zip.aria2'
    })
    const activePath = h.read(active)!.savePath
    h.files.add(activePath)
    h.files.add(join(dir, 'payload.zip'))
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip'
    })
    assert.equal(h.conflicts.at(-1)?.items[0].existing, 'active')
    await assert.rejects(
      h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' }),
      /路径.*使用/
    )
    assert.deepEqual(h.trashed, [])
    assert.ok(h.files.has(activePath))
    assert.equal(h.read(active)?.status, 'downloading')
    assert.equal(h.read(id), null)
    assert.equal(h.engine.adds.length, 1)
    await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
    assert.equal(h.read(id)?.filename, 'payload (1).zip')
  }
)

test(
  'M-011 审查: 新数据目标也不能占用活跃 HTTP 的 control 路径',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    const dir = join(h.root, 'shared')
    await h.manager.addTask({
      kind: 'http',
      source: SOURCE + '/active',
      dir,
      filename: 'payload.zip'
    })
    // No file has materialized yet: application ownership, not existsSync, must protect it.
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip.aria2'
    })
    assert.equal(h.conflicts.at(-1)?.items[0].existing, 'active')
    assert.equal(h.read(id), null)
    await assert.rejects(
      h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' }),
      /路径.*使用/
    )
    assert.deepEqual(h.trashed, [])
    assert.equal(h.engine.adds.length, 1)
  }
)

test(
  'M-011 审查: rename 同样避让尚未落盘的 companion 数据路径',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    const dir = join(h.root, 'shared')
    await h.manager.addTask({
      kind: 'http',
      source: SOURCE + '/active',
      dir,
      filename: 'payload (1).zip.aria2'
    })
    h.files.add(join(dir, 'payload.zip'))
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip'
    })
    await h.manager.resolveDuplicate({ conflictId: id, decision: 'rename' })
    assert.equal(h.read(id)?.filename, 'payload (2).zip')
    assert.deepEqual(h.trashed, [])
  }
)

test(
  'M-011 审查: overwrite await 前也预约 control 路径,阻止新数据抢占',
  { skip: !SQLITE_OK, timeout: 10000 },
  async (t) => {
    const h = await harness(t)
    const dir = join(h.root, 'shared')
    const target = join(dir, 'payload.zip')
    h.files.add(target)
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    t.after(release)
    h.hooks.trash = async () => {
      entered()
      await blocked
    }
    const first = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip'
    })
    const pending = h.manager.resolveDuplicate({ conflictId: first, decision: 'overwrite' })
    await inside
    try {
      const second = await h.manager.addTask({
        kind: 'http',
        source: SOURCE + '/second',
        dir,
        filename: 'payload.zip.aria2'
      })
      assert.equal(h.conflicts.at(-1)?.conflictId, second)
      assert.equal(h.conflicts.at(-1)?.items[0].existing, 'active')
      assert.equal(h.read(second), null)
      assert.deepEqual(h.trashed, [target])
      await h.manager.resolveDuplicate({ conflictId: second, decision: 'skip' })
    } finally {
      release()
      await pending
    }
    assert.equal(h.engine.adds.length, 1)
  }
)

test(
  'M-011 审查: 原生正斜杠路径规范化后维持同源 completed 覆盖语义',
  { skip: !SQLITE_OK },
  async (t) => {
    const h = await harness(t)
    const dir = join(h.root, 'shared')
    const oldId = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip'
    })
    const target = h.read(oldId)!.savePath
    h.files.add(target)
    h.engine.emit('engine-1', { status: 'completed', savePath: target.split(sep).join('/') })
    assert.equal(h.read(oldId)?.savePath, target)
    assert.equal(h.frames.at(-1)?.savePath, target)
    const id = await h.manager.addTask({
      kind: 'http',
      source: SOURCE,
      dir,
      filename: 'payload.zip'
    })
    assert.equal(h.conflicts.at(-1)?.items[0].existing, 'completed')
    await h.manager.resolveDuplicate({ conflictId: id, decision: 'overwrite' })
    assert.equal(h.read(oldId), null)
    assert.equal(h.rows().length, 1)
    assert.equal(h.read(id)?.savePath, target)
  }
)
