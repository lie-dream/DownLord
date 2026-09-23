/**
 * 分领域错误映射器(纯函数,Task 9 spec §3.1 / §3.2;ARCHITECTURE §6.3 / §7.2)。
 *
 * 输入原始信息(RPC code + message / yt-dlp stderr + exitCode / FS errno / HTTP status)
 * → 输出 `errorCatalog` 的 `ErrorEntry`。全部纯函数、无副作用、可单测。
 *
 * 收口关系:
 * - `video/resolveError.ts` 的 `mapResolveError` / `mapDownloadError` 委托此处 yt-dlp 映射器;
 * - `engine/rpcClient.ts` 的 `mapRpcError` / 连接 / 超时 / HTTP 文案委托此处 aria2 映射器;
 * - `tasks/taskManager.ts` 的 `ensureDir` 失败路径委托此处 FS 映射器。
 *
 * 行为保持:既有领域(yt-dlp 解析 / 下载、aria2 RPC)的判定优先级与正则**逐字迁入**,
 * 对外可读结果不退化;新分类(FS errno / HTTP 404 / 403 / 代理失效)为明确补缺。
 */
import { ERR, toReadable, type ErrorEntry } from './errorCatalog'

// ===================== yt-dlp stderr 关键字(自 resolveError.ts 逐字迁入)=====================
const RE_UNSUPPORTED = /Unsupported URL/i
/**
 * ⚠️ `supporter[- ]only` 于 2026-08-18 据**真机日志**补入(v0.4 Task 6 手测 M2)。
 * B 站充电专属视频报的是 `This is a supporter-only video: 该视频为UP主的「充电」专属视频…`,
 * 既有的 `members[- ]only` 认不出它 —— 于是掉进「站点可能已改版」那句假话里。
 * **出处**:`%APPDATA%/DownLord/logs/main.log`,`[BiliBili] 1WBbe6jEd4` / `1DEgZ6rEce` 两条。
 * ⚠️ 只取 ASCII 段做判据:那句中文在日志里是 GBK,按字节匹配不可靠。
 */
const RE_LOGIN =
  /Sign in|Private video|members[- ]only|supporter[- ]only|This video is (private|available to)|Join this channel|requires authentication|log\s?in/i
const RE_NETWORK =
  /HTTP Error 4\d\d|Unable to download webpage|Unable to download|Failed to resolve|getaddrinfo|Connection (refused|reset|timed out)/i
/** 下载侧:ffmpeg 缺失 / 后处理失败(合并 / 音频提取需 ffmpeg)。 */
const RE_FFMPEG = /ffmpeg|ffprobe|Postprocessing|merge|Merger|ExtractAudio/i
/** 补缺:HTTP 404 从通用网络分流为「链接可能已失效」(spec §3.2)。 */
const RE_HTTP_404 = /HTTP\s*(Error\s*)?404/i
/** HTTP 412(B站等反爬风控 Precondition Failed)从通用网络分流为「站点拒绝访问」(不误导网络/代理)。 */
const RE_HTTP_412 = /HTTP\s*(Error\s*)?412/i
/**
 * HTTP 429 限流(2026-08-19 真机 YouTube 字幕轨实测,见 `ERR.HTTP_429` 的出处注释)。
 * 与 404 / 412 同类:从通用网络分流出来,**不再说「请检查网络或代理设置」**。
 */
const RE_HTTP_429 = /HTTP\s*(Error\s*)?429/i
/**
 * 下载期媒体流 403(2026-08-19 真机 YouTube 实测)。**刻意只收这一个实测到的完整形态**,
 * 不泛化成裸 `403` —— 解析期的 403 与下载期的 403 给用户的下一步不同,而泛化会把两者合成一条。
 */
const RE_MEDIA_FORBIDDEN = /unable to download video data:\s*HTTP Error 403/i
/**
 * Cookie 关键字(v0.2 Task 1 · spec §2.5):在 yt-dlp 解析 / 下载映射器**先于 `RE_LOGIN`** 命中,
 * 把 cookie 读取失败诚实分流到专门 `COOKIE_*`,绝不静默 / 不误导为网络 / 代理问题。
 * - 浏览器读取失败:占用锁 / Chrome ABE 新加密 / DPAPI 权限 / 找不到 cookie 库;
 * - 文件失败:cookies 文件不存在 / 非 Netscape 格式。
 */
