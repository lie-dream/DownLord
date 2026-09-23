import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAria2Version,
  parseYtDlpVersion,
  parseFfmpegVersion,
  mergeProbedVersions
} from './probeVersion'
import { ENGINE_VERSIONS } from './engineVersions'

// ── aria2c --version ──────────────────────────────────────────────────────────
test('parseAria2Version 从真实 `aria2c --version` 多行输出取版本号', () => {
  const raw = [
    'aria2 version 1.37.0',
    'Copyright (C) 2006, 2019 Tatsuhiro Tsujikawa',
    '',
    'This program is free software; you can redistribute it and/or modify',
    'it under the terms of the GNU General Public License as published by'
  ].join('\n')
  assert.equal(parseAria2Version(raw), '1.37.0')
})

test('parseAria2Version 空 / 不匹配输出返回 null(由调用方回退静态常量)', () => {
  assert.equal(parseAria2Version(''), null)
  assert.equal(parseAria2Version('command not found'), null)
})

// ── yt-dlp --version ──────────────────────────────────────────────────────────
test('parseYtDlpVersion 取 stable 日期版本号 YYYY.MM.DD', () => {
  assert.equal(parseYtDlpVersion('2026.06.30\n'), '2026.06.30')
})

test('parseYtDlpVersion 取 nightly 带第四段的版本号', () => {
  assert.equal(parseYtDlpVersion('2026.06.30.232815\n'), '2026.06.30.232815')
})

test('parseYtDlpVersion 跳过前置告警行,仍取版本号', () => {
  const raw = ['WARNING: you are using an outdated version of yt-dlp', '2026.06.30'].join('\n')
  assert.equal(parseYtDlpVersion(raw), '2026.06.30')
})

test('parseYtDlpVersion 空 / 不匹配输出返回 null', () => {
  assert.equal(parseYtDlpVersion(''), null)
  assert.equal(parseYtDlpVersion('not a version'), null)
})

// ── ffmpeg -version ───────────────────────────────────────────────────────────
test('parseFfmpegVersion 取 gyan.dev build 的数字版本(剥除 -full_build 后缀)', () => {
  const raw = [
    'ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers',
    'built with gcc 14.2.0 (Rev1, Built by MSYS2 project)'
  ].join('\n')
  assert.equal(parseFfmpegVersion(raw), '7.1')
})

test('parseFfmpegVersion 取 BtbN build 的版本(剥除 n 前缀)', () => {
  const raw = 'ffmpeg version n7.1 Copyright (c) 2000-2024 the FFmpeg developers'
  assert.equal(parseFfmpegVersion(raw), '7.1')
})

test('parseFfmpegVersion 取 release build 的三段版本号', () => {
  const raw = 'ffmpeg version 7.0.2 Copyright (c) 2000-2024 the FFmpeg developers'
  assert.equal(parseFfmpegVersion(raw), '7.0.2')
})

test('parseFfmpegVersion 空 / 不匹配输出返回 null', () => {
  assert.equal(parseFfmpegVersion(''), null)
  assert.equal(parseFfmpegVersion('ffmpeg: command not found'), null)
})

// ── mergeProbedVersions(回退逻辑)─────────────────────────────────────────────
test('mergeProbedVersions 三引擎均解析成功时返回探测值', () => {
  const fallback = { aria2: '0.0', ytdlp: '0000.00.00', ffmpeg: '0.0' }
  const merged = mergeProbedVersions(
    {
      aria2: 'aria2 version 1.37.0',
      ytdlp: '2026.06.30',
      ffmpeg: 'ffmpeg version 7.1-full_build-www.gyan.dev'
    },
    fallback
  )
  assert.deepEqual(merged, { aria2: '1.37.0', ytdlp: '2026.06.30', ffmpeg: '7.1' })
})

test('mergeProbedVersions 单引擎探测为 null 时该字段回退静态常量', () => {
  const merged = mergeProbedVersions(
    { aria2: null, ytdlp: '2026.06.30', ffmpeg: 'ffmpeg version 7.1' },
    ENGINE_VERSIONS
  )
  assert.equal(merged.aria2, ENGINE_VERSIONS.aria2) // 探测缺失 → 回退
  assert.equal(merged.ytdlp, '2026.06.30') // 探测成功 → 真实值
  assert.equal(merged.ffmpeg, '7.1')
})

test('mergeProbedVersions 解析失败(输出存在但不匹配)时该字段回退静态常量', () => {
  const merged = mergeProbedVersions(
    { aria2: 'garbage output', ytdlp: 'garbage', ffmpeg: 'garbage' },
    ENGINE_VERSIONS
  )
  assert.deepEqual(merged, ENGINE_VERSIONS)
})
