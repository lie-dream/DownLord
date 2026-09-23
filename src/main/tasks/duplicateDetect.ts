/**
 * 检测重复下载 —— 查重后端纯函数(v0.2 Task 3 Phase 1 · spec §3.2 / §3.3 / §4.3)。
 *
 * 全部零副作用:磁盘 / 历史经注入(`fileExists` / `listDir` / `isTaken`)传入,便于确定化单测,
 * **不碰 fs、不写 `tasks`**(查重只读源数据,§7.3)。三创建路径接入 / parked / resolve 落地留 Phase 2。
 */
import { basename, dirname, join } from 'node:path'

import type { DuplicateConflictItem, DuplicateExisting, Task } from '../../shared/ipc'

/**
 * 下载残留后缀(与 `videoEngine.cleanPartials` 同款判据):`.part`(半成品)/ `.aria2`(控制文件)/
 * `.ytdl`(分片状态)/ `.part-Frag*`(分片临时)。查重磁盘扫描排除这些,避免把未完成的残留误判为
 * 「已存在同名文件」(spec §3.2)。
 */
function isResidual(name: string): boolean {
  return (
    name.endsWith('.part') ||
    name.endsWith('.aria2') ||
    name.endsWith('.ytdl') ||
    name.includes('.part-Frag')
  )
}

/** 去 basename 最后一个扩展名(`标题 [1080p].mp4` → `标题 [1080p]`;无扩展名 / 前导点文件原样) */
function stemOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 比较 `pathA` 去最后扩展名后的 basename 是否 === `stemB`(spec §3.2)。
 * **忽略 ext 差异**:预测 ext 与真实 ext 可能不同(§1.3),故只比对 stem。
 */
export function sameStem(pathA: string, stemB: string): boolean {
  return stemOfName(basename(pathA)) === stemB
}

/** 非终态(「进行中」= 已在下载列表,查重命中态 active,spec §3.3);`completed` / `error` 为终态 */
const NON_TERMINAL_STATUS: ReadonlySet<Task['status']> = new Set([
  'resolving',
  'awaiting_selection',
  'queued',
  'downloading',
  'paused',
  'processing'
])

export interface DetectConflictInput {
  kind: 'http' | 'video'
  /** 源 URL(与历史任务 `t.source` 精确比对;不做语义 URL 等价,§2.2) */
  source: string
  /** 目标落盘目录(与历史任务 `dirname(t.savePath)` 比对) */
  dir: string
  /** 目标 basename 去扩展名(视频含 `[清晰度]`;同清晰度 → 同 stem,不同清晰度 → 不同 stem 天然不误判) */
  stem: string
  /** 目标落盘扩展名,**含前导点**(如 `.mp4`):http 精确磁盘校验用 `stem+ext`;video 磁盘按 stem 前缀匹配任意 ext(此值仅拼 `filename`) */
  ext: string
  /** 全量历史(`TaskManager.tasks`;只读迭代,不写库) */
  historyTasks: Task[]
  /** 注入:文件是否存在(http 精确路径 / completed 记录 `savePath` 校验) */
  fileExists: (p: string) => boolean
  /** 注入:列目录(video 磁盘 stem 前缀匹配) */
  listDir: (d: string) => string[]
}

/**
 * 提交前查重(纯函数,spec §3.2 / §3.3):按「同源 URL + 同目录 + 同 stem(含清晰度)」查历史 + 磁盘,
 * 命中返回冲突项,否则 `null`。命中态优先级 **completed > diskOnly > active**;`qualityLabel` 直接取自
 * 命中视频任务的 `videoMeta?.qualityLabel`(http 为 null),**不重新推导**。
 *
 * **不误判**(§3.2):不同目录 / 不同清晰度(stem 不同)/ 仅音频 vs 视频(stem 不同)均不命中;
 * `.part`/`.aria2`/`.ytdl`/`.part-Frag` 残留经 `isResidual` 排除。
 */
export function detectConflict(input: DetectConflictInput): DuplicateConflictItem | null {
  const { kind, source, dir, stem, ext, historyTasks, fileExists, listDir } = input

  // 1) 历史扫描:同源 + 同目录 + 同 stem 的另一任务;分类 completed(文件在)/ active(非终态)。
  let matchedTask: Task | null = null // 供 qualityLabel:首个匹配任务(视频取其清晰度标签)
  let completedTask: Task | null = null
  let activeTask: Task | null = null
  for (const t of historyTasks) {
    if (t.source !== source) continue
    if (dirname(t.savePath) !== dir) continue
    if (!sameStem(t.savePath, stem)) continue
    matchedTask = matchedTask ?? t
    if (t.status === 'completed') {
      // completed 且文件在 → 命中 completed;文件缺失则非命中(磁盘扫描或另行命中)。error 终态亦非命中。
      if (fileExists(t.savePath)) completedTask = completedTask ?? t
    } else if (NON_TERMINAL_STATUS.has(t.status)) {
      activeTask = activeTask ?? t
    }
  }

  // 2) 磁盘扫描:http 精确 `stem+ext`;video 目录内非残留 `<stem>.*`(任意 ext,§3.2)。
  let diskPath: string | null = null
  if (kind === 'http') {
    const p = join(dir, stem + ext)
    if (fileExists(p)) diskPath = p
  } else {
    for (const name of listDir(dir)) {
      if (isResidual(name)) continue
      if (sameStem(name, stem)) {
        diskPath = join(dir, name)
        break
      }
    }
  }

  const qualityLabel = kind === 'video' ? (matchedTask?.videoMeta?.qualityLabel ?? null) : null

  // 3) 命中态优先级 completed > diskOnly > active(spec §3.3);都不命中 → null。
  let existing: DuplicateExisting
  let existingPath: string | null
  if (completedTask) {
    existing = 'completed'
    existingPath = completedTask.savePath
  } else if (diskPath) {
    // diskOnly:磁盘有同名文件但无对应 completed 记录(§3.2「若历史无 completed 记录」)
    existing = 'diskOnly'
    existingPath = diskPath
  } else if (activeTask) {
    existing = 'active'
    existingPath = null
  } else {
    return null
  }

  return {
    index: 0,
    filename: stem + ext,
    qualityLabel,
    existingDir: dir,
    existingPath,
    existing
  }
}

/**
 * 重命名序号生成(纯函数,spec §4.3):从 `stem` 起,若 `isTaken(candidateStem)` 则试 `stem (1)`、
 * `stem (2)`…… 直到不冲突返回。序号加在 **stem 末尾**(视频 `标题 [1080p]` → `标题 [1080p] (1)`,
 * `[清晰度]` 之后 / ext 之前);`ext` 由调用方拼(此处返回不含 ext)。`isTaken` 注入 = 磁盘 + 历史
 * 合并判据,便于确定化单测。`ext` 保留在签名(调用点对齐 http/video 拼名)但序号只作用于 stem,
 * 故内部不读(`_ext`)。
 */
export function nextAvailableStem(
  stem: string,
  _ext: string,
  isTaken: (candidateStem: string) => boolean
): string {
  if (!isTaken(stem)) return stem
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (${n})`
    if (!isTaken(candidate)) return candidate
  }
}
