import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toNetscapeCookieFile } from './netscapeCookies'
import type { OfferedCookie } from '../../shared/extensionProtocol'

/**
 * N1 —— spec §5.2 的 **12 条边界各一例** + 一条多域合并的**全串 equal**。
 *
 * ⚠️ 逐条覆盖而非抽样,理由见 spec §5.3:格式错的失败形态是「yt-dlp 静默跳过那些行」,
 * 而日志按红线查不到域名与值 —— 单测是这类失败的唯一防线。
 */

const MAGIC = '# Netscape HTTP Cookie File'

/** 构造 OfferedCookie,只覆盖关心字段 */
function ck(partial: Partial<OfferedCookie>): OfferedCookie {
  return {
    name: 'sid',
    value: 'abc',
    domain: 'www.example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    ...partial
  }
}

/** 单条 cookie → 那一行(去掉首行魔术注释与行尾换行) */
function oneLine(cookie: Partial<OfferedCookie>): string {
  const { text } = toNetscapeCookieFile([{ host: 'www.example.com', cookies: [ck(cookie)] }])
  const lines = text.split('\n')
  assert.equal(lines[0], MAGIC, '首行必须是魔术注释')
  return lines[1]
}

// ==================== ① 前导点 / includeSubdomains ====================

test('N1 ① 前导点 → 第 2 列 TRUE,domain 原样输出(前导点即 hostOnly 的编码)', () => {
  assert.equal(
    oneLine({ domain: '.example.com' }),
    '.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc'
  )
})

test('N1 ① 无前导点 → 第 2 列 FALSE,domain 原样输出', () => {
  assert.equal(
    oneLine({ domain: 'www.example.com' }),
    'www.example.com\tFALSE\t/\tFALSE\t0\tsid\tabc'
  )
})

// ==================== ② secure 全大写 ====================

test('N1 ② secure 第 4 列全大写 TRUE / FALSE(Python 判 secure == "TRUE",小写会被当作非 secure)', () => {
  assert.equal(oneLine({ secure: true }), 'www.example.com\tFALSE\t/\tTRUE\t0\tsid\tabc')
  assert.equal(oneLine({ secure: false }), 'www.example.com\tFALSE\t/\tFALSE\t0\tsid\tabc')
})

// ==================== ③ httpOnly → 整行前缀(Phase 0 探针 B1 实测成立)====================

test('N1 ③ httpOnly → 整行前缀 #HttpOnly_,其余七列不变', () => {
  assert.equal(
    oneLine({ httpOnly: true }),
    '#HttpOnly_www.example.com\tFALSE\t/\tFALSE\t0\tsid\tabc'
  )
})

test('N1 ③ 非 httpOnly → 无前缀', () => {
  assert.equal(oneLine({ httpOnly: false }).startsWith('#'), false)
})

// ==================== ④ session cookie(Phase 0 探针 B2 实测成立)====================

test('N1 ④ expires 缺省(session cookie)→ 第 5 列写 0', () => {
  assert.equal(oneLine({ expires: undefined }).split('\t')[4], '0')
})

// ==================== ⑤ expires 必须是纯数字 ====================

test('N1 ⑤ expires 非有限 / 负数 / NaN → 写 0;否则 Math.floor(必须是纯数字串)', () => {
  assert.equal(oneLine({ expires: Number.NaN }).split('\t')[4], '0')
  assert.equal(oneLine({ expires: Number.POSITIVE_INFINITY }).split('\t')[4], '0')
  assert.equal(oneLine({ expires: -1 }).split('\t')[4], '0')
  assert.equal(oneLine({ expires: 1799999999.9 }).split('\t')[4], '1799999999')
  // 纯数字串:不许出现小数点 / 科学计数法 / 任何非数字字符,否则 yt-dlp LoadError 跳过该行
  assert.match(oneLine({ expires: 1799999999.9 }).split('\t')[4], /^\d+$/)
})

// ==================== ⑥ path 空 → / ====================

test('N1 ⑥ path 空串 → 第 3 列写 /(空字段匹配不到任何请求)', () => {
  assert.equal(oneLine({ path: '' }).split('\t')[2], '/')
})

test('N1 ⑥ path 非空 → 原样输出', () => {
  assert.equal(oneLine({ path: '/sub/dir' }).split('\t')[2], '/sub/dir')
})

// ==================== ⑦ name / value 含 TAB 或换行 → 整条丢弃 ====================

test('N1 ⑦ name / value 含 TAB 或 CR 或 LF → 整条丢弃并计入 skipped', () => {
  for (const bad of ['\t', '\r', '\n']) {
    const byName = toNetscapeCookieFile([
      { host: 'www.example.com', cookies: [ck({ name: `s${bad}id` })] }
    ])
    assert.deepEqual(
      { text: byName.text, written: byName.written, skipped: byName.skipped },
      { text: `${MAGIC}\n`, written: 0, skipped: 1 }
    )

    const byValue = toNetscapeCookieFile([
      { host: 'www.example.com', cookies: [ck({ value: `a${bad}bc` })] }
    ])
    assert.deepEqual(
      { text: byValue.text, written: byValue.written, skipped: byValue.skipped },
      { text: `${MAGIC}\n`, written: 0, skipped: 1 }
    )
  }
})

