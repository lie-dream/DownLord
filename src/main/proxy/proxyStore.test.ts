import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readProxyConfig, writeProxyConfig, type ProxyStoreFs } from './proxyStore'
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from '../../shared/ipc'

/** 内存 fake fs(注入式),模拟原子写(临时文件 → rename)与读 */
function createMemoryFs(seed: Record<string, string> = {}): ProxyStoreFs & {
  files: Map<string, string>
  renames: number
} {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    renames: 0,
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
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      if (!files.has(oldPath)) throw new Error('rename: source missing')
      files.set(newPath, files.get(oldPath)!)
      files.delete(oldPath)
      this.renames++
    },
    async mkdir(): Promise<void> {
      // 内存 fs 无需建目录
    }
  }
}

const PATH = '/userData/config/proxy.json'

// ==================== 往返一致(spec §2.3)====================

test('writeProxyConfig 原子写(临时文件 → rename)后 readProxyConfig 往返一致', async () => {
  const fs = createMemoryFs()
  const cfg: ProxyConfig = { mode: 'manual', manualUrl: 'http://127.0.0.1:7890' }
  await writeProxyConfig(PATH, cfg, fs)

  assert.equal(fs.renames, 1, '应经临时文件 rename 落盘(原子写)')
  assert.equal(fs.files.has(`${PATH}.tmp`), false, '临时文件应已 rename 消失')

  const read = await readProxyConfig(PATH, fs)
  assert.deepEqual(read, cfg)
})

// ==================== 缺失 → 回退默认并修复 ====================

test('readProxyConfig 文件缺失 → 回退 DEFAULT_PROXY_CONFIG 并重写修复', async () => {
  const fs = createMemoryFs()
  const read = await readProxyConfig(PATH, fs)
  assert.deepEqual(read, DEFAULT_PROXY_CONFIG)
  // 修复:重写出默认配置文件
  assert.equal(fs.files.has(PATH), true)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_PROXY_CONFIG)
})

// ==================== JSON 损坏 → 回退默认并修复 ====================

test('readProxyConfig JSON 损坏 → 回退默认并重写修复', async () => {
  const fs = createMemoryFs({ [PATH]: '{ not valid json ]' })
  const read = await readProxyConfig(PATH, fs)
  assert.deepEqual(read, DEFAULT_PROXY_CONFIG)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_PROXY_CONFIG)
})

test('readProxyConfig 结构非法(未知 mode / 字段类型错)→ 回退默认并修复', async () => {
  const fs = createMemoryFs({ [PATH]: JSON.stringify({ mode: 'turbo', manualUrl: 123 }) })
  const read = await readProxyConfig(PATH, fs)
  assert.deepEqual(read, DEFAULT_PROXY_CONFIG)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_PROXY_CONFIG)
})

test('readProxyConfig 合法非默认配置 → 原样读回(不被误判损坏)', async () => {
  const cfg: ProxyConfig = { mode: 'direct', manualUrl: null }
  const fs = createMemoryFs({ [PATH]: JSON.stringify(cfg) })
  const read = await readProxyConfig(PATH, fs)
  assert.deepEqual(read, cfg)
  // 合法即不触发修复重写(renames 维持 0)
  assert.equal(fs.renames, 0)
})
