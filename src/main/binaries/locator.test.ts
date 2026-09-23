import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  BinaryName,
  resolveBinDir,
  resolveBundledPath,
  resolveYtDlpPath,
  userWritableYtDlpPath
} from './locator'

test('resolveBinDir returns resources/bin in dev and process resources bin when packaged', () => {
  const devBinDir = resolveBinDir({
    isPackaged: false,
    resourcesPath: join('C:', 'Electron', 'resources'),
    appPath: join('D:', 'Fixtures', 'Workspace', 'Apps', 'SampleProject')
  })

  assert.equal(
    devBinDir,
    join('D:', 'Fixtures', 'Workspace', 'Apps', 'SampleProject', 'resources', 'bin')
  )

  const packagedBinDir = resolveBinDir({
    isPackaged: true,
    resourcesPath: join(
      'C:',
      'Users',
      'test-user',
      'AppData',
      'Local',
      'Programs',
      'DownLord',
      'resources'
    ),
    appPath: join('C:', 'Users', 'test-user', 'AppData', 'Local', 'Programs', 'DownLord')
  })

  assert.equal(
    packagedBinDir,
    join('C:', 'Users', 'test-user', 'AppData', 'Local', 'Programs', 'DownLord', 'resources', 'bin')
  )
})

test('resolveYtDlpPath prefers the writable user copy and falls back to the bundled copy', () => {
  const binDir = join('D:', 'Fixtures', 'Workspace', 'Apps', 'SampleProject', 'resources', 'bin')
  const userDataDir = join('C:', 'Users', 'test-user', 'AppData', 'Roaming', 'DownLord')
  const writableCopy = userWritableYtDlpPath(userDataDir)
  const bundledCopy = resolveBundledPath(binDir, BinaryName.YtDlp)

  assert.equal(
    resolveYtDlpPath({
      binDir,
      userDataDir,
      existsSync: (path) => path === writableCopy
    }),
    writableCopy
  )

  assert.equal(
    resolveYtDlpPath({
      binDir,
      userDataDir,
      existsSync: () => false
    }),
    bundledCopy
  )
})
