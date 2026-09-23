import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COOKIE_HOSTS_PLACEHOLDER, ERR, toReadable } from './errorCatalog'
import {
  mapAria2RpcError,
  mapAria2DownloadError,
  mapEngineHttpError,
  mapYtdlpResolveError,
  mapYtdlpDownloadError,
  mapHttpError,
  mapProxyError,
  mapFsError,
  mapUpdateError,
  UpdateError
} from './mapError'

// ==================== errorCatalog.toReadable(拼接规则,spec §3.1)====================

test('toReadable 无 nextStep → 仅 message(既有领域逐字保真)', () => {
  assert.equal(
    toReadable({ code: 'X', message: '下载引擎未就绪或已退出' }),
    '下载引擎未就绪或已退出'
  )
})

test('toReadable 有 nextStep → 「<message>。下一步:<nextStep>」', () => {
  const s = toReadable({ code: 'X', message: '磁盘空间不足', nextStep: '清理空间后重试' })
  assert.equal(s, '磁盘空间不足。下一步:清理空间后重试')
})

// ==================== aria2 RPC(行为保真,自 rpcClient.mapRpcError 迁入)====================

test('mapAria2RpcError code 1/2/3/4 → 前缀条目 + 保留原始 message', () => {
  assert.match(toReadable(mapAria2RpcError(1, 'Invalid argument')), /参数错误/)
  assert.match(toReadable(mapAria2RpcError(1, 'Invalid argument')), /Invalid argument/)
  assert.match(toReadable(mapAria2RpcError(2, 'boom')), /内部错误/)
  assert.match(toReadable(mapAria2RpcError(3, 'no mem')), /资源不足/)
  assert.match(toReadable(mapAria2RpcError(4, 'dup')), /重复操作/)
})

// ==================== aria2 下载状态 errorCode(v0.3 Task 1 · 2026-07-22 真机 · spec §4.3)====================

test('mapAria2DownloadError 磁力 12 → 相同 infoHash 已在下载 + 可操作提示(不再显示裸 12)', () => {
  const s = mapAria2DownloadError('12')
  assert.match(s, /相同内容的种子已在下载中/)
  assert.match(s, /删除该任务|清理/)
  assert.notEqual(s, '12')
})

test('mapAria2DownloadError 已知码译中文(2 超时 / 6 网络 / 9 磁盘 / 27 磁力格式)', () => {
  assert.match(mapAria2DownloadError('2'), /超时/)
  assert.match(mapAria2DownloadError('6'), /网络/)
  assert.match(mapAria2DownloadError('9'), /磁盘空间/)
  assert.match(mapAria2DownloadError('27'), /磁力链接格式/)
})

test('mapAria2DownloadError 未知纯数字码 → 兜底带原码(便于反馈)', () => {
  assert.equal(mapAria2DownloadError('99'), '下载失败(引擎代码 99)')
})

test('mapAria2DownloadError 非数字(上游已给可读文案)→ 原样透出(不吞)', () => {
  const msg = '下载引擎崩溃后重启失败,请稍后重试任务'
  assert.equal(mapAria2DownloadError(msg), msg)
})

test('mapAria2DownloadError 带空白的数字码 → trim 后仍命中', () => {
  assert.match(mapAria2DownloadError(' 12 '), /相同内容的种子/)
})

// ---- 真机修订 2026-07-27(Task 4 spec §13):errorCode=1 / 未知码透出 aria2 原文 ----

test('mapAria2DownloadError 码 1 + errorMessage → 透出真实原因,不再是「未知错误…请重试」(真机 2026-07-27)', () => {
  // 真机原文(aria2 tellStatus):TLS 握手失败,重试必然再失败 →「请重试」是误导
  const raw = 'SSL/TLS handshake failure: Error: 目标主要名称不正确。\r\n(80090322)'
  const s = mapAria2DownloadError('1', raw)
  assert.match(s, /SSL\/TLS handshake failure/, '含 aria2 原文')
  assert.match(s, /引擎代码 1/, '保留原码便于反馈')
  assert.doesNotMatch(s, /请重试/, '不再给出误导性「请重试」')
  assert.doesNotMatch(s, /[\r\n]/, '换行已折叠为单行')
})

test('mapAria2DownloadError 码 1 无 errorMessage → 回落原文案(逐字节零回归)', () => {
  assert.equal(mapAria2DownloadError('1'), '下载失败(引擎未知错误),请重试')
  assert.equal(mapAria2DownloadError('1', ''), '下载失败(引擎未知错误),请重试', '空原文视同无')
})

test('mapAria2DownloadError 已知具体码带 errorMessage → 文案原样不变(不加噪音,零回归)', () => {
  const raw = 'Timeout while connecting'
  assert.equal(mapAria2DownloadError('2', raw), mapAria2DownloadError('2'))
  assert.equal(mapAria2DownloadError('12', raw), mapAria2DownloadError('12'))
  assert.doesNotMatch(mapAria2DownloadError('9', raw), /Timeout/)
})

test('mapAria2DownloadError 未知码 + errorMessage → 带原码 + 原文(便于反馈)', () => {
  const s = mapAria2DownloadError('99', 'weird engine failure')
  assert.match(s, /引擎代码 99/)
  assert.match(s, /weird engine failure/)
})

test('mapAria2DownloadError 超长 errorMessage → 截断加省略号(不撑破任务行)', () => {
  const s = mapAria2DownloadError('1', 'x'.repeat(500))
  assert.ok(s.length < 260, `实际长度 ${s.length}`)
  assert.match(s, /…$/)
})

test('mapAria2DownloadError 非数字码 + errorMessage → 仍原样透出(上游文案优先,不拼接)', () => {
  const msg = '下载引擎崩溃后重启失败,请稍后重试任务'
  assert.equal(mapAria2DownloadError(msg, 'ignored'), msg)
})

test('mapAria2RpcError code 1 + not found → 任务不存在(细分,不误导为参数错误;真机 2026-07-09)', () => {
  const readable = toReadable(mapAria2RpcError(1, 'GID deadbeef is not found'))
  assert.match(readable, /任务不存在/)
  assert.match(readable, /GID deadbeef is not found/)
  assert.ok(!/参数错误/.test(readable))
})

test('mapAria2RpcError JSON-RPC 标准码 -326xx', () => {
  assert.match(toReadable(mapAria2RpcError(-32600, '')), /无效请求/)
  assert.match(toReadable(mapAria2RpcError(-32601, '')), /方法不存在/)
  assert.match(toReadable(mapAria2RpcError(-32602, '')), /参数无效/)
  assert.match(toReadable(mapAria2RpcError(-32603, '')), /内部错误/)
})

