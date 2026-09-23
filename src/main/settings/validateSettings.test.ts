import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clampBtMaxPeers,
  clampMaxConcurrent,
  clampSeedRatio,
  clampSeedTimeMin,
  clampSpeedLimit,
  isAllowedHeight,
  isCookieConfig,
  isSubtitleChoice,
  isThemeMode,
  mergeSettings
} from './validateSettings'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_COOKIE_CONFIG,
  DEFAULT_SUBTITLE_CHOICE,
  type AppSettings
} from '../../shared/ipc'

// ==================== clampMaxConcurrent(取整 + clamp [1,10])====================

test('clampMaxConcurrent 越界夹取与取整', () => {
  assert.equal(clampMaxConcurrent(0), 1, '0 → 下界 1')
  assert.equal(clampMaxConcurrent(11), 10, '11 → 上界 10')
  assert.equal(clampMaxConcurrent(-5), 1, '负数 → 下界 1')
  assert.equal(clampMaxConcurrent(3.7), 3, '3.7 → 向下取整 3')
  assert.equal(clampMaxConcurrent(5), 5, '区间内原样')
  assert.equal(clampMaxConcurrent(10), 10, '边界 10 保留')
  assert.equal(clampMaxConcurrent(1), 1, '边界 1 保留')
})

test('clampMaxConcurrent 非数 / 非有限 → 回退默认 3', () => {
  assert.equal(clampMaxConcurrent(NaN), 3)
  assert.equal(clampMaxConcurrent(Infinity), 3)
  assert.equal(clampMaxConcurrent('5' as unknown), 3)
  assert.equal(clampMaxConcurrent(null), 3)
  assert.equal(clampMaxConcurrent(undefined), 3)
})

// ==================== clampSpeedLimit(取整 + clamp [0,1048576],0=不限,v0.2 Task 2 · spec §2.1 / §7.1)====================

test('clampSpeedLimit 越界夹取与取整', () => {
  assert.equal(clampSpeedLimit(0), 0, '0 → 0(不限速)')
  assert.equal(clampSpeedLimit(-5), 0, '负数 → 0')
  assert.equal(clampSpeedLimit(500.7), 500, '小数向下取整')
  assert.equal(clampSpeedLimit(500), 500, '区间内原样')
  assert.equal(clampSpeedLimit(1048576), 1048576, '上界保留')
  assert.equal(clampSpeedLimit(2000000), 1048576, '超上限 → 夹取 1048576')
})

test('clampSpeedLimit 非数 / 非有限 → 回退 0(不限速)', () => {
  assert.equal(clampSpeedLimit(NaN), 0)
  assert.equal(clampSpeedLimit(Infinity), 0)
  assert.equal(clampSpeedLimit(-Infinity), 0)
  assert.equal(clampSpeedLimit('500' as unknown), 0)
  assert.equal(clampSpeedLimit(null), 0)
  assert.equal(clampSpeedLimit(undefined), 0)
})

// ==================== clampSeedRatio / clampSeedTimeMin / clampBtMaxPeers(v0.3 Task 3 · spec §5)====================

test('clampSeedRatio 保留小数 + 边界 [0,100]', () => {
  assert.equal(clampSeedRatio(1.5), 1.5, '保留小数(不取整)')
  assert.equal(clampSeedRatio(0), 0, '0 保留(不按分享率停)')
  assert.equal(clampSeedRatio(-1), 0, '负数 → 0')
  assert.equal(clampSeedRatio(100), 100, '上界保留')
  assert.equal(clampSeedRatio(200), 100, '超上限 → 100')
  assert.equal(clampSeedRatio(NaN), 1.0, '非有限 → 默认 1.0')
  assert.equal(clampSeedRatio(Infinity), 1.0)
  assert.equal(clampSeedRatio('2' as unknown), 1.0, '非数字 → 默认 1.0')
})

