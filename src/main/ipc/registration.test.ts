/**
 * 零覆盖清单 C 类:`src/main/ipc/` 十个注册模块的替身测 —— v1.0 Task 1 Phase 2 后半。
 *
 * 背景(Phase 1 实测):这十个文件 **全部零覆盖**,原因不是「不可测」,而是它们顶层就
 * `import { ipcMain } from 'electron'`,而 electron-as-node 下 `require('electron')` 回的是**字符串**
 * (可执行文件路径),`ipcMain` / `app` / `BrowserWindow` 全为 `undefined`。缺的只是一个替身。
 * ⇒ 判定:**真缺口,不是豁免**(spec §1.4 那条纪律:把「不可测」归进排除项等于把它伪装成已覆盖;
 * 而把「可测但没测」写成豁免,是同一个错换了方向)。
 *
 * 被钉住的是这十个模块**唯一的职责** —— 转发正确性,共三件:
 *   ① 通道名对不对(漏注册一个 = 界面上一个按钮永久失灵,而任何既有断言都不会红);
 *   ② 参数有没有**原样**传给业务单元(它们不许自己写业务逻辑,ARCHITECTURE §7.2);
 *   ③ 广播有没有**跳过已销毁窗口**(不跳会在关窗竞态里抛 `Object has been destroyed`)。
 *
 * 🚫 替身不模拟 Electron 语义,故本文件**不断言** Electron 自己的行为(窗口真会不会最小化之类)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'path'
import { writeFileSync } from 'fs'

import { IpcChannel } from '../../shared/ipc'
import type { AppIpcDeps } from './app'
import {
  FakeWindow,
  emitListener,
  invokeHandler,
  nativeTheme,
  recorder,
  resetElectronStub
} from '../../../tests/helpers/electronStub'
import { makeTempDir } from '../../../tests/helpers/tmpdir'

const requireCjs = createRequire(import.meta.url)
const STUB_PATH = resolve(__dirname, '../../../tests/helpers/electronStub.ts')

interface ResolverHost {
  _resolveFilename(request: string, ...rest: unknown[]): string
}

/**
 * 劫持 `'electron'` 的模块解析 → 替身,跑 fn,无论成败都还原。
 * 与 `db/engines/betterSqlite.test.ts` 同一手法(那里劫的是 `better-sqlite3`)。
 */
async function withElectronStub<T>(fn: () => Promise<T>): Promise<T> {
  const moduleApi = requireCjs('module') as unknown as ResolverHost
  const original = moduleApi._resolveFilename
  moduleApi._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === 'electron') return STUB_PATH
    return original.call(this, request, ...rest)
  }
  try {
    resetElectronStub()
    return await fn()
  } finally {
    moduleApi._resolveFilename = original
  }
}

/** 造 n 个假窗口并登记进替身;返回它们,便于逐个断言 */
function makeWindows(n: number): FakeWindow[] {
  const wins = Array.from({ length: n }, (_, i) => new FakeWindow(i + 1))
  recorder.windows.push(...wins)
  return wins
}

// ==================== app ====================

/** 只注入路径与 I/O 替身,不创建文件、不打开真实文档。 */
function makeNoticesDeps(
  overrides: Partial<AppIpcDeps['thirdPartyNotices']> = {}
): AppIpcDeps['thirdPartyNotices'] {
  return {
    isPackaged: false,
    appPath: resolve('.tmp-probe/task5-fixtures/notices-ipc/app'),
    resourcesPath: resolve('.tmp-probe/task5-fixtures/notices-ipc/resources'),
    existsSync: () => true,
    openPath: async () => '',
    ...overrides
  }
}

test('IPC-1 app:四个通道注册齐,既有版本 / 默认目录读取仍纯转发', async () => {
  await withElectronStub(async () => {
    const { registerAppIpc } = await import('./app')
    const versions = { aria2c: '1.37.0', ytDlp: '2025.01.01', ffmpeg: '7.1' }
    let reads = 0
    registerAppIpc({
      getEngineVersions: () => {
        reads += 1
        return versions as never
      },
      thirdPartyNotices: makeNoticesDeps()
    })

    assert.deepEqual(
      [...recorder.handlers.keys()].sort(),
      [
        'app:getDownloadDir',
        'app:getEngineVersions',
        'app:getVersion',
        'app:openThirdPartyNotices'
      ],
      '四个通道一个不少,也不注册多余通道(漏一个 = 关于页 / 默认目录静默失灵)'
    )
    recorder.appVersion = '9.9.9'
    assert.equal(invokeHandler(IpcChannel.AppGetVersion), '9.9.9')
    assert.equal(invokeHandler(IpcChannel.AppGetDownloadDir), 'D:\\Downloads', "getPath('downloads')")
    assert.equal(invokeHandler(IpcChannel.AppGetEngineVersions), versions)
    assert.equal(reads, 1, '每次 invoke 现读缓存,不在注册期取一次就定死')
  })
})

