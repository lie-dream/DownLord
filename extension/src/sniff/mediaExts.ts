/**
 * 嗅探清单的**扩展侧手抄件**(v0.4 Task 5 · spec §2.2)。
 *
 * **为什么是手抄字面量而不是值导入**:「契约单向穿透」只许 `import type`,值导入会把主仓代码
 * bundle 进扩展(断言 A9 当场变红)。于是**值不能穿透、只能手抄** —— 而下面每个常量都带了
 * 主仓那侧的 **tuple 类型标注**,把「手抄错」变成**编译期错误**:
 * 主仓 `src/shared/sniffMedia.ts` 改一个元素(增删或改写),这里立刻 `typecheck:ext` 红。
 * (这是 Task 3 `channel/protocol.ts` 那套「字面量钉死」手法的推广。)
 *
 * ⚠️ **命名陷阱(Task 3 踩过同款)**:产物级断言会检查「产物不含主仓标识符」。故扩展侧常量
 *    **不得与主仓同名** —— 主仓用 `SNIFF_` 前缀,这里一律不带前缀。图省事抄成
 *    `SNIFF_MEDIA_EXTS` 会让 `build.test.ts` 的 A9′ 当场变红。
 *
 * ⚠️ **增长口径**:按实测数据驱动增长,新增须在该 Task 的 spec 记录出处与站点 ——
 *    且必须**两侧一起改**(只改这边,tuple 类型立刻拦下)。
 */
import type {
  SniffMediaExts,
  SniffSegmentContentTypes,
  SniffSegmentExts,
  SniffStreamContentTypes,
  SniffStreamExts
} from '../contract'

/** 流媒体清单文件 → **视频流**组。类型钉死主仓的 `SNIFF_STREAM_EXTS` */
export const STREAM_EXTS: SniffStreamExts = ['m3u8', 'mpd']

/** 可直接下载的媒体文件 → **媒体文件**组。类型钉死主仓的 `SNIFF_MEDIA_EXTS` */
export const MEDIA_EXTS: SniffMediaExts = ['mp4', 'flv', 'mp3', 'm4a', 'webm']

/** 分片 → **不进列表,只计数**。类型钉死主仓的 `SNIFF_SEGMENT_EXTS` */
export const SEGMENT_EXTS: SniffSegmentExts = ['ts', 'm4s']

/** 流媒体清单的 Content-Type(归一后形态)。类型钉死主仓的 `SNIFF_STREAM_CONTENT_TYPES` */
export const STREAM_CONTENT_TYPES: SniffStreamContentTypes = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml'
]

/** 分片的 Content-Type(归一后形态)。类型钉死主仓的 `SNIFF_SEGMENT_CONTENT_TYPES` */
export const SEGMENT_CONTENT_TYPES: SniffSegmentContentTypes = ['video/mp2t']