test('clampSeedTimeMin 整数 + 边界 [0,10080]', () => {
  assert.equal(clampSeedTimeMin(60), 60)
  assert.equal(clampSeedTimeMin(90.7), 90, '小数向下取整')
  assert.equal(clampSeedTimeMin(-5), 0, '负数 → 0')
  assert.equal(clampSeedTimeMin(10080), 10080, '上界(7 天)保留')
  assert.equal(clampSeedTimeMin(99999), 10080, '超上限 → 10080')
  assert.equal(clampSeedTimeMin(NaN), 60, '非有限 → 默认 60')
  assert.equal(clampSeedTimeMin(null), 60)
})

test('clampBtMaxPeers 整数 + 边界 [0,512]', () => {
  assert.equal(clampBtMaxPeers(200), 200)
  assert.equal(clampBtMaxPeers(0), 0, '0 = 跟随全局 128')
  assert.equal(clampBtMaxPeers(-1), 0, '负数 → 0')
  assert.equal(clampBtMaxPeers(512), 512, '上界保留')
  assert.equal(clampBtMaxPeers(1000), 512, '超上限 → 512')
  assert.equal(clampBtMaxPeers(50.9), 50, '小数向下取整')
  assert.equal(clampBtMaxPeers(NaN), 0, '非有限 → 默认 0')
})

test('mergeSettings BT 做种四字段:布尔守卫 + 数值 clamp + 缺省保留默认', () => {
  // btSeedEnabled 布尔守卫(默认 false → true;非布尔回退)
  const on = mergeSettings(DEFAULT_APP_SETTINGS, { btSeedEnabled: true })
  assert.equal(on.btSeedEnabled, true, '合法布尔接受(false→true)')
  const kept = mergeSettings(DEFAULT_APP_SETTINGS, {
    btSeedEnabled: 'yes' as unknown as boolean
  })
  assert.equal(kept.btSeedEnabled, false, '非布尔 → 回退当前(默认 false)')

  // 三数值走 clamp
  const clamped = mergeSettings(DEFAULT_APP_SETTINGS, {
    btSeedRatio: 999,
    btSeedTimeMin: 99999,
    btMaxPeers: 9999
  })
  assert.equal(clamped.btSeedRatio, 100, 'ratio 超上限 → 100')
  assert.equal(clamped.btSeedTimeMin, 10080, 'time 超上限 → 10080')
  assert.equal(clamped.btMaxPeers, 512, 'peers 超上限 → 512')

  // 小数:ratio 保留、time/peers 取整
  const frac = mergeSettings(DEFAULT_APP_SETTINGS, {
    btSeedRatio: 1.5,
    btSeedTimeMin: 30.9,
    btMaxPeers: 100.9
  })
  assert.equal(frac.btSeedRatio, 1.5, 'ratio 保留小数')
  assert.equal(frac.btSeedTimeMin, 30, 'time 取整')
  assert.equal(frac.btMaxPeers, 100, 'peers 取整')

  // 缺省(空 patch)→ 保留默认
  const missing = mergeSettings(DEFAULT_APP_SETTINGS, {})
  assert.equal(missing.btSeedEnabled, false)
  assert.equal(missing.btSeedRatio, 1.0)
  assert.equal(missing.btSeedTimeMin, 60)
  assert.equal(missing.btMaxPeers, 0)
})

test('mergeSettings btAutoUpdateTrackers 布尔守卫(v0.4 Task 1 · spec §5.2)', () => {
  // 默认开 → 可关
  assert.equal(DEFAULT_APP_SETTINGS.btAutoUpdateTrackers, true, '默认开(按需拉取,失败退内置表)')
  const off = mergeSettings(DEFAULT_APP_SETTINGS, { btAutoUpdateTrackers: false })
  assert.equal(off.btAutoUpdateTrackers, false, '合法布尔生效(true→false)')

  // 非布尔被忽略 → 保留 current(不猜、不 coerce)
  const kept = mergeSettings(off, {
    btAutoUpdateTrackers: 'on' as unknown as boolean
  })
  assert.equal(kept.btAutoUpdateTrackers, false, '非布尔 → 回退当前值(false)')
  const keptTrue = mergeSettings(DEFAULT_APP_SETTINGS, {
    btAutoUpdateTrackers: 1 as unknown as boolean
  })
  assert.equal(keptTrue.btAutoUpdateTrackers, true, '数字 1 不当作 true,保留当前(true)')

  // 缺省(空 patch)→ 保留默认
  assert.equal(mergeSettings(DEFAULT_APP_SETTINGS, {}).btAutoUpdateTrackers, true)
})

