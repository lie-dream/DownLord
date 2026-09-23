import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '../../../shared/ipc'
import { normalizeTaskSearchQuery, filterTasksBySearch } from './taskSearch'
import { filterTasksByNav } from './taskFilter'
import { filterTasksByCategory, type CategoryFilterKey } from './categoryFilter'
import type { NavKey } from './types'

const mk = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  kind: 'http',
  source: 'https://origin.test/plain',
  status: 'paused',
  filename: 'plain.bin',
  savePath: 'C:/Downloads/plain.bin',
  category: null,
  totalBytes: 100,
  downloadedBytes: 0,
  speed: 0,
  videoMeta: null,
  torrentMeta: null,
  error: null,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  ...over
})
const ids = (tasks: Task[]): string[] => tasks.map((task) => task.id)

test('T7-A01 空串/全空白返回原数组引用，空数组安全', () => {
  const tasks = [mk('one')]
  const empty: Task[] = []
  for (const query of ['', ' \t\r\n ']) {
    assert.equal(normalizeTaskSearchQuery(query), '')
    assert.equal(filterTasksBySearch(tasks, query), tasks)
    assert.equal(filterTasksBySearch(empty, query), empty)
  }
  assert.deepEqual(filterTasksBySearch(empty, 'x'), [])
})

test('T7-A02 仅trim首尾，内部空格保留且不折叠', () => {
  const tasks = [mk('spaced', { filename: 'a b Report' }), mk('joined', { filename: 'ab' })]
  assert.equal(normalizeTaskSearchQuery('  Report  '), 'report')
  assert.deepEqual(ids(filterTasksBySearch(tasks, '  Report  ')), ['spaced'])
  assert.deepEqual(ids(filterTasksBySearch(tasks, 'a b')), ['spaced'])
  assert.deepEqual(ids(filterTasksBySearch(tasks, 'ab')), ['joined'])
  assert.deepEqual(ids(filterTasksBySearch(tasks, 'a  b')), [])
})

test('T7-A03 中文filename/source分别命中，不做拼音或分词', () => {
  const tasks = [
    mk('file', { filename: '中文报告.pdf' }),
    mk('source', { source: 'https://origin.test/中文资料' })
  ]
  assert.deepEqual(ids(filterTasksBySearch(tasks, '中文')), ['file', 'source'])
  assert.deepEqual(ids(filterTasksBySearch(tasks, 'zhongwen')), [])
  assert.deepEqual(ids(filterTasksBySearch(tasks, '中 报')), [])
})

test('T7-A04 字段与查询两侧忽略大小写', () => {
  const tasks = [
    mk('file', { filename: 'Report.MP4' }),
    mk('source', { source: 'https://origin.test/ORIGIN-A' })
  ]
  for (const query of ['report', 'REPORT', 'rEpOrT']) {
    assert.deepEqual(ids(filterTasksBySearch(tasks, query)), ['file'])
  }
  for (const query of ['origin-a', 'ORIGIN-A']) {
    assert.deepEqual(ids(filterTasksBySearch(tasks, query)), ['source'])
  }
})

test('T7-A05 filename或source为OR，双命中不重复且不命中排除', () => {
  const tasks = [
    mk('file', { filename: 'needle.bin' }),
    mk('source', { source: 'https://origin.test/needle' }),
    mk('both', { filename: 'needle', source: 'https://needle.test/' }),
    mk('neither')
  ]
  assert.deepEqual(ids(filterTasksBySearch(tasks, 'needle')), ['file', 'source', 'both'])
})

test('T7-A06 标点按字面、不解码URL、不搜索额外字段', () => {
  const slash = String.fromCharCode(92)
  const tasks = [
    mk('literal', {
      source: 'https://origin-a.test/path?token=A_B%25#Frag',
      filename: '[literal]' + slash + 'name.bin'
    }),
    mk('other', { source: 'https://other.test/plain', filename: 'plain' }),
    mk('private-marker', {
      category: 'private-marker',
      savePath: 'C:/private-marker/data',
      error: 'private-marker',
      kind: 'video'
    })
  ]
  for (const query of ['?token=', 'A_B%25', '#Frag', '[', slash]) {
    assert.deepEqual(ids(filterTasksBySearch(tasks, query)), ['literal'])
  }
  assert.deepEqual(ids(filterTasksBySearch(tasks, '.')), ['literal', 'other', 'private-marker'])
  for (const query of ['A_B%#Frag', '.*', 'private-marker', 'video']) {
    assert.deepEqual(ids(filterTasksBySearch(tasks, query)), [])
  }
  const encoded = [mk('encoded', { source: 'https://origin.test/A%20B%2Fend' })]
  assert.deepEqual(ids(filterTasksBySearch(encoded, 'A B/end')), [])
  assert.deepEqual(ids(filterTasksBySearch(encoded, 'A%20B%2Fend')), ['encoded'])
})

test('T7-A07 原nav/category/search三维AND，含null类别与BT跨状态', () => {
  const tasks = [
    mk('pv', { filename: 'needle', category: 'video' }),
    mk('da', { filename: 'needle', category: 'audio', status: 'downloading' }),
    mk('cv', { filename: 'needle', category: 'video', status: 'completed' }),
    mk('ev', { filename: 'needle', category: 'video', status: 'error' }),
    mk('ta', { filename: 'needle', category: 'audio', kind: 'torrent', status: 'completed' }),
    mk('tn', { filename: 'needle', kind: 'torrent' }),
    mk('qv', { filename: 'other', category: 'video', status: 'queued' })
  ]
  const cases: [NavKey, CategoryFilterKey, string[]][] = [
    ['all', 'all', ['pv', 'da', 'cv', 'ev', 'ta', 'tn']],
    ['all', 'video', ['pv', 'cv', 'ev']],
    ['all', 'audio', ['da', 'ta']],
    ['active', 'all', ['pv', 'da', 'tn']],
    ['active', 'video', ['pv']],
    ['active', 'audio', ['da']],
    ['completed', 'video', ['cv']],
    ['completed', 'audio', ['ta']],
    ['failed', 'video', ['ev']],
    ['failed', 'audio', []],
    ['torrent', 'all', ['ta', 'tn']],
    ['torrent', 'audio', ['ta']],
    ['torrent', 'video', []]
  ]
  for (const [nav, category, expected] of cases) {
    assert.deepEqual(
      ids(
        filterTasksBySearch(filterTasksByCategory(filterTasksByNav(tasks, nav), category), 'needle')
      ),
      expected,
      nav + '/' + category
    )
  }
  assert.deepEqual(
    ids(
      filterTasksBySearch(filterTasksByCategory(filterTasksByNav(tasks, 'active'), 'video'), '  ')
    ),
    ['pv', 'qv']
  )
})

test('T7-A08 冻结输入不改数组/对象/身份/顺序，同字段不同id保留', () => {
  const tasks = [
    mk('first', { filename: 'same', createdAt: 10 }),
    mk('middle', { createdAt: 100 }),
    mk('last', { filename: 'same', createdAt: 20 })
  ]
  const before = structuredClone(tasks)
  tasks.forEach(Object.freeze)
  Object.freeze(tasks)
  const result = filterTasksBySearch(tasks, 'same')
  assert.deepEqual(ids(result), ['first', 'last'])
  assert.equal(result[0], tasks[0])
  assert.equal(result[1], tasks[2])
  assert.equal(filterTasksBySearch(tasks, '  '), tasks)
  assert.deepEqual(tasks, before)
})
