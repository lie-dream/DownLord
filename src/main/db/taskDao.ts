import type {
  HistoryStats,
  HistoryWindowStat,
  Task,
  TaskFilter,
  TaskStatus,
  TorrentMeta,
  VideoMeta
} from '../../shared/ipc'
import { escapeLike } from '../history/historyTime'

interface Statement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface TaskDaoDatabase {
  prepare(sql: string): Statement
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
}

type TaskRow = {
  id: string
  kind: Task['kind']
  source: string
  status: TaskStatus
  filename: string
  savePath: string
  category: string | null
  totalBytes: number
  downloadedBytes: number
  videoMeta: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  torrentMeta: string | null
}

type PersistedTaskField = Exclude<keyof Task, 'speed'>
type TaskUpdates = Partial<Pick<Task, PersistedTaskField>>

const TASK_COLUMNS = [
  'id',
  'kind',
  'source',
  'status',
  'filename',
  'savePath',
  'category',
  'totalBytes',
  'downloadedBytes',
  'videoMeta',
  'error',
  'createdAt',
  'startedAt',
  'completedAt',
  'torrentMeta'
] as const satisfies readonly PersistedTaskField[]

const TASK_COLUMN_SET = new Set<string>(TASK_COLUMNS)

function serializeVideoMeta(videoMeta: VideoMeta | null): string | null {
  return videoMeta === null ? null : JSON.stringify(videoMeta)
}

function parseVideoMeta(value: string | null): VideoMeta | null {
  if (value === null) return null
  try {
    return JSON.parse(value) as VideoMeta
  } catch (err) {
    // 行级损坏不放大为全量失败:quick_check 只校验 B-tree 结构,不校验应用层 JSON——
    // 一行坏 videoMeta 若直接抛出会让 listTasks 整体失败、任务列表永远拉不到。
    // 退化为 null(该任务丢视频元数据标签,远好于列表全灭),原文进日志可追查。
    console.error(`[taskDao] videoMeta JSON 损坏,已退化为 null: ${value}`, err)
    return null
  }
}

function serializeTorrentMeta(torrentMeta: TorrentMeta | null): string | null {
  return torrentMeta === null ? null : JSON.stringify(torrentMeta)
}

function parseTorrentMeta(value: string | null): TorrentMeta | null {
  // == null 同时兜住 null 与 undefined:后者出现在缺 torrentMeta 列的历史行 / 测试桩,
  // 均表「无值」,退化 null 属正常路径,不打损坏日志(真实损坏 = 非空字符串解析失败)。
  if (value == null) return null
  try {
    return JSON.parse(value) as TorrentMeta
  } catch (err) {
    // 与 videoMeta 同策:行级 JSON 损坏退化为 null(该任务丢 BT 元信息标签,远好于列表全灭),原文进日志。
    console.error(`[taskDao] torrentMeta JSON 损坏,已退化为 null: ${value}`, err)
    return null
  }
}

function taskToParams(task: Task): unknown[] {
  return TASK_COLUMNS.map((column) => {
    if (column === 'videoMeta') {
      return serializeVideoMeta(task.videoMeta)
    }

    if (column === 'torrentMeta') {
      return serializeTorrentMeta(task.torrentMeta)
    }

    return task[column]
  })
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    status: row.status,
    filename: row.filename,
    savePath: row.savePath,
    category: row.category,
    totalBytes: row.totalBytes,
    downloadedBytes: row.downloadedBytes,
    speed: 0,
    videoMeta: parseVideoMeta(row.videoMeta),
    torrentMeta: parseTorrentMeta(row.torrentMeta),
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt
  }
}

export function insertTask(db: TaskDaoDatabase, task: Task): Task {
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (${TASK_COLUMNS.join(', ')})
VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`
    ).run(...taskToParams(task))
  })

  insert()

  const inserted = getTask(db, task.id)
  if (!inserted) {
    throw new Error(`Inserted task ${task.id} could not be read back`)
  }

  return inserted
}

export function updateTask(db: TaskDaoDatabase, id: string, updates: TaskUpdates): void {
  const entries = Object.entries(updates).filter(
    ([key, value]) => TASK_COLUMN_SET.has(key) && key !== 'id' && value !== undefined
  )

  if (entries.length === 0) {
    return
  }

  const update = db.transaction(() => {
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ')
    const values = entries.map(([key, value]) => {
      if (key === 'videoMeta') return serializeVideoMeta(value as VideoMeta | null)
      if (key === 'torrentMeta') return serializeTorrentMeta(value as TorrentMeta | null)
      return value
    })

    db.prepare(`UPDATE tasks SET ${assignments} WHERE id = ?`).run(...values, id)
  })

  update()
}

export function deleteTask(db: TaskDaoDatabase, id: string): void {
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  })

  remove()
}

export function getTask(db: TaskDaoDatabase, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined

  return row ? rowToTask(row) : null
}

export function listTasks(db: TaskDaoDatabase, filter: TaskFilter = {}): Task[] {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]

    if (statuses.length === 0) {
      return []
    }

    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

  if (filter.category) {
    conditions.push('category = ?')
    params.push(filter.category)
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM tasks${whereClause} ORDER BY createdAt DESC`)
    .all(...params) as TaskRow[]

  return rows.map(rowToTask)
}