// ==================== isThemeMode 守卫 ====================

test('isThemeMode 守卫三档', () => {
  assert.equal(isThemeMode('system'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('turbo'), false)
  assert.equal(isThemeMode(''), false)
  assert.equal(isThemeMode(123), false)
  assert.equal(isThemeMode(null), false)
})

// ==================== isAllowedHeight 白名单 ====================

test('isAllowedHeight 白名单(null | 480 | 720 | 1080 | 2160)', () => {
  assert.equal(isAllowedHeight(null), true)
  assert.equal(isAllowedHeight(480), true)
  assert.equal(isAllowedHeight(720), true)
  assert.equal(isAllowedHeight(1080), true)
  assert.equal(isAllowedHeight(2160), true)
  assert.equal(isAllowedHeight(360), false, '非白名单数值')
  assert.equal(isAllowedHeight(4320), false, '>4K 不在白名单')
  assert.equal(isAllowedHeight('1080' as unknown), false, '字符串非法')
  assert.equal(isAllowedHeight(undefined), false)
})

// ==================== mergeSettings ====================

test('mergeSettings 空 patch → no-op(返回等值克隆,video 不共享引用)', () => {
  const merged = mergeSettings(DEFAULT_APP_SETTINGS, {})
  assert.deepEqual(merged, DEFAULT_APP_SETTINGS)
  assert.notEqual(merged, DEFAULT_APP_SETTINGS, '应为新对象')
  assert.notEqual(merged.video, DEFAULT_APP_SETTINGS.video, 'video 应克隆,不共享引用')
})

test('mergeSettings 丢弃未知键,仅接受已知字段', () => {
  const merged = mergeSettings(DEFAULT_APP_SETTINGS, {
    maxConcurrent: 5,
    // @ts-expect-error 故意传未知键验证被丢弃
    bogus: 'x',
    foo: 42
  })
  assert.equal(merged.maxConcurrent, 5)
  assert.equal('bogus' in merged, false)
  assert.equal('foo' in merged, false)
})

test('mergeSettings 逐字段校验:非法值回退当前值', () => {
  const current: AppSettings = {
    defaultDir: 'D:/Downloads',
    maxConcurrent: 4,
    maxOverallLimitKBps: 0,
    useAria2cForVideo: true,
    video: { defaultHeight: 1080, defaultAudioOnly: false },
    themeMode: 'dark',
    clipboardWatch: false,
    autoUpdateYtDlp: true,
    autoUpdateApp: true,
    btSeedEnabled: false,
    btSeedRatio: 1.0,
    btSeedTimeMin: 60,
    btMaxPeers: 0,
    btAutoUpdateTrackers: true
  }
  const merged = mergeSettings(current, {
    maxConcurrent: 99, // clamp → 10
    themeMode: 'turbo' as unknown as AppSettings['themeMode'], // 非法 → 保留 dark
    video: { defaultHeight: 360, defaultAudioOnly: true } // 360 非白名单 → 保留 1080;audioOnly 接受
  })
  assert.equal(merged.maxConcurrent, 10)
  assert.equal(merged.themeMode, 'dark')
  assert.equal(merged.defaultDir, 'D:/Downloads', '未传保留当前')
  assert.equal(merged.video.defaultHeight, 1080, '非白名单 → 保留当前')
  assert.equal(merged.video.defaultAudioOnly, true, '合法布尔接受')
})

test('mergeSettings maxOverallLimitKBps clamp / useAria2cForVideo 布尔守卫(v0.2 Task 2 · spec §4.3)', () => {
  // maxOverallLimitKBps:越界 clamp、小数 floor、负数 → 0
  const clamped = mergeSettings(DEFAULT_APP_SETTINGS, { maxOverallLimitKBps: 2000000 })
  assert.equal(clamped.maxOverallLimitKBps, 1048576, '超上限 → clamp 1048576')
  const floored = mergeSettings(DEFAULT_APP_SETTINGS, { maxOverallLimitKBps: 500.7 })
  assert.equal(floored.maxOverallLimitKBps, 500, '小数 floor')
  const negated = mergeSettings(DEFAULT_APP_SETTINGS, { maxOverallLimitKBps: -1 })
  assert.equal(negated.maxOverallLimitKBps, 0, '负数 → 0(不限速)')

  // useAria2cForVideo:合法布尔接受
  const off = mergeSettings(DEFAULT_APP_SETTINGS, { useAria2cForVideo: false })
  assert.equal(off.useAria2cForVideo, false, '合法布尔接受')

  // useAria2cForVideo:非布尔回退当前值(默认 true)
  const kept = mergeSettings(DEFAULT_APP_SETTINGS, {
    useAria2cForVideo: 'yes' as unknown as boolean
  })
  assert.equal(kept.useAria2cForVideo, true, '非布尔 → 回退当前(默认 true)')
})

test('mergeSettings clipboardWatch 布尔守卫(v0.2 Task 4 · spec §1.2 / §6.1)', () => {
  // 默认关(false)→ 补丁开启为 true(关键判别:无守卫时 spread 只带 current false,补丁被丢)
  const on = mergeSettings(DEFAULT_APP_SETTINGS, { clipboardWatch: true })
  assert.equal(on.clipboardWatch, true, '合法 true 接受')

  // 当前 true → 补丁关闭为 false
  const current: AppSettings = { ...DEFAULT_APP_SETTINGS, clipboardWatch: true }
  const off = mergeSettings(current, { clipboardWatch: false })
  assert.equal(off.clipboardWatch, false, '合法 false 接受(true→false)')

  // 非布尔 → 回退当前值(此处当前为 true)
  const kept = mergeSettings(current, {
    clipboardWatch: 'yes' as unknown as boolean
  })
  assert.equal(kept.clipboardWatch, true, '非布尔 → 回退当前')

  // 缺失(空 patch)→ 保留当前(默认 false)
  const missing = mergeSettings(DEFAULT_APP_SETTINGS, {})
  assert.equal(missing.clipboardWatch, false, '未传 → 保留当前(默认 false)')
})

test('mergeSettings autoUpdateYtDlp / autoUpdateApp 布尔守卫(v0.2 Task 6 · spec §4.1)', () => {
  // 默认开(true)→ 补丁关闭为 false(关键判别:无守卫时 spread 只带 current,补丁被丢)
  const offYtDlp = mergeSettings(DEFAULT_APP_SETTINGS, { autoUpdateYtDlp: false })
  assert.equal(offYtDlp.autoUpdateYtDlp, false, '合法 false 接受(true→false)')
  const offApp = mergeSettings(DEFAULT_APP_SETTINGS, { autoUpdateApp: false })
  assert.equal(offApp.autoUpdateApp, false, '合法 false 接受(true→false)')

  // 当前 false → 补丁开启为 true
  const current: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    autoUpdateYtDlp: false,
    autoUpdateApp: false
  }
  const on = mergeSettings(current, { autoUpdateYtDlp: true, autoUpdateApp: true })
  assert.equal(on.autoUpdateYtDlp, true, 'yt-dlp false→true 接受')
  assert.equal(on.autoUpdateApp, true, 'app false→true 接受')

  // 非布尔 → 回退当前值(此处当前为 true 默认)
  const kept = mergeSettings(DEFAULT_APP_SETTINGS, {
    autoUpdateYtDlp: 'yes' as unknown as boolean,
    autoUpdateApp: 1 as unknown as boolean
  })
  assert.equal(kept.autoUpdateYtDlp, true, '非布尔 → 回退当前(默认 true)')
  assert.equal(kept.autoUpdateApp, true, '非布尔 → 回退当前(默认 true)')

  // 缺失(空 patch)→ 保留当前(默认 true)
  const missing = mergeSettings(DEFAULT_APP_SETTINGS, {})
  assert.equal(missing.autoUpdateYtDlp, true, '未传 → 保留当前(默认 true)')
  assert.equal(missing.autoUpdateApp, true, '未传 → 保留当前(默认 true)')
})