const RE_COOKIE_FILE = /cookies file .*does not exist|not .*Netscape|cookie file/i
const RE_COOKIE_BROWSER =
  /could not (find|copy)|cookies database|Failed to decrypt|DPAPI|unable to open database|browser cookies|is locked/i
/**
 * 站点明确表示「这里没有可下载的媒体」(v0.4 Task 6 手测 M2 / M3 实测新增,2026-08-18)。
 *
 * ⚠️ **增长口径:按实测数据驱动,新增一条须记下出处与站点**(同 `shared/sniffMedia.ts` 的规矩)。
 *    当前唯一一条来自 2026-08-18 裸跑内置 yt-dlp 2026.06.09 对 X 的实测输出
 *    `ERROR: [twitter] <id>: No video could be found in this tweet`。
 *    **不凭印象往里加同义措辞** —— 本 Task 已因「照重建的措辞改正则」白走过一轮。
 */
const RE_NO_MEDIA = /No video could be found/i
/**
 * YouTube 要求重建会话(2026-08-18 真机日志补入)。**出处**:`main.log` 里
 * `[youtube] jyUPvA5EBbA / OhJNshwWfHo / JR2J5DRrizY: The page needs to be reloaded.` 三条,
 * 而**同一条 URL 裸跑 `-J` + 系统代理、不带 cookie 时返回 29 条 formats** —— 站点没改版。
 * 增长口径同 `RE_NO_MEDIA`:只收实测措辞。
 */
const RE_SESSION_RELOAD = /The page needs to be reloaded/i

// ===================== aria2 引擎传输 / RPC =====================

/** 条目追加运行时详情(保留原始 message 末尾,如「下载引擎参数错误:<detail>」)。 */
function withDetail(entry: ErrorEntry, detail: string): ErrorEntry {
  return { code: entry.code, message: `${entry.message}：${detail}` }
}

/**
 * aria2 JSON-RPC 错误码 → 条目(自 rpcClient.mapRpcError 的 switch 逐字迁入,顺序保真)。
 * - code 1/2/3/4:前缀条目 + 原始 message;
 * - -326xx / 401:固定条目;
 * - default:先判 not found / gid → 任务不存在;否则兜底「下载引擎错误(代码 <code>):<message>」。
 */
export function mapAria2RpcError(code: number, rawMessage: string): ErrorEntry {
  switch (code) {
    case 1:
      // aria2 的 code 1 是方法级通用失败码(不只参数错误):对已完成 / 不存在 gid 的
      // pause / remove 等返回 `GID ... is not found`(真机 2026-07-09 实测),按「任务不存在」
      // 细分,避免误导为「参数错误」。
      if (rawMessage.toLowerCase().includes('not found')) {
        return withDetail(ERR.RPC_TASK_NOT_FOUND, rawMessage)
      }
      return withDetail(ERR.RPC_PARAM, rawMessage)
    case 2:
      return withDetail(ERR.RPC_INTERNAL, rawMessage)
    case 3:
      return withDetail(ERR.RPC_RESOURCE, rawMessage)
    case 4:
      return withDetail(ERR.RPC_DUPLICATE, rawMessage)

    case -32600:
      return ERR.RPC_INVALID_REQUEST
    case -32601:
      return ERR.RPC_METHOD_NOT_FOUND
    case -32602:
      return ERR.RPC_INVALID_PARAMS
    case -32603:
      return ERR.RPC_INTERNAL_STD

    case 401:
      return ERR.RPC_UNAUTHORIZED

    default:
      if (rawMessage.toLowerCase().includes('not found') || rawMessage.includes('gid')) {
        return withDetail(ERR.RPC_TASK_NOT_FOUND, rawMessage)
      }
      return { code: 'RPC_UNKNOWN', message: `下载引擎错误（代码 ${code}）：${rawMessage}` }
  }
}

