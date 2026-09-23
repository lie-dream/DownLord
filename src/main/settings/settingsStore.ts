/**
 * 应用设置持久化(Task 8 · spec §3.1 / §3.4)。
 *
 * 文件:`<userData>/config/settings.json`,内容即 `AppSettings` 的 JSON。
 * 直接复用 Task 7 `proxyStore.ts` 的成熟模式:
 * - 写:**原子写**(写临时文件 → rename;先 mkdir 父目录),避免半写损坏。
 * - 读:文件缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_APP_SETTINGS` 并**重写修复**
 *   (不静默崩溃,符合 §7.3「不静默丢弃」精神;此处非源下载数据,可安全重建)。
 *
 * 结构合法但字段越界(如 maxConcurrent 50 / defaultHeight 360)不算「损坏」:
 * 经 `mergeSettings` 归一(clamp / 白名单回退),不触发整体回退重写。
 *
 * 读写机制自 v0.4 Task 3 起委托 `../config/jsonConfigStore.ts`(spec §1.4.1 四份 store 收口),
 * 本文件只留本配置特有的三个轴:守卫 `isAppSettingsShape` / 归一 `mergeSettings` / `repairOnInvalid: true`。
 * **导出名与签名逐字不变** → 调用点零改动。
 *
 * fs 经接口注入(测试用内存 fake);纯函数地基本身不碰真实 FS。真实装配(Phase 2)
 * 传入 node:fs/promises 薄封装。
 */
import { createJsonConfigStore, type JsonConfigStoreFs } from '../config/jsonConfigStore'
import { DEFAULT_APP_SETTINGS, type AppSettings, type VideoPrefs } from '../../shared/ipc'
import { isThemeMode, mergeSettings } from './validateSettings'

/** 注入式 fs 接口(原子写所需最小面:read / write / rename / mkdir;即通用 `JsonConfigStoreFs`) */
export type SettingsStoreFs = JsonConfigStoreFs

/** 视频偏好结构守卫(类型层:defaultHeight 为 number|null、defaultAudioOnly 为 boolean) */
function isVideoPrefsShape(v: unknown): v is VideoPrefs {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const h = o.defaultHeight
  if (h !== null && typeof h !== 'number') return false
  if (typeof o.defaultAudioOnly !== 'boolean') return false
  return true
}

/**
 * 结构守卫(类型层):四字段齐备且类型正确。
 * 仅判结构,不判取值范围(范围由 mergeSettings 归一);结构非法才触发整体回退重写。
 */
function isAppSettingsShape(v: unknown): v is AppSettings {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.defaultDir !== 'string') return false
  if (typeof o.maxConcurrent !== 'number') return false
  if (!isThemeMode(o.themeMode)) return false
  if (!isVideoPrefsShape(o.video)) return false
  return true
}

/** 以本配置的三个轴组装通用 store(每次调用现组,保持既有「path + fs 传参」的无状态签名) */
function appSettingsStore(
  path: string,
  fs: SettingsStoreFs
): ReturnType<typeof createJsonConfigStore<AppSettings>> {
  return createJsonConfigStore<AppSettings>({
    path,
    fs,
    // 照搬迁移前的两层拷贝语义(顶层 + video),不在纯重构里改变深度
    cloneDefaults: () => ({ ...DEFAULT_APP_SETTINGS, video: { ...DEFAULT_APP_SETTINGS.video } }),
    guard: isAppSettingsShape,
    // 结构合法:逐字段归一(越界 clamp、白名单回退),不触发修复重写
    normalize: (parsed) => mergeSettings(DEFAULT_APP_SETTINGS, parsed),
    // 用户配置:损坏即回写默认修复(尽力而为,失败不抛)
    repairOnInvalid: true
  })
}

/**
 * 原子写应用设置(spec §3.1):写临时文件 → rename 覆盖目标。
 * 先确保父目录存在(`config/` 首次运行可能不存在)。
 */
export async function writeSettings(
  path: string,
  settings: AppSettings,
  fs: SettingsStoreFs
): Promise<void> {
  await appSettingsStore(path, fs).write(settings)
}

/**
 * 读应用设置(spec §3.4):
 * 文件缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_APP_SETTINGS` 并重写修复后返回默认。
 * 修复写失败也不抛(不因可恢复损坏而崩溃),仍返回默认值。
 * 结构合法则经 `mergeSettings` 归一(clamp 越界 / 字段白名单回退),不重写。
 */
export async function readSettings(path: string, fs: SettingsStoreFs): Promise<AppSettings> {
  return appSettingsStore(path, fs).read()
}
