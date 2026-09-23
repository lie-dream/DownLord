/**
 * 扩展名 → 类别判定 + 目录路由(纯函数,无 I/O;spec §3)。
 * 直链(http)任务与视频任务共用同一判定;视频按最终输出容器归类(mp4→video / mp3→audio)。
 * 不起子进程、不碰文件系统、不碰网络。
 */
import { join } from 'node:path'
import { CATEGORY_KEYS, categorySubdir, type CategoryDef } from './categoryModel'

/**
 * 取末尾扩展名:小写、无前导 `.`。
 * 边界(spec §3.3):无点 / 末尾点 / 仅前导点的隐藏文件 → `''`。
 */
export function extractExt(filename: string): string {
  const dot = filename.lastIndexOf('.')
  // dot < 0:无点;dot === 0:隐藏文件(如 .bashrc),前导点不算扩展名
  if (dot <= 0) {
    return ''
  }
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * 规范化用户输入的扩展名清单(权威规范化,spec §5.2):逐项
 * **trim → 小写 → 去前导点 → 再 trim**,丢弃空项,最后**去重保序**(保留首次出现位置)。
 *
 * 顺序按鲁棒性安排(先 trim 使 `' .MP4 '` 的前导点紧贴后才好剥离),
 * 结果满足 spec 列举的全部属性(小写 / 无前导点 / 无首尾空白 / 非空 / 去重保序)。
 * 渲染层可做轻量同款回显,但落库前由主进程 `updateCategory` 再调一次为准(§7.2)。
 */
export function normalizeExtensions(exts: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of exts) {
    const ext = raw
      .trim() // 先去首尾空白,使前导点紧贴(' .mp4 ' → '.mp4')
      .toLowerCase() // 小写
      .replace(/^\.+/, '') // 去前导点(.mp4 / ..mp4 → mp4)
      .trim() // 去剥点后可能残留的空白
    if (ext === '' || seen.has(ext)) {
      continue // 去空 + 去重
    }
    seen.add(ext)
    result.push(ext)
  }
  return result
}

/**
 * 由类别配置构建 `ext → key` 反向索引。
 * 按 `CATEGORY_KEYS` 顺序遍历,**先定义者优先**;重复 ext 记 `console.warn`(视为配置错误,不抛不崩)。
 * MVP 默认数据无冲突;冲突仅在用户改配置时可能出现(Task 8)。
 */
export function buildExtIndex(categories: CategoryDef[]): Map<string, string> {
  const byKey = new Map(categories.map((c) => [c.key, c]))
  const index = new Map<string, string>()
  for (const key of CATEGORY_KEYS) {
    const cat = byKey.get(key)
    if (!cat) {
      continue
    }
    for (const rawExt of cat.extensions) {
      const ext = rawExt.toLowerCase()
      if (index.has(ext)) {
        console.warn(
          `[category] 扩展名 "${ext}"(类别 "${key}")与已有类别 "${index.get(ext)}" 冲突,已忽略,沿用先定义者`
        )
        continue
      }
      index.set(ext, key)
    }
  }
  return index
}

/** 文件名 → category key;未知 / 无扩展名 / 未命中 → `'other'`。 */
export function categorize(filename: string, extIndex: Map<string, string>): string {
  const ext = extractExt(filename)
  if (!ext) {
    return 'other'
  }
  return extIndex.get(ext) ?? 'other'
}

/**
 * category key → 保存目录(实时计算,spec §1.3)。
 * - `savePath` 非空 → 自定义绝对路径,原样返回(覆盖);
 * - `savePath` 空 / 找不到 key → 跟随默认目录:`join(defaultDir, categorySubdir(key))`;
 * - `other` / 未知 key(子目录空)→ `defaultDir` 本身(兜底)。
 *
 * 不再读 seed 时烤死的绝对路径:改默认目录后,未自定义类别下一次路由即按新 `defaultDir` 跟随。
 */
export function resolveCategoryDir(
  key: string,
  categories: CategoryDef[],
  defaultDir: string
): string {
  const cat = categories.find((c) => c.key === key)
  if (cat && cat.savePath) {
    return cat.savePath
  }
  const sub = categorySubdir(key)
  return sub ? join(defaultDir, sub) : defaultDir
}
