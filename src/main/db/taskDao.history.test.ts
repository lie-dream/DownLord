/**
 * searchHistory / historyStats 真 node:sqlite 集成测试(v0.2 Task 5 · spec §8.1「DAO」)。
 *
 * 覆盖:text 双 LIKE(含中文子串 / 特殊字符防注入)、status 单 / 多 / 空数组、category、时间范围端点、
 * 组合 AND、ORDER BY createdAt DESC + LIMIT;统计 GROUP BY + SUM、null→other、**仅 completed**、
 * 三窗口边界 + 累计;以及 §7.3 红线:查询前后 tasks 表逐字段**零变化**。
 *
 * 真实 node:sqlite(经 initDatabase 建表 + 迁移);不可用时优雅跳过(本地纯 node 直跑),
 * CI 经 electron-as-node 恒可用、真跑(仿 migration.integration.test.ts)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { Task } from '../../shared/ipc'
import type { AppDatabase } from './connection'
import { historyStats, insertTask, searchHistory } from './taskDao'

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
  const msg = `[taskDao.history] node:sqlite 不可用(${process.version});须经 electron-as-node 运行(npm test)。`
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-history-'))
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

/** 统计固定 boundaries(直接注入具体数值,与本地时区解耦) */
const BOUNDS = { todayStart: 10_000, weekStart: 5_000, monthStart: 1_000 }

/** seed 一批多状态 / 类别 / 时间的历史记录 */
function seed(db: AppDatabase): void {
  const rows: Task[] = [
    // 视频 completed:今日窗口(completedAt>=today)
    makeTask({
      id: 't1',
      kind: 'video',
      category: 'video',
      status: 'completed',
      filename: '风景大片.mp4',
      source: 'https://bilibili.com/video/av1',
      totalBytes: 1000,
      createdAt: 9000,
      completedAt: 12_000
    }),
    // 视频 completed:本周(非今日)
    makeTask({
      id: 't2',
      kind: 'video',
      category: 'video',
      status: 'completed',
      filename: 'movie.mkv',
      source: 'https://youtube.com/watch?v=2',
      totalBytes: 2000,
      createdAt: 8000,
      completedAt: 7000
    }),
    // 音频 completed:本月(非本周)
    makeTask({
      id: 't3',
      kind: 'http',
      category: 'audio',
      status: 'completed',
      filename: 'song.mp3',
      source: 'https://example.com/song.mp3',
      totalBytes: 500,
      createdAt: 7000,
      completedAt: 2000
    }),
    // category=null completed:早于本月(仅累计)
    makeTask({
      id: 't4',
      category: null,
      status: 'completed',
      filename: 'a_b%c.zip',
      source: 'https://example.com/50%off?q=1;--x',
      totalBytes: 300,
      createdAt: 6000,
      completedAt: 500
    }),
    // error:不计入统计,但可被 status 搜索
    makeTask({
      id: 't5',
      kind: 'video',
      category: 'video',
      status: 'error',
      filename: 'failed.mp4',
      source: 'https://bilibili.com/video/av5',
      totalBytes: 9999,
      createdAt: 5000,
      completedAt: 12_000, // 即便有 completedAt,status!=completed 也不计
      error: 'boom'
    }),
    // downloading:不计入统计
    makeTask({
      id: 't6',
      kind: 'video',
      category: 'video',
      status: 'downloading',
      filename: 'inprogress.mp4',
      source: 'https://youtube.com/watch?v=6',
      totalBytes: 0,
      createdAt: 4000,
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
  const { initDatabase } = await import('./connection')
  let db: AppDatabase | null = null
  try {
    db = initDatabase(path.join(dir, 'downlord.db'))
    seed(db)
    fn(db)
  } finally {
    cleanup(dir, db)
  }
}

test(
  'searchHistory: text 双 LIKE 命中 filename / source(含中文子串)',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      // 中文子串命中 filename
      const cn = searchHistory(db, { text: '风景', limit: 500 })
      assert.deepEqual(
        cn.map((t) => t.id),
        ['t1']
      )
      // 命中 source(站点子串,跨多行 → createdAt DESC 排序)
      const bili = searchHistory(db, { text: 'bilibili', limit: 500 })
      assert.deepEqual(
        bili.map((t) => t.id),
        ['t1', 't5']
      )
      // 命中 filename 扩展名
      const mp3 = searchHistory(db, { text: '.mp3', limit: 500 })
      assert.deepEqual(
        mp3.map((t) => t.id),
        ['t3']
      )
    })
  }
)

