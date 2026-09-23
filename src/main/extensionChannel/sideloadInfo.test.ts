import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { getSideloadInfo, resolveExtensionDir } from './sideloadInfo'

/** 扩展目录定位单测(v0.4 Task 3 · spec §4.5 / §7.1;与 binaries/locator 的 resolveBinDir 同形) */

test('打包态 → <resources>/extension', () => {
  assert.equal(
    resolveExtensionDir({
      isPackaged: true,
      resourcesPath: 'C:/Program Files/DownLord/resources',
      appPath: 'C:/Program Files/DownLord/resources/app.asar'
    }),
    join('C:/Program Files/DownLord/resources', 'extension')
  )
})

test('dev 态 → <项目根>/extension/dist(构建产物目录,不是源码目录)', () => {
  assert.equal(
    resolveExtensionDir({
      isPackaged: false,
      resourcesPath: 'C:/electron/resources',
      appPath: 'D:/Projects/DownLord'
    }),
    join('D:/Projects/DownLord', 'extension', 'dist')
  )
})

test('getSideloadInfo:存在性经注入探针实探(未构建扩展时如实回 false,不假装有)', () => {
  const dir = join('D:/Projects/DownLord', 'extension', 'dist')
  const probed: string[] = []

  const missing = getSideloadInfo({
    isPackaged: false,
    resourcesPath: 'C:/electron/resources',
    appPath: 'D:/Projects/DownLord',
    existsSync: (p) => {
      probed.push(p)
      return false
    }
  })
  assert.deepStrictEqual(missing, { dir, exists: false })
  assert.deepStrictEqual(probed, [dir], '恰好探一次,探的就是解析出来的那个目录')

  const present = getSideloadInfo({
    isPackaged: false,
    resourcesPath: 'C:/electron/resources',
    appPath: 'D:/Projects/DownLord',
    existsSync: () => true
  })
  assert.deepStrictEqual(present, { dir, exists: true })
})
