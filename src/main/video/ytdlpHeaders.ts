/**
 * 接管 / 嗅探 headers → yt-dlp 命令行参数(纯函数;v0.4 Task 5 · spec §4.5「白名单的三层」第③层)。
 *
 * **注入式范式照抄同目录之外的 `engine/aria2Headers.ts`**:缺省恒产 `[]`,摊开后与改动前
 * **逐字节等价**(那边缺省恒产 `{}`,同一手法)。零回归不靠自觉,靠「缺省分支的返回值是常量」
 * 这条形状(判据 U-25 / U-26 / U-27,反向探针 RP-6)。
 *
 * ⚠️ **刻意不用 `--add-header`**,而用专用选项 `--referer` / `--user-agent` —— 与 aria2 侧
 * 「刻意不用 `--header`」**逐字同构**:
 * 1. **`--add-header` 是「任意头」的入口**。不用它,即使白名单前两层(协议形状 / 值过滤)都被
 *    绕过,yt-dlp 侧也**没有**接收任意头的通路 —— 这是第三层存在的全部意义(纵深,不是重复)。
 *    判据 `grep -rn "add-header" src/main/video/` **零命中**(配正向对照搜 `--referer`)。
 * 2. **专用选项是「替换」而非「追加」**,不会造成同名重复头。
 *
 * ★ **实测 R3(2026-08-09,内置 `resources/bin/yt-dlp.exe` 版本 `2026.06.09`)**:
 *   `yt-dlp --user-agent X --version` 退出码 **0** → 专用选项仍在,第③层**成立**,
 *   无需退到 `--add-header`。`--user-agent` 虽在新版帮助里被归入 Deprecated options,
 *   但**仍被接受**;若某天真被移除,退路与如实标注写在 spec §4.5 / §6.1。
 */

/**
 * 白名单过滤后的 headers → yt-dlp 参数片段。
 *
 * @param headers - `filterDownloadHeaders` 的输出(**规范大小写**:`Referer` / `User-Agent`);
 *                  `undefined` = 不下发任何头
 * @returns yt-dlp 参数片段;**缺省恒为 `[]`**(摊进 args 后与改动前逐字节等价)
 */
export function toYtdlpHeaderArgs(headers?: Record<string, string>): string[] {
  if (!headers) return []
  const args: string[] = []
  if (headers['Referer']) args.push('--referer', headers['Referer'])
  if (headers['User-Agent']) args.push('--user-agent', headers['User-Agent'])
  return args
}