/** HTTP 非 2xx(rpcClient.call 通信异常)→ 条目(保留「HTTP <status>」插值,逐字保真)。 */
export function mapEngineHttpError(status: number): ErrorEntry {
  return { code: 'ENGINE_HTTP', message: `下载引擎通信异常（HTTP ${status}）` }
}

/**
 * aria2 **下载状态** `errorCode`(tellStatus 的 `errorCode` 字段,值域为 aria2 EXIT-STATUS 表 0–32)→
 * 友好中文(v0.3 Task 1 · 2026-07-22 真机 · spec §4.3)。**与 `mapAria2RpcError`(JSON-RPC 码)是两张不同的表**:
 * 前者是「下载为何失败」的结果码,后者是「RPC 调用本身」的错误码。
 *
 * BT 尤其需要:磁力 `errorCode=12`(相同 infoHash 已在下载)之前被**原样透传**成裸「12」显示在任务行
 * (taskManager 进度失败分支),不诚实、不可读。本函数把已知码译成中文,BT 相关码(11/12/26/27)给可操作提示;
 * 未知**纯数字**码 → 兜底「下载失败(引擎代码 N)」;**非数字**(已是可读文案,如崩溃重启失败)→ 原样透出。
 */
const ARIA2_DOWNLOAD_ERRORS: Readonly<Record<string, string>> = {
  '1': '下载失败(引擎未知错误),请重试',
  '2': '连接超时,请检查网络或代理后重试',
  '3': '资源不存在(链接可能已失效)',
  '4': '资源不存在(多次 404,链接可能已失效)',
  '5': '下载被中止(速度过慢)',
  '6': '网络错误,请检查网络或代理',
  '7': '下载未完成',
  '9': '磁盘空间不足',
  '11': '相同文件已在下载中(请勿重复添加)',
  '12': '相同内容的种子已在下载中——请勿重复添加;若为上次任务残留,先删除该任务并清理下载目录中的 .torrent/.aria2 残留后重试',
  '13': '目标文件已存在',
  '16': '无法创建或写入目标文件',
  '17': '文件读写错误',
  '18': '无法创建下载目录',
  '19': '域名解析失败,请检查网络或代理',
  '24': 'HTTP 认证失败',
  '26': '种子文件损坏或缺少元信息',
  '27': '磁力链接格式错误',
  '29': '服务器繁忙(过载),请稍后重试',
  '32': '文件校验失败(内容不完整)'
}

/** aria2 原文错误说明最大透出长度(防超长 stderr 撑破任务行;够容纳典型 TLS / 网络原文) */
const ARIA2_ERROR_MESSAGE_MAX = 200

/**
 * aria2 下载状态码 → **可操作下一步**(v0.4 Task 6 认领 backlog #63 · spec §6.3)。
 *
 * ⚠️ **刻意另开一张稀疏表,而不是把 `ARIA2_DOWNLOAD_ERRORS` 改成对象** ——
 * 那张表 20+ 条既有码此刻**一个字符都不用动**(零破坏,既有单测原样守着);
 * 也不是对 `'24'` 写特判(那会留下「为什么它特殊」的疑惑)。需要时按码补一行,并确保带原文的分支也会查表(#54 的码 22)。
 *
 * **#63 的事实**(2026-08-11 裸跑 aria2c 四档取证):401 → `errorCode` **24**,而 aria2 自己的
 * `errorMessage` 原文里**没有那个数字**(`Authorization failed.`)—— 故用户此前只看到「HTTP 认证失败」:
 * 准确,但**不可操作**。真正的答案是「这个资源要浏览器登录态」。
 *
 * ⚠️ **不断言「这是 401」**:库内只证了 401 → 24 的**单向**,反向「24 只可能由 401 触发」无实证,
 * 故措辞停在「需要登录凭据」。
 * ⚠️ **不违反「直链带 cookie 本版不做」**:**不承诺直链能带**,而是给出一条真实存在的出路。
 */