test('mapAria2RpcError 401 → 鉴权失败 + secret', () => {
  const s = toReadable(mapAria2RpcError(401, 'Unauthorized'))
  assert.match(s, /鉴权失败/)
  assert.match(s, /secret/)
})

test('mapAria2RpcError default + not found / gid → 任务不存在', () => {
  assert.match(toReadable(mapAria2RpcError(9000, 'GID abc not found')), /任务不存在/)
  assert.match(toReadable(mapAria2RpcError(9000, 'unknown gid here')), /任务不存在/)
})

test('mapAria2RpcError default 兜底 → 代码 + 原始 message', () => {
  const s = toReadable(mapAria2RpcError(9999, 'Unknown custom error'))
  assert.match(s, /代码 9999/)
  assert.match(s, /Unknown custom error/)
})

test('mapEngineHttpError 保留「HTTP <status>」插值', () => {
  assert.match(toReadable(mapEngineHttpError(404)), /HTTP 404/)
  assert.match(toReadable(mapEngineHttpError(500)), /HTTP 500/)
})

// ==================== yt-dlp 解析(行为保真 + 404 补缺)====================

test('mapYtdlpResolveError exitCode null → 超时', () => {
  assert.equal(mapYtdlpResolveError('', null).code, ERR.YTDLP_TIMEOUT.code)
})

test('mapYtdlpResolveError exitCode 0 → 站点改版', () => {
  assert.equal(mapYtdlpResolveError('', 0).code, ERR.YTDLP_SITE_CHANGED.code)
})

test('mapYtdlpResolveError Unsupported → 暂不支持 + 改直链引导(§3.3)', () => {
  const e = mapYtdlpResolveError('ERROR: Unsupported URL: https://x/foo', 1)
  assert.equal(e.code, ERR.YTDLP_UNSUPPORTED.code)
  const s = toReadable(e)
  assert.match(s, /暂不支持/)
  assert.match(s, /直链下载/)
  assert.match(s, /添加对话框/) // §3.3:引导用户在添加对话框切到直链下载
})

test('mapYtdlpResolveError 登录 / 私有 / members-only → 需登录', () => {
  assert.equal(mapYtdlpResolveError('ERROR: Sign in to confirm', 1).code, ERR.YTDLP_NEED_LOGIN.code)
  assert.equal(
    mapYtdlpResolveError('ERROR: Private video. Sign in', 1).code,
    ERR.YTDLP_NEED_LOGIN.code
  )
})

test('mapYtdlpResolveError HTTP 403(非 404)→ 网络(保持现状)', () => {
  const e = mapYtdlpResolveError('ERROR: Unable to download webpage: HTTP Error 403: Forbidden', 1)
  assert.equal(e.code, ERR.YTDLP_NETWORK.code)
})

test('mapYtdlpResolveError HTTP 404 → 链接可能已失效(补缺,从网络分流)', () => {
  const e = mapYtdlpResolveError('ERROR: Unable to download webpage: HTTP Error 404: Not Found', 1)
  assert.equal(e.code, ERR.HTTP_404.code)
  assert.match(toReadable(e), /失效/)
})

test('mapYtdlpResolveError 未知非 0 → 站点改版兜底', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: totally unexpected', 1).code,
    ERR.YTDLP_SITE_CHANGED.code
  )
})

// ==================== yt-dlp 下载(行为保真 + 404 补缺)====================

test('mapYtdlpDownloadError ffmpeg / 后处理失败 → 合并失败', () => {
  assert.equal(mapYtdlpDownloadError('ERROR: ffmpeg not found', 1).code, ERR.YTDLP_FFMPEG.code)
  assert.equal(
    mapYtdlpDownloadError('ERROR: Postprocessing: ffprobe and ffmpeg not found', 1).code,
    ERR.YTDLP_FFMPEG.code
  )
})

test('mapYtdlpDownloadError 复用登录 / 网络;404 分流失效', () => {
  assert.equal(mapYtdlpDownloadError('ERROR: Sign in', 1).code, ERR.YTDLP_NEED_LOGIN.code)
  assert.equal(
    mapYtdlpDownloadError('ERROR: Unable to download: HTTP Error 403', 1).code,
    ERR.YTDLP_NETWORK.code
  )
  assert.equal(
    mapYtdlpDownloadError('ERROR: Unable to download: HTTP Error 404', 1).code,
    ERR.HTTP_404.code
  )
})

test('mapYtdlpDownloadError 未知非 0 → 下载失败兜底', () => {
  const s = toReadable(mapYtdlpDownloadError('ERROR: weird failure', 1))
  assert.match(s, /下载失败|重试/)
})

test('mapYtdlpResolveError HTTP 412(B站反爬)→ 站点拒绝(不误导网络/代理)', () => {
  const e = mapYtdlpResolveError(
    'ERROR: [BiliBili] x: Unable to download JSON metadata: HTTP Error 412: Precondition Failed',
    1
  )
  assert.equal(e.code, ERR.SITE_REJECTED.code)
  const s = toReadable(e)
  assert.match(s, /站点拒绝/)
  assert.match(s, /与本地网络无关/)
})

test('mapYtdlpDownloadError HTTP 412 → 站点拒绝', () => {
  assert.equal(
    mapYtdlpDownloadError('ERROR: Unable to download: HTTP Error 412', 1).code,
    ERR.SITE_REJECTED.code
  )
})

// ==================== Cookie 分流(v0.2 Task 1 · spec §2.5:先于 login 命中 COOKIE_*)====================

test('mapYtdlpResolveError cookie 文件失败 → COOKIE_FILE_INVALID(先于 login)', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: cookies file does not exist', 1).code,
    ERR.COOKIE_FILE_INVALID.code
  )
  assert.equal(
    mapYtdlpResolveError('ERROR: The cookies file is not in Netscape format', 1).code,
    ERR.COOKIE_FILE_INVALID.code
  )
})

test('mapYtdlpResolveError 浏览器 cookie 读取失败 → COOKIE_BROWSER_FAILED(先于 login)', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: Failed to decrypt with DPAPI', 1).code,
    ERR.COOKIE_BROWSER_FAILED.code
  )
  assert.equal(
    mapYtdlpResolveError('ERROR: could not copy Chrome cookie database', 1).code,
    ERR.COOKIE_BROWSER_FAILED.code
  )
  // 浏览器 cookie 库被独占锁
  assert.equal(
    mapYtdlpResolveError('ERROR: unable to open database file (is locked)', 1).code,
    ERR.COOKIE_BROWSER_FAILED.code
  )
})

