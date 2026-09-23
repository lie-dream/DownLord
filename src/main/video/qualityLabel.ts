/**
 * 格式选择 → 友好清晰度标签(纯函数,spec §3.1)。
 *
 * 把用户 / 自动的 `FormatChoice`(+ 手选时已 find 出的 `ResolvedFormat`)归一为一行可读清晰度:
 * - 仅音频 → 「仅音频 MP3」;
 * - 手选具体格式(format.height 已知)→ 精确 `${height}P`;
 * - 自动按封顶(heightCap)→ ≥2160 视为「最高」,否则 `≤${cap}P`;
 * - 无约束兜底 → 「最高」。
 *
 * 仅用于 UI 友好展示(写入 `videoMeta.qualityLabel`),不参与格式选择 / 下载逻辑。
 */
import type { FormatChoice, ResolvedFormat } from '../../shared/ipc'

export function qualityLabelOf(choice: FormatChoice, format?: ResolvedFormat): string {
  if (choice.audioOnly) return '仅音频 MP3'
  if (format?.height) return `${format.height}P` // 手选具体格式 → 精确清晰度(ResolvedFormat.height)
  if (choice.heightCap) return choice.heightCap >= 2160 ? '最高' : `≤${choice.heightCap}P` // 自动按封顶
  return '最高' // 无约束兜底
}

/**
 * 文件名清晰度短标(纯函数,2026-07-01 手测暴露:同一视频不同清晰度用同一文件名 →
 * yt-dlp 遇已存在文件跳过 → 假「完成」0B + 覆盖旧文件)。与 `qualityLabelOf` 同源分支,
 * 产出**文件名安全**短标(方括号由调用方拼 `标题 [<tag>].ext`):
 * - 仅音频 → `null`(音频落 `标题.mp3`,扩展名已与视频 mp4 区分、不冲突,不加标签);
 * - 手选具体格式(`format.height`)→ `${height}p`(如 `1080p`);
 * - 自动封顶(`heightCap`)→ ≥2160「最高」/ 否则 `${cap}p`;
 * - 兜底 → 「最高」。
 * 不含 Windows 非法字符(`≤` 不用于此,改纯数字 + p / 「最高」),可直接进文件名。
 */
export function qualityTag(choice: FormatChoice, format?: ResolvedFormat): string | null {
  if (choice.audioOnly) return null
  if (format?.height) return `${format.height}p`
  if (choice.heightCap) return choice.heightCap >= 2160 ? '最高' : `${choice.heightCap}p`
  return '最高'
}

/**
 * `formats` 中实际可下的最高 height(纯函数,v0.3 Task 4 · #30 · spec §5)。
 *
 * 「自动 / 最高 / 封顶」选择只有下载意图、无具体 formatId,其字面标签(「最高」/「≤NP」)与
 * 「手选具体 NP」产出不同文件名 stem → 同内容下成两份、查重(§3.2 按 stem 判定)不命中。
 * 本函数把 `resolved.formats` 的实际最高 height 归一出来,由调用点喂 `qualityTag` / `qualityLabelOf`
 * 产出**具体** `${height}p` 标签(**命名函数逻辑不改**),与手选同 height 一致 → 查重命中。
 *
 * - `heightCap` 有值 → 取 ≤cap 的实际最高(视频有 1080/360、cap 720 → 360;视频最高 720 < cap 1080 → 720);
 * - `heightCap` 空 / null → 全局最高;
 * - 无任何有效 video 流 height(纯音频 / 批量无 formats / cap 排除所有)→ null(调用点回落原「最高」,诚实盲区,§5)。
 */
export function resolvedTopHeight(
  formats: ResolvedFormat[],
  heightCap?: number | null
): number | null {
  const heights = formats
    .map((f) => f.height)
    .filter((h): h is number => h != null && (heightCap == null || h <= heightCap))
  return heights.length ? Math.max(...heights) : null
}
