/**
 * 构建产物断言(v0.4 Task 2 · spec §8.1 断言 A4–A7 / A9)。
 *
 * 读 `extension/dist/` 的**真实产物**做断言,不 mock、不重跑构建 ——
 * 产物缺失时显式失败并提示先跑 `npm run build`(**测试不该有副作用**,不在这里偷偷触发构建)。
 * `npm run build` 已含扩展构建(spec §6.1)且在门禁四件套里,故正常流程下产物必然在场。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(extensionDir, '..')
const distDir = join(extensionDir, 'dist')

/** A4 的必备产物 —— 少一件扩展就装不起来。v0.4 Task 7(#43)起图标是四个尺寸各一张,不再共用一张。 */
const REQUIRED_ARTIFACTS = [
  'manifest.json',
  'sw.js',
  'popup.html',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
]

const MISSING_HINT =
  '扩展产物不存在或不完整。先跑 `npm run build`(或 `node scripts/build-extension.mjs`)再跑测试。'

function readDistFile(relativePath: string): string {
  const fullPath = join(distDir, relativePath)
  assert.ok(existsSync(fullPath), `缺少产物 extension/dist/${relativePath} —— ${MISSING_HINT}`)
  return readFileSync(fullPath, 'utf8')
}

interface ExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  key?: string
  permissions?: string[]
  host_permissions?: string[]
  background?: { service_worker?: string }
  action?: { default_popup?: string; default_icon?: Record<string, string> }
  icons?: Record<string, string>
}

function readDistManifest(): ExtensionManifest {
  return JSON.parse(readDistFile('manifest.json')) as ExtensionManifest
}

test('A4: 产物八件齐 + manifest 八个 icon key 各指各的(四个尺寸不共用一张图)', () => {
  assert.ok(existsSync(distDir), `extension/dist 不存在 —— ${MISSING_HINT}`)

  for (const relativePath of REQUIRED_ARTIFACTS) {
    const fullPath = join(distDir, relativePath)
    assert.ok(existsSync(fullPath), `缺少 extension/dist/${relativePath} —— ${MISSING_HINT}`)
    assert.ok(statSync(fullPath).size > 0, `extension/dist/${relativePath} 是空文件`)
  }

  // 上面只管「文件在不在」,管不住 manifest 指向谁 —— 把八个 key 改回同一张 icons/icon.png、
  // 再让那张图在 dist 里存在,上面照样全绿。#43 的交付项是「四个 key 各指各的」,
  // 那句话得有机器守着,否则这次改完、下次就静默回潮。
  const manifest = readDistManifest()
  for (const [where, group] of [
    ['icons', manifest.icons],
    ['action.default_icon', manifest.action?.default_icon]
  ] as const) {
    assert.deepStrictEqual(
      Object.keys(group ?? {}),
      ['16', '32', '48', '128'],
      `manifest.${where} 的尺寸 key 应是 16/32/48/128 四个`
    )

    const targets = Object.values(group ?? {})
    for (const target of targets) {
      assert.ok(
        existsSync(join(distDir, target)),
        `manifest.${where} 指向 extension/dist/${target},但该文件不在产物里`
      )
    }
    assert.equal(
      new Set(targets).size,
      targets.length,
      `manifest.${where} 的四个尺寸指向同一张图 —— 四尺寸降采样等于白做(#43)`
    )
  }
})

test('A5′: manifest 字段正确,permissions 与 host_permissions 各自全等(权限增长表的机器形式)', () => {
  const manifest = readDistManifest()

  assert.equal(manifest.manifest_version, 3, 'MV3')
  // 全等而非 includes:悄悄多要一个权限当场变红(权限增长表的机器执行形式,spec §4.2)。
  // v0.4 Task 4 按增长表加 `downloads`(表内,无表外新增);顺序也钉死,免得日后靠排序糊弄。
  // v0.4 Task 5 按表加 `webRequest`;Task 6 按表加 `cookies`(第四档要在浏览器内读登录态)——均无表外新增。
  assert.deepStrictEqual(manifest.permissions, ['storage', 'downloads', 'webRequest', 'cookies'])
  // v0.4 Task 3 新增的这个 key 同样要按表守 —— 只加不查,权限就会静默增长。
  // ⚠️ match pattern 语法**不支持端口**,故它是**回环全端口授权**,不得表述为「只授权 52330」。
  assert.deepStrictEqual(manifest.host_permissions, ['http://127.0.0.1/*', '<all_urls>'])
  assert.equal(manifest.background?.service_worker, 'sw.js')
  assert.equal(manifest.action?.default_popup, 'popup.html')
  assert.equal(typeof manifest.key, 'string')
  assert.ok((manifest.key ?? '').length > 0, 'key 在场 → 扩展 ID 固定,换目录不变(spec §4.3)')
})

