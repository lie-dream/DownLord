/**
 * 应用设置校验纯函数(Task 8 · spec §3.4)。
 *
 * 无 I/O、无副作用:逐字段守卫 + 合并补丁。损坏 / 异型字段回退当前值(再回退默认),
 * 配合 settingsStore 的「损坏回退不静默丢弃」一道保证 settings.json 永远落地为合法结构。
 */
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingsPatch,
  type CookieBrowser,
  type CookieConfig,
  type CookieSource,
  type SubtitleChoice,
  type ThemeMode,
  type VideoPrefs
} from '../../shared/ipc'
import { normalizeSubtitle } from '../video/ytdlpSubtitle'

/** 最大同时下载数允许区间 [1,10](原型滑块区间,spec §3.2) */
const MAX_CONCURRENT_MIN = 1
const MAX_CONCURRENT_MAX = 10

/** 全局下载限速上限 [0, 1048576] KB/s(= 1 GB/s;防御异常大值,常规带宽远不及,v0.2 Task 2 · spec §2.1) */
const MAX_SPEED_LIMIT_KBPS = 1_048_576

/** BT 做种上限(v0.3 Task 3 · spec §5):分享率 [0,100]、时长 [0,10080] 分钟(7 天)、单任务 peer [0,512] */
const MAX_SEED_RATIO = 100
const MAX_SEED_TIME_MIN = 10080
const MAX_BT_PEERS = 512

/** 默认清晰度下拉白名单(null = 每次询问;spec §4.4) */
const ALLOWED_HEIGHTS: ReadonlySet<number> = new Set([480, 720, 1080, 2160])

const THEME_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>(['system', 'light', 'dark'])

/** Cookie 来源 / 浏览器 / 字幕格式白名单(v0.2 Task 1 · spec §4.4 守卫) */
// ⚠️ `'extension'` 于 v0.4 Task 6 Phase 4 补入:漏了它 `isCookieConfig` 会判假 → `mergeVideoPrefs`
//    **静默丢弃**整个 cookie 补丁,表现为「设置页选了第四档,松手就弹回原档」,且写盘 / 读盘两侧都失效。
const COOKIE_SOURCES: ReadonlySet<CookieSource> = new Set<CookieSource>([
  'none',
  'browser',
  'file',
  'extension'
])
const COOKIE_BROWSERS: ReadonlySet<CookieBrowser> = new Set<CookieBrowser>([
  'chrome',
  'edge',
  'firefox',
  'brave',
  'chromium',
  'opera',
  'vivaldi'
])
const SUBTITLE_FORMATS: ReadonlySet<SubtitleChoice['format']> = new Set<SubtitleChoice['format']>([
  'srt',
  'vtt'
])

/**
 * 取整 + clamp 到 [1,10]。非有限数(NaN / Infinity / 非数字)回退默认 3。
 * 小数向下取整(3.7 → 3),越界夹取(0 → 1,11 → 10,负数 → 1)。
 */
export function clampMaxConcurrent(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_APP_SETTINGS.maxConcurrent
  const int = Math.floor(n)
  if (int < MAX_CONCURRENT_MIN) return MAX_CONCURRENT_MIN
  if (int > MAX_CONCURRENT_MAX) return MAX_CONCURRENT_MAX
  return int
}

/**
 * 取整 + clamp 到 [0, MAX_SPEED_LIMIT_KBPS] KB/s(v0.2 Task 2 · spec §2.1 / §4.3,仿 clampMaxConcurrent)。
 * `0` = 不限速;非有限数(NaN / Infinity / 非数字)/ 负数 → 回退 `0`(不限速);小数向下取整(500.7 → 500);
 * 超上限夹取到 1048576(1 GB/s)。
 */
export function clampSpeedLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  const int = Math.floor(n)
  if (int < 0) return 0
  if (int > MAX_SPEED_LIMIT_KBPS) return MAX_SPEED_LIMIT_KBPS
  return int
}

