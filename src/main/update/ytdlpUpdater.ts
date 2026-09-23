/**
 * yt-dlp 独立热更新编排服务(v0.2 Task 6 · spec §2;ARCHITECTURE §7.1 / §7.2 / §7.5)。
 *
 * 依赖**全注入**(http / fs / spawn / getProxy / getCurrentVersion / hasActiveYtDlp / 路径 /
 * stateStore / onStatus),核心比对 / 校验为纯函数(`ytdlpUpdate.ts`),单测不碰真实网络 / FS / 进程。
 *
 * 红线(逐条守住):
 * - **§7.5 只动可写副本**:替换目标 = `writableYtDlpPath`(`<userData>/bin/yt-dlp.exe`)+ 同目录
 *   `.download` / `.pending`,**绝不触碰内置 `resources/bin/`**。
 * - **占位检测不倒退**:校验下限用 `MIN_VALID_YTDLP_BYTES`(< 1MB 判占位),**绝不以「等于内置大小」判定**。
 * - **原子 + 失败保留旧版**:下载→临时→三重校验→`rename` 覆盖;任一步失败清理临时、旧版原样不动。
 * - **不破坏运行中任务(§7.1)**:目标被占用(`hasActiveYtDlp` 或 rename EBUSY/EPERM)→ 降级 `.pending`
 *   下次启动生效,**绝不 kill 运行中 yt-dlp 进程**。
 * - **走代理**:检查 + 下载前 `configureProxy(getProxy().effectiveUrl)`(不承诺翻墙)。
 */
import type { ProxyResolved, UpdateCheckResult, UpdateStatus } from '../../shared/ipc'
import {
  computeSha256,
  needsYtDlpUpdate,
  parseLatestRelease,
  parseSha256Sums,
  selectAsset,
  selectSumsAsset,
  YTDLP_ASSET_NAME,
  YTDLP_LATEST_RELEASE_URL,
  type ParsedRelease
} from './ytdlpUpdate'
import { downloadYtDlpPath, pendingYtDlpPath } from './paths'
import type { UpdateHttpClient } from './updateHttp'
import type { UpdateStateStore } from './updateStateStore'
import { shouldCheckNow as isThrottleElapsed } from './updateStateStore'
import { MIN_VALID_YTDLP_BYTES } from '../binaries/ensureWritable'
import {
  captureVersionOutput,
  parseYtDlpVersion,
  DEFAULT_PROBE_TIMEOUT_MS
} from '../binaries/probeVersion'
import { UpdateError, mapUpdateError } from '../errors/mapError'
import { toReadable } from '../errors/errorCatalog'

/** 编排所需的注入式 fs 面(异步;单测注入内存 fake) */
export interface UpdaterFs {
  statSync(path: string): { size: number }
  readFile(path: string): Promise<Buffer>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface YtdlpUpdaterDeps {
  /** 更新 HTTP 客户端(getJson / getText / downloadToFile / configureProxy) */
  http: UpdateHttpClient
  /** 注入式 fs(校验 size / 读文件算 sha / rename 替换 / unlink 清理) */
  fs: UpdaterFs
  /** 起子进程做 `--version` 可执行性验证(复用 captureVersionOutput) */
  spawn: typeof import('child_process').spawn
  /** 当前代理解析态(实时读,切档即时生效;经 effectiveUrl 注入 http.configureProxy) */
  getProxy: () => ProxyResolved
  /** 当前 yt-dlp 版本(启动已探测的 engineVersionsCache.ytdlp) */
  getCurrentVersion: () => string
  /** 是否有视频任务正占用 yt-dlp(占用则替换降级 pending,不杀进程) */
  hasActiveYtDlp: () => boolean
  /** yt-dlp 可写副本绝对路径(替换目标;`.download` / `.pending` 由此派生同目录) */
  writableYtDlpPath: string
  /** 节流缓存门面(读写 lastYtDlpCheckAt / lastYtDlpLatest) */
  stateStore: UpdateStateStore
  /** 状态 / 进度回调(Phase 1 占位空实现,Phase 3 接 broadcastUpdateStatus) */
  onStatus: (status: UpdateStatus) => void
  /**
   * 替换**真正生效**(applied,rename 覆盖成功;非 pending)后回调新版本号。
   * 供刷新「当前版本」数据源(`engineVersionsCache.ytdlp`)——否则下次 `check` 仍读旧版 →
   * `needsYtDlpUpdate` 恒为 true → **重复下载同一版本**(U4 真机 bug 修复)。新版本经三重校验
   * `--version == tag` 已确认,故直接回传 tag 即当前真实版本,无需再 spawn 探测。
   */
  onApplied?: (version: string) => void
  /** 当前时间(默认 `Date.now`;单测注入固定值) */
  now?: () => number
  /** `--version` 探测超时(默认 `DEFAULT_PROBE_TIMEOUT_MS`) */
  probeTimeoutMs?: number
}

export class YtdlpUpdater {
  private readonly now: () => number
  private readonly probeTimeoutMs: number

