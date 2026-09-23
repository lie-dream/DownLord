/**
 * 自动更新体系 集成测试 — v0.2 Task 6 Phase 4(spec §7.2 / plan Phase 4)。
 *
 * 在各 `*.test.ts`(注入内存 fake 的纯单测)之上补真实集成,仿 settings.integration.test.ts:
 * 真实 node `fs` 落盘 + 真实 `updateStateStore`(nodeUpdateStateStoreFs)+ 注入 fake 网络端到端。
 *
 * 【Section A — yt-dlp 热更新端到端(注入 fake HTTP,真实 FS 替换)】
 *   A1 空闲替换:fake HTTP 写真实临时文件 → 三重校验(size / SHA256 / --version==tag)→ 原子 rename
 *      覆盖可写副本;副本字节 = 下载内容 + size ≥ 阈值 + `resolveYtDlpPath` 指向它;`ensureWritableYtDlp`
 *      随后 `skipped`(占位检测不倒退,§8)。
 *   A2 占用降级:hasActiveYtDlp=true → 生成 `.pending`、旧副本不动(不 kill,§7.1);重启模拟调
 *      `applyPendingYtDlp` → 覆盖生效 + pending 清除。
 *
 * 【Section B — settings 两开关真实往返(nodeSettingsStoreFs 落盘)】
 *   B1 autoUpdateYtDlp / autoUpdateApp 写盘 → 新实例读回一致;
 *   B2 旧无该字段的 settings.json → mergeSettings 补默认 true(向后兼容零迁移)。
 *
 * 真实网络下载 / 真实 GitHub / electron-updater 发布依赖归手测(spec §7.3),此处只注入 fake 网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { YtdlpUpdater, type UpdaterFs } from './ytdlpUpdater'
import { applyPendingYtDlp } from './applyPendingYtDlp'
import { downloadYtDlpPath, pendingYtDlpPath } from './paths'
import { computeSha256, YTDLP_ASSET_NAME } from './ytdlpUpdate'
import { createUpdateStateStore } from './updateStateStore'
import { nodeUpdateStateStoreFs } from './nodeUpdateStateStoreFs'
import type { UpdateHttpClient, DownloadProgress } from './updateHttp'
import { MIN_VALID_YTDLP_BYTES } from '../binaries/ensureWritable'
import { ensureWritableYtDlp } from '../binaries/ensureWritable'
import { resolveYtDlpPath, userWritableYtDlpPath } from '../binaries/locator'
import { SettingsService } from '../settings/settingsService'
import { nodeSettingsStoreFs } from '../settings/nodeSettingsStoreFs'
import type { ProxyResolved, UpdateStatus } from '../../shared/ipc'

// ==================== 样本 ====================

const TAG = '2026.06.10'
const CURRENT = '2026.06.09'
// 新版本 exe 字节(≥ 1MB 阈值,过 size 下限);旧副本用不同字节,便于验证「未被覆盖」/「已覆盖」
const NEW_BYTES = Buffer.alloc(1_100_000, 0xab)
const OLD_BYTES = Buffer.alloc(1_050_000, 0xcd)
const NEW_HASH = computeSha256(NEW_BYTES)
const SUMS = `${NEW_HASH}  ${YTDLP_ASSET_NAME}\n${'0'.repeat(64)}  yt-dlp\n`

function releaseJson(tag: string): unknown {
  return {
    tag_name: tag,
    assets: [
      {
        name: YTDLP_ASSET_NAME,
        browser_download_url: 'https://x/yt-dlp.exe',
        size: NEW_BYTES.length
      },
      { name: 'SHA2-256SUMS', browser_download_url: 'https://x/SHA2-256SUMS', size: SUMS.length }
    ]
  }
}

/** 注入 fake HTTP:downloadToFile 真实写入 NEW_BYTES 到 dest(供真实 FS 校验 / 替换) */
function createFakeHttp(): UpdateHttpClient {
  return {
    async configureProxy(): Promise<void> {
      /* fake HTTP:不真连网,代理配置无副作用 */
    },
    async getJson(): Promise<unknown> {
      return releaseJson(TAG)
    },
    async getText(): Promise<string> {
      return SUMS
    },
    async downloadToFile(
      _url: string,
      dest: string,
      onProgress?: (p: DownloadProgress) => void
    ): Promise<void> {
      fs.writeFileSync(dest, NEW_BYTES)
      onProgress?.({ received: NEW_BYTES.length, total: NEW_BYTES.length })
    }
  }
}