for (const isPackaged of [false, true]) {
  test(`NOTICES-main 固定路径:${isPackaged ? '打包 resources 根' : '开发应用根'},无参数且先查存在再打开`, async () => {
    await withElectronStub(async () => {
      const { registerAppIpc } = await import('./app')
      const calls: Array<[string, string]> = []
      const notices = makeNoticesDeps({
        isPackaged,
        existsSync: (p) => {
          calls.push(['exists', p])
          return true
        },
        openPath: async (p) => {
          calls.push(['open', p])
          return ''
        }
      })
      registerAppIpc({
        getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
        thirdPartyNotices: notices
      })
      assert.equal(IpcChannel.AppOpenThirdPartyNotices, 'app:openThirdPartyNotices')
      assert.ok(recorder.handlers.has(IpcChannel.AppOpenThirdPartyNotices))
      assert.deepEqual(calls, [], '注册不应打开文档')
      assert.equal(await invokeHandler(IpcChannel.AppOpenThirdPartyNotices), '')
      const expected = join(
        isPackaged ? notices.resourcesPath : notices.appPath,
        'THIRD-PARTY-NOTICES.md'
      )
      assert.deepEqual(calls, [
        ['exists', expected],
        ['open', expected]
      ])
      assert.deepEqual(recorder.shellCalls, [], '只走注入 I/O,不碰系统 shell')
    })
  })

  test(`NOTICES-main 缺文件:${isPackaged ? '打包' : '开发'}态返回可见错误,不调用 openPath`, async () => {
    await withElectronStub(async () => {
      const { registerAppIpc } = await import('./app')
      const checked: string[] = []
      const notices = makeNoticesDeps({
        isPackaged,
        existsSync: (p) => {
          checked.push(p)
          return false
        },
        openPath: async () => assert.fail('缺文件时不许调用 shell.openPath')
      })
      registerAppIpc({
        getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
        thirdPartyNotices: notices
      })
      assert.equal(
        await invokeHandler(IpcChannel.AppOpenThirdPartyNotices),
        '第三方许可与声明文件不存在，请检查应用文件是否完整。'
      )
      assert.deepEqual(checked, [
        join(isPackaged ? notices.resourcesPath : notices.appPath, 'THIRD-PARTY-NOTICES.md')
      ])
    })
  })
}

test('NOTICES-main 运行时拒绝任何额外参数,包括显式 undefined / 空载荷,且零 I/O', async (t) => {
  const cases: Array<[string, unknown[]]> = [
    ['任意本地路径', ['D:/outside/notices.md']],
    ['路径穿越', ['../THIRD-PARTY-NOTICES.md']],
    ['URL', ['https://example.invalid/notices']],
    ['路径对象', [{ path: 'D:/outside/notices.md' }]],
    ['空对象', [{}]],
    ['空数组', [[]]],
    ['undefined', [undefined]],
    ['null', [null]],
    ['空字符串', ['']],
    ['false', [false]],
    ['零', [0]],
    ['多个参数', [undefined, 'D:/outside/notices.md']]
  ]
  for (const [label, args] of cases) {
    await t.test(label, async () => {
      await withElectronStub(async () => {
        const { registerAppIpc } = await import('./app')
        registerAppIpc({
          getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
          thirdPartyNotices: makeNoticesDeps({
            existsSync: () => assert.fail('非法参数不许访问文件系统'),
            openPath: async () => assert.fail('非法参数不许调用 shell.openPath')
          })
        })
        assert.equal(
          await invokeHandler(IpcChannel.AppOpenThirdPartyNotices, ...args),
          '打开第三方许可与声明失败：此操作不接受参数。'
        )
        assert.deepEqual(recorder.shellCalls, [])
      })
    })
  }
})

