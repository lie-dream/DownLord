/**
 * 接管配置 store 单测(v0.4 Task 4 · spec §5.1 · plan 4.1)。
 *
 * 落盘经**注入的内存 fake fs**(仿 `btTrackerStore.test.ts` / `channelConfig.test.ts`),
 * 本文件不碰真实文件系统。
 *
 * ★ 本文件承载 **I-08 的纯函数半**:落盘 JSON 的**键集合恰好三个**。
 *   (I-08 的端到端半在 `takeover.integration.test.ts`,走真服务的 `setPause` 写盘路径。)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JsonConfigStoreFs } from '../config/jsonConfigStore'
import {
  DEFAULT_TAKEOVER_CONFIG,
  cloneDefaultTakeoverConfig,
  createTakeoverConfigStore,
  isTakeoverConfigShape,
  normalizeDomain,
  normalizeDomainList,
  normalizeTakeoverConfig
} from './takeoverConfig'

const PATH = 'C:/userData/config/takeover.json'

/** 内存 fake fs:记录每次写入,便于断言原子写顺序与落盘内容 */
function memFs(seed: Record<string, string> = {}): {
  fs: JsonConfigStoreFs
  files: Map<string, string>
} {
  const files = new Map<string, string>(Object.entries(seed))
  const fs: JsonConfigStoreFs = {
    readFile: async (p) => {
      const v = files.get(p)
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return v
    },
    writeFile: async (p, d) => void files.set(p, d),
    rename: async (from, to) => {
      files.set(to, files.get(from) as string)
      files.delete(from)
    },
    mkdir: async () => {}
  }
  return { fs, files }
}

// ── 默认值与副本 ────────────────────────────────────────────────────────

test('默认值:接管开着(装了扩展即视为授权)、未暂停、空例外表', () => {
  assert.deepStrictEqual(DEFAULT_TAKEOVER_CONFIG, {
    enabled: true,
    pausedUntil: null,
    excludedDomains: []
  })
})

test('★ cloneDefaults 每次新建数组 —— mutate 副本绝不污染全局常量(btTrackerStore 踩过的坑)', () => {
  const a = cloneDefaultTakeoverConfig()
  const b = cloneDefaultTakeoverConfig()
  assert.notEqual(a.excludedDomains, b.excludedDomains, '两次调用必须是两个不同的数组实例')
  a.excludedDomains.push('evil.com')
  assert.deepStrictEqual(DEFAULT_TAKEOVER_CONFIG.excludedDomains, [], '全局常量不得被污染')
  assert.deepStrictEqual(b.excludedDomains, [])
})

// ── 域名归一 ────────────────────────────────────────────────────────────

test('normalizeDomain:去协议 / 去路径 / 去查询 / 去端口 / 去尾点 / 转小写', () => {
  assert.equal(normalizeDomain('  EXAMPLE.com  '), 'example.com')
  assert.equal(normalizeDomain('https://dl.example.com/x.zip?t=1'), 'dl.example.com')
  assert.equal(normalizeDomain('http://Example.COM:8080/path'), 'example.com')
  assert.equal(normalizeDomain('example.com.'), 'example.com')
  assert.equal(normalizeDomain('user:pass@example.com'), 'example.com')
})

test('normalizeDomain:归一不出东西 → 空串(由调用方丢弃,不落一条空规则)', () => {
  assert.equal(normalizeDomain(''), '')
  assert.equal(normalizeDomain('   '), '')
  assert.equal(normalizeDomain('https://'), '')
  assert.equal(normalizeDomain('/just/a/path'), '')
})

test('normalizeDomainList:逐条归一 + 丢空 + **保序**去重(用户添加的顺序就是他心里的顺序)', () => {
  assert.deepStrictEqual(
    normalizeDomainList(['B.com', 'https://a.com/x', '', 'b.COM', '  ', 'c.com']),
    ['b.com', 'a.com', 'c.com']
  )
})

// ── 结构守卫与归一 ──────────────────────────────────────────────────────

