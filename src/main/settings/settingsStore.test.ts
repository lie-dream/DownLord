import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readSettings, writeSettings, type SettingsStoreFs } from './settingsStore'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_COOKIE_CONFIG,
  DEFAULT_SUBTITLE_CHOICE,
  type AppSettings
} from '../../shared/ipc'

/** 内存 fake fs(注入式),模拟原子写(临时文件 → rename)与读 */
function createMemoryFs(seed: Record<string, string> = {}): SettingsStoreFs & {
  files: Map<string, string>
  renames: number
  writes: string[]
} {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    renames: 0,
    writes: [],
    async readFile(path: string): Promise<string> {
      if (!files.has(path)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return files.get(path)!
    },
    async writeFile(path: string, data: string): Promise<void> {
      this.writes.push(path)
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

const PATH = '/userData/config/settings.json'

// ==================== 往返一致(spec §3.1)====================

test('writeSettings 原子写(临时文件 → rename)后 readSettings 往返一致', async () => {
  const fs = createMemoryFs()
  const settings: AppSettings = {
    defaultDir: 'D:/Downloads',
    maxConcurrent: 6,
    maxOverallLimitKBps: 0,
    useAria2cForVideo: true,
    // 含 cookie / subtitle(v0.2 Task 1):完整 video 往返一致(langs 已归一,无去重差异)
    video: {
      defaultHeight: 1080,
      defaultAudioOnly: true,
      cookie: { source: 'browser', browser: 'firefox', profile: null, file: null },
      subtitle: { langs: ['zh-Hans'], format: 'srt', includeAuto: true }
    },
    themeMode: 'dark',
    clipboardWatch: false,
    autoUpdateYtDlp: true,
    autoUpdateApp: true,
    btSeedEnabled: false,
    btSeedRatio: 1.0,
    btSeedTimeMin: 60,
    btMaxPeers: 0,
    btAutoUpdateTrackers: true
  }
  await writeSettings(PATH, settings, fs)

  assert.equal(fs.renames, 1, '应经临时文件 rename 落盘(原子写)')
  assert.equal(fs.files.has(`${PATH}.tmp`), false, '临时文件应已 rename 消失')

  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, settings)
})

test('writeSettings 写顺序:先写 .tmp 再 rename(原子写顺序)', async () => {
  const fs = createMemoryFs()
  await writeSettings(PATH, DEFAULT_APP_SETTINGS, fs)
  assert.deepEqual(fs.writes, [`${PATH}.tmp`], '应只向 .tmp 写,正式文件由 rename 产生')
})

// ==================== 缺失 → 回退默认并修复 ====================

test('readSettings 文件缺失 → 回退 DEFAULT_APP_SETTINGS 并重写修复', async () => {
  const fs = createMemoryFs()
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, DEFAULT_APP_SETTINGS)
  // 修复:重写出默认配置文件
  assert.equal(fs.files.has(PATH), true)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_APP_SETTINGS)
})

// ==================== JSON 损坏 / 结构非法 → 回退默认并修复 ====================

test('readSettings JSON 损坏 → 回退默认并重写修复', async () => {
  const fs = createMemoryFs({ [PATH]: '{ not valid json ]' })
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, DEFAULT_APP_SETTINGS)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_APP_SETTINGS)
})

test('readSettings 结构非法(缺字段 / 类型错 / 未知 themeMode)→ 回退默认并修复', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({ defaultDir: 123, maxConcurrent: 'x', themeMode: 'turbo' })
  })
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, DEFAULT_APP_SETTINGS)
  assert.deepEqual(JSON.parse(fs.files.get(PATH)!), DEFAULT_APP_SETTINGS)
})

test('readSettings video 结构非法(defaultAudioOnly 非布尔)→ 回退默认并修复', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({
      defaultDir: '',
      maxConcurrent: 3,
      themeMode: 'system',
      video: { defaultHeight: null, defaultAudioOnly: 'yes' }
    })
  })
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, DEFAULT_APP_SETTINGS)
})

