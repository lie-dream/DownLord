/**
 * 更新节流缓存(v0.2 Task 6 · spec §4.3)。
 *
 * 文件:`<userData>/config/updateState.json`。**非用户配置、非源数据**,是运行态节流缓存
 * ——避免频繁查 GitHub 触发 60 req/h 限流;与 `settings.json` 语义分离(不污染用户设置回显)。
 *
 * 复用 `settingsStore` / `proxyStore` 原子写模式(tmp→rename + mkdir 父目录);
 * 损坏 / 缺失 → 回退默认(可安全重建,派生缓存非源数据,符合 §7.3「不静默丢弃」精神)。
 * 读写机制自 v0.4 Task 3 起委托 `../config/jsonConfigStore.ts`(spec §1.4.1 四份 store 收口),
 * 本文件只留本缓存特有的三个轴:守卫 / 归一补默认 / `repairOnInvalid: false`。**导出名与签名逐字不变**。
 * fs 经接口注入(测试用内存 fake);纯函数地基本身不碰真实 FS。
 */
import { createJsonConfigStore, type JsonConfigStoreFs } from '../config/jsonConfigStore'

/** 后台自动检查节流窗口:每 24h 至多一次(手动检查无视节流,§2.5) */
export const UPDATE_THROTTLE_MS = 24 * 60 * 60 * 1000

/** 节流缓存结构(spec §4.3);缺省全 0 / null。 */
export interface UpdateState {
  /** 上次 yt-dlp 检查时间戳(ms;0 = 从未) */
  lastYtDlpCheckAt: number
  /** 上次查到的 yt-dlp 最新版(null = 未知) */
  lastYtDlpLatest: string | null
  /** 上次应用本体检查时间戳(ms;0 = 从未) */
  lastAppCheckAt: number
  /** 上次查到的应用最新版(null = 未知) */
  lastAppLatest: string | null
}

export const DEFAULT_UPDATE_STATE: UpdateState = {
  lastYtDlpCheckAt: 0,
  lastYtDlpLatest: null,
  lastAppCheckAt: 0,
  lastAppLatest: null
}

/** 注入式 fs 接口(原子写最小面;即通用 `JsonConfigStoreFs`) */
export type UpdateStateStoreFs = JsonConfigStoreFs

/** 结构守卫:四字段齐备且类型正确(非法即回退默认;派生缓存可安全重建)。 */
function isUpdateStateShape(v: unknown): v is UpdateState {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.lastYtDlpCheckAt !== 'number') return false
  if (!(o.lastYtDlpLatest === null || typeof o.lastYtDlpLatest === 'string')) return false
  if (typeof o.lastAppCheckAt !== 'number') return false
  if (!(o.lastAppLatest === null || typeof o.lastAppLatest === 'string')) return false
  return true
}

/** 以本缓存的三个轴组装通用 store(每次调用现组,保持既有「path + fs 传参」的无状态签名) */
function updateStore(
  path: string,
  fs: UpdateStateStoreFs
): ReturnType<typeof createJsonConfigStore<UpdateState>> {
  return createJsonConfigStore<UpdateState>({
    path,
    fs,
    cloneDefaults: () => ({ ...DEFAULT_UPDATE_STATE }),
    guard: isUpdateStateShape,
    // 合法结构补默认(向后兼容新增字段)
    normalize: (parsed) => ({ ...DEFAULT_UPDATE_STATE, ...parsed })
    // repairOnInvalid 缺省 false:派生缓存不重写,下次写入自愈
  })
}

/** 原子写节流缓存(写临时文件 → rename;先 mkdir 父目录)。 */
export async function writeUpdateState(
  path: string,
  state: UpdateState,
  fs: UpdateStateStoreFs
): Promise<void> {
  await updateStore(path, fs).write(state)
}

/**
 * 读节流缓存:缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_UPDATE_STATE`(不重写,派生缓存下次写入自愈)。
 * 合法结构补默认后返回(向后兼容新增字段)。
 */
export async function readUpdateState(path: string, fs: UpdateStateStoreFs): Promise<UpdateState> {
  return updateStore(path, fs).read()
}

/** 节流判定(spec §4.3 / §2.5):距上次检查 ≥ 窗口 → 应执行。`lastAt=0`(从未)始终执行。 */
export function shouldCheckNow(
  lastAt: number,
  now: number,
  windowMs: number = UPDATE_THROTTLE_MS
): boolean {
  return now - lastAt >= windowMs
}

/**
 * 节流缓存读写门面(注入 path + fs;编排层经此读写,单测可注入内存 fake)。
 */
export interface UpdateStateStore {
  read(): Promise<UpdateState>
  write(state: UpdateState): Promise<void>
}

/** 用真实 path + 注入 fs 组装节流缓存门面。 */
export function createUpdateStateStore(path: string, fs: UpdateStateStoreFs): UpdateStateStore {
  return {
    read: () => readUpdateState(path, fs),
    write: (state) => writeUpdateState(path, state, fs)
  }
}
