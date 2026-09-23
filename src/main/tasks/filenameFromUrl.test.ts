/**
 * `filenameFromUrl` 提取的**行为等价**单测(U-12;v0.4 Task 4 · spec §1.4 / §7.1)。
 *
 * 判据不是「新函数看起来对」,而是**与提取前逐字节相同**:下面 `legacyResolveFilename` 是
 * `resolveFilename`(`taskManager.ts`)提取前那一段的**原样副本**,两者对同一输入必须给出同一输出。
 * (兜底分支含 `Date.now()`,两次调用天然不同 → 该分支断言「两者都走了兜底且形态一致」。)
 *
 * 用例含 2026-08-01 实测的三个真实样本形态(`.exe` 带 query / `.tar.gz` / `.zip` 带 query)
 * + 非法 URL 兜底 + 空末段 + 百分号编码 + 路径穿越清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filenameFromUrl } from './taskManager'
import { sanitizeBasename } from '../video/filename'

/** ★ 提取前的原样副本(taskManager.ts `resolveFilename` 的 URL 末段推断支) */
function legacyResolveFilename(source: string): string {
  try {
    const segments = new URL(source).pathname.split('/').filter(Boolean)
    const base = decodeURIComponent(segments[segments.length - 1] ?? '')
    const cleaned = sanitizeBasename(base)
    if (cleaned) {
      return cleaned
    }
  } catch {
    // 非标准 URL,落回兜底名
  }
  return `download-${Date.now()}`
}

/** 命中 URL 末段(非兜底)的输入 —— 这些必须逐字节相同 */
const HIT_CASES: { name: string; url: string; expect: string }[] = [
  {
    name: '实测样本① .exe 带 query(跨域 CDN)',
    url: 'https://uu.gdl.netease.com/dl/UU-6.15.1.exe?sign=abc123&t=1754000000',
    expect: 'UU-6.15.1.exe'
  },
  {
    name: '实测样本② .tar.gz(双扩展名不被截断)',
    url: 'https://nodejs.org/dist/v22.11.0/node-v22.11.0.tar.gz',
    expect: 'node-v22.11.0.tar.gz'
  },
  {
    name: '实测样本③ .zip 带 query',
    url: 'https://dl.example.com/pkg/tool-1.2.3.zip?token=xyz',
    expect: 'tool-1.2.3.zip'
  },
  {
    name: '百分号编码的中文名被还原',
    url: 'https://a.com/d/%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6.pdf',
    expect: '测试文件.pdf'
  },
  {
    name: '尾部斜杠不影响(filter(Boolean) 去空段)',
    url: 'https://a.com/dir/file.bin/',
    expect: 'file.bin'
  },
  {
    name: 'hash 不进 pathname',
    url: 'https://a.com/x/setup.msi#frag',
    expect: 'setup.msi'
  },
  {
    name: '末段含非法字符 → sanitizeBasename 清洗(路径穿越无需新增缓解)',
    url: 'https://a.com/x/%2E%2E%5C%2E%2E%5Cevil.exe',
    expect: sanitizeBasename('..\\..\\evil.exe')
  }
]

for (const c of HIT_CASES) {
  test(`U-12 ${c.name} —— 与提取前逐字节相同`, () => {
    const now = filenameFromUrl(c.url)
    assert.equal(now, legacyResolveFilename(c.url))
    assert.equal(now, c.expect)
  })
}

test('U-12 非法 URL → 兜底名(两者同形:download-<时间戳>)', () => {
  for (const url of ['not a url', '', 'ht!tp://%%%']) {
    const now = filenameFromUrl(url)
    assert.match(now, /^download-\d+$/)
    assert.match(legacyResolveFilename(url), /^download-\d+$/)
  }
})

/**
 * 空末段走的**不是** `download-<时间戳>`,而是 `sanitizeBasename('')` 自己的 `'download'` 兜底 ——
 * 提取前后同样如此(2026-08-02 本测试跑出来的事实,不是设计意图的猜测)。
 * 这里用「形态归一后比较」断言等价:兜底名含时间戳,两次调用天然不同,只能比形态。
 */
function shapeOf(value: string): string {
  return /^download-\d+$/.test(value) ? 'download-<ts>' : value
}

test('U-12 空末段 / 清洗后为空 → 与提取前同一支(sanitizeBasename 的 download 兜底)', () => {
  for (const url of ['https://a.com', 'https://a.com/', 'https://a.com/%2E%2E%2F']) {
    assert.equal(shapeOf(filenameFromUrl(url)), shapeOf(legacyResolveFilename(url)))
  }
  assert.equal(filenameFromUrl('https://a.com/'), 'download')
})
