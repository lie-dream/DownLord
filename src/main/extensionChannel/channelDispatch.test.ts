import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dispatchChannelMessage, protocolMismatch, type ChannelHandlers } from './channelDispatch'
import { EXTENSION_PROTOCOL_VERSION } from '../../shared/extensionProtocol'

/** 信封校验 + 版本协商 + 分发单测(v0.4 Task 3 立 · Task 4 扩三支 · spec §2.4 / §7.1) */

/** 一条形状合法的 intent 载荷(六字段;`byExtensionId` 可选) */
const INTENT = {
  url: 'https://dl.example.com/a.zip',
  referrer: 'https://page.example.com/',
  danger: 'safe',
  totalBytes: 1024,
  userAgent: 'UA/1.0'
}

const SNAPSHOT = { enabled: true, pausedUntil: null, paused: false }

function handlers(): ChannelHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    handshake: (payload) => {
      calls.push(payload.extensionVersion)
      return { appVersion: '0.4.0' }
    },
    downloadIntent: (payload) => {
      calls.push(`intent:${payload.url}`)
      return { taken: false }
    },
    takeoverGetConfig: () => {
      calls.push('getConfig')
      return SNAPSHOT
    },
    takeoverSetPause: (payload) => {
      calls.push(`setPause:${String(payload.minutes)}`)
      return SNAPSHOT
    },
    sniffAddSelected: (payload) => {
      calls.push(`sniff:${payload.url}`)
      return { taken: false }
    },
    videoIntent: (payload) => {
      calls.push(`video:${payload.pageUrl}`)
      return { taken: false }
    },
    cookieOffer: (payload) => {
      // ⚠️ 只记**条数**,不记 domain / name / value —— 连测试夹具都按红线 R4 的尺子写:
      //    夹具里留一个 `payload.domain` 迟早会被人抄进真实 logger。
      calls.push(`cookie:${payload.cookies.length}`)
      return { accepted: true }
    }
  }
}

const MISMATCH = {
  ok: false,
  reason: 'protocol_mismatch',
  appProtocolVersion: EXTENSION_PROTOCOL_VERSION
}

test('版本相符 → 分发到 handshake handler,回 200 + ack', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    { type: 'handshake', protocolVersion: 3, payload: { extensionVersion: '0.4.0' } },
    h
  )
  assert.deepStrictEqual(result, {
    status: 200,
    body: { ok: true, protocolVersion: 3, payload: { appVersion: '0.4.0' } }
  })
  assert.deepStrictEqual(h.calls, ['0.4.0'], 'handler 恰好被调用一次')
})

test('旧扩展报 protocolVersion: 1 → 409 + appProtocolVersion:3(不尽力兼容)', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    { type: 'handshake', protocolVersion: 1, payload: { extensionVersion: '9.9.9' } },
    h
  )
  assert.deepStrictEqual(result, { status: 409, body: MISMATCH })
  assert.deepStrictEqual(h.calls, [], '版本不符时 handler 绝不能被调用')
})

test('未知 type → protocol_mismatch(增长表外的 type 一律拒,不静默降级)', () => {
  // ⚠️ 这里原本用的是 `download.intent`(Task 4 实现后换成了当时未实现的 `sniff.report`)。
  // `sniff.report` 在 v0.4 Task 5 Step 0 被**取消**、永不会实现 —— 故它现在是一个稳定的
  // 「表外 type」样本,用例意图不变:表外 / 未实现的 type 一律拒。
  const result = dispatchChannelMessage(
    { type: 'sniff.report', protocolVersion: 3, payload: { items: [] } },
    handlers()
  )
  assert.deepStrictEqual(result, { status: 409, body: MISMATCH })
})

