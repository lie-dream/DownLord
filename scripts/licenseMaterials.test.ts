import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// Phase 1 source contracts only: neither this checker nor the npm scanner inspects an installer.
// The byte baselines below came from the fixed upstream materials, not a generated manifest.
const root = resolve(import.meta.dirname, '..')
const bin = 'resources/bin/'
const provenancePath = bin + 'license-provenance.json'
const tplPath = bin + 'license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt'
const canonicalPath = bin + 'yt-dlp-LICENSE.txt'
const engineVersionsPath = 'src/main/binaries/engineVersions.ts'
const requiredHashes: Record<string, string> = {
  'aria2-LICENSE.txt': '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643',
  'ffmpeg-LICENSE.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  'yt-dlp-LICENSE.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  'license-notices/yt-dlp/LICENSE':
    '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  'license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt':
    'b085c65586a953cdb4b13c6390d63ec984d66912e4b6a19e66ba3582f2ed104b',
  'license-notices/yt-dlp/README.md':
    '23f551d2ae1887611978e1a6223a259e3dfdc2f767fb8972f63c9b10fa9c8e23',
  'license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE':
    'c32913b33252e71190af2066f08115c69bc9fddadf3bf29296e20c835389841c',
  'license-notices/yt-dlp/components/requests-2.34.2/NOTICE':
    'f5110972dedad2b4e9d314518daf3b7d72d6e02e499acd802181de6f74571dcc',
  'license-notices/yt-dlp/components/certifi/index.f75d2927d3c1.txt':
    '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
  'license-notices/yt-dlp/components/liblzma/COPYING.0BSD':
    '0b01625d853911cd0e2e088dcfb743261034a091bb379246cb25a14cc4c74bf1',
  'license-notices/yt-dlp/components/liblzma/xz-5.2.5/COPYING':
    'bcb02973ef6e87ea73d331b3a80df7748407f17efdb784b61b47e0e610d3bb5c',
  'license-notices/aria2/LICENSE.OpenSSL':
    '8bf8790acc763bbae4e03f90fd28ee25acdf6daadd3b2adc90101365a403ed07',
  'license-notices/ffmpeg/README.txt':
    '9172433fb251059a58d2ff11ba8c6132e04819136ed96e809563911ff0d13816'
}
const ffmpegDocs: string[] = [
  'bootstrap.min.css',
  'community.html',
  'default.css',
  'developer.html',
  'drawvg-reference.html',
  'faq.html',
  'fate.html',
  'ffmpeg-all.html',
  'ffmpeg-bitstream-filters.html',
  'ffmpeg-codecs.html',
  'ffmpeg-devices.html',
  'ffmpeg-filters.html',
  'ffmpeg-formats.html',
  'ffmpeg-protocols.html',
  'ffmpeg-resampler.html',
  'ffmpeg-scaler.html',
  'ffmpeg-utils.html',
  'ffmpeg.html',
  'ffplay-all.html',
  'ffplay.html',
  'ffprobe-all.html',
  'ffprobe.html',
  'general.html',
  'git-howto.html',
  'libavcodec.html',
  'libavdevice.html',
  'libavfilter.html',
  'libavformat.html',
  'libavutil.html',
  'libswresample.html',
  'libswscale.html',
  'mailing-list-faq.html',
  'nut.html',
  'platform.html',
  'style.min.css'
]
const aria2Extras = [
  'AUTHORS',
  'ChangeLog',
  'LICENSE.OpenSSL',
  'NEWS',
  'README.html',
  'README.mingw'
]
const ffmpegPresets = [
  'libvpx-1080p.ffpreset',
  'libvpx-1080p50_60.ffpreset',
  'libvpx-360p.ffpreset',
  'libvpx-720p.ffpreset',
  'libvpx-720p50_60.ffpreset'
]
const inventory = new Set(
  [
    ...Object.keys(requiredHashes),
    ...aria2Extras.map((name) => 'license-notices/aria2/' + name),
    ...ffmpegDocs.map((name) => 'license-notices/ffmpeg/doc/' + name),
    ...ffmpegPresets.map((name) => 'license-notices/ffmpeg/presets/' + name)
  ].map((name) => bin + name)
)
const engines = [
  {
    id: 'aria2',
    file: 'aria2c.exe',
    version: '1.37.0',
    sourceLicense: 'GPL-2.0-or-later',
    binaryLicense: 'GPL-2.0-or-later',
    sha256: 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2'
  },
  {
    id: 'ffmpeg',
    file: 'ffmpeg.exe',
    version: '8.1.2',
    sourceLicense: 'GPL-3.0-or-later (this configured build)',
    binaryLicense: 'GPL-3.0-or-later',
    sha256: '1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e'
  },
  {
    id: 'yt-dlp',
    file: 'yt-dlp.exe',
    version: '2026.07.04',
    sourceLicense: 'Unlicense',
    binaryLicense: 'GPL-3.0-or-later',
    sha256: '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'
  }
]
const semanticNotices = [
  '聚合许可文件不是 Windows 已实测成分清单。',
  'GNU Readline 等仅 Linux 条目不据此归入 Windows。',
  'Microsoft 附加条件仅约束微软可分发代码，不扩大到 Python 或其上程序整体。',
  'Eric Young 广告致谢仅在原文的广告条件成立时适用；Tim Hudson 致谢仅在包含 apps 目录的 Windows 特定代码或其衍生代码时适用。',
  'Meriyah/Astring 未标仅 Unix，原版权及 ISC/MIT 全文已内嵌。',
  '0BSD 致谢不是法律强制；XZ 构建系统的 GPL 不因此适用于所构建的二进制。',
  '旧版 XZ 的公有领域许可不被追溯改为 0BSD。'
]

