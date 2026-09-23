/**
 * npm 许可扫描（v1.0 Task 5 Phase 1 补充锁定输入完整性与引擎静态登记）。
 * 零 CLI 参数、零外部依赖；读取 cwd/package.json、package-lock.json 和 node_modules。
 * 产品面 = 根 dependencies + React / React DOM / Fluent UI 的依赖闭包，其余为构建面。
 * ALLOWED 不为变绿而扩张；ADJUDICATED 按包名 + 精确许可串匹配，open / stale 任一非空即 1。
 * 必须完整安装当前平台的锁定输入；空目录、缺包、错版本、锁外包都不能成为假绿。
 * 引擎表仅为来源登记，不验证 EXE 或包内文件，也不参与 npm 退出码。
 * 独立子进程不证明全面分发合规；材料完整性、源码义务、真实包检需分别核验。
 * 用法：npm run scan:licenses
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = process.cwd()
const NM = join(ROOT, 'node_modules')

/**
 * 允许清单。每一项都能追到规划期那张分布表(JS 依赖 141 个:MIT ×132 / ISC ×2 / BSD-2 ×2 /
 * Apache-2.0 ×2 / Python-2.0 ×1 / BlueOak-1.0.0 ×1 / 0BSD ×1,**零 copyleft**)。
 * 🚫 加项之前先问一句:是这个许可证真的该全局放行,还是我只是想让扫描变绿?后者请走 ADJUDICATED。
 */
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Unlicense',
  '0BSD',
  'CC0-1.0',
  'Python-2.0',
  'BlueOak-1.0.0'
])

/**
 * 逐包定性登记表(**不是允许清单**,见文件头)。性质与 `scan-secrets.mjs` 的同名表一致:
 * ① 每次运行完整打印;② 逐包而非逐许可证;③ 失效条目(包已不在树里)= 失败。
 */
const ADJUDICATED = [
  {
    name: '@csstools/color-helpers',
    license: 'MIT-0',
    face: '构建期面',
    verdict: '放行',
    why: 'MIT-0 = MIT 去掉署名要求,比 MIT 更宽松,无 copyleft。经 jsdom → cssstyle 引入,仅测试期使用,不进产物。'
  },
  {
    name: '@csstools/css-syntax-patches-for-csstree',
    license: 'MIT-0',
    face: '构建期面',
    verdict: '放行',
    why: '同上。'
  },
  {
    name: 'caniuse-lite',
    license: 'CC-BY-4.0',
    face: '构建期面',
    verdict: '放行',
    why: 'CC-BY-4.0 只要求署名、无 copyleft;它是 browserslist 的浏览器支持度**数据集**,经 vite / postcss 在构建期读取,数据不进产物。'
  },
  {
    name: 'truncate-utf8-bytes',
    license: 'WTFPL',
    face: '构建期面',
    verdict: '放行',
    why: 'WTFPL 是无条件放弃一切限制的许可,比 MIT 更宽松、无 copyleft。经 sanitize-filename 引入。'
  }
]

