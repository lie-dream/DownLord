/**
 * L4 · MediaTool(MVP 退化形态)—— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L4 层)。
 *
 * `mediaTool.ts` 此前**零覆盖**,但它完全是注入式纯逻辑(binDir 由主进程装配传入,不碰 `app`)。
 *
 * 值得钉住的是那条**架构承诺**:DownLord 不自己拼 ffmpeg 命令、不自己起 ffmpeg 进程,
 * MediaTool 退化为「只告诉 yt-dlp 去哪儿找 ffmpeg」。故本文件既断言它**返回什么**,
 * 也断言它**不做什么** —— 接口面上除了 `resolveFfmpegLocation` 不该再长出别的东西,
 * 长出来就说明有人开始在这里拼命令行了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { createMediaTool } from './mediaTool'

const BIN_DIR = join('C:', 'app', 'resources', 'bin')

test('L4-mt-1 resolveFfmpegLocation 返回 binDir 下的内置 ffmpeg 绝对路径', () => {
  const tool = createMediaTool({ binDir: BIN_DIR })
  assert.equal(tool.resolveFfmpegLocation(), join(BIN_DIR, 'ffmpeg.exe'))
})

test('L4-mt-2 binDir 随注入变化(不缓存、不写死),每次现算', () => {
  const a = createMediaTool({ binDir: join('D:', 'a') })
  const b = createMediaTool({ binDir: join('D:', 'b') })
  assert.equal(a.resolveFfmpegLocation(), join('D:', 'a', 'ffmpeg.exe'))
  assert.equal(b.resolveFfmpegLocation(), join('D:', 'b', 'ffmpeg.exe'))
  assert.notEqual(a.resolveFfmpegLocation(), b.resolveFfmpegLocation())
})

test('L4-mt-3 MediaTool 只有「定位」这一件事:接口面恰为 resolveFfmpegLocation 一个方法', () => {
  const tool = createMediaTool({ binDir: BIN_DIR })
  assert.deepEqual(
    Object.keys(tool),
    ['resolveFfmpegLocation'],
    'ARCHITECTURE §4:合并 / 转码全交 yt-dlp 内部调 ffmpeg,这里多出任何方法都意味着开始自起进程了'
  )
})

test('L4-mt-4 同一实例多次调用结果稳定(纯函数,无隐藏状态)', () => {
  const tool = createMediaTool({ binDir: BIN_DIR })
  assert.equal(tool.resolveFfmpegLocation(), tool.resolveFfmpegLocation())
})
