/**
 * 扩展构建脚本(v0.4 Task 2 · spec §2.3)—— 一个脚本干四件事:bundle / 注版本 / 拷资源 / 打 zip。
 *
 * **七步顺序是刻意排列的**:三项前置校验全部跑在「触碰 extension/dist」之前,
 * 这是「非法版本时不产出任何产物」的唯一保证 —— 先删后校验的话,失败就留下一个半残的 dist。
 *
 *   0  读 package.json 的 version 并校验合法性        不合法 → exit(1),此时尚未碰 dist
 *   0b 断言 extension/manifest.json 不含 version 字段  含则退出(有人手抄了 → 漂移隐患,当场拦下)
 *   0c 读 build/icon.png 的 IHDR,断言正方形且 ≥128    不满足则退出(杜绝把 64px 谎报成 128)
 *      并逐份校验 build/icon-{16,32,48,128}.png 的实际尺寸(v0.4 Task 7 / #43:四个 key 各指各的)
 *   0d 生成 buildId = <version>+<YYYYMMDD-HHmmss>     v0.4 Task 5;供第 2 步 define 注入
 *   1  清空并重建 extension/dist/
 *   2  bundle:esbuild 两个入口 → sw.js / popup.js;**一处 define 同时喂两个入口**注入 buildId
 *   3  注入版本:{...manifest, version} 写出 dist/manifest.json
 *   4  拷静态资源:popup.html、build/icon-{16,32,48,128}.png → dist/icons/icon-<size>.png
 *   5  打 zip:dist/** → <repo>/dist/downlord-extension-<version>.zip
 *   6  从 manifest.key 派生并打印扩展 ID
 *
 * 用法:node scripts/build-extension.mjs [--watch]
 *
 * ⚠️ 第 3 步是 Firefox manifest 变体(`--target=firefox`)的落点(v0.4 Task 5 spec §3.4);Firefox 本版不做,故不预置该分支。
 *
 * ⚠️ **副作用一条,提前说清**:第 0d 步注入构建时刻,使**每次构建的产物都不同**(zip 哈希必变)。
 *    这是**要它变**,不是缺陷 —— 产物一模一样的话,#53 想区分的那两版本来就区分不出来。
 *    Phase 1 已核对既有产物级断言里没有「两次构建产物相同 / zip 哈希稳定」这类判据。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import AdmZip from 'adm-zip'
import * as esbuild from 'esbuild'

import { formatBuildId } from './buildId.mjs'
import { assertValidExtensionVersion } from './extensionVersion.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = join(rootDir, 'extension')
const distDir = join(extensionDir, 'dist')
const sourceManifestPath = join(extensionDir, 'manifest.json')
const sourceIconPath = join(rootDir, 'build', 'icon.png')
const popupHtmlPath = join(extensionDir, 'src', 'popup', 'popup.html')
const zipOutDir = join(rootDir, 'dist')

const ENTRY_POINTS = [
  { in: join(extensionDir, 'src', 'sw', 'index.ts'), out: 'sw' },
  { in: join(extensionDir, 'src', 'popup', 'main.ts'), out: 'popup' }
]

/** 图标最小边长 —— manifest 声明了 128 这个 key,源图小于它就是谎报 */
const MIN_ICON_SIZE = 128

/**
 * manifest 声明的四个尺寸 key。v0.4 Task 7(#43)起**每个尺寸一份独立降采样图**,
 * 不再四个 key 共用一张 512 —— 让浏览器自己缩,16px 下糊成一团。
 * 源与 build/icon.png 同目录:一处生成、一处消费,不制造第二个图标源。
 */
const ICON_SIZES = [16, 32, 48, 128]

/** 某尺寸降采样图的源路径。成品入库(不引 sharp / jimp),生成方式见 scripts/make-icons.ps1。 */
const sizedIconPath = (size) => join(rootDir, 'build', `icon-${size}.png`)