test('mapError cookie 关键字优先于 login:同时含 cookie + Sign in → COOKIE_*(不误判需登录)', () => {
  // 浏览器 cookie 失败常伴随后续 Sign in 提示;cookie 判定在前,分流到 COOKIE_BROWSER_FAILED
  const e = mapYtdlpResolveError('ERROR: Failed to decrypt cookies. Sign in to confirm', 1)
  assert.equal(e.code, ERR.COOKIE_BROWSER_FAILED.code)
  // 下载侧同理
  assert.equal(
    mapYtdlpDownloadError('ERROR: cookies file does not exist. Please sign in', 1).code,
    ERR.COOKIE_FILE_INVALID.code
  )
})

test('mapYtdlpDownloadError cookie 浏览器失败 → COOKIE_BROWSER_FAILED', () => {
  assert.equal(
    mapYtdlpDownloadError('ERROR: could not find firefox cookies database', 1).code,
    ERR.COOKIE_BROWSER_FAILED.code
  )
})

// ==================== 三处旧文案更新(v0.2 已支持 Cookie · spec §2.5)====================

test('YTDLP_NEED_LOGIN 文案更新:引导导入浏览器 Cookie(不再声称「不支持 Cookie」)', () => {
  const s = toReadable(ERR.YTDLP_NEED_LOGIN)
  assert.match(s, /需要登录或会员权限/)
  assert.match(s, /Cookie/)
  assert.match(s, /设置 → 视频/)
  assert.doesNotMatch(s, /不支持 Cookie/, '不再出现过时的「不支持 Cookie」文案')
})

test('SITE_REJECTED nextStep 更新:可尝试导入 Cookie(不再声称「不支持」)', () => {
  const s = toReadable(ERR.SITE_REJECTED)
  assert.match(s, /站点拒绝/)
  assert.match(s, /与本地网络无关/)
  assert.match(s, /导入浏览器 Cookie/)
  assert.doesNotMatch(s, /不支持 Cookie/)
})

test('HTTP_403 nextStep 更新:可导入 Cookie 后重试(不再声称「不支持」)', () => {
  const s = toReadable(ERR.HTTP_403)
  assert.match(s, /无访问权限/)
  assert.match(s, /导入浏览器 Cookie/)
  assert.doesNotMatch(s, /不支持 Cookie/)
})

// ==================== COOKIE_* 条目文案(诚实回退,不承诺可下)====================

test('COOKIE_BROWSER_FAILED / COOKIE_FILE_INVALID 带诚实 nextStep', () => {
  const b = toReadable(ERR.COOKIE_BROWSER_FAILED)
  assert.match(b, /无法读取所选浏览器的 Cookie/)
  assert.match(b, /Firefox|Cookie 文件/, '诚实建议改用 Firefox / 文件')
  const f = toReadable(ERR.COOKIE_FILE_INVALID)
  assert.match(f, /Cookie 文件无效或不存在/)
  assert.match(f, /Netscape/)
})

// ==================== HTTP 状态码 / 代理(补缺,spec §3.2)====================

test('mapHttpError 404 → 链接失效 + 下一步', () => {
  const s = toReadable(mapHttpError(404))
  assert.match(s, /失效/)
  assert.match(s, /核对链接/)
})

test('mapHttpError 403 → 无访问权限 + 下一步', () => {
  const s = toReadable(mapHttpError(403))
  assert.match(s, /无访问权限/)
  assert.match(s, /Cookie/)
})

test('mapHttpError 其余 4xx·5xx → 网络', () => {
  assert.equal(mapHttpError(500).code, ERR.YTDLP_NETWORK.code)
})

test('mapProxyError → 可能代理未生效 + 检查代理设置', () => {
  const s = toReadable(mapProxyError())
  assert.match(s, /代理未生效/)
  assert.match(s, /检查代理设置/)
})

// ==================== 文件系统 errno(补缺核心,spec §3.2)====================

test('mapFsError ENOSPC → 磁盘空间不足 + 下一步', () => {
  const e = mapFsError('ENOSPC: no space left on device')
  assert.equal(e.code, ERR.FS_ENOSPC.code)
  const s = toReadable(e)
  assert.match(s, /磁盘空间不足/)
  assert.match(s, /下一步/)
})

test('mapFsError EACCES / EPERM → 无写入权限', () => {
  assert.equal(mapFsError('EACCES: permission denied').code, ERR.FS_EACCES.code)
  assert.equal(mapFsError('EPERM: operation not permitted').code, ERR.FS_EACCES.code)
  assert.match(toReadable(mapFsError('EACCES: permission denied')), /无写入权限/)
})

test('mapFsError EBUSY → 文件被占用', () => {
  const s = toReadable(mapFsError('EBUSY: resource busy or locked'))
  assert.match(s, /文件被占用/)
  assert.match(s, /关闭/)
})

test('mapFsError 未知 errno → 通用目录创建失败兜底', () => {
  const e = mapFsError('ENOENT: no such file or directory')
  assert.equal(e.code, ERR.FS_DIR_CREATE.code)
  assert.match(toReadable(e), /无法创建保存目录/)
})

test('mapFsError 接受多种输入形态(string / ErrnoException 对象 / 普通 Error)', () => {
  // Node ErrnoException 风格(err.code)
  assert.equal(mapFsError({ code: 'ENOSPC' }).code, ERR.FS_ENOSPC.code)
  assert.equal(mapFsError({ code: 'EBUSY', message: 'busy' }).code, ERR.FS_EBUSY.code)
  // 普通 Error(仅 message 含 errno,如 TaskManager D6 mock)
  assert.equal(mapFsError(new Error('EACCES: permission denied (mock)')).code, ERR.FS_EACCES.code)
  // 兜底:无法识别
  assert.equal(mapFsError(undefined).code, ERR.FS_DIR_CREATE.code)
  assert.equal(mapFsError(null).code, ERR.FS_DIR_CREATE.code)
})

// ==================== 自动更新(v0.2 Task 6,spec §6.2)====================

test('mapUpdateError UpdateError.kind → 精确映射(权威)', () => {
  assert.equal(mapUpdateError(new UpdateError('rate-limited')).code, ERR.UPDATE_RATE_LIMITED.code)
  assert.equal(mapUpdateError(new UpdateError('verify')).code, ERR.UPDATE_VERIFY_FAILED.code)
  assert.equal(mapUpdateError(new UpdateError('apply')).code, ERR.UPDATE_APPLY_FAILED.code)
  assert.equal(mapUpdateError(new UpdateError('app')).code, ERR.UPDATE_APP_FAILED.code)
  assert.equal(mapUpdateError(new UpdateError('network')).code, ERR.UPDATE_NETWORK.code)
})