  constructor(private readonly deps: YtdlpUpdaterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  }

  /** 后台自动检查节流判定(spec §2.5):距上次检查 ≥ 24h → true;读缓存失败保守 → true。 */
  async shouldCheckNow(): Promise<boolean> {
    try {
      const state = await this.deps.stateStore.read()
      return isThrottleElapsed(state.lastYtDlpCheckAt, this.now())
    } catch {
      return true
    }
  }

  /**
   * 仅检查(无视节流,供手动「检查 yt-dlp 更新」)。走代理 → 查 latest → 版本比对 → 写节流缓存。
   * 网络 / 解析失败诚实回退(latestVersion=null + error),不抛。
   */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = this.deps.getCurrentVersion()
    this.deps.onStatus({ target: 'ytdlp', phase: 'checking', currentVersion })
    try {
      const release = await this.fetchLatestRelease()
      const latestVersion = release.tag
      const hasUpdate = needsYtDlpUpdate(currentVersion, latestVersion)
      await this.recordCheck(latestVersion)
      this.deps.onStatus({
        target: 'ytdlp',
        phase: hasUpdate ? 'available' : 'up-to-date',
        currentVersion,
        latestVersion
      })
      return { target: 'ytdlp', currentVersion, latestVersion, hasUpdate }
    } catch (err) {
      const readable = toReadable(mapUpdateError(err))
      console.warn('[YtdlpUpdater] 检查更新失败(诚实回退,保留旧版):', err)
      this.deps.onStatus({ target: 'ytdlp', phase: 'error', currentVersion, error: readable })
      return {
        target: 'ytdlp',
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        error: readable
      }
    }
  }

  /**
   * 检查 + 有更新则下载 / 校验 / 替换(自动路径由 index 门控节流 + 开关调用)。
   * 三重校验(size / SHA256 / `--version`==tag)全过才替换;任一步失败清理临时 + 保留旧版。
   */
  async run(): Promise<void> {
    const currentVersion = this.deps.getCurrentVersion()
    const downloadPath = downloadYtDlpPath(this.deps.writableYtDlpPath)
    try {
      this.deps.onStatus({ target: 'ytdlp', phase: 'checking', currentVersion })
      const release = await this.fetchLatestRelease()
      const latestVersion = release.tag
      await this.recordCheck(latestVersion)

      if (!needsYtDlpUpdate(currentVersion, latestVersion)) {
        this.deps.onStatus({ target: 'ytdlp', phase: 'up-to-date', currentVersion, latestVersion })
        return
      }

      const asset = selectAsset(release.assets, YTDLP_ASSET_NAME)
      const sumsAsset = selectSumsAsset(release.assets)
      if (!asset || !sumsAsset) {
        // 默认要求 SHA256(安全优先,§2.3):缺资产 / 缺 sums 即中止,保留旧版
        throw new UpdateError('verify', '缺少 yt-dlp.exe 或 SHA2-256SUMS 资产')
      }

      // 下载到同目录临时文件(保证 rename 同卷原子)
      this.deps.onStatus({
        target: 'ytdlp',
        phase: 'downloading',
        percent: 0,
        currentVersion,
        latestVersion
      })
      await this.deps.http.downloadToFile(asset.url, downloadPath, ({ received, total }) => {
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined
        this.deps.onStatus({
          target: 'ytdlp',
          phase: 'downloading',
          percent,
          currentVersion,
          latestVersion
        })
      })

      // 三重校验:size ≥ 阈值 / SHA256 匹配 / 可执行 --version == tag
      this.deps.onStatus({ target: 'ytdlp', phase: 'verifying', currentVersion, latestVersion })
      await this.verifyDownloaded(downloadPath, sumsAsset.url, latestVersion)

      // 替换:空闲即时覆盖 / 占用降级 pending(不杀进程,§7.1)
      await this.applyDownloaded(downloadPath, currentVersion, latestVersion)
    } catch (err) {
      // 任一步失败:清理临时文件,旧版原样保留(绝不留半文件覆盖)
      await this.safeUnlink(downloadPath)
      const readable = toReadable(mapUpdateError(err))
      console.warn('[YtdlpUpdater] 更新失败(已清理临时文件,保留旧版):', err)
      this.deps.onStatus({ target: 'ytdlp', phase: 'error', currentVersion, error: readable })
    }
  }

  /** 走代理取 latest release 并解析;解析失败 → 网络类错误(诚实,不误判可升级)。 */
  private async fetchLatestRelease(): Promise<ParsedRelease> {
    await this.deps.http.configureProxy(this.deps.getProxy().effectiveUrl)
    const json = await this.deps.http.getJson(YTDLP_LATEST_RELEASE_URL)
    const release = parseLatestRelease(json)
    if (!release) throw new UpdateError('network', 'latest release JSON 结构非法')
    return release
  }

