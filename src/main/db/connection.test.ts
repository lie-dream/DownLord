/**
 * connection 单元测试(2026-07-11 审计修复:损坏备份带 WAL 伴生文件)。
 *
 * 用真实临时目录 + 真 SQLite 引擎(node:sqlite,经 electron-as-node 可用)验证 §7.3 损坏路径:
 * 打开 / quick_check 失败 → 备份主库 **连同 `-wal` / `-shm`** → 移除原件 → 重建可用新库。
 * WAL 里可能存着最近已提交事务(损坏库 checkpoint 大概率失败),只备份主库会丢最新历史。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { initDatabase } from './connection'

test('损坏库备份连同 -wal/-shm 一并备份并清理,重建后新库可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'downlord-conn-test-'))
  const dbPath = join(dir, 'downlord.db')

  try {
    // 构造「损坏」现场:主库是非 SQLite 垃圾字节(打开或 quick_check 必失败)+ 残留 WAL 伴生文件
    writeFileSync(dbPath, 'this is definitely not a sqlite database file')
    writeFileSync(`${dbPath}-wal`, 'stale wal frames (may hold last committed txns)')
    writeFileSync(`${dbPath}-shm`, 'stale shared memory index')

    const db = initDatabase(dbPath)

    // 重建后的新库真实可用(建表迁移已跑;能开事务写读则链路健康)
    assert.equal(db.quickCheck(), 'ok', '重建后的新库 quick_check=ok')
    db.close()

    const files = readdirSync(dir)
    const backupMain = files.find((f) => /^downlord\.db\.backup\.\d+$/.test(f))
    assert.ok(backupMain, `主库已备份(带时间戳): ${files.join(', ')}`)
    assert.ok(files.includes(`${backupMain}-wal`), 'WAL 伴生文件一并进备份(最近事务不丢)')
    assert.ok(files.includes(`${backupMain}-shm`), 'shm 伴生文件一并进备份')
    assert.ok(!existsSync(`${dbPath}-wal`), '原残留 -wal 已移除(不与新库同名共存)')
    assert.ok(!existsSync(`${dbPath}-shm`), '原残留 -shm 已移除')
    assert.ok(existsSync(dbPath), '新库文件已就位')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('健康库初始化:不触发备份,直接 WAL + 迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'downlord-conn-test-'))
  const dbPath = join(dir, 'downlord.db')

  try {
    const db = initDatabase(dbPath) // 首次运行:引擎直接建空库,quick_check=ok
    assert.equal(db.quickCheck(), 'ok')
    db.close()

    const backups = readdirSync(dir).filter((f) => f.includes('.backup.'))
    assert.deepEqual(backups, [], '健康路径零备份文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
