/// <reference types="node" />

/**
 * `lib/extensionView` 纯函数单测 —— 这些映射被**两个界面**共用(设置页扩展分组 + 「浏览器扩展」页),
 * 故在此单独钉死措辞:两处渲染出的字都从这里来,这里错了两处一起错(U-34 的另一半保险)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExtensionChannelStatus, TakeoverSettingsView } from '../../../shared/ipc'
import {
  FALLBACK_STATUS,
  FALLBACK_TAKEOVER,
  LINK_NOTE,
  LINK_TEXT,
  PAUSE_PRESETS,
  SNIFF_PRIVACY_NOTE,
  clockText,
  invalidPortCode,
  linkText,
  serviceText,
  takeoverStateText
} from './extensionView'

function st(over: Partial<ExtensionChannelStatus> = {}): ExtensionChannelStatus {
  return { ...FALLBACK_STATUS, ...over }
}
function tk(over: Partial<TakeoverSettingsView> = {}): TakeoverSettingsView {
  return { ...FALLBACK_TAKEOVER, ...over }
}

// ── 服务状态三态 ──────────────────────────────────────────────────────────────

test('serviceText:listening 带回环地址与端口', () => {
  assert.equal(serviceText(st({ service: 'listening', port: 52330 })), '监听中 · 127.0.0.1:52330')
})

test('serviceText:port_in_use 说清是哪个端口被占', () => {
  assert.equal(serviceText(st({ service: 'port_in_use', port: 52330 })), '端口 52330 被占用,通道未启动')
})

test('★ serviceText:真实 listen 失败必须显示错误码,不被「已关闭」掩盖(诚实)', () => {
  assert.equal(serviceText(st({ service: 'stopped', lastError: 'EACCES' })), '未启动(EACCES)')
})

test('serviceText:`invalid_port:*` 不是 listen 失败 → 服务态仍是「已关闭」(那件事在端口块说)', () => {
  assert.equal(serviceText(st({ service: 'stopped', lastError: 'invalid_port:reserved_bt' })), '已关闭')
})

test('invalidPortCode:只认 `invalid_port:` 前缀,其余一律 null', () => {
  assert.equal(invalidPortCode('invalid_port:not_integer'), 'not_integer')
  assert.equal(invalidPortCode('EACCES'), null)
  assert.equal(invalidPortCode(null), null)
})

// ── 扩展连接三态 ──────────────────────────────────────────────────────────────

test('★ 第三态是「待活动」,**绝不是「断开」**(CONTEXT.md:握手事件驱动、无心跳,分不清就不假装)', () => {
  assert.equal(LINK_TEXT.idle_pending, '待活动')
  assert.equal(linkText(st({ link: 'idle_pending' })), '待活动')
  for (const v of Object.values(LINK_TEXT)) assert.equal(v.includes('断开'), false)
  for (const v of Object.values(LINK_NOTE)) assert.equal(v.includes('断开'), false)
})

test('★ unpaired 副文案只说「本次启动以来没收到握手」,不谎称未安装 / 未配对成功', () => {
  assert.equal(linkText(st({ link: 'unpaired' })), '未配对')
  assert.equal(LINK_NOTE.unpaired.includes('未安装'), false)
  assert.ok(LINK_NOTE.unpaired.includes('本次启动以来尚未收到扩展的握手'))
})

test('linkText:connected 附最近握手时间', () => {
  const s = linkText(st({ link: 'connected', lastHandshakeAt: Date.UTC(2026, 7, 3, 6, 30) }))
  assert.ok(s.startsWith('已连接(最近握手 '))
})

// ── 接管四态 ──────────────────────────────────────────────────────────────────

test('takeoverStateText:总开关关 → 「已关闭」(优先于其它判据)', () => {
  assert.equal(takeoverStateText(tk({ enabled: false }), st({ service: 'listening' }), 0), '已关闭')
})

test('takeoverStateText:暂停中 → 「已暂停 · 剩余 N 分钟(至 HH:MM)」', () => {
  const now = new Date(2026, 7, 3, 14, 30).getTime()
  const until = now + 60 * 60_000
  assert.equal(
    takeoverStateText(tk({ paused: true, pausedUntil: until }), st({ service: 'listening' }), now),
    `已暂停 · 剩余 60 分钟(至 ${clockText(until)})`
  )
})

test('★ 剩余分钟下限为 1:临到期不显示 0 / 负数(那看着像 bug,真相只是马上到期)', () => {
  const now = new Date(2026, 7, 3, 14, 30).getTime()
  const line = takeoverStateText(
    tk({ paused: true, pausedUntil: now - 5_000 }),
    st({ service: 'listening' }),
    now
  )
  assert.ok(line.startsWith('已暂停 · 剩余 1 分钟'))
})

test('★ 第四态绑在**确实为真**的判据上:通道没监听 → 接管必然不会发生', () => {
  assert.equal(
    takeoverStateText(tk(), st({ service: 'stopped' }), 0),
    '本地通道未启动 · 接管不会发生'
  )
})

test('★ 通道在监听但没握手过 ≠ 接管不会发生:状态仍是「接管中」(不替浏览器打包票)', () => {
  assert.equal(takeoverStateText(tk(), st({ service: 'listening', link: 'unpaired' }), 0), '接管中')
})

test('★ 暂停档**恰好三档纯时间**,无「直到关闭浏览器」/「永久暂停」', () => {
  assert.deepEqual(
    PAUSE_PRESETS.map((p) => p.label),
    ['15 分钟', '1 小时', '4 小时']
  )
  assert.deepEqual(
    PAUSE_PRESETS.map((p) => p.minutes),
    [15, 60, 240]
  )
})

test('接管兜底**默认开**(装了扩展即视为授权),通道兜底**默认关**(不白开监听端口)', () => {
  assert.equal(FALLBACK_TAKEOVER.enabled, true)
  assert.equal(FALLBACK_STATUS.enabled, false)
  assert.equal(FALLBACK_STATUS.service, 'stopped')
})

// ── 隐私说明三句 ──────────────────────────────────────────────────────────────

test('★ 隐私说明三句逐字(两处共用同一常量,改这里两处一起改)', () => {
  assert.equal(
    SNIFF_PRIVACY_NOTE,
    '本扩展不注入页面脚本,只读取网络请求的地址与响应头。嗅探结果不上传、不保存,关闭浏览器即清除。'
  )
})