test('mapUpdateError 原始错误文本兜底判定', () => {
  // 限流:rate limit / 403 / X-RateLimit
  assert.equal(
    mapUpdateError(new Error('API rate limit exceeded')).code,
    ERR.UPDATE_RATE_LIMITED.code
  )
  assert.equal(mapUpdateError(new Error('HTTP 403')).code, ERR.UPDATE_RATE_LIMITED.code)
  // 网络:各类连接错误
  assert.equal(
    mapUpdateError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code,
    ERR.UPDATE_NETWORK.code
  )
  assert.equal(
    mapUpdateError(new Error('getaddrinfo ENOTFOUND api.github.com')).code,
    ERR.UPDATE_NETWORK.code
  )
  // 替换失败:EBUSY / EPERM / rename
  assert.equal(
    mapUpdateError(Object.assign(new Error('busy'), { code: 'EBUSY' })).code,
    ERR.UPDATE_APPLY_FAILED.code
  )
  // 兜底:未知 → 网络(检查阶段最常见失因)
  assert.equal(mapUpdateError(new Error('something else')).code, ERR.UPDATE_NETWORK.code)
})

test('mapUpdateError 条目文案含可读中文 + 下一步', () => {
  assert.match(toReadable(mapUpdateError(new UpdateError('verify'))), /校验失败/)
  assert.match(toReadable(mapUpdateError(new UpdateError('apply'))), /保留当前可用版本/)
})

// ============ N9:第四档前置事实改判 login 那一格(v0.4 Task 6 · spec §6.2)============
// 🔴 **既有三档零回归的落点就在这一节的第一条**:不传第三参 → 原样 YTDLP_NEED_LOGIN。
//    上方那些既有 login 用例(第 167 / 203 行附近)一个字都没改,它们本身就是零回归的证据。

test('N9 ★ 第三参 undefined → 原样 YTDLP_NEED_LOGIN(既有三档逐字节零回归)', () => {
  assert.equal(mapYtdlpResolveError('ERROR: Sign in to confirm', 1).code, ERR.YTDLP_NEED_LOGIN.code)
  assert.equal(mapYtdlpDownloadError('ERROR: Private video', 1).code, ERR.YTDLP_NEED_LOGIN.code)
  // 显式传 undefined 与不传是同一条路径(调用方写 `extCookie?.context` 时天然产 undefined)
  assert.equal(
    mapYtdlpResolveError('ERROR: Sign in to confirm', 1, undefined).code,
    ERR.YTDLP_NEED_LOGIN.code
  )
})

test('N9 supplied → COOKIE_EXTENSION_STALE(送到了却被拒 = 登录态过期,不是「你没登录」)', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: Sign in to confirm', 1, 'supplied').code,
    ERR.COOKIE_EXTENSION_STALE.code
  )
  assert.equal(
    mapYtdlpDownloadError('ERROR: Private video. Sign in', 1, 'supplied').code,
    ERR.COOKIE_EXTENSION_STALE.code
  )
})

test('N9 missing → COOKIE_EXTENSION_NONE(通道通着但手上没这个域的登录态)', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: Sign in to confirm', 1, 'missing').code,
    ERR.COOKIE_EXTENSION_NONE.code
  )
  assert.equal(
    mapYtdlpDownloadError('ERROR: members-only content', 1, 'missing').code,
    ERR.COOKIE_EXTENSION_NONE.code
  )
})

test('N9 unpaired → COOKIE_EXTENSION_NOT_PAIRED(原因在连接,不在这个站点)', () => {
  assert.equal(
    mapYtdlpResolveError('ERROR: Sign in to confirm', 1, 'unpaired').code,
    ERR.COOKIE_EXTENSION_NOT_PAIRED.code
  )
  assert.equal(
    mapYtdlpDownloadError('ERROR: Join this channel', 1, 'unpaired').code,
    ERR.COOKIE_EXTENSION_NOT_PAIRED.code
  )
})

test('N9 ★ cookie 判定仍先于 login:同时含 cookie 关键字 + Sign in → 仍走 COOKIE_*,第三参不夺权', () => {
  // 既有优先级链一格都不动(v0.2 §2.5)。若哪天有人把改判提到 cookie 判定之前,这条当场红。
  const s = 'ERROR: cookies file does not exist; Sign in to confirm you are not a bot'
  assert.equal(mapYtdlpResolveError(s, 1, 'supplied').code, ERR.COOKIE_FILE_INVALID.code)
  assert.equal(mapYtdlpDownloadError(s, 1, 'missing').code, ERR.COOKIE_FILE_INVALID.code)
  const b = 'ERROR: unable to open database file; Sign in'
  assert.equal(mapYtdlpResolveError(b, 1, 'unpaired').code, ERR.COOKIE_BROWSER_FAILED.code)
})

test('N9 ★ 改判只发生在 login 那一格:非 login 的 stderr 带上下文也不改判', () => {
  // 上下文不是「一律换码」的开关 —— 网络 / 404 / ffmpeg / 兜底各走各的(spec §6.2 ③「那一格」)
  assert.equal(
    mapYtdlpResolveError('ERROR: Unable to download webpage', 1, 'missing').code,
    ERR.YTDLP_NETWORK.code
  )
  assert.equal(
    mapYtdlpResolveError('ERROR: Unable to download: HTTP Error 404', 1, 'supplied').code,
    ERR.HTTP_404.code
  )
  assert.equal(
    mapYtdlpDownloadError('ERROR: Merger failed', 1, 'unpaired').code,
    ERR.YTDLP_FFMPEG.code
  )
  assert.equal(
    mapYtdlpResolveError('ERROR: totally unknown', 1, 'supplied').code,
    ERR.YTDLP_SITE_CHANGED.code
  )
})

