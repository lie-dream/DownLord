import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readBtTrackerCache,
  writeBtTrackerCache,
  createBtTrackerStore,
  DEFAULT_BT_TRACKER_CACHE,
  type BtTrackerCache,
  type BtTrackerStoreFs
} from './btTrackerStore'

/** 内存 fake fs(注入式),模拟原子写(临时文件 → rename)与读;不碰真实文件系统 */
function createMemoryFs(seed: Record<string, string> = {}): BtTrackerStoreFs & {
  files: Map<string, string>
  renames: number
  writes: number
} {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    renames: 0,
    writes: 0,
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return files.get(path)!
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data)
      this.writes++
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      if (!files.has(oldPath)) throw new Error('rename: source missing')
      files.set(newPath, files.get(oldPath)!)
      files.delete(oldPath)
      this.renames++
    },
    async mkdir(): Promise<void> {
      /* fake FS:目录树是内存 Map,无需真实建目录 */
    }
  }
}

const PATH = '/userData/config/btTrackers.json'

const SAMPLE: BtTrackerCache = {
  updatedAt: 1_700_000_000_000,
  sourceUrls: [
    'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
    'https://cdn.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best_ip.txt'
  ],
  trackers: ['udp://a.example.com:6969/announce', 'udp://93.158.213.92:6969/announce']
}

test('writeBtTrackerCache 原子写(tmp → rename)+ readBtTrackerCache 往返一致', async () => {
  const fs = createMemoryFs()
  await writeBtTrackerCache(PATH, SAMPLE, fs)
  assert.equal(fs.renames, 1, '经临时文件 rename 落盘(原子写)')
  assert.equal(fs.files.has(`${PATH}.tmp`), false, '临时文件已 rename 消失')
  assert.deepEqual(await readBtTrackerCache(PATH, fs), SAMPLE)
})

test('writeBtTrackerCache 三字段同一次写(自包含,不会时间戳写了表没写)', async () => {
  const fs = createMemoryFs()
  await writeBtTrackerCache(PATH, SAMPLE, fs)
  const parsed = JSON.parse(fs.files.get(PATH)!)
  assert.deepEqual(Object.keys(parsed).sort(), ['sourceUrls', 'trackers', 'updatedAt'])
  assert.equal(fs.writes, 1, '一次写入,不分两趟')
})

test('readBtTrackerCache 文件缺失 → 回退默认(不抛、不重写)', async () => {
  const fs = createMemoryFs()
  assert.deepEqual(await readBtTrackerCache(PATH, fs), DEFAULT_BT_TRACKER_CACHE)
  assert.equal(fs.writes, 0, '回退路径零写盘(派生缓存下次成功拉取自愈)')
  assert.equal(fs.renames, 0)
  assert.equal(fs.files.size, 0)
})

test('readBtTrackerCache JSON 损坏 → 回退默认(不抛、不重写)', async () => {
  const fs = createMemoryFs({ [PATH]: '{ not valid ]' })
  assert.deepEqual(await readBtTrackerCache(PATH, fs), DEFAULT_BT_TRACKER_CACHE)
  assert.equal(fs.writes, 0, '损坏文件原样留着,不静默重写')
  assert.equal(fs.files.get(PATH), '{ not valid ]')
})

test('readBtTrackerCache 结构非法 → 回退默认(逐字段守卫)', async () => {
  const cases: string[] = [
    JSON.stringify({ updatedAt: 'x', sourceUrls: [], trackers: [] }), // updatedAt 非 number
    JSON.stringify({ updatedAt: 1, sourceUrls: 'no', trackers: [] }), // sourceUrls 非数组
    JSON.stringify({ updatedAt: 1, sourceUrls: [], trackers: [1, 2] }), // trackers 元素非 string
    JSON.stringify({ updatedAt: 1, trackers: [] }), // 缺 sourceUrls
    JSON.stringify(null),
    JSON.stringify(['udp://a.example.com:6969/announce'])
  ]
  for (const seed of cases) {
    const fs = createMemoryFs({ [PATH]: seed })
    assert.deepEqual(await readBtTrackerCache(PATH, fs), DEFAULT_BT_TRACKER_CACHE, `非法:${seed}`)
    assert.equal(fs.writes, 0, '非法结构不重写')
  }
})

test('readBtTrackerCache 回退值是独立副本(mutate 不污染 DEFAULT_BT_TRACKER_CACHE)', async () => {
  const fs = createMemoryFs()
  const first = await readBtTrackerCache(PATH, fs)
  first.trackers.push('udp://mutated.example.com:6969/announce')
  assert.deepEqual(DEFAULT_BT_TRACKER_CACHE.trackers, [], '共享常量未被污染')
  assert.deepEqual((await readBtTrackerCache(PATH, fs)).trackers, [], '下次读仍是干净默认值')
})

test('createBtTrackerStore 门面读写绑定 path + fs', async () => {
  const fs = createMemoryFs()
  const store = createBtTrackerStore(PATH, fs)
  assert.deepEqual(await store.read(), DEFAULT_BT_TRACKER_CACHE, '尚无缓存 → 默认(即用内置表)')
  await store.write(SAMPLE)
  assert.deepEqual(await store.read(), SAMPLE)
})