// ── 三引擎静态登记：2026-09-14 原材料/自报取证，详见 resources/bin/license-provenance.json ──
const ENGINES = [
  {
    file: 'aria2c.exe',
    version: '1.37.0',
    sourceLicense: 'GPL-2.0-or-later',
    license: 'GPL-2.0-or-later',
    copyleft: true,
    verified:
      'Windows 64-bit build1 原 ZIP 内 EXE 与本地相同；--version 自报 GPLv2+。该 ZIP 无独立上游校验文件，自算 ZIP hash 不等于上游校验',
    upstream: 'https://github.com/aria2/aria2/releases/tag/release-1.37.0',
    licenseTextAt:
      'resources/bin/aria2-LICENSE.txt（原 COPYING）；附加原文在 license-notices/aria2/',
    duty: '保留 GPL 全文、原声明及 OpenSSL/Original SSLeay 条件，提供对应源码途径；分发义务另行核验'
  },
  {
    file: 'yt-dlp.exe',
    version: '2026.07.04',
    sourceLicense: 'Unlicense',
    license: 'GPL-3.0-or-later',
    copyleft: true,
    verified:
      'stable@2026.07.04 / 997fa1408 / win_exe，官方 SHA2-256SUMS 对应本地 EXE；同版 README Licensing 将 PyInstaller 合并成品声明为 GPLv3+，不是按源码 LICENSE 推断',
    upstream: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04',
    licenseTextAt:
      'resources/bin/yt-dlp-LICENSE.txt（从同版完整 TPL 提取 GPLv3）；源码 LICENSE、完整 TPL 和组件补充在 license-notices/yt-dlp/',
    duty: '保留成品 GPL 全文、对应源码途径及组件原声明；TPL 不是实测 Windows 成分清单，Readline 的 Linux 范围不因提取 GPL 改变'
  },
  {
    file: 'ffmpeg.exe',
    version: '8.1.2-essentials_build-www.gyan.dev',
    sourceLicense: 'GPL-3.0-or-later (this configured build)',
    license: 'GPL-3.0-or-later',
    copyleft: true,
    verified:
      'gyan.dev essentials 原 ZIP 与 .zip.sha256 对应；包内 EXE 与本地相同；-version 含 --enable-gpl --enable-version3，-L 自报 GPLv3+',
    upstream: 'https://www.gyan.dev/ffmpeg/builds/',
    licenseTextAt:
      'resources/bin/ffmpeg-LICENSE.txt（原 LICENSE）；README.txt / doc / presets 原文在 license-notices/ffmpeg/',
    duty: '保留 GPL 全文及构建材料，源码提交 38b88335f99e76ed89ff3c93f877fdefce736c13；对应源码/外库义务另行核验'
  }
]

// ── 遍历 node_modules ─────────────────────────────────────────────────────
/** 一个包:名字 / 许可证 / 磁盘路径。嵌套 `node_modules` 一并收,同名不同版本各算一个。 */
function collect(dir, acc, errors) {
  let entries
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      errors.push('链接目录无法核定锁定输入: ' + relative(ROOT, dir))
      return acc
    }
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    errors.push('无法读取扫描目录: ' + relative(ROOT, dir) + '（' + error.message + '）')
    return acc
  }
  for (const e of entries) {
    if (e.name === '.bin') continue
    const full = join(dir, e.name)
    // 不跟随 npm link / scope junction；漏扫未知目标不能被解释成许可零命中。
    if (e.isSymbolicLink()) {
      errors.push('链接包/目录无法核定锁定输入: ' + relative(ROOT, full))
      continue
    }
    if (!e.isDirectory()) continue
    if (e.name.startsWith('@')) {
      collect(full, acc, errors) // scope 目录本身不是包
      continue
    }
    const manifest = join(full, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        acc.push({
          name: pkg.name || relative(NM, full).split(sep).join('/'),
          version: pkg.version,
          license: normalizeLicense(pkg),
          deps: Object.keys(pkg.dependencies || {}),
          requiredDeps: requiredDependencies(pkg),
          path: relative(ROOT, full).split(sep).join('/')
        })
      } catch {
        acc.push({
          name: relative(NM, full).split(sep).join('/'),
          license: '(package.json 解析失败)',
          deps: [],
          requiredDeps: [],
          path: relative(ROOT, full).split(sep).join('/')
        })
      }
    }
    const nested = join(full, 'node_modules')
    if (existsSync(nested)) collect(nested, acc, errors)
  }
  return acc
}

/** `license` 可能是字符串 / `{type}` / 已废弃的 `licenses[]`。三种形态都收,收不到就如实标出来。 */
function normalizeLicense(pkg) {
  let lic = pkg.license
  if (lic && typeof lic === 'object') lic = lic.type
  if (!lic && Array.isArray(pkg.licenses)) lic = pkg.licenses.map((x) => x.type || x).join(' OR ')
  return typeof lic === 'string' && lic.trim() ? lic.trim() : '(无 license 字段)'
}

/**
 * SPDX 表达式求值(只需处理 npm 生态实际出现的两种连接词)。
 * - `A OR B` —— 使用者可任选其一 ⇒ **任一在允许清单内即放行**;
 * - `A AND B` —— 两者义务同时生效 ⇒ **全部在允许清单内才放行**。
 */
function isAllowed(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim()
  if (/\bOR\b/i.test(clean)) return clean.split(/\bOR\b/i).some((p) => isAllowed(p))
  if (/\bAND\b/i.test(clean)) return clean.split(/\bAND\b/i).every((p) => isAllowed(p))
  return ALLOWED.has(clean.trim())
}