test('searchHistory: 防注入 / 特殊字符按字面匹配、不报错', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    // t4 filename='a_b%c.zip':搜 'a_b%c' 应精确命中(_ 与 % 按字面,非通配)
    assert.deepEqual(
      searchHistory(db, { text: 'a_b%c', limit: 500 }).map((t) => t.id),
      ['t4']
    )
    // 单纯 '%' 字面:仅 t4(filename 或 source 含字面 %),不因通配匹配全部
    assert.deepEqual(
      searchHistory(db, { text: '%', limit: 500 }).map((t) => t.id),
      ['t4']
    )
    // '_' 字面:仅 t4
    assert.deepEqual(
      searchHistory(db, { text: '_', limit: 500 }).map((t) => t.id),
      ['t4']
    )
    // SQL 注入样字符串:作为绑定参数按字面搜,命中 t4 source 且不抛
    assert.deepEqual(
      searchHistory(db, { text: ';--x', limit: 500 }).map((t) => t.id),
      ['t4']
    )
    // 反斜杠不报错(无命中)
    assert.doesNotThrow(() => searchHistory(db, { text: 'a\\b', limit: 500 }))
  })
})

test('searchHistory: status 单 / 多值 / 空数组→[]', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    assert.deepEqual(
      searchHistory(db, { status: ['error'], limit: 500 }).map((t) => t.id),
      ['t5']
    )
    const multi = searchHistory(db, { status: ['error', 'downloading'], limit: 500 })
    assert.deepEqual(
      multi.map((t) => t.id),
      ['t5', 't6']
    )
    // 空数组 → 直接返回 []
    assert.deepEqual(searchHistory(db, { status: [], limit: 500 }), [])
  })
})

test('searchHistory: category 精确匹配', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    assert.deepEqual(
      searchHistory(db, { category: 'video', limit: 500 }).map((t) => t.id),
      ['t1', 't2', 't5', 't6']
    )
    assert.deepEqual(
      searchHistory(db, { category: 'audio', limit: 500 }).map((t) => t.id),
      ['t3']
    )
  })
})

test('searchHistory: createdAt 时间范围端点(含端点)', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    // from=7000(含):createdAt>=7000 → t1(9000) t2(8000) t3(7000)
    assert.deepEqual(
      searchHistory(db, { from: 7000, limit: 500 }).map((t) => t.id),
      ['t1', 't2', 't3']
    )
    // to=6000(含):createdAt<=6000 → t4(6000) t5(5000) t6(4000)
    assert.deepEqual(
      searchHistory(db, { to: 6000, limit: 500 }).map((t) => t.id),
      ['t4', 't5', 't6']
    )
    // 区间 [6000,8000]
    assert.deepEqual(
      searchHistory(db, { from: 6000, to: 8000, limit: 500 }).map((t) => t.id),
      ['t2', 't3', 't4']
    )
  })
})

test('searchHistory: 组合 AND(text+status+category+time)', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const r = searchHistory(db, {
      text: 'video',
      status: ['error', 'downloading', 'completed'],
      category: 'video',
      from: 5000,
      to: 12_000,
      limit: 500
    })
    // category=video ∧ (filename|source) 含 'video' ∧ createdAt∈[5000,12000]:
    // t1 source .../video/av1 ✓;t5 source .../video/av5 ✓;
    // t2(source watch?v=2 / movie.mkv)、t6(watch?v=6 / inprogress.mp4)不含子串 'video' → 排除
    assert.deepEqual(
      r.map((t) => t.id),
      ['t1', 't5']
    )
  })
})

