/**
 * 配对输入校验单测(v0.4 Task 3 · spec §4.2 / §6.3)。
 *
 * 覆盖的是**真会发生**的输入:从 DownLord 复制常带换行与空格,手打常打成大写或少一位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PORT, MIN_PORT, TOKEN_LENGTH, validatePairingForm } from './pairing'

const TOKEN = '0123456789abcdef'.repeat(4)

function check(token: string, port: string, hasSavedToken = false): ReturnType<typeof validatePairingForm> {
  return validatePairingForm({ token, port, hasSavedToken })
}

test('合法输入 → 给出可落库的值', () => {
  assert.deepEqual(check(TOKEN, '52330'), { ok: true, port: 52330, token: TOKEN })
})

test('token: 首尾空白 / 换行必须容忍(粘贴几乎一定带)', () => {
  assert.deepEqual(check(`  ${TOKEN}\n`, ' 52330 '), { ok: true, port: 52330, token: TOKEN })
  assert.deepEqual(check(`\r\n${TOKEN}\t`, '52330'), { ok: true, port: 52330, token: TOKEN })
})

test('token: 大小写混用 / 全大写不容忍,且说清是「哪一项」不合法', () => {
  for (const bad of [TOKEN.toUpperCase(), `${TOKEN.slice(0, 63)}A`]) {
    const result = check(bad, '52330')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.field, 'token')
    assert.match(result.ok === false ? result.message : '', /小写/)
  }
})

test('token: 长度不符 → 消息里带上实际位数(用户才知道是少粘了还是多粘了)', () => {
  const short = check(TOKEN.slice(0, 63), '52330')
  assert.equal(short.ok, false)
  assert.match(short.ok === false ? short.message : '', new RegExp(`${TOKEN_LENGTH} 位`))
  assert.match(short.ok === false ? short.message : '', /63 位/)

  const long = check(`${TOKEN}0`, '52330')
  assert.equal(long.ok, false)
  assert.match(long.ok === false ? long.message : '', /65 位/)
})

test('token: 含非 hex 字符(如中文引号 / 空格夹在中间)→ 红', () => {
  const result = check(`${TOKEN.slice(0, 32)} ${TOKEN.slice(33)}`, '52330')
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.field, 'token')
})

test('token: 留空 —— 未配对时红,已配对时视为「沿用旧的」(改端口不必重新配对)', () => {
  const fresh = check('   ', '52330', false)
  assert.equal(fresh.ok, false)
  assert.equal(fresh.ok === false && fresh.field, 'token')

  assert.deepEqual(check('   ', '52341', true), { ok: true, port: 52341, token: null })
})

test('port: 边界 —— 1024 与 65535 合法,1023 与 65536 非法', () => {
  assert.equal(check(TOKEN, String(MIN_PORT)).ok, true)
  assert.equal(check(TOKEN, String(MAX_PORT)).ok, true)

  for (const bad of [String(MIN_PORT - 1), String(MAX_PORT + 1), '0', '80']) {
    const result = check(TOKEN, bad)
    assert.equal(result.ok, false, `端口 ${bad} 应被拒`)
    assert.equal(result.ok === false && result.field, 'port')
  }
})

test('port: 非纯数字一律红 —— 不学 parseInt 把 "52330abc" 静默读成 52330', () => {
  for (const bad of ['52330abc', '5233 0', '', '  ', '52330.5', '-52330', '0x52330', '五二三三零']) {
    const result = check(TOKEN, bad)
    assert.equal(result.ok, false, `端口 "${bad}" 应被拒`)
    assert.equal(result.ok === false && result.field, 'port')
  }
})

test('★ 先报 token 再报 port:两项都错时只回其中一项,但回的是**具体那一项**', () => {
  const both = check('nope', 'nope')
  assert.equal(both.ok, false)
  assert.equal(both.ok === false && both.field, 'token')

  const onlyPort = check(TOKEN, 'nope')
  assert.equal(onlyPort.ok === false && onlyPort.field, 'port')
})

test('校验失败的文案里不含空话', () => {
  const messages = [check('nope', '52330'), check(TOKEN, 'nope'), check('', '52330')]
    .map((r) => (r.ok === false ? r.message : ''))

  for (const message of messages) {
    assert.ok(message.length > 0)
    assert.equal(/未知错误|请重试|输入有误/.test(message), false, `空话文案:${message}`)
  }
})