test('NOTICES-main 系统 openPath 返回失败字符串时保留原因,不假报成功', async () => {
  await withElectronStub(async () => {
    const { registerAppIpc } = await import('./app')
    let opens = 0
    registerAppIpc({
      getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
      thirdPartyNotices: makeNoticesDeps({
        openPath: async () => {
          opens += 1
          return 'Windows 找不到关联程序'
        }
      })
    })
    assert.equal(
      await invokeHandler(IpcChannel.AppOpenThirdPartyNotices),
      '打开第三方许可与声明失败：Windows 找不到关联程序'
    )
    assert.equal(opens, 1)
  })
})

for (const [label, failure, detail] of [
  ['Error', new Error('系统拒绝访问'), '系统拒绝访问'],
  ['字符串', '系统打开失败', '系统打开失败'],
  ['无原因', undefined, '未知错误，请重试。']
] as const) {
  test(`NOTICES-main openPath 抛出${label}也转成可见错误,不泄漏 rejection`, async () => {
    await withElectronStub(async () => {
      const { registerAppIpc } = await import('./app')
      registerAppIpc({
        getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
        thirdPartyNotices: makeNoticesDeps({
          openPath: async () => {
            throw failure
          }
        })
      })
      assert.equal(
        await invokeHandler(IpcChannel.AppOpenThirdPartyNotices),
        `打开第三方许可与声明失败：${detail}`
      )
    })
  })
}

test('NOTICES-main 存在检查抛异常也返回可见错误,不继续打开', async () => {
  await withElectronStub(async () => {
    const { registerAppIpc } = await import('./app')
    registerAppIpc({
      getEngineVersions: () => ({ aria2: '1.37.0', ytdlp: 'test', ffmpeg: '8.1.2' }),
      thirdPartyNotices: makeNoticesDeps({
        existsSync: () => {
          throw new Error('无法检查声明文件')
        },
        openPath: async () => assert.fail('存在检查异常后不许继续打开')
      })
    })
    assert.equal(
      await invokeHandler(IpcChannel.AppOpenThirdPartyNotices),
      '打开第三方许可与声明失败：无法检查声明文件'
    )
  })
})

// ==================== settings ====================

test('IPC-2 settings:两个通道纯转发 SettingsService,patch 原样透传、返回值原样回', async () => {
  await withElectronStub(async () => {
    const { registerSettingsIpc } = await import('./settings')
    const seen: unknown[] = []
    const latest = { maxConcurrent: 5 }
    registerSettingsIpc({
      settingsService: {
        get: () => latest,
        set: (patch: unknown) => {
          seen.push(patch)
          return latest
        }
      } as never
    })

    assert.deepEqual([...recorder.handlers.keys()].sort(), ['settings:get', 'settings:set'])
    assert.equal(await invokeHandler(IpcChannel.SettingsGet), latest)
    const patch = { maxConcurrent: 7, speedLimitKBps: 0 }
    assert.equal(await invokeHandler(IpcChannel.SettingsSet, patch), latest)
    assert.deepEqual(seen, [patch], 'handler 不许改写 patch —— 校验 / clamp 全在 SettingsService')
  })
})

// ==================== proxy ====================

test('IPC-3 proxy:三个通道纯转发;statusChanged 广播跳过已销毁窗口', async () => {
  await withElectronStub(async () => {
    const { registerProxyIpc, broadcastProxyStatusChanged } = await import('./proxy')
    const cfg = { mode: 'manual', manualUrl: 'http://127.0.0.1:7890' }
    const status = { mode: 'manual', effectiveUrl: 'http://127.0.0.1:7890', reachable: true }
    const setArgs: unknown[] = []
    registerProxyIpc({
      proxyService: {
        getProxyConfig: () => cfg,
        setConfig: (c: unknown) => {
          setArgs.push(c)
          return status
        },
        getStatus: () => status
      } as never
    })

    assert.deepEqual(
      [...recorder.handlers.keys()].sort(),
      ['proxy:get', 'proxy:getStatus', 'proxy:set']
    )
    assert.equal(await invokeHandler(IpcChannel.ProxyGet), cfg)
    assert.equal(await invokeHandler(IpcChannel.ProxySet, cfg), status)
    assert.equal(await invokeHandler(IpcChannel.ProxyGetStatus), status)
    assert.deepEqual(setArgs, [cfg])

    const [w1, w2, w3] = makeWindows(3)
    w2.destroyed = true
    broadcastProxyStatusChanged(status as never)
    assert.deepEqual(
      recorder.sent.map((m) => m.windowId),
      [w1.id, w3.id],
      '已销毁窗口必须跳过(不跳会在关窗竞态里抛 Object has been destroyed)'
    )
    assert.equal(recorder.sent[0].channel, IpcChannel.ProxyStatusChanged)
    assert.deepEqual(recorder.sent[0].args, [status])
  })
})