test('mergeSettings defaultDir 接受任意字符串(含空串语义)', () => {
  const merged = mergeSettings(DEFAULT_APP_SETTINGS, { defaultDir: '' })
  assert.equal(merged.defaultDir, '')
  const merged2 = mergeSettings(DEFAULT_APP_SETTINGS, {
    defaultDir: 123 as unknown as string // 非字符串 → 回退当前
  })
  assert.equal(merged2.defaultDir, DEFAULT_APP_SETTINGS.defaultDir)
})

test('mergeSettings video 部分字段补丁:只改 defaultHeight 不动 defaultAudioOnly', () => {
  const current: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    video: { defaultHeight: null, defaultAudioOnly: true }
  }
  const merged = mergeSettings(current, { video: { defaultHeight: 720 } as AppSettings['video'] })
  assert.equal(merged.video.defaultHeight, 720)
  assert.equal(merged.video.defaultAudioOnly, true, '未传字段保留当前')
})

// ==================== isCookieConfig / isSubtitleChoice 守卫(v0.2 Task 1 · spec §4.4)====================

test('isCookieConfig 接受三态合法配置', () => {
  assert.equal(isCookieConfig(DEFAULT_COOKIE_CONFIG), true)
  assert.equal(
    isCookieConfig({ source: 'browser', browser: 'firefox', profile: null, file: null }),
    true
  )
  assert.equal(
    isCookieConfig({ source: 'browser', browser: 'chrome', profile: 'Default', file: null }),
    true
  )
  assert.equal(
    isCookieConfig({ source: 'file', browser: null, profile: null, file: 'D:\\c.txt' }),
    true
  )
})

