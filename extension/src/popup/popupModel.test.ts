/**
 * popup 数据层单测(v0.4 Task 2 立 · Task 3 补配对态与四原因码文案)。
 *
 * 数据层是纯函数,所以 popup 的「缺失兜底」与「四原因码怎么说人话」不必开浏览器就能断言 ——
 * 这正是把 popup 拆成 model / view 两层的目的(Task 2 spec §2.1)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MISSING_PLACEHOLDER, buildPopupModel, type PopupFacts } from './popupModel'
import type { SniffBucket, SniffedItem } from '../sniff/sniffBucket'
import type { SniffGroup } from '../sniff/sniffRules'

const TOKEN = 'a'.repeat(64)

/** 一条桶内条目。**来源是 origin 级**,与真实采集形态一致 */
function item(
  url: string,
  group: SniffGroup,
  ext: string,
  sizeBytes: number | null = null
): SniffedItem {
  return {
    url,
    contentType: '',
    initiator: 'https://page.example',
    ext,
    group,
    sizeBytes,
    seq: 0
  }
}

function bucketOf(items: SniffedItem[], overrides: Partial<SniffBucket> = {}): SniffBucket {
  return {
    seq: items.length,
    segmentCount: 0,
    hiddenSmallCount: 0,
    overflowCount: 0,
    items,
    ...overrides
  }
}

function makeFacts(overrides: Partial<PopupFacts> = {}): PopupFacts {
  return {
    extensionVersion: '0.3.0',
    extensionId: 'joomlppocobhkaeinpcmkkbphnjmjiei',
    wake: { count: 12, lastEvent: 'startup' },
    pairing: undefined,
    lastHandshake: undefined,
    defaultPort: 52330,
    protocolVersion: 2,
    takeover: undefined,
    // v0.4 Task 5:默认取「两份 buildId 一致 + 嗅探关着」—— 与真实默认态一致,
    // 让上面那些老用例不必关心新字段
    buildId: '0.4.0+20260809-143022',
    swBuildId: '0.4.0+20260809-143022',
    sniffEnabled: false,
    sniff: undefined,
    sniffJustEnabled: false,
    sniffSent: {},
    // v0.4 Task 6:默认「本次还没点过那个按钮」
    videoIntent: undefined,
    ...overrides
  }
}

test('buildPopupModel: 事实齐全时原样透传,计数转字符串', () => {
  const model = buildPopupModel(makeFacts())

  assert.equal(model.version, '0.3.0')
  assert.equal(model.extensionId, 'joomlppocobhkaeinpcmkkbphnjmjiei')
  assert.equal(model.wakeCount, '12')
  assert.equal(model.lastEvent, 'startup')
})

test('buildPopupModel: wake 缺失(刚装上、还没被唤醒过)兜占位符,不显示 undefined(L5)', () => {
  const model = buildPopupModel(makeFacts({ wake: undefined }))

  assert.equal(model.wakeCount, MISSING_PLACEHOLDER)
  assert.equal(model.lastEvent, MISSING_PLACEHOLDER)
  // 已有的事实不受影响
  assert.equal(model.version, '0.3.0')
  assert.equal(model.extensionId, 'joomlppocobhkaeinpcmkkbphnjmjiei')
})

test('buildPopupModel: 空串 / 纯空白的版本与 ID 也兜占位符', () => {
  const model = buildPopupModel(makeFacts({ extensionVersion: '', extensionId: '   ' }))

  assert.equal(model.version, MISSING_PLACEHOLDER)
  assert.equal(model.extensionId, MISSING_PLACEHOLDER)
})

test('buildPopupModel: 脏 count(NaN / 小数)不渗进 UI', () => {
  assert.equal(
    buildPopupModel(makeFacts({ wake: { count: Number.NaN, lastEvent: 'install' } })).wakeCount,
    MISSING_PLACEHOLDER
  )
  assert.equal(
    buildPopupModel(makeFacts({ wake: { count: 3.7, lastEvent: 'install' } })).wakeCount,
    '3'
  )
})