type Snapshot = Map<string, Buffer>
interface Provenance {
  schemaVersion: number
  engines: {
    id: string
    version: string
    sourceLicense: string
    binaryLicense: string
    localBinary: { sha256: string }
  }[]
  materials: {
    path: string
    packagedPath: string
    originId: string
    originalPath: string
    sha256: string
    bytes: number
  }[]
  origins: { id: string; url: string; sha256: string }[]
  gplExtraction: {
    startInclusive: number
    endExclusive: number
    sourceSha256: string
    extractedSha256: string
  }
  applicability: {
    inventoryStatus: string
    windowsObserved: string[]
    unexcluded: string[]
    linuxMacosOnly: string[]
    linuxOnly: string[]
    macosOnly: string[]
    microsoftScope: string
    curlExcludedBuilds: string[]
    meriyahAstringUnixOnly: boolean
    opensslAdvertisingConditional: boolean
    opensslAppsAcknowledgementConditional: boolean
    zeroBsdCreditRequired: boolean
    xzBuildSystemGplAppliesToBinary: boolean
    liblzma: { binaryVersionVerified: boolean; oldPublicDomainPreserved: boolean }
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshot(): Snapshot {
  const files: Snapshot = new Map()
  function read(relativePath: string): void {
    if (existsSync(join(root, relativePath)))
      files.set(relativePath, readFileSync(join(root, relativePath)))
  }
  function walk(relativePath: string): void {
    if (!existsSync(join(root, relativePath))) return
    for (const entry of readdirSync(join(root, relativePath), { withFileTypes: true })) {
      const name = relativePath + '/' + entry.name
      if (entry.isDirectory()) walk(name)
      else if (entry.isFile() && !name.endsWith('.exe')) read(name)
    }
  }
  walk('resources/bin')
  for (const name of [
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    '.gitattributes',
    'electron-builder.yml',
    engineVersionsPath,
    'scripts/scan-licenses.mjs'
  ])
    read(name)
  return files
}

function inspect(files: Snapshot): { code: 0 | 1; issues: string[] } {
  const issues = new Set<string>()
  const text = (name: string): string => files.get(name)?.toString('utf8') ?? ''
  const check = (ok: boolean, issue: string): void => {
    if (!ok) issues.add(issue)
  }
  for (const name of inventory) check(files.has(name), 'missing:' + name)
  for (const [name, hash] of Object.entries(requiredHashes)) {
    if (files.has(bin + name))
      check(digest(files.get(bin + name)!) === hash, 'integrity:' + bin + name)
  }
  let p: Provenance
  try {
    p = JSON.parse(text(provenancePath)) as Provenance
  } catch {
    return { code: 1, issues: [...issues, 'provenance:missing-or-invalid'] }
  }
  check(p.schemaVersion === 1, 'provenance:schema')
  const actualInventory = [...files.keys()].filter(
    (name) =>
      name.startsWith(bin) && ![bin + 'README.md', bin + '.gitkeep', provenancePath].includes(name)
  )
  check(
    JSON.stringify(actualInventory.sort()) === JSON.stringify([...inventory].sort()),
    'materials:inventory'
  )
  check(
    JSON.stringify(p.materials.map((m) => m.path).sort()) === JSON.stringify([...inventory].sort()),
    'provenance:inventory'
  )
  for (const m of p.materials) {
    const bytes = files.get(m.path)
    if (bytes) check(digest(bytes) === m.sha256 && bytes.length === m.bytes, 'integrity:' + m.path)
    check(m.packagedPath === m.path.replace(/^resources\//, ''), 'mapping:' + m.path)
    check(
      p.origins.some(
        (o) => o.id === m.originId && /^https:\/\//.test(o.url) && /^[a-f0-9]{64}$/.test(o.sha256)
      ) && !!m.originalPath,
      'origin:' + m.path
    )
  }
  const notices = text('THIRD-PARTY-NOTICES.md')
  for (const expected of engines) {
    const e = p.engines.find((candidate) => candidate.id === expected.id)
    check(
      !!e &&
        e.version === expected.version &&
        e.sourceLicense === expected.sourceLicense &&
        e.binaryLicense === expected.binaryLicense &&
        e.localBinary.sha256 === expected.sha256,
      'engine:' + expected.id
    )
    check(
      notices.includes(
        '| ' +
          expected.id +
          ' | ' +
          expected.version +
          ' | ' +
          expected.sourceLicense +
          ' | ' +
          expected.binaryLicense +
          ' |'
      ),
      'notices:engine:' + expected.id
    )
  }
  check(
    !/2026\.06\.09/.test(text(bin + 'README.md') + text(engineVersionsPath) + notices),
    'metadata:stale-version'
  )
  check(/ytdlp:\s*'2026\.07\.04'/.test(text(engineVersionsPath)), 'metadata:fallback')
  check(
    /file: 'yt-dlp\.exe',\s*version: '2026\.07\.04',\s*sourceLicense: 'Unlicense',\s*license: 'GPL-3\.0-or-later'/.test(
      text('scripts/scan-licenses.mjs')
    ),
    'metadata:scanner'
  )
  check(
    /Copyright \(c\) 2026 lie-dream/.test(text('LICENSE')) &&
      !text('LICENSE').includes('@') &&
      text('LICENSE').includes('Permission is hereby granted, free of charge') &&
      text('LICENSE').includes('IN NO EVENT SHALL THE'),
    'project:MIT'
  )
  const slice = p.gplExtraction
  check(
    slice.startInclusive === 43768 &&
      slice.endExclusive === 78915 &&
      slice.sourceSha256 === requiredHashes[tplPath.slice(bin.length)] &&
      slice.extractedSha256 === requiredHashes['yt-dlp-LICENSE.txt'],
    'gpl:provenance'
  )
  const tpl = files.get(tplPath)
  const gpl = files.get(canonicalPath)
  check(
    !!tpl && !!gpl && tpl.subarray(slice.startInclusive, slice.endExclusive).equals(gpl),
    'gpl:byte-slice'
  )
  const legal = text(canonicalPath)
  check(
    Array.from({ length: 18 }, (_, i) => new RegExp('(?:^|\\n)  ' + i + '\\. ').test(legal)).every(
      Boolean
    ) &&
      legal.includes('END OF TERMS AND CONDITIONS') &&
      legal.includes('How to Apply These Terms to Your New Programs') &&
      legal.endsWith('<http://www.gnu.org/philosophy/why-not-lgpl.html>.\n'),
    'gpl:complete-text'
  )
  const a = p.applicability
  check(
    a.inventoryStatus === 'not-an-exhaustive-binary-inventory' &&
      !a.windowsObserved.includes('GNU Readline'),
    'platform:inventory-scope'
  )
  check(
    JSON.stringify(a.linuxMacosOnly) === JSON.stringify(['ncurses']) &&
      JSON.stringify(a.linuxOnly) ===
        JSON.stringify([
          'GNU Readline',
          'libstdc++',
          'libgcc',
          'libuuid',
          'SecretStorage',
          'cryptography',
          'Jeepney'
        ]) &&
      JSON.stringify(a.macosOnly) ===
        JSON.stringify(['libintl', 'libidn2', 'Unicode data', 'libunistring', 'librtmp', 'zstd']),
    'platform:excluded-groups'
  )
  check(
    a.microsoftScope === 'Microsoft Distributable Code only' &&
      !a.meriyahAstringUnixOnly &&
      JSON.stringify(a.curlExcludedBuilds) ===
        JSON.stringify(['yt-dlp_x86', 'yt-dlp_musllinux_aarch64']),
    'platform:component-conditions'
  )
  check(
    a.opensslAdvertisingConditional &&
      a.opensslAppsAcknowledgementConditional &&
      !a.zeroBsdCreditRequired &&
      !a.xzBuildSystemGplAppliesToBinary &&
      !a.liblzma.binaryVersionVerified &&
      a.liblzma.oldPublicDomainPreserved,
    'conditions:scope'
  )
  for (const sentence of semanticNotices)
    check(notices.includes(sentence), 'notices:scope:' + sentence)
  const extra =
    text('electron-builder.yml')
      .split(/^extraResources:\s*$/m)[1]
      ?.split(/^\S/m)[0] ?? ''
  const entries = [...extra.matchAll(/^ {2}- from: (.+)\r?\n([\s\S]*?)(?=^ {2}- from: |$(?![\s\S]))/gm)]
  const engineEntry = entries.find((entry) => entry[1].trim() === 'resources/bin')
  const filters = engineEntry
    ? [...engineEntry[2].matchAll(/^ {6}- ['"]?([^'"\r\n]+)['"]?\s*$/gm)].map((match) => match[1])
    : []
  check(
    !!engineEntry &&
      /^ {4}to: bin\s*$/m.test(engineEntry[2]) &&
      JSON.stringify(filters.sort()) ===
        JSON.stringify(
          [
            'aria2c.exe',
            'ffmpeg.exe',
            'yt-dlp.exe',
            'aria2-LICENSE.txt',
            'ffmpeg-LICENSE.txt',
            'yt-dlp-LICENSE.txt',
            'license-notices/**/*',
            'license-provenance.json'
          ].sort()
        ),
    'copy:bin'
  )
  check(
    entries.length === 3 &&
      entries.some(
        (entry) =>
          entry[1].trim() === 'THIRD-PARTY-NOTICES.md' &&
          /^ {4}to: THIRD-PARTY-NOTICES.md\s*$/m.test(entry[2])
      ),
    'copy:root-single-source'
  )
  check(
    entries.some(
      (entry) => entry[1].trim() === 'extension/dist' && /^ {4}to: extension\s*$/m.test(entry[2])
    ),
    'copy:extension'
  )
  const attrs = text('.gitattributes')
  for (const name of [
    'aria2-LICENSE.txt',
    'ffmpeg-LICENSE.txt',
    'yt-dlp-LICENSE.txt',
    'license-notices/**'
  ])
    check(attrs.includes('/resources/bin/' + name + ' -text'), 'attributes:' + name)
  check(attrs.includes('* text=auto eol=lf'), 'attributes:global-policy')
  return { code: issues.size ? 1 : 0, issues: [...issues] }
}

const baseline = snapshot()
test('Phase1/local materials, semantic boundaries and single-source copy contracts', () => {
  assert.deepEqual(inspect(baseline), { code: 0, issues: [] })
})
// 三枚引擎 EXE 是 git 忽略的构建输入,不在源码树里(真 CI 的全新 checkout 没有它们,2026-09-23 实证);
// 缺席时显式 skip 并写明原因,不静默;字节核对由本机与打包期的包内检查承担。
const missingEngines = engines
  .filter((e) => !existsSync(join(root, bin, e.file)))
  .map((e) => e.file)
test(
  'Phase1/bundled engine bytes remain the verified existing binaries',
  {
    skip: missingEngines.length
      ? `engine binaries are git-ignored build inputs and are absent here: ${missingEngines.join(', ')}`
      : false
  },
  () => {
    for (const e of engines)
      assert.equal(digest(readFileSync(join(root, bin, e.file))), e.sha256, e.file)
  }
)

// Fixtures are small on-disk overlays of the read-only source snapshot; unmodified 11 MB docs
// are shared in memory, never edited/hard-linked. Each result records its base manifest hash.
function negative(id: string, expectedIssue: string, mutate: (files: Snapshot) => void): void {
  test('Phase1/negative/' + id, () => {
    assert.equal(
      inspect(baseline).code,
      0,
      'A broken positive control must not make a negative fixture pass'
    )
    const files = new Map(baseline)
    mutate(files)
    const fixtureRoot = join(root, '.tmp-probe/task5-fixtures')
    mkdirSync(fixtureRoot, { recursive: true })
    const dir = mkdtempSync(join(fixtureRoot, 'phase1-material-' + id + '-'))
    const changes: { path: string; operation: string }[] = []
    for (const name of new Set([...baseline.keys(), ...files.keys()])) {
      const changed = files.get(name)
      if (changed === baseline.get(name)) continue
      changes.push({ path: name, operation: changed ? 'replace' : 'remove' })
      if (changed) {
        const target = join(dir, 'changes', name)
        mkdirSync(resolve(target, '..'), { recursive: true })
        writeFileSync(target, changed)
        files.set(name, readFileSync(target))
      }
    }
    const result = inspect(files)
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify(
        {
          fixtureKind: 'synthetic source snapshot overlay, not a packaged artifact',
          baseManifestSha256: digest(baseline.get(provenancePath)!),
          changes,
          expectedIssue,
          ...result
        },
        null,
        2
      ) + '\n'
    )
    assert.equal(result.code, 1, JSON.stringify(result))
    assert.ok(
      result.issues.some((issue) => issue.startsWith(expectedIssue)),
      JSON.stringify(result)
    )
  })
}
function changeText(files: Snapshot, name: string, edit: (text: string) => string): void {
  files.set(name, Buffer.from(edit(files.get(name)!.toString('utf8'))))
}
function changeProvenance(files: Snapshot, edit: (p: Provenance) => void): void {
  const p = JSON.parse(files.get(provenancePath)!.toString('utf8')) as Provenance
  edit(p)
  files.set(provenancePath, Buffer.from(JSON.stringify(p)))
}
negative('incomplete-gpl-block', 'gpl:complete-text', (files) =>
  changeText(files, canonicalPath, (s) => s.slice(0, s.indexOf('  17. ')))
)
for (const name of [
  'license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
  'license-notices/yt-dlp/components/requests-2.34.2/NOTICE',
  'license-notices/yt-dlp/components/certifi/index.f75d2927d3c1.txt',
  'license-notices/yt-dlp/components/liblzma/COPYING.0BSD'
])
  negative('missing-' + name.split('/').slice(-2).join('-'), 'missing:' + bin + name, (files) => {
    files.delete(bin + name)
  })
negative('mpl-link-not-full-text', 'integrity:', (files) => {
  files.set(
    bin + 'license-notices/yt-dlp/components/certifi/index.f75d2927d3c1.txt',
    Buffer.from('Mozilla Public License 2.0: https://www.mozilla.org/MPL/2.0/')
  )
})
negative('xz-index-not-0bsd', 'integrity:', (files) => {
  files.set(
    bin + 'license-notices/yt-dlp/components/liblzma/COPYING.0BSD',
    Buffer.from(
      'XZ Utils Licensing\nliblzma is under the BSD Zero Clause License (0BSD). See COPYING.0BSD.'
    )
  )
})
negative('wrong-finished-license', 'engine:yt-dlp', (files) =>
  changeProvenance(files, (p) => {
    p.engines.find((e) => e.id === 'yt-dlp')!.binaryLicense = 'Unlicense'
  })
)
negative('readline-as-windows', 'platform:inventory-scope', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.windowsObserved.push('GNU Readline')
  })
)
negative('microsoft-all-python', 'platform:component-conditions', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.microsoftScope = 'all Python programs'
  })
)
negative('meriyah-unix-only', 'platform:component-conditions', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.meriyahAstringUnixOnly = true
  })
)
negative('openssl-unconditional', 'conditions:scope', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.opensslAdvertisingConditional = false
    p.applicability.opensslAppsAcknowledgementConditional = false
  })
)
negative('0bsd-mandatory-credit', 'conditions:scope', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.zeroBsdCreditRequired = true
  })
)
negative('notice-unconditional', 'notices:scope:', (files) =>
  changeText(files, 'THIRD-PARTY-NOTICES.md', (s) =>
    s.replace(semanticNotices[3], 'Eric Young 和 Tim Hudson 致谢无条件适用。')
  )
)
negative('stale-notice', 'notices:engine:yt-dlp', (files) =>
  changeText(files, 'THIRD-PARTY-NOTICES.md', (s) => s.replaceAll('2026.07.04', '2026.06.09'))
)
negative('wrong-fallback', 'metadata:fallback', (files) =>
  changeText(files, engineVersionsPath, (s) => s.replaceAll('2026.07.04', '2026.06.09'))
)
negative('stale-manual-copy', 'copy:root-single-source', (files) =>
  changeText(files, 'electron-builder.yml', (s) =>
    s.replace('from: THIRD-PARTY-NOTICES.md', 'from: resources/THIRD-PARTY-NOTICES.md')
  )
)
negative('tpl-line-ending-conversion', 'integrity:' + tplPath, (files) =>
  changeText(files, tplPath, (s) => s.replaceAll('\n', '\r\n'))
)
negative('unregistered-extra-material', 'materials:inventory', (files) => {
  files.set(bin + 'license-notices/extraction-temp.txt', Buffer.from('must not ship'))
})

negative('source-gpl-block-missing', 'gpl:byte-slice', (files) => {
  const bytes = files.get(tplPath)!
  files.set(tplPath, Buffer.concat([bytes.subarray(0, 43768), bytes.subarray(78915)]))
})
negative('notice-wrong-finished-license', 'notices:engine:yt-dlp', (files) =>
  changeText(files, 'THIRD-PARTY-NOTICES.md', (s) =>
    s.replace(
      '| yt-dlp | 2026.07.04 | Unlicense | GPL-3.0-or-later |',
      '| yt-dlp | 2026.07.04 | Unlicense | Unlicense |'
    )
  )
)
negative('notice-readline-as-windows', 'notices:scope:', (files) =>
  changeText(files, 'THIRD-PARTY-NOTICES.md', (s) =>
    s.replace(semanticNotices[1], 'GNU Readline 是 Windows 已实测成分。')
  )
)
negative('xz-build-system-gpl-to-binary', 'conditions:scope', (files) =>
  changeProvenance(files, (p) => {
    p.applicability.xzBuildSystemGplAppliesToBinary = true
  })
)
