/**
 * 接管配置的真源(v0.4 Task 4 · spec §5.1 · plan 4.1)。
 *
 * 落 `<userData>/config/takeover.json`,经既有 `../config/jsonConfigStore.ts` 组装为**第六份** store
 * (前五份:`proxyStore` / `settingsStore` / `updateStateStore` / `btTrackerStore` / `channelConfig`)。
 * 本文件只提供该 store 的**三个轴**,读写机制一个字不重写。
 *
 * | 轴 | 本 store 的取值 | 为什么 |
 * |---|---|---|
 * | `repairOnInvalid` | **`true`** | 这是**用户配置**(不是派生缓存):损坏时回写默认修复,免得用户下次打开设置页看到的是一份读不出来的文件 |
 * | `normalize` | 取显式字段 + 域名小写去重 + `pausedUntil` 非有限数回落 `null` | 手改过的文件也要能安全用 |
 * | `cloneDefaults` | **工厂返回新数组** | `excludedDomains` 是数组,浅展开会让调用方共享同一份引用,一旦被 mutate 就污染全局常量(`../bt/btTrackerStore.ts` 的 `cloneDefaultCache` 已踩过这个坑) |
 *
 * ⚠️ **落盘键集合恰好三个**(I-08 用 `deepStrictEqual` 钉死)。连接态 / headers / 任务 id 之类
 * **一个都不许塞进来** —— 它们要么是运行时态(CONTEXT.md),要么带隐私(referrer / UA)。
 *
 * ⚠️ **零 schema**:本文件**不触 SQLite**。接管任务就是普通 `kind='http'`,v0.4「零迁移」口径不受影响。
 */
import {
  createJsonConfigStore,
  type JsonConfigStore,
  type JsonConfigStoreFs
} from '../config/jsonConfigStore'

/** 接管配置。**三个字段,不多不少**(spec §5.1) */
export interface TakeoverConfig {
  /**
   * 接管总开关。**默认 `true`** —— 装了扩展即视为授权(CONTEXT.md「接管」)。
   *
   * ⚠️ 与**默认关**的剪贴板监控刻意相反:那是**被动监听**用户没交给我们的东西,这是用户**主动点了下载**。
   * 关掉后扩展照常上报、DownLord 一律回绝,与暂停走**同一条降级路径**。
   */
  enabled: boolean
  /**
   * 暂停到期的**绝对时刻**(epoch ms);`null` = 未暂停。
   *
   * ★ **为什么落盘而不是留内存**(spec §5.1,与 `limitKBps` 那类运行时态刻意不同):
   * ① 它是**带绝对到期时刻的用户意图**,而 `limitKBps` 是无到期时刻的临时覆盖 ——
   *    「暂停 1 小时」在重启后失效,是**违背用户明确表达**的行为;
   * ② 反例更刺眼:用户暂停后 DownLord 崩溃自恢复 / 用户重启机器 → 接管突然复活 →
   *    浏览器下载被抢走,而那正是他刚刚明确说不要的;
   * ③ **零 schema 影响**:它只是本 JSON 里的一个 number,不触 SQLite。
   */
  pausedUntil: number | null
  /**
   * 域名例外表(**小写、不含通配符**);空数组 = 不排除任何域。
   *
   * ⚠️ **只收域名,永不收扩展名**(CONTEXT.md「接管判定」):类别的扩展名清单管「抢过来之后放到
   * 哪个目录」、从不拒绝任何文件;本表管「抢不抢」。两者都会提到「文件类型」,混在一处必被误解。
   */
  excludedDomains: string[]
}

/** 缺省:接管开着、没暂停、不排除任何域 */
export const DEFAULT_TAKEOVER_CONFIG: TakeoverConfig = {
  enabled: true,
  pausedUntil: null,
  excludedDomains: []
}

/**
 * 默认值的**独立副本**:`excludedDomains` 是数组,浅展开会共享同一份引用 ——
 * 调用方 `push` 一下就污染了 `DEFAULT_TAKEOVER_CONFIG`(`btTrackerStore` 记过这个坑,照它写)。
 */
export function cloneDefaultTakeoverConfig(): TakeoverConfig {
  return { enabled: true, pausedUntil: null, excludedDomains: [] }
}

/**
 * 域名归一:去首尾空白 → 小写 → 去 `http(s)://` 前缀 → 去路径 / 查询串 → 去端口 → 去尾点。
 *
 * 用户从地址栏复制过来的多半是 `https://dl.example.com/x.zip?t=1`,直接存进例外表永不命中
 * (`isExcludedDomain` 比的是 `new URL(url).host`)。**在入口归一,而不是在匹配时容错** ——
 * 后者会让存进去的值与看见的值不一致,用户无从判断自己填对没有。
 *
 * 归一不出东西(空串 / 只有协议)→ 返回 `''`,由调用方丢弃。
 */
export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // 协议前缀
  s = s.split('/')[0].split('?')[0].split('#')[0] // 路径 / 查询 / 锚点
  s = s.split('@').pop() ?? '' // 万一带了 user:pass@
  s = s.split(':')[0] // 端口
  s = s.replace(/\.+$/, '') // 尾点(FQDN 写法)
  return s
}

/** 域名表归一:逐条归一 + 丢空 + **保序去重**(不排序 —— 用户添加的顺序就是他心里的顺序) */
export function normalizeDomainList(list: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of list) {
    const d = normalizeDomain(raw)
    if (d && !out.includes(d)) out.push(d)
  }
  return out
}

/** 元素全为 string 的数组 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * 结构守卫:三字段齐备且类型正确(只判**结构**,取值范围归 `normalize`)。
 *
 * `pausedUntil` 允许 `number` 或 `null`;`NaN` / `Infinity` 是合法的 `number` 结构,
 * 由 `normalizeTakeoverConfig` 回落 `null`(与 `normalizeIntent` 处理 `totalBytes` 同一手法)。
 */
export function isTakeoverConfigShape(v: unknown): v is TakeoverConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.enabled !== 'boolean') return false
  if (o.pausedUntil !== null && typeof o.pausedUntil !== 'number') return false
  if (!isStringArray(o.excludedDomains)) return false
  return true
}

/**
 * 归一:**只取三个显式字段**(手改文件里多出来的键当场丢掉,落盘键集合恒为三个)+
 * 域名小写去重 + `pausedUntil` 非有限数回落 `null`。
 */
export function normalizeTakeoverConfig(parsed: TakeoverConfig): TakeoverConfig {
  return {
    enabled: parsed.enabled,
    pausedUntil: Number.isFinite(parsed.pausedUntil) ? (parsed.pausedUntil as number) : null,
    excludedDomains: normalizeDomainList(parsed.excludedDomains)
  }
}

/** 接管配置读写门面(编排层经此读写;单测注入内存 fake fs) */
export type TakeoverConfigStore = JsonConfigStore<TakeoverConfig>

/** 用真实 path + 注入 fs 组装接管配置门面(三个轴在此定死,读写机制全走通用 store) */
export function createTakeoverConfigStore(
  path: string,
  fs: JsonConfigStoreFs
): TakeoverConfigStore {
  return createJsonConfigStore<TakeoverConfig>({
    path,
    fs,
    cloneDefaults: cloneDefaultTakeoverConfig,
    guard: isTakeoverConfigShape,
    normalize: normalizeTakeoverConfig,
    // ★ 用户配置 → 损坏即回写默认修复(与派生缓存 `btTrackerStore` 的 false 刻意相反)
    repairOnInvalid: true
  })
}