test('buildPopupModel: 纯函数 —— 不改入参', () => {
  const facts = makeFacts({ pairing: { token: TOKEN, port: 52340 } })
  const snapshot = JSON.stringify(facts)

  buildPopupModel(facts)

  assert.equal(JSON.stringify(facts), snapshot, '入参未被就地修改')
})

// ── 配对态与端口预填 ────────────────────────────────────────────────────────

test('buildPopupModel: 未保存配对码 → 端口预填 DEFAULT_PORT(注入值,数据层不写魔法数)', () => {
  const model = buildPopupModel(makeFacts({ defaultPort: 52330 }))

  assert.equal(model.paired, false)
  assert.equal(model.pairingStatus, '未保存')
  assert.equal(model.portValue, '52330')
})

test('buildPopupModel: 已保存配对码 → 端口预填已存的那个(改端口不必重新配对)', () => {
  const model = buildPopupModel(makeFacts({ pairing: { token: TOKEN, port: 52341 } }))

  assert.equal(model.paired, true)
  assert.equal(model.pairingStatus, '已保存')
  assert.equal(model.portValue, '52341')
})

test('buildPopupModel: ★ 这一行只说「存没存」,绝不声称「配对成没成」(2026-07-31 手测 B3/B4)', () => {
  // 踩到的现象:粘一串**格式合法但不对**的 64 位 hex,DownLord 侧通道甚至还没开,
  // popup 却同时显示「连不上 DownLord」+「已配对」—— 自相矛盾,且「已配对」是我们**不知道**的事。
  // 根因是同词不同义:DownLord 侧的「已配对 / 未配对」基于**握手**(lastActiveAt),
  // 扩展侧却只能基于**storage 里有没有这串字符**。故扩展侧一律改说「已保存 / 未保存」。
  const wrongToken = buildPopupModel(
    makeFacts({
      pairing: { token: 'a'.repeat(64), port: 52330 },
      lastHandshake: { at: 1, reason: 'unreachable' }
    })
  )

  assert.equal(wrongToken.pairingStatus, '已保存')
  for (const field of [wrongToken.pairingStatus, wrongToken.connection]) {
    assert.equal(
      /已配对/.test(field),
      false,
      `「已配对」是基于握手的结论,扩展侧无权作出 —— 实际值:${field}`
    )
  }
  // 结果行必须仍然如实报「连不上」,不因为「存过码」就粉饰
  assert.match(wrongToken.connection, /连不上 DownLord/)
})

test('buildPopupModel: ★ token 绝不进 model —— 渲染层拿不到,就不可能写进 DOM', () => {
  const model = buildPopupModel(makeFacts({ pairing: { token: TOKEN, port: 52330 } }))

  for (const [key, value] of Object.entries(model)) {
    assert.equal(
      String(value).includes(TOKEN),
      false,
      `model.${key} 含明文配对码 —— 数据层只该知道「有没有配对」`
    )
  }
})

// ── 四原因码文案(spec §2.4 表格的「扩展侧文案」列,逐字)────────────────────

test('connection: 尚无握手结果 —— 存没存过配对码各说各的,不含糊', () => {
  assert.match(buildPopupModel(makeFacts()).connection, /尚未保存配对码/)
  assert.match(
    buildPopupModel(makeFacts({ pairing: { token: TOKEN, port: 52330 } })).connection,
    /配对码已保存,本次尚无握手结果/
  )
})

test('connection: ok → 「已连接 DownLord(应用 vX)」;拿不到应用版本则不编', () => {
  assert.equal(
    buildPopupModel(makeFacts({ lastHandshake: { at: 1, reason: 'ok', appVersion: '0.3.0' } }))
      .connection,
    '已连接 DownLord(应用 v0.3.0)'
  )
  assert.equal(
    buildPopupModel(makeFacts({ lastHandshake: { at: 1, reason: 'ok' } })).connection,
    '已连接 DownLord'
  )
})

