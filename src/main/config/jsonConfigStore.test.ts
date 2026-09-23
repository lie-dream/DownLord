import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createJsonConfigStore, type JsonConfigStoreFs } from './jsonConfigStore'

/** 被测样例结构:三种字段各占一类(原始值 / 可空 / 数组 —— 数组用于验副本独立性) */
interface Sample {
  n: number
  s: string | null
  list: string[]
}

/** 独立副本工厂(含数组,故不能写成 `{...DEFAULTS}`) */
function cloneDefaults(): Sample {
  return { n: 0, s: null, list: [] }
}

const DEFAULTS: Sample = cloneDefaults()

function isSample(v: unknown): v is Sample {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.n !== 'number') return false
  if (!(o.s === null || typeof o.s === 'string')) return false
  if (!Array.isArray(o.list) || !o.list.every((x) => typeof x === 'string')) return false
  return true
}

/** 内存 fake fs:除文件内容外**逐字记录调用序列**(写路径字节级断言的取证面) */
function createMemoryFs(seed: Record<string, string> = {}): JsonConfigStoreFs & {
  files: Map<string, string>
  calls: string[][]
} {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    calls: [],
    async readFile(path: string): Promise<string> {
      this.calls.push(['readFile', path])
      if (!files.has(path)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return files.get(path)!
    },
    async writeFile(path: string, data: string): Promise<void> {
      this.calls.push(['writeFile', path, data])
      files.set(path, data)
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      this.calls.push(['rename', oldPath, newPath])
      if (!files.has(oldPath)) throw new Error('rename: source missing')
      files.set(newPath, files.get(oldPath)!)
      files.delete(oldPath)
    },
    async mkdir(dir: string): Promise<void> {
      this.calls.push(['mkdir', dir])
    }
  }
}

const PATH = '/userData/config/sample.json'
const DIR = '/userData/config'
const SAMPLE: Sample = { n: 7, s: 'x', list: ['a', 'b'] }

/** 默认档(不传 `repairOnInvalid` / `normalize`)—— 缺省即**不修复** */
function plainStore(fs: JsonConfigStoreFs): ReturnType<typeof createJsonConfigStore<Sample>> {
  return createJsonConfigStore<Sample>({ path: PATH, fs, cloneDefaults, guard: isSample })
}

// ==================== ★ 写路径字节级断言(迁移的核心护栏,spec §1.4.1 纪律 3)====================

test('write 调用序列恰好 mkdir(dirname) → writeFile(tmp) → rename(tmp, path),内容无尾换行', async () => {
  const fs = createMemoryFs()
  await plainStore(fs).write(SAMPLE)

  const expected = JSON.stringify(SAMPLE, null, 2)
  assert.deepEqual(
    fs.calls,
    [
      ['mkdir', DIR],
      ['writeFile', `${PATH}.tmp`, expected],
      ['rename', `${PATH}.tmp`, PATH]
    ],
    '三步顺序 / 参数逐字固定:多一步少一步、换个顺序都算行为变化'
  )
  assert.equal(fs.files.get(PATH), expected, '落盘字节 = JSON.stringify(v, null, 2)')
  assert.equal(expected.endsWith('\n'), false, '无尾换行(四份既有 store 均无)')
  assert.equal(fs.files.has(`${PATH}.tmp`), false, '临时文件已 rename 消失')
})

test('write → read 往返一致', async () => {
  const fs = createMemoryFs()
  const store = plainStore(fs)
  await store.write(SAMPLE)
  assert.deepEqual(await store.read(), SAMPLE)
})

// ==================== repairOnInvalid 两态 ====================

test('repairOnInvalid:true 损坏 → 回退默认并回写修复', async () => {
  const fs = createMemoryFs({ [PATH]: '{ not valid ]' })
  const store = createJsonConfigStore<Sample>({
    path: PATH,
    fs,
    cloneDefaults,
    guard: isSample,
    repairOnInvalid: true
  })

  assert.deepEqual(await store.read(), DEFAULTS)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULTS, '损坏文件被默认值覆盖修复')
})

test('repairOnInvalid:true 且修复写失败 → 仍返回默认值不抛', async () => {
  const fs = createMemoryFs({ [PATH]: 'broken' })
  fs.writeFile = async (): Promise<void> => {
    throw new Error('EACCES: read-only')
  }
  const store = createJsonConfigStore<Sample>({
    path: PATH,
    fs,
    cloneDefaults,
    guard: isSample,
    repairOnInvalid: true
  })

  assert.deepEqual(await store.read(), DEFAULTS, '修复写失败不影响返回默认值')
})

test('repairOnInvalid:false(缺省)损坏 → 回退默认但零写盘,损坏文件原样留着', async () => {
  const fs = createMemoryFs({ [PATH]: '{ not valid ]' })

  assert.deepEqual(await plainStore(fs).read(), DEFAULTS)
  assert.deepEqual(
    fs.calls.filter((c) => c[0] !== 'readFile'),
    [],
    '回退路径零 mkdir / 零 writeFile / 零 rename'
  )
  assert.equal(fs.files.get(PATH), '{ not valid ]', '损坏文件不被静默重写')
})

test('read 文件缺失 → 回退默认(缺省档不修复)', async () => {
  const fs = createMemoryFs()
  assert.deepEqual(await plainStore(fs).read(), DEFAULTS)
  assert.equal(fs.files.size, 0)
})

// ==================== guard / normalize ====================

test('guard 拒(结构非法)→ 回退默认', async () => {
  const cases: string[] = [
    JSON.stringify({ n: 'x', s: null, list: [] }), // n 非 number
    JSON.stringify({ n: 1, s: 5, list: [] }), // s 非 string|null
    JSON.stringify({ n: 1, s: null, list: [1] }), // list 元素非 string
    JSON.stringify({ n: 1, s: null }), // 缺 list
    JSON.stringify(null),
    JSON.stringify([1, 2])
  ]
  for (const seed of cases) {
    const fs = createMemoryFs({ [PATH]: seed })
    assert.deepEqual(await plainStore(fs).read(), DEFAULTS, `非法:${seed}`)
  }
})

test('normalize 生效:合法结构经归一后返回,且不触发修复重写', async () => {
  const fs = createMemoryFs({ [PATH]: JSON.stringify({ n: 99, s: 'keep', list: ['a'] }) })
  const store = createJsonConfigStore<Sample>({
    path: PATH,
    fs,
    cloneDefaults,
    guard: isSample,
    normalize: (p) => ({ ...p, n: Math.min(p.n, 10) }), // clamp
    repairOnInvalid: true
  })

  assert.deepEqual(await store.read(), { n: 10, s: 'keep', list: ['a'] }, 'n 被 clamp 到 10')
  assert.deepEqual(
    fs.calls.filter((c) => c[0] !== 'readFile'),
    [],
    '合法结构零写盘(归一不算损坏)'
  )
})

test('不传 normalize → 合法结构原样返回', async () => {
  const fs = createMemoryFs({ [PATH]: JSON.stringify(SAMPLE) })
  assert.deepEqual(await plainStore(fs).read(), SAMPLE)
})

// ==================== cloneDefaults 独立副本 ====================

test('cloneDefaults 每次返回独立副本(mutate 返回值不污染下一次读 / 不污染常量)', async () => {
  const fs = createMemoryFs()
  const store = plainStore(fs)

  const first = await store.read()
  first.list.push('mutated')
  first.n = 42

  assert.deepEqual(await store.read(), { n: 0, s: null, list: [] }, '下次读仍是干净默认值')
  assert.deepEqual(DEFAULTS.list, [], '共享常量未被污染')
})