/** 真实 node fs 背书的 UpdaterFs(集成:不注入内存 fake,走真实磁盘) */
const nodeUpdaterFs: UpdaterFs = {
  statSync: (p) => fs.statSync(p),
  readFile: (p) => fs.promises.readFile(p),
  rename: (o, n) => fs.promises.rename(o, n),
  unlink: (p) => fs.promises.unlink(p)
}

/** captureVersionOutput 兼容的 fake spawn:回吐 `--version` 输出后 close(避免起真实子进程) */
function fakeSpawn(versionOutput: string): typeof import('child_process').spawn {
  return ((..._args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = (): void => {}
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(versionOutput))
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof import('child_process').spawn
}

const DIRECT_PROXY: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-update-'))
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort:Windows 句柄偶发占用,忽略
  }
}

/** 起一套真实 FS 的 YtdlpUpdater(可写副本落 <userData>/bin/yt-dlp.exe,同 index 装配) */
function startUpdater(
  userDataDir: string,
  opts: { hasActiveYtDlp?: boolean } = {}
): { updater: YtdlpUpdater; statuses: UpdateStatus[]; writablePath: string } {
  const writablePath = userWritableYtDlpPath(userDataDir)
  fs.mkdirSync(path.dirname(writablePath), { recursive: true })
  const statuses: UpdateStatus[] = []
  const stateStore = createUpdateStateStore(
    path.join(userDataDir, 'config', 'updateState.json'),
    nodeUpdateStateStoreFs
  )
  const updater = new YtdlpUpdater({
    http: createFakeHttp(),
    fs: nodeUpdaterFs,
    spawn: fakeSpawn(`${TAG}\n`),
    getProxy: () => DIRECT_PROXY,
    getCurrentVersion: () => CURRENT,
    hasActiveYtDlp: () => opts.hasActiveYtDlp ?? false,
    writableYtDlpPath: writablePath,
    stateStore,
    onStatus: (s) => statuses.push(s),
    probeTimeoutMs: 1000
  })
  return { updater, statuses, writablePath }
}

// ==================== Section A:yt-dlp 热更新端到端 ====================

test('A1 空闲替换:三重校验通过 → 原子覆盖可写副本;resolveYtDlpPath 指向它;ensureWritable 随后 skipped', async () => {
  const dir = makeTempDir()
  try {
    const { updater, statuses, writablePath } = startUpdater(dir, { hasActiveYtDlp: false })
    await updater.run()

    // 可写副本 = 下载内容(原子替换),size ≥ 阈值(占位检测下限)
    assert.ok(fs.existsSync(writablePath), '可写副本已就位')
    assert.deepEqual(fs.readFileSync(writablePath), NEW_BYTES, '副本字节 = 下载内容')
    assert.ok(
      fs.statSync(writablePath).size >= MIN_VALID_YTDLP_BYTES,
      'size ≥ MIN_VALID_YTDLP_BYTES'
    )

    // 临时文件已清理(rename 消耗),无 .download / .pending 残留
    assert.equal(
      fs.existsSync(downloadYtDlpPath(writablePath)),
      false,
      '.download 已被 rename 消耗'
    )
    assert.equal(fs.existsSync(pendingYtDlpPath(writablePath)), false, '空闲路径无 .pending')

    // applied 阶段广播 + 诚实 message
    const applied = statuses.find((s) => s.phase === 'applied')
    assert.ok(applied, 'applied 阶段已广播')
    assert.match(applied?.message ?? '', /2026\.06\.10/)

    // resolveYtDlpPath 优先返回可写副本(§7.5 独立热更新落点)
    const resolved = resolveYtDlpPath({
      binDir: path.join(dir, 'bundled'),
      userDataDir: dir,
      existsSync: fs.existsSync
    })
    assert.equal(resolved, writablePath, 'resolveYtDlpPath 指向可写副本')

    // ensureWritableYtDlp 见有效副本 → skipped(占位检测语义不倒退,§8;不以「等于内置大小」判定)
    const ensured = ensureWritableYtDlp({ binDir: path.join(dir, 'bundled'), userDataDir: dir })
    assert.equal(ensured.action, 'skipped', '有效副本 → skipped(尊重热更新版本)')
  } finally {
    cleanup(dir)
  }
})