test('connection: unreachable → 三条排查项,指向「开应用 / 启用通道 / 核对端口」', () => {
  const text = buildPopupModel(
    makeFacts({ lastHandshake: { at: 1, reason: 'unreachable' } })
  ).connection

  assert.equal(
    text,
    '连不上 DownLord。请确认:① DownLord 正在运行 ② 设置页「浏览器扩展」里的本地通道已启用 ③ 端口填的是 DownLord 里显示的那个'
  )
})

test('connection: unauthorized → 指向「重新配对」这一条修法', () => {
  assert.equal(
    buildPopupModel(makeFacts({ lastHandshake: { at: 1, reason: 'unauthorized' } })).connection,
    '配对码不被接受。请到 DownLord 设置页「浏览器扩展」重新复制配对码后重新配对'
  )
})

test('connection: protocol_mismatch 且拿到对端版本 → 直说哪边旧', () => {
  // 场景 = 扩展已升到 v2(Task 5 bump)、DownLord 还是 v1 的旧版:两侧版本**必须不同**,
  // 相同时下一类用例断言不谎称「版本不一致」
  const model = buildPopupModel(
    makeFacts({
      protocolVersion: 2,
      lastHandshake: { at: 1, reason: 'protocol_mismatch', appProtocolVersion: 1 }
    })
  )

  assert.equal(model.connection, '协议版本不一致:DownLord 侧 v1、扩展侧 v2,请升级较旧的一边')
})

test('connection: protocol_mismatch 但拿不到对端版本 → 改口说「端口上可能是别的程序」(必要的诚实)', () => {
  const model = buildPopupModel(
    makeFacts({
      pairing: { token: TOKEN, port: 52341 },
      lastHandshake: { at: 1, reason: 'protocol_mismatch' }
    })
  )

  assert.equal(
    model.connection,
    '端口 52341 上的服务没有按 DownLord 协议应答 —— 可能是别的程序占用了这个端口,或两侧版本不一致'
  )
})

test('connection: 四条文案的修法互不重叠,且不出现「未知错误 / 请重试」这类空话', () => {
  const texts = (['ok', 'unreachable', 'unauthorized', 'protocol_mismatch'] as const).map(
    (reason) => buildPopupModel(makeFacts({ lastHandshake: { at: 1, reason } })).connection
  )

  assert.equal(new Set(texts).size, 4, '四条文案两两不同')
  for (const text of texts) {
    assert.equal(/未知错误|请重试|出错了/.test(text), false, `空话文案:${text}`)
  }
})

// ── 接管状态一行(v0.4 Task 4 · spec §5.4)────────────────────────────

/** 固定「拿到快照那一刻」,不读真实时钟 */
const AT = Date.parse('2026-08-04T09:15:00.000Z')
const MIN = 60_000

function withTakeover(
  config: {
    enabled: boolean
    pausedUntil: number | null
    paused: boolean
  },
  at: number = AT
): PopupFacts {
  return makeFacts({ takeover: { config, at } })
}

/** 与被测代码同法算出期望里的「至 HH:MM」—— 直接写死小时数会随运行机器的时区变红 */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('takeover: 没问到 → 占位符 + 按钮全禁用(不显示一个可能过期的旧值)', () => {
  const model = buildPopupModel(makeFacts({ takeover: undefined }))

  assert.equal(model.takeoverStatus, MISSING_PLACEHOLDER)
  assert.equal(model.takeoverPaused, false)
  // 遥控器此刻够不着 DownLord —— 给个能按的按钮就是骗人
  assert.equal(model.takeoverActionable, false)
})

test('takeover: 接管中 → 「接管中」+ 三档可按', () => {
  const model = buildPopupModel(withTakeover({ enabled: true, pausedUntil: null, paused: false }))

  // ★ 与 DownLord 设置页 `takeoverStateText` **逐字同源**(spec §5.4 行文里的「已开启」在 §5.5
  //   落成了「接管中」;两侧说同一个事实,就该用同一个词)。
  assert.equal(model.takeoverStatus, '接管中')
  assert.equal(model.takeoverPaused, false)
  assert.equal(model.takeoverActionable, true)
})

