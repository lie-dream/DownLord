/**
 * aria2 限速选项纯函数(v0.2 Task 2 · spec §2.1 / §4.4)。
 *
 * 仿 `proxy/proxyArgs.ts` 范式:只做单位映射,不碰 fs / 网络 / 子进程。
 * 内部统一存 `KB/s` 整数;`kbps>0` → `${kbps}K`,`0`(不限速)→ `'0'`
 * ——供 `aria2.changeGlobalOption` / `aria2.changeOption` 动态**解除**限速(接线留 Phase 2)。
 * 只调带宽上限,绝不触碰 `.aria2` 续传(§2.5 / §7.4)。
 *
 * v1.0 Task 8 · #100(2026-09-17):两函数此后产**同一个键** `max-download-limit`,区别只在调用处 ——
 * 全局经 `changeGlobalOption`(= 新任务默认值)、任务经 `changeOption(gid)`(= 该任务覆盖值)。
 */

/**
 * aria2 全局限速选项片段(`aria2.changeGlobalOption` / 启动初值,spec §2.1)。
 * `kbps>0` → `{ 'max-download-limit': '${kbps}K' }`;`0` → `{ ...: '0' }`(全局默认不限)。
 *
 * ⚠️ 长期约束(v1.0 Task 8 · #100):全局 = `max-download-limit` 的**全局默认值**(新任务继承),
 * **不是** `max-overall-download-limit` 总量上限;改回 overall 会让单任务 0 / N 失效
 * (overall 是所有任务的总量硬上限,任务级 `max-download-limit` 只能在其下收紧,2026-09-17 探针实证)。
 */
export function toAria2GlobalLimitOption(kbps: number): Record<string, string> {
  return { 'max-download-limit': kbps > 0 ? `${kbps}K` : '0' }
}

/**
 * aria2 任务级限速选项片段(`aria2.changeOption(gid)`,spec §2.1)。
 * `kbps>0` → `{ 'max-download-limit': '${kbps}K' }`;`0` → `{ ...: '0' }`(解除该任务限速)。
 */
export function toAria2TaskLimitOption(kbps: number): Record<string, string> {
  return { 'max-download-limit': kbps > 0 ? `${kbps}K` : '0' }
}