test('isTakeoverConfigShape:三字段齐备且类型正确才算合法结构', () => {
  assert.equal(isTakeoverConfigShape({ enabled: true, pausedUntil: null, excludedDomains: [] }), true)
  assert.equal(isTakeoverConfigShape({ enabled: true, pausedUntil: 1, excludedDomains: [] }), true)
  assert.equal(isTakeoverConfigShape(null), false)
  assert.equal(isTakeoverConfigShape({ pausedUntil: null, excludedDomains: [] }), false)
  assert.equal(isTakeoverConfigShape({ enabled: 'yes', pausedUntil: null, excludedDomains: [] }), false)
  assert.equal(isTakeoverConfigShape({ enabled: true, pausedUntil: '1', excludedDomains: [] }), false)
  assert.equal(isTakeoverConfigShape({ enabled: true, pausedUntil: null, excludedDomains: [1] }), false)
})

test('normalize:pausedUntil 非有限数(NaN / Infinity)回落 null', () => {
  assert.equal(
    normalizeTakeoverConfig({ enabled: true, pausedUntil: Number.NaN, excludedDomains: [] })
      .pausedUntil,
    null
  )
  assert.equal(
    normalizeTakeoverConfig({
      enabled: true,
      pausedUntil: Number.POSITIVE_INFINITY,
      excludedDomains: []
    }).pausedUntil,
    null
  )
})

test('normalize:只取三个显式字段 —— 手改文件里多出来的键当场丢掉', () => {
  const parsed = {
    enabled: false,
    pausedUntil: 123,
    excludedDomains: ['A.com'],
    // 手改 / 旧版本残留 / 有人顺手塞的东西
    headers: { Cookie: 'leak' },
    linkState: 'connected'
  } as unknown as Parameters<typeof normalizeTakeoverConfig>[0]
  assert.deepStrictEqual(normalizeTakeoverConfig(parsed), {
    enabled: false,
    pausedUntil: 123,
    excludedDomains: ['a.com']
  })
})

// ── store 读写 ──────────────────────────────────────────────────────────

test('读:文件缺失 → 回退默认值', async () => {
  const { fs } = memFs()
  const store = createTakeoverConfigStore(PATH, fs)
  assert.deepStrictEqual(await store.read(), DEFAULT_TAKEOVER_CONFIG)
})

test('★ repairOnInvalid:true —— 用户配置损坏时**回写默认修复**(与派生缓存 btTrackerStore 相反)', async () => {
  const { fs, files } = memFs({ [PATH]: '{ 这不是 json' })
  const store = createTakeoverConfigStore(PATH, fs)
  assert.deepStrictEqual(await store.read(), DEFAULT_TAKEOVER_CONFIG)
  assert.deepStrictEqual(JSON.parse(files.get(PATH) as string), DEFAULT_TAKEOVER_CONFIG)
})

test('读:结构合法 → 经 normalize 归一(域名小写去重),且**不触发修复重写**', async () => {
  const raw = JSON.stringify({
    enabled: false,
    pausedUntil: 999,
    excludedDomains: ['Example.COM', 'example.com', 'https://b.com/x']
  })
  const { fs, files } = memFs({ [PATH]: raw })
  const store = createTakeoverConfigStore(PATH, fs)
  assert.deepStrictEqual(await store.read(), {
    enabled: false,
    pausedUntil: 999,
    excludedDomains: ['example.com', 'b.com']
  })
  assert.equal(files.get(PATH), raw, '合法结构不得被重写')
})

test('★ I-08(纯函数半)落盘 JSON 的键集合**恰好三个** —— 防日后有人顺手塞进连接态 / headers', async () => {
  const { fs, files } = memFs()
  const store = createTakeoverConfigStore(PATH, fs)
  await store.write({ enabled: true, pausedUntil: 1_700_000_000_000, excludedDomains: ['a.com'] })
  const onDisk = JSON.parse(files.get(PATH) as string) as Record<string, unknown>
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['enabled', 'excludedDomains', 'pausedUntil'])
})

test('写:原子写(先 tmp 再 rename)—— 落盘后不留 .tmp 残留', async () => {
  const { fs, files } = memFs()
  const store = createTakeoverConfigStore(PATH, fs)
  await store.write(cloneDefaultTakeoverConfig())
  assert.equal(files.has(`${PATH}.tmp`), false)
  assert.equal(files.has(PATH), true)
})