test('takeover: 已关闭 → 「已关闭」+ 按钮禁用(要开回来得去 DownLord 设置页)', () => {
  const model = buildPopupModel(withTakeover({ enabled: false, pausedUntil: null, paused: false }))

  assert.equal(model.takeoverStatus, '已关闭')
  // 暂停一个已经关掉的接管没有任何可观察效果
  assert.equal(model.takeoverActionable, false)
})

test('takeover: 暂停中 → 剩余分钟 + 到期时刻,按钮换成「恢复接管」', () => {
  const pausedUntil = AT + 15 * MIN
  const model = buildPopupModel(withTakeover({ enabled: true, pausedUntil, paused: true }))

  assert.equal(model.takeoverStatus, `已暂停 · 剩余 15 分钟(至 ${clock(pausedUntil)})`)
  assert.equal(model.takeoverPaused, true)
  assert.equal(model.takeoverActionable, true)
})

test('takeover: ★ 剩余分钟必须拿**同一批**的时刻去减 —— 早 30 秒的时刻会被 ceil 藏成 16 分钟', () => {
  const pausedUntil = AT + 15 * MIN

  const sameBatch = buildPopupModel(withTakeover({ enabled: true, pausedUntil, paused: true }, AT))
  const staleClock = buildPopupModel(
    withTakeover({ enabled: true, pausedUntil, paused: true }, AT - 30_000)
  )

  // Step 6a 的设置页正是这么显示成 16 / 61 / 241 分钟的:偏差被 `Math.ceil` 整个吞掉,
  // 看不出是「算错了」还是「本来就该这么多」。`TakeoverSnapshot` 把 config 与 at 绑成一个值,
  // 就是为了让「拿旧时刻去减」在装配点写不出来。
  assert.equal(sameBatch.takeoverStatus.includes('剩余 15 分钟'), true)
  assert.equal(
    staleClock.takeoverStatus.includes('剩余 16 分钟'),
    true,
    '这一条钉的是「同源」的必要性'
  )
})

test('takeover: 剩余时长向上取整 —— 剩 30 秒说「1 分钟」,不说「0 分钟」', () => {
  const model = buildPopupModel(
    withTakeover({ enabled: true, pausedUntil: AT + 30_000, paused: true })
  )

  // 说「0 分钟」会让用户以为已经恢复了,而此刻接管确实还没恢复
  assert.equal(model.takeoverStatus.includes('剩余 1 分钟'), true)
})

test('takeover: 到期瞬间 / 时钟微抖 → 下限 1 分钟,绝不显示 0 或负数', () => {
  for (const pausedUntil of [AT, AT - 1, AT - 5_000]) {
    const model = buildPopupModel(withTakeover({ enabled: true, pausedUntil, paused: true }))

    assert.equal(model.takeoverStatus.includes('剩余 1 分钟'), true, `pausedUntil=${pausedUntil}`)
    assert.equal(/剩余 (0|-\d+) 分钟/.test(model.takeoverStatus), false)
  }
})

test('takeover: 说暂停却没给到期时刻 → 只说「已暂停」,**不编一个时长出来**', () => {
  const model = buildPopupModel(withTakeover({ enabled: true, pausedUntil: null, paused: true }))

  assert.equal(model.takeoverStatus, '已暂停')
  assert.equal(model.takeoverPaused, true)
})

test('takeover: 已关闭时按钮组不显示「恢复接管」(不出现「已关闭 + 恢复接管」这种自相矛盾)', () => {
  const model = buildPopupModel(
    withTakeover({ enabled: false, pausedUntil: AT + 15 * MIN, paused: true })
  )

  assert.equal(model.takeoverStatus, '已关闭')
  assert.equal(model.takeoverPaused, false)
  assert.equal(model.takeoverActionable, false)
})

