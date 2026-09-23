import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const rootDir = process.cwd()
// 三个测试根:src/(主仓)、extension/(v0.4 Task 2 的第二个可分发工件,spec §6.3)、
// scripts/(构建脚本的纯函数单测,spec §8.1 断言 A8 指名落在 scripts/extensionVersion.test.ts —— 不列此根它就永远不跑)。
// extension/dist 是构建产物、只含 .js/.json/.html/.png,scripts/verify/ 只有 .mts 探针,都无 *.test.ts,不会被误收。
const testRoots = [join(rootDir, 'src'), join(rootDir, 'extension'), join(rootDir, 'scripts')]

// electron 包的主导出即「平台对应 electron 可执行文件的绝对路径」字符串(跨平台);
// 经 ELECTRON_RUN_AS_NODE=1 让其跑成纯 Node(内置 node:sqlite + node:test + tsx,免开窗 / 免 DISPLAY)。
const requireFromHere = createRequire(import.meta.url)
const electronExe = requireFromHere('electron')

function collectTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const tests = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      tests.push(...collectTests(fullPath))
      continue
    }

    if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
      tests.push(fullPath)
    }
  }

  return tests
}

const testFiles = testRoots
  .filter((dir) => statSync(dir, { throwIfNoEntry: false }))
  .flatMap((dir) => collectTests(dir))
  .sort()

if (testFiles.length === 0) {
  console.error('No test files found under src/ , extension/ or scripts/ (**/*.test.ts(x))')
  process.exit(1)
}

// 默认 dot reporter:全绿时输出压成一行点(1600+ 用例 ≈ 1.6KB),取代 tap 的 9800 行。
// 失败信息不丢——Node 的 dot reporter 在末尾自带 `Failed tests:` 段,含用例名 + 完整断言 diff,
// 故「失败后再跑一次 spec」是多余的一次全量重跑。反向探针批量核对靠的正是这些用例名。
// 排障要看逐用例全量时:npm test -- --spec
const reporter = process.argv.includes('--spec') ? 'spec' : 'dot'

// `npm run coverage` 走这条支路;`npm test` 的既有行为(测试数、stdout 输出形态、退出码语义)零变化。
const withCoverage = process.argv.includes('--coverage')

// 覆盖率分母 = 三个测试根下的一等源文件,减去三类排除项(*.d.ts / 测试文件自身 / *.config.*)。
// tests/ 是测试基础设施、extension/dist 与 out/ 是构建产物、scripts/verify 是一次性 .mts 探针、
// scripts/reporters 是本度量自身的代码 —— 都不在分母口径内,故一并排除,免得混进百分比里。
const coverageExcludes = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.d.ts',
  '**/*.config.*',
  'tests/**',
  'scripts/reporters/**',
  'scripts/verify/**',
  'extension/dist/**',
  'out/**'
]

// 第二个 reporter 只写 stderr,故 dot / spec 对 stdout 的输出一个字节都不变;
// 而 stdio:'inherit' 让这段摘要直接显示出来,runner 无需解析任何东西、无需临时文件。
const reporterArgs = [
  `--test-reporter=${reporter}`,
  '--test-reporter-destination=stdout',
  '--test-reporter=./scripts/reporters/skip-summary.mjs',
  '--test-reporter-destination=stderr'
]

const coverageArgs = []
if (withCoverage) {
  mkdirSync(join(rootDir, 'coverage'), { recursive: true })
  coverageArgs.push(
    '--experimental-test-coverage',
    ...coverageExcludes.map((glob) => `--test-coverage-exclude=${glob}`)
  )
  reporterArgs.push(
    '--test-reporter=./scripts/reporters/coverage-report.mjs',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    `--test-reporter-destination=${join('coverage', 'lcov.info')}`
  )
}

const result = spawnSync(
  electronExe,
  [
    '--import',
    'tsx',
    '--import',
    './tests/setup/jsdom.ts',
    '--test',
    ...coverageArgs,
    ...reporterArgs,
    ...testFiles.map((file) => relative(rootDir, file))
  ],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TSX_TSCONFIG_PATH: join(rootDir, 'tsconfig.web.json')
    },
    stdio: 'inherit',
    shell: false
  }
)

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

// dot reporter 不输出 pass/fail 汇总,这里补一行——否则「一行点」看不出跑没跑、跑了多少。
const status = result.status ?? 1
console.log(
  status === 0
    ? `\n✅ 测试全绿(${testFiles.length} 个测试文件,reporter=${reporter})`
    : `\n❌ 测试失败(exit ${status},reporter=${reporter});失败用例名与断言详情见上方 Failed tests 段`
)

process.exit(status)
