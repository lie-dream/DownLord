/**
 * 代理配置持久化(Task 7 · spec §2.3)。
 *
 * 文件:`<userData>/config/proxy.json`,内容即 `ProxyConfig` 的 JSON。
 * - 写:**原子写**(写临时文件 → rename,沿用工程落盘约定,避免半写损坏)。
 * - 读:文件缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_PROXY_CONFIG` 并**重写修复**
 *   (不静默崩溃,符合 §7 数据安全精神;此处非源下载数据,损坏可安全重建)。
 *
 * 读写机制自 v0.4 Task 3 起委托 `../config/jsonConfigStore.ts`(spec §1.4.1 四份 store 收口),
 * 本文件只留**本配置特有的三个轴**:守卫 `isProxyConfig` / 归一取显式字段 / `repairOnInvalid: true`。
 * **导出名与签名逐字不变** → 调用点零改动。
 *
 * fs 经接口注入(测试用内存 fake);纯函数地基本身不碰真实 FS。真实装配(Phase 2/3)
 * 传入 `nodeProxyStoreFs`(node:fs/promises 薄封装)。
 */
import { createJsonConfigStore, type JsonConfigStoreFs } from '../config/jsonConfigStore'
import { DEFAULT_PROXY_CONFIG, type ProxyConfig, type ProxyMode } from '../../shared/ipc'

/** 注入式 fs 接口(原子写所需最小面:read / write / rename / mkdir;即通用 `JsonConfigStoreFs`) */
export type ProxyStoreFs = JsonConfigStoreFs

const VALID_MODES: ReadonlySet<ProxyMode> = new Set<ProxyMode>(['system', 'manual', 'direct'])

/** 结构守卫:mode 合法 + manualUrl 为 string|null(防损坏 / 防被篡改成异型) */
function isProxyConfig(v: unknown): v is ProxyConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!VALID_MODES.has(o.mode as ProxyMode)) return false
  if (o.manualUrl !== null && typeof o.manualUrl !== 'string') return false
  return true
}

/** 以本配置的三个轴组装通用 store(每次调用现组,保持既有「path + fs 传参」的无状态签名) */
function proxyStore(
  path: string,
  fs: ProxyStoreFs
): ReturnType<typeof createJsonConfigStore<ProxyConfig>> {
  return createJsonConfigStore<ProxyConfig>({
    path,
    fs,
    cloneDefaults: () => ({ ...DEFAULT_PROXY_CONFIG }),
    guard: isProxyConfig,
    // 合法结构:只取显式字段(丢弃多余键,防被篡改成异型)
    normalize: (parsed) => ({ mode: parsed.mode, manualUrl: parsed.manualUrl }),
    // 用户配置:损坏即回写默认修复(尽力而为,失败不抛)
    repairOnInvalid: true
  })
}

/**
 * 原子写代理配置(spec §2.3):写临时文件 → rename 覆盖目标。
 * 先确保父目录存在(`config/` 首次运行可能不存在)。
 */
export async function writeProxyConfig(
  path: string,
  config: ProxyConfig,
  fs: ProxyStoreFs
): Promise<void> {
  await proxyStore(path, fs).write(config)
}

/**
 * 读代理配置(spec §2.3):
 * 文件缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_PROXY_CONFIG` 并重写修复后返回默认。
 * 修复写失败也不抛(不因配置文件可恢复损坏而崩溃),仍返回默认值。
 */
export async function readProxyConfig(path: string, fs: ProxyStoreFs): Promise<ProxyConfig> {
  return proxyStore(path, fs).read()
}
