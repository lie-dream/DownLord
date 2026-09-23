import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// 扩展侧「浏览器全局边界」的四条限制(v0.4 Task 2 立 chrome / browser,Task 3 加 fetch,Task 4 加 navigator)。
// 抽成常量是因为下面有两处**窄化例外**要各自摘掉其中一条 —— 手抄四份必然漂移。
const RESTRICTED_CHROME = {
  name: 'chrome',
  message: '只允许在 extension/src/adapter/chromeAdapter.ts 里出现;业务代码走 BrowserAdapter'
}
const RESTRICTED_BROWSER = {
  name: 'browser',
  message: '同上(Firefox 实现若日后要做,同样收在 adapter/ 内;本版不做 Firefox)'
}
const RESTRICTED_FETCH = {
  name: 'fetch',
  message: '只允许在 extension/src/adapter/fetchNet.ts 里出现;业务代码走 BrowserAdapter.net'
}
const RESTRICTED_NAVIGATOR = {
  name: 'navigator',
  message:
    '只允许在 extension/src/adapter/chromeAdapter.ts 里出现;UA 走 BrowserAdapter.runtime.getUserAgent()'
}

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // 下划线前缀的参数 / 变量表示「刻意不用」(TS/JS 社区通用约定):豁免之,
      // 使 FakeEngine 等占位参数 _kbps/_id 不再误报 no-unused-vars(仅放行显式标记者,不放松真未用检查)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // 纯 JS 文件(构建 / 测试脚本)不适用 TS 专属规则:.mjs 里写不了返回类型标注,
    // 对其要求 explicit-function-return-type 无法满足也无意义。
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // ① 扩展代码通段(v0.4 Task 2 · spec §6.2):契约边界 + 浏览器全局边界 + 关掉 react 系噪音。
    // 注意:explicit-function-return-type / no-explicit-any **不豁免** —— 与 src/ 同规,不为新目录开特例。
    files: ['extension/**/*.ts'],
    rules: {
      // react 系规则对零框架的扩展代码无意义,且 react-refresh 会对非组件导出误报。
      // 批量关(手数规则名必漏,漏一条就是一个 error)。
      ...Object.fromEntries(
        Object.keys(eslintPluginReact.configs.flat.recommended.rules).map((k) => [k, 'off'])
      ),
      'react-refresh/only-export-components': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',

      // 契约单向穿透:基础规则让位给 TS 版(只有后者才有 allowTypeImports,
      // 「只许 import type、禁值导入」正靠它表达)
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 契约文件:只许 import type
              group: ['**/shared/extensionProtocol', '**/shared/extensionProtocol.*'],
              allowTypeImports: true,
              message: '扩展只能 `import type` 契约类型,禁值导入(会把主仓代码 bundle 进扩展)'
            },
            {
              // ★ v0.4 Task 4 收紧:由「点名禁 `src/shared/ipc*`」改为**禁整个 `src/shared/**`**,
              // 只用 gitignore 式 `!` negation 给 `extensionProtocol` 单点开口(它的 allowTypeImports
              // 在上一条 pattern 里)。
              //
              // ⚠️ **为什么必须改**:Phase 3 会在 `src/shared/` 新建 `downloadHeaders.ts`。
              // 按旧 pattern(只点名 `ipc*`)它**不在禁止之列** —— 那是一个会**静默出现**的口子:
              // 没人会因为新建了一个共享文件就想起回来补 eslint。改成「默认禁、单点开」后,
              // 此后主仓 `src/shared/` 加任何文件都天然被挡。
              group: [
                '**/src/shared/**',
                '!**/src/shared/extensionProtocol',
                '!**/src/shared/extensionProtocol.*'
              ],
              message:
                '扩展只能经 src/shared/extensionProtocol.ts 取类型;src/shared/ 的其余文件(ipc.ts / downloadHeaders.ts …)一律禁'
            },
            {
              // 主进程 / 渲染 / preload 一律禁
              group: ['**/src/main/**', '**/src/renderer/**', '**/src/preload/**'],
              message:
                '主进程↔渲染进程的代码与扩展无关;扩展只能经 src/shared/extensionProtocol.ts 取类型'
            },
            {
              group: ['electron', 'electron/**', 'electron-log', 'electron-updater'],
              message: '扩展跑在浏览器里,不得引用任何 Electron 侧依赖'
            }
          ]
        }
      ],

      // 适配层边界:业务代码不得直接碰浏览器全局
      'no-restricted-globals': [
        'error',
        RESTRICTED_CHROME,
        RESTRICTED_BROWSER,
        RESTRICTED_FETCH,
        RESTRICTED_NAVIGATOR
      ]
    }
  },
  {
    // ② 例外一:契约收口点 —— 唯一合法的跨目录取类型点(spec §2.1)
    files: ['extension/src/contract.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' }
  },
  {
    // ③ 例外二:chrome 适配实现 —— 唯一允许碰 chrome 全局的文件(Task 2 spec §3.1),
    // 且自 v0.4 Task 4 起也是唯一允许读 `navigator` 的文件(Task 4 spec §2.5)。
    // ⚠️ **窄化而非整条 off**:只摘掉 chrome / browser / navigator,`fetch` 仍禁 ——
    // 否则「网络出口只有一个」会在这里开一个谁也想不到的口子。
    files: ['extension/src/adapter/chromeAdapter.ts'],
    rules: { 'no-restricted-globals': ['error', RESTRICTED_FETCH] }
  },
  {
    // ④ 例外三:fetch 出口 —— 唯一允许碰 fetch 全局的文件(Task 3 spec §5.4.2)。
    // 与 ③ **并列不合并**:两个例外放的东西正好相反(这里摘 fetch、仍禁 chrome / browser / navigator)。
    files: ['extension/src/adapter/fetchNet.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        RESTRICTED_CHROME,
        RESTRICTED_BROWSER,
        RESTRICTED_NAVIGATOR
      ]
    }
  },
  eslintConfigPrettier
)
