/**
 * 历史 IPC 编排 集成测试(v0.2 Task 5 · spec §8.2)。
 *
 * 覆盖 `history:search` / `history:stats` handler 的编排主体经真 node:sqlite 往返:seed 多状态 / 类别 /
 * 时间历史 → `runHistorySearch` / `runHistoryStats`(handler 内部编排,注入固定 `now`)→ 断言结果集 + 聚合数值;
 * 并断言源数据**逐字段零变化**(§7.3 只读红线)。
 *
 * 与 `taskDao.history.test.ts`(DAO 只认具体 from/to,直测 SQL)互补:本文件聚焦 **handler 编排增值** ——
 * 时间预设 `today` / `week` / `month` / `custom` 经 `resolveTimeRange` 换算、text `trim`、limit `clampHistoryLimit`
 * 兜底 500,这些 DAO 单测不覆盖(DAO 只吃换算后的具体值)。故用**真实日历锚点**(2026-07-15 周三 · `statWindowStarts`
 * 派生边界)驱动,验证预设窗口过滤与 stats 口径一致。
 *
 * handler 本体依赖 electron `ipcMain`,在 electron-as-node 测试环境下不可直跑(同 `category.ts` / `dialog.ts`),
 * 故测 handler 的可导出编排主体 `runHistorySearch` / `runHistoryStats`(handler 仅薄包装调它们 + 传 `Date.now()`)。
 *
 * 真实 node:sqlite(经 initDatabase 建表 + 迁移);不可用时优雅跳过(本地纯 node 直跑),
 * CI 经 electron-as-node 恒可用、真跑(仿 taskDao.history.test.ts / category.integration.test.ts)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { Task } from '../../shared/ipc'
import type { AppDatabase } from '../db/connection'
import { insertTask } from '../db/taskDao'
import { statWindowStarts } from '../history/historyTime'
import { runHistorySearch, runHistoryStats } from './history'

// ==================== node:sqlite 能力探测(同步、不静态加载)====================
const requireForProbe = createRequire(import.meta.url)
function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (p: string) => { close(): void }
    }
    const probe = new DatabaseSync(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
}
const SQLITE_OK = canLoadSqlite()
if (!SQLITE_OK) {
  const msg = `[history.integration] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

// ==================== 真实日历锚点(2026-07-15 周三 12:00 本地)====================
// 选定周三使 monthStart(7-1) < weekStart(7-13) < todayStart(7-15) < NOW 严格递减:seed 各条落在
// 「今日 / 本周非今日 / 本月非本周 / 早于本月」四个清晰窗口,验证 timePreset 换算与 stats 边界。
const NOW = new Date(2026, 6, 15, 12, 0, 0, 0).getTime()
const { todayStart, weekStart, monthStart } = statWindowStarts(NOW)
const HOUR = 3_600_000
const DAY = 86_400_000

// 前置自检:锚点严格递减(周三保证),否则窗口断言失去意义
if (SQLITE_OK) {
  assert.ok(
    monthStart < weekStart && weekStart < todayStart && todayStart < NOW,
    '锚点须严格递减(monthStart < weekStart < todayStart < NOW)'
  )
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-histipc-'))
}
function cleanup(dir: string, db?: { close(): void } | null): void {
  try {
    db?.close()
  } catch {
    // 已关闭 / 关闭失败不影响清理
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort:Windows 句柄偶发占用,忽略
  }
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: 'id',
    kind: 'http',
    source: 'https://example.com/file',
    status: 'completed',
    filename: 'file.bin',
    savePath: 'D:\\Downloads\\file.bin',
    category: 'other',
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    videoMeta: null,
    torrentMeta: null,
    error: null,
    createdAt: 1000,
    startedAt: null,
    completedAt: null,
    ...over
  }
}

/** seed 一批多状态 / 类别 / 时间(锚点相对量)历史记录 */
function seed(db: AppDatabase): void {
  const rows: Task[] = [
    // 今日 · 视频 completed
    makeTask({
      id: 't1',
      kind: 'video',
      category: 'video',
      status: 'completed',
      filename: '风景大片.mp4',
      source: 'https://bilibili.com/video/av1',
      totalBytes: 1000,
      createdAt: todayStart + 8 * HOUR,
      completedAt: todayStart + 9 * HOUR
    }),
    // 本周非今日 · 视频 completed
    makeTask({
      id: 't2',
      kind: 'video',
      category: 'video',
      status: 'completed',
      filename: 'movie.mkv',
      source: 'https://youtube.com/watch?v=2',
      totalBytes: 2000,
      createdAt: weekStart + 2 * HOUR,
      completedAt: weekStart + 3 * HOUR
    }),
    // 本月非本周 · 音频 completed
    makeTask({
      id: 't3',
      kind: 'http',
      category: 'audio',
      status: 'completed',
      filename: 'song.mp3',
      source: 'https://example.com/song.mp3',
      totalBytes: 500,
      createdAt: monthStart + 2 * HOUR,
      completedAt: monthStart + 3 * HOUR
    }),
    // 早于本月 · category=null completed(仅累计;特殊字符顺带验证不炸)
    makeTask({
      id: 't4',
      category: null,
      status: 'completed',
      filename: 'a_b%c.zip',
      source: 'https://example.com/50%off?q=1;--x',
      totalBytes: 300,
      createdAt: monthStart - 2 * DAY,
      completedAt: monthStart - 2 * DAY + HOUR
    }),
    // 今日 · 视频 error(可被 status 搜,但不计统计)
    makeTask({
      id: 't5',
      kind: 'video',
      category: 'video',
      status: 'error',
      filename: 'failed.mp4',
      source: 'https://bilibili.com/video/av5',
      totalBytes: 9999,
      createdAt: todayStart + 5 * HOUR,
      completedAt: todayStart + 6 * HOUR, // 即便有 completedAt,status!=completed 也不计
      error: 'boom'
    }),
    // 本周非今日 · 视频 downloading(不计统计)
    makeTask({
      id: 't6',
      kind: 'video',
      category: 'video',
      status: 'downloading',
      filename: 'inprogress.mp4',
      source: 'https://youtube.com/watch?v=6',
      totalBytes: 0,
      createdAt: weekStart + 4 * HOUR,
      completedAt: null
    })
  ]
  for (const t of rows) {
    insertTask(db, t)
  }
}