test('N9 三条新码的 message / nextStep 逐字(v0.4 D6 定 · v1.0 Task 3 按 #73 改 NOT_PAIRED 两字段)', () => {
  assert.equal(ERR.COOKIE_EXTENSION_NOT_PAIRED.message, '本次启动尚未与浏览器扩展握手,拿不到登录态')
  assert.equal(
    ERR.COOKIE_EXTENSION_NOT_PAIRED.nextStep,
    '若已配对过,打开一次扩展 popup 或在浏览器里重新点一次下载即可握手;若从未配对,请在 设置 → 浏览器扩展 完成配对。'
  )
  assert.equal(ERR.COOKIE_EXTENSION_NONE.message, '未取到 <域名> 的登录态')
  assert.equal(
    ERR.COOKIE_EXTENSION_NONE.nextStep,
    '请确认已在浏览器中登录该网站,然后回到浏览器,用扩展重新发起一次下载'
  )
  assert.equal(ERR.COOKIE_EXTENSION_STALE.message, '站点拒绝了所提供的登录态')
  assert.equal(
    ERR.COOKIE_EXTENSION_STALE.nextStep,
    '登录态可能已过期。请在浏览器中确认仍处于登录状态后重新发起;必要时先在设置页清除已暂借的登录态'
  )
})

test('N9 ★ 三条新码都不复用 YTDLP_NEED_LOGIN 的死胡同 nextStep(设置 → 视频 → Cookie 来源)', () => {
  // D6 的核心之一:第四档下用户**已经在那儿选好了**,再指过去是把人往死胡同送
  for (const entry of [
    ERR.COOKIE_EXTENSION_NOT_PAIRED,
    ERR.COOKIE_EXTENSION_NONE,
    ERR.COOKIE_EXTENSION_STALE
  ]) {
    assert.doesNotMatch(toReadable(entry), /设置 → 视频/)
  }
  // 正向对照:被替代的那条**确实**指向那里(证明上面的 pattern 与路径都没写错)
  assert.match(toReadable(ERR.YTDLP_NEED_LOGIN), /设置 → 视频/)
})

// ============ N10:#63 —— '24' 的 nextStep 稀疏表(v0.4 Task 6 · spec §6.3)============

test("N10 ★ '24' → 「HTTP 认证失败」主体逐字不变 + 追加可操作下一步(backlog #63)", () => {
  const s = mapAria2DownloadError('24')
  assert.equal(
    s,
    'HTTP 认证失败。下一步:该链接需要登录凭据,而直链下载不携带登录态。若它来自某个视频页,请改为下载该页面(浏览器扩展 popup 的「用 DownLord 下载此页视频」)——视频通路支持登录态。'
  )
  // 拼接形态与 errorCatalog.toReadable 同源(「<message>。下一步:<nextStep>」)
  assert.ok(s.startsWith('HTTP 认证失败。下一步:'))
  // ⚠️ 措辞停在「需要登录凭据」:库内只证了 401→24 的单向,反向无实证,故不断言「这是 401」
  assert.doesNotMatch(s, /401/)
})

test("N10 '24' 带 errorMessage 时仍是同一句(已知具体码不拼原文,零回归)", () => {
  // 真机取证:aria2 对 401 给的 errorMessage 是 `Authorization failed.`,原文里没有 24 这个数字
  assert.equal(mapAria2DownloadError('24', 'Authorization failed.'), mapAria2DownloadError('24'))
})

test('N10 ★ 其余已知码文案主体逐字不变、且**不带**下一步(稀疏表只填了一条)', () => {
  assert.equal(mapAria2DownloadError('2'), '连接超时,请检查网络或代理后重试')
  assert.equal(mapAria2DownloadError('3'), '资源不存在(链接可能已失效)')
  assert.equal(mapAria2DownloadError('9'), '磁盘空间不足')
  assert.equal(mapAria2DownloadError('13'), '目标文件已存在')
  assert.equal(mapAria2DownloadError('19'), '域名解析失败,请检查网络或代理')
  assert.equal(mapAria2DownloadError('27'), '磁力链接格式错误')
  assert.equal(mapAria2DownloadError('32'), '文件校验失败(内容不完整)')
  for (const code of ['2', '3', '9', '13', '19', '27', '32']) {
    assert.doesNotMatch(mapAria2DownloadError(code), /下一步/, `码 ${code} 不该被稀疏表波及`)
  }
})

test('N10 未知码 / 码 1 / 非数字码的兜底一律不变(稀疏表不命中即完全不参与)', () => {
  assert.equal(mapAria2DownloadError('99'), '下载失败(引擎代码 99)')
  assert.equal(mapAria2DownloadError('1'), '下载失败(引擎未知错误),请重试')
  assert.equal(
    mapAria2DownloadError('1', 'SSL/TLS handshake failure'),
    '下载失败(引擎代码 1):SSL/TLS handshake failure'
  )
  assert.equal(mapAria2DownloadError('99', 'boom'), '下载失败(引擎代码 99):boom')
  assert.equal(mapAria2DownloadError('引擎崩溃后重启失败'), '引擎崩溃后重启失败')
})

test("N10 带空白的 '24' → trim 后仍命中稀疏表", () => {
  assert.equal(mapAria2DownloadError('  24 '), mapAria2DownloadError('24'))
})

// ============ v0.4 Task 6 手测 M2 / M3 补:站点「静默降级」不报登录错 ============
// ⚠️ 下面这条 stderr 是 **2026-08-18 裸跑内置 yt-dlp 2026.06.09 对 X 的真实输出**,
//    不是重建的措辞 —— 本 Task 曾按重建的 `logged in` 措辞推过一版修法,被真值当场否决。
//    把真值钉成回归测试:老洞复发(有人收窄 RE_NO_MEDIA / 调乱优先级)就必红。

/** X 匿名访问时的真实 stderr(`exitCode` 实测为 1) */
const X_NO_MEDIA = 'ERROR: [twitter] 2076223974393127137: No video could be found in this tweet'

test('★ M2 真值:X 匿名 stderr 不再掉进「站点可能已改版」', () => {
  const e = mapYtdlpResolveError(X_NO_MEDIA, 1)
  assert.equal(e.code, 'YTDLP_NO_MEDIA')
  assert.equal(e.message, '未在该页面找到可下载的视频')
  // 反面:原先掉进去的那个码不该再出现
  assert.notEqual(e.code, ERR.YTDLP_SITE_CHANGED.code)
})

test('★ M2 真值 + 第四档 missing / unpaired → nextStep 摆出「没取到登录态」这个已知事实', () => {
  for (const ctx of ['missing'] as const) {
    const e = mapYtdlpResolveError(X_NO_MEDIA, 1, ctx)
    assert.equal(e.code, 'YTDLP_NO_MEDIA_NO_COOKIE')
    assert.ok(e.nextStep?.includes('未取到'), `${ctx}:应摆出未取到登录态这个事实`)
    // 🔴 仍**不断言**原因是登录 —— 两种情况站点给的信息相同,必须如实说无法区分
    assert.ok(e.nextStep?.includes('无法区分'), `${ctx}:不得断言原因,必须如实说分不清`)
  }
  const unpaired = mapYtdlpResolveError(X_NO_MEDIA, 1, 'unpaired')
  assert.equal(unpaired.code, 'COOKIE_EXTENSION_NOT_PAIRED')
})