// ==================== extension ====================

test('IPC-4 extension:五个通道纯转发;setChannelConfig 刻意不收 token;状态广播跳过已销毁窗口', async () => {
  await withElectronStub(async () => {
    const { registerExtensionIpc, broadcastExtensionChannelStatus } = await import('./extension')
    const config = { enabled: true, port: 52330, token: 'tok' }
    const status = { service: 'listening', extension: 'paired' }
    const patches: unknown[] = []
    registerExtensionIpc({
      channelService: {
        getConfig: () => config,
        setConfig: (p: unknown) => {
          patches.push(p)
          return status
        },
        regenerateToken: () => config,
        getStatus: () => status,
        getSideloadInfo: () => ({ dir: 'D:\\ext', exists: true })
      } as never
    })

    assert.deepEqual([...recorder.handlers.keys()].sort(), [
      'extension:getChannelConfig',
      'extension:getChannelStatus',
      'extension:getSideloadInfo',
      'extension:regenerateToken',
      'extension:setChannelConfig'
    ])
    assert.equal(await invokeHandler(IpcChannel.ExtensionGetChannelConfig), config)
    assert.equal(await invokeHandler(IpcChannel.ExtensionGetChannelStatus), status)
    assert.equal(await invokeHandler(IpcChannel.ExtensionRegenerateToken), config)
    assert.deepEqual(await invokeHandler(IpcChannel.ExtensionGetSideloadInfo), {
      dir: 'D:\\ext',
      exists: true
    })

    const patch = { enabled: false, port: 52331 }
    assert.equal(await invokeHandler(IpcChannel.ExtensionSetChannelConfig, patch), status)
    assert.deepEqual(patches, [patch], 'patch 原样转发')

    const [w1, w2] = makeWindows(2)
    w1.destroyed = true
    broadcastExtensionChannelStatus(status as never)
    assert.deepEqual(
      recorder.sent.map((m) => [m.windowId, m.channel]),
      [[w2.id, IpcChannel.ExtensionChannelStatusChanged]]
    )
  })
})

// ==================== theme ====================

test('IPC-5 theme:theme:set 写 nativeTheme.themeSource 并回解析后的生效主题', async () => {
  await withElectronStub(async () => {
    const { registerThemeIpc } = await import('./theme')
    registerThemeIpc()

    assert.deepEqual([...recorder.handlers.keys()], ['theme:set'])

    nativeTheme.shouldUseDarkColors = false
    assert.equal(invokeHandler(IpcChannel.ThemeSet, 'light'), 'light')
    assert.equal(nativeTheme.themeSource, 'light', 'mode 必须写进 nativeTheme.themeSource')

    // 权威源是 shouldUseDarkColors,不是传进来的 mode —— system 档下这两者会不一致
    nativeTheme.shouldUseDarkColors = true
    assert.equal(
      invokeHandler(IpcChannel.ThemeSet, 'system'),
      'dark',
      'system 档下的生效主题取 shouldUseDarkColors,不许回传 mode 本身'
    )
    assert.equal(nativeTheme.themeSource, 'system')
  })
})

test('IPC-6 theme:系统主题变化 → 向所有未销毁窗口推 theme:changed', async () => {
  await withElectronStub(async () => {
    const { registerThemeIpc } = await import('./theme')
    registerThemeIpc()
    assert.ok(recorder.themeListeners.has('updated'), '必须监听 nativeTheme updated')

    const [w1, w2, w3] = makeWindows(3)
    w3.destroyed = true
    nativeTheme.shouldUseDarkColors = true
    nativeTheme.fireUpdated()

    assert.deepEqual(
      recorder.sent.map((m) => [m.windowId, m.channel, m.args[0]]),
      [
        [w1.id, IpcChannel.ThemeChanged, 'dark'],
        [w2.id, IpcChannel.ThemeChanged, 'dark']
      ]
    )
  })
})

