/**
 * 构建标记(buildId)的生成 —— **零副作用模块**(v0.4 Task 5 · spec §3.5 · `docs/TODO.md` #53)。
 *
 * 与 `extensionVersion.mjs` 同一处理:纯函数不能留在 `build-extension.mjs` 里 ——
 * 那个文件顶层就 `await buildOnce()`,测试一 import 就真跑一次构建。
 *
 * ★ **它解决的是什么**:Task 4 Phase 2 真机验收中,同一处修复第一轮没生效、第二轮生效,
 *   而两轮之间**代码判据一字未改**。用户每次都卸载后重装,故「跑旧代码」这条解释不成立;
 *   未验证的可能性只剩两条 —— ①加载的目录不是当次构建的 `extension/dist` ②浏览器缓存了旧的
 *   SW 脚本。两条都表现为「分不清代码没修对、还是浏览器跑的不是这版」,毁的是**验证的可信度**。
 *
 * ★ **为什么必须带构建时刻,不能只用 git short sha**:调试时连续构建两次而未提交,sha 完全一样 ——
 *   恰好废在最需要它的那个场景里。
 */

/** 两位补零(月 / 日 / 时 / 分 / 秒共用) */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * `<version>+<YYYYMMDD-HHmmss>`,如 `0.4.0+20260809-143022`。
 *
 * **取本地时刻而非 UTC**:这个值的唯一读者是正坐在机器前的开发者,他要拿它和自己的墙上时钟对。
 *
 * @param {string} version - `package.json` 的 version(已由 `assertValidExtensionVersion` 校验过)
 * @param {Date} date - 构建时刻。**由调用方传入**,故本函数可测(不读时钟 = 无副作用)
 * @returns {string}
 */
export function formatBuildId(version, date) {
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  return `${version}+${stamp}`
}
