/**
 * v2 数据迁移 集成测试 — Task 8.5 Phase 1(spec §1.6 / §7.2,ARCHITECTURE §7.3 红线)。
 *
 * v2 迁移 `UPDATE categories SET savePath=''`:把存量「绝对路径烤死」重置为「空 = 跟随默认目录」语义。
 * 红线(§7.3):迁移**只动 categories(可重建派生配置)、零触碰 tasks(真实下载历史源数据)**——
 * 本测试逐字段断言 tasks 行在迁移前后字节级不变。
 *
 * 真实 node:sqlite(经 initDatabase 建表 + 跑迁移);不可用时优雅跳过(本地纯 node 直跑),
 * CI 经 electron-as-node 恒可用、真跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { AppDatabase } from './connection'
import type { TaskDaoDatabase } from './taskDao'

// ==================== 原生模块能力探测(同步、不静态加载)====================

const requireForProbe = createRequire(import.meta.url)

function canLoadSqlite(): boolean {
  try {
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (path: string) => { close(): void }
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
  const msg =
    `[migration.integration] node:sqlite 不可用(${process.version});` +
    ' 须经 electron-as-node 运行(npm test)。'
  if (process.env.CI) {
    throw new Error(`${msg} CI 要求真跑,判定为运行时配置错误。`)
  }
  console.log(`${msg} 本地优雅跳过。`)
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'downlord-migration-'))
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

/** tasks 行(真实历史源数据样本,逐字段断言迁移不动) */
const TASK_ROW = {
  id: 't1',
  kind: 'http',
  source: 'https://x/a.zip',
  status: 'completed',
  filename: 'a.zip',
  savePath: 'D:\\Old\\Archives\\a.zip',
  category: 'archive',
  totalBytes: 123,
  downloadedBytes: 123,
  videoMeta: null as string | null,
  error: null as string | null,
  createdAt: 1000,
  startedAt: 1000,
  completedAt: 2000,
  torrentMeta: null as string | null
}

