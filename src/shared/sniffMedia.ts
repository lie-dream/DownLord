/**
 * 网页嗅探的媒体识别清单 —— **单一真源**(v0.4 Task 5 · spec §2.2)。
 *
 * 三个扩展名清单 + 两个 Content-Type 清单。扩展侧(`extension/src/sniff/mediaExts.ts`)
 * **手抄同一批字面量**并用本文件导出的 tuple 类型标注 —— 「契约单向穿透」只许 `import type`,
 * 值导入会把主仓代码 bundle 进扩展。**值不能穿透、只能手抄,而 tuple 类型把「手抄错」变成编译期错误**:
 * 这里改一个元素,扩展侧立刻 `typecheck:ext` 红。
 *
 * ⚠️ **三个扩展名清单刻意互不相交** —— 判定因此**不依赖顺序**,也不会出现「`m4s` 既在媒体清单
 *    又在分片清单」这种歧义。`docs/TODO.md` **#11 要求的「识别 m4s」由分片清单承担**:
 *    **识别 ≠ 下载** —— 它的产物是「已聚合 N 片」那句话,不是一条可下载条目。
 *
 * ⚠️ **判据是 OR 不是 AND**(扩展名命中**或** Content-Type 命中):`/play?id=123` 这种无扩展名的
 *    流媒体清单只能靠 Content-Type 认出来,而**那正是嗅探唯一不可替代的价值** ——
 *    带 `.m3u8` 明文后缀的链接用户自己粘贴就行。误报的代价只是「多列一条可以不点」,漏报才是真损失。
 *
 * ⚠️ 本文件**不被 `extension/` 值导入**(eslint `no-restricted-imports` 对 `src/shared/**`
 *    默认禁死,只给 `extensionProtocol` 单点开口;tuple 类型经 `extension/src/contract.ts`
 *    的纯类型 re-export 穿透)。
 */

/**
 * 流媒体清单文件的扩展名 → **视频流**组 → 主进程判 `video`(交 yt-dlp)。
 *
 * **增长口径:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点。**
 * (这行注释刻意贴在常量旁而不是放进文档 —— 约束贴在它约束的东西旁边最不容易失传,
 *  改常量的人一定会看到。)
 */
export const SNIFF_STREAM_EXTS = ['m3u8', 'mpd'] as const
/** 上一行常量的 tuple 类型 —— 扩展侧靠它把手抄值钉死 */
export type SniffStreamExts = typeof SNIFF_STREAM_EXTS
export type SniffStreamExt = SniffStreamExts[number]

/**
 * 可直接下载的媒体文件扩展名 → **媒体文件**组 → 主进程判 `http`(交 aria2)。
 *
 * **增长口径:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点。**
 */
export const SNIFF_MEDIA_EXTS = ['mp4', 'flv', 'mp3', 'm4a', 'webm'] as const
/** 上一行常量的 tuple 类型 */
export type SniffMediaExts = typeof SNIFF_MEDIA_EXTS
export type SniffMediaExt = SniffMediaExts[number]

/**
 * 分片扩展名 → **不进列表,只计数**(嗅探结果里分片流聚合成一条,不逐片罗列)。
 *
 * 放行它们会让每个分片各成一条直链涌进列表,正面违反 `CONTEXT.md`「嗅探」条。
 *
 * **增长口径:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点。**
 */
export const SNIFF_SEGMENT_EXTS = ['ts', 'm4s'] as const
/** 上一行常量的 tuple 类型 */
export type SniffSegmentExts = typeof SNIFF_SEGMENT_EXTS
export type SniffSegmentExt = SniffSegmentExts[number]

/**
 * 流媒体清单的 Content-Type(**已去 charset、已转小写**后的形态)。
 *
 * **增长口径:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点。**
 */
export const SNIFF_STREAM_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml'
] as const
/** 上一行常量的 tuple 类型 */
export type SniffStreamContentTypes = typeof SNIFF_STREAM_CONTENT_TYPES

/**
 * 分片的 Content-Type(**已去 charset、已转小写**后的形态)。`video/mp2t` 就是 HLS 的 `.ts` 分片。
 *
 * **增长口径:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点。**
 */
export const SNIFF_SEGMENT_CONTENT_TYPES = ['video/mp2t'] as const
/** 上一行常量的 tuple 类型 */
export type SniffSegmentContentTypes = typeof SNIFF_SEGMENT_CONTENT_TYPES