function snapshotTasks(db: AppDatabase): object[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as object[]
  return rows.map((r) => ({ ...r }))
}

async function withDb(fn: (db: AppDatabase) => void): Promise<void> {
  const dir = makeTempDir()
  const { initDatabase } = await import('../db/connection')
  let db: AppDatabase | null = null
  try {
    db = initDatabase(path.join(dir, 'downlord.db'))
    seed(db)
    fn(db)
  } finally {
    cleanup(dir, db)
  }
}

// ==================== history:search 编排往返 ====================

test('runHistorySearch: 无过滤 → 全部,createdAt DESC', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const r = runHistorySearch(db, {}, NOW)
    assert.deepEqual(
      r.map((t) => t.id),
      ['t1', 't5', 't6', 't2', 't3', 't4'],
      '按 createdAt 降序返回全部历史'
    )
  })
})

test(
  'runHistorySearch: timePreset=today/week/month 经 resolveTimeRange 换算过滤(基于 createdAt)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      // today:createdAt >= todayStart → t1 t5(t6 属本周非今日,排除)
      assert.deepEqual(
        runHistorySearch(db, { timePreset: 'today' }, NOW).map((t) => t.id),
        ['t1', 't5']
      )
      // week:createdAt >= weekStart → t1 t5 t6 t2
      assert.deepEqual(
        runHistorySearch(db, { timePreset: 'week' }, NOW).map((t) => t.id),
        ['t1', 't5', 't6', 't2']
      )
      // month:createdAt >= monthStart → t1 t5 t6 t2 t3(t4 早于本月排除)
      assert.deepEqual(
        runHistorySearch(db, { timePreset: 'month' }, NOW).map((t) => t.id),
        ['t1', 't5', 't6', 't2', 't3']
      )
    })
  }
)

test('runHistorySearch: timePreset=custom 透传 from/to(含端点)', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    // custom [monthStart, weekStart+3h]:下界排除 t4,上界排除今日系(t1/t5)与 t6(weekStart+4h)
    const r = runHistorySearch(
      db,
      { timePreset: 'custom', from: monthStart, to: weekStart + 3 * HOUR },
      NOW
    )
    assert.deepEqual(
      r.map((t) => t.id),
      ['t2', 't3'],
      'custom 区间过滤(from/to 均生效)'
    )
  })
})

test(
  'runHistorySearch: text 先 trim 再搜(空白串归 undefined 不搜)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      // 前后空白 → trim → '风景' 命中 t1 filename
      assert.deepEqual(
        runHistorySearch(db, { text: '  风景  ' }, NOW).map((t) => t.id),
        ['t1'],
        'text 经 trim 后按内容命中'
      )
      // 纯空白 → trim → '' → undefined → 不搜 → 全部(等价无 text)
      assert.equal(
        runHistorySearch(db, { text: '   ' }, NOW).length,
        6,
        '纯空白 text 归 undefined,不过滤'
      )
    })
  }
)

