import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VideoResolver } from './videoResolver'
import type { YtdlpProcess, YtdlpRunOptions, YtdlpRunResult } from './ytdlpProcess'
import type { ProxyResolved, CookieConfig } from '../../shared/ipc'

const SINGLE_VIDEO_JSON = JSON.stringify({
  id: 'abc',
  title: 'A Video',
  duration: 100,
  extractor: 'youtube',
  webpage_url: 'https://youtu.be/abc',
  formats: [
    { format_id: '18', ext: 'mp4', height: 360, acodec: 'mp4a.40.2', vcodec: 'avc1', filesize: 100 }
  ]
})

const PLAYLIST_JSON = JSON.stringify({
  _type: 'playlist',
  title: 'PL',
  entries: [{ id: 'a', title: 'A', url: 'https://youtu.be/a' }]
})

/** mock 注入式 ytdlpProcess:吐预存 run 结果,可选记录调用参数 */
function mockProcess(
  result: Partial<YtdlpRunResult>,
  capture?: (path: string, args: string[], opts?: YtdlpRunOptions) => void
): YtdlpProcess {
  return {
    async run(path, args, opts) {
      capture?.(path, args, opts)
      return { exitCode: 0, stdout: '', stderr: '', ...result }
    }
  }
}

test('VideoResolver.resolve returns ResolvedVideo and uses resolve args + injected path', async () => {
  let seenPath = ''
  let seenArgs: string[] = []
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (p, a) => {
        seenPath = p
        seenArgs = a
      })
    },
    { ytdlpPath: 'C:\\bin\\yt-dlp.exe' }
  )
  const r = await resolver.resolve('https://youtu.be/abc')
  assert.equal(r.kind, 'video')
  if (r.kind === 'video') assert.equal(r.formats.length, 1)

  // 组 buildYtDlpResolveArgs + 注入的 ytdlpPath(可测接口后)
  assert.equal(seenPath, 'C:\\bin\\yt-dlp.exe')
  assert.ok(seenArgs.includes('-J'))
  assert.ok(seenArgs.includes('--flat-playlist'))
  assert.equal(seenArgs[seenArgs.length - 1], 'https://youtu.be/abc')
})

test('VideoResolver.resolve returns ResolvedPlaylist for a playlist (mock process)', async () => {
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ stdout: PLAYLIST_JSON }) },
    { ytdlpPath: 'yt-dlp' }
  )
  const r = await resolver.resolve('https://youtu.be/playlist')
  assert.equal(r.kind, 'playlist')
})

test('VideoResolver.resolve throws readable error on Unsupported URL (non-zero exit)', async () => {
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ exitCode: 1, stderr: 'ERROR: Unsupported URL: https://x' }) },
    { ytdlpPath: 'yt-dlp' }
  )
  await assert.rejects(resolver.resolve('https://x'), /暂不支持/)
})

test('VideoResolver.resolve throws readable error on login-required video', async () => {
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ exitCode: 1, stderr: 'ERROR: Sign in to confirm your age' }) },
    { ytdlpPath: 'yt-dlp' }
  )
  await assert.rejects(resolver.resolve('https://x'), /登录|会员/)
})

test('VideoResolver.resolve throws 站点改版 on invalid JSON (clean exit)', async () => {
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ exitCode: 0, stdout: 'not json at all' }) },
    { ytdlpPath: 'yt-dlp' }
  )
  await assert.rejects(resolver.resolve('https://x'), /改版|更新/)
})

test('VideoResolver.resolve throws 站点改版 when formats are empty', async () => {
  const emptyFormats = JSON.stringify({
    id: 'x',
    title: 'T',
    extractor: 'y',
    webpage_url: 'u',
    formats: []
  })
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ exitCode: 0, stdout: emptyFormats }) },
    { ytdlpPath: 'yt-dlp' }
  )
  await assert.rejects(resolver.resolve('https://x'), /改版|更新/)
})

test('VideoResolver.resolve maps killed process (exitCode null) to timeout', async () => {
  const resolver = new VideoResolver(
    { ytdlpProcess: mockProcess({ exitCode: null, stderr: '' }) },
    { ytdlpPath: 'yt-dlp' }
  )
  await assert.rejects(resolver.resolve('https://x'), /超时/)
})