/**
 * 做种分享率 clamp(v0.3 Task 3 · spec §5):**保留小数**(ratio 可为 1.5 等,不取整);
 * 非有限数(NaN / Infinity / 非数字)→ 回退默认 1.0;负数 → 0(不按分享率停);超上限 → 100。
 */
export function clampSeedRatio(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_APP_SETTINGS.btSeedRatio
  if (n < 0) return 0
  if (n > MAX_SEED_RATIO) return MAX_SEED_RATIO
  return n
}

/**
 * 做种时长 clamp(分钟,v0.3 Task 3 · spec §5):整数 [0,10080];非有限数 → 回退默认 60;
 * 小数向下取整;负数 → 0(不按时间停);超上限 → 10080(7 天)。
 */
export function clampSeedTimeMin(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_APP_SETTINGS.btSeedTimeMin
  const int = Math.floor(n)
  if (int < 0) return 0
  if (int > MAX_SEED_TIME_MIN) return MAX_SEED_TIME_MIN
  return int
}

/**
 * 单任务最大 peer clamp(v0.3 Task 3 · spec §5):整数 [0,512];非有限数 → 回退默认 0(跟随全局 128);
 * 小数向下取整;负数 → 0;超上限 → 512。
 */
export function clampBtMaxPeers(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_APP_SETTINGS.btMaxPeers
  const int = Math.floor(n)
  if (int < 0) return 0
  if (int > MAX_BT_PEERS) return MAX_BT_PEERS
  return int
}

/** 主题三档守卫 */
export function isThemeMode(v: unknown): v is ThemeMode {
  return typeof v === 'string' && THEME_MODES.has(v as ThemeMode)
}

/** 默认清晰度白名单守卫(null | 480 | 720 | 1080 | 2160) */
export function isAllowedHeight(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && ALLOWED_HEIGHTS.has(v))
}

/**
 * Cookie 配置守卫(v0.2 Task 1 · spec §4.4):source 枚举 + browser 枚举|null + profile string|null + file string|null。
 * 只判结构 / 枚举合法,不判文件真实存在(运行期由 yt-dlp 报错 → COOKIE_FILE_INVALID)。
 */
export function isCookieConfig(v: unknown): v is CookieConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!COOKIE_SOURCES.has(o.source as CookieSource)) return false
  if (!(o.browser === null || COOKIE_BROWSERS.has(o.browser as CookieBrowser))) return false
  if (!(o.profile === null || typeof o.profile === 'string')) return false
  if (!(o.file === null || typeof o.file === 'string')) return false
  return true
}

/** 字幕选择守卫(v0.2 Task 1 · spec §4.4):langs string[] + format 'srt'|'vtt' + includeAuto boolean。 */
export function isSubtitleChoice(v: unknown): v is SubtitleChoice {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.langs) || !o.langs.every((x) => typeof x === 'string')) return false
  if (!SUBTITLE_FORMATS.has(o.format as SubtitleChoice['format'])) return false
  if (typeof o.includeAuto !== 'boolean') return false
  return true
}

/**
 * 视频偏好逐字段校验:非法字段回退当前值(defaultHeight 白名单、defaultAudioOnly 布尔守卫;
 * cookie / subtitle 经守卫,subtitle 经 `normalizeSubtitle` 去空 / 去重,v0.2 §4.4)。
 */
function mergeVideoPrefs(current: VideoPrefs, patch: unknown): VideoPrefs {
  if (!patch || typeof patch !== 'object') return current
  const o = patch as Record<string, unknown>
  const next: VideoPrefs = { ...current }
  if ('defaultHeight' in o && isAllowedHeight(o.defaultHeight)) next.defaultHeight = o.defaultHeight
  if ('defaultAudioOnly' in o && typeof o.defaultAudioOnly === 'boolean') {
    next.defaultAudioOnly = o.defaultAudioOnly
  }
  if ('cookie' in o && isCookieConfig(o.cookie)) next.cookie = o.cookie
  if ('subtitle' in o && isSubtitleChoice(o.subtitle)) next.subtitle = normalizeSubtitle(o.subtitle)
  return next
}