// ==================== shell ====================

test('IPC-7 shell:文件不存在 → 返回可读中文提示且**不碰系统 shell**;存在 → 透传', async (t) => {
  const dir = await makeTempDir(t, 'ipc-shell')
  const real = join(dir, 'real.bin')
  writeFileSync(real, 'x')
  const missing = join(dir, 'gone.bin')

  await withElectronStub(async () => {
    const { registerShellIpc } = await import('./shell')
    registerShellIpc()
    assert.deepEqual([...recorder.handlers.keys()].sort(), ['shell:openPath', 'shell:showItemInFolder'])

    // ① 缺失:两个通道同一句文案,且一次系统调用都不许发生
    assert.equal(await invokeHandler(IpcChannel.ShellOpenPath, missing), '文件不存在,可能已被移动或删除')
    assert.equal(
      await invokeHandler(IpcChannel.ShellShowItemInFolder, missing),
      '文件不存在,可能已被移动或删除'
    )
    assert.deepEqual(
      recorder.shellCalls,
      [],
      '缺失时提前返回 —— 否则会退化成系统英文弹窗 / 静默无反应的不一致(§6.3)'
    )

    // ② 存在:openPath 透传底层返回串(空 = 成功),showItemInFolder 恒回空串
    recorder.openPathResult = 'Windows 找不到关联程序'
    assert.equal(
      await invokeHandler(IpcChannel.ShellOpenPath, real),
      'Windows 找不到关联程序',
      'openPath 的失败原因必须原样回传,不许吞成空串'
    )
    assert.equal(await invokeHandler(IpcChannel.ShellShowItemInFolder, real), '')
    assert.deepEqual(recorder.shellCalls, [`openPath:${real}`, `showItemInFolder:${real}`])
  })
})

// ==================== window ====================

test('IPC-8 window:三个单向通道按 sender 反查窗口;toggleMaximize 双向切换', async () => {
  await withElectronStub(async () => {
    const { registerWindowIpc } = await import('./window')
    registerWindowIpc()
    assert.deepEqual(
      [...recorder.listeners.keys()].sort(),
      ['window:close', 'window:minimize', 'window:toggleMaximize']
    )

    const [win, other] = makeWindows(2)
    emitListener(IpcChannel.WindowMinimize, win.webContents)
    emitListener(IpcChannel.WindowToggleMaximize, win.webContents) // 未最大化 → maximize
    emitListener(IpcChannel.WindowToggleMaximize, win.webContents) // 已最大化 → unmaximize
    emitListener(IpcChannel.WindowClose, win.webContents)

    assert.deepEqual(win.calls, ['minimize', 'maximize', 'unmaximize', 'close'])
    assert.deepEqual(other.calls, [], '只作用于发消息那个窗口(多窗口不许串门)')
  })
})

test('IPC-9 window:已销毁窗口 / 反查不到窗口时静默跳过,不抛', async () => {
  await withElectronStub(async () => {
    const { registerWindowIpc } = await import('./window')
    registerWindowIpc()

    const [win] = makeWindows(1)
    win.destroyed = true
    emitListener(IpcChannel.WindowMinimize, win.webContents)
    assert.deepEqual(win.calls, [], '已销毁窗口不许再调 minimize')

    // 反查不到(sender 不属于任何窗口)→ fromWebContents 回 null → 早退不抛
    emitListener(IpcChannel.WindowClose, { send: () => {} })
    assert.deepEqual(win.calls, [])
  })
})

// ==================== torrent / video ====================

test('IPC-10 torrent:两个通道纯转发 TaskManager,参数原样、返回值原样', async () => {
  await withElectronStub(async () => {
    const { registerTorrentIpc } = await import('./torrent')
    const calls: unknown[][] = []
    registerTorrentIpc({
      applyTorrentSelection: async (...a: unknown[]) => {
        calls.push(['applyTorrentSelection', ...a])
      },
      stopSeeding: async (...a: unknown[]) => {
        calls.push(['stopSeeding', ...a])
      }
    } as never)

    assert.deepEqual(
      [...recorder.handlers.keys()].sort(),
      ['torrent:applySelection', 'torrent:stopSeeding']
    )
    await invokeHandler(IpcChannel.TorrentApplySelection, 't1', [1, 3, 4])
    await invokeHandler(IpcChannel.TorrentStopSeeding, 't2')
    assert.deepEqual(calls, [
      ['applyTorrentSelection', 't1', [1, 3, 4]],
      ['stopSeeding', 't2']
    ])
  })
})

