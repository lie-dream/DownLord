/**
 * 保存位置「所见即所存」视图纯函数(渲染层,spec §2)。
 *
 * 对话框 / 格式框据此**镜像**主进程落点,保证「显示目录 ≡ 落盘目录」:
 * - `previewDir` 镜像 main `explicitDirOf`(`dir && dir !== defaultDir ? dir : categoryDir`)——
 *   传值用 `pickedDir ?? defaultDir` sentinel,主进程 `explicitDirOf` 同规则判显式 / 走分类。
 * - `categoryDirForUrl` 取 URL 末段扩展名 → 在 `category:list`(下发解析后真实目录)里找含该 ext 的类 → 其目录。
 *
 * **§7.2 渲染纯 UI**:目录字符串全部来自 `category:list`(main `resolveCategoryDir` 解析);本模块只
 * 「选哪个目录显示」(一次 `!==` 比较 + 本地 ext→类),**绝不拼 `join`、绝不 import main 含 `node:path` 模块**
 * (`categorize` / `categoryModel` 经 `categoryModel` 引 `node:path`,会拖进沙箱渲染包);最终 savePath
 * (join + ensureDir + 落库)仍在主进程 `routeForFilename`。
 */

import type { CategoryConfig } from '../../../shared/ipc'

/**
 * 显示目录 = 镜像 main `explicitDirOf`:用户浏览到「非默认目录」→ 显式覆盖(`pickedDir`);
 * 否则(未浏览 / 选回默认目录)→ 跟随分类目录(`categoryDir`,来自 `category:list`)。
 * 与传值 `pickedDir ?? defaultDir` 同规则,故显示目录 ≡ 落盘目录(spec §2.1 / §2.4)。
 */
export function previewDir(
  pickedDir: string | null,
  defaultDir: string,
  categoryDir: string
): string {
  return pickedDir && pickedDir !== defaultDir ? pickedDir : categoryDir
}

/** 取 URL 末段文件名的小写扩展名(无扩展名 / 隐藏文件 / 非法 URL → null);与 main `extractExt` 同规则 */
function extOfUrl(url: string): string | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const lastSeg = pathname.split('/').filter(Boolean).pop()
  if (!lastSeg) return null
  const dot = lastSeg.lastIndexOf('.')
  if (dot <= 0) return null
  return lastSeg.slice(dot + 1).toLowerCase()
}

/**
 * 直链按扩展名归类目录:取 URL 末段扩展名 → 在 `categories` 找含该 ext 的具体类 → 其解析后真实目录。
 * 无扩展名 / 无匹配类 → `null`(调用方回落 `defaultDir`,等价 main `other` → `defaultDir`,spec §2.2)。
 */
export function categoryDirForUrl(url: string, categories: CategoryConfig[]): string | null {
  const ext = extOfUrl(url)
  if (!ext) return null
  const match = categories.find((c) => c.key !== 'other' && c.extensions.includes(ext))
  return match ? match.savePath : null
}

/** 纯字符串切末位 `/`、`\` 取父目录(无分隔符 → 原样);渲染层 helper,不引 main `node:path`(spec §2.3) */
export function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(0, idx) : path
}

/**
 * torrent 整包落点显示(v0.3 Task 1 · spec §10.3):镜像 main `torrentSaveDir(join(defaultDir,'Torrents'))`——
 * BT 不按扩展名分类,整包落**兜底子目录** `<defaultDir>/Torrents`。**显示专用**(真实 join + ensureDir 在主进程)。
 * §7.2:渲染层不引 `node:path`,按 `defaultDir` 既有分隔符拼「Torrents」子目录(仅一次字符串拼接,非 `join`)。
 */
export function torrentDisplayDir(defaultDir: string): string {
  if (!defaultDir) return 'Torrents'
  const sep = defaultDir.includes('\\') && !defaultDir.includes('/') ? '\\' : '/'
  return `${defaultDir}${sep}Torrents`
}

/**
 * 多文件种子的落点显示(v0.3 Task 2 · spec §7):`<defaultDir>/Torrents/<种子名>`——
 * 多文件种子 aria2 在 `Torrents` 目录内创建以种子名(`torrentMeta.name` = 顶层文件夹名)命名的子目录。
 * **显示专用**(真实 join + ensureDir 在主进程);§7.2 渲染层不引 `node:path`,按既有分隔符拼一次字符串。
 * `name` 空(元数据未全 / 兜底)→ 退回 `torrentDisplayDir`(仅 Torrents 目录)。
 */
export function landingDirForTorrent(defaultDir: string, name: string): string {
  const base = torrentDisplayDir(defaultDir)
  if (!name) return base
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${sep}${name}`
}

/**
 * 视频选格式时的落点(spec §2.3):显式优先,否则随 `audioOnly` 取 audio / video 类目录。
 * 等价 `previewDir(explicitDir, defaultDir, 类目录)`——`explicitDir` 已由 App 预滤为 `null` 或「!== defaultDir」,
 * 故 `explicitDir ?? 类目录` 即镜像 main 落点;类目录来自 `category:list`(无对应类 → 空,实际已加载不发生)。
 */
export function landingDirForVideo(opts: {
  audioOnly: boolean
  categories: CategoryConfig[]
  explicitDir: string | null
}): string {
  if (opts.explicitDir) return opts.explicitDir
  const key = opts.audioOnly ? 'audio' : 'video'
  return opts.categories.find((c) => c.key === key)?.savePath ?? ''
}
