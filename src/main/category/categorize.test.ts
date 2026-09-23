import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  extractExt,
  buildExtIndex,
  categorize,
  resolveCategoryDir,
  normalizeExtensions
} from './categorize'
import { defaultCategoryDefs, CATEGORY_KEYS, type CategoryDef } from './categoryModel'

const DEFAULT_DIR = join('C:', 'Users', 'me', 'Downloads')
const defs = defaultCategoryDefs()
const extIndex = buildExtIndex(defs)

// ───────────────────────── extractExt(spec §3.3 / §7.1) ─────────────────────────

test('extractExt: 取末尾扩展名 + 小写', () => {
  assert.equal(extractExt('A.MP4'), 'mp4')
  assert.equal(extractExt('x.tar.gz'), 'gz') // 多扩展名取最后一段
  assert.equal(extractExt('a.b.c.zip'), 'zip')
})

test('extractExt: 无扩展名 / 末尾点 / 隐藏文件 → 空串', () => {
  assert.equal(extractExt('noext'), '') // 无点
  assert.equal(extractExt('archive.'), '') // 末尾点,扩展名为空
  assert.equal(extractExt('.bashrc'), '') // 仅前导点的隐藏文件
})

// ───────────────────────── buildExtIndex(spec §3.2 / §7.1) ─────────────────────────

test('buildExtIndex: 默认清单各 ext 映射到对应 key', () => {
  assert.equal(extIndex.get('mp4'), 'video')
  assert.equal(extIndex.get('webm'), 'video')
  assert.equal(extIndex.get('mp3'), 'audio')
  assert.equal(extIndex.get('flac'), 'audio')
  assert.equal(extIndex.get('zip'), 'archive')
  assert.equal(extIndex.get('gz'), 'archive') // .tar.gz 天然落 archive
  assert.equal(extIndex.get('pdf'), 'document')
  assert.equal(extIndex.get('exe'), 'program')
  // 默认数据无冲突,other 无扩展名贡献
  assert.equal(extIndex.has('unknownxyz'), false)
})

