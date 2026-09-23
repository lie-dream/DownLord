/**
 * SQLite 连接管理 — WAL + 损坏自检与备份重建(spec §4.2 / §4.3,ARCHITECTURE §7.3 红线)。
 *
 * 红线遵守:`tasks` 表存的是**真实下载历史(源数据,不可重建)**;一旦 `quick_check`
 * 判定损坏,**必须先 copyFileSync 备份(带时间戳)、再 unlinkSync 删除、再重建**,
 * 绝不静默丢弃——用户可从 `${dbPath}.backup.${timestamp}` 恢复。
 *
 * 引擎无关:DB 实例经 `createDatabase`(`./engine` 单一切换点)取得;quick_check / WAL 经
 * `quickCheck()` / `enableWal()` 薄封装,屏蔽 node:sqlite 与 better-sqlite3 的形态差异(Task 3.5)。
 */
import { createDatabase } from './engine'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { LATEST_MIGRATION_VERSION, readCurrentVersion, runMigrations } from './migration'

/** 已初始化的 DB 实例类型(引擎无关,供 TaskManager / DAO 复用) */
export type { AppDatabase } from './engine'
import type { AppDatabase } from './engine'

let dbInstance: AppDatabase | null = null

/** WAL 模式伴生文件后缀(损坏备份 / 清理与主库同步处理) */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

/**
 * 迁移前主动预备份(spec §3.4,ARCHITECTURE §7.3「先备份旧库」)。
 *
 * 触发判据:**存量库**且**有待应用迁移**——`currentVersion ≥ 1 && currentVersion < LATEST_MIGRATION_VERSION`。
 * fresh 库(本次刚建,`currentVersion === 0`)无历史可失 → 跳过;库已最新(无 pending)→ 跳过(不留冗余备份)。
 *
 * 与损坏被动备份(`quickCheck !== 'ok'`)分离:v3 是**结构性重建**(重建 tasks 表),须在改结构前留一份可恢复副本。
 * 先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 刷回主库 → 复制单一 `.db` 即自洽;checkpoint 失败退回连同现存
 * sidecar 一并复制(仿损坏路径),仍不静默。**备份失败 → 抛出中止迁移**:绝不在未备份的情况下改结构。
 */
function backupBeforeMigration(db: AppDatabase, dbPath: string): void {
  const currentVersion = readCurrentVersion(db)
  if (currentVersion < 1 || currentVersion >= LATEST_MIGRATION_VERSION) {
    return // fresh 库 / 已最新:无待迁移的存量历史,跳过预备份
  }

  if (!existsSync(dbPath)) {
    return // 无实体文件(如 :memory:):无可复制的历史,跳过
  }

  const backupPath = `${dbPath}.backup.pre-migration.${Date.now()}`
  try {
    let checkpointed = false
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)') // 把 WAL 刷回主库,复制单文件即一致可恢复
      checkpointed = true
    } catch (checkpointErr) {
      console.error('[db] 迁移前 checkpoint 失败,退回连同 sidecar 一并备份:', checkpointErr)
    }

    copyFileSync(dbPath, backupPath)
    if (!checkpointed) {
      // checkpoint 未成功:最近已提交事务可能仍在 -wal,连同 sidecar 一并复制,避免丢历史
      for (const suffix of SIDECAR_SUFFIXES) {
        const sidecar = `${dbPath}${suffix}`
        if (existsSync(sidecar)) {
          copyFileSync(sidecar, `${backupPath}${suffix}`)
        }
      }
    }
    console.error(
      `[db] 迁移前已备份至 ${backupPath}(v${currentVersion} → v${LATEST_MIGRATION_VERSION})`
    )
  } catch (backupErr) {
    // 备份失败不得静默:抛出中止,绝不在未备份的情况下重建 tasks 表(§7.3 红线)
    console.error('[db] 迁移前备份失败,中止迁移以免丢失历史:', backupErr)
    throw backupErr
  }
}