test('★ supplied / 无上下文 → 不提登录态(我们确实送到了,或压根没在用第四档)', () => {
  for (const ctx of ['supplied', undefined] as const) {
    const e = mapYtdlpResolveError(X_NO_MEDIA, 1, ctx)
    assert.equal(e.code, 'YTDLP_NO_MEDIA')
    assert.equal(e.nextStep?.includes('未取到'), false)
  }
})

test('★ 优先级:真出现登录信号时以登录那格为准,不被 no-media 抢走', () => {
  // 同时含两种信号 → 更确定的归因(登录)优先
  const both = `${X_NO_MEDIA}\nERROR: Join this channel to get access to members-only content`
  assert.equal(mapYtdlpResolveError(both, 1, 'missing').code, 'COOKIE_EXTENSION_NONE')
  // 正向对照:去掉登录信号就回到 no-media(证明上一行不是恒真)
  assert.equal(mapYtdlpResolveError(X_NO_MEDIA, 1, 'missing').code, 'YTDLP_NO_MEDIA_NO_COOKIE')
})

test('★ 下载侧对称接上(该句下载期是否出现未实测,接上只为不掉进兜底误导)', () => {
  assert.equal(mapYtdlpDownloadError(X_NO_MEDIA, 1).code, 'YTDLP_NO_MEDIA')
  assert.equal(mapYtdlpDownloadError(X_NO_MEDIA, 1, 'missing').code, 'YTDLP_NO_MEDIA_NO_COOKIE')
})

test('★ 措辞诚实:两个 no-media 码都不得出现「站点可能已改版 / 更新 yt-dlp / 需要登录」', () => {
  for (const entry of [ERR.YTDLP_NO_MEDIA, ERR.YTDLP_NO_MEDIA_NO_COOKIE]) {
    const text = toReadable(entry)
    for (const forbidden of ['已改版', '更新 yt-dlp', '需要登录', '请重试']) {
      assert.equal(text.includes(forbidden), false, `${entry.code} 不得出现「${forbidden}」`)
    }
  }
  // 正向对照:这四个词确实是「能被查出来」的 —— 原先掉进去的那个码就带着其中两个
  const old = toReadable(ERR.YTDLP_SITE_CHANGED)
  assert.ok(old.includes('已改版') && old.includes('更新 yt-dlp'))
})

// ====== v0.4 Task 6 手测收尾:真机日志驱动的两条补漏(2026-08-18)======
// ⚠️ 下面两条 stderr 全部**逐字取自** `%APPDATA%/DownLord/logs/main.log`,不是重建措辞。
//    本 Task 已因「照重建的措辞改正则」白走一轮,此后只收实测值。

/** B 站充电专属视频(真机 `[BiliBili] 1WBbe6jEd4` / `1DEgZ6rEce`;中文段在日志里是 GBK,故只取 ASCII) */
const BILI_SUPPORTER =
  'ERROR: [BiliBili] 1WBbe6jEd4: This is a supporter-only video: (GBK 中文段). Use --cookies-from-browser or --cookies for the authentication.'
/** YouTube 会话重建(真机 `[youtube] jyUPvA5EBbA` / `OhJNshwWfHo` / `JR2J5DRrizY` 三条) */
const YT_RELOAD = 'ERROR: [youtube] jyUPvA5EBbA: The page needs to be reloaded.'

test('★ 真机:B 站充电专属 supporter-only 归登录类,不再是「站点可能已改版」', () => {
  assert.equal(mapYtdlpResolveError(BILI_SUPPORTER, 1).code, 'YTDLP_NEED_LOGIN')
  assert.notEqual(mapYtdlpResolveError(BILI_SUPPORTER, 1).code, ERR.YTDLP_SITE_CHANGED.code)
  // 第四档三态各自改判(M2 在 B 站上就是靠这条测得通)
  assert.equal(mapYtdlpResolveError(BILI_SUPPORTER, 1, 'missing').code, 'COOKIE_EXTENSION_NONE')
  assert.equal(
    mapYtdlpResolveError(BILI_SUPPORTER, 1, 'unpaired').code,
    'COOKIE_EXTENSION_NOT_PAIRED'
  )
  assert.equal(mapYtdlpResolveError(BILI_SUPPORTER, 1, 'supplied').code, 'COOKIE_EXTENSION_STALE')
})

test('★ 真机:members-only 老措辞不受影响(正向对照,证明上一条不是把闸拆了)', () => {
  const members = 'ERROR: [youtube] abc: Join this channel to get access to members-only content'
  assert.equal(mapYtdlpResolveError(members, 1).code, 'YTDLP_NEED_LOGIN')
  // 反面:一句既不含 supporter-only 也不含任何登录词的,仍该落兜底
  assert.equal(
    mapYtdlpResolveError('ERROR: something entirely unrelated', 1).code,
    'YTDLP_SITE_CHANGED'
  )
})

test('★ 真机:YouTube「The page needs to be reloaded」不再伪装成站点改版', () => {
  const e = mapYtdlpResolveError(YT_RELOAD, 1)
  assert.equal(e.code, 'YTDLP_SESSION_RELOAD')
  assert.notEqual(e.code, ERR.YTDLP_SITE_CHANGED.code)
  // 措辞诚实:站点没改版,也不该叫用户去更新 yt-dlp
  const text = toReadable(e)
  for (const forbidden of ['已改版', '更新 yt-dlp']) {
    assert.equal(text.includes(forbidden), false, `不得出现「${forbidden}」`)
  }
  // 两种成因必须并列摆出,不替用户选一个
  assert.ok(text.includes('反自动化'))
  assert.ok(text.includes('从扩展获取'))
})

test('★ 真机:会话重建与档位无关(不因第四档就改口,我们并不知道是不是 cookie 导致的)', () => {
  for (const ctx of ['missing', 'unpaired', 'supplied', undefined] as const) {
    assert.equal(mapYtdlpResolveError(YT_RELOAD, 1, ctx).code, 'YTDLP_SESSION_RELOAD')
  }
  // 下载侧同样接上
  assert.equal(mapYtdlpDownloadError(YT_RELOAD, 1).code, 'YTDLP_SESSION_RELOAD')
})