  /** 三重校验:临时文件字节完整性 + 篡改防护 + 可执行性(spec §2.3);任一失败抛 verify 错误。 */
  private async verifyDownloaded(
    downloadPath: string,
    sumsUrl: string,
    tag: string
  ): Promise<void> {
    // 1. 大小下限(与占位检测同源 MIN_VALID_YTDLP_BYTES,不以内置大小判定)
    const size = this.deps.fs.statSync(downloadPath).size
    if (size < MIN_VALID_YTDLP_BYTES) {
      throw new UpdateError('verify', `下载文件过小(${size} < ${MIN_VALID_YTDLP_BYTES})`)
    }
    // 2. SHA256 完整性(权威):从 SHA2-256SUMS 取期望 hash 比对
    const sumsText = await this.deps.http.getText(sumsUrl)
    const expected = parseSha256Sums(sumsText, YTDLP_ASSET_NAME)
    if (!expected) throw new UpdateError('verify', 'SHA2-256SUMS 缺 yt-dlp.exe 行')
    const actual = computeSha256(await this.deps.fs.readFile(downloadPath))
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new UpdateError('verify', 'SHA256 不匹配(下载不完整或被篡改)')
    }
    // 3. 可执行性:起子进程 --version,解析出的版本须 == tag
    const probed = await this.probeDownloadedVersion(downloadPath)
    if (!probed || probed !== tag) {
      throw new UpdateError('verify', `可执行性验证失败(--version=${probed ?? 'null'} != ${tag})`)
    }
  }

  /** 替换:空闲 → rename 覆盖(applied);占用或 rename EBUSY/EPERM → 降级 pending(不杀进程)。 */
  private async applyDownloaded(
    downloadPath: string,
    currentVersion: string,
    latestVersion: string
  ): Promise<void> {
    const pendingPath = pendingYtDlpPath(this.deps.writableYtDlpPath)

    if (this.deps.hasActiveYtDlp()) {
      // 有视频任务占用 yt-dlp:暂存 pending,下次启动生效(§7.1 不杀进程)
      await this.deps.fs.rename(downloadPath, pendingPath)
      this.deps.onStatus({
        target: 'ytdlp',
        phase: 'pending-restart',
        currentVersion,
        latestVersion,
        message: 'yt-dlp 更新已就绪,将在下次启动生效(当前有视频任务在使用)'
      })
      return
    }

    try {
      await this.deps.fs.rename(downloadPath, this.deps.writableYtDlpPath)
      // 真正生效:刷新当前版本源(否则再次检查仍读旧版 → 重复下载,U4 修复)。
      // pending 分支不调(尚未生效,下次启动 applyPending 后由 probeVersion 探测校正)。
      this.deps.onApplied?.(latestVersion)
      this.deps.onStatus({
        target: 'ytdlp',
        phase: 'applied',
        currentVersion,
        latestVersion,
        message: `yt-dlp 已更新至 ${latestVersion}`
      })
    } catch (err) {
      if (isBusyError(err)) {
        // Windows 文件锁(EBUSY/EPERM):降级 pending(临时文件仍在,rename 为 pending 后不再清理)
        await this.deps.fs.rename(downloadPath, pendingPath)
        this.deps.onStatus({
          target: 'ytdlp',
          phase: 'pending-restart',
          currentVersion,
          latestVersion,
          message: 'yt-dlp 更新已就绪,将在下次启动生效'
        })
        return
      }
      throw err
    }
  }

  /** `<tmp> --version` → parseYtDlpVersion(复用注入式 captureVersionOutput);失败 / 超时 → null。 */
  private async probeDownloadedVersion(exePath: string): Promise<string | null> {
    const raw = await captureVersionOutput(
      this.deps.spawn,
      exePath,
      ['--version'],
      this.probeTimeoutMs
    )
    return raw ? parseYtDlpVersion(raw) : null
  }

  /** 写节流缓存(失败仅记日志,不影响检查结果)。 */
  private async recordCheck(latest: string): Promise<void> {
    try {
      const state = await this.deps.stateStore.read()
      await this.deps.stateStore.write({
        ...state,
        lastYtDlpCheckAt: this.now(),
        lastYtDlpLatest: latest
      })
    } catch (err) {
      console.warn('[YtdlpUpdater] 写节流缓存失败(忽略):', err)
    }
  }

  /** 清理临时文件(失败吞掉,不影响错误上报)。 */
  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.deps.fs.unlink(path)
    } catch {
      // 临时文件可能本就不存在(下载未开始)/ 已被 rename:忽略
    }
  }
}

/** 表征 Windows 文件锁的替换失败(EBUSY / EPERM;降级 pending 的信号)。 */
function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  if (code === 'EBUSY' || code === 'EPERM') return true
  const message = (err as { message?: unknown })?.message
  return typeof message === 'string' && /EBUSY|EPERM/.test(message)
}