test('isCookieConfig 拒绝非法 source / browser / 字段类型', () => {
  assert.equal(isCookieConfig({ source: 'turbo', browser: null, profile: null, file: null }), false)
  assert.equal(
    isCookieConfig({ source: 'browser', browser: 'safari', profile: null, file: null }),
    false
  )
  assert.equal(isCookieConfig({ source: 'file', browser: null, profile: null, file: 123 }), false)
  assert.equal(isCookieConfig(null), false)
  assert.equal(isCookieConfig('x'), false)
})

test('isSubtitleChoice 接受合法选择', () => {
  assert.equal(isSubtitleChoice(DEFAULT_SUBTITLE_CHOICE), true)
  assert.equal(
    isSubtitleChoice({ langs: ['zh-Hans', 'en'], format: 'vtt', includeAuto: true }),
    true
  )
})

test('isSubtitleChoice 拒绝非法 langs / format / includeAuto', () => {
  assert.equal(isSubtitleChoice({ langs: 'zh', format: 'srt', includeAuto: false }), false)
  assert.equal(isSubtitleChoice({ langs: [1, 2], format: 'srt', includeAuto: false }), false)
  assert.equal(isSubtitleChoice({ langs: [], format: 'ass', includeAuto: false }), false)
  assert.equal(isSubtitleChoice({ langs: [], format: 'srt', includeAuto: 'yes' }), false)
  assert.equal(isSubtitleChoice(null), false)
})

// ==================== mergeVideoPrefs cookie / subtitle(经 mergeSettings)====================