// ============ 代理注入(Task 7 · spec §4.2:resolve 前实时取 effectiveUrl 传入)============

test('VideoResolver.resolve appends --proxy from injected getProxy (manual 用户值)', async () => {
  let seenArgs: string[] = []
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      }),
      getProxy: () => ({
        mode: 'manual',
        effectiveUrl: 'http://127.0.0.1:7890',
        systemDetected: null
      })
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  const i = seenArgs.indexOf('--proxy')
  assert.ok(i >= 0, '含 --proxy')
  assert.equal(seenArgs[i + 1], 'http://127.0.0.1:7890')
})

test('VideoResolver.resolve appends --proxy "" when getProxy resolves direct (null 显式关闭)', async () => {
  let seenArgs: string[] = []
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      }),
      getProxy: () => ({ mode: 'direct', effectiveUrl: null, systemDetected: null })
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  const i = seenArgs.indexOf('--proxy')
  assert.ok(i >= 0, '含 --proxy')
  assert.equal(seenArgs[i + 1], '', 'direct → --proxy 空串显式关闭(屏蔽环境 HTTP_PROXY)')
})

test('VideoResolver.resolve reads current proxy on each call (切档即时生效)', async () => {
  let seenArgs: string[] = []
  let current: ProxyResolved = { mode: 'direct', effectiveUrl: null, systemDetected: null }
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      }),
      getProxy: () => current
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  assert.equal(seenArgs[seenArgs.indexOf('--proxy') + 1], '', '初始 direct → 空串')

  // 切档:回调返回值变更 → 下一次 resolve 实时读到新值
  current = {
    mode: 'system',
    effectiveUrl: 'socks5://127.0.0.1:7891',
    systemDetected: 'socks5://127.0.0.1:7891'
  }
  await resolver.resolve('https://youtu.be/abc')
  assert.equal(
    seenArgs[seenArgs.indexOf('--proxy') + 1],
    'socks5://127.0.0.1:7891',
    '切档后下一次 resolve 读到新值'
  )
})

// ============ Cookie 注入(v0.2 Task 1 · spec §2.2 / §6.2:resolve 前实时取 CookieConfig,与 proxy 对称)============

test('VideoResolver.resolve appends cookie args from injected getCookie (browser 档)', async () => {
  let seenArgs: string[] = []
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      }),
      getCookie: () => ({ source: 'browser', browser: 'firefox', profile: null, file: null })
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  const i = seenArgs.indexOf('--cookies-from-browser')
  assert.ok(i >= 0, '含 --cookies-from-browser(需登录站连解析也注入 cookie)')
  assert.equal(seenArgs[i + 1], 'firefox')
})

test('VideoResolver.resolve without getCookie → no cookie args (零回归,与 v0.1 逐字节等价)', async () => {
  let seenArgs: string[] = []
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      })
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  assert.equal(
    seenArgs.includes('--cookies-from-browser'),
    false,
    '未注入 getCookie → 无 cookie 参数'
  )
  assert.equal(seenArgs.includes('--cookies'), false)
})

test('VideoResolver.resolve reads current cookie on each call (切档即时生效)', async () => {
  let seenArgs: string[] = []
  let current: CookieConfig = { source: 'none', browser: null, profile: null, file: null }
  const resolver = new VideoResolver(
    {
      ytdlpProcess: mockProcess({ stdout: SINGLE_VIDEO_JSON }, (_p, a) => {
        seenArgs = a
      }),
      getCookie: () => current
    },
    { ytdlpPath: 'yt-dlp' }
  )
  await resolver.resolve('https://youtu.be/abc')
  assert.equal(seenArgs.includes('--cookies-from-browser'), false, '初始 none → 无 cookie 参数')

  // 切档:回调返回值变更 → 下一次 resolve 实时读到新值
  current = { source: 'browser', browser: 'edge', profile: null, file: null }
  await resolver.resolve('https://youtu.be/abc')
  const i = seenArgs.indexOf('--cookies-from-browser')
  assert.ok(i >= 0 && seenArgs[i + 1] === 'edge', '切档后下一次 resolve 读到新 cookie 档')
})
