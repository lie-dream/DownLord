import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isValidChannelToken, readChannelConfig, writeChannelConfig } from './channelConfig'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'

/** 通道配置落盘单测(v0.4 Task 3 · spec §3.2 / §5.3 / §7.1) */

const PATH = 'C:/userData/config/extensionChannel.json'
const TOKEN = 'a'.repeat(64)
const NEW_TOKEN = 'b'.repeat(64)

/** 内存 fake fs:记录调用序列(用于「首次运行只写一次」的字节级取证) */
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

/** 定值生成器(单测注入,断言可复现) */
function fixedToken(value = NEW_TOKEN): () => string {
  return () => value
}

test('文件缺失 → 默认(enabled:false / port:52330)+ 生成 token 并原子写回', async () => {
  const fs = createMemoryFs()
  const config = await readChannelConfig(PATH, fs, fixedToken())

  assert.deepStrictEqual(config, { enabled: false, port: 52330, token: NEW_TOKEN })
  assert.deepStrictEqual(JSON.parse(fs.files.get(PATH)!), config, '新 token 必须落盘,否则重启即失配')
})

test('★ 首次运行**只写一次**(不出现「先写默认再写带 token」的两次写)', async () => {
  const fs = createMemoryFs()
  await readChannelConfig(PATH, fs, fixedToken())

  const writes = fs.calls.filter(([op]) => op === 'writeFile')
  assert.equal(writes.length, 1, `期望恰好 1 次写,实际 ${writes.length} 次(repairOnInvalid 应为 false)`)
  // 原子写序列:mkdir → writeFile(tmp) → rename
  assert.deepStrictEqual(
    fs.calls.map(([op]) => op),
    ['readFile', 'mkdir', 'writeFile', 'rename']
  )
  assert.equal(writes[0][1], `${PATH}.tmp`, '先写临时文件再 rename')
})

test('★ 落盘 JSON 的键集合恰好 [enabled, port, token](连接状态是运行时态,不许塞进来)', async () => {
  const fs = createMemoryFs()
  await readChannelConfig(PATH, fs, fixedToken())
  const onDisk = JSON.parse(fs.files.get(PATH)!) as Record<string, unknown>
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['enabled', 'port', 'token'])

  // 写路径同样只落这三个键(即便调用方多塞字段也不会被写出去 —— 类型层已挡,此处钉死运行期)
  const fs2 = createMemoryFs()
  await writeChannelConfig(PATH, { enabled: true, port: 52330, token: TOKEN }, fs2)
  assert.deepStrictEqual(
    Object.keys(JSON.parse(fs2.files.get(PATH)!) as Record<string, unknown>).sort(),
    ['enabled', 'port', 'token']
  )
})

test('JSON 损坏 → 回退默认 + 补 token(且**不额外**回写损坏修复,只写这一次)', async () => {
  const fs = createMemoryFs({ [PATH]: '{ 这不是 json' })
  const config = await readChannelConfig(PATH, fs, fixedToken())

  assert.deepStrictEqual(config, { enabled: false, port: 52330, token: NEW_TOKEN })
  assert.equal(fs.calls.filter(([op]) => op === 'writeFile').length, 1)
})

test('token 非 64hex(空 / 短 / 大写 / 非 hex)→ 重新生成并写回,其余字段保留', async () => {
  for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
    const fs = createMemoryFs({
      [PATH]: JSON.stringify({ enabled: true, port: 52400, token: bad })
    })
    const config = await readChannelConfig(PATH, fs, fixedToken())
    assert.deepStrictEqual(
      config,
      { enabled: true, port: 52400, token: NEW_TOKEN },
      `token "${bad}" 应被重新生成,而 enabled / port 原样保留`
    )
  }
})

test('token 合法 → 原样返回,**一次都不写盘**', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({ enabled: true, port: 52330, token: TOKEN })
  })
  const config = await readChannelConfig(PATH, fs, fixedToken())

  assert.deepStrictEqual(config, { enabled: true, port: 52330, token: TOKEN })
  assert.equal(
    fs.calls.filter(([op]) => op === 'writeFile').length,
    0,
    '合法配置每次启动都重写会白磨盘,也让「改动即写」的可观测性失真'
  )
})

test('port 非法(超范围 / 落在 BT 段 / 非整数)→ 回落 52330', async () => {
  for (const badPort of [80, 70000, 52305, 52330.5]) {
    const fs = createMemoryFs({
      [PATH]: JSON.stringify({ enabled: true, port: badPort, token: TOKEN })
    })
    const config = await readChannelConfig(PATH, fs, fixedToken())
    assert.equal(config.port, 52330, `port ${badPort} 应回落默认`)
    assert.equal(config.enabled, true, '端口非法不该连带把开关也改了')
  }
})

test('enabled 非布尔 → 整体结构非法 → 回退默认(enabled:false)', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({ enabled: 'yes', port: 52330, token: TOKEN })
  })
  const config = await readChannelConfig(PATH, fs, fixedToken())
  assert.equal(config.enabled, false)
})

test('多余键被丢弃(防被篡改成异型 / 防连接状态偷偷落库)', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({
      enabled: true,
      port: 52330,
      token: TOKEN,
      lastHandshakeAt: 1_700_000_000_000
    })
  })
  const config = await readChannelConfig(PATH, fs, fixedToken())
  assert.deepStrictEqual(Object.keys(config).sort(), ['enabled', 'port', 'token'])
})

test('isValidChannelToken:只认 64 位小写 hex', () => {
  assert.equal(isValidChannelToken(TOKEN), true)
  assert.equal(isValidChannelToken('0123456789abcdef'.repeat(4)), true)
  assert.equal(isValidChannelToken(TOKEN.toUpperCase()), false)
  assert.equal(isValidChannelToken(`${TOKEN} `), false)
  assert.equal(isValidChannelToken(undefined), false)
  assert.equal(isValidChannelToken(123), false)
})