const ARIA2_ERROR_NEXT_STEPS: Readonly<Record<string, string>> = {
  '22': '链接可能已失效 —— 若这次下载是从浏览器点过来的,回浏览器重新点一次下载即可拿到新链接。',
  '24': '该链接需要登录凭据,而直链下载不携带登录态。若它来自某个视频页,请改为下载该页面(浏览器扩展 popup 的「用 DownLord 下载此页视频」)——视频通路支持登录态。'
}

/** 清洗 aria2 原文:折叠换行 / 连续空白为单空格 + trim + 截断(真机原文含 `\r\n` 与尾部错误码) */
function tidyAria2Message(message: string): string {
  // 只剥真机出现的成功状态尾巴;非零码、其它系统错误与冒号后的有效详情都保留。
  const flat = message
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/: Error: 操作成功完成。 \(0\)$/, '')
  return flat.length > ARIA2_ERROR_MESSAGE_MAX ? `${flat.slice(0, ARIA2_ERROR_MESSAGE_MAX)}…` : flat
}

export function mapAria2DownloadError(errorCode: string, errorMessage?: string): string {
  const trimmed = errorCode.trim()
  // 纯数字 = aria2 下载状态码 → 译中文(未知码兜底带原码,便于反馈);非数字 = 上游已给可读文案,原样透出
  if (/^\d+$/.test(trimmed)) {
    const known = ARIA2_DOWNLOAD_ERRORS[trimmed]
    // 真机修订 2026-07-27(spec §13):码 1(unknown)/ 未知码本就「说不清」,而 aria2 的 errorMessage 说得清
    // (如 SSL/TLS 握手失败)→ 拼原文替代「引擎未知错误,请重试」的误导(TLS/证书类失败重试必然再失败)。
    // **已知具体码文案原样不变**(既有中文已可操作,不加噪音,零回归)。
    const detail = errorMessage ? tidyAria2Message(errorMessage) : ''
    let base = known ?? `下载失败(引擎代码 ${trimmed})`
    if (detail && (trimmed === '1' || known === undefined)) {
      base = `下载失败(引擎代码 ${trimmed}):${detail}`
    }
    // #54:两支主句构造后统一查表,否则未知码 22 带原文时会提前返回,漏掉下一步。
    // #63(v0.4 Task 6):查第二张稀疏表。**已知码文案主体逐字不变**,只在命中时按
    // `errorCatalog.toReadable` 的**同一形态**追加「。下一步:…」—— 拼接规则只有那一处真源,
    // 在此重写一遍格式必然与它漂移。
    const nextStep = ARIA2_ERROR_NEXT_STEPS[trimmed]
    return nextStep ? toReadable({ code: `ARIA2_${trimmed}`, message: base, nextStep }) : base
  }
  return errorCode
}

// ===================== yt-dlp 解析 / 下载 =====================

/**
 * 第四档「从扩展获取」在**取值时刻**算出的前置事实(v0.4 Task 6 · spec §6.2)。
 *
 * - `'unpaired'` —— 通道未启用 / 从未握手过;
 * - `'missing'` —— 通道正常,但 `take(hosts)` 空、或 `written === 0`(等于没有);
 * - `'supplied'` —— 真写出了文件且 `written > 0`。
 *
 * ★ **这是 D6「报错知识来自 DownLord 自己」的载体**:三个 `COOKIE_EXTENSION_*` 码由这份事实选出,
 * **不是从 stderr 正则里猜的**。
 */
export type ExtensionCookieContext = 'supplied' | 'missing' | 'unpaired'

/**
 * 命中 login 那一格后的**改判**(v0.4 Task 6 · spec §6.2 ③)。
 *
 * 🔴 **`undefined` → 原样 `YTDLP_NEED_LOGIN`** —— 既有三档(none / browser / file)与全部既有调用点
 * 逐字节零回归,`mapError.test.ts` 的既有用例一个字都不用改。
 *
 * ⚠️ 改判**只发生在这一格**:cookie 判定(`COOKIE_FILE_INVALID` / `COOKIE_BROWSER_FAILED`)
 * **仍先于** login 判定,既有优先级链顺序一格都不动。
 */