test('★ 真机:日志里其余四类措辞的归属(回归基线,防以后被改乱)', () => {
  const CASES: [string, string][] = [
    [
      'ERROR: [BiliBili] 1SH7q6eEK8: Unable to download JSON metadata: HTTP Error 412: Precondition Failed',
      'SITE_REJECTED'
    ],
    [
      'ERROR: [generic] Unable to download webpage: EOF occurred in violation of protocol (_ssl.c:1007)',
      'YTDLP_NETWORK'
    ],
    [
      "ERROR: [youtube] abc: Unable to download API page: ('Connection aborted.', ConnectionResetError(10054))",
      'YTDLP_NETWORK'
    ],
    [
      "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video.",
      'YTDLP_NEED_LOGIN'
    ]
  ]
  for (const [stderr, code] of CASES) {
    assert.equal(mapYtdlpResolveError(stderr, 1).code, code, stderr.slice(0, 48))
  }
})

// ── v0.4 Task 6 Step 5b:YouTube 下载失败的两条真机 stderr(2026-08-19)────────────────
//
// 增长口径同 X_NO_MEDIA / BILI_SUPPORTER / YT_RELOAD:**只收实测到的字符串,并记下出处与站点**。
// 出处:%APPDATA%/DownLord/logs/main.log,`url=https://www.youtube.com/watch?v=1WEAJ-DFkHE`
// 三条 `[VideoEngine] 下载失败 … exitCode=1`(11:11:05 / 11:12:57 / 11:27:54)。

/** 真机原文(11:11:05 与 11:27:54 两条逐字相同):字幕轨被限流 */
const YT_SUB_429 =
  "ERROR: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests"
/** 真机原文(11:12:57):媒体流被拒。裸跑 yt-dlp 2026.07.04 八种 player_client 全数复现 */
const YT_MEDIA_403 = 'ERROR: unable to download video data: HTTP Error 403: Forbidden'

test('S5b 字幕轨 429 → HTTP_429,不再说「请检查网络或代理设置」(真机 2026-08-19 YouTube)', () => {
  const e = mapYtdlpDownloadError(YT_SUB_429, 1)
  assert.equal(e.code, 'HTTP_429')
  assert.notEqual(e.code, 'YTDLP_NETWORK', '★ 网络与代理都是好的,支用户去查它就是在说假话')
  assert.match(e.message, /与本地网络或代理无关/)
})

test('S5b 媒体流 403 → YTDLP_MEDIA_FORBIDDEN,并列成因、不替用户断言(真机 2026-08-19 YouTube)', () => {
  const e = mapYtdlpDownloadError(YT_MEDIA_403, 1)
  assert.equal(e.code, 'YTDLP_MEDIA_FORBIDDEN')
  assert.notEqual(e.code, 'YTDLP_NETWORK')
  assert.match(e.message, /与本地网络或代理无关/)
  assert.match(e.nextStep ?? '', /常见成因有三/, '摆事实、并列成因,不替用户挑一个')
})

test('S5b 两条同时出现 → 媒体 403 优先(「视频流下不动」比「字幕被限流」更接近用户卡住的那件事)', () => {
  assert.equal(mapYtdlpDownloadError(`${YT_SUB_429}\n${YT_MEDIA_403}`, 1).code, 'YTDLP_MEDIA_FORBIDDEN')
})

test('S5b 只收实测形态:不把裸 403 泛化(解析期 403 与下载期 403 的下一步不同)', () => {
  // 「无法下载视频数据」那句缺席时,不得命中 YTDLP_MEDIA_FORBIDDEN
  assert.notEqual(mapYtdlpDownloadError('ERROR: HTTP Error 403: Forbidden', 1).code, 'YTDLP_MEDIA_FORBIDDEN')
})

test('S5b 零回归:404 / 412 / 通用网络三条既有分流不受新增两条影响', () => {
  assert.equal(mapYtdlpDownloadError('ERROR: HTTP Error 404: Not Found', 1).code, 'HTTP_404')
  assert.equal(mapYtdlpDownloadError('ERROR: HTTP Error 412: Precondition Failed', 1).code, 'SITE_REJECTED')
  assert.equal(mapYtdlpDownloadError('ERROR: Unable to download webpage', 1).code, 'YTDLP_NETWORK')
})

// ============ v1.0 Task 3 · P1:错误链整堆改动与零回归对照 ============

test('M-004/M-016 nextStep 逐字:读 Cookie 失败给真实退路,不自动降级', () => {
  assert.equal(
    ERR.COOKIE_BROWSER_FAILED.message,
    '无法读取所选浏览器的 Cookie（可能浏览器正在运行、加密方式变化或权限不足）'
  )
  assert.equal(
    ERR.COOKIE_BROWSER_FAILED.nextStep,
    '本次失败是因为读不到浏览器 Cookie。可改用 Firefox,或导出 Cookie 文件(设置 → 视频 → Cookie 来源);若该视频本就无需登录,也可把 Cookie 来源改回「不使用」。'
  )
  assert.doesNotMatch(toReadable(ERR.COOKIE_BROWSER_FAILED), /请关闭.*浏览器/)
})

test('M-006/#72 兜底不再无条件说「请重试」', () => {
  const expected = {
    code: 'YTDLP_DOWNLOAD_FAILED',
    message: '视频下载失败',
    nextStep:
      '常见成因有三:① 网络或代理波动 —— 可重试;② 落点目录不可写 —— 换一个保存位置;③ 该视频的形态当前版本的 yt-dlp 尚不支持(如互动 / 分支剧情视频)—— 这一类重试不会成功,需等待 yt-dlp 更新。'
  }
  assert.deepEqual(ERR.YTDLP_DOWNLOAD_FAILED, expected)
  for (const stderr of ['', 'ERROR: totally unknown']) {
    const entry = mapYtdlpDownloadError(stderr, 1)
    assert.deepEqual(entry, expected)
    assert.doesNotMatch(toReadable(entry), /请重试/)
  }
})

test('M-019 真因进主句:missing 与普通 no-media 区分,下一步仍不猜原因', () => {
  assert.equal(
    ERR.YTDLP_NO_MEDIA_NO_COOKIE.message,
    '未取到 <域名> 的登录态,也没在该页面找到可下载的视频'
  )
  assert.ok(ERR.YTDLP_NO_MEDIA_NO_COOKIE.message.includes(COOKIE_HOSTS_PLACEHOLDER))
  assert.notEqual(ERR.YTDLP_NO_MEDIA_NO_COOKIE.message, ERR.YTDLP_NO_MEDIA.message)
  assert.equal(
    ERR.YTDLP_NO_MEDIA_NO_COOKIE.nextStep,
    '该页面可能本就没有视频,也可能是未登录时被站点隐藏 —— 这两种情况站点给出的信息完全相同,DownLord 无法区分。本次未取到 <域名> 的登录态;若属后者,请在浏览器中登录后用扩展重新发起一次下载'
  )
})

