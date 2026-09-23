/**
 * preload 产物级**运行时**断言(v0.4 Task 4 · spec §7.1 的 B-01 / B-02 / B-03)。
 *
 * 与 `extension/artifact.test.ts` 同一手法:**把 `out/preload/index.js` 那个真文件跑起来**,
 * 注入假 `process.argv` 与假 `contextBridge`,看它到底 expose 了什么。
 * 守的是三类「typecheck 与 lint 都抓不到、装上才发现」的问题:
 *   - 有人给 preload 加了多入口 / 改成 ESM → CJS 前提破裂(**B-01**);
 *   - renderer 多入口被撤掉 → 小窗口 `loadFile` 404 白屏(**B-02**);
 *   - 窗口标记判定写反 / 两个对象都 expose → 小窗口拿到 59 条钥匙(**B-03**)。
 *
 * 产物缺失时**显式失败并提示先跑 `npm run build`**(与 `extension/build.test.ts` 同一风格)——
 * **测试不该有副作用**,不在这里偷偷触发构建。
 *
 * ⚠️ B-01 / B-02 同时是 2026-08-02 那次 B1 / B2 真机取证的**常驻化**:取证只证明「当时对」,
 *    这两支才让它「以后改坏会红」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { TAKEOVER_WINDOW_ARG } from '../shared/ipc'

const preloadDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(preloadDir, '..', '..')
const outDir = join(rootDir, 'out')

const MISSING_HINT = '构建产物不存在。先跑 `npm run build` 再跑测试。'

function readOutFile(relativePath: string): string {
  const fullPath = join(outDir, relativePath)
  assert.ok(existsSync(fullPath), `缺少产物 out/${relativePath} —— ${MISSING_HINT}`)
  return readFileSync(fullPath, 'utf8')
}

// ── B-01:preload 单入口 + CJS 不回归 ───────────────────────────────────────

test('B-01: out/preload/ 只有 index.js —— 没走多入口(spec §3.6)', () => {
  assert.ok(existsSync(join(outDir, 'preload')), `缺少 out/preload/ —— ${MISSING_HINT}`)
  const entries = readdirSync(join(outDir, 'preload'))

  assert.deepStrictEqual(
    entries,
    ['index.js'],
    'out/preload/ 出现了 index.js 以外的文件 —— preload 多半被改成了多入口。' +
      '接管小窗口刻意与主窗口**共用同一个 preload**(靠窗口标记分支),多入口会把 electron-vite ' +
      '的 lib 模式与 CJS 输出一起搅动,正是 spec §3.6 排除掉的那条路'
  )
})

test('B-01: out/preload/index.js 仍是 CJS(首行非 import,且经 require 取 electron)', () => {
  const source = readOutFile('preload/index.js')
  const firstLine = source.split('\n')[0]

  assert.equal(
    /^\s*import\b/.test(firstLine),
    false,
    `preload 产物首行出现顶层 import(实际首行:${JSON.stringify(firstLine)})—— 输出格式被改成了 ESM`
  )
  assert.match(
    source,
    /require\((['"])electron\1\)/,
    'preload 产物里找不到 require("electron") —— CJS 输出前提已破'
  )
})

// ── B-02:renderer 多入口产物 ───────────────────────────────────────────────

test('B-02: out/renderer/ 下 index.html 与 takeover.html 同时存在(spec §3.5)', () => {
  for (const html of ['index.html', 'takeover.html']) {
    assert.ok(
      existsSync(join(outDir, 'renderer', html)),
      `缺少 out/renderer/${html} —— renderer 多入口配置可能被撤掉了;` +
        `打包态小窗口走 loadFile(../renderer/takeover.html),缺它就是白屏。${MISSING_HINT}`
    )
  }
})

// ── B-03:窗口标记分支 ─────────────────────────────────────────────────────

interface ExposeCall {
  key: string
  value: Record<string, unknown>
}

/**
 * 在 vm 沙箱里跑一遍真产物,返回它实际发生的 `exposeInMainWorld` 调用。
 *
 * `argv` 由调用方给 —— 这就是「注入 fake `process.argv`」:真实 Electron 里这串由
 * `webPreferences.additionalArguments` 决定,这里由测试决定。
 */
