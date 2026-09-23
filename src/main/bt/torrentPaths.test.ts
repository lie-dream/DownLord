import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { torrentSaveDir, managedTorrentDir, managedTorrentPath } from './torrentPaths'

// 跨平台:expected 与实现同用 `join`,分隔符自动对齐当前平台(仿 categorize.test.ts)

test('torrentSaveDir: 在 defaultDir 下追加 Torrents 子目录', () => {
  const dir = join('home', 'user', 'Downloads')
  assert.equal(torrentSaveDir(dir), join(dir, 'Torrents'))
})

test('managedTorrentDir: <userData>/torrents', () => {
  const ud = join('C:', 'Users', 'x', 'AppData', 'Roaming', 'DownLord')
  assert.equal(managedTorrentDir(ud), join(ud, 'torrents'))
})

test('managedTorrentPath: <userData>/torrents/<taskId>.torrent', () => {
  const ud = join('var', 'app')
  assert.equal(managedTorrentPath(ud, 'task-123'), join(ud, 'torrents', 'task-123.torrent'))
})

test('managedTorrentPath: 位于 managedTorrentDir 之下(路径由 id 派生)', () => {
  const ud = join('var', 'app')
  assert.equal(managedTorrentPath(ud, 'id').startsWith(managedTorrentDir(ud)), true)
})
