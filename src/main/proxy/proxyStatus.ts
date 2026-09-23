/**
 * 代理状态指示合成(纯函数,Task 7 · spec §5.1)。
 *
 * 把「配置档 + 解析态 + 连通探测结果」合成状态栏可显示的 `ProxyStatus`。
 * 文案诚实(PRD §4.4):「已连接」仅指**到代理端口本身**连通,不承诺墙外可达;
 * 不出现「翻墙 / 突破封锁 / 加速墙外 / 保证可用」措辞。探测真实实现留 Phase 3,此处只合成。
 */
import type { ProxyConfig, ProxyResolved, ProxyStatus } from '../../shared/ipc'

/** 连通探测结果:'ok'=到代理端口可连 / 'fail'=不通 / null=未探测(direct 档不探,spec §5.2) */
export type ProxyProbe = 'ok' | 'fail' | null

/**
 * 合成代理状态(spec §5.1 七情形表):
 * 1. direct → 直连 / off
 * 2. system + 读到代理 + 探测通 → 跟随系统(已连接) / ok
 * 3. system + 读到代理 + 探测不通 → 跟随系统(代理未响应) / warn
 * 4. system + 系统未设代理(effectiveUrl null)→ 跟随系统(系统未设代理 · 直连) / off
 * 5. manual + 校验通过 + 探测通 → 手动代理(已连接) / ok
 * 6. manual + 校验通过 + 探测不通 → 手动代理(未响应) / warn
 * 7. manual + 校验失败(effectiveUrl null)→ 手动代理(地址无效) / warn
 *
 * 区分依据:`resolved.effectiveUrl` —— system 下 null 即系统未设代理;manual 下 null 即校验失败。
 */
export function buildProxyStatus(
  config: ProxyConfig,
  resolved: ProxyResolved,
  probe: ProxyProbe
): ProxyStatus {
  const effectiveUrl = resolved.effectiveUrl

  if (config.mode === 'direct') {
    return { mode: 'direct', label: '直连', dot: 'off', effectiveUrl: null }
  }

  if (config.mode === 'system') {
    if (effectiveUrl === null) {
      return {
        mode: 'system',
        label: '跟随系统(系统未设代理 · 直连)',
        dot: 'off',
        effectiveUrl: null
      }
    }
    return probe === 'ok'
      ? { mode: 'system', label: '跟随系统(已连接)', dot: 'ok', effectiveUrl }
      : { mode: 'system', label: '跟随系统(代理未响应)', dot: 'warn', effectiveUrl }
  }

  // manual
  if (effectiveUrl === null) {
    return { mode: 'manual', label: '手动代理(地址无效)', dot: 'warn', effectiveUrl: null }
  }
  return probe === 'ok'
    ? { mode: 'manual', label: '手动代理(已连接)', dot: 'ok', effectiveUrl }
    : { mode: 'manual', label: '手动代理(未响应)', dot: 'warn', effectiveUrl }
}
