/**
 * tracker 表缓存(v0.4 Task 1 · spec §5.1)。
 *
 * 文件:`<userData>/config/btTrackers.json`(与 `updateState.json` 同目录)。**非用户配置、非源数据**,
 * 是【派生缓存】——可从公开源随时重建,与 SQLite 里无法重建的下载历史(源数据)语义完全不同,
 * 故损坏 / 缺失一律**回退默认**(退回内置表),不抛、不重写,下次成功拉取自然覆盖自愈(§7.3 精神)。
 *
 * 逐结构仿 `../update/updateStateStore.ts`(原子写 tmp→rename + mkdir 父目录 + 结构守卫 + 门面)。
 * 读写机制自 v0.4 Task 3 起委托 `../config/jsonConfigStore.ts`(spec §1.4.1 四份 store 收口 ——
 * 当初「**不修改 `updateStateStore.ts` 本身**」的绕行留痕,至此由通用 store 收口);本文件只留本缓存
 * 特有的三个轴:守卫 / 归一补默认 / `repairOnInvalid: false`。**导出名与签名逐字不变**。
 * fs 经接口注入(测试用内存 fake),本模块不 import `fs`。
 */
import { createJsonConfigStore, type JsonConfigStoreFs } from '../config/jsonConfigStore'

/** tracker 缓存结构(spec §5.1);表与时间戳、源 URL 在**同一次写**里,不会出现「时间戳写了表没写」。 */
export interface BtTrackerCache {
  /** 上次【成功】拉取并应用的时间戳(ms;0 = 从未) */
  updatedAt: number
  /** 本次成功的源 URL(仅供排障;整表替换语义下只记成功那一组) */
  sourceUrls: string[]
  /** 远端表(整表替换;内置表不在此,空数组 = 尚无缓存 → 用内置) */
  trackers: string[]
}

/** 缺省:三字段全空 / 零 → 语义即「从未拉取过」→ 生效表 = 内置表 */
export const DEFAULT_BT_TRACKER_CACHE: BtTrackerCache = {
  updatedAt: 0,
  sourceUrls: [],
  trackers: []
}

/**
 * 默认值的**独立副本**:`DEFAULT_BT_TRACKER_CACHE` 含数组字段,浅展开会让调用方共享同一份数组引用,
 * 一旦被 mutate 就污染了全局常量(`UpdateState` 全是原始值,无此问题,故此处比原型多一层)。
 */
function cloneDefaultCache(): BtTrackerCache {
  return { updatedAt: 0, sourceUrls: [], trackers: [] }
}

/** 注入式 fs 接口(原子写最小面;即通用 `JsonConfigStoreFs`) */
export type BtTrackerStoreFs = JsonConfigStoreFs

/** 元素全为 string 的数组 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** 结构守卫:三字段齐备且类型正确(非法即回退默认;派生缓存可安全重建)。 */
function isBtTrackerCacheShape(v: unknown): v is BtTrackerCache {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.updatedAt !== 'number') return false
  if (!isStringArray(o.sourceUrls)) return false
  if (!isStringArray(o.trackers)) return false
  return true
}

/** 以本缓存的三个轴组装通用 store(每次调用现组,保持既有「path + fs 传参」的无状态签名) */
function trackerStore(
  path: string,
  fs: BtTrackerStoreFs
): ReturnType<typeof createJsonConfigStore<BtTrackerCache>> {
  return createJsonConfigStore<BtTrackerCache>({
    path,
    fs,
    cloneDefaults: cloneDefaultCache,
    guard: isBtTrackerCacheShape,
    // 合法结构补默认(向后兼容新增字段);底座用独立副本,免得共享默认数组引用
    normalize: (parsed) => ({ ...cloneDefaultCache(), ...parsed })
    // repairOnInvalid 缺省 false:派生缓存不重写,下次成功拉取自愈
  })
}

/** 原子写 tracker 缓存(写临时文件 → rename;先 mkdir 父目录)。 */
export async function writeBtTrackerCache(
  path: string,
  cache: BtTrackerCache,
  fs: BtTrackerStoreFs
): Promise<void> {
  await trackerStore(path, fs).write(cache)
}

/**
 * 读 tracker 缓存:缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_BT_TRACKER_CACHE`(即退回内置表),
 * **不抛、不重写**(派生缓存,下次成功写入自愈)。
 */
export async function readBtTrackerCache(
  path: string,
  fs: BtTrackerStoreFs
): Promise<BtTrackerCache> {
  return trackerStore(path, fs).read()
}

/**
 * tracker 缓存读写门面(注入 path + fs;编排层经此读写,单测可注入内存 fake)。
 */
export interface BtTrackerStore {
  read(): Promise<BtTrackerCache>
  write(cache: BtTrackerCache): Promise<void>
}

/** 用真实 path + 注入 fs 组装 tracker 缓存门面。 */
export function createBtTrackerStore(path: string, fs: BtTrackerStoreFs): BtTrackerStore {
  return {
    read: () => readBtTrackerCache(path, fs),
    write: (cache) => writeBtTrackerCache(path, cache, fs)
  }
}