// ==================== ⑧ domain / path 含 TAB 或换行 → 整条丢弃 ====================

test('N1 ⑧ domain / path 含 TAB 或 CR 或 LF → 整条丢弃并计入 skipped', () => {
  for (const bad of ['\t', '\r', '\n']) {
    const byDomain = toNetscapeCookieFile([
      { host: 'www.example.com', cookies: [ck({ domain: `www${bad}.example.com` })] }
    ])
    assert.deepEqual(
      { text: byDomain.text, written: byDomain.written, skipped: byDomain.skipped },
      { text: `${MAGIC}\n`, written: 0, skipped: 1 }
    )

    const byPath = toNetscapeCookieFile([
      { host: 'www.example.com', cookies: [ck({ path: `/a${bad}b` })] }
    ])
    assert.deepEqual(
      { text: byPath.text, written: byPath.written, skipped: byPath.skipped },
      { text: `${MAGIC}\n`, written: 0, skipped: 1 }
    )
  }
})

// ==================== ⑨ name 为空串 → 整条丢弃 ====================

test('N1 ⑨ name 为空串 → 整条丢弃(Python 会把 value 当 name,产出语义不同的 cookie)', () => {
  const r = toNetscapeCookieFile([{ host: 'www.example.com', cookies: [ck({ name: '' })] }])
  assert.deepEqual({ text: r.text, written: r.written, skipped: r.skipped }, {
    text: `${MAGIC}\n`,
    written: 0,
    skipped: 1
  })
})

// ==================== ⑩ value 为空串 → 保留 ====================

test('N1 ⑩ value 为空串 → 保留(空值 cookie 真实存在,丢掉是错的)', () => {
  const r = toNetscapeCookieFile([{ host: 'www.example.com', cookies: [ck({ value: '' })] }])
  assert.deepEqual({ text: r.text, written: r.written, skipped: r.skipped }, {
    text: `${MAGIC}\nwww.example.com\tFALSE\t/\tFALSE\t0\tsid\t\n`,
    written: 1,
    skipped: 0
  })
})

// ==================== ⑪ 空输入 → 只有首行 ====================

test('N1 ⑪ groups 为空 / cookies 为空 → 只输出首行魔术注释,written = 0', () => {
  const empty = toNetscapeCookieFile([])
  assert.deepEqual({ text: empty.text, written: empty.written, skipped: empty.skipped }, {
    text: `${MAGIC}\n`,
    written: 0,
    skipped: 0
  })

  const emptyCookies = toNetscapeCookieFile([{ host: 'www.example.com', cookies: [] }])
  assert.deepEqual(
    { text: emptyCookies.text, written: emptyCookies.written, skipped: emptyCookies.skipped },
    { text: `${MAGIC}\n`, written: 0, skipped: 0 }
  )
})

// ==================== ⑫ 多域合并 —— 全串 equal ====================

test('N1 ⑫ 多域合并:按 groups 顺序、组内保序,输出确定(全串 equal)', () => {
  const r = toNetscapeCookieFile([
    {
      host: 'www.bilibili.com',
      cookies: [
        ck({
          name: 'SESSDATA',
          value: 'sess-1',
          domain: '.bilibili.com',
          path: '/',
          expires: 1800000000,
          secure: true,
          httpOnly: true
        }),
        ck({
          name: 'bili_jct',
          value: 'jct-1',
          domain: 'www.bilibili.com',
          path: '/',
          secure: false,
          httpOnly: false
        })
      ]
    },
    {
      host: 'passport.bilibili.com',
      cookies: [
        ck({
          name: 'DedeUserID',
          value: '',
          domain: 'passport.bilibili.com',
          path: '/api',
          expires: 1700000000.7,
          secure: true,
          httpOnly: false
        })
      ]
    }
  ])

  assert.equal(
    r.text,
    [
      MAGIC,
      '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1800000000\tSESSDATA\tsess-1',
      'www.bilibili.com\tFALSE\t/\tFALSE\t0\tbili_jct\tjct-1',
      'passport.bilibili.com\tFALSE\t/api\tTRUE\t1700000000\tDedeUserID\t',
      ''
    ].join('\n')
  )
  assert.equal(r.written, 3)
  assert.equal(r.skipped, 0)
})

// ==================== 形状不变量:恰好 7 字段 / 6 个 TAB ====================

test('N1 每条数据行恰好 6 个 TAB(字段数 ≠ 7 会被 yt-dlp 跳过 —— 静默失败的确切机制)', () => {
  const { text } = toNetscapeCookieFile([
    {
      host: 'www.example.com',
      cookies: [ck({}), ck({ httpOnly: true }), ck({ domain: '.example.com', secure: true })]
    }
  ])
  const dataLines = text.split('\n').slice(1).filter((l) => l !== '')
  assert.equal(dataLines.length, 3)
  for (const line of dataLines) {
    assert.equal(line.split('\t').length, 7, `字段数必须是 7:${JSON.stringify(line)}`)
  }
})
