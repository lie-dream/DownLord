/**
 * 嗅探资源分流(纯函数,v0.4 Task 5 · spec §4.3)。
 *
 * **本函数是 `classifyLink` 的包装,不是它的分叉** —— 第④层显式回落到它,故「直链扩展名那套
 * 判据」只有一份真源;本函数只补 `classifyLink` 结构上拿不到的那一半:**Content-Type**
 * (`classifyLink` 是纯 URL 函数,拿不到响应头)。
 *
 * 历史边界:v0.4 Task 5 不改 `linkClassify.ts`,当时的手动清单链接缺口留给 backlog #66。
 * v1.0 Task 3 已让该入口直接消费共享流媒体扩展名;本函数四层顺序及单参 fallback 保持不变。
 *
 * 四层**顺序不可换**,逐层的不可省理由写在各自分支上。
 */
import {
  SNIFF_MEDIA_EXTS,
  SNIFF_SEGMENT_CONTENT_TYPES,
  SNIFF_SEGMENT_EXTS,
  SNIFF_STREAM_CONTENT_TYPES,
  SNIFF_STREAM_EXTS
} from '../../shared/sniffMedia'
// ★ 第④层**显式导入并调用** —— 这一行就是「包装而非分叉」的落地形态:
//   直链扩展名清单(`DIRECT_FILE_EXTS`)与已知视频站表只存在于 `linkClassify.ts` 一处。
import { classifyLink } from './linkClassify'

/**
 * 嗅探分流结果。
 *
 * - `video` → 交 yt-dlp(流媒体清单 / 已知视频站)
 * - `http` → 交 aria2(可直接下载的媒体文件)
 * - `segment` → **不受理**(分片,只该被计数,不该成为一条任务)
 * - `unknown` → **不受理**(判不出就不猜)
 */
export type SniffKind = 'video' | 'http' | 'segment' | 'unknown'

const SEGMENT_CONTENT_TYPES: ReadonlySet<string> = new Set(SNIFF_SEGMENT_CONTENT_TYPES)
const STREAM_CONTENT_TYPES: ReadonlySet<string> = new Set(SNIFF_STREAM_CONTENT_TYPES)
const SEGMENT_EXTS: ReadonlySet<string> = new Set(SNIFF_SEGMENT_EXTS)
const STREAM_EXTS: ReadonlySet<string> = new Set(SNIFF_STREAM_EXTS)
const MEDIA_EXTS: ReadonlySet<string> = new Set(SNIFF_MEDIA_EXTS)

/**
 * 取 URL 路径末段的小写扩展名(无扩展名 / 隐藏文件 / URL 非法 → `null`)。
 *
 * ⚠️ **与 `linkClassify.ts` 的 `extractExt` 同构,刻意不共享** —— 共享要改后者(哪怕只是加个
 *    `export`),而后者对 v0.4 Task 5 的承诺是 `git diff` 恒为空。**这是有意的重复,理由写死在这里,
 *    不许被「优化」掉。**
 */
function extractExt(url: string): string | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const lastSeg = pathname.split('/').filter(Boolean).pop()
  if (!lastSeg) return null
  const dot = lastSeg.lastIndexOf('.')
  return dot <= 0 ? null : lastSeg.slice(dot + 1).toLowerCase()
}

/**
 * 据 URL + 响应 Content-Type 判嗅探资源的去向。
 *
 * @param url - 资源地址(**原样**,不剥 query)
 * @param contentType - 响应头 `Content-Type`。协议约定扩展侧已去 charset 并小写;
 *   本函数仍再归一一次 —— 第①层是**防御层**,它挡的是**伪造的载荷**,而伪造者不受协议约定约束。
 */
export function classifySniffed(url: string, contentType: string): { kind: SniffKind } {
  const ct = contentType.split(';')[0].trim().toLowerCase()
  const ext = extractExt(url)

  // ① 分片 —— **不可省的防御层**(spec §4.3 / E6:分片过滤刻意做两遍)。
  //    `Content-Type: video/mp2t` 就是 HLS 的 `.ts` 分片。扩展侧已过滤过一遍,这一层挡的是
  //    **伪造的 `sniff.addSelected`**(本机任何拿到 token 的程序都能直接打这个端点)。
  //    ⚠️ 必须早于第③层:`video/mp2t` 也以 `video/` 开头,顺序一换分片就会被当成直链受理。
  if (SEGMENT_CONTENT_TYPES.has(ct) || (ext !== null && SEGMENT_EXTS.has(ext))) {
    return { kind: 'segment' }
  }

  // ② 流媒体清单 → 交 yt-dlp。无扩展名的清单(`/play?id=123`)只能靠 Content-Type 认出来,
  //    **那正是嗅探不可替代的价值**(带 `.m3u8` 明文后缀的链接用户自己粘贴就行)。
  if (STREAM_CONTENT_TYPES.has(ct) || (ext !== null && STREAM_EXTS.has(ext))) {
    return { kind: 'video' }
  }

  // ③ 可直接下载的媒体文件 → 交 aria2。
  //    ⚠️ **扩展名分支不可省**:CDN 常对 mp4 发 `application/octet-stream`,Content-Type 判不出;
  //    而 **`.mp4` 不在 `linkClassify` 的 `DIRECT_FILE_EXTS` 里**(那份清单是 zip exe msi 7z rar
  //    iso dmg pkg apk pdf mp3),fallback 到第④层会落 `ambiguous` → `unknown` → 不受理。
  //    **少了这层,整个方案在最常见的 mp4 上就不成立**(守卫用例 U-22)。
  if (ct.startsWith('video/') || ct.startsWith('audio/') || (ext !== null && MEDIA_EXTS.has(ext))) {
    return { kind: 'http' }
  }

  // ④ 回落到既有 `classifyLink`(**包装而非分叉**:已知视频站 / 直链扩展名只有这一份真源)。
  //    已知视频站(YouTube / B 站 …)靠它天然命中 `video`。
  //    ⚠️ **刻意不传第二参 `knownFileExts`** —— 那是「用户可改的运行时类别配置」,让嗅探的
  //    安全判定随用户改类别而漂移是不可接受的(守卫用例 U-24)。
  const linked = classifyLink(url)
  if (linked.kind === 'video' || linked.kind === 'http') return { kind: linked.kind }

  // `ambiguous` / `torrent` 一律收敛成 `unknown` → **不受理**。
  // 嗅探路径的输入不是用户手打的 URL(那种场景 UI 有「默认建议 video」的人工兜底),
  // 而是**程序上报的载荷**;判不出就不猜,**拒绝是诚实且安全的**。`torrent` 同理 ——
  // 嗅探不是 BT 入口。
  return { kind: 'unknown' }
}
