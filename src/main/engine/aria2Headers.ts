/**
 * 接管 headers → aria2 任务级选项(纯函数;v0.4 Task 4 · spec §6.2「白名单的三层」第③层)。
 *
 * **注入式范式照抄 v0.3 `btOptions.toSeedOptions`**:缺省恒产 `{}`,展开后与改动前**逐字节等价**
 * (`toSeedOptions` 缺省恒产 `{'seed-time':'0'}` 保证与 Task 1 逐字节等价,同一手法)。
 * 零回归不靠自觉,靠「缺省分支的返回值是常量」这条形状。
 *
 * ⚠️ **刻意不用 aria2 的 `header` 选项**,而用专用的 `referer` / `user-agent` —— 两条理由,都写死在这里:
 * 1. **`header` 是「任意头」的入口**。不用它,即使白名单前两层(协议形状 / 值过滤)都被绕过,
 *    aria2 侧也**没有**接收任意头的通路 —— 这是第三层存在的全部意义(纵深,不是重复)。
 * 2. **专用选项是「替换」而非「追加」**。`--header` 会在 aria2 自带的 User-Agent 之外**再加一条**,
 *    造成同名重复头(部分站点据此判异常);`--user-agent` 直接替换,不会重复。
 */

/**
 * 白名单过滤后的 headers → aria2 任务级选项。
 *
 * @param headers - `filterDownloadHeaders` 的输出(**规范大小写**:`Referer` / `User-Agent`);
 *                  `undefined` = 不下发任何头
 * @returns aria2 选项片段;**缺省恒为 `{}`**(展开进 options 后与改动前逐字节等价)
 */
export function toAria2HeaderOptions(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {}
  const options: Record<string, string> = {}
  if (headers['Referer']) options.referer = headers['Referer']
  if (headers['User-Agent']) options['user-agent'] = headers['User-Agent']
  return options
}