test(
  'v2 迁移:重置 categories.savePath="" + tasks 行逐字段零变化(§7.3)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { runMigrations } = await import('./migration')

    let db: AppDatabase | null = null
    try {
      // 1) 建库(跑 v1 建表 + v2)→ 手动写入「存量」:绝对路径分类 + 真实历史 tasks 行
      db = initDatabase(dbPath)
      db.prepare(
        'INSERT INTO categories (key, displayName, extensions, savePath) VALUES (?, ?, ?, ?)'
      ).run('video', '视频', '["mp4"]', 'D:\\Old\\Videos')
      db.prepare(
        `INSERT INTO tasks (id, kind, source, status, filename, savePath, category,
        totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        TASK_ROW.id,
        TASK_ROW.kind,
        TASK_ROW.source,
        TASK_ROW.status,
        TASK_ROW.filename,
        TASK_ROW.savePath,
        TASK_ROW.category,
        TASK_ROW.totalBytes,
        TASK_ROW.downloadedBytes,
        TASK_ROW.videoMeta,
        TASK_ROW.error,
        TASK_ROW.createdAt,
        TASK_ROW.startedAt,
        TASK_ROW.completedAt
      )

      // 2) 模拟「存量库停在 v1」:删掉已应用的 v2 及以上标记(v3 于 v0.3 加入,initDatabase 已一并应用),
      //    使 runMigrations 重新应用 v2(+v3)。核心验证点仍是 v2 的 categories 重置 + tasks 源数据零丢失。
      db.prepare('DELETE FROM schema_version WHERE version >= 2').run()
      const verBefore = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number
      }
      assert.equal(verBefore.v, 1, '前置:库停在 version=1(待 v2)')

      // 基线快照:tasks 行迁移前
      const taskBefore = db.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK_ROW.id)

      // 3) 跑迁移 → v2 应用
      runMigrations(db)

      // categories.savePath 被重置为 ''(绝对路径烤死 → 跟随语义)
      const cat = db.prepare('SELECT savePath FROM categories WHERE key = ?').get('video') as {
        savePath: string
      }
      assert.equal(cat.savePath, '', 'v2 重置 categories.savePath = ""(跟随语义)')
      const verAfter = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number
      }
      assert.equal(verAfter.v, 4, '迁移后 version=4(v2 + v3 + v4 重新应用)')

      // §7.3 红线:tasks 行逐字段字节级不变(迁移零触碰源数据)
      const taskAfter = db.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK_ROW.id)
      assert.deepEqual(taskAfter, taskBefore, 'tasks 行迁移前后逐字段完全一致(源数据零触碰)')
      // 各字段值 = 写入原值(展开成普通对象再比,绕过 node:sqlite 行的 null-prototype 差异)
      assert.deepEqual(
        { ...(taskAfter as object) },
        TASK_ROW,
        'tasks 行各字段值 = 写入原值(无任何改写)'
      )
    } finally {
      cleanup(dir, db)
    }
  }
)

// ==================== v3 迁移(v0.3 Task 1 · spec §3.5,ARCHITECTURE §7.3 头号红线)====================
//
// v3 = kind 加 'torrent' + 新增 torrentMeta 列,须**重建 tasks 表**(SQLite 无法原地改 CHECK)。
// 红线:迁移**前主动备份** + 事务内重建 + 迁移后**逐字段零数据丢失断言**。为真实覆盖「旧 CHECK 表 → 重建」
// 路径,手工用 node:sqlite 建**旧 CHECK**(仅 http/video)tasks 表 + schema_version=2(模拟 v0.2 存量库),
// 再经 initDatabase 触发迁移前备份 + runMigrations 应用 v3。

/** node:sqlite 原生句柄(建旧 schema 用;仅在 SQLITE_OK 时调用) */
interface RawSqlite {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown }
  close(): void
}

/** 旧 CHECK(仅 http/video)tasks 表 DDL —— v0.2 存量库形态,无 torrentMeta 列 */
const LEGACY_V2_SCHEMA = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  filename TEXT NOT NULL,
  savePath TEXT NOT NULL,
  category TEXT,
  totalBytes INTEGER DEFAULT 0,
  downloadedBytes INTEGER DEFAULT 0,
  videoMeta TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  completedAt INTEGER,
  CHECK(kind IN ('http', 'video')),
  CHECK(status IN ('resolving','awaiting_selection','queued','downloading','paused','processing','completed','error'))
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);
CREATE TABLE categories (
  key TEXT PRIMARY KEY,
  displayName TEXT NOT NULL,
  extensions TEXT NOT NULL,
  savePath TEXT NOT NULL
);
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);`

/** 存量真实历史行(旧 14 列):http(videoMeta null 边界)+ video(videoMeta JSON + startedAt/completedAt null 边界) */
const LEGACY_ROWS = [
  {
    id: 't-http',
    kind: 'http',
    source: 'https://x/a.zip',
    status: 'completed',
    filename: 'a.zip',
    savePath: 'D:\\Old\\Archives\\a.zip',
    category: 'archive',
    totalBytes: 123,
    downloadedBytes: 123,
    videoMeta: null as string | null,
    error: null as string | null,
    createdAt: 1000,
    startedAt: 1000 as number | null,
    completedAt: 2000 as number | null
  },
  {
    id: 't-video',
    kind: 'video',
    source: 'https://y/watch?v=1',
    status: 'error',
    filename: 'v.mp4',
    savePath: 'D:\\Old\\Videos\\v.mp4',
    category: 'video',
    totalBytes: 0,
    downloadedBytes: 0,
    videoMeta: '{"title":"V"}' as string | null,
    error: 'boom' as string | null,
    createdAt: 1500,
    startedAt: null as number | null,
    completedAt: null as number | null
  }
]

const LEGACY_COLUMNS = [
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
  'completedAt'
] as const

/** 15 列 tasks INSERT(含 torrentMeta)—— v3 迁移后表用,验证新 CHECK / torrentMeta 落库 */
const INSERT_15 = `INSERT INTO tasks (
  id, kind, source, status, filename, savePath, category, totalBytes, downloadedBytes,
  videoMeta, error, createdAt, startedAt, completedAt, torrentMeta
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function backupFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.startsWith('downlord.db.backup.pre-migration.'))
}

test(
  'v3 迁移:旧 CHECK 存量表重建 → 逐字段零丢失 + 迁移前备份 + torrent 可插 / bogus 拒 + 3 索引(§7.3)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    // 1) 手工建**旧 CHECK**(仅 http/video)存量库 + schema_version=2 + 真实历史行(node:sqlite 原生,绕过 v1 新 schema)
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (p: string) => RawSqlite
    }
    const raw = new DatabaseSync(dbPath)
    const beforeById = new Map<string, Record<string, unknown>>()
    try {
      raw.exec(LEGACY_V2_SCHEMA)
      raw.prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)').run(1, 1)
      raw.prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)').run(2, 2)
      const insert14 = raw.prepare(
        `INSERT INTO tasks (${LEGACY_COLUMNS.join(', ')}) VALUES (${LEGACY_COLUMNS.map(() => '?').join(', ')})`
      )
      for (const row of LEGACY_ROWS) {
        insert14.run(...LEGACY_COLUMNS.map((c) => (row as Record<string, unknown>)[c]))
      }
      // 迁移前快照(展开成普通对象,绕过 null-prototype 差异)
      for (const row of LEGACY_ROWS) {
        beforeById.set(row.id, {
          ...(raw.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) as object)
        })
      }
    } finally {
      raw.close() // 释放句柄,交给 initDatabase 重开(Windows 下删/改需先关)
    }

    let db: AppDatabase | null = null
    try {
      // 2) initDatabase → enableWal → 迁移前主动备份(currentVersion=2 ≥1 且 <3)→ runMigrations 应用 v3
      db = initDatabase(dbPath)

      // §3.4:存量库(v2)升级前主动预备份文件已生成
      assert.ok(backupFiles(dir).length >= 1, '迁移前主动备份文件已生成(§3.4)')

      // version 收敛到 3
      const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      assert.equal(ver.v, 4, '迁移后 version=4(v3 重建 + v4 索引)')

      // 行数不变
      const count = db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
      assert.equal(count.c, LEGACY_ROWS.length, '迁移后行数不变(源数据零丢失)')

      // §7.3 核心:每行逐字段字节级零变化 + 新列 torrentMeta = null
      for (const row of LEGACY_ROWS) {
        const after = { ...(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) as object) }
        assert.deepEqual(
          after,
          { ...beforeById.get(row.id), torrentMeta: null },
          `${row.id} 迁移前后逐字段零变化(新列 torrentMeta=null)`
        )
      }

      // 新 CHECK 生效:kind='torrent' 可插 + torrentMeta 落库
      const meta = '{"name":"Release","infoHash":"abc","files":[]}'
      db.prepare(INSERT_15).run(
        't-bt',
        'torrent',
        'magnet:?xt=urn:btih:abc',
        'downloading',
        'Release',
        'D:\\Downloads\\Torrents\\Release',
        'other',
        0,
        0,
        null,
        null,
        3000,
        3000,
        null,
        meta
      )
      const bt = db.prepare('SELECT kind, torrentMeta FROM tasks WHERE id = ?').get('t-bt') as {
        kind: string
        torrentMeta: string
      }
      assert.equal(bt.kind, 'torrent', 'kind=torrent 插入成功(新 CHECK 放行)')
      assert.equal(bt.torrentMeta, meta, 'torrentMeta 落库字节一致')

      // 非法 kind 被 CHECK 拒绝
      assert.throws(
        () => {
          db!
            .prepare(INSERT_15)
            .run(
              't-bogus',
              'bogus',
              'https://z',
              'queued',
              'z',
              'D:\\z',
              'other',
              0,
              0,
              null,
              null,
              4000,
              null,
              null,
              null
            )
        },
        /CHECK|constraint/i,
        'kind=bogus 被 CHECK 拒绝'
      )

      // 3 索引重建存在
      const indexNames = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
          .all() as {
          name: string
        }[]
      ).map((r) => r.name)
      for (const idx of ['idx_tasks_status', 'idx_tasks_category', 'idx_tasks_createdAt']) {
        assert.ok(indexNames.includes(idx), `索引 ${idx} 重建存在`)
      }
    } finally {
      cleanup(dir, db)
    }
  }
)

// ==================== v4 迁移(v0.3 Task 4 · #29 · spec §4,ARCHITECTURE §3.3 / §7.3)====================
//
// v4 = 查重 `source` 索引:**唯一 DDL 是一条 `CREATE INDEX`**——不动任何 tasks 行、不改表结构、不动 CHECK。
// 为真实覆盖「存量 v3 库 → v4」路径,手工用 node:sqlite 建 **v3 形态**库(15 列 + 3 索引 + kind 含 torrent)
// + `schema_version` = 1/2/3 + 真实历史行,再经 initDatabase 触发迁移前主动备份 + runMigrations 应用 v4。
//
// 断言四件套:① `MAX(version)=4` ② 逐行 `deepEqual(after, before)` **字节级零变化**——索引迁移连「新列补
// 默认」都不需要,故 after 与 before **完全相等**(不像 v3 需补 `torrentMeta: null`)③ `idx_tasks_source`
// ∈ `sqlite_master` ④ `EXPLAIN QUERY PLAN` 证查询计划**实走**该索引(杜绝「建了没人用」的死索引)。

/** v3 形态 tasks 表 DDL(15 列 + 新 CHECK + 3 索引)—— v0.3 Task 1 后、Task 4 前的存量库形态 */
const V3_SCHEMA = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  filename TEXT NOT NULL,
  savePath TEXT NOT NULL,
  category TEXT,
  totalBytes INTEGER DEFAULT 0,
  downloadedBytes INTEGER DEFAULT 0,
  videoMeta TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  completedAt INTEGER,
  torrentMeta TEXT,
  CHECK(kind IN ('http', 'video', 'torrent')),
  CHECK(status IN ('resolving','awaiting_selection','queued','downloading','paused','processing','completed','error'))
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);
CREATE TABLE categories (
  key TEXT PRIMARY KEY,
  displayName TEXT NOT NULL,
  extensions TEXT NOT NULL,
  savePath TEXT NOT NULL
);
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL
);`

const COLUMNS_15 = [
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
] as const

/**
 * 存量 v3 真实历史行:http completed · **同源两条 video**(不同清晰度 → `findBySource` 多行命中)·
 * torrent(含 `torrentMeta`)。覆盖 null / 非 null 各边界字段。
 */
const V3_ROWS: Array<Record<string, unknown>> = [
  {
    id: 't-http',
    kind: 'http',
    source: 'https://x/a.zip',
    status: 'completed',
    filename: 'a.zip',
    savePath: 'D:\\Old\\Archives\\a.zip',
    category: 'archive',
    totalBytes: 123,
    downloadedBytes: 123,
    videoMeta: null,
    error: null,
    createdAt: 1000,
    startedAt: 1000,
    completedAt: 2000,
    torrentMeta: null
  },
  {
    id: 't-video-1080',
    kind: 'video',
    source: 'https://y/watch?v=1',
    status: 'completed',
    filename: 'V [1080p].mp4',
    savePath: 'D:\\Old\\Videos\\V [1080p].mp4',
    category: 'video',
    totalBytes: 999,
    downloadedBytes: 999,
    videoMeta: '{"title":"V","qualityLabel":"1080P"}',
    error: null,
    createdAt: 1500,
    startedAt: 1500,
    completedAt: 2500,
    torrentMeta: null
  },
  {
    id: 't-video-720',
    kind: 'video',
    source: 'https://y/watch?v=1',
    status: 'error',
    filename: 'V [720p].mp4',
    savePath: 'D:\\Old\\Videos\\V [720p].mp4',
    category: 'video',
    totalBytes: 0,
    downloadedBytes: 0,
    videoMeta: '{"title":"V","qualityLabel":"720P"}',
    error: 'boom',
    createdAt: 1600,
    startedAt: null,
    completedAt: null,
    torrentMeta: null
  },
  {
    id: 't-bt',
    kind: 'torrent',
    source: 'magnet:?xt=urn:btih:abc',
    status: 'downloading',
    filename: 'Release',
    savePath: 'D:\\Downloads\\Torrents\\Release',
    category: 'other',
    totalBytes: 4096,
    downloadedBytes: 1024,
    videoMeta: null,
    error: null,
    createdAt: 1700,
    startedAt: 1700,
    completedAt: null,
    torrentMeta: '{"name":"Release","infoHash":"abc","files":[]}'
  }
]

function indexNamesOf(db: AppDatabase): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'").all() as {
      name: string
    }[]
  ).map((r) => r.name)
}

