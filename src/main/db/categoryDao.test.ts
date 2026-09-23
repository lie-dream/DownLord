import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  listCategories,
  seedDefaultCategories,
  updateCategory,
  type CategoryDaoDatabase
} from './categoryDao'
import { CATEGORY_KEYS, defaultCategoryDefs } from '../category/categoryModel'

interface TestStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

type CategoryRow = {
  key: string
  displayName: string
  extensions: string
  savePath: string
}

/** 插入 / 更新参数顺序须与 categoryDao SQL 一致 */
const CATEGORY_COLUMNS: Array<keyof CategoryRow> = ['key', 'displayName', 'extensions', 'savePath']

class MockStatement implements TestStatement {
  constructor(
    private readonly handlers: {
      all?: (...params: unknown[]) => unknown[]
      run?: (...params: unknown[]) => unknown
    }
  ) {}

  all(...params: unknown[]): unknown[] {
    return this.handlers.all?.(...params) ?? []
  }

  run(...params: unknown[]): unknown {
    return this.handlers.run?.(...params)
  }
}

/**
 * 模拟 categories 表的最小面:覆盖 categoryDao 发出的 SQL(SELECT / INSERT / UPDATE)。
 * 结构上满足 CategoryDaoDatabase(prepare + transaction)。
 */
class MockCategoryDb implements CategoryDaoDatabase {
  rows: CategoryRow[] = []

  prepare(sql: string): TestStatement {
    if (sql.startsWith('SELECT key, displayName, extensions, savePath FROM categories')) {
      return new MockStatement({ all: () => this.rows.map((row) => ({ ...row })) })
    }

    if (sql.startsWith('INSERT INTO categories')) {
      return new MockStatement({
        run: (...params) => {
          const row = Object.fromEntries(
            CATEGORY_COLUMNS.map((column, index) => [column, params[index]])
          ) as CategoryRow
          this.rows.push(row)
        }
      })
    }

    if (sql.startsWith('UPDATE categories SET ')) {
      return new MockStatement({ run: (...params) => this.updateFromSql(sql, params) })
    }

    throw new Error(`Unexpected SQL in categoryDao test: ${sql}`)
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return (...args) => {
      const snapshot = this.rows.map((row) => ({ ...row }))
      try {
        return fn(...args)
      } catch (error) {
        this.rows = snapshot
        throw error
      }
    }
  }

  private updateFromSql(sql: string, params: unknown[]): void {
    const assignments =
      sql
        .match(/^UPDATE categories SET (.+) WHERE key = \?$/)
        ?.at(1)
        ?.split(', ')
        .map((assignment) => assignment.split(' = ')[0] as keyof CategoryRow) ?? []
    const key = params[assignments.length] as string
    const updates = Object.fromEntries(
      assignments.map((column, index) => [column, params[index]])
    ) as Partial<CategoryRow>
    const row = this.rows.find((item) => item.key === key)
    // 不存在 key:无行匹配 → no-op(UPDATE 影响 0 行,不抛)
    if (row) {
      Object.assign(row, updates)
    }
  }
}

test('categoryDao listCategories decodes extensions JSON without inserting defaults', () => {
  const db = new MockCategoryDb()

  assert.deepEqual(listCategories(db), [])

  db.rows.push({
    key: 'video',
    displayName: '视频',
    extensions: '["mp4","mkv"]',
    savePath: 'D:\\Downloads\\Videos'
  })

  assert.deepEqual(listCategories(db), [
    {
      key: 'video',
      displayName: '视频',
      extensions: ['mp4', 'mkv'],
      savePath: 'D:\\Downloads\\Videos'
    }
  ])
})