test('IPC-11 video:三个通道纯转发;getResolved 的 null 必须原样回(不许变 undefined)', async () => {
  await withElectronStub(async () => {
    const { registerVideoIpc } = await import('./video')
    const calls: unknown[][] = []
    let resolved: unknown = null
    registerVideoIpc({
      getResolved: (id: string) => {
        calls.push(['getResolved', id])
        return resolved
      },
      selectFormat: async (...a: unknown[]) => {
        calls.push(['selectFormat', ...a])
      },
      submitBatch: async (...a: unknown[]) => {
        calls.push(['submitBatch', ...a])
      }
    } as never)

    assert.deepEqual(
      [...recorder.handlers.keys()].sort(),
      ['video:getResolved', 'video:select', 'video:submitBatch']
    )
    assert.equal(
      await invokeHandler(IpcChannel.VideoGetResolved, 'v1'),
      null,
      'null 与 undefined 在 IPC 序列化后不等价 —— 渲染层的「还没解析出来」判定靠的是 null'
    )
    resolved = { kind: 'video' }
    assert.deepEqual(await invokeHandler(IpcChannel.VideoGetResolved, 'v1'), { kind: 'video' })

    const choice = { formatId: '137', audioOnly: false }
    await invokeHandler(IpcChannel.VideoSelect, 'v1', choice)
    await invokeHandler(IpcChannel.VideoSubmitBatch, 'p1', [{ entryIndex: 0, choice }])
    assert.deepEqual(calls, [
      ['getResolved', 'v1'],
      ['getResolved', 'v1'],
      ['selectFormat', 'v1', choice],
      ['submitBatch', 'p1', [{ entryIndex: 0, choice }]]
    ])
  })
})

// ==================== clipboard(只有广播,没有 handler)====================

test('IPC-12 clipboard:只导出广播 helper,推给所有未销毁窗口', async () => {
  await withElectronStub(async () => {
    const mod = await import('./clipboard')
    assert.deepEqual(
      Object.keys(mod).sort(),
      ['broadcastClipboardLink'],
      '本文件刻意**没有** registerClipboardIpc:点「添加」走既有 addTask,不新开通道'
    )

    const [w1, w2] = makeWindows(2)
    w1.destroyed = true
    const link = { url: 'https://example.com/a.zip', kind: 'http' }
    mod.broadcastClipboardLink(link as never)
    assert.deepEqual(
      recorder.sent.map((m) => [m.windowId, m.channel, m.args[0]]),
      [[w2.id, IpcChannel.ClipboardLinkDetected, link]]
    )
  })
})

// ==================== 替身自检(缺这条,上面每一条都可能是恒真)====================

test('IPC-13 判据自检:替身劫持真的生效 —— 不劫持时 ipcMain 是 undefined', async () => {
  // 正向对照:electron-as-node 下真 `require('electron')` 回的是**字符串**(可执行文件路径),
  // 故 `ipcMain` 恒 undefined。上面 12 条能跑通,唯一解释就是劫持确实把 'electron' 换成了替身。
  const realElectron = requireCjs('electron') as unknown
  assert.equal(typeof realElectron, 'string', 'electron-as-node 下 require("electron") 回路径字符串')
  assert.equal(
    (realElectron as Record<string, unknown>).ipcMain,
    undefined,
    '真 electron 模块在本运行时没有 ipcMain —— 这正是这十个模块此前零覆盖的原因'
  )

  // 反向:劫持生效时,同一个 request 解析到的是替身文件
  const moduleApi = requireCjs('module') as unknown as ResolverHost
  const original = moduleApi._resolveFilename
  moduleApi._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === 'electron') return STUB_PATH
    return original.call(this, request, ...rest)
  }
  try {
    assert.equal(moduleApi._resolveFilename('electron', module, false), STUB_PATH)
  } finally {
    moduleApi._resolveFilename = original
  }
})