/**
 * 合并设置补丁到当前值(spec §3.4):
 * - 仅接受已知键(defaultDir / maxConcurrent / maxOverallLimitKBps / useAria2cForVideo / video / themeMode / clipboardWatch / autoUpdateYtDlp / autoUpdateApp / btSeedEnabled / btSeedRatio / btSeedTimeMin / btMaxPeers),异型 / 未知键丢弃。
 * - 逐字段校验:非法值回退当前值(current 已是合法全量)。
 * - 空 patch → 原样返回(no-op,克隆 video 避免共享引用)。
 * - `video` 可只带被改子字段(`mergeVideoPrefs` 逐字段合并;类型见 `AppSettingsPatch`,v0.3 Task 4 审计#10)。
 *
 * `defaultDir` 接受任意字符串(空串保留语义=用系统 downloads);路径真实可写性不在此强校验,
 * 由下载时 `ensureDir` 兜底(spec §3.4 / §9)。
 */
export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const next: AppSettings = { ...current, video: { ...current.video } }
  if (!patch || typeof patch !== 'object') return next

  const o = patch as Record<string, unknown>
  if ('defaultDir' in o && typeof o.defaultDir === 'string') next.defaultDir = o.defaultDir
  if ('maxConcurrent' in o) next.maxConcurrent = clampMaxConcurrent(o.maxConcurrent)
  if ('maxOverallLimitKBps' in o) next.maxOverallLimitKBps = clampSpeedLimit(o.maxOverallLimitKBps)
  if ('useAria2cForVideo' in o && typeof o.useAria2cForVideo === 'boolean') {
    next.useAria2cForVideo = o.useAria2cForVideo
  }
  if ('themeMode' in o && isThemeMode(o.themeMode)) next.themeMode = o.themeMode
  if ('clipboardWatch' in o && typeof o.clipboardWatch === 'boolean') {
    next.clipboardWatch = o.clipboardWatch
  }
  // Cookie 第四档首次说明已确认(v0.4 Task 6 · plan Phase 4):布尔守卫仿 clipboardWatch。
  // **可选字段**,故这里只在补丁显式带布尔时写入;不带 → `next` 沿用 current(缺省 = 未确认)。
  if ('cookieExtensionNoticeAcked' in o && typeof o.cookieExtensionNoticeAcked === 'boolean') {
    next.cookieExtensionNoticeAcked = o.cookieExtensionNoticeAcked
  }
  if ('autoUpdateYtDlp' in o && typeof o.autoUpdateYtDlp === 'boolean') {
    next.autoUpdateYtDlp = o.autoUpdateYtDlp
  }
  if ('autoUpdateApp' in o && typeof o.autoUpdateApp === 'boolean') {
    next.autoUpdateApp = o.autoUpdateApp
  }
  // BT 做种(v0.3 Task 3 · spec §5):布尔守卫仿 useAria2cForVideo;三数值走各自 clamp(ratio 保留小数 / time·peers 整数区间)
  if ('btSeedEnabled' in o && typeof o.btSeedEnabled === 'boolean') {
    next.btSeedEnabled = o.btSeedEnabled
  }
  if ('btSeedRatio' in o) next.btSeedRatio = clampSeedRatio(o.btSeedRatio)
  if ('btSeedTimeMin' in o) next.btSeedTimeMin = clampSeedTimeMin(o.btSeedTimeMin)
  if ('btMaxPeers' in o) next.btMaxPeers = clampBtMaxPeers(o.btMaxPeers)
  // tracker 自动更新开关(v0.4 Task 1 · spec §5.2):布尔守卫仿 btSeedEnabled;**表本身绝不进 settings.json**(D13)
  if ('btAutoUpdateTrackers' in o && typeof o.btAutoUpdateTrackers === 'boolean') {
    next.btAutoUpdateTrackers = o.btAutoUpdateTrackers
  }
  if ('video' in o) next.video = mergeVideoPrefs(current.video, o.video)

  return next
}
