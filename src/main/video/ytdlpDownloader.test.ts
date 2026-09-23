import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toYtdlpDownloaderArgs } from './ytdlpDownloader'

const ARIA2C = 'C:\\bin\\aria2c.exe'

// ==================== 挂 aria2c 分支(spec §2.4 / §3.1 / §7.1)====================

test('挂 aria2c + 0(不限)→ --downloader <path> + --downloader-args aria2c:…(无 --max-download-limit)', () => {
  assert.deepEqual(toYtdlpDownloaderArgs({ enabled: true, aria2cPath: ARIA2C, limitKBps: 0 }), [
    '--downloader',
    ARIA2C,
    '--downloader-args',
    'aria2c:-x 16 -s 16 -k 1M --connect-timeout=10 --auto-save-interval=1 --allow-overwrite=true'
  ])
})

test('挂 aria2c + 500 → downloader-args 单 argv 元素末尾追加 " --max-download-limit=500K"', () => {
  assert.deepEqual(toYtdlpDownloaderArgs({ enabled: true, aria2cPath: ARIA2C, limitKBps: 500 }), [
    '--downloader',
    ARIA2C,
    '--downloader-args',
    'aria2c:-x 16 -s 16 -k 1M --connect-timeout=10 --auto-save-interval=1 --allow-overwrite=true --max-download-limit=500K'
  ])
})

// ============ 未挂 aria2c 分支(自带下载器 → --concurrent-fragments + --limit-rate,spec §2.4 / §7.1 / #24)============

test('未挂 aria2c + 0(不限)→ [--concurrent-fragments, 4](分片并发提速;不加 --limit-rate,v0.3 Task 4 · #24)', () => {
  assert.deepEqual(toYtdlpDownloaderArgs({ enabled: false, aria2cPath: ARIA2C, limitKBps: 0 }), [
    '--concurrent-fragments',
    '4'
  ])
})

test('未挂 aria2c + 500 → [--concurrent-fragments, 4, --limit-rate, 500K](分片并发 + 自带下载器限速)', () => {
  assert.deepEqual(toYtdlpDownloaderArgs({ enabled: false, aria2cPath: '', limitKBps: 500 }), [
    '--concurrent-fragments',
    '4',
    '--limit-rate',
    '500K'
  ])
})
