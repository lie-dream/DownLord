/**
 * 按 format 协议精细化判定是否挂 aria2c(纯函数,v0.3 Task 4 · #24 · spec §2)。
 *
 * yt-dlp 的 HLS(m3u8)/ DASH(分片)由其自带下载器逐分片抓取;把这类任务硬挂 external
 * downloader aria2c 是徒劳——aria2c 不理解 m3u8 / dash manifest,**注定失败 → 触发运行时
 * 「加速回退」重起自带下载器**,白白多一次失败尝试 + 进程重起开销。
 *
 * 故按**选中 format 的 protocol** 判定:已确认分片协议 → 不挂 aria2c(改用 yt-dlp 自带下载器 +
 * `--concurrent-fragments` 并发提速);progressive / 未知 protocol → **保守挂 aria2c + 保留原三层
 * 回退**(§7.1 回退不退化,是「少踩一脚」而非「拆安全网」)。
 */

/** 分片协议关键字(yt-dlp `format.protocol`):HLS 的 m3u8 / m3u8_native、DASH 的 http_dash_segments / dash */
const FRAGMENTED_PROTOCOLS = ['m3u8', 'm3u8_native', 'http_dash_segments', 'dash']

/**
 * 未挂 aria2c 时 yt-dlp 自带下载器的分片并发数(spec §2.4)。保守取 4:对 HLS/DASH 提速,
 * 对 progressive 单文件无副作用(yt-dlp 忽略);不追求极限并发,避免触发站点风控。
 */
export const CONCURRENT_FRAGMENTS = 4

/**
 * 选中 format 的 protocol 是否为分片协议(HLS/DASH)。
 * - 命中 FRAGMENTED_PROTOCOLS(子串包含即算,覆盖 `m3u8_native` 等变体)→ true(不挂 aria2c);
 * - `https` / `http` / 空 / undefined → false(**保守挂 aria2c + 回退,不退化**,§2.5 / §7.1)。
 */
export function isFragmentedProtocol(protocol: string | null | undefined): boolean {
  if (!protocol) return false // 未知 → 保守(挂 aria2c + 回退)
  return FRAGMENTED_PROTOCOLS.some((p) => protocol.includes(p))
}