test('信封缺字段 / 不是对象 / body 非 JSON(调用方传 null)→ 一律 protocol_mismatch', () => {
  const h = handlers()
  const cases: unknown[] = [
    null, // ← 调用方 JSON.parse 失败时传的值
    undefined,
    'plain text',
    42,
    [],
    {}, // 缺 type 与 protocolVersion
    { type: 'handshake' }, // 缺 protocolVersion
    { protocolVersion: 3, payload: {} }, // 缺 type
    { type: 'handshake', protocolVersion: '3', payload: {} }, // 版本不是数字(**当期版本**的字符串形态:唯一失败原因就是类型)
    { type: 'handshake', protocolVersion: 3 }, // 缺 payload
    { type: 'handshake', protocolVersion: 3, payload: {} }, // payload 缺 extensionVersion
    { type: 'handshake', protocolVersion: 3, payload: { extensionVersion: 4 } } // 类型不对
  ]
  for (const raw of cases) {
    assert.deepStrictEqual(
      dispatchChannelMessage(raw, h),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(raw) ?? String(raw)}`
    )
  }
  assert.deepStrictEqual(h.calls, [], '形状不合法时 handler 一次都不该被调用')
})

test('protocolMismatch():统一应答含 appProtocolVersion(鉴权已通过,告知哪边旧不是泄漏)', () => {
  assert.deepStrictEqual(protocolMismatch(), { status: 409, body: MISMATCH })
})

test('★ 鉴权先于版本检查:分发层根本不参与鉴权,故未鉴权请求拿不到 appProtocolVersion', () => {
  // 鉴权在 channelAuth.ts,失败时 channelServer 只回 {ok:false,reason:'unauthorized'};
  // 只有走到本文件的请求(=已过三闸)才可能拿到 appProtocolVersion。此处钉死后者的形状。
  const body = protocolMismatch().body
  assert.equal(body.ok, false)
  assert.equal(body.ok === false && body.reason, 'protocol_mismatch')
})

// ── v0.4 Task 4:三个新 type ────────────────────────────────────────────────

test('U-18: download.intent 形状合法 → 分发到 downloadIntent handler', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    { type: 'download.intent', protocolVersion: 3, payload: INTENT },
    h
  )

  assert.deepStrictEqual(result, {
    status: 200,
    body: { ok: true, protocolVersion: 3, payload: { taken: false } }
  })
  assert.deepStrictEqual(h.calls, ['intent:https://dl.example.com/a.zip'])
})

test('U-18: download.intent 形状守卫 —— 缺字段 / 类型错一律 protocolMismatch,handler 不被调用', () => {
  const h = handlers()
  const cases: unknown[] = [
    undefined,
    null,
    'text',
    [],
    {},
    { ...INTENT, url: undefined },
    { ...INTENT, referrer: undefined },
    { ...INTENT, danger: undefined },
    { ...INTENT, totalBytes: undefined },
    { ...INTENT, userAgent: undefined },
    { ...INTENT, url: 42 },
    { ...INTENT, totalBytes: '1024' },
    { ...INTENT, byExtensionId: 7 }
  ]

  for (const payload of cases) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type: 'download.intent', protocolVersion: 3, payload }, h),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(payload) ?? String(payload)}`
    )
  }
  assert.deepStrictEqual(h.calls, [])
})

test('U-18: download.intent 的 byExtensionId 可选 —— 给了字符串也放行', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    {
      type: 'download.intent',
      protocolVersion: 3,
      payload: { ...INTENT, byExtensionId: 'other-ext' }
    },
    h
  )
  assert.equal(result.status, 200)
})

test('U-18: takeover.getConfig 无 payload 也放行(只读快照,本就没有载荷可守)', () => {
  const h = handlers()
  for (const payload of [undefined, {}, { junk: 1 }]) {
    const result = dispatchChannelMessage(
      { type: 'takeover.getConfig', protocolVersion: 3, payload },
      h
    )
    assert.deepStrictEqual(result, {
      status: 200,
      body: { ok: true, protocolVersion: 3, payload: SNAPSHOT }
    })
  }
  assert.deepStrictEqual(h.calls, ['getConfig', 'getConfig', 'getConfig'])
})