test('takeover: 这一行的取值与「配对码」那一行**用词纪律不同** —— 一个共用、一个不共用', () => {
  const paused = buildPopupModel(
    withTakeover({ enabled: true, pausedUntil: AT + 60 * MIN, paused: true })
  )
  const running = buildPopupModel(withTakeover({ enabled: true, pausedUntil: null, paused: false }))
  const off = buildPopupModel(withTakeover({ enabled: false, pausedUntil: null, paused: false }))

  // 接管状态来自 DownLord 的应答、判据与 DownLord 侧同源 → **共用**它的词
  for (const text of [paused.takeoverStatus, running.takeoverStatus, off.takeoverStatus]) {
    assert.equal(/^(接管中|已暂停|已关闭)/.test(text), true, `应共用 DownLord 的词:${text}`)
  }
  // 配对那一行只知道「storage 里存没存过」,判据与 DownLord 侧**不同** → 不许共用「已配对」
  assert.equal(running.pairingStatus, '未保存')
  assert.equal(/配对/.test(running.pairingStatus), false)
})

// ── U-17 / U-18:buildId 一致性(docs/TODO.md #53;反向探针 RP-8 盯这两条)──────

const POPUP_BUILD = '0.4.0+20260809-143022'
const SW_BUILD_OLD = '0.4.0+20260809-101500'

test('U-17: popup 与 sw 的 buildId 相同 → 正常显示、无告警', () => {
  const model = buildPopupModel(makeFacts({ buildId: POPUP_BUILD, swBuildId: POPUP_BUILD }))

  assert.equal(model.buildId, POPUP_BUILD)
  assert.equal(model.buildIdMismatch, false)
  assert.equal(model.buildIdWarning, '')
})

test('U-17: buildId 不同 → 出告警,且告警里**两个值都在**(只报一个等于没说清哪边旧)', () => {
  const model = buildPopupModel(makeFacts({ buildId: POPUP_BUILD, swBuildId: SW_BUILD_OLD }))

  assert.equal(model.buildIdMismatch, true)
  assert.match(model.buildIdWarning, /popup 与后台脚本版本不一致/)
  assert.ok(model.buildIdWarning.includes(POPUP_BUILD), '告警里要有 popup 那份')
  assert.ok(model.buildIdWarning.includes(SW_BUILD_OLD), '告警里要有后台那份')
  assert.match(model.buildIdWarning, /重新加载扩展/, '要给出可执行的修法')
})

test('U-18: sw 没回 buildId(旧 sw / 没应答)→ 按**不一致**处理并告警,不是当作一致', () => {
  const model = buildPopupModel(makeFacts({ buildId: POPUP_BUILD, swBuildId: undefined }))

  // 沉默不是一致:失效模式②(浏览器缓存了旧 SW 脚本)最可能的表现恰恰就是沉默。
  // 把它读成一致,给出的就是和 manifest.version_name 一模一样的错误安心感 —— #53 堵的正是这个。
  assert.equal(model.buildIdMismatch, true)
  assert.ok(model.buildIdWarning.includes(POPUP_BUILD), '至少要说清 popup 自己是哪一版')
  assert.ok(model.buildIdWarning.includes(MISSING_PLACEHOLDER), '后台那份如实显示为占位符')
})

// ── 嗅探那一行的条数(Phase 2 起,列表本身由 `sniffView.test.ts` 覆盖)──────────

test('sniff: 开关关着 → 那一行仍报真实条数(「已关闭 · 0 条」,清干净没有要看得见)', () => {
  const model = buildPopupModel(makeFacts({ sniffEnabled: false, sniff: bucketOf([]) }))

  assert.equal(model.sniffEnabled, false)
  assert.equal(model.sniffCount, '已关闭 · 0 条')
  assert.equal(model.sniff.empty?.text, '嗅探已关闭')
})

test('sniff: ★ 读到了一个空桶 ≠ 这次没读到桶(装配点把「本页还没有桶」兜成空桶)', () => {
  const emptyRead = buildPopupModel(makeFacts({ sniffEnabled: true, sniff: bucketOf([]) }))
  const notRead = buildPopupModel(makeFacts({ sniffEnabled: true, sniff: undefined }))

  assert.equal(emptyRead.sniff.empty?.text, '本页未检测到媒体资源')
  assert.equal(notRead.sniff.empty?.text, '无法读取本页资源')
  // 一句正常的空状态被谎报成故障,和反过来一样坏
  assert.equal(emptyRead.sniff.unavailable, false)
  assert.equal(notRead.sniff.unavailable, true)
})