test(
  'runHistorySearch: limit 经 clampHistoryLimit 兜底(undefined/0/超大 → 500,具体值截断)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      // undefined → 500 → 全 6 条
      assert.equal(runHistorySearch(db, {}, NOW).length, 6)
      // 0(无效)→ 500 → 全 6 条
      assert.equal(runHistorySearch(db, { limit: 0 }, NOW).length, 6)
      // 超大 → 500 → 全 6 条(不足 500 返回全部)
      assert.equal(runHistorySearch(db, { limit: 99_999 }, NOW).length, 6)
      // 具体值 2 → 截断取最新两条
      assert.deepEqual(
        runHistorySearch(db, { limit: 2 }, NOW).map((t) => t.id),
        ['t1', 't5']
      )
    })
  }
)

test('runHistorySearch: status / category 透传 DAO', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    assert.deepEqual(
      runHistorySearch(db, { status: ['error', 'downloading'] }, NOW).map((t) => t.id),
      ['t5', 't6']
    )
    assert.deepEqual(
      runHistorySearch(db, { category: 'video' }, NOW).map((t) => t.id),
      ['t1', 't5', 't6', 't2']
    )
    // 空 status 数组 → DAO 语义直接返回 []
    assert.deepEqual(runHistorySearch(db, { status: [] }, NOW), [])
  })
})

test(
  'runHistorySearch: 组合 AND(text+status+category+timePreset)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      const r = runHistorySearch(
        db,
        {
          text: 'video', // source .../video/... 命中 t1 t5(youtube watch?v= 不含 'video' 子串)
          status: ['completed', 'error', 'downloading'],
          category: 'video',
          timePreset: 'month'
        },
        NOW
      )
      assert.deepEqual(
        r.map((t) => t.id),
        ['t1', 't5'],
        '多条件 AND 交集'
      )
    })
  }
)

// ==================== history:stats 编排往返 ====================

test(
  'runHistoryStats: 三窗口 + 累计(仅 completed · completedAt 口径,注入 NOW)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      const s = runHistoryStats(db, NOW)
      // 累计:t1..t4 completed(t5 error / t6 downloading 排除)→ 4 / 1000+2000+500+300
      assert.deepEqual(s.total, { count: 4, totalBytes: 3800 })
      // today:completedAt >= todayStart → t1 → 1 / 1000
      assert.deepEqual(s.today, { count: 1, totalBytes: 1000 })
      // week:completedAt >= weekStart → t1 t2 → 2 / 3000
      assert.deepEqual(s.week, { count: 2, totalBytes: 3000 })
      // month:completedAt >= monthStart → t1 t2 t3 → 3 / 3500
      assert.deepEqual(s.month, { count: 3, totalBytes: 3500 })
    })
  }
)

test(
  'runHistoryStats: byCategory GROUP BY + SUM、null→other、count 降序',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      const s = runHistoryStats(db, NOW)
      const byCat = new Map(s.byCategory.map((c) => [c.category, c]))
      assert.deepEqual(byCat.get('video'), { category: 'video', count: 2, totalBytes: 3000 })
      assert.deepEqual(byCat.get('audio'), { category: 'audio', count: 1, totalBytes: 500 })
      assert.deepEqual(byCat.get('other'), { category: 'other', count: 1, totalBytes: 300 })
      assert.equal(s.byCategory.length, 3, 'error/downloading 不计 → 无额外分组')
      assert.equal(s.byCategory[0].category, 'video', 'count 降序:video 居首')
    })
  }
)

// ==================== §7.3 只读红线:编排往返前后 tasks 表零变化 ====================

test(
  '§7.3 只读:runHistorySearch / runHistoryStats 往返前后 tasks 表逐字段零变化',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      const before = snapshotTasks(db)
      // 覆盖各分支多次往返
      runHistorySearch(db, { text: '  风景  ', timePreset: 'week', limit: 3 }, NOW)
      runHistorySearch(db, { timePreset: 'custom', from: monthStart, to: NOW }, NOW)
      runHistorySearch(db, { status: [], category: 'video' }, NOW)
      runHistoryStats(db, NOW)
      const after = snapshotTasks(db)
      assert.deepEqual(after, before, 'tasks 表行数与逐字段内容零变化(只读源数据,§7.3)')
    })
  }
)
