import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CHANNEL_PORT,
  MIN_CHANNEL_PORT,
  RESERVED_BT_PORT_MAX,
  RESERVED_BT_PORT_MIN,
  validateChannelPort
} from './portValidation'

/** 端口校验单测(v0.4 Task 3 · spec §5.2 / §7.1) */

test('52330(默认)→ 合法', () => {
  assert.deepStrictEqual(validateChannelPort(52330), { ok: true, port: 52330 })
})

test('80 / 1023 → out_of_range(<1024)', () => {
  assert.deepStrictEqual(validateChannelPort(80), { ok: false, code: 'out_of_range' })
  assert.deepStrictEqual(validateChannelPort(MIN_CHANNEL_PORT - 1), {
    ok: false,
    code: 'out_of_range'
  })
  assert.deepStrictEqual(validateChannelPort(MIN_CHANNEL_PORT), {
    ok: true,
    port: MIN_CHANNEL_PORT
  })
})

test('70000 → out_of_range(>65535)', () => {
  assert.deepStrictEqual(validateChannelPort(70000), { ok: false, code: 'out_of_range' })
  assert.deepStrictEqual(validateChannelPort(MAX_CHANNEL_PORT), {
    ok: true,
    port: MAX_CHANNEL_PORT
  })
  assert.deepStrictEqual(validateChannelPort(MAX_CHANNEL_PORT + 1), {
    ok: false,
    code: 'out_of_range'
  })
})

test('非整数 / NaN / 字符串 / null / undefined → not_integer', () => {
  for (const v of [52330.5, Number.NaN, '52330', null, undefined, {}, [], Infinity]) {
    assert.deepStrictEqual(
      validateChannelPort(v),
      { ok: false, code: 'not_integer' },
      `应拒:${String(v)}`
    )
  }
})

test('★ 52305 → reserved_bt(落在 BT 52301-52310 / DHT 52311-52320 已占段)', () => {
  assert.deepStrictEqual(validateChannelPort(52305), { ok: false, code: 'reserved_bt' })
  assert.deepStrictEqual(validateChannelPort(52315), { ok: false, code: 'reserved_bt' })
  assert.deepStrictEqual(validateChannelPort(RESERVED_BT_PORT_MIN), {
    ok: false,
    code: 'reserved_bt'
  })
  assert.deepStrictEqual(validateChannelPort(RESERVED_BT_PORT_MAX), {
    ok: false,
    code: 'reserved_bt'
  })
  // 段的两侧边界外仍合法(不误伤)
  assert.equal(validateChannelPort(RESERVED_BT_PORT_MIN - 1).ok, true)
  assert.equal(validateChannelPort(RESERVED_BT_PORT_MAX + 1).ok, true)
})