// ── 产物面 / 构建期面分档 ─────────────────────────────────────────────────
/**
 * 种子 = 根 `package.json` 的 `dependencies`(electron-builder 打进 asar 的那批)
 * **加上**三个声明在 devDependencies、却被 vite bundle 进 renderer 产物的包。
 * 然后取传递闭包。剩下的一律构建期面。
 */
const BUNDLED_DEV = ['react', 'react-dom', '@fluentui/react-components']
function productFace(packages) {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const byName = new Map()
  for (const p of packages) if (!byName.has(p.name)) byName.set(p.name, p)

  const seen = new Set()
  const queue = [...Object.keys(rootPkg.dependencies || {}), ...BUNDLED_DEV]
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name)) continue
    seen.add(name)
    const pkg = byName.get(name)
    if (pkg) queue.push(...pkg.deps)
  }
  return seen
}

// optionalDependencies 覆盖同名 dependencies；仅非可选 peer 属于必需输入。
function requiredDependencies(pkg, includeDev = false) {
  const names = new Set()
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...(includeDev ? pkg.devDependencies : {})
  })) {
    if (!Object.hasOwn(pkg.optionalDependencies || {}, name)) names.add(name)
  }
  for (const name of Object.keys(pkg.peerDependencies || {})) {
    if (!pkg.peerDependenciesMeta?.[name]?.optional) names.add(name)
  }
  return [...names]
}

// 与 npm/Node 的父级 node_modules 查找位置一致，不以任意同名兄弟包冒充可解析输入。
function resolveLockedDependency(fromPath, name, lockedPackages) {
  const parts = fromPath ? fromPath.split('/') : []
  while (true) {
    if (parts.at(-1) !== 'node_modules') {
      const candidate = [...parts, 'node_modules', name].join('/')
      if (Object.hasOwn(lockedPackages, candidate)) return candidate
    }
    if (parts.length === 0) return undefined
    parts.pop()
  }
}

// 锁定输入不完整时先失败，不能靠仍在场的几条 ADJUDICATED 产生假绿。
function validateInputs(packages) {
  const errors = []
  if (packages.length === 0) errors.push('node_modules 缺失或为空')
  let rootPkg, lock
  try {
    rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  } catch (error) {
    return [...errors, '无法读取 package.json / package-lock.json: ' + error.message]
  }
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
    return [...errors, '需要包含 packages 的完整 npm lockfile v2/v3']
  }
  const lockedRoot = lock.packages['']
  for (const field of ['name', 'version']) {
    if (rootPkg[field] !== lockedRoot[field]) errors.push('根 package.json 与锁不匹配: ' + field)
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const sorted = (value) =>
      JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)))
    if (sorted(rootPkg[field]) !== sorted(lockedRoot[field]))
      errors.push('根依赖声明与锁不匹配: ' + field)
  }
  const supports = (values, current) =>
    !values ||
    (!values.includes('!' + current) &&
      (!values.some((value) => !value.startsWith('!')) ||
        values.includes(current) ||
        values.includes('any')))
  const libc =
    process.platform === 'linux'
      ? process.report?.getReport().header.glibcVersionRuntime
        ? 'glibc'
        : 'musl'
      : undefined
  const installed = new Map(packages.map((pkg) => [pkg.path, pkg]))
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path) continue
    if (!resolve(ROOT, path).startsWith(NM + sep)) {
      errors.push('锁中存在非 node_modules 路径: ' + path)
      continue
    }
    const pkg = installed.get(path)
    // 只豁免明确与当前平台不兼容的可选包，不以 optional 为借口漏扫当前平台内容。
    const incompatible =
      !supports(locked.os, process.platform) ||
      !supports(locked.cpu, process.arch) ||
      (libc && !supports(locked.libc, libc))
    if (!pkg && locked.optional && incompatible) continue
    if (!pkg) errors.push('缺少锁定包: ' + path)
    else if (pkg.version !== locked.version)
      errors.push(
        '版本不匹配: ' + path + '（锁 ' + locked.version + ' / 实际 ' + pkg.version + '）'
      )
  }
  for (const pkg of packages) {
    if (!lock.packages[pkg.path]) errors.push('存在锁外包: ' + pkg.path)
  }
  for (const pkg of [
    { path: '', requiredDeps: requiredDependencies(rootPkg, true) },
    ...packages
  ]) {
    const names = new Set([
      ...pkg.requiredDeps,
      ...requiredDependencies(lock.packages[pkg.path] || {}, pkg.path === '')
    ])
    for (const name of names) {
      const path = resolveLockedDependency(pkg.path, name, lock.packages)
      if (!path || !installed.has(path))
        errors.push('必需依赖未解析到锁定实装包: ' + (pkg.path || '<root>') + ' -> ' + name)
    }
  }
  return errors
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
const collectionErrors = []
const packages = collect(NM, [], collectionErrors)
const inputErrors = [...collectionErrors, ...validateInputs(packages)]
if (inputErrors.length > 0) {
  console.error('❌ 许可扫描输入不完整或与锁不一致:')
  for (const error of inputErrors) console.error('   ' + error)
  process.exit(1)
}
const inProduct = productFace(packages)

