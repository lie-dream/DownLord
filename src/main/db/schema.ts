export interface SchemaDatabase {
  exec(sql: string): void
}

export const TASKS_TABLE_SQL = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                -- 内部任务 id(UUID 或时间戳+随机)
  kind TEXT NOT NULL,                  -- 'http' | 'video' | 'torrent'
  source TEXT NOT NULL,                -- 原始 URL / magnet / .torrent 路径(真实历史源数据)
  status TEXT NOT NULL,                -- TaskStatus 枚举(8 态)
  filename TEXT NOT NULL,              -- 最终文件名(含扩展名)
  savePath TEXT NOT NULL,              -- 完整保存路径(绝对路径)
  category TEXT,                       -- 'video'|'audio'|'archive'|'document'|'program'|'other'(预留,Task 6 驱动)
  totalBytes INTEGER DEFAULT 0,        -- 文件总大小(字节),0=未知
  downloadedBytes INTEGER DEFAULT 0,   -- 已下载字节(仅关键节点写,非实时)
  videoMeta TEXT,                      -- JSON:{ title, selectedFormat, postProcess, playlistIndex }(视频用,预留)
  error TEXT,                          -- 错误信息(error 态)
  createdAt INTEGER NOT NULL,          -- 创建时间戳(ms)
  startedAt INTEGER,                   -- 首次开始下载时间戳(downloading 首次进入)
  completedAt INTEGER,                 -- 完成时间戳(completed 态)
  torrentMeta TEXT,                    -- JSON:{ name, infoHash, files[] }(torrent 用,v0.3 Task 1;http/video 恒 null)
  CHECK(kind IN ('http', 'video', 'torrent')),
  CHECK(status IN ('resolving','awaiting_selection','queued','downloading','paused','processing','completed','error'))
);`

export const CATEGORIES_TABLE_SQL = `CREATE TABLE categories (
  key TEXT PRIMARY KEY,                -- 'video'|'audio'|'archive'|...
  displayName TEXT NOT NULL,           -- 显示名称
  extensions TEXT NOT NULL,            -- JSON 数组:["mp4","mkv",...]
  savePath TEXT NOT NULL               -- 保存目录(绝对路径)
);`

export const SCHEMA_VERSION_TABLE_SQL = `CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL           -- 迁移应用时间戳(ms)
);`

export function createTables(db: SchemaDatabase): void {
  db.exec(`
${TASKS_TABLE_SQL}

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);

${CATEGORIES_TABLE_SQL}

${SCHEMA_VERSION_TABLE_SQL}
`)
}