test('U-18: takeover.setPause 形状守卫 —— minutes 必须是数字或 null', () => {
  const h = handlers()

  for (const minutes of [60, 0, null]) {
    const result = dispatchChannelMessage(
      { type: 'takeover.setPause', protocolVersion: 3, payload: { minutes } },
      h
    )
    assert.equal(result.status, 200, `应放行:minutes=${String(minutes)}`)
  }
  assert.deepStrictEqual(h.calls, ['setPause:60', 'setPause:0', 'setPause:null'])

  const bad = handlers()
  for (const payload of [undefined, null, {}, { minutes: '60' }, { minutes: undefined }, []]) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type: 'takeover.setPause', protocolVersion: 3, payload }, bad),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(payload) ?? String(payload)}`
    )
  }
  assert.deepStrictEqual(bad.calls, [])
})

test('U-18: 版本不符时,四个新 type 的 handler 同样一次都不该被调用(顺序:版本先于 type)', () => {
  const h = handlers()
  for (const type of [
    'download.intent',
    'takeover.getConfig',
    'takeover.setPause',
    'sniff.addSelected'
  ]) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type, protocolVersion: 1, payload: INTENT }, h),
      { status: 409, body: MISMATCH }
    )
  }
  assert.deepStrictEqual(h.calls, [])
})

test('U-19: ★ download.intent 响应体 payload 只有 {taken} —— 不带 reason', () => {
  const result = dispatchChannelMessage(
    { type: 'download.intent', protocolVersion: 3, payload: INTENT },
    handlers()
  )

  assert.equal(result.body.ok, true)
  const payload = result.body.ok === true ? (result.body.payload as Record<string, unknown>) : {}
  // 多一个 reason 字段就会有人去写 `if (reason === 'paused')`,那等于把决策泄回扩展侧。
  // 「暂停中 / 规则不接管 / DownLord 未运行 / 通道不通」在扩展侧必须是同一条代码路径。
  assert.deepStrictEqual(Object.keys(payload), ['taken'])
})

// ── v0.4 Task 5:sniff.addSelected(唯一新增 type)─────────────────────────────

/** 一条形状合法的嗅探转交载荷(**五字段全必填**;没有 kind / dir / filename / header map / tabId) */
const SNIFF = {
  url: 'https://cdn.example.com/hls/index.m3u8',
  contentType: 'application/vnd.apple.mpegurl',
  referrer: 'https://page.example.com',
  userAgent: 'UA/1.0',
  totalBytes: -1
}

test('sniff.addSelected 形状合法 → 分发到 sniffAddSelected handler', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    { type: 'sniff.addSelected', protocolVersion: 3, payload: SNIFF },
    h
  )

  assert.deepStrictEqual(result, {
    status: 200,
    // ★ 应答复用 `DownloadIntentAck` —— 只有 taken,不带 reason
    body: { ok: true, protocolVersion: 3, payload: { taken: false } }
  })
  assert.deepStrictEqual(h.calls, ['sniff:https://cdn.example.com/hls/index.m3u8'])
})

test('sniff.addSelected 形状守卫 —— 缺字段 / 类型错一律 protocolMismatch(),handler 不被调用', () => {
  const h = handlers()
  const cases: unknown[] = [
    undefined,
    null,
    'text',
    [],
    {},
    { ...SNIFF, url: undefined },
    { ...SNIFF, contentType: undefined },
    { ...SNIFF, referrer: undefined },
    { ...SNIFF, userAgent: undefined },
    { ...SNIFF, totalBytes: undefined },
    { ...SNIFF, url: 42 },
    { ...SNIFF, contentType: null },
    { ...SNIFF, totalBytes: '1024' }
  ]

  for (const payload of cases) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type: 'sniff.addSelected', protocolVersion: 3, payload }, h),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(payload) ?? String(payload)}`
    )
  }
  assert.deepStrictEqual(h.calls, [], '形状不合法时 handler 一次都不该被调用')
})

test('★ 新增 type 不可能漏配安全策略:分发顺序仍是「版本 → type → payload 形状」', () => {
  // 鉴权在 `channelAuth.ts`,更在这一切之前 —— 这是单端点单处鉴权格局的白拿好处:
  // 加一个 type 只是往 switch 里加一支,鉴权那一层压根不需要知道有新 type。
  const h = handlers()
  // ① 版本先判:版本不符时,连形状都不会看(给一个形状完全合法的载荷也照拒)
  assert.deepStrictEqual(
    dispatchChannelMessage({ type: 'sniff.addSelected', protocolVersion: 1, payload: SNIFF }, h),
    { status: 409, body: MISMATCH }
  )
  // ② 版本符 + 形状不符 → 仍拒
  assert.deepStrictEqual(
    dispatchChannelMessage({ type: 'sniff.addSelected', protocolVersion: 3, payload: {} }, h),
    { status: 409, body: MISMATCH }
  )
  assert.deepStrictEqual(h.calls, [])
})

// ── v0.4 Task 6:video.intent + cookie.offer(N11)────────────────────────────

