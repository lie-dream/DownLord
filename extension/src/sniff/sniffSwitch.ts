/**
 * 嗅探开关 —— **副作用层**(v0.4 Task 5 · spec §2.1 / §2.5)。
 *
 * ★ **默认关**(D1)。理由与「剪贴板监控默认关」同一把尺子:被动监听类功能不默认打开。
 *   接管是相反的一类 —— 那是用户主动点了下载,装了扩展即视为授权。
 *
 * ★ 开关存 `storage.local`(**要跨浏览器重启活着**),而嗅探**结果**存 `storage.session`
 *   (**要跟着浏览器一起消失**)。两者存在不同区里是刻意的,不是笔误。
 *
 * ★ **关闭时清空全部桶**:让「关闭 = 完全不监听」在**可观察行为**上真的成立 ——
 *   与「暂停接管在可观察行为上等同于完全不拦截」同一标准。只停止写入、留着旧数据,
 *   用户关了开关还能在 popup 里看到自己刚才的浏览痕迹,那不叫关闭。
 *
 * ⚠️ 本文件是 `sniff/` 里**唯一**打日志的地方,且**只记计数、绝不记 URL**
 *    (隐私红线,见 `sniffRules.ts` 文件头)。
 */
import type { BrowserAdapter } from '../adapter/browserAdapter'
import { clearAllBuckets } from './sniffStore'

export const SNIFF_ENABLED_KEY = 'downlord:sniffEnabled'

/** 读开关。**未写过 / 读到任何非 `true` 的值 → 关**(默认关是靠这个 `=== true` 保证的,不靠初始化) */
export async function readSniffEnabled(adapter: BrowserAdapter): Promise<boolean> {
  return (await adapter.storage.get<boolean>(SNIFF_ENABLED_KEY)) === true
}

/**
 * 写开关。关闭时**顺带清空全部桶**。
 *
 * 顺序是「先写开关、后清桶」:万一清桶失败,至少监听已经停了(反过来会留下一个仍在采集的窗口)。
 */
export async function setSniffEnabled(adapter: BrowserAdapter, enabled: boolean): Promise<void> {
  await adapter.storage.set(SNIFF_ENABLED_KEY, enabled)

  if (enabled) {
    console.log('[DownLord] 嗅探已开启(结果只留在本机浏览器内存,不落库、不上报)')
    return
  }

  const cleared = await clearAllBuckets(adapter)
  console.log(`[DownLord] 嗅探已关闭,已清空 ${cleared} 个标签页的嗅探结果`)
}

/**
 * 订阅开关变更 —— sw 的模块级缓存靠它刷新(spec §2.1 第 3 条)。
 *
 * ⚠️ **读失败按「关」处理**:保守方向是「宁可漏嗅,不可在用户没开时监听」。
 */
export function watchSniffEnabled(
  adapter: BrowserAdapter,
  onChange: (enabled: boolean) => void
): void {
  adapter.storage.onChanged((changedKeys: string[]): void => {
    if (!changedKeys.includes(SNIFF_ENABLED_KEY)) return
    void readSniffEnabled(adapter).then(onChange, (): void => onChange(false))
  })
}
