/**
 * 仓库级安全配置的静态断言(v1.0 Task 3 · P4 · 不变量卡 `I-14`)。
 *
 * 两份渲染层 html 的 CSP **必须逐字一致** —— 它们本就是同一份策略的两个副本,
 * 而「只改了一份」在运行时不会报任何错:接管小窗(takeover.html)平时不开,
 * 少一条指令要等到有人真去攻击那个窗口才会被发现。故用一条 `assert.equal` 钉死。
 *
 * ⚠️ **本文件断言的是「配置写对了」,不是「打包产物真的生效了」** —— 两件事:
 *   · CSP:meta 形态在 `file://` 下确实生效,配置对 = 生效(`frame-ancestors` 是例外,
 *     它按 W3C CSP3 在 meta 形态下 MUST be ignored,故本项目不往 meta 里补它,见 T1-008)。
 *   · fuses:配置对 **≠** 产物真关了。真判据只能在打包产物上跑
 *     (`ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/DownLord.exe -p "process.versions.node"`),
 *     不变量卡 `I-15` 已把它显式标成「无自动化用例可钉 · 判据命令即护栏」。
 *     下面那条 fuses 用例守的只是**配置不被顺手删掉**,🚫 不要拿它当「fuses 已生效」的证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

/** 读文件并归一换行(仓库 `.gitattributes` 钉死 LF,但检出环境不保证)。 */
function readText(relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8').replace(/\r\n/g, '\n')
}

/** 从 html 里抽出 CSP meta 的 content 原文(meta 是多行属性,故 `\s+` 要能跨行)。 */
function readCspContent(relPath: string): string {
  const html = readText(relPath)
  const matched = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
  assert.ok(matched, `${relPath} 里没找到 CSP meta —— 是被删了还是改了写法?`)
  return matched[1]
}

test('CSP 两份 html 逐字一致且含 base-uri', () => {
  const indexCsp = readCspContent('src/renderer/index.html')
  const takeoverCsp = readCspContent('src/renderer/takeover.html')

  // 主断言:逐字相等。只改一份必红这一条(I-14 的反向探针即「只给 index.html 加一条指令」)。
  assert.equal(takeoverCsp, indexCsp, '两份 CSP 必须逐字一致 —— 疑似只改了其中一份')

  // T1-009:base-uri 属 Document Directives,**不 fallback 到 default-src**,必须显式声明。
  assert.ok(indexCsp.includes("base-uri 'none'"), `CSP 缺 base-uri 'none':${indexCsp}`)

  // T1-009 连带:connect-src / object-src 本可靠 default-src fallback(T1-010 判为假阳),
  // 显式声明是为了消除「靠 fallback 兜住」的隐式依赖 —— 改 default-src 时不会悄悄放宽它们。
  assert.ok(indexCsp.includes("connect-src 'self'"), `CSP 缺显式 connect-src:${indexCsp}`)
  assert.ok(indexCsp.includes("object-src 'none'"), `CSP 缺显式 object-src:${indexCsp}`)
})

test('electron-builder.yml 关掉 runAsNode 与 enableNodeCliInspectArguments', () => {
  const yml = readText('electron-builder.yml')

  // 取 electronFuses 段(顶层 key 到下一个顶层 key 之前的缩进块)。
  const section = /^electronFuses:\n((?:[ \t]+.*\n|\n)*)/m.exec(yml)
  assert.ok(section, 'electron-builder.yml 里没有 electronFuses 段 —— T1-007 的配置被删了?')

  assert.match(section[1], /^\s+runAsNode:\s*false\s*$/m, 'runAsNode 未显式关闭')
  assert.match(
    section[1],
    /^\s+enableNodeCliInspectArguments:\s*false\s*$/m,
    'enableNodeCliInspectArguments 未显式关闭'
  )
})