function needLoginEntry(extCookieCtx?: ExtensionCookieContext): ErrorEntry {
  switch (extCookieCtx) {
    case 'supplied':
      // 送到了却仍被拒 → 登录态过期 / 换账号,而不是「你没登录」
      return ERR.COOKIE_EXTENSION_STALE
    case 'missing':
      return ERR.COOKIE_EXTENSION_NONE
    case 'unpaired':
      return ERR.COOKIE_EXTENSION_NOT_PAIRED
    default:
      return ERR.YTDLP_NEED_LOGIN
  }
}

/**
 * 命中「站点说没有媒体」那一格后的分支(v0.4 Task 6 手测新增)。
 *
 * `unpaired` 先直说本次尚未握手;`missing` 则摆出没取到登录态的已知事实。
 * `supplied` / 无上下文仍只说没找到媒体。**不把 no-media 猜成登录信号**。
 */
function noMediaEntry(extCookieCtx?: ExtensionCookieContext): ErrorEntry {
  if (extCookieCtx === 'unpaired') return ERR.COOKIE_EXTENSION_NOT_PAIRED
  return extCookieCtx === 'missing' ? ERR.YTDLP_NO_MEDIA_NO_COOKIE : ERR.YTDLP_NO_MEDIA
}

/** 412 按已知登录态分支;既有三档与 supplied 仍直接返回原静态条目。 */
function siteRejectedEntry(extCookieCtx?: ExtensionCookieContext): ErrorEntry {
  if (extCookieCtx === 'missing' || extCookieCtx === 'unpaired') {
    return {
      ...ERR.SITE_REJECTED,
      nextStep: '该站点需要登录态而本次没有取到。请回到浏览器,用扩展重新发起一次下载。'
    }
  }
  return ERR.SITE_REJECTED
}

/**
 * yt-dlp 解析失败 → 条目(自 resolveError.mapResolveError 逐字迁入 + 404 补缺):
 * - exitCode === null(被信号杀死:超时 / 取消)→ 超时
 * - exitCode === 0(进程成功却判失败:JSON / formats 空)→ 站点改版
 * - exitCode 非 0:按 stderr 关键字(Unsupported / 登录 / 网络);网络内 404 分流为链接失效;否则兜底站点改版
 *
 * @param extCookieCtx - 第四档前置事实(v0.4 Task 6,可选);缺省 → 行为与改动前逐字节等价。
 */
export function mapYtdlpResolveError(
  stderr: string,
  exitCode: number | null,
  extCookieCtx?: ExtensionCookieContext
): ErrorEntry {
  if (exitCode === null) {
    return ERR.YTDLP_TIMEOUT
  }
  if (exitCode === 0) {
    return ERR.YTDLP_SITE_CHANGED
  }

  const s = stderr || ''
  if (RE_UNSUPPORTED.test(s)) {
    return ERR.YTDLP_UNSUPPORTED
  }
  // Cookie 失败先于登录判定分流(v0.2 §2.5:不误导为需登录 / 网络)
  if (RE_COOKIE_FILE.test(s)) {
    return ERR.COOKIE_FILE_INVALID
  }
  if (RE_COOKIE_BROWSER.test(s)) {
    return ERR.COOKIE_BROWSER_FAILED
  }
  if (RE_LOGIN.test(s)) {
    return needLoginEntry(extCookieCtx)
  }
  // 「站点说没有媒体」——**必须排在 login 之后**:真出现登录信号时以那条为准(更确定的归因优先);
  // 排在 network 之前是因为它比「网络问题」具体得多,而两者同时出现的形态未实测到。
  if (RE_NO_MEDIA.test(s)) {
    return noMediaEntry(extCookieCtx)
  }
  // YouTube 会话重建(2026-08-18 真机):此前掉进兜底,把一个能正常解析的公开视频说成「站点已改版」
  if (RE_SESSION_RELOAD.test(s)) {
    return ERR.YTDLP_SESSION_RELOAD
  }
  if (RE_NETWORK.test(s)) {
    if (RE_HTTP_404.test(s)) return ERR.HTTP_404
    if (RE_HTTP_412.test(s)) return siteRejectedEntry(extCookieCtx)
    return ERR.YTDLP_NETWORK
  }
  return ERR.YTDLP_SITE_CHANGED
}

