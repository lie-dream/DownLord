/**
 * 统一错误目录(单一文案来源,Task 9 spec §3.1 / §3.2;ARCHITECTURE §6.3 / §7.2)。
 *
 * 全部用户可见错误文案集中于此,作为「可读中文 + 可操作下一步」的唯一权威:
 * - 既有散落文案(`video/resolveError.ts` 的 MSG_*、`engine/rpcClient.ts` 的散串)迁入此处;
 *   原文件改为经 `mapError` 引用,**对外行为不变**(收口,非重写)。
 * - 原始 stderr / 异常栈**只进日志**(Phase 2 落盘),目录只产可读中文 + 下一步。
 *
 * 设计约束(行为保持不退化):
 * - **既有领域条目**(yt-dlp 解析 / 下载、aria2 RPC、引擎连接 / 超时 / HTTP)不带 `nextStep`,
 *   `toReadable` 输出 === 现状文案(逐字保真,零回归);唯一例外 `YTDLP_UNSUPPORTED` 按 §3.3
 *   追加「改直链下载」引导(可读字符串仅在末尾补 nextStep,关键词不变)。
 * - **补缺领域条目**(FS errno / HTTP 404 / 代理失效)带 `nextStep`,`toReadable` 拼接为
 *   「<可读中文>。下一步:<可操作下一步>」。
 */

/** 错误条目:稳定标识 + 可读中文 + 可选「可操作下一步」(spec §3.1)。 */
export interface ErrorEntry {
  /** 稳定标识(便于日志定位 / 测试断言,非用户可见)。 */
  code: string
  /** 可读中文提示(用户可见主体)。 */
  message: string
  /** 可操作下一步(可选);存在则由 `toReadable` 拼接到 message 末尾。 */
  nextStep?: string
}

/**
 * 条目 → 用户可读字符串(spec §3.1:nextStep 拼进可读消息末尾)。
 * - 有 nextStep → 「<message>。下一步:<nextStep>」
 * - 无 nextStep → 「<message>」(既有领域据此逐字保真,零回归)
 */
export function toReadable(entry: ErrorEntry): string {
  return entry.nextStep ? `${entry.message}。下一步:${entry.nextStep}` : entry.message
}

/**
 * `COOKIE_EXTENSION_NONE` 的域名占位(v0.4 Task 6 · spec §6.2 ④)。
 *
 * **导出成常量而不是让两处各写一遍字面量** —— 填充方(`video/resolveError.ts`)与被填充的条目
 * 一旦对不上,失败形态是「用户看到一句带着 `<域名>` 的错误」,而这类文案错误没有任何机器会喊。
 */
export const COOKIE_HOSTS_PLACEHOLDER = '<域名>'

/**
 * 错误目录常量表(单一来源)。
 *
 * 带运行时插值的引擎文案(RPC 各码 + 详情、HTTP 状态码)不入此静态表,
 * 由 `mapError` 的映射器以这些条目为前缀动态构造(见 `mapError.ts`)。
 */
