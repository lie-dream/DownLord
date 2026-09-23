import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toYtdlpHeaderArgs } from './ytdlpHeaders'
import { filterDownloadHeaders, TAKEOVER_HEADER_ALLOWLIST } from '../../shared/downloadHeaders'

/** yt-dlp headers 注入的纯函数单测(v0.4 Task 5 · spec §4.5 · 用例 U-25) */

test('U-25 ★ 缺省恒产 []:undefined 与 {} 都返回空数组(缺省逐字节等价的形状保证)', () => {
  assert.deepStrictEqual(toYtdlpHeaderArgs(undefined), [])
  assert.deepStrictEqual(toYtdlpHeaderArgs(), [])
  assert.deepStrictEqual(toYtdlpHeaderArgs({}), [])
  // 白名单外的键 / 空串值一个都不产参数(空 Referer 与不下发 referer 是同一件事)
  assert.deepStrictEqual(toYtdlpHeaderArgs({ Cookie: 'sid=1' }), [])
  assert.deepStrictEqual(toYtdlpHeaderArgs({ Referer: '', 'User-Agent': '' }), [])
  // 大小写不规范的键也不产参数 —— 上游 `filterDownloadHeaders` 已把键名归一,这里按精确键取值
  assert.deepStrictEqual(toYtdlpHeaderArgs({ referer: 'https://a/' }), [])
})

test('U-25 附:两个白名单键各自独立成对产出,顺序恒为 referer 在前', () => {
  assert.deepStrictEqual(toYtdlpHeaderArgs({ Referer: 'https://page/' }), [
    '--referer',
    'https://page/'
  ])
  assert.deepStrictEqual(toYtdlpHeaderArgs({ 'User-Agent': 'UA/1.0' }), ['--user-agent', 'UA/1.0'])
  assert.deepStrictEqual(toYtdlpHeaderArgs({ 'User-Agent': 'UA/1.0', Referer: 'https://page/' }), [
    '--referer',
    'https://page/',
    '--user-agent',
    'UA/1.0'
  ])
})

test('★ 白名单第③层:不用 --add-header(任意头入口),且只认第②层放行的那两个键', () => {
  // 与 aria2 侧 `toAria2HeaderOptions` 逐字同构:白名单只有两个键,这里也只可能产出两种选项
  const produced = toYtdlpHeaderArgs({
    Referer: 'https://page/',
    'User-Agent': 'UA/1.0'
  }).filter((a) => a.startsWith('--'))
  assert.deepStrictEqual(produced, ['--referer', '--user-agent'])
  assert.equal(produced.some((a) => a.includes('add-header')), false, '★ 绝不产出 --add-header')

  // ★ 与白名单常量对账:白名单有几个键,这里最多产出几个选项 —— 改白名单必然改到这里
  assert.equal(produced.length, TAKEOVER_HEADER_ALLOWLIST.length)
})

test('★ 与第②层串起来:整条链路只可能把 Referer / User-Agent 送到 yt-dlp', () => {
  // 上游传来一堆越界键(伪造载荷的极端情形)→ 第②层过滤 → 第③层只认两个专用选项
  const filtered = filterDownloadHeaders({
    referer: 'https://page.example.com/',
    'USER-AGENT': 'UA/2.0',
    Cookie: 'sid=SECRET',
    Authorization: 'Bearer SECRET',
    'X-Anything': 'v'
  })
  const args = toYtdlpHeaderArgs(filtered)
  assert.deepStrictEqual(args, [
    '--referer',
    'https://page.example.com/',
    '--user-agent',
    'UA/2.0'
  ])
  assert.equal(args.join(' ').includes('SECRET'), false, '★ Cookie / Authorization 的值一个字符都不许流到引擎')
})