/** 一条形状合法的 `video.intent` 载荷(`pageUrl` 必填,`userAgent` 可选) */
const VIDEO = { pageUrl: 'https://www.example.com/video/BV1x', userAgent: 'UA/1.0' }

/** 一条形状合法的 `cookie.offer` 载荷(**分发层只看形状**,裸 host 与逐项字段归 service 层) */
const OFFER = {
  domain: 'www.example.com',
  cookies: [
    {
      name: 'SESSDATA',
      value: 'sentinel-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true
    }
  ]
}

test('N11: video.intent 形状合法 → 分发到 videoIntent handler(版本 3 通过)', () => {
  const h = handlers()
  const result = dispatchChannelMessage({ type: 'video.intent', protocolVersion: 3, payload: VIDEO }, h)

  assert.deepStrictEqual(result, {
    status: 200,
    body: { ok: true, protocolVersion: 3, payload: { taken: false } }
  })
  assert.deepStrictEqual(h.calls, ['video:https://www.example.com/video/BV1x'])
})

test('N11: video.intent 的 userAgent 可选 —— 不给也放行', () => {
  const h = handlers()
  const result = dispatchChannelMessage(
    { type: 'video.intent', protocolVersion: 3, payload: { pageUrl: VIDEO.pageUrl } },
    h
  )
  assert.equal(result.status, 200)
  assert.deepStrictEqual(h.calls, [`video:${VIDEO.pageUrl}`])
})

test('N11: video.intent 形状守卫 —— pageUrl 缺失 / 类型错一律 protocolMismatch(),handler 不被调用', () => {
  const h = handlers()
  const cases: unknown[] = [
    undefined,
    null,
    'text',
    [],
    {},
    { pageUrl: undefined },
    { pageUrl: 42 },
    { ...VIDEO, userAgent: 7 }
  ]
  for (const payload of cases) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type: 'video.intent', protocolVersion: 3, payload }, h),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(payload) ?? String(payload)}`
    )
  }
  assert.deepStrictEqual(h.calls, [], '形状不合法时 handler 一次都不该被调用')
})

test('N11: cookie.offer 形状合法 → 分发到 cookieOffer handler,应答**只有 accepted**(零回显)', () => {
  const h = handlers()
  const result = dispatchChannelMessage({ type: 'cookie.offer', protocolVersion: 3, payload: OFFER }, h)

  assert.deepStrictEqual(result, {
    status: 200,
    body: { ok: true, protocolVersion: 3, payload: { accepted: true } }
  })
  assert.deepStrictEqual(h.calls, ['cookie:1'])

  // ★ 零回显是 spec §7.3 全部安全论证的支点:通道上不存在任何「读出 cookie」的形状。
  //   多一个字段(哪怕只是「收了几条」)就得重算整个威胁模型。
  const payload = result.body.ok === true ? (result.body.payload as Record<string, unknown>) : {}
  assert.deepStrictEqual(Object.keys(payload), ['accepted'])
})

test('N11: cookie.offer 形状守卫 —— domain 非字符串 / cookies 非数组一律 protocolMismatch()', () => {
  const h = handlers()
  const cases: unknown[] = [
    undefined,
    null,
    'text',
    [],
    {},
    { domain: 'a.com' }, // 缺 cookies
    { cookies: [] }, // 缺 domain
    { domain: 42, cookies: [] },
    { domain: 'a.com', cookies: 'x' },
    { domain: 'a.com', cookies: {} }
  ]
  for (const payload of cases) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type: 'cookie.offer', protocolVersion: 3, payload }, h),
      { status: 409, body: MISMATCH },
      `应拒:${JSON.stringify(payload) ?? String(payload)}`
    )
  }
  assert.deepStrictEqual(h.calls, [])
})

test('N11: ★ 版本 2(Task 5 那一版)对两个新 type 一律 protocol_mismatch —— 增即 bump 的机器判据', () => {
  const h = handlers()
  for (const [type, payload] of [
    ['video.intent', VIDEO],
    ['cookie.offer', OFFER]
  ] as const) {
    assert.deepStrictEqual(
      dispatchChannelMessage({ type, protocolVersion: 2, payload }, h),
      { status: 409, body: MISMATCH },
      `版本 2 的 ${type} 必须被拒`
    )
  }
  // 版本不符时 handler 一次都不该被调用 —— 否则「不尽力兼容」就只是一句口号
  assert.deepStrictEqual(h.calls, [])
})