/**
 * yt-dlp 下载失败 → 条目(自 resolveError.mapDownloadError 逐字迁入 + 404 补缺):
 * - ffmpeg 缺失 / 后处理失败 → 合并失败(真二进制就位后消解);
 * - 复用登录 / 网络关键字;网络内 404 分流为链接失效;
 * - 其余非 0 退出 → 兜底下载失败。
 *
 * @param extCookieCtx - 第四档前置事实(v0.4 Task 6,可选);缺省 → 行为与改动前逐字节等价。
 */
export function mapYtdlpDownloadError(
  stderr: string,
  _exitCode: number | null,
  extCookieCtx?: ExtensionCookieContext
): ErrorEntry {
  const s = stderr || ''
  if (RE_FFMPEG.test(s)) {
    return ERR.YTDLP_FFMPEG
  }
  // Cookie 失败先于登录判定分流(v0.2 §2.5)
  if (RE_COOKIE_FILE.test(s)) {
    return ERR.COOKIE_FILE_INVALID
  }
  if (RE_COOKIE_BROWSER.test(s)) {
    return ERR.COOKIE_BROWSER_FAILED
  }
  if (RE_LOGIN.test(s)) {
    return needLoginEntry(extCookieCtx)
  }
  // 与解析侧对称接上。⚠️ **如实标注**:这一句在**解析期**已实测到(2026-08-18 X),
  // 在**下载期**是否会出现**未实测** —— 接上它的代价是最坏情况下这一行永不执行,
  // 而不接的代价是它真出现时掉进下载失败兜底,丢掉「该页没有媒体」这条已知事实。
  if (RE_NO_MEDIA.test(s)) {
    return noMediaEntry(extCookieCtx)
  }
  // YouTube 会话重建(2026-08-18 真机):此前掉进兜底,把一个能正常解析的公开视频说成「站点已改版」
  if (RE_SESSION_RELOAD.test(s)) {
    return ERR.YTDLP_SESSION_RELOAD
  }
  if (RE_NETWORK.test(s)) {
    if (RE_HTTP_404.test(s)) return ERR.HTTP_404
    if (RE_HTTP_412.test(s)) return siteRejectedEntry(extCookieCtx)
    // 2026-08-19 真机 YouTube:下面两条此前都掉进 YTDLP_NETWORK,把网络与代理都完好的场景
    // 说成「请检查网络或代理设置」,把用户支去查一个没坏的东西(违背 CONTEXT 的「诚实」)。
    // 媒体 403 先于 429 判:两者可能同时出现在一次 stderr 里,而「视频流下不动」比
    // 「字幕被限流」更接近用户真正卡住的那件事。
    if (RE_MEDIA_FORBIDDEN.test(s)) return ERR.YTDLP_MEDIA_FORBIDDEN
    if (RE_HTTP_429.test(s)) return ERR.HTTP_429
    return ERR.YTDLP_NETWORK
  }
  return ERR.YTDLP_DOWNLOAD_FAILED
}

// ===================== HTTP 状态码 / 代理(补缺,spec §3.2)=====================

/** HTTP 状态码 → 条目:404 链接失效 / 403 无权限 / 其余 4xx·5xx 归网络。 */
export function mapHttpError(status: number): ErrorEntry {
  if (status === 404) {
    return ERR.HTTP_404
  }
  if (status === 403) {
    return ERR.HTTP_403
  }
  return ERR.YTDLP_NETWORK
}

/** 代理失效(任务级失败 + 代理档非 direct)→ 「可能代理未生效,检查代理设置」。 */
export function mapProxyError(): ErrorEntry {
  return ERR.PROXY_FAILED
}

// ===================== 自动更新(v0.2 Task 6,spec §6.2)=====================

/** 更新错误分类(编排层显式抛出以精确映射;raw 网络 / errno 错误另经文本兜底判定)。 */
export type UpdateErrorKind = 'network' | 'rate-limited' | 'verify' | 'apply' | 'app'

