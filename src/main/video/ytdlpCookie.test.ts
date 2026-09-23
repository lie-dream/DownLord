import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toYtdlpCookieArgs } from './ytdlpCookie'
import type { CookieConfig } from '../../shared/ipc'

/** 构造 CookieConfig,只覆盖关心字段(其余补 null) */
function cookie(partial: Partial<CookieConfig>): CookieConfig {
  return { source: 'none', browser: null, profile: null, file: null, ...partial }
}

// ==================== none / undefined → 零附加(向后兼容,spec §2.1)====================

test('toYtdlpCookieArgs undefined → [](调用方不带 cookie 概念,零回归)', () => {
  assert.deepEqual(toYtdlpCookieArgs(undefined), [])
})

test('toYtdlpCookieArgs source none → [](向后兼容,与 v0.1 逐字节等价)', () => {
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'none' })), [])
})

// ==================== browser → --cookies-from-browser(spec §2.1)====================

test('toYtdlpCookieArgs browser → --cookies-from-browser <browser>', () => {
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'browser', browser: 'chrome' })), [
    '--cookies-from-browser',
    'chrome'
  ])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'browser', browser: 'firefox' })), [
    '--cookies-from-browser',
    'firefox'
  ])
})

test('toYtdlpCookieArgs browser + profile → <browser>:<profile> 拼接(前向兼容)', () => {
  assert.deepEqual(
    toYtdlpCookieArgs(cookie({ source: 'browser', browser: 'chrome', profile: 'Default' })),
    ['--cookies-from-browser', 'chrome:Default']
  )
})

// ==================== file → --cookies <path>(spec §2.1)====================

test('toYtdlpCookieArgs file → --cookies <绝对路径>', () => {
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'file', file: 'D:\\cookies\\bili.txt' })), [
    '--cookies',
    'D:\\cookies\\bili.txt'
  ])
})

// ==================== 配置不完整 → 退化零附加(不产坏参数,spec §2.1)====================

test('toYtdlpCookieArgs browser 但 browser 为 null → [](配置不完整,不产坏参数)', () => {
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'browser', browser: null })), [])
})

test('toYtdlpCookieArgs file 但 file 为 null → [](配置不完整,不产坏参数)', () => {
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'file', file: null })), [])
})

// ============ N5:第四档 extension → 与 file 档同形(v0.4 Task 6 · spec §2.2)============

test('N5 第四档 + 有临时文件 → --cookies <路径>(与 file 档产出同形,不改 yt-dlp 调用协议)', () => {
  assert.deepEqual(
    toYtdlpCookieArgs(cookie({ source: 'extension' }), 'C:\\Users\\x\\cookies-tmp\\ck-abc.txt'),
    ['--cookies', 'C:\\Users\\x\\cookies-tmp\\ck-abc.txt']
  )
})

test('N5 第四档 + 无临时文件 → [](退化零附加:参数与 none 档逐字节相同,公开内容照下不误)', () => {
  // ⚠️ 这**不是**错误路径 —— 手上没登录态时照常跑 yt-dlp,失败了再由 mapError 的上下文改判
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'extension' })), [])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'extension' }), ''), [])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'extension' }), undefined), [])
})

test('N5 ★ 零回归:既有三档传了第二参也**一个字节不受影响**(加性可选参的机器证据)', () => {
  const p = 'D:\\tmp\\ck-deadbeef.txt'
  // 上面既有那 7 条用例调的是「不传第二参」;这里补的是「传了也不看」那一半 ——
  // 若哪天有人把第四档分支挪到 file / browser 之前,这一条当场红
  assert.deepEqual(toYtdlpCookieArgs(undefined, p), [])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'none' }), p), [])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'browser', browser: 'chrome' }), p), [
    '--cookies-from-browser',
    'chrome'
  ])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'file', file: 'D:\\c\\bili.txt' }), p), [
    '--cookies',
    'D:\\c\\bili.txt'
  ])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'browser', browser: null }), p), [])
  assert.deepEqual(toYtdlpCookieArgs(cookie({ source: 'file', file: null }), p), [])
})
