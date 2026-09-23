/**
 * 构建标记 —— **由扩展产物自己上报的那一份**(v0.4 Task 5 · spec §3.5 · `docs/TODO.md` #53)。
 *
 * 值由 `scripts/build-extension.mjs` 在 esbuild 的 `define` 里注入,**一处 define 同时喂
 * `sw` 与 `popup` 两个入口** —— 这正是「同一 buildId 注入两个产物」的最短路径。
 *
 * ⚠️ **为什么不用 `manifest.version_name`**(#53 写死的做法约束):失效模式②(浏览器缓存了旧的
 * SW 脚本)下 manifest 是新的、`sw.js` 是旧的,`version_name` 会显示新标记却跑旧代码 ——
 * **比没有更坏**。#53 堵的不只是 manifest,是**任何不由 sw 自己开口的读法**。
 */

declare const __DOWNLORD_BUILD_ID__: string

/** 构建期 esbuild define 注入;直接跑 TS(单测)时未定义 → `'dev'`。`typeof` 对未声明标识符是安全的 */
export const BUILD_ID: string =
  typeof __DOWNLORD_BUILD_ID__ === 'string' ? __DOWNLORD_BUILD_ID__ : 'dev'