test('A6: 产物 manifest 的 version 与 package.json 一致(防漂移)', () => {
  const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
    version: string
  }

  assert.equal(readDistManifest().version, version)
})

test('A7: 源 manifest 不含 version 字段(堵死手抄回潮)', () => {
  const sourceManifest = JSON.parse(
    readFileSync(join(extensionDir, 'manifest.json'), 'utf8')
  ) as ExtensionManifest

  assert.ok(
    !('version' in sourceManifest),
    'extension/manifest.json 不应写 version —— 版本由构建脚本从 package.json 注入'
  )
})

test('A9: 契约零运行时耦合 —— 产物不含 extensionProtocol / EXTENSION_PROTOCOL_VERSION', () => {
  // 产物刻意不 minify(spec §2.3),所以标识符断言成立:
  // 命中任何一个都说明 `import type` 变成了值导入,主仓代码被 bundle 进了扩展。
  for (const bundle of ['sw.js', 'popup.js']) {
    const text = readDistFile(bundle)
    assert.ok(
      !text.includes('extensionProtocol'),
      `${bundle} 含 "extensionProtocol" → 契约单向穿透破功(应只 import type)`
    )
    assert.ok(
      !text.includes('EXTENSION_PROTOCOL_VERSION'),
      `${bundle} 含 "EXTENSION_PROTOCOL_VERSION" → 主仓值被 bundle 进扩展`
    )
  }
})

test('A5″: manifest 无 content_scripts / scripting —— 不注入网页 DOM 是 Task 5 的红线', () => {
  for (const [name, text] of [
    ['源 manifest', readFileSync(join(extensionDir, 'manifest.json'), 'utf8')],
    ['产物 manifest', readDistFile('manifest.json')]
  ] as const) {
    assert.equal(text.includes('content_scripts'), false, `${name} 出现 content_scripts`)
    assert.equal(text.includes('scripting'), false, `${name} 出现 scripting`)
    // 正向对照:同一读法能查到确实存在的字段 —— 否则「零命中」分不清「真没有」与「读错了文件」
    assert.equal(text.includes('permissions'), true, `${name} 连 permissions 都查不到 → 读错了文件`)
  }
})

test('A9′: 嗅探清单同样零运行时耦合 —— 产物不含 sniffMedia 及其五个 SNIFF_ 常量名', () => {
  // 命名陷阱(Task 3 踩过同款):主仓用 `SNIFF_` 前缀,扩展侧一律不带(MEDIA_EXTS / STREAM_EXTS / …)。
  // 抄成同名会让本条当场变红,而那正是「值不能穿透、只能手抄」这条约束的机器形式。
  //
  // ⚠️ 判据点名**五个具体常量**而不是笼统的 `SNIFF_` 前缀:扩展侧自己也有
  //    `SNIFF_KEY_PREFIX` / `SNIFF_ENABLED_KEY` 这类合法名字,按前缀查会把它们一起误报。
  const MAIN_REPO_NAMES = [
    'sniffMedia',
    'SNIFF_STREAM_EXTS',
    'SNIFF_MEDIA_EXTS',
    'SNIFF_SEGMENT_EXTS',
    'SNIFF_STREAM_CONTENT_TYPES',
    'SNIFF_SEGMENT_CONTENT_TYPES'
  ]

  for (const bundle of ['sw.js', 'popup.js']) {
    const text = readDistFile(bundle)
    for (const name of MAIN_REPO_NAMES) {
      assert.ok(!text.includes(name), `${bundle} 含主仓标识符 "${name}" → 扩展侧抄了主仓的名字`)
    }
  }

  // 正向对照:嗅探代码**确实**在产物里(否则上面那些零命中只是因为整块代码没被打进来)
  assert.ok(readDistFile('sw.js').includes('m3u8'), 'sw.js 里应当有嗅探清单的字面量')
})
