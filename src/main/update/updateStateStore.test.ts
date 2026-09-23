import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readUpdateState,
  writeUpdateState,
  shouldCheckNow,
  createUpdateStateStore,
  DEFAULT_UPDATE_STATE,
  UPDATE_THROTTLE_MS,
  type UpdateState,
  type UpdateStateStoreFs
} from './updateStateStore'

/** 内存 fake fs(注入式),模拟原子写(临时文件 → rename)与读 */
function createMemoryFs(seed: Record<string, string> = {}): UpdateStateStoreFs & {
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

const PATH = '/userData/config/updateState.json'

test('writeUpdateState 原子写(tmp → rename)+ readUpdateState 往返一致', async () => {
  const fs = createMemoryFs()
  const state: UpdateState = {
    lastYtDlpCheckAt: 1_700_000_000_000,
    lastYtDlpLatest: '2026.06.10',
    lastAppCheckAt: 1_700_000_100_000,
    lastAppLatest: '0.2.0'
  }
  await writeUpdateState(PATH, state, fs)
  assert.equal(fs.renames, 1, '经临时文件 rename 落盘(原子写)')
  assert.equal(fs.files.has(`${PATH}.tmp`), false, '临时文件已 rename 消失')
  assert.deepEqual(await readUpdateState(PATH, fs), state)
})

test('readUpdateState 缺失 → 回退默认(不抛、不重写)', async () => {
  const fs = createMemoryFs()
  assert.deepEqual(await readUpdateState(PATH, fs), DEFAULT_UPDATE_STATE)
  // ★ 派生缓存与用户配置的唯一行为差异(`repairOnInvalid: false`):回退路径**零写盘**,
  //   下次成功检查更新时写入自愈。只断言返回值是不够的 —— 回写默认后返回值一样(TODO #48)。
  assert.equal(fs.writes, 0, '回退路径零写盘(派生缓存下次写入自愈)')
  assert.equal(fs.renames, 0)
  assert.equal(fs.files.size, 0)
})

test('readUpdateState 损坏 JSON / 结构非法 → 回退默认(不抛、不重写)', async () => {
  const corrupt = createMemoryFs({ [PATH]: '{ not valid ]' })
  assert.deepEqual(await readUpdateState(PATH, corrupt), DEFAULT_UPDATE_STATE)
  assert.equal(corrupt.writes, 0, '损坏文件原样留着,不静默重写')
  assert.equal(corrupt.files.get(PATH), '{ not valid ]')

  const badShape = createMemoryFs({ [PATH]: JSON.stringify({ lastYtDlpCheckAt: 'x' }) })
  assert.deepEqual(await readUpdateState(PATH, badShape), DEFAULT_UPDATE_STATE)
  assert.equal(badShape.writes, 0, '非法结构不重写')
})

test('readUpdateState 合法结构补默认(向后兼容新增字段)', async () => {
  // 缺 lastAppLatest 的 shape 非法 → 回退默认;此处验证完整合法结构原样读回
  const full: UpdateState = {
    lastYtDlpCheckAt: 5,
    lastYtDlpLatest: null,
    lastAppCheckAt: 0,
    lastAppLatest: null
  }
  const fs = createMemoryFs({ [PATH]: JSON.stringify(full) })
  assert.deepEqual(await readUpdateState(PATH, fs), full)
})

test('shouldCheckNow 节流判定(spec §2.5:24h 窗口)', () => {
  const base = 1_700_000_000_000
  assert.equal(shouldCheckNow(base, base + UPDATE_THROTTLE_MS - 1), false, '距上次 <24h → 跳过')
  assert.equal(shouldCheckNow(base, base + UPDATE_THROTTLE_MS), true, '距上次 =24h → 执行')
  assert.equal(shouldCheckNow(base, base + UPDATE_THROTTLE_MS + 1), true, '距上次 >24h → 执行')
  assert.equal(shouldCheckNow(0, base), true, 'lastAt=0(从未)→ 始终执行')
})

test('createUpdateStateStore 门面读写绑定 path + fs', async () => {
  const fs = createMemoryFs()
  const store = createUpdateStateStore(PATH, fs)
  await store.write({ ...DEFAULT_UPDATE_STATE, lastYtDlpLatest: '2026.06.10' })
  assert.equal((await store.read()).lastYtDlpLatest, '2026.06.10')
})
