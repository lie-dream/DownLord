/**
 * Category 模型与默认类别 / 扩展名清单(纯定义,spec §2.1 / §2.2)。
 *
 * 一处定义两处复用:extensions 驱动判定、savePath 驱动分类保存、displayName 驱动 chips。
 * icon **不在此**(不落库,渲染层按 key 映射,spec §2.3)。
 */

/** 持久化模型(= categories 表一行)。 */
export interface CategoryDef {
  key: string
  displayName: string
  extensions: string[]
  savePath: string
}

/** 稳定枚举主键 + 判定优先级顺序(先定义者优先,spec §3.2)。 */
export const CATEGORY_KEYS = ['video', 'audio', 'archive', 'document', 'program', 'other'] as const
export type CategoryKey = (typeof CATEGORY_KEYS)[number]

/** 默认类别(相对子目录 + 扩展名清单,seed 时拼 savePath;spec §2.2)。 */
interface DefaultCategory {
  key: CategoryKey
  displayName: string
  /** 相对默认下载目录的子目录;other 为空串(兜底到 defaultDir)。 */
  subdir: string
  /** 小写、无 `.`;other 为空数组(判定兜底,不靠扩展名命中)。 */
  extensions: string[]
}

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  {
    key: 'video',
    displayName: '视频',
    subdir: 'Videos',
    extensions: [
      'mp4',
      'mkv',
      'avi',
      'mov',
      'flv',
      'wmv',
      'webm',
      'm4v',
      'mpg',
      'mpeg',
      'ts',
      '3gp'
    ]
  },
  {
    key: 'audio',
    displayName: '音频',
    subdir: 'Music',
    extensions: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'alac']
  },
  {
    key: 'archive',
    displayName: '压缩包',
    subdir: 'Archives',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso']
  },
  {
    key: 'document',
    displayName: '文档',
    subdir: 'Documents',
    extensions: [
      'pdf',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'ppt',
      'pptx',
      'txt',
      'csv',
      'epub',
      'rtf',
      'md'
    ]
  },
  {
    key: 'program',
    displayName: '程序',
    subdir: 'Programs',
    extensions: ['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage']
  },
  { key: 'other', displayName: '其他', subdir: '', extensions: [] }
]

/**
 * key → 标准子目录(从 `DEFAULT_CATEGORIES.subdir` 派生,单一来源;spec §1.2)。
 * 未知 key / `other` → `''`(空 = 跟随默认目录本身,不另起子目录)。
 */
export function categorySubdir(key: string): string {
  return DEFAULT_CATEGORIES.find((c) => c.key === key)?.subdir ?? ''
}

/**
 * seed 用默认 `CategoryDef[]`:`savePath` 恒 `''`(= 「跟随默认目录」干净初值;spec §1.2)。
 * 不再烤死绝对路径、不再依赖 `defaultDir`——运行时由 `resolveCategoryDir` 按当前默认目录实时解析,
 * 改默认目录即跟随,无需任何「同步」步骤(取代并移除 C2,spec §1.3 / §1.5)。
 */
export function defaultCategoryDefs(): CategoryDef[] {
  return DEFAULT_CATEGORIES.map((c) => ({
    key: c.key,
    displayName: c.displayName,
    extensions: [...c.extensions],
    savePath: ''
  }))
}