/**
 * 更新领域可抛错误:编排(`ytdlpUpdater` / `appUpdater`)对「校验失败 / 替换失败 / 应用更新失败」
 * 等非原始异常显式抛此类型,`mapUpdateError` 据 `kind` 精确映射,避免脆弱的字符串猜测。
 */
export class UpdateError extends Error {
  constructor(
    public readonly kind: UpdateErrorKind,
    message?: string
  ) {
    super(message ?? kind)
    this.name = 'UpdateError'
  }
}

/** 从未知错误对象提取可匹配文本(errno code + message),供 raw 错误兜底判定。 */
function updateErrorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown }
    const code = typeof e.code === 'string' ? e.code : ''
    const message = typeof e.message === 'string' ? e.message : ''
    return `${code} ${message}`.trim()
  }
  return String(err ?? '')
}

/**
 * 更新失败(检查 / 下载 / 校验 / 替换 / 应用更新)→ 条目(spec §6.2):
 * - 显式 `UpdateError` 按 `kind` 直接映射(权威);
 * - 原始错误按文本兜底:rate limit / 403 + X-RateLimit → 限流;网络类(ECONNREFUSED / ETIMEDOUT /
 *   getaddrinfo / ENOTFOUND / ECONNRESET / proxy)→ 网络;EBUSY / EPERM / rename → 替换失败;
 *   其余归网络(检查阶段最常见失因)。
 * 原始 stderr / 栈只进日志(electron-log),不糊用户脸(§6.3)。
 */
export function mapUpdateError(err: unknown): ErrorEntry {
  if (err instanceof UpdateError) {
    switch (err.kind) {
      case 'rate-limited':
        return ERR.UPDATE_RATE_LIMITED
      case 'verify':
        return ERR.UPDATE_VERIFY_FAILED
      case 'apply':
        return ERR.UPDATE_APPLY_FAILED
      case 'app':
        return ERR.UPDATE_APP_FAILED
      case 'network':
        return ERR.UPDATE_NETWORK
    }
  }
  const raw = updateErrorText(err)
  if (/rate limit|X-RateLimit|\b403\b/i.test(raw)) {
    return ERR.UPDATE_RATE_LIMITED
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENETUNREACH|getaddrinfo|ENOTFOUND|proxy/i.test(raw)) {
    return ERR.UPDATE_NETWORK
  }
  if (/EBUSY|EPERM|\brename\b/i.test(raw)) {
    return ERR.UPDATE_APPLY_FAILED
  }
  return ERR.UPDATE_NETWORK
}

// ===================== 文件系统 errno(补缺,spec §3.2)=====================

/** 从未知错误对象提取可匹配文本(errno code + message),供 FS 关键字判定。 */
function fsErrorText(err: unknown): string {
  if (typeof err === 'string') {
    return err
  }
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown }
    const code = typeof e.code === 'string' ? e.code : ''
    const message = typeof e.message === 'string' ? e.message : ''
    return `${code} ${message}`.trim()
  }
  return String(err ?? '')
}

/**
 * 文件系统错误(目录创建 / 写盘失败)→ 条目(补缺,spec §1.3 / §3.2):
 * - ENOSPC → 磁盘空间不足
 * - EACCES / EPERM → 无写入权限
 * - EBUSY / ETXTBSY → 文件被占用
 * - 其余 → 通用目录创建失败兜底
 *
 * 接受 errno code 字符串、含 errno 的 message、或 Node `ErrnoException` 对象;原始错误进日志,不入文案。
 */
export function mapFsError(err: unknown): ErrorEntry {
  const raw = fsErrorText(err)
  if (/ENOSPC/i.test(raw)) {
    return ERR.FS_ENOSPC
  }
  if (/EACCES|EPERM/i.test(raw)) {
    return ERR.FS_EACCES
  }
  if (/EBUSY|ETXTBSY/i.test(raw)) {
    return ERR.FS_EBUSY
  }
  return ERR.FS_DIR_CREATE
}