test('M-018 no-media + unpaired 在解析与下载两侧均直说本次尚未握手', () => {
  for (const map of [mapYtdlpResolveError, mapYtdlpDownloadError]) {
    const entry = map(X_NO_MEDIA, 1, 'unpaired')
    assert.equal(entry.code, 'COOKIE_EXTENSION_NOT_PAIRED')
    assert.strictEqual(entry, ERR.COOKIE_EXTENSION_NOT_PAIRED)
  }
})

test('#74-a 412 接 extCookieCtx:missing / unpaired 回浏览器,不回 Cookie 来源设置', () => {
  for (const map of [mapYtdlpResolveError, mapYtdlpDownloadError]) {
    for (const ctx of ['missing', 'unpaired'] as const) {
      const entry = map('ERROR: Unable to download webpage: HTTP Error 412', 1, ctx)
      assert.equal(entry.code, 'SITE_REJECTED')
      assert.equal(entry.message, ERR.SITE_REJECTED.message)
      assert.equal(
        entry.nextStep,
        '该站点需要登录态而本次没有取到。请回到浏览器,用扩展重新发起一次下载。'
      )
      assert.doesNotMatch(toReadable(entry), /设置 → 视频/)
    }
  }
})

test('#74-a 正向对照:412 + undefined / supplied 恒等于原静态条目与独立旧值', () => {
  const original = {
    code: 'SITE_REJECTED',
    message: '该站点拒绝了访问(可能是反爬风控 / 需要登录 / 地区限制),与本地网络无关',
    nextStep: 'B 站 / X 等强风控站可尝试在设置 → 视频导入浏览器 Cookie(你自己的登录态)后重试'
  }
  for (const map of [mapYtdlpResolveError, mapYtdlpDownloadError]) {
    for (const ctx of [undefined, 'supplied'] as const) {
      const entry = map('ERROR: Unable to download webpage: HTTP Error 412', 1, ctx)
      assert.strictEqual(entry, ERR.SITE_REJECTED)
      assert.deepEqual(entry, original)
    }
  }
})

test('#54 三处都给出「回浏览器重新点一次」:403 / 404 保留旧句,22 带原文仍追加', () => {
  const nextStep =
    '链接可能已失效 —— 若这次下载是从浏览器点过来的,回浏览器重新点一次下载即可拿到新链接。'
  assert.deepEqual(mapHttpError(403), {
    code: 'HTTP_403',
    message: '无访问权限(可能需要登录或会员)',
    nextStep: '可能需登录 / 会员:可在设置 → 视频导入浏览器 Cookie 后重试。' + nextStep
  })
  assert.deepEqual(mapHttpError(404), {
    code: 'HTTP_404',
    message: '链接可能已失效',
    nextStep: '核对链接后重新添加。' + nextStep
  })
  assert.equal(
    mapAria2DownloadError('22', 'status=403'),
    '下载失败(引擎代码 22):status=403。下一步:' + nextStep
  )
  assert.equal(mapAria2DownloadError('22'), '下载失败(引擎代码 22)。下一步:' + nextStep)
  assert.equal(
    mapAria2DownloadError(' 22 ', 'status=403'),
    mapAria2DownloadError('22', 'status=403')
  )
})

test('#54 正向对照:未登记码 99 带 boom 仍逐字原样,不追加下一步', () => {
  assert.equal(mapAria2DownloadError('99', 'boom'), '下载失败(引擎代码 99):boom')
})

test('M-027 剥掉无信息系统码尾巴:保留真实 TLS 原因与码 1 主句', () => {
  // 真机尾巴是成功状态噪音,不是导致 TLS 失败的原因。
  for (const raw of [
    'SSL/TLS handshake failure: Error: 操作成功完成。 (0)',
    '  SSL/TLS handshake failure: Error: 操作成功完成。\r\n(0)  '
  ]) {
    const actual = mapAria2DownloadError('1', raw)
    assert.equal(actual, '下载失败(引擎代码 1):SSL/TLS handshake failure')
    assert.doesNotMatch(actual, /操作成功完成|\(0\)$/)
  }
})

test('M-027 正向对照:有意义的系统错误、非零码及非尾部内容逐字保留', () => {
  for (const raw of [
    'SSL/TLS handshake failure: Error: 目标主要名称不正确。 (80090322)',
    'SSL/TLS handshake failure: Error: 操作成功完成。 (5)',
    'SSL/TLS handshake failure: Error: 操作成功完成。 (0): certificate detail'
  ]) {
    assert.equal(mapAria2DownloadError('1', raw), '下载失败(引擎代码 1):' + raw)
  }
})

test('I-6 混合信号:两侧 login 先于 no-media,no-media 先于 network', () => {
  const noMediaAndNetwork = X_NO_MEDIA + '\nERROR: Unable to download webpage'
  const allSignals = noMediaAndNetwork + '\nERROR: Sign in to confirm'
  for (const map of [mapYtdlpResolveError, mapYtdlpDownloadError]) {
    for (const [ctx, loginCode, noMediaCode] of [
      ['missing', 'COOKIE_EXTENSION_NONE', 'YTDLP_NO_MEDIA_NO_COOKIE'],
      ['supplied', 'COOKIE_EXTENSION_STALE', 'YTDLP_NO_MEDIA'],
      [undefined, 'YTDLP_NEED_LOGIN', 'YTDLP_NO_MEDIA']
    ] as const) {
      assert.equal(map(allSignals, 1, ctx).code, loginCode)
      assert.equal(map(noMediaAndNetwork, 1, ctx).code, noMediaCode)
    }
  }
})

test('#72 真机格式不可用信号仍归诚实兜底,不猜互动视频专码', () => {
  // 2026-09-07 main.log 的真实措辞,仅视频 / 分支 ID 脱敏;第二条去掉站点前缀作对照。
  const detail =
    'Requested format is not available. Use --list-formats for a list of available formats'
  for (const stderr of ['ERROR: [BiliBili] <video>_<branch>: ' + detail, 'ERROR: ' + detail]) {
    for (const ctx of [undefined, 'missing', 'unpaired', 'supplied'] as const) {
      const entry = mapYtdlpDownloadError(stderr, 1, ctx)
      assert.equal(entry.code, 'YTDLP_DOWNLOAD_FAILED')
      assert.strictEqual(entry, ERR.YTDLP_DOWNLOAD_FAILED)
    }
  }
})