export const ERR = {
  // ===================== aria2 引擎传输 / RPC(既有领域,行为保持)=====================
  /** fetch ECONNREFUSED / 连接失败 → 引擎未就绪(rpcClient.call 连接错误,逐字保真)。 */
  ENGINE_NOT_READY: { code: 'ENGINE_NOT_READY', message: '下载引擎未就绪或已退出' },
  /** AbortController 超时 → 引擎响应超时(rpcClient.call AbortError,逐字保真)。 */
  ENGINE_TIMEOUT: { code: 'ENGINE_TIMEOUT', message: '下载引擎响应超时，请重试' },

  /** RPC code 1(参数错误,带详情)。 */
  RPC_PARAM: { code: 'RPC_PARAM', message: '下载引擎参数错误' },
  /** RPC code 2(内部错误,带详情)。 */
  RPC_INTERNAL: { code: 'RPC_INTERNAL', message: '下载引擎内部错误' },
  /** RPC code 3(资源不足,带详情)。 */
  RPC_RESOURCE: { code: 'RPC_RESOURCE', message: '下载引擎资源不足' },
  /** RPC code 4(重复操作,带详情)。 */
  RPC_DUPLICATE: { code: 'RPC_DUPLICATE', message: '下载引擎重复操作' },
  /** JSON-RPC -32600。 */
  RPC_INVALID_REQUEST: { code: 'RPC_INVALID_REQUEST', message: '下载引擎收到无效请求' },
  /** JSON-RPC -32601。 */
  RPC_METHOD_NOT_FOUND: { code: 'RPC_METHOD_NOT_FOUND', message: '下载引擎方法不存在' },
  /** JSON-RPC -32602。 */
  RPC_INVALID_PARAMS: { code: 'RPC_INVALID_PARAMS', message: '下载引擎参数无效' },
  /** JSON-RPC -32603。 */
  RPC_INTERNAL_STD: { code: 'RPC_INTERNAL_STD', message: '下载引擎内部错误' },
  /** aria2 unauthorized(code 401)。 */
  RPC_UNAUTHORIZED: { code: 'RPC_UNAUTHORIZED', message: '下载引擎鉴权失败（secret 不匹配）' },
  /** gid 不存在(default 分支命中 not found / gid,带详情)。 */
  RPC_TASK_NOT_FOUND: { code: 'RPC_TASK_NOT_FOUND', message: '下载任务不存在' },

  // ===================== yt-dlp 解析(既有领域,行为保持)=====================
  /**
   * Unsupported URL → 暂不支持解析。§3.3:追加「改直链下载」引导(message 保留原文案,
   * 仅末尾补 nextStep;`/暂不支持/`、`/直链/` 关键词不变,既有单测零回归)。
   */
  YTDLP_UNSUPPORTED: {
    code: 'YTDLP_UNSUPPORTED',
    message: '该链接暂不支持解析(站点未适配或非视频页),可尝试作为直链下载',
    nextStep: '在添加对话框把识别切换为「直链下载」后重新添加'
  },
  /** 需登录 / 会员(v0.2 已支持 Cookie:引导导入你自己的登录态,不承诺一定可下,spec §2.5)。 */
  YTDLP_NEED_LOGIN: {
    code: 'YTDLP_NEED_LOGIN',
    message: '该视频需要登录或会员权限',
    nextStep: '可在设置 → 视频 → Cookie 来源导入你已登录的浏览器 Cookie 后重试'
  },
  /** 网络 / 代理失败(HTTP 4xx 非 404 / 无法下载网页 / DNS / 连接)。 */
  YTDLP_NETWORK: { code: 'YTDLP_NETWORK', message: '无法访问该视频页,请检查网络或代理设置' },
  /** 进程被信号杀死(超时 / 取消)。 */
  YTDLP_TIMEOUT: { code: 'YTDLP_TIMEOUT', message: '解析超时,请重试' },
  /** exit 0 却失败(JSON 解析失败 / formats 空)→ 站点改版兜底。 */
  YTDLP_SITE_CHANGED: {
    code: 'YTDLP_SITE_CHANGED',
    message: '解析失败,站点可能已改版(可尝试更新 yt-dlp)'
  },
  /**
   * 站点明确表示「这里没有可下载的媒体」(v0.4 Task 6 手测 M2 / M3 实测新增,2026-08-18)。
   *
   * 🔴 **刻意不声称原因是登录** —— 当天裸跑内置 yt-dlp(2026.06.09)实测:X 对
   * **「这条推文本来就没有视频」**与**「有视频但匿名看不到」**报的是**同一句**
   * `No video could be found in this tweet`(两条真实推文各跑一次,`exitCode` 均为 1)。
   * 两者在 stderr 里**字面不可区分**,把它当登录信号会对着一条纯文字推文说「需要登录」——
   * 那是**反向的不诚实**,用户做什么都消不掉。
   *
   * ⚠️ 它替代的是原先掉进来的 `YTDLP_SITE_CHANGED`:「站点可能已改版(可尝试更新 yt-dlp)」
   * 在这里**每个字都是假的** —— 站点没改版,yt-dlp 也不需要更新。
   */
  YTDLP_NO_MEDIA: {
    code: 'YTDLP_NO_MEDIA',
    message: '未在该页面找到可下载的视频',
    nextStep:
      '请确认该页面确实包含视频;部分站点在未登录时会把视频藏起来,表现与「本来就没有视频」完全相同'
  },
  /**
   * 同上,但**本次确实没取到该站登录态**(第四档 `missing`;`unpaired` 另走未握手提示)。
   *
   * 与 `COOKIE_EXTENSION_*` 三兄弟同一手法:**同一处境、按前置事实分成不同的码**,
   * 让主句与 nextStep 都能说得更具体。这里**仍不断言**是登录导致的 —— 只是把 DownLord 自己
   * **确实知道的那件事**(没拿到登录态)摆出来,由用户判断。
   */
  YTDLP_NO_MEDIA_NO_COOKIE: {
    code: 'YTDLP_NO_MEDIA_NO_COOKIE',
    message: `未取到 ${COOKIE_HOSTS_PLACEHOLDER} 的登录态,也没在该页面找到可下载的视频`,
    nextStep: `该页面可能本就没有视频,也可能是未登录时被站点隐藏 —— 这两种情况站点给出的信息完全相同,DownLord 无法区分。本次未取到 ${COOKIE_HOSTS_PLACEHOLDER} 的登录态;若属后者,请在浏览器中登录后用扩展重新发起一次下载`
  },
  /**
   * YouTube 要求重建会话(`The page needs to be reloaded.`,2026-08-18 真机日志补入)。
   *
   * ⚠️ **它此前掉进 `YTDLP_SITE_CHANGED`**,于是一个**公开、可正常解析**的视频被说成
   * 「站点可能已改版(可尝试更新 yt-dlp)」—— 同一条 URL 用同样参数裸跑 yt-dlp
   * (`-J` + 系统代理、**不带 cookie**)当场返回 29 条 formats,站点根本没改版。
   *
   * 🔴 **不断言原因** —— 这句话在**带登录态**和**不带登录态**两种情形下都可能出现:
   * 前者多因 YouTube 会轮换会话、而扩展给的是浏览器**正在使用中**的那一份(yt-dlp 官方
   * wiki 的 exporting-youtube-cookies 一节专门警告这件事);后者则是反自动化机制。
   * 故 nextStep **两种成因并列摆出**,不替用户选一个。
   */
  YTDLP_SESSION_RELOAD: {
    code: 'YTDLP_SESSION_RELOAD',
    message: 'YouTube 拒绝了这次请求,要求重建会话',
    nextStep:
      '常见于两种情况:① 站点的反自动化机制 —— 稍后重试通常可恢复;② 正在使用「从扩展获取」时,YouTube 会轮换登录态,而扩展给的是浏览器当前正在用的那一份,容易被判为冲突 —— 可改用「不使用」档下载公开视频'
  },

  // ===================== yt-dlp 下载(既有领域,行为保持)=====================
  /**
   * ffmpeg 后处理 / 合并失败。真 ffmpeg(8.1.2)已随 Task 9 就位,**占位文案已消解**为
   * 诚实提示(spec §3.2「真二进制就位后改为正常的『合并失败,请重试』」);不再声称「未就位」。
   */
  YTDLP_FFMPEG: {
    code: 'YTDLP_FFMPEG',
    message: '音视频合并失败',
    nextStep: '请重试,若反复失败可尝试更换清晰度或更新 yt-dlp'
  },
  /** 下载非 0 退出兜底。 */
  YTDLP_DOWNLOAD_FAILED: {
    code: 'YTDLP_DOWNLOAD_FAILED',
    message: '视频下载失败',
    nextStep:
      '常见成因有三:① 网络或代理波动 —— 可重试;② 落点目录不可写 —— 换一个保存位置;③ 该视频的形态当前版本的 yt-dlp 尚不支持(如互动 / 分支剧情视频)—— 这一类重试不会成功,需等待 yt-dlp 更新。'
  },

  // ===================== Cookie 登录(v0.2 Task 1,spec §2.5)=====================
  /**
   * `--cookies-from-browser` 读取失败(浏览器占用 / Chrome ABE 新加密 / DPAPI 权限)。
   * 诚实回退:提示改用 Firefox 或 Cookie 文件,不宣称一定可读(§2.4 / §5.3)。
   */
  COOKIE_BROWSER_FAILED: {
    code: 'COOKIE_BROWSER_FAILED',
    message: '无法读取所选浏览器的 Cookie（可能浏览器正在运行、加密方式变化或权限不足）',
    nextStep:
      '本次失败是因为读不到浏览器 Cookie。可改用 Firefox,或导出 Cookie 文件(设置 → 视频 → Cookie 来源);若该视频本就无需登录,也可把 Cookie 来源改回「不使用」。'
  },
  /** Cookie 文件不存在 / 非 Netscape 格式。 */
  COOKIE_FILE_INVALID: {
    code: 'COOKIE_FILE_INVALID',
    message: 'Cookie 文件无效或不存在（需 Netscape cookies.txt 格式）',
    nextStep: '重新从浏览器导出 Cookie 文件后在设置 → 视频中重新选择'
  },

  // ============ 第四档「从扩展获取」(v0.4 Task 6,spec §6.2 · Step 0 D6 逐字)============
  // 🔴 **刻意不复用 `YTDLP_NEED_LOGIN`**:那条的 nextStep 指向「设置 → 视频 → Cookie 来源」,
  //    而第四档下用户**已经在那儿选好了** —— 再指过去是把人往死胡同送。
  // ⚠️ 三条的**触发时机**见 `mapError.needLoginEntry`:不是「跑 yt-dlp 之前直接抛」,而是
  //    yt-dlp 真失败且命中 login 那一格时,按 DownLord 自己掌握的**前置事实**改判(spec §6.2)。
  //    v1.0 Task 3:M-018 的 no-media + unpaired 也复用未握手提示,不改变 login 判定。
  /** 第四档但通道未启用 / 本次启动尚未握手 —— 不等于从未配对,先提示恢复握手。 */
  COOKIE_EXTENSION_NOT_PAIRED: {
    code: 'COOKIE_EXTENSION_NOT_PAIRED',
    message: '本次启动尚未与浏览器扩展握手,拿不到登录态',
    nextStep:
      '若已配对过,打开一次扩展 popup 或在浏览器里重新点一次下载即可握手;若从未配对,请在 设置 → 浏览器扩展 完成配对。'
  },
  /**
   * 第四档、通道正常,但手上没有该任务需要的那些域的登录态
   * (cookie 迟到 / 扩展读取失败 / 该域本就无 cookie / 持有层已空〔重启后〕)。
   *
   * ⚠️ message 里的 `<域名>` 是**占位**,由调用方(`video/resolveError.ts`)用
   * `resolveCookieHosts` 的结果顿号连接后填。**这是域名唯一允许出现的地方 —— UI**,不入日志(D9)。
   */
  COOKIE_EXTENSION_NONE: {
    code: 'COOKIE_EXTENSION_NONE',
    message: `未取到 ${COOKIE_HOSTS_PLACEHOLDER} 的登录态`,
    nextStep: '请确认已在浏览器中登录该网站,然后回到浏览器,用扩展重新发起一次下载'
  },
  /** 第四档、cookie 真送到了,但站点仍拒绝 —— 登录态过期 / 换了账号。 */
  COOKIE_EXTENSION_STALE: {
    code: 'COOKIE_EXTENSION_STALE',
    message: '站点拒绝了所提供的登录态',
    nextStep:
      '登录态可能已过期。请在浏览器中确认仍处于登录状态后重新发起;必要时先在设置页清除已暂借的登录态'
  },

  // ===================== 网络 / HTTP(补缺,spec §3.2)=====================
  /** HTTP 403 / 付费墙 / members-only → 无访问权限。 */
  HTTP_403: {
    code: 'HTTP_403',
    message: '无访问权限(可能需要登录或会员)',
    nextStep:
      '可能需登录 / 会员:可在设置 → 视频导入浏览器 Cookie 后重试。链接可能已失效 —— 若这次下载是从浏览器点过来的,回浏览器重新点一次下载即可拿到新链接。'
  },
  /** HTTP 404 / 资源失效 → 链接可能已失效。 */
  HTTP_404: {
    code: 'HTTP_404',
    message: '链接可能已失效',
    nextStep:
      '核对链接后重新添加。链接可能已失效 —— 若这次下载是从浏览器点过来的,回浏览器重新点一次下载即可拿到新链接。'
  },
  /**
   * HTTP 429 限流。**出处**:YouTube 下载期字幕轨(2026-08-19 真机 main.log)——
   * `Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests`。
   * 此前掉进 `YTDLP_NETWORK`,把一个网络与代理都完好的场景说成「请检查网络或代理设置」。
   */
  HTTP_429: {
    code: 'HTTP_429',
    message: '站点限流(HTTP 429:请求过于频繁),与本地网络或代理无关',
    nextStep: '稍后重试即可;若限流发生在字幕轨上,也可在设置 → 视频关闭字幕后重试'
  },
  /**
   * 视频流被站点拒绝(下载期 403)。**出处**:YouTube(2026-08-19 真机 main.log
   * `unable to download video data: HTTP Error 403: Forbidden`,并经裸跑 yt-dlp 2026.07.04
   * 复现:八种 player_client 全数失败、零产物)。
   *
   * ⚠️ 文案**只摆事实、并列成因,不替用户断言原因** —— 已解析出清晰度却下不动,
   * 三种成因在用户侧无法区分,替他挑一个必然指错一部分人。
   */
  YTDLP_MEDIA_FORBIDDEN: {
    code: 'YTDLP_MEDIA_FORBIDDEN',
    message: '已解析到清晰度,但站点拒绝下载该视频流(HTTP 403),与本地网络或代理无关',
    nextStep:
      '常见成因有三:① 站点对下载新增了校验,当前 yt-dlp 版本尚未跟进;② 该视频需要登录 / 会员;③ 媒体地址已过期。可尝试导入 Cookie 或稍后重试;若持续失败,通常需等待 yt-dlp 更新'
  },
  /** HTTP 412 等站点反爬风控 → 站点拒绝访问(与本地网络无关;强风控站需登录态)。 */
  SITE_REJECTED: {
    code: 'SITE_REJECTED',
    message: '该站点拒绝了访问(可能是反爬风控 / 需要登录 / 地区限制),与本地网络无关',
    nextStep: 'B 站 / X 等强风控站可尝试在设置 → 视频导入浏览器 Cookie(你自己的登录态)后重试'
  },
  /** 代理失效(任务级失败 + 代理档非 direct)→ 可能代理未生效。 */
  PROXY_FAILED: {
    code: 'PROXY_FAILED',
    message: '无法访问,可能代理未生效',
    nextStep: '检查代理设置(设置 → 代理)'
  },

  // ===================== 文件系统 errno(补缺,spec §3.2)=====================
  /** ENOSPC → 磁盘空间不足。 */
  FS_ENOSPC: {
    code: 'FS_ENOSPC',
    message: '磁盘空间不足',
    nextStep: '清理磁盘空间或更换保存目录后重试'
  },
  /** EACCES / EPERM → 无写入权限。 */
  FS_EACCES: {
    code: 'FS_EACCES',
    message: '无写入权限',
    nextStep: '更换保存目录或以管理员身份运行后重试'
  },
  /** EBUSY → 文件被占用。 */
  FS_EBUSY: {
    code: 'FS_EBUSY',
    message: '文件被占用',
    nextStep: '关闭占用该文件的程序后重试'
  },
  /** 通用目录创建失败兜底(路径非法 / 盘符不存在等)。 */
  FS_DIR_CREATE: {
    code: 'FS_DIR_CREATE',
    message: '无法创建保存目录',
    nextStep: '检查路径是否有效或更换保存目录后重试'
  },

  // ===================== 自动更新(v0.2 Task 6,spec §6.1)=====================
  /** 无法连接 GitHub(网络 / 代理 / DNS)→ 检查网络或代理。 */
  UPDATE_NETWORK: {
    code: 'UPDATE_NETWORK',
    message: '无法连接更新服务器(GitHub)',
    nextStep: '检查网络或代理设置(设置 → 代理)后重试'
  },
  /** GitHub 未认证 API 限流(60 req/h)→ 稍后再试。 */
  UPDATE_RATE_LIMITED: {
    code: 'UPDATE_RATE_LIMITED',
    message: '更新检查过于频繁,已被 GitHub 限流',
    nextStep: '请稍后(约一小时后)再试'
  },
  /** 下载文件 SHA256 / 可执行性校验失败(不完整或被篡改)→ 保留旧版。 */
  UPDATE_VERIFY_FAILED: {
    code: 'UPDATE_VERIFY_FAILED',
    message: '更新文件校验失败(可能下载不完整或被篡改),已保留当前版本',
    nextStep: '请重试;若反复失败请检查网络 / 代理'
  },
  /** 替换失败(rename / EBUSY / EPERM)→ 保留旧版,占用则下次启动生效。 */
  UPDATE_APPLY_FAILED: {
    code: 'UPDATE_APPLY_FAILED',
    message: '更新替换失败,已保留当前可用版本',
    nextStep: '请重试;若 yt-dlp 正在使用,更新将在下次启动生效'
  },
  /** 应用本体自更新失败(electron-updater error)。 */
  UPDATE_APP_FAILED: {
    code: 'UPDATE_APP_FAILED',
    message: '应用更新失败',
    nextStep: '请重试,或到项目 Releases 页手动下载安装'
  }
} as const satisfies Record<string, ErrorEntry>