/**
 * 按来源精确查历史(v0.3 Task 4 · #29,spec §4):`WHERE source = ?` 走 `idx_tasks_source`
 * (migration v4),把查重候选集从「全量历史」缩到「同源命中」。**只读**:零 INSERT / UPDATE /
 * DELETE(§7.3);复用 `rowToTask` 投影(`speed` 恒 0;行级 videoMeta / torrentMeta 损坏退化 null,
 * 与 `getTask` / `listTasks` 同策)。
 *
 * **不加 ORDER BY**(与既有查重的内存迭代同为「无序候选集」):`detectConflict` 对候选逐条分类,
 * 命中态优先级 completed > diskOnly > active **与顺序无关**;顺序仅影响「同源 + 同目录 + 同 stem 多条
 * 并存」时取哪一条的 `savePath` / `qualityLabel`——这些字段在该前提下本就同值(stem 含清晰度标签)。
 */
export function findBySource(db: TaskDaoDatabase, source: string): Task[] {
  const rows = db.prepare('SELECT * FROM tasks WHERE source = ?').all(source) as TaskRow[]

  return rows.map(rowToTask)
}

export function batchUpdateStatus(db: TaskDaoDatabase, ids: string[], status: TaskStatus): void {
  if (ids.length === 0) {
    return
  }

  const updateStatus = db.transaction(() => {
    const statement = db.prepare('UPDATE tasks SET status = ? WHERE id = ?')

    for (const id of ids) {
      statement.run(status, id)
    }
  })

  updateStatus()
}

// ==================== 历史检索 / 统计(v0.2 Task 5 · 纯 SELECT / GROUP BY 只读)====================
//
// 红线(ARCHITECTURE §7.3):`searchHistory` / `historyStats` **只读** tasks 表(真实下载历史源数据),
// 零 INSERT / UPDATE / DELETE。时间口径已由 handler 经 `historyTime.ts` 纯函数换算为具体 from/to/边界,
// DAO 只认具体数值,复用 `TaskDaoDatabase` 注入接口 + `rowToTask` 投影。

/** 已解析的具体 SQL 过滤条件(time preset 已由 handler 换算为 from/to,DAO 只认具体值;spec §3.3) */
export interface HistorySqlFilter {
  text?: string
  status?: TaskStatus[]
  category?: string
  from?: number // createdAt >=
  to?: number // createdAt <=
  limit: number // 已 clamp 的上限
}

/**
 * 历史检索(spec §3.2 / §3.3):动态参数化 WHERE(全部 `?` 绑定,零拼接,无注入面)+
 * `ORDER BY createdAt DESC LIMIT ?`。text 双 LIKE(filename / source)配合 `escapeLike` + `ESCAPE '\'`
 * 按字面匹配 % _ \;status 空数组 → 直接 `[]`(对齐 `listTasks` 语义)。结果复用 `rowToTask` 投影。
 */
export function searchHistory(db: TaskDaoDatabase, filter: HistorySqlFilter): Task[] {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.text) {
    const like = `%${escapeLike(filter.text)}%`
    conditions.push(`(filename LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')`)
    params.push(like, like)
  }

  if (filter.status) {
    if (filter.status.length === 0) {
      return []
    }
    conditions.push(`status IN (${filter.status.map(() => '?').join(', ')})`)
    params.push(...filter.status)
  }

  if (filter.category) {
    conditions.push('category = ?')
    params.push(filter.category)
  }

  if (filter.from !== undefined) {
    conditions.push('createdAt >= ?')
    params.push(filter.from)
  }

  if (filter.to !== undefined) {
    conditions.push('createdAt <= ?')
    params.push(filter.to)
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM tasks${whereClause} ORDER BY createdAt DESC LIMIT ?`)
    .all(...params, filter.limit) as TaskRow[]

  return rows.map(rowToTask)
}

/**
 * 历史统计聚合(spec §4.1 / §4.2):**仅 `status='completed'`** 计入,总量 `SUM(totalBytes)`,时间维用
 * `completedAt`。按类别 `GROUP BY COALESCE(category,'other')`(null 归 other)count 降序;三时间窗口
 * (今日 / 本周 / 本月,下界由 `boundaries` 传入,`completedAt >= ?`)+ 累计(无时间条件)。纯 SELECT / GROUP BY。
 */
export function historyStats(
  db: TaskDaoDatabase,
  boundaries: { todayStart: number; weekStart: number; monthStart: number }
): HistoryStats {
  const byCategory = (
    db
      .prepare(
        `SELECT COALESCE(category, 'other') AS category,
                COUNT(*) AS count,
                COALESCE(SUM(totalBytes), 0) AS totalBytes
         FROM tasks
         WHERE status = 'completed'
         GROUP BY COALESCE(category, 'other')
         ORDER BY count DESC`
      )
      .all() as Array<{ category: string; count: number | bigint; totalBytes: number | bigint }>
  ).map((row) => ({
    category: row.category,
    count: Number(row.count),
    totalBytes: Number(row.totalBytes)
  }))

  const windowStat = (fromInclusive?: number): HistoryWindowStat => {
    const clause = fromInclusive !== undefined ? ' AND completedAt >= ?' : ''
    const args = fromInclusive !== undefined ? [fromInclusive] : []
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(totalBytes), 0) AS totalBytes
         FROM tasks WHERE status = 'completed'${clause}`
      )
      .get(...args) as { count: number | bigint; totalBytes: number | bigint }
    return { count: Number(row.count), totalBytes: Number(row.totalBytes) }
  }

  return {
    total: windowStat(),
    today: windowStat(boundaries.todayStart),
    week: windowStat(boundaries.weekStart),
    month: windowStat(boundaries.monthStart),
    byCategory
  }
}
