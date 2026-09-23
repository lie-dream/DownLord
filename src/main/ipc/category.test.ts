/**
 * `category:list` 投影单测(spec §1.7)。
 *
 * 直测 `projectCategoryList` 纯函数(handler 的全部投影逻辑;handler 本体依赖 electron `ipcMain`,
 * 在 electron-as-node 测试环境下不可直跑,故投影抽为纯函数以单测,handler 仅薄包装取数 + 注入 defaultDir)。
 *
 * 覆盖:跟随类 `savePath=join(defaultDir,subdir)` / `isCustom=false`;自定义类 `savePath=绝对值` /
 * `isCustom=true`;改 `getDefaultDir` 返回值 → 跟随类目录变、自定义类不变(复用 Step 2 `resolveCategoryDir`,
 * 与路由 `routeForFilename` 同源同值)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { projectCategoryList } from './category'
import { categorySubdir, type CategoryDef } from '../category/categoryModel'

/** 两类输入:video 跟随(savePath 空)、archive 自定义(savePath 绝对值);other 兜底子目录空。 */
function fixtureRows(): CategoryDef[] {
  return [
    { key: 'video', displayName: '视频', extensions: ['mp4', 'mkv'], savePath: '' },
    { key: 'archive', displayName: '压缩包', extensions: ['zip'], savePath: 'E:\\MyArchives' },
    { key: 'other', displayName: '其他', extensions: [], savePath: '' }
  ]
}

test('跟随类:savePath = join(defaultDir, subdir) 且 isCustom=false', () => {
  const defaultDir = join('D:', 'DL')
  const list = projectCategoryList(fixtureRows(), defaultDir)

  const video = list.find((c) => c.key === 'video')!
  assert.equal(video.savePath, join(defaultDir, categorySubdir('video')), '跟随默认目录子目录')
  assert.equal(video.isCustom, false, 'DB savePath 空 → 跟随')
  // 投影不动 key/displayName/extensions(chips / 链接识别加固只读这些)
  assert.equal(video.displayName, '视频')
  assert.deepEqual(video.extensions, ['mp4', 'mkv'])
})

test('other:子目录空 → savePath 回落 defaultDir 本身,isCustom=false', () => {
  const defaultDir = join('D:', 'DL')
  const list = projectCategoryList(fixtureRows(), defaultDir)

  const other = list.find((c) => c.key === 'other')!
  assert.equal(other.savePath, defaultDir, 'other 兜底到 defaultDir')
  assert.equal(other.isCustom, false)
})

test('自定义类:savePath = 原始绝对值(覆盖),isCustom=true', () => {
  const list = projectCategoryList(fixtureRows(), join('D:', 'DL'))

  const archive = list.find((c) => c.key === 'archive')!
  assert.equal(archive.savePath, 'E:\\MyArchives', '非空 → 原样返回自定义目录')
  assert.equal(archive.isCustom, true, 'DB savePath 非空 → 自定义')
})

test('改 defaultDir:跟随类目录随之变,自定义类不变(同源同值,杜绝显示≠实存)', () => {
  const rows = fixtureRows()
  const before = projectCategoryList(rows, join('D:', 'DL'))
  const after = projectCategoryList(rows, join('E:', 'Downloads'))

  const videoBefore = before.find((c) => c.key === 'video')!.savePath
  const videoAfter = after.find((c) => c.key === 'video')!.savePath
  assert.notEqual(videoAfter, videoBefore, '跟随类目录随默认目录变')
  assert.equal(videoAfter, join('E:', 'Downloads', categorySubdir('video')))

  const archiveBefore = before.find((c) => c.key === 'archive')!.savePath
  const archiveAfter = after.find((c) => c.key === 'archive')!.savePath
  assert.equal(archiveAfter, archiveBefore, '自定义类不随默认目录变')
  assert.equal(archiveAfter, 'E:\\MyArchives')

  // isCustom 反映原始 DB savePath,不随 defaultDir 变
  assert.equal(after.find((c) => c.key === 'video')!.isCustom, false)
  assert.equal(after.find((c) => c.key === 'archive')!.isCustom, true)
})