test(
  'v4 迁移:存量 v3 库只加 idx_tasks_source —— 逐行字节级零变化 + 索引存在 + 查询计划实走 + 迁移前备份(§7.3)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')
    const { findBySource } = await import('./taskDao')

    // 1) 手工建 **v3 形态**存量库 + schema_version=1/2/3 + 真实历史行(node:sqlite 原生,绕过已含 v4 的新链)
    const { DatabaseSync } = requireForProbe('node:sqlite') as {
      DatabaseSync: new (p: string) => RawSqlite
    }
    const raw = new DatabaseSync(dbPath)
    const beforeById = new Map<string, Record<string, unknown>>()
    try {
      raw.exec(V3_SCHEMA)
      for (const version of [1, 2, 3]) {
        raw
          .prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)')
          .run(version, version)
      }
      const insert15 = raw.prepare(INSERT_15)
      for (const row of V3_ROWS) {
        insert15.run(...COLUMNS_15.map((column) => row[column]))
      }
      // 迁移前快照(展开成普通对象,绕过 null-prototype 差异)
      for (const row of V3_ROWS) {
        beforeById.set(row.id as string, {
          ...(raw.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) as object)
        })
      }
      // 前置:v3 存量库**尚无** source 索引(否则本测试证不了 v4 的作用)
      const idxBefore = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_source'")
        .get()
      assert.equal(idxBefore, undefined, '前置:v3 存量库无 idx_tasks_source')
    } finally {
      raw.close() // 释放句柄,交给 initDatabase 重开(Windows 下删/改需先关)
    }

    let db: AppDatabase | null = null
    try {
      // 2) initDatabase → 迁移前主动备份(currentVersion=3 ≥1 且 <4)→ runMigrations 应用 v4
      db = initDatabase(dbPath)

      // §3.4:索引迁移虽非破坏性,存量库仍照常预备份(不绕过安全副作用)
      assert.ok(
        backupFiles(dir).length >= 1,
        '存量 v3 库迁移前主动备份文件已生成(§3.4,不因「只加索引」绕过)'
      )

      // ① version 收敛到 4
      const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
      assert.equal(ver.v, 4, '迁移后 version=4')

      // ② §7.3 核心:行数不变 + 每行逐字段**字节级零变化**(after 与 before **完全相等**,无任何补默认)
      const count = db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
      assert.equal(count.c, V3_ROWS.length, 'v4 迁移后行数不变(零数据触碰)')
      for (const row of V3_ROWS) {
        const after = { ...(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) as object) }
        assert.deepEqual(
          after,
          beforeById.get(row.id as string),
          `${String(row.id)} 迁移前后逐字段完全一致(只加索引,连新列补默认都没有)`
        )
      }

      // ③ 新索引存在,且原 3 索引原样保留(v4 不重建表 → 索引不重建)
      const indexNames = indexNamesOf(db)
      assert.ok(
        indexNames.includes('idx_tasks_source'),
        'idx_tasks_source ∈ sqlite_master(v4 已建)'
      )
      for (const idx of ['idx_tasks_status', 'idx_tasks_category', 'idx_tasks_createdAt']) {
        assert.ok(indexNames.includes(idx), `原索引 ${idx} 原样保留`)
      }

      // ④ 查询计划实走该索引(非死索引)
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE source = ?')
        .all('https://y/watch?v=1') as Array<{ detail: string }>
      assert.ok(
        plan.some((step) => String(step.detail).includes('idx_tasks_source')),
        `WHERE source = ? 的查询计划实走 idx_tasks_source(实际:${JSON.stringify(plan)})`
      )

      // findBySource 在真实 SQLite 上的行为:同源多行 / 精确单行 / 无命中空数组
      const dao = db as unknown as TaskDaoDatabase
      const sameSource = findBySource(dao, 'https://y/watch?v=1')
      assert.deepEqual(
        sameSource.map((t) => t.id).sort(),
        ['t-video-1080', 't-video-720'],
        '同源两条 video 全命中(不同清晰度)'
      )
      assert.deepEqual(
        sameSource.find((t) => t.id === 't-video-1080')?.videoMeta,
        { title: 'V', qualityLabel: '1080P' },
        'rowToTask 投影:videoMeta 解析为对象'
      )
      assert.equal(
        findBySource(dao, 'https://x/a.zip').length,
        1,
        '精确命中单行(不误伤别的 source)'
      )
      assert.deepEqual(findBySource(dao, 'https://nope/none'), [], '无命中 → 空数组')

      // 只读:findBySource 前后行数与内容不变(§7.3 查重只读)
      const countAfterRead = db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
      assert.equal(countAfterRead.c, V3_ROWS.length, 'findBySource 纯 SELECT:读后行数不变')
    } finally {
      cleanup(dir, db)
    }
  }
)