test('categoryDao seedDefaultCategories inserts 6 defaults into an empty table (savePath="" follow)', () => {
  const db = new MockCategoryDb()

  seedDefaultCategories(db)

  const seeded = listCategories(db)
  assert.equal(seeded.length, 6)
  assert.deepEqual(
    seeded.map((c) => c.key),
    [...CATEGORY_KEYS]
  )
  // 往返一致:seed savePath 恒 ''(跟随,spec §1.2)+ extensions JSON 编解码
  assert.deepEqual(seeded, defaultCategoryDefs())
  for (const c of seeded) {
    assert.equal(c.savePath, '', `${c.key} seed savePath 应为空串`)
  }
})

test('categoryDao seedDefaultCategories is idempotent and never overwrites user changes', () => {
  const db = new MockCategoryDb()

  seedDefaultCategories(db)
  // 模拟用户改了 archive 的目录
  updateCategory(db, 'archive', { savePath: 'E:\\MyArchives' })

  // 再次 seed:非空 → 跳过,不覆盖用户已改配置
  seedDefaultCategories(db)

  const after = listCategories(db)
  assert.equal(after.length, 6)
  assert.equal(after.find((c) => c.key === 'archive')?.savePath, 'E:\\MyArchives')
})

test('categoryDao updateCategory round-trips displayName / extensions / savePath', () => {
  const db = new MockCategoryDb()
  seedDefaultCategories(db)

  updateCategory(db, 'archive', {
    displayName: '归档',
    extensions: ['zip', 'rar', 'cab'],
    savePath: 'E:\\Archives'
  })

  const archive = listCategories(db).find((c) => c.key === 'archive')
  assert.equal(archive?.displayName, '归档')
  assert.deepEqual(archive?.extensions, ['zip', 'rar', 'cab'])
  assert.equal(archive?.savePath, 'E:\\Archives')
})

test('categoryDao updateCategory normalizes extensions before persisting (lowercase / strip dot / trim / drop empty / dedupe)', () => {
  const db = new MockCategoryDb()
  seedDefaultCategories(db)

  // 渲染层可能传原始值(大写 / 前导点 / 空白 / 空项 / 重复);主进程为权威规范化(spec §5.2 / §7.2)
  updateCategory(db, 'video', { extensions: ['.MP4', 'mp4', ' MKV ', '', 'avi'] })

  const video = listCategories(db).find((c) => c.key === 'video')
  assert.deepEqual(video?.extensions, ['mp4', 'mkv', 'avi'])
})

test('categoryDao updateCategory on a missing key is a no-op and does not throw', () => {
  const db = new MockCategoryDb()
  seedDefaultCategories(db)
  const before = listCategories(db)

  assert.doesNotThrow(() => {
    updateCategory(db, 'nonexistent', { savePath: 'E:\\Nope' })
  })

  // 列表不变(未新增、未改动)
  assert.deepEqual(listCategories(db), before)
})

test('categoryDao updateCategory with an empty patch is a no-op', () => {
  const db = new MockCategoryDb()
  seedDefaultCategories(db)
  const before = listCategories(db)

  updateCategory(db, 'archive', {})

  assert.deepEqual(listCategories(db), before)
})

test('categoryDao 行级 extensions JSON 损坏 → 退化 [],不放大为 listCategories 整体失败(启动装配期不连坐)', () => {
  const db = new MockCategoryDb()
  seedDefaultCategories(db)

  // 直接改行模拟外部编辑 / 局部损坏(quick_check 校验不到应用层 JSON)
  const row = db.rows.find((r) => r.key === 'video')
  assert.ok(row)
  row.extensions = '[broken'

  // 修复前:listCategories 整体抛出 → seedDefaultCategories 在装配期炸掉、下载功能连坐
  const cats = listCategories(db)
  assert.equal(cats.length, db.rows.length, '坏行不吞掉整个列表')
  assert.deepEqual(cats.find((c) => c.key === 'video')?.extensions, [], '坏 extensions 退化为 []')
  assert.ok((cats.find((c) => c.key === 'audio')?.extensions.length ?? 0) > 0, '其余行不受影响')
})