// —— 第 0 步:版本合法性 ——
// 校验逻辑住在 scripts/extensionVersion.mjs(零副作用模块),由 scripts/extensionVersion.test.ts 断言。
// 本文件顶层就 `await buildOnce()`,测试直接 import 会真跑一次构建,故纯函数不能留在这里。

// —— 第 0c 步:PNG IHDR ——

/** 读 PNG 的 IHDR 块取宽高。PNG = 8 字节签名 + 4 字节长度 + 4 字节 "IHDR" + 宽(4,BE)+ 高(4,BE)。 */
export function readPngSize(buffer) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('不是合法的 PNG 文件(签名不匹配)')
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('PNG 首块不是 IHDR,无法读取尺寸')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// —— 第 6 步:扩展 ID ——

/** ID = 公钥 DER 的 SHA-256 前 16 字节,每个 nibble 映射 a–p(Chromium 的算法)。 */
export function deriveExtensionId(keyBase64) {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest()
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join('')
}

// —— 各步骤 ——

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 三项前置校验,全部在触碰 dist 之前跑完。返回后续步骤要用的事实。 */
function runPreflight() {
  const version = assertValidExtensionVersion(readJson(join(rootDir, 'package.json')).version)

  const manifest = readJson(sourceManifestPath)
  if ('version' in manifest) {
    throw new Error(
      `extension/manifest.json 不应含 version 字段(当前含 "${manifest.version}")。\n` +
        '版本由本脚本从 package.json 注入;源文件里写死版本号 = 手抄 = 漂移隐患。'
    )
  }

  const icon = readFileSync(sourceIconPath)
  const { width, height } = readPngSize(icon)
  if (width !== height || width < MIN_ICON_SIZE) {
    throw new Error(
      `build/icon.png 为 ${width}×${height},要求正方形且边长 ≥ ${MIN_ICON_SIZE}。\n` +
        'manifest 声明了 128 这个尺寸 key,源图不够大就是谎报。'
    )
  }

  // 四份降采样图逐份校验。与上面守母图的断言是两回事:母图管「源够不够大」,
  // 这里管「每个 key 拿到的是不是它自称的那个尺寸」—— 少一条都能让谎报溜过去。
  const icons = ICON_SIZES.map((size) => {
    const path = sizedIconPath(size)
    if (!existsSync(path)) {
      throw new Error(
        `缺少 build/icon-${size}.png —— manifest 的 ${size} 尺寸 key 要一份独立降采样图。\n` +
          '成品位图一次性生成后入库,生成方式见 scripts/make-icons.ps1(不接进门禁)。'
      )
    }
    const buffer = readFileSync(path)
    const actual = readPngSize(buffer)
    if (actual.width !== size || actual.height !== size) {
      throw new Error(
        `build/icon-${size}.png 为 ${actual.width}×${actual.height},要求正好 ${size}×${size}。\n` +
          '四个尺寸 key 各指各的,尺寸对不上等于拿大图冒充小图。'
      )
    }
    return { size, buffer }
  })

  return { version, manifest, icons, iconSourceSize: `${width}×${height}` }
}

/**
 * esbuild 参数 —— 两个入口一致。不 minify 是硬要求(产物要能被用户审计 + 产物断言依赖它)。
 *
 * ★ `define` **只写一处,却同时喂 `sw` 与 `popup` 两个入口** —— 这正是「同一 buildId 注入两个
 *   产物」的最短路径,也是 popup 能拿两份标记做比对的前提(spec §3.5)。
 */
function buildOptions(buildId) {
  return {
    entryPoints: ENTRY_POINTS,
    outdir: distDir,
    bundle: true,
    format: 'iife',
    target: ['chrome114'],
    platform: 'browser',
    minify: false,
    sourcemap: false,
    logLevel: 'info',
    define: { __DOWNLORD_BUILD_ID__: JSON.stringify(buildId) }
  }
}