// ==================== 合法配置 → 原样读回 ====================

test('readSettings 合法非默认配置 → 原样读回(不被误判损坏 / 不重写)', async () => {
  const settings: AppSettings = {
    defaultDir: 'E:/Media',
    maxConcurrent: 8,
    maxOverallLimitKBps: 0,
    useAria2cForVideo: true,
    video: {
      defaultHeight: 720,
      defaultAudioOnly: false,
      cookie: DEFAULT_COOKIE_CONFIG,
      subtitle: DEFAULT_SUBTITLE_CHOICE
    },
    themeMode: 'light',
    clipboardWatch: false,
    autoUpdateYtDlp: true,
    autoUpdateApp: true,
    btSeedEnabled: false,
    btSeedRatio: 1.0,
    btSeedTimeMin: 60,
    btMaxPeers: 0,
    btAutoUpdateTrackers: true
  }
  const fs = createMemoryFs({ [PATH]: JSON.stringify(settings) })
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, settings)
  assert.equal(fs.renames, 0, '合法即不触发修复重写')
})

test('readSettings 旧 settings.json 无 cookie/subtitle → 经 mergeSettings 补全默认(§4.4 零迁移)', async () => {
  // 模拟 v0.1 落盘的旧文件:video 仅两必填字段,无 cookie / subtitle(shape 仍合法)
  const old = {
    defaultDir: 'D:/Old',
    maxConcurrent: 4,
    themeMode: 'light',
    video: { defaultHeight: 1080, defaultAudioOnly: false }
  }
  const fs = createMemoryFs({ [PATH]: JSON.stringify(old) })
  const read = await readSettings(PATH, fs)

  // 旧两字段保留
  assert.equal(read.video.defaultHeight, 1080)
  assert.equal(read.video.defaultAudioOnly, false)
  // 新字段自动补全为默认(零迁移:无需 schema_version / 迁移代码)
  assert.deepEqual(read.video.cookie, DEFAULT_COOKIE_CONFIG, 'cookie 补全默认 none')
  assert.deepEqual(read.video.subtitle, DEFAULT_SUBTITLE_CHOICE, 'subtitle 补全默认空')
  // 旧文件结构合法(cookie/subtitle 可选、shape 不查)→ 不触发损坏回退重写
  assert.equal(fs.renames, 0, '旧文件不算损坏,不整体回退')
})

test('readSettings 结构合法但字段越界 → mergeSettings 归一(不整体回退)', async () => {
  const fs = createMemoryFs({
    [PATH]: JSON.stringify({
      defaultDir: 'D:/x',
      maxConcurrent: 50, // 越界 → clamp 10
      themeMode: 'dark',
      video: { defaultHeight: 360, defaultAudioOnly: true } // 360 非白名单 → null
    })
  })
  const read = await readSettings(PATH, fs)
  assert.equal(read.maxConcurrent, 10, '越界 clamp 到 10')
  assert.equal(read.video.defaultHeight, null, '非白名单清晰度归一为 null')
  assert.equal(read.video.defaultAudioOnly, true)
  assert.equal(read.defaultDir, 'D:/x')
  assert.equal(read.themeMode, 'dark')
  assert.equal(fs.renames, 0, '字段越界不算损坏,不整体回退重写')
})

// ==================== 修复写失败不崩 ====================

test('readSettings 损坏 + 修复写失败 → 仍返回默认值不抛', async () => {
  const fs = createMemoryFs({ [PATH]: 'broken' })
  // 让写盘恒失败(模拟目录只读)
  fs.writeFile = async (): Promise<void> => {
    throw new Error('EACCES: read-only')
  }
  const read = await readSettings(PATH, fs)
  assert.deepEqual(read, DEFAULT_APP_SETTINGS, '修复写失败仍返回默认值,不崩')
})