test('buildExtIndex: 人造冲突按 CATEGORY_KEYS 顺序「先定义者优先」+ console.warn,不抛不崩', () => {
  // 同 ext 'dup' 入 video 与 audio:CATEGORY_KEYS 中 video 先于 audio → video 胜
  const conflicting: CategoryDef[] = [
    { key: 'audio', displayName: '音频', extensions: ['dup'], savePath: '/a' },
    { key: 'video', displayName: '视频', extensions: ['dup'], savePath: '/v' }
  ]

  const originalWarn = console.warn
  let warnCount = 0
  console.warn = () => {
    warnCount++
  }
  let idx: Map<string, string>
  try {
    assert.doesNotThrow(() => {
      idx = buildExtIndex(conflicting)
    })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(idx!.get('dup'), 'video') // 先定义(CATEGORY_KEYS 顺序)优先
  assert.ok(warnCount > 0, '冲突应记 console.warn')
})

test('buildExtIndex: 大小写无关(ext key 一律小写)', () => {
  const cats: CategoryDef[] = [
    { key: 'video', displayName: '视频', extensions: ['MP4', 'MoV'], savePath: '/v' }
  ]
  const idx = buildExtIndex(cats)
  assert.equal(idx.get('mp4'), 'video')
  assert.equal(idx.get('mov'), 'video')
})

// ───────────────────────── categorize(spec §3.1 / §7.1) ─────────────────────────

test('categorize: 各类命中', () => {
  assert.equal(categorize('movie.mp4', extIndex), 'video')
  assert.equal(categorize('song.mp3', extIndex), 'audio')
  assert.equal(categorize('pack.zip', extIndex), 'archive')
  assert.equal(categorize('doc.pdf', extIndex), 'document')
  assert.equal(categorize('setup.exe', extIndex), 'program')
})

test('categorize: 大小写无关 + 多扩展名', () => {
  assert.equal(categorize('MOVIE.MP4', extIndex), 'video')
  assert.equal(categorize('bundle.tar.gz', extIndex), 'archive')
})

test('categorize: 未知扩展名 / 空扩展名 → other', () => {
  assert.equal(categorize('mystery.xyz', extIndex), 'other')
  assert.equal(categorize('noext', extIndex), 'other')
  assert.equal(categorize('.bashrc', extIndex), 'other')
  assert.equal(categorize('', extIndex), 'other')
})

// ───────────────────────── resolveCategoryDir(实时计算,spec §1.3) ─────────────────────────

test('resolveCategoryDir: 空 savePath(跟随)→ join(defaultDir, 标准子目录)', () => {
  // seed defs 全为 savePath='':按 categorySubdir 实时拼默认目录子目录
  assert.equal(resolveCategoryDir('video', defs, DEFAULT_DIR), join(DEFAULT_DIR, 'Videos'))
  assert.equal(resolveCategoryDir('audio', defs, DEFAULT_DIR), join(DEFAULT_DIR, 'Music'))
  assert.equal(resolveCategoryDir('archive', defs, DEFAULT_DIR), join(DEFAULT_DIR, 'Archives'))
  assert.equal(resolveCategoryDir('document', defs, DEFAULT_DIR), join(DEFAULT_DIR, 'Documents'))
  assert.equal(resolveCategoryDir('program', defs, DEFAULT_DIR), join(DEFAULT_DIR, 'Programs'))
})

test('resolveCategoryDir: 改 defaultDir → 空 savePath 类别实时跟随新目录(无需同步)', () => {
  const NEW_DIR = join('D:', 'NewRoot')
  assert.equal(resolveCategoryDir('video', defs, NEW_DIR), join(NEW_DIR, 'Videos'))
  assert.equal(resolveCategoryDir('audio', defs, NEW_DIR), join(NEW_DIR, 'Music'))
})

test('resolveCategoryDir: 非空 savePath(自定义)→ 原样返回(覆盖,不拼默认目录)', () => {
  const custom: CategoryDef[] = [
    { key: 'video', displayName: '视频', extensions: ['mp4'], savePath: join('E:', 'Movies') }
  ]
  assert.equal(resolveCategoryDir('video', custom, DEFAULT_DIR), join('E:', 'Movies'))
})

test('resolveCategoryDir: other / 未知 key → defaultDir(子目录空,兜底)', () => {
  assert.equal(resolveCategoryDir('other', defs, DEFAULT_DIR), DEFAULT_DIR)
  assert.equal(resolveCategoryDir('nope', defs, DEFAULT_DIR), DEFAULT_DIR)
})

// ───────────────────────── 默认清单模型(spec §1.2) ─────────────────────────

test('defaultCategoryDefs: 6 类齐全,全部 savePath="" (跟随)', () => {
  assert.equal(defs.length, CATEGORY_KEYS.length)
  assert.deepEqual(
    defs.map((d) => d.key),
    [...CATEGORY_KEYS]
  )
  for (const def of defs) {
    assert.equal(def.savePath, '', `${def.key} seed savePath 应为空串(跟随默认目录)`)
  }
  const other = defs.find((d) => d.key === 'other')!
  assert.deepEqual(other.extensions, []) // other 不靠扩展名命中
})

// ───────────────────────── normalizeExtensions(权威规范化,spec §5.2 / §7.1) ─────────────────────────

test('normalizeExtensions: 大写 → 小写', () => {
  assert.deepEqual(normalizeExtensions(['MP4', 'MoV', 'WEBM']), ['mp4', 'mov', 'webm'])
})

test('normalizeExtensions: 去前导点(单点 / 多点前缀)', () => {
  assert.deepEqual(normalizeExtensions(['.mp4', '..mkv', '.zip']), ['mp4', 'mkv', 'zip'])
})

test('normalizeExtensions: trim 首尾空白(含点与空格混合)', () => {
  assert.deepEqual(normalizeExtensions(['  mp4  ', ' .mkv ', '\tflac']), ['mp4', 'mkv', 'flac'])
})

test('normalizeExtensions: 去空(空串 / 纯空白 / 纯点 → 丢弃)', () => {
  assert.deepEqual(normalizeExtensions(['', '   ', '.', '..']), [])
})

test('normalizeExtensions: 去重保序(大小写 / 前导点视为同一项,保留首次出现位置)', () => {
  assert.deepEqual(normalizeExtensions(['mp4', 'MP4', '.mp4', 'mkv', 'mp4']), ['mp4', 'mkv'])
})

test('normalizeExtensions: 组合规范化一步到位', () => {
  assert.deepEqual(normalizeExtensions([' .MP4 ', 'MKV', 'mkv', '', '.AVI']), ['mp4', 'mkv', 'avi'])
})
