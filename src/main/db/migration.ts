import { createTables, type SchemaDatabase } from './schema'

interface Statement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface MigrationDatabase extends SchemaDatabase {
  prepare(sql: string): Statement
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
}

export interface Migration {
  version: number
  up: (db: MigrationDatabase) => void
  down?: (db: MigrationDatabase) => void
}

export const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      createTables(db)
    }
  },
  {
    // v2(Task 8.5 · spec §1.6):重置存量 categories.savePath = '',使「绝对路径烤死」转为
    // 「空 = 跟随默认目录」新语义(运行时 resolveCategoryDir 实时解析)。纯数据迁移,不改表结构。
    // §7.3 合规:UPDATE 只动 categories(可重建派生配置),零触碰 tasks(源数据)。
    version: 2,
    up: (db) => {
      db.prepare("UPDATE categories SET savePath = ''").run()
    }
  },
  {
    // v3(v0.3 Task 1 · spec §3.3):kind 加 'torrent' + 新增 torrentMeta 列。SQLite 无法原地改
    // CHECK 约束 → 唯一正道是**重建 tasks 表**(建新表 → 拷数据 → drop 旧 → rename → 重建索引)。
    //
    // §7.3 红线(源数据安全):
    //   · tasks = 真实下载历史(源数据,不可重建)——迁移**前**由 connection.ts 主动预备份旧库;
    //   · 全部 DDL/DML 在 runMigrations 既有单一 db.transaction 内(异常整体 ROLLBACK,库停在 v2、数据无损);
    //   · INSERT 用**显式列名**(而非 SELECT *)杜绝列序错位;torrentMeta 缺省 NULL(存量无 BT)。
    //
    // **字面自包含**:不引用可变的 schema.ts::TASKS_TABLE_SQL——迁移历史一经发布即为定值,
    // 若引用会随 schema.ts 后续演进而漂移、破坏历史稳定性(§3.2 / §3.3)。status CHECK 8 态原样。
    version: 3,
    up: (db) => {
      db.exec(`CREATE TABLE tasks_new (
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

INSERT INTO tasks_new (
  id, kind, source, status, filename, savePath, category,
  totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt
)
SELECT
  id, kind, source, status, filename, savePath, category,
  totalBytes, downloadedBytes, videoMeta, error, createdAt, startedAt, completedAt
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);`)
    }
  },
  {
    // v4(v0.3 Task 4 · #29 · spec §4):查重 source 索引 —— **只加索引,零数据触碰**。
    //
    // §7.3 合规(与 v2/v3 对照):索引是**纯派生结构**(可随时重建,tasks 行本身不可重建)——
    //   · 无 INSERT / UPDATE / DELETE:不动任何 tasks 行、不改表结构、不动 kind/status CHECK;
    //   · 仍走既有框架:runMigrations 单一事务内执行 + INSERT schema_version(异常整体 ROLLBACK);
    //   · connection.ts 对存量 v3 库照常触发迁移前主动备份(安全副作用,索引迁移本非破坏性,不绕过);
    //   · 集成测试以「逐行 deepEqual(after, before) 字节级零变化」+ 索引存在断言护航。
    //
    // 用途:查重 detectConflictFor 的候选集从「全量历史」缩到「同源命中」(taskDao.findBySource)。
    // **字面自包含 DDL**(同 v3):不引用 schema.ts 常量,迁移历史一经发布即为定值,避免随后续演进漂移。
    version: 4,
    up: (db) => {
      db.exec('CREATE INDEX idx_tasks_source ON tasks(source)')
    }
  }
]

/** 已定义迁移的最高版本号(供 connection.ts 判定「存量库待迁移」以触发迁移前主动备份) */
export const LATEST_MIGRATION_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0
)

function hasSchemaVersionTable(db: MigrationDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get() as { name: string } | undefined

  return row?.name === 'schema_version'
}

/** 读取库当前 schema 版本(0 = fresh 库 / 无 schema_version 表)。导出供 connection.ts 迁移前备份判定。 */
export function readCurrentVersion(db: MigrationDatabase): number {
  if (!hasSchemaVersionTable(db)) {
    return 0
  }

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined

  return row?.version ?? 0
}

export function runMigrations(db: MigrationDatabase): void {
  const currentVersion = readCurrentVersion(db)
  const pendingMigrations = migrations.filter((migration) => migration.version > currentVersion)

  if (pendingMigrations.length === 0) {
    return
  }

  const applyMigrations = db.transaction((items: Migration[]) => {
    for (const migration of items) {
      migration.up(db)
      db.prepare('INSERT OR REPLACE INTO schema_version (version, appliedAt) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      )
    }
  })

  applyMigrations(pendingMigrations)
}