/** 第 3 + 4 步:注版本写 manifest、拷静态资源。watch 模式下静态资源变更也走这里。 */
function emitStaticAssets({ version, manifest, icons }) {
  writeFileSync(
    join(distDir, 'manifest.json'),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    'utf8'
  )
  writeFileSync(join(distDir, 'popup.html'), readFileSync(popupHtmlPath))
  mkdirSync(join(distDir, 'icons'), { recursive: true })
  for (const { size, buffer } of icons) {
    writeFileSync(join(distDir, 'icons', `icon-${size}.png`), buffer)
  }
}

/**
 * 第 5 步:打 zip。落 <repo>/dist/ 而非 extension/dist/ ——
 * 后者会被 electron-builder 的 extraResources 连带打进安装包(套娃)。
 * zip 根**直接是 manifest.json**(不套子目录),解压后可直接「加载解压缩的扩展」。
 */
function writeZip(version) {
  mkdirSync(zipOutDir, { recursive: true })
  const zipPath = join(zipOutDir, `downlord-extension-${version}.zip`)
  const zip = new AdmZip()
  zip.addLocalFolder(distDir)
  zip.writeZip(zipPath)
  return zipPath
}

function reportExtensionId(manifest) {
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    console.warn('[extension] ⚠️ manifest 无 key 字段 —— 扩展 ID 将由目录路径派生,换目录即变。')
    return
  }
  console.log(`[extension] 扩展 ID: ${deriveExtensionId(manifest.key)}`)
}

async function buildOnce() {
  const facts = runPreflight()
  // 第 0d 步:构建时刻在此刻定死,两个入口共用同一个值
  const buildId = formatBuildId(facts.version, new Date())

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  await esbuild.build(buildOptions(buildId))
  emitStaticAssets(facts)
  const zipPath = writeZip(facts.version)

  console.log(
    `[extension] 版本已注入: ${facts.version}(源 manifest 不含 version,由 package.json 注入)`
  )
  console.log(`[extension] 构建标记: ${buildId}(sw 与 popup 各带一份,popup 里比对二者是否一致)`)
  console.log(
    `[extension] 图标: 四个尺寸各自独立降采样(${ICON_SIZES.map((s) => `${s}×${s}`).join(' / ')}),` +
      `母图 build/icon.png ${facts.iconSourceSize}`
  )
  console.log(`[extension] 可加载解压目录: ${distDir}`)
  console.log(`[extension] zip: ${zipPath}`)
  reportExtensionId(facts.manifest)
}

async function buildWatch() {
  const facts = runPreflight()
  const buildId = formatBuildId(facts.version, new Date())

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  const ctx = await esbuild.context(buildOptions(buildId))
  await ctx.watch()
  emitStaticAssets(facts)
  reportExtensionId(facts.manifest)

  // esbuild 只看 TS 入口的依赖图,静态资源(manifest / html / icon)得自己盯着重拷
  for (const target of [
    sourceManifestPath,
    popupHtmlPath,
    sourceIconPath,
    ...ICON_SIZES.map(sizedIconPath)
  ]) {
    if (!existsSync(target)) continue
    watch(target, () => {
      try {
        emitStaticAssets(runPreflight())
        console.log(`[extension] 静态资源已重拷(${target})`)
      } catch (error) {
        console.error(`[extension] 静态资源重拷失败: ${error.message}`)
      }
    })
  }

  console.log(
    '[extension] watch 中(Ctrl+C 退出)。注意:watch 模式**不打 zip**,只刷新可加载解压目录。'
  )
  console.log(
    `[extension] 构建标记: ${buildId} —— ⚠️ **一次 watch 会话内恒定**` +
      '(esbuild 的 define 在建 context 时就固化了)。要拿到新标记,重启 watch 或跑一次 `npm run build`。'
  )
}

const watchMode = process.argv.includes('--watch')

try {
  await (watchMode ? buildWatch() : buildOnce())
} catch (error) {
  console.error(`[extension] 构建失败:${error.message}`)
  process.exit(1)
}
