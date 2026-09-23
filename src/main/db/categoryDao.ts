/**
 * categoryDao — categories 表读写 + 默认值幂等 seed(spec §6.1 / §6.2)。
 *
 * 红线:
 * - 结构零变更 + v2 数据迁移重置 savePath 语义:icon 前端映射、默认数据走启动 seed(spec §2.3 / §1.6);
 *   迁移仅重置存量 savePath='',表结构不动(migration.ts version 2)。
 * - seed 幂等:仅空表才插,非空跳过、绝不覆盖用户已改配置(ARCHITECTURE §7.3 不静默丢弃)。
 * - 写经事务;extensions 字段 JSON 编解码(`JSON.stringify` / `JSON.parse`)。
 * - `updateCategory` 仅改既有 key 的可配置字段,不增删类别(增删类别 MVP 不做,spec §9)。
 */
import { defaultCategoryDefs, type CategoryDef } from '../category/categoryModel'
import { normalizeExtensions } from '../category/categorize'
import type { CategoryPatch } from '../../shared/ipc'

interface Statement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

export interface CategoryDaoDatabase {
  prepare(sql: string): Statement
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult
}

type CategoryRow = {
  key: string
  displayName: string
  extensions: string
  savePath: string
}

/** categories 列(INSERT 参数顺序;key 为主键,updateCategory 不改) */
const CATEGORY_COLUMNS = ['key', 'displayName', 'extensions', 'savePath'] as const

const PATCHABLE_COLUMNS = new Set<keyof CategoryPatch>(['displayName', 'extensions', 'savePath'])

function rowToCategory(row: CategoryRow): CategoryDef {
  return {
    key: row.key,
    displayName: row.displayName,
    extensions: parseExtensions(row.extensions),
    savePath: row.savePath
  }
}

/**
 * extensions 列 JSON 解析防护:一行损坏若直接抛出,`listCategories` 会在启动装配期
 * (seedDefaultCategories)整体失败并连坐下载功能。类别扩展名是可重建派生配置,
 * 退化为空数组(该类暂不参与扩展名路由,兜底 other),原文进日志可追查。
 */
function parseExtensions(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch (err) {
    console.error(`[categoryDao] extensions JSON 损坏,已退化为 []: ${value}`, err)
    return []
  }
}

export function listCategories(db: CategoryDaoDatabase): CategoryDef[] {
  const rows = db
    .prepare('SELECT key, displayName, extensions, savePath FROM categories')
    .all() as CategoryRow[]

  return rows.map(rowToCategory)
}

/**
 * 启动期幂等 seed:仅当 categories 表为空时,按 `defaultCategoryDefs()` 批量插入 6 默认类别(事务)。
 * seed 的 `savePath` 恒 `''`(= 跟随默认目录,运行时由 `resolveCategoryDir` 实时解析;spec §1.2)。
 * 非空则跳过 —— 尊重用户已改配置,绝不覆盖(spec §6.1,ARCHITECTURE §7.3)。
 */
export function seedDefaultCategories(db: CategoryDaoDatabase): void {
  if (listCategories(db).length > 0) {
    return
  }

  const defaults = defaultCategoryDefs()
  const seed = db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO categories (${CATEGORY_COLUMNS.join(', ')})
VALUES (${CATEGORY_COLUMNS.map(() => '?').join(', ')})`
    )
    for (const cat of defaults) {
      insert.run(cat.key, cat.displayName, JSON.stringify(cat.extensions), cat.savePath)
    }
  })

  seed()
}

/**
 * 改既有 key 的可配置字段(displayName / extensions / savePath)。
 * extensions 先经 `normalizeExtensions` 权威规范化(小写 / 去前导点 / trim / 去空 / 去重保序,
 * spec §5.2)再 `JSON.stringify` 落库 —— 即便渲染层已轻量回显,主进程仍为权威(§7.2)。
 * 不存在的 key:`WHERE key = ?` 影响 0 行 → no-op(不抛);空 patch 同样 no-op。
 * 不增删类别(§6.2 / §9)。
 */
export function updateCategory(db: CategoryDaoDatabase, key: string, patch: CategoryPatch): void {
  const entries = (Object.entries(patch) as Array<[keyof CategoryPatch, unknown]>).filter(
    ([column, value]) => PATCHABLE_COLUMNS.has(column) && value !== undefined
  )

  if (entries.length === 0) {
    return
  }

  const update = db.transaction(() => {
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
    const values = entries.map(([column, value]) =>
      column === 'extensions' ? JSON.stringify(normalizeExtensions(value as string[])) : value
    )

    db.prepare(`UPDATE categories SET ${assignments} WHERE key = ?`).run(...values, key)
  })

  update()
}