test('sniff: ★ 关着却还有残留 → 如实显示条数,不被一句安心的「已关闭」盖住', () => {
  const leftover = bucketOf(
    [item('a', 'stream', 'm3u8'), item('b', 'file', 'mp4', 1), item('c', 'file', 'mp4', 1)],
    { seq: 3 }
  )
  const model = buildPopupModel(makeFacts({ sniffEnabled: false, sniff: leftover }))

  // 清桶失败是**故障**,而故障必须看得见 —— 关着时只说「已关闭」等于把它藏起来
  assert.equal(model.sniffCount, '已关闭 · 3 条')
})

test('sniff: 开着但本页还没采到 → 0 条', () => {
  const model = buildPopupModel(makeFacts({ sniffEnabled: true, sniff: undefined }))

  assert.equal(model.sniffCount, '0 条')
})

test('sniff: 有条目 → N 条;有分片 → 另报计数(分片只计数,不列条目)', () => {
  const bucket = bucketOf([item('a', 'stream', 'm3u8'), item('b', 'file', 'mp4', 1)], {
    seq: 2,
    segmentCount: 12
  })
  const model = buildPopupModel(makeFacts({ sniffEnabled: true, sniff: bucket }))

  assert.equal(model.sniffCount, '2 条 · 另检测到 12 个分片请求')
})

test('sniff: 列表视图由 buildSniffSections 产出 —— popupModel 只是把它接上,不重复判断', () => {
  const bucket = bucketOf([item('https://x.example/a.m3u8', 'stream', 'm3u8')], {
    seq: 1,
    segmentCount: 12
  })
  const model = buildPopupModel(makeFacts({ sniffEnabled: true, sniff: bucket }))

  assert.equal(model.sniff.sections.length, 1)
  assert.equal(model.sniff.sections[0].title, '视频流')
  assert.equal(model.sniff.sections[0].rows[0].note, '已聚合 12 片')
  assert.equal(model.sniff.empty, null)
})

test('sniff: 转交结果透传进行内按钮(判断在 sniffView 里,这里只验接线通)', () => {
  const url = 'https://x.example/a.m3u8'
  const bucket = bucketOf([item(url, 'stream', 'm3u8')], { seq: 1 })
  const model = buildPopupModel(
    makeFacts({ sniffEnabled: true, sniff: bucket, sniffSent: { [url]: 'sent' } })
  )

  assert.equal(model.sniff.sections[0].rows[0].actionLabel, '已发送')
  assert.equal(model.sniff.sections[0].rows[0].actionDisabled, true)
})

// ── 连接结论异常时提升为常驻行(Phase 2 · DESIGN §7 第 2 条)──────────────

test('connectionAlert: 握手 ok → 空串(那一行折回诊断区,不占常驻位置)', () => {
  const model = buildPopupModel(
    makeFacts({
      pairing: { token: TOKEN, port: 52330 },
      lastHandshake: { reason: 'ok', at: 1, appVersion: '0.4.0' }
    })
  )

  assert.equal(model.connectionAlert, '')
  assert.match(model.connection, /已连接 DownLord/)
})

test('connectionAlert: 连不上 → 提升为常驻行,且**与诊断区那一行同字**(不另写一套)', () => {
  const model = buildPopupModel(
    makeFacts({
      pairing: { token: TOKEN, port: 52330 },
      lastHandshake: { reason: 'unreachable', at: 1 }
    })
  )

  assert.equal(model.connectionAlert, model.connection)
  assert.match(model.connectionAlert, /连不上 DownLord/)
})