/** 尽力关闭(损坏句柄 close 可能抛,吞掉不影响后续重建) */
function closeQuietly(db: AppDatabase | undefined): void {
  if (db) {
    try {
      db.close()
    } catch {
      // 关闭损坏句柄失败不影响后续流程
    }
  }
}

/**
 * 打开并初始化数据库:
 * 1. 打开 DB → `quickCheck()`(PRAGMA quick_check);打开本身或自检失败均视为损坏。
 * 2. 损坏:`copyFileSync` 备份(`${dbPath}.backup.${Date.now()}`)→ `unlinkSync` 删除 → 重新打开。
 * 3. 正常 / 重建后:统一 `enableWal()`(PRAGMA journal_mode=WAL)+ `runMigrations`(建表 / 迁移)。
 *
 * 首次运行(文件不存在)由引擎直接建空库,`quick_check` 返回 'ok',不触发备份。
 */
export function initDatabase(dbPath: string): AppDatabase {
  // 引擎不会创建父目录,先确保数据库目录存在(ARCHITECTURE §2.1)
  mkdirSync(dirname(dbPath), { recursive: true })

  let db: AppDatabase | undefined

  try {
    db = createDatabase(dbPath)
    const check = db.quickCheck()
    if (check !== 'ok') {
      throw new Error(`quick_check=${String(check)}`)
    }
  } catch (err) {
    // 打开或自检失败 → 视为损坏:先备份、再删除、再重建(§7.3 红线,绝不静默丢弃)。
    // **备份必须在 close() 之前**:SQLite 关闭连接时会清理(unlink)它认为无效的 -wal/-shm,
    // 先关再备会把 WAL 里的最近已提交事务一并丢掉(损坏库 checkpoint 大概率失败,最新历史
    // 往往只在 -wal 中;实验证实 close 后伴生文件即消失)。主库此刻是共享锁,copyFileSync 可读。
    if (existsSync(dbPath)) {
      const backupPath = `${dbPath}.backup.${Date.now()}`
      try {
        copyFileSync(dbPath, backupPath)
        for (const suffix of SIDECAR_SUFFIXES) {
          const sidecar = `${dbPath}${suffix}`
          if (existsSync(sidecar)) {
            copyFileSync(sidecar, `${backupPath}${suffix}`)
          }
        }
        console.error(`[db] 数据库损坏,已备份至 ${backupPath};原因:`, err)
      } catch (backupErr) {
        // 备份失败时不得静默丢弃:释放句柄后抛出让上层感知,绝不在未备份的情况下删库
        console.error('[db] 损坏库备份失败,中止重建以免丢失历史:', backupErr)
        closeQuietly(db)
        throw backupErr
      }
    }

    // 释放句柄(Windows 下删除需先关闭);伴生文件已备份,SQLite close 顺带清掉它们也无妨
    closeQuietly(db)

    try {
      if (existsSync(dbPath)) {
        unlinkSync(dbPath)
      }
      for (const suffix of SIDECAR_SUFFIXES) {
        const sidecar = `${dbPath}${suffix}`
        if (existsSync(sidecar)) {
          unlinkSync(sidecar) // 残留旧 -wal/-shm 与重建的新库同名共存会有 salt 不匹配的边角行为
        }
      }
    } catch (removeErr) {
      console.error('[db] 损坏库移除失败,中止重建:', removeErr)
      throw removeErr
    }

    db = createDatabase(dbPath)
  }

  // 并发读 + 写性能;所有写操作仍经 DAO 的 db.transaction 原子化(spec §4.2 / §4.4)
  db.enableWal()
  // §7.3 红线:结构性迁移(如 v3 重建 tasks 表)前主动预备份旧库;fresh 库跳过(见函数注释)
  try {
    backupBeforeMigration(db, dbPath)
  } catch (err) {
    closeQuietly(db)
    throw err
  }
  runMigrations(db)

  dbInstance = db
  return db
}

/** 单例访问已初始化的 DB;未初始化时抛错(防止误用未建表的连接) */
export function getDatabase(): AppDatabase {
  if (!dbInstance) {
    throw new Error('数据库尚未初始化,请先调用 initDatabase()')
  }
  return dbInstance
}