test('mergeSettings 接受合法 cookie 补丁,非法回退当前', () => {
  const patched = mergeSettings(DEFAULT_APP_SETTINGS, {
    video: {
      defaultHeight: null,
      defaultAudioOnly: false,
      cookie: { source: 'browser', browser: 'edge', profile: null, file: null }
    } as AppSettings['video']
  })
  assert.deepEqual(patched.video.cookie, {
    source: 'browser',
    browser: 'edge',
    profile: null,
    file: null
  })

  // 非法 cookie → 保留当前(默认 none)
  const rejected = mergeSettings(DEFAULT_APP_SETTINGS, {
    video: {
      defaultHeight: null,
      defaultAudioOnly: false,
      cookie: { source: 'bad', browser: null, profile: null, file: null }
    } as unknown as AppSettings['video']
  })
  assert.deepEqual(rejected.video.cookie, DEFAULT_COOKIE_CONFIG, '非法 cookie 回退当前默认')
})

test('mergeSettings subtitle 补丁经 normalizeSubtitle 去空 / 去重', () => {
  const patched = mergeSettings(DEFAULT_APP_SETTINGS, {
    video: {
      defaultHeight: null,
      defaultAudioOnly: false,
      subtitle: { langs: [' en ', 'en', '', 'zh-Hans'], format: 'srt', includeAuto: true }
    } as AppSettings['video']
  })
  assert.deepEqual(patched.video.subtitle, {
    langs: ['en', 'zh-Hans'],
    format: 'srt',
    includeAuto: true
  })
})

// ==================== v0.4 Task 6:第四档 'extension' 与首次说明标记 ====================
// ⚠️ 这两条**看住的是「静默丢弃」**:白名单漏 `'extension'` 时 `isCookieConfig` 判假 →
//    整个 cookie 补丁被 `mergeVideoPrefs` 悄悄扔掉,表现为「设置页选了第四档,松手弹回原档」,
//    读盘侧同样失效。**没有这两条,漏白名单不会让任何用例变红。**

test('★ v0.4 Task 6:isCookieConfig 认第四档 extension(browser/profile/file 恒 null,与 none 同形)', () => {
  assert.equal(
    isCookieConfig({ source: 'extension', browser: null, profile: null, file: null }),
    true
  )
  // 正向对照:白名单确实在筛,不是恒真
  assert.equal(
    isCookieConfig({ source: 'extensions', browser: null, profile: null, file: null }),
    false
  )
})

test('★ v0.4 Task 6:mergeSettings 落得下第四档(漏白名单则被静默丢弃)', () => {
  const patched = mergeSettings(DEFAULT_APP_SETTINGS, {
    video: { cookie: { source: 'extension', browser: null, profile: null, file: null } }
  })
  assert.deepEqual(patched.video.cookie, {
    source: 'extension',
    browser: null,
    profile: null,
    file: null
  })
})

test('★ v0.4 Task 6:cookieExtensionNoticeAcked 可选布尔 —— 缺省不写、给了才落(零迁移)', () => {
  // 缺省:默认设置里根本没有这个键 → 「未确认」,首次切档照样弹说明
  assert.equal('cookieExtensionNoticeAcked' in DEFAULT_APP_SETTINGS, false)
  assert.equal(mergeSettings(DEFAULT_APP_SETTINGS, {}).cookieExtensionNoticeAcked, undefined)
  // 显式给布尔才落
  assert.equal(
    mergeSettings(DEFAULT_APP_SETTINGS, { cookieExtensionNoticeAcked: true })
      .cookieExtensionNoticeAcked,
    true
  )
  // 异型丢弃(仿 clipboardWatch 的布尔守卫)
  assert.equal(
    mergeSettings(DEFAULT_APP_SETTINGS, {
      cookieExtensionNoticeAcked: 'yes'
    } as unknown as Parameters<typeof mergeSettings>[1]).cookieExtensionNoticeAcked,
    undefined
  )
})