test('connectionAlert: ★ 未配对也算异常 —— 此刻点资源行的「下载」必然什么都不会发生', () => {
  const model = buildPopupModel(makeFacts({ pairing: undefined, lastHandshake: undefined }))

  assert.equal(model.connectionAlert, model.connection)
  assert.match(model.connectionAlert, /尚未保存配对码/)
})

// ── v0.4 Task 6:「用 DownLord 下载此页视频」那一行实话 ──────────────────────

test('videoIntent: 还没点过 → 按钮可点、那一行是空串(不留空盒子)', () => {
  const model = buildPopupModel(makeFacts())

  assert.equal(model.videoIntentEnabled, true)
  assert.equal(model.videoIntentMessage, '')
})

test('videoIntent: 发送中 → 按钮禁用(防连点),文案如实说正在发', () => {
  const model = buildPopupModel(makeFacts({ videoIntent: { phase: 'sending' } }))

  assert.equal(model.videoIntentEnabled, false)
  assert.equal(model.videoIntentMessage, '正在交给 DownLord…')
})

test('★ 受理但没拿到 cookie → 只说「已交给 DownLord」,**那半句「已附…登录态」不出现**', () => {
  const model = buildPopupModel(
    makeFacts({ videoIntent: { phase: 'taken', cookieDomains: [], cookieTooLarge: false } })
  )

  assert.equal(model.videoIntentMessage, '已交给 DownLord,请在 DownLord 窗口确认')
  assert.equal(
    model.videoIntentMessage.includes('登录态'),
    false,
    '没选第四档 / 没点名 / 没送出去时,这半句必须一个字都不出现'
  )
  // 按钮恢复可点:用户可能想再点一次(比如刚才在 DownLord 里点了取消)
  assert.equal(model.videoIntentEnabled, true)
})

test('★ 确实收到 cookie.offer 的成功应答 → 才追加「(已附 <域名> 的登录态)」', () => {
  const model = buildPopupModel(
    makeFacts({
      videoIntent: { phase: 'taken', cookieDomains: ['www.example.com'], cookieTooLarge: false }
    })
  )

  assert.equal(
    model.videoIntentMessage,
    '已交给 DownLord,请在 DownLord 窗口确认(已附 www.example.com 的登录态)'
  )
})

test('两个域都收下 → 都列出来(用户看得见到底附了哪几个站的登录态)', () => {
  const model = buildPopupModel(
    makeFacts({
      videoIntent: {
        phase: 'taken',
        cookieDomains: ['page.example', 'cdn.example'],
        cookieTooLarge: false
      }
    })
  )

  assert.equal(
    model.videoIntentMessage,
    '已交给 DownLord,请在 DownLord 窗口确认(已附 page.example、cdn.example 的登录态)'
  )
})

test('★ 超上限 → 如实说「登录态过大,未能提供」,且不许同时说「已附」', () => {
  const model = buildPopupModel(
    makeFacts({ videoIntent: { phase: 'taken', cookieDomains: [], cookieTooLarge: true } })
  )

  assert.equal(
    model.videoIntentMessage,
    '已交给 DownLord,请在 DownLord 窗口确认 · 登录态过大,未能提供'
  )
  assert.equal(model.videoIntentMessage.includes('已附'), false)
})

test('没受理 → 一句实话,绝不假装成功', () => {
  const model = buildPopupModel(makeFacts({ videoIntent: { phase: 'failed' } }))

  assert.equal(model.videoIntentMessage, '没能交给 DownLord,请确认它正在运行')
  assert.equal(model.videoIntentEnabled, true)
})

test('★ 读不到当前标签页地址(受限页,探针 B4)→ 如实说,不崩、也不装作拿到了', () => {
  const model = buildPopupModel(makeFacts({ videoIntent: { phase: 'no_url' } }))

  assert.equal(
    model.videoIntentMessage,
    '读不到当前标签页地址 —— 浏览器内置页面(设置、新标签页、扩展商店)不对扩展提供地址,请在普通网页上使用'
  )
  // 按钮**仍然可点**:恒可点是设计(不判断页面类型),读不到地址由这一行如实交代
  assert.equal(model.videoIntentEnabled, true)
})