test('searchHistory: ORDER BY createdAt DESC + LIMIT 生效', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const all = searchHistory(db, { limit: 500 })
    assert.deepEqual(
      all.map((t) => t.id),
      ['t1', 't2', 't3', 't4', 't5', 't6']
    )
    // LIMIT 截断,取最新两条
    const top2 = searchHistory(db, { limit: 2 })
    assert.deepEqual(
      top2.map((t) => t.id),
      ['t1', 't2']
    )
  })
})

test('historyStats: GROUP BY + SUM、null→other、count 降序', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const s = historyStats(db, BOUNDS)
    const byCat = new Map(s.byCategory.map((c) => [c.category, c]))
    // video: t1(1000)+t2(2000) = 2 条 / 3000;audio: t3 = 1/500;other(null→other): t4 = 1/300
    assert.deepEqual(byCat.get('video'), { category: 'video', count: 2, totalBytes: 3000 })
    assert.deepEqual(byCat.get('audio'), { category: 'audio', count: 1, totalBytes: 500 })
    assert.deepEqual(byCat.get('other'), { category: 'other', count: 1, totalBytes: 300 })
    // error/downloading 不计入 → 无空 key、无 t5(video 9999 不进 video 总量)
    assert.equal(s.byCategory.length, 3)
    // count 降序:首位是 video(2 条)
    assert.equal(s.byCategory[0].category, 'video')
  })
})

test('historyStats: 仅 completed 计入(error/downloading 排除)', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const s = historyStats(db, BOUNDS)
    // 累计:仅 4 条 completed(t1..t4),总量 1000+2000+500+300=3800;9999(error)不计
    assert.deepEqual(s.total, { count: 4, totalBytes: 3800 })
  })
})

test('historyStats: 三窗口边界 + 累计(注入固定 boundaries)', { skip: !SQLITE_OK }, async () => {
  await withDb((db) => {
    const s = historyStats(db, BOUNDS)
    // today: completedAt>=10000 → t1 → 1 / 1000
    assert.deepEqual(s.today, { count: 1, totalBytes: 1000 })
    // week: completedAt>=5000 → t1(12000) t2(7000) → 2 / 3000
    assert.deepEqual(s.week, { count: 2, totalBytes: 3000 })
    // month: completedAt>=1000 → t1 t2 t3(2000) → 3 / 3500
    assert.deepEqual(s.month, { count: 3, totalBytes: 3500 })
    // total: 全部 completed → 4 / 3800
    assert.deepEqual(s.total, { count: 4, totalBytes: 3800 })
  })
})

test('historyStats: 空表返回全零 / 空 byCategory', { skip: !SQLITE_OK }, async () => {
  const dir = makeTempDir()
  const { initDatabase } = await import('./connection')
  let db: AppDatabase | null = null
  try {
    db = initDatabase(path.join(dir, 'downlord.db')) // 不 seed
    const s = historyStats(db, BOUNDS)
    assert.deepEqual(s.total, { count: 0, totalBytes: 0 })
    assert.deepEqual(s.today, { count: 0, totalBytes: 0 })
    assert.deepEqual(s.byCategory, [])
  } finally {
    cleanup(dir, db)
  }
})

test(
  '§7.3 只读:searchHistory / historyStats 调用前后 tasks 表逐字段零变化',
  { skip: !SQLITE_OK },
  async () => {
    await withDb((db) => {
      const before = snapshotTasks(db)
      // 多次多样查询 + 统计
      searchHistory(db, {
        text: '风景',
        status: ['completed'],
        category: 'video',
        from: 1,
        to: 99_999,
        limit: 3
      })
      searchHistory(db, { text: 'a_b%c', limit: 500 })
      searchHistory(db, { status: [], limit: 500 })
      historyStats(db, BOUNDS)
      const after = snapshotTasks(db)
      assert.deepEqual(after, before, 'tasks 表行数与逐字段内容零变化(只读源数据,§7.3)')
    })
  }
)