const dist = new Map()
for (const p of packages) dist.set(p.license, (dist.get(p.license) || 0) + 1)

const ackIndex = new Map(ADJUDICATED.map((a) => [a.name, a]))
const ackSeen = new Set()
const open = []
for (const p of packages) {
  if (isAllowed(p.license)) continue
  const ack = ackIndex.get(p.name)
  if (ack && ack.license === p.license) {
    ackSeen.add(p.name)
    continue
  }
  open.push(p)
}
const stale = ADJUDICATED.filter((a) => !ackSeen.has(a.name))

// ── 报告 ──────────────────────────────────────────────────────────────────
console.log(
  `依赖许可证扫描(node_modules 共 ${packages.length} 个包 · 产物面 ${inProduct.size} 个 / 构建期面 ${packages.length - inProduct.size} 个)\n`
)

console.log('① npm 依赖的许可证分布:')
for (const [lic, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
  const mark = isAllowed(lic) ? '✅' : '⚠️ '
  console.log(`   ${mark} ${String(n).padStart(4)}  ${lic}`)
}
console.log()

if (open.length > 0) {
  console.log(`🚨 未定性 ${open.length} 个包(不在允许清单内,需逐包定性):`)
  for (const p of open) {
    console.log(
      `   ${p.name}  ——  ${p.license}  [${inProduct.has(p.name) ? '产物面 · 有义务' : '构建期面 · 无义务'}]`
    )
    console.log(`       ${p.path}`)
  }
  console.log()
}

if (ackSeen.size > 0) {
  console.log(`📌 已定性 ${ackSeen.size} 个包(不在允许清单内,但逐包定性放行;每次运行完整打印):`)
  for (const a of ADJUDICATED) {
    if (!ackSeen.has(a.name)) continue
    console.log(
      `   ${a.name}  ——  ${a.license}  [${inProduct.has(a.name) ? '产物面 · 有义务' : a.face}]  ${a.verdict}`
    )
    console.log(`       理由:${a.why}`)
  }
  console.log()
}

if (stale.length > 0) {
  console.log(`❌ 定性登记表失效 ${stale.length} 条(登记的包已不在依赖树里,或许可证已变):`)
  for (const a of stale) console.log(`   ${a.name}  ——  登记的是 ${a.license}`)
  console.log()
}

// ② 不把文件存在、静态登记或独立进程当成分发合规证明。
console.log('② 引擎静态来源登记（不验证 EXE 或包内许可，不参与 npm 退出码）：')
for (const e of ENGINES) {
  console.log(
    '   ' + e.file + '  ' + e.version + '  ——  ' + e.license + (e.copyleft ? '(copyleft)' : '')
  )
  console.log('       源码许可:' + e.sourceLicense)
  console.log('       来源登记:' + e.verified)
  console.log('       分发材料/边界:' + e.duty)
  console.log('       上游发行页:' + e.upstream)
  console.log('       许可证文本位置:' + e.licenseTextAt)
}
console.log(
  '\n   独立子进程不证明全面分发合规；npm、Electron/Chromium、引擎原材料与实际包检分别核验。\n'
)

if (open.length > 0 || stale.length > 0) {
  console.log(
    `❌ 扫描未过:未定性 ${open.length} 个包 / 登记表失效 ${stale.length} 条\n` +
      '   → 逐包定性写进 ADJUDICATED(含产物面 / 构建期面与理由);🚫 不要为了变绿往 ALLOWED 里加许可证。'
  )
  process.exit(1)
}

console.log('✅ npm 依赖零未定性许可证')
