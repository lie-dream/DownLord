/**
 * SettingsService 单元测试(Task 8 · spec §3.4 / plan Phase 2)。
 *
 * 注入内存 fake fs(不碰真实 FS / Electron),确定性验证:init 读盘 + 空 defaultDir 解析、
 * get 返回副本、set 合并校验 → 原子写 → onChange 联动回调被调用且带最新(clamp 后)值、损坏回退默认。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SettingsService } from './settingsService'
import { type SettingsStoreFs } from './settingsStore'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_COOKIE_CONFIG,
  DEFAULT_SUBTITLE_CHOICE,
  type AppSettings
} from '../../shared/ipc'

const CONFIG_PATH = '/userData/config/settings.json'
const SYS_DOWNLOADS = 'C:\\Users\\Test\\Downloads'

/** 内存 fake fs(注入式),模拟原子写(临时文件 → rename)与读;记录 rename 次数验证落盘 */
function createMemoryFs(seed: Record<string, string> = {}): SettingsStoreFs & {
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

/** 装配 SettingsService + 记录 onChange 调用 */
function createService(seed: Record<string, string> = {}): {
  service: SettingsService
  fs: ReturnType<typeof createMemoryFs>
  onChangeCalls: AppSettings[]
} {
  const fs = createMemoryFs(seed)
  const onChangeCalls: AppSettings[] = []
  const service = new SettingsService({
    store: fs,
    configPath: CONFIG_PATH,
    systemDownloadsDir: SYS_DOWNLOADS,
    onChange: (s) => onChangeCalls.push(s)
  })
  return { service, fs, onChangeCalls }
}

// ==================== init:读盘 + 空 defaultDir 解析 ====================

test('init 首启(无 settings.json):回退默认 + 空 defaultDir 解析为系统下载目录', async () => {
  const { service } = createService()
  await service.init()

  const s = service.get()
  assert.equal(s.defaultDir, SYS_DOWNLOADS, '空 defaultDir 解析为系统下载目录(spec §3.4)')
  assert.equal(s.maxConcurrent, DEFAULT_APP_SETTINGS.maxConcurrent)
  assert.equal(s.themeMode, DEFAULT_APP_SETTINGS.themeMode)
  assert.deepEqual(s.video, DEFAULT_APP_SETTINGS.video)
})

test('init 读到合法非默认配置:非空 defaultDir 原样保留(不覆盖为系统目录)', async () => {
  const stored: AppSettings = {
    defaultDir: 'E:\\Media',
    maxConcurrent: 6,
    maxOverallLimitKBps: 0,
    useAria2cForVideo: true,
    // 含 cookie / subtitle 默认(v0.2 Task 1):get() 经 mergeSettings 补全,往返 deepEqual 需齐备
    video: {
      defaultHeight: 1080,
      defaultAudioOnly: true,
      cookie: DEFAULT_COOKIE_CONFIG,
      subtitle: DEFAULT_SUBTITLE_CHOICE
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
  const { service } = createService({ [CONFIG_PATH]: JSON.stringify(stored) })
  await service.init()

  assert.deepEqual(service.get(), stored, '合法配置原样读回,defaultDir 非空不被系统目录覆盖')
})

test('init 读到损坏 JSON:回退默认 + 解析 defaultDir,不崩', async () => {
  const { service } = createService({ [CONFIG_PATH]: '{ not valid json ]' })
  await service.init()

  const s = service.get()
  assert.equal(s.defaultDir, SYS_DOWNLOADS, '损坏回退默认后空 defaultDir 仍解析')
  assert.equal(s.maxConcurrent, DEFAULT_APP_SETTINGS.maxConcurrent)
})

// ==================== get:返回副本 ====================

test('get 返回深副本:改返回值不污染内部缓存', async () => {
  const { service } = createService()
  await service.init()

  const a = service.get()
  a.maxConcurrent = 99
  a.video.defaultHeight = 4320

  const b = service.get()
  assert.notEqual(b.maxConcurrent, 99, '标量副本隔离')
  assert.notEqual(b.video.defaultHeight, 4320, '嵌套 video 副本隔离')
})

// ==================== set:合并校验 → 原子写 → onChange → 回最新全量 ====================

test('set:合并校验 → 原子写盘 → 返回最新全量,get 反映变更', async () => {
  const { service, fs } = createService()
  await service.init()

  const renamesBeforeSet = fs.renames // init 对缺失文件已修复重写一次,只测 set 的增量
  const returned = await service.set({ maxConcurrent: 5, themeMode: 'light' })

  assert.equal(returned.maxConcurrent, 5)
  assert.equal(returned.themeMode, 'light')
  assert.deepEqual(service.get(), returned, 'get 与 set 返回一致(往返)')
  assert.equal(fs.renames - renamesBeforeSet, 1, 'set 经原子 rename 落盘一次')

  const persisted = JSON.parse(fs.files.get(CONFIG_PATH)!)
  assert.equal(persisted.maxConcurrent, 5, '新值落盘')
  assert.equal(persisted.themeMode, 'light')
  assert.equal(
    persisted.defaultDir,
    SYS_DOWNLOADS,
    '首个 set 随 merged 持久化解析后的绝对路径(spec §3.4)'
  )
})

test('set 触发 onChange 一次,带 clamp 后最新全量', async () => {
  const { service, onChangeCalls } = createService()
  await service.init()

  const returned = await service.set({ maxConcurrent: 50 }) // 越界 → clamp 10

  assert.equal(onChangeCalls.length, 1, 'onChange 调用一次')
  assert.equal(onChangeCalls[0].maxConcurrent, 10, 'onChange 带 clamp 后值(非原始 50)')
  assert.equal(returned.maxConcurrent, 10, '返回值同样 clamp 到 10')
})

test('set 部分补丁:仅改指定字段,其余保持(merge 语义)', async () => {
  const { service } = createService()
  await service.init() // defaultDir=SYS_DOWNLOADS, maxConcurrent=3, themeMode=system

  await service.set({ video: { defaultHeight: 720, defaultAudioOnly: false } })

  const s = service.get()
  assert.equal(s.video.defaultHeight, 720, '指定字段更新')
  assert.equal(s.maxConcurrent, 3, '未改字段保持')
  assert.equal(s.defaultDir, SYS_DOWNLOADS, 'defaultDir 保持解析后的系统目录')
  assert.equal(s.themeMode, 'system')
})

test('set 非法字段被 mergeSettings 丢弃 / 归一(themeMode 非法回退当前值)', async () => {
  const { service } = createService()
  await service.init()

  // @ts-expect-error 故意传非法 themeMode 验证守卫
  const returned = await service.set({ themeMode: 'turbo', maxConcurrent: 0 })

  assert.equal(returned.themeMode, 'system', '非法 themeMode 回退当前值')
  assert.equal(returned.maxConcurrent, 1, 'maxConcurrent 0 → clamp 下限 1')
})

// 注:C2「改默认目录 → 专用回调同步分类目录」已移除(Task 8.5 Phase 1);
// 改默认目录的实时跟随由 resolveCategoryDir 按当前 defaultDir 实时解析(见 categorize.test.ts /
// settings.integration.test.ts H1),不再经 SettingsService 专用回调。

// ==================== 2026-07-11 审计修复:set 并发串行化 ====================

test('set 并发串行化:两个 set 同 tick 发起,两个补丁都生效(不丢更新 / 共享 tmp 不互撞)', async () => {
  const { service, fs } = createService()
  await service.init()

  // 修复前:B 在 A 的 await writeSettings 期间以未含 A 补丁的旧缓存 merge → A 的改动丢失;
  // 两次写还共享同一 `${path}.tmp`,交错 rename 时后者 source missing 直接抛
  const [, b] = await Promise.all([
    service.set({ maxConcurrent: 7 }),
    service.set({ themeMode: 'dark' })
  ])

  const final = service.get()
  assert.equal(final.maxConcurrent, 7, 'A 的补丁不被 B 覆盖回旧值')
  assert.equal(final.themeMode, 'dark', 'B 的补丁生效')
  assert.equal(b.maxConcurrent, 7, '后完成的 set 返回值含两个补丁(基于最新缓存 merge)')

  const onDisk = JSON.parse(fs.files.get(CONFIG_PATH)!) as {
    maxConcurrent: number
    themeMode: string
  }
  assert.equal(onDisk.maxConcurrent, 7, '落盘与内存一致')
  assert.equal(onDisk.themeMode, 'dark', '落盘与内存一致')
})

test('set 串行化:前一个 set 写盘失败不卡死后续 set(队尾吞错,错误仍抛给当次调用方)', async () => {
  const { service, fs } = createService()
  await service.init()

  const origWrite = fs.writeFile.bind(fs)
  let failOnce = true
  fs.writeFile = async (path: string, data: string) => {
    if (failOnce) {
      failOnce = false
      throw new Error('磁盘写失败')
    }
    return origWrite(path, data)
  }

  await assert.rejects(service.set({ maxConcurrent: 9 }), /磁盘写失败/, '失败照常抛给调用方')
  const after = await service.set({ maxConcurrent: 5 })
  assert.equal(after.maxConcurrent, 5, '后续 set 不被前一个失败卡死')
})

// ==================== v1.0 Task 3 · M-015:第三档 cookie 文件格式校验 ====================
// 🔴 校验必须在主进程(ARCHITECTURE §7.2)。渲染层只比「我要的路径 ≠ 回包里的路径」,
//   一个格式判断都不做。以下四条覆盖:拒收 / 收下 / 读不到放行 / 不顺带重读。

test('M-015 非 Netscape 格式的 cookie 文件 → 不落盘(file 置空,source 不动)', async () => {
  const { service, fs } = createService()
  await service.init()
  fs.files.set('/pics/cat.jpg', 'not a cookie file at all')

  const next = await service.set({
    video: { cookie: { source: 'file', browser: null, profile: null, file: '/pics/cat.jpg' } }
  })
  assert.equal(next.video.cookie?.file, null, '坏文件不落盘 —— 选错要当场知道,不拖到下载失败')
  // ★ source 是用户的意愿,不许顺手改掉;第三档 + 空路径本就是合法的「还没选文件」态
  assert.equal(next.video.cookie?.source, 'file')
  // 真实落盘的那份也不含该路径
  const persisted = JSON.parse(fs.files.get(CONFIG_PATH)!) as AppSettings
  assert.equal(persisted.video.cookie?.file, null)
})

test('M-015 真 Netscape cookies.txt → 照常落盘(上一条的正向对照)', async () => {
  const { service, fs } = createService()
  await service.init()
  fs.files.set(
    '/exports/cookies.txt',
    '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc\n'
  )

  const next = await service.set({
    video: { cookie: { source: 'file', browser: null, profile: null, file: '/exports/cookies.txt' } }
  })
  assert.equal(next.video.cookie?.file, '/exports/cookies.txt', '好文件必须收下')
})

test('M-015 读不到那个文件 → 放行(只否定能证明为假的)', async () => {
  const { service } = createService()
  await service.init()
  // 文件不在 fake fs 里 ⇒ readFile 抛 ENOENT。「读不到」既可能是路径错、也可能是 U 盘没插 /
  // 权限不足 —— 拿不准就不替用户下结论(下载时 COOKIE_FILE_INVALID 仍然兜底)。
  const next = await service.set({
    video: { cookie: { source: 'file', browser: null, profile: null, file: '/e/missing.txt' } }
  })
  assert.equal(next.video.cookie?.file, '/e/missing.txt')
})

test('M-015 改别的设置不顺带去读一遍 cookie 文件(只在文件真换了时读盘)', async () => {
  const { service, fs } = createService()
  await service.init()
  fs.files.set(
    '/exports/cookies.txt',
    '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\ta\tb\n'
  )
  await service.set({
    video: { cookie: { source: 'file', browser: null, profile: null, file: '/exports/cookies.txt' } }
  })

  // 之后把该文件内容换成垃圾:再改一个**无关**设置时不该重读、更不该把已落盘的路径清掉
  fs.files.set('/exports/cookies.txt', 'garbage')
  const next = await service.set({ maxConcurrent: 5 })
  assert.equal(next.video.cookie?.file, '/exports/cookies.txt', '无关改动不触发重校验')
  assert.equal(next.maxConcurrent, 5)
})