test('A2 占用降级:hasActiveYtDlp=true → 生成 .pending、旧副本不动;applyPendingYtDlp 重启模拟覆盖生效', async () => {
  const dir = makeTempDir()
  try {
    const { updater, statuses, writablePath } = startUpdater(dir, { hasActiveYtDlp: true })
    // 预置旧的有效副本(视频任务正占用中,不可 kill)
    fs.writeFileSync(writablePath, OLD_BYTES)

    await updater.run()

    // 降级 pending:新字节暂存 .pending;旧副本原样不动(§7.1 不杀进程)
    const pendingPath = pendingYtDlpPath(writablePath)
    assert.ok(fs.existsSync(pendingPath), '生成 .pending(占用降级)')
    assert.deepEqual(fs.readFileSync(pendingPath), NEW_BYTES, '.pending = 新版本字节')
    assert.deepEqual(fs.readFileSync(writablePath), OLD_BYTES, '旧副本不动(运行中任务不受影响)')
    assert.ok(
      statuses.some((s) => s.phase === 'pending-restart'),
      'pending-restart 阶段已广播'
    )

    // 重启模拟:applyPendingYtDlp(此时无进程占用)→ 覆盖生效 + pending 清除
    const result = applyPendingYtDlp({ ytdlpPath: writablePath })
    assert.equal(result.action, 'applied', '重启期 pending 有效 → applied')
    assert.deepEqual(fs.readFileSync(writablePath), NEW_BYTES, '重启后副本 = 新版本(生效)')
    assert.equal(fs.existsSync(pendingPath), false, 'pending 已清除')
  } finally {
    cleanup(dir)
  }
})

// ==================== Section B:settings 两开关真实往返 ====================

function makeConfigPath(dir: string): string {
  return path.join(dir, 'config', 'settings.json')
}

test('B1 autoUpdateYtDlp / autoUpdateApp 写盘 → 新实例读回一致(真实 settings.json 落盘)', async () => {
  const dir = makeTempDir()
  const configPath = makeConfigPath(dir)
  try {
    const s1 = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await s1.init()
    await s1.set({ autoUpdateYtDlp: false, autoUpdateApp: false })

    // 全新实例读同一 settings.json(模拟应用重启)
    const s2 = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await s2.init()
    const restored = s2.get()
    assert.equal(restored.autoUpdateYtDlp, false, 'autoUpdateYtDlp 跨会话保持')
    assert.equal(restored.autoUpdateApp, false, 'autoUpdateApp 跨会话保持')

    // 真实落盘验证
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    assert.equal(persisted.autoUpdateYtDlp, false, 'autoUpdateYtDlp 真实落盘')
    assert.equal(persisted.autoUpdateApp, false, 'autoUpdateApp 真实落盘')
  } finally {
    cleanup(dir)
  }
})

test('B2 旧无该字段的 settings.json → mergeSettings 补默认 true(向后兼容零迁移)', async () => {
  const dir = makeTempDir()
  const configPath = makeConfigPath(dir)
  try {
    // 写入 Task 6 之前形态的 settings.json(缺 autoUpdateYtDlp / autoUpdateApp)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultDir: 'D:\\DL',
        maxConcurrent: 3,
        maxOverallLimitKBps: 0,
        useAria2cForVideo: true,
        video: { defaultHeight: null, defaultAudioOnly: false },
        themeMode: 'system',
        clipboardWatch: false
      }),
      'utf-8'
    )

    const service = new SettingsService({
      store: nodeSettingsStoreFs,
      configPath,
      systemDownloadsDir: dir,
      onChange: () => {}
    })
    await service.init()
    const s = service.get()
    assert.equal(s.autoUpdateYtDlp, true, '旧文件缺字段 → 补默认 true')
    assert.equal(s.autoUpdateApp, true, '旧文件缺字段 → 补默认 true')
  } finally {
    cleanup(dir)
  }
})
