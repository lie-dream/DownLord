/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TorrentFile } from '../../../shared/ipc'
import { buildTorrentFileRows, totalTorrentBytes } from './torrentFileList'

const f = (path: string, length: number, selected = true): TorrentFile => ({
  path,
  length,
  selected
})

test('buildTorrentFileRows:1-based index 锚定原数组位(§3.2 不变式),不随显示排序变', () => {
  // 原顺序:b.mkv(位0→idx1)/ a.mkv(位1→idx2)/ c.mkv(位2→idx3)
  const rows = buildTorrentFileRows([f('b.mkv', 10), f('a.mkv', 20), f('c.mkv', 30)])
  // 显示按 path 排序:a / b / c
  assert.deepEqual(
    rows.map((r) => r.path),
    ['a.mkv', 'b.mkv', 'c.mkv']
  )
  // index 恒锚定原 aria2 顺序:a 原位1→idx2 / b 原位0→idx1 / c 原位2→idx3
  assert.equal(rows.find((r) => r.path === 'a.mkv')?.index, 2)
  assert.equal(rows.find((r) => r.path === 'b.mkv')?.index, 1)
  assert.equal(rows.find((r) => r.path === 'c.mkv')?.index, 3)
})

test('buildTorrentFileRows:大小格式化(formatBytes)', () => {
  const rows = buildTorrentFileRows([f('big.bin', 1024 * 1024)])
  assert.equal(rows[0].sizeLabel, '1.0 MB')
})

test('buildTorrentFileRows:保留目录层级路径原样(不聚合树)', () => {
  const rows = buildTorrentFileRows([f('Movie/CD1/a.mkv', 5), f('Movie/b.srt', 1)])
  assert.ok(rows.some((r) => r.path === 'Movie/CD1/a.mkv'))
  assert.ok(rows.some((r) => r.path === 'Movie/b.srt'))
})

test('buildTorrentFileRows:空清单 → 空数组', () => {
  assert.deepEqual(buildTorrentFileRows([]), [])
})

test('totalTorrentBytes:汇总全部文件字节(不受 selected 影响)', () => {
  assert.equal(totalTorrentBytes([f('a', 100, true), f('b', 200, false), f('c', 300, true)]), 600)
})

test('totalTorrentBytes:空清单 → 0', () => {
  assert.equal(totalTorrentBytes([]), 0)
})
