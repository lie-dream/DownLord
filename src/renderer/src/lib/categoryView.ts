/**
 * 类别 UI 视图映射(渲染层纯函数,spec §2.3)。
 *
 * 「一处定义两处复用」中 icon 是**另一类来源**:不落库,按 key 在此映射。
 * - `categoryLabel`:'all' + 6 类的静态默认文案(= 原型 chips / DEFAULT_CATEGORIES displayName);
 *   chips 的 6 类文案优先取 `category:list` 的 displayName(可在 Task 8 改名),本表为 'all' 文案与静态兜底。
 * - `categoryIconClass`:category key → `TaskRow` 的 `.t-icon` 类(video/audio/file),**与任务行图标同源**,
 *   改图标只改这一处常量(spec §2.3)。
 */
import type { CategoryKey } from '../../../main/category/categoryModel'
import type { CategoryFilterKey } from './categoryFilter'

/** 与 `TaskRow` `iconCategory` 的文件类图标同源(error 态属任务行,不在类别映射内) */
export type CategoryIconClass = 'video' | 'audio' | 'file'

const LABELS: Record<CategoryFilterKey, string> = {
  all: '全部',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
  document: '文档',
  program: '程序',
  other: '其他'
}

/** category key(含 'all')→ 静态默认文案 */
export function categoryLabel(key: CategoryFilterKey): string {
  return LABELS[key]
}

/** category key → TaskRow 同源图标类:video/audio 专属,其余(archive/document/program/other)复用文件图标 */
export function categoryIconClass(key: CategoryKey): CategoryIconClass {
  switch (key) {
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    default:
      return 'file'
  }
}
