/**
 * L4 · 启动期二进制自检的纯函数 —— v1.0 Task 1 Phase 2 后半(spec §2.1 的 L4 层)。
 *
 * `selfCheck.ts` 此前**零覆盖**。它不是不可测,只是没人测过:两个导出都是纯函数 + 注入式探针,
 * 连 fs 都不碰。零覆盖清单上它属「真缺口」而非豁免。
 *
 * 被钉住的性质有三条,每条都对应一句「缺失不抛错」的设计承诺:
 *   ① 三引擎的探针顺序与路径来源(yt-dlp 用**已解析**路径,可能是用户可写区的副本,不是内置路径);
 *   ② `checkBinaries` **绝不抛错**,缺失只落 `ok:false` —— 抛了就会在 `app.whenReady` 里炸掉整个启动;
 *   ③ 结果是**结构化**的(name / path / ok 三件),调用方才写得出「缺哪个」的日志。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import { buildEngineProbes, checkBinaries } from './selfCheck'

const BIN_DIR = join('C:', 'app', 'resources', 'bin')
const WRITABLE_YTDLP = join('C:', 'Users', 'x', 'AppData', 'Roaming', 'DownLord', 'bin', 'yt-dlp.exe')

test('L4-sc-1 buildEngineProbes 产出三引擎探针,顺序与名字固定', () => {
  const probes = buildEngineProbes({ binDir: BIN_DIR, ytDlpPath: WRITABLE_YTDLP })
  assert.deepEqual(
    probes.map((p) => p.name),
    ['aria2c', 'yt-dlp', 'ffmpeg']
  )
})

test('L4-sc-2 aria2c / ffmpeg 取内置路径,yt-dlp 取传入的已解析路径(可写副本优先,不回落内置)', () => {
  const probes = buildEngineProbes({ binDir: BIN_DIR, ytDlpPath: WRITABLE_YTDLP })
  const byName = Object.fromEntries(probes.map((p) => [p.name, p.path]))

  assert.equal(byName['aria2c'], join(BIN_DIR, 'aria2c.exe'))
  assert.equal(byName['ffmpeg'], join(BIN_DIR, 'ffmpeg.exe'))
  assert.equal(
    byName['yt-dlp'],
    WRITABLE_YTDLP,
    'yt-dlp 必须用调用方解析好的路径 —— 拼回 binDir 就等于永远自检那个「占位副本永不更新」的内置件'
  )
  assert.notEqual(byName['yt-dlp'], join(BIN_DIR, 'yt-dlp.exe'), '反面钉死:不得回落内置路径')
})

test('L4-sc-3 checkBinaries 逐条判存在性,缺失只标 ok:false 且绝不抛错', () => {
  const probes = buildEngineProbes({ binDir: BIN_DIR, ytDlpPath: WRITABLE_YTDLP })
  const present = new Set([join(BIN_DIR, 'aria2c.exe'), WRITABLE_YTDLP])

  const results = checkBinaries(probes, (p) => present.has(p))

  assert.deepEqual(results, [
    { name: 'aria2c', path: join(BIN_DIR, 'aria2c.exe'), ok: true },
    { name: 'yt-dlp', path: WRITABLE_YTDLP, ok: true },
    { name: 'ffmpeg', path: join(BIN_DIR, 'ffmpeg.exe'), ok: false }
  ])
})

test('L4-sc-4 三个全缺也只是三条 ok:false —— 启动期自检不许把应用炸掉', () => {
  const probes = buildEngineProbes({ binDir: BIN_DIR, ytDlpPath: WRITABLE_YTDLP })
  const results = checkBinaries(probes, () => false)
  assert.equal(results.length, 3)
  assert.equal(
    results.every((r) => r.ok === false),
    true
  )
  // 正向对照:同一组探针在「全在」时全 true —— 否则上一条在「ok 恒 false」时也绿
  assert.equal(
    checkBinaries(probes, () => true).every((r) => r.ok === true),
    true
  )
})

test('L4-sc-5 探针为空数组时回空数组(不炸、不塞默认值)', () => {
  assert.deepEqual(checkBinaries([], () => true), [])
})

test('L4-sc-6 探针里的 path 被原样传给 existsSync,一个字符都不加工', () => {
  const seen: string[] = []
  const probes = buildEngineProbes({ binDir: BIN_DIR, ytDlpPath: WRITABLE_YTDLP })
  checkBinaries(probes, (p) => {
    seen.push(p)
    return true
  })
  assert.deepEqual(seen, probes.map((p) => p.path))
})