function runPreloadArtifact(argv: readonly string[]): ExposeCall[] {
  const source = readOutFile('preload/index.js')
  const calls: ExposeCall[] = []

  const sandbox = {
    process: { argv: [...argv], contextIsolated: true },
    console: { log: (): void => {}, error: (): void => {} },
    window: {} as Record<string, unknown>,
    require: (id: string): unknown => {
      assert.equal(id, 'electron', `preload 产物 require 了 electron 以外的模块:${id}`)
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: Record<string, unknown>): void => {
            calls.push({ key, value })
          }
        },
        // 方法只在渲染层真调用时才触发,加载期不碰;给个空壳足够
        ipcRenderer: {
          on: (): void => {},
          removeListener: (): void => {},
          send: (): void => {},
          invoke: async (): Promise<void> => {}
        }
      }
    }
  }

  runInContext(source, createContext(sandbox))
  return calls
}

/** 真实 Electron 里 argv 的形态:一堆 Chromium 开关,标记混在中间(2026-08-02 B1 取证实录) */
const BASE_ARGV = [
  'D:\\...\\electron.exe',
  '--type=renderer',
  '--enable-sandbox',
  '--renderer-client-id=4',
  '/prefetch:1'
]

test('B-03: 带窗口标记 → 只 expose takeoverApi,且**恰好一次**', () => {
  const calls = runPreloadArtifact([...BASE_ARGV, TAKEOVER_WINDOW_ARG])

  assert.equal(
    calls.length,
    1,
    `expose 了 ${calls.length} 次 —— 两个分支各自都必须只 expose 一个对象`
  )
  assert.equal(calls[0].key, 'takeoverApi')
  // 形状对账:确认送出去的是接管面,不是主窗口那 59 条
  assert.ok(typeof calls[0].value.onPresent === 'function', 'takeoverApi 缺 onPresent')
  assert.ok(typeof calls[0].value.submit === 'function', 'takeoverApi 缺 submit')
  assert.equal(
    calls[0].value.removeTask,
    undefined,
    '接管小窗口拿到了 removeTask —— 最小暴露面被破坏(它只该确认一次下载)'
  )
})

test('B-03: **标记缺失** → 走主窗口分支,只 expose api,且**恰好一次**', () => {
  const calls = runPreloadArtifact(BASE_ARGV)

  assert.equal(
    calls.length,
    1,
    `expose 了 ${calls.length} 次 —— 两个分支各自都必须只 expose 一个对象`
  )
  assert.equal(calls[0].key, 'api')
  assert.ok(typeof calls[0].value.addTask === 'function', 'api 缺 addTask')
  assert.equal(
    calls[0].value.onPresent,
    undefined,
    '主窗口拿到了 takeoverApi 的方法 —— 分支即边界这条已破'
  )
})

test('B-03: 两个分支的 expose 是**互斥**的 —— 任一次运行都只有一个 key', () => {
  const takeoverKeys = runPreloadArtifact([...BASE_ARGV, TAKEOVER_WINDOW_ARG]).map((c) => c.key)
  const mainKeys = runPreloadArtifact(BASE_ARGV).map((c) => c.key)

  assert.deepStrictEqual(takeoverKeys, ['takeoverApi'])
  assert.deepStrictEqual(mainKeys, ['api'])
  assert.deepStrictEqual(
    takeoverKeys.filter((k) => mainKeys.includes(k)),
    [],
    '两个分支 expose 了同一个 key —— 说明有对象被无条件暴露了'
  )
})

test('B-03: 标记判定是**全等匹配**,不是子串 —— 相似前缀不得误判为小窗口', () => {
  const calls = runPreloadArtifact([...BASE_ARGV, `${TAKEOVER_WINDOW_ARG}-x`])

  assert.deepStrictEqual(
    calls.map((c) => c.key),
    ['api'],
    `argv 里只有 ${TAKEOVER_WINDOW_ARG}-x 却被判成了接管窗口 —— ` +
      '判定要是 includes(整串) 而非字符串包含'
  )
})