test(
  'v3 迁移:fresh 库经 initDatabase 直接可插 torrent 行 + 不留迁移前备份(fresh 跳过)',
  { skip: !SQLITE_OK },
  async () => {
    const dir = makeTempDir()
    const dbPath = path.join(dir, 'downlord.db')
    const { initDatabase } = await import('./connection')

    let db: AppDatabase | null = null
    try {
      db = initDatabase(dbPath)

      // fresh 库(currentVersion 0)无历史可失 → 迁移前备份跳过(§3.4 判据)
      assert.equal(backupFiles(dir).length, 0, 'fresh 库跳过迁移前主动备份')

      // v1 新 CHECK + v3 重建均正确:torrent 行直接可插
      db.prepare(INSERT_15).run(
        'fresh-bt',
        'torrent',
        'magnet:?xt=urn:btih:def',
        'resolving',
        '获取元数据中',
        'D:\\Downloads\\Torrents',
        'other',
        0,
        0,
        null,
        null,
        5000,
        null,
        null,
        null
      )
      const row = db.prepare('SELECT kind FROM tasks WHERE id = ?').get('fresh-bt') as {
        kind: string
      }
      assert.equal(row.kind, 'torrent', 'fresh 库 torrent 行可插')

      // v4 亦作用于 fresh 库:version 收敛 4 + source 索引已建(v0.3 Task 4 · #29)
      const freshVer = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number
      }
      assert.equal(freshVer.v, 4, 'fresh 库 version=4')
      assert.ok(indexNamesOf(db).includes('idx_tasks_source'), 'fresh 库亦建 idx_tasks_source(v4)')

      // bogus 仍被拒
      assert.throws(
        () => {
          db!
            .prepare(INSERT_15)
            .run(
              'fresh-bogus',
              'bogus',
              'https://z',
              'queued',
              'z',
              'D:\\z',
              'other',
              0,
              0,
              null,
              null,
              6000,
              null,
              null,
              null
            )
        },
        /CHECK|constraint/i,
        'fresh 库 kind=bogus 被 CHECK 拒绝'
      )
    } finally {
      cleanup(dir, db)
    }
  }
)
