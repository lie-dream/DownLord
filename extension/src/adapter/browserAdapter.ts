/**
 * 浏览器适配层 — **只有接口,零实现、零 `chrome` 引用**(v0.4 Task 2 · spec §3.1)。
 *
 * 业务代码只面对本文件的接口,拿不到 `chrome` 全局 —— 于是 §5 的生命周期约定 L1
 * (「跨事件状态一律落 storage」)从「纪律」变成了「**可用的 API 就只有这一个**」。
 *
 * Task 2 只封 `storage` + `runtime`(只封真用到的)。`downloads` / `webRequest` / `cookies`
 * 由各自的功能 Task 加 —— 没有真实调用点的抽象必然设计错(spec §10.2 第 12 条)。
 *
 * v0.4 Task 3 按同一原则追加两处(Task 3 spec §5.4.2):`BrowserRuntime` 的
 * `onMessage` / `sendMessage`(popup ↔ sw 的**扩展内部**消息)与**第三块** `BrowserNet`
 * (本地通道的网络出口)。
 *
 * v0.4 Task 4 追加**第四块** `BrowserDownloads`(下载事件与取消)与 `BrowserRuntime.getUserAgent()`
 * —— 同样是「有了真实调用点才封」(Task 4 spec §2.5)。
 *
 * v0.4 Task 5 追加**第五、六块** `BrowserWebRequest`(嗅探的唯一事件源)与 `BrowserTabs`
 * (取当前标签页 / 刷新 / 关闭事件),并把存储拆成 `BrowserLocalStorage`(多一个 `onChanged`)
 * 与 `BrowserSessionStorage`(多一个 `keys()`)—— 仍是同一条原则,只封本 Task 真用到的那几支。
 *
 * v0.4 Task 6 追加**第七块** `BrowserCookies`(按 URL 取该站 cookie —— 第四档「从扩展获取」的
 * 唯一读取点)与 `BrowserTabs.queryActiveUrl()`(popup 那个按钮要交出去的页面地址)。
 * ⚠️ **后者放宽了 Task 5 立的一条边界,故在那一块的注释里显式记了一笔** —— 悄悄放宽等于那条边界废了。
 */

/** 跨事件持久状态的读写口。语义:key-value,值须可 JSON 序列化。 */
export interface BrowserStorage {
  /** 未命中返回 `undefined` —— 由类型强制调用方处理缺失(约定 L5,不给默认值糖) */
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * ★ v0.4 Task 5:落盘存储(`local`)—— 比 `BrowserStorage` 多一个变更订阅。
 *
 * 用途只有一个:sw 的**嗅探开关模块级缓存**要能被 popup 那侧的写入刷新。
 * **只报变更的 key,不报新旧值** —— 值自己回头去读,免得把浏览器的 `StorageChange` 形状漏进业务代码;
 * 也免得日后有人顺手从这里读出别的键的内容。
 */
export interface BrowserLocalStorage extends BrowserStorage {
  /** 顶层同步注册(约定 L2)。listener 内部自行 catch,不让异常逃逸到浏览器 */
  onChanged(listener: (changedKeys: string[]) => void): void
}

/**
 * ★ v0.4 Task 5:会话存储(`session`)—— **内存态、浏览器关闭即清**,嗅探结果的落点。
 *
 * ⚠️ **刻意不用 `local`**:嗅探结果落盘就违反了「关浏览器即清」(CONTEXT.md「嗅探」条)。
 * ⚠️ **绝不放开访问级别**:默认只有扩展自身可访问、不暴露给 content script
 *    (我们本来也不注入页面脚本)。**那个 API 的名字刻意不写在注释里** —— 判据是它在
 *    `extension/src/` 里 grep **零命中**,注释若照抄名字,判据就再也分不清「代码在用」与「注释在说」。
 *
 * 比 `BrowserStorage` 多的 `keys()` 只为一件事:关闭嗅探开关时清空**全部** `sniff:*` 键 ——
 * 让「关闭 = 完全不监听」在**可观察行为**上真的成立。
 */
export interface BrowserSessionStorage extends BrowserStorage {
  /** 当前全部键名 */
  keys(): Promise<string[]>
}

/** 扩展自身运行时信息与生命周期事件。 */
export interface BrowserRuntime {
  /** manifest 里的 version(构建期注入,spec §2.4) */
  getVersion(): string
  /** 本次安装的扩展 ID(`chrome-extension://<id>` 的 `<id>`) */
  getId(): string
  /** 安装 / 更新事件。reason 归一为三值,屏蔽各浏览器的额外取值 */
  onInstalled(listener: (reason: 'install' | 'update' | 'other') => void): void
  /** 浏览器启动时的 sw 冷启动事件 */
  onStartup(listener: () => void): void
  /**
   * 同一扩展内两个上下文之间的消息(popup → sw)。
   *
   * ⚠️ **不是**与 DownLord 之间的反向通道 —— v0.4 明确不做「DownLord → 扩展」的反向推送
   * (Task 3 spec §2.3 / CONTEXT.md「本地通道」)。这里两端都在浏览器里。
   *
   * listener **返回 Promise**:各浏览器的原生形态不同(Chromium 要 `return true` + 回调,
   * Firefox / polyfill 直接收 Promise),差异全折在各自的适配实现里(Task 2 spec §3.2)。
   */
  onMessage(listener: (message: unknown) => Promise<unknown>): void
  /** popup 侧发消息给 sw 并等应答 */
  sendMessage(message: unknown): Promise<unknown>
  /**
   * ★ v0.4 Task 4 新增:sw 环境的 UA(浏览器全局 `navigator` 的 `userAgent`)。
   *
   * 它**不在 `DownloadItem` 里**,故由适配层供给 —— 「浏览器环境事实的唯一读取点」
   * 因此仍只有 `chromeAdapter.ts` 一处(eslint `no-restricted-globals` 对该全局同样钉死)。
   *
   * (措辞刻意不写成带点号的取值形态 —— `grep -rn "\bnavigator\." extension/src/`
   *  只准命中适配实现那一个文件,注释若照抄取值形态,这条判据就再也分不清「代码在用」与「注释在说」。)
   */
  getUserAgent(): string
}

/** `BrowserNet.postJson` 的入参 */
export interface PostJsonInput {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
}

/** `BrowserNet.postJson` 的出参:**状态码与文本原样透传,不在这里判成败** */
export interface PostJsonResult {
  status: number
  text: string
}

/**
 * ★ v0.4 Task 3 新增的第三块:本地通道的网络出口 —— **唯一允许发 HTTP 的地方**。
 *
 * 实现(`fetchNet.ts`)是全仓唯一碰 `fetch` 全局的文件,由 eslint `no-restricted-globals` 钉死;
 * 判成败是纯函数 `classifyHandshakeResponse` 的活,故这里连「哪个状态码算成功」都不知道。
 */
export interface BrowserNet {
  postJson(input: PostJsonInput): Promise<PostJsonResult>
}

/**
 * ★ v0.4 Task 4 新增的第四块:浏览器下载事件与取消(spec §2.5)。
 *
 * 照「加一个才封一个」原则,**只封本 Task 真用到的三支** —— 不透传下载命名空间的其余 API。
 *
 * ⚠️ **`erase` 是 Phase 4 补进来的,起因是 Step 0 实测⑤ 的结论被真机推翻**(`docs/TODO.md` #52)。
 *    原注释写的是「`cancel()` 4ms、零残渣,下载项自然消失,**无需再擦一次**」——
 *    2026-08-04 在 Edge 151 上分四轮取证,`cancel` 成功的那条记录**一律残留**在下载列表里
 *    (`state: 'interrupted'` / `error: 'USER_CANCELED'`,5 组延迟组合 5/5 全中)。
 *    「零残渣」那半仍然成立(文件确实被删干净),被推翻的是「下载项自然消失」。
 */
export interface BrowserDownloads {
  /** 顶层同步注册(约定 L2)。listener 内部自行 catch,不让异常逃逸到浏览器 */
  onCreated(listener: (item: CreatedDownload) => void): void
  /** 取消一次原生下载 */
  cancel(id: number): Promise<void>
  /**
   * 抹掉**一条已被取消**的下载记录(接管成功后的观感清理)。
   *
   * ★ **名字里的 `Canceled` 不是修辞,是红线的形状保证**。实测(2026-08-04,Edge 151):
   *   - `erase` **只删记录、不删文件** —— 对一条 `complete` 记录 erase 后,
   *     `search` 返回 0 行而文件**仍在盘上**;
   *   - `cancel` 打在一个**已下完**的项目上是**静默无效**的(`lastError` 为 null、`state` 仍是
   *     `complete`、文件已落在浏览器下载目录)。
   *
   *   两条叠起来就是:**若对一条 `complete` 记录下 erase,用户会失去「浏览器那边也有一份」的唯一线索**
   *   —— 文件删不掉,记录却没了。故实现**必须**把 `state: 'interrupted'` 写进查询条件,
   *   让「已完成项」在**参数层**就落不进来;调用方连一个能误用的入口都没有。
   *   (实测 I1:同一条 query 打在 complete 记录上 → 返回 `ids: []`、记录原封不动。)
   */
  eraseCanceled(id: number): Promise<void>
}

/**
 * `DownloadItem` 里本 Task 真正用到的字段 —— **收窄到八个,不整个透传**。
 *
 * ⚠️ 刻意不含 `filename`(`onCreated` 时刻是空串,2026-08-01 实机实测③)与
 * `finalUrl`(带签名与过期时间、绑定单一镜像,实测④)—— 上报用的是 `url`。
 *
 * ★ `state` / `startTime` **不上报、只用于粗筛**:浏览器启动时会为**下载历史里的每一条记录**
 *   重放 `onCreated`(2026-08-02 真机:重启 Edge → DownLord 弹出大量确认框)。这两个字段是
 *   把历史记录与「用户此刻真的点了下载」区分开的唯一依据,故必须进这个收窄形状。
 */
export interface CreatedDownload {
  id: number
  url: string
  /** 浏览器没给时是空串 */
  referrer: string
  /** 浏览器危险度判定;`onCreated` 时刻可能尚未完成 → 尽力而为 */
  danger: string
  /** `-1` / `0` 表示未知 */
  totalBytes: number
  /** `in_progress` / `interrupted` / `complete`;**历史重放时不是 `in_progress`** */
  state: string
  /** 下载开始时刻(ISO 8601);历史重放时是过去的时间 */
  startTime: string
  /** 由别的扩展发起的下载才有 */
  byExtensionId?: string
}

/**
 * 一次响应头事件里本 Task 真正用到的字段 —— **收窄到四个,不整个透传**(Task 5 spec §2.1)。
 *
 * ⚠️ 仍然刻意**不含 `originUrl` / `requestId` / `statusCode`**:嗅探阶段的判定只看
 *    「哪个 tab」「什么地址」「响应头说它是什么」。**留在形状里的字段迟早会被 log 出来。**
 *
 * ★ **`initiator` 是 Phase 2 补进来的,且必须补**(2026-08-09):Phase 1 的注释写的是
 *   「`initiator` 要到 Phase 2 用户点了某一条时才取,那时是逐条取,不是这里整批留」——
 *   **这条打算做不到**。用户点「下载」发生在 popup 里,那时 `webRequest` 的 `details` 早已不存在;
 *   而适配层的 `BrowserTabs` **刻意读不到 tab 的 `url`**(那才是真正该守住的隐私边界)。
 *   于是「采集时不留、事后再取」在实现上等于**永远拿不到 referrer**,而 spec §4.1 的
 *   `SniffAddSelected.referrer` 明确要求它。故改为采集时随条目一起存。
 *
 *   代价被三件事框住:① 它是 **origin 级**(浏览器给的就是 origin,`https://a.example` 那种形态),
 *   ARCHITECTURE §7.6「不记 referrer 完整值」**不靠自觉而靠取值本身**;② 它随桶一起活在
 *   `storage.session`,浏览器关闭即清;③ `sniff/` 全目录一条 URL 都不 log,它同样不例外。
 */
export interface SniffedResponse {
  /** 发起请求的标签页;**`-1` = 扩展自身 / 后台请求**(含 DownLord 本地通道那些) */
  tabId: number
  url: string
  /** 发起该请求的页面**来源(origin 级)**;浏览器没给时是空串 */
  initiator: string
  /** 响应头原样(名字大小写不定,取值要大小写不敏感匹配)。浏览器没给时是空数组 */
  responseHeaders: readonly { name: string; value?: string }[]
}

/**
 * ★ v0.4 Task 5 新增的第五块:响应头观察 —— **嗅探的唯一事件源**(Task 5 spec §2.1)。
 *
 * **为什么只有 `onHeadersReceived` 这一支**:`contentType`(判定用)与 `Content-Length`
 * (1MB 门槛 + 列表显示用)**只有响应头阶段才有**。再注册一个 `onBeforeRequest` 只会让
 * 同一资源两次入列,徒增去重麻烦 —— 那是唯一解,不是取舍。
 *
 * **观察型,不是 blocking**:实现不传 `'blocking'` / `'extraHeaders'`,回调**无返回值**、
 * 不修改任何请求。(实现里确实传了 `'responseHeaders'` —— 那是**读**响应头的必需 opt-in,
 * 不带它拿到的 `responseHeaders` 恒为 `undefined`、嗅探全程零命中;它与 blocking 无关。)
 */
export interface BrowserWebRequest {
  /**
   * 顶层同步注册(约定 L2)。listener 内部自行 catch,不让异常逃逸到浏览器。
   *
   * @param filter 观察范围。嗅探传 `{ urls: ['<all_urls>'] }` —— 这个决定放在**调用点**
   *   而不是藏进实现里:它是本 Task 唯一的表外权限增长,该在 sw 里一眼看见。
   */
  onHeadersReceived(listener: (details: SniffedResponse) => void, filter: { urls: string[] }): void
}

/**
 * ★ v0.4 Task 5 新增的第六块:标签页。
 *
 * ⚠️ **只封三支,且刻意读不到 `title`** —— 嗅探侧只需要 tab 的 `id`(桶按 tabId 分)。
 * (`activeTab` / `tabs` 权限只在读 `url` / `title` 时才需要,故这几支**不构成新权限**:
 *  `Tab.url` 的可见性由「有 `tabs` 权限**或**匹配该 URL 的 host 权限」决定,而我们已有 `<all_urls>`。)
 *
 * ⚠️ **v0.4 Task 6 放宽了一处,显式记一笔**:Task 5 的原注释写的是「**刻意读不到 `url` / `title`**
 *    —— 拿不到 URL,就不可能有人顺手把它记进日志或发出去」。Task 6 的 popup 按钮
 *    「用 DownLord 下载此页视频」**必须**把页面地址交给 DownLord(没有它就没有可解析的东西),
 *    故新增 `queryActiveUrl()`。**边界从「拿不到」降级为「拿得到但只有一个调用点」** ——
 *    补偿是那条路径全程零 URL 日志(`cookies/` 目录零 log、popup 只把地址塞进上行载荷)。
 *    `title` 仍然一个字都不封:它对下载毫无用处,留着只会多一个能被记下来的东西。
 */
export interface BrowserTabs {
  /** 当前窗口的活动标签页 id;取不到(如 popup 在无标签页的窗口里打开)返回 `undefined` */
  queryActiveId(): Promise<number | undefined>
  /**
   * ★ v0.4 Task 6:当前窗口活动标签页的**地址**。
   *
   * `undefined` = **读不到**,且**只有这一个「没有」的取值**(取不到 tab / 浏览器把 `url` 抹成
   * 空串两种情形合并)。⚠️ 后者是真实且常见的:`edge://…` / 新建标签页 / 扩展商店这类页面
   * **不在 `<all_urls>` 的匹配范围内**,`Tab.url` 恒被抹掉(2026-08-17 探针 B4 实测:7 个 tab 中
   * 6 个可见,不可见的那个正是受限页)。故调用方**必须**为「读不到」留一条如实报错的分支 ——
   * 按钮恒可点 **不等于** 恒能拿到地址,**更不许装作拿到了**。
   */
  queryActiveUrl(): Promise<string | undefined>
  /**
   * **绕过缓存**刷新某个标签页。**只在用户点了「强制刷新本页」时调** —— 绝不自动 reload
   * (用户可能正在填表单)。
   *
   * ★ **名字里的 `BypassingCache` 不是修辞,是这个按钮唯一有用的形态**(2026-08-09 实测 R2):
   *   关掉标签页再打开同一 URL,采到的资源从 **4 条掉到 2 条** —— **缓存命中不触发
   *   `onHeadersReceived`**,没有响应头就没有嗅探。于是普通 `reload` 刷完照样走缓存、照样抓不到,
   *   按钮等于没有。把 `bypassCache` 焊进方法名与实现里,调用方**连一个能退化成普通刷新的入口都没有**。
   *   (与 `BrowserDownloads.eraseCanceled` 同一手法:约束写进形状,不靠调用方自觉。)
   */
  reloadBypassingCache(tabId: number): Promise<void>
  /** 标签页关闭 —— 桶的三个清理点之一。顶层同步注册(约定 L2) */
  onRemoved(listener: (tabId: number) => void): void
}

/**
 * 一条浏览器 cookie 里本 Task 真正用到的字段 —— **收窄到七个,不整个透传**。
 *
 * ⚠️ **刻意不含 `hostOnly`**:协议里 `OfferedCookie` **没有**这个字段,`domain` 的**前导点**就是它
 *    (`.example.com` = 域 cookie,`example.com` = host-only)。封进来只会让人以为「该自己算一遍」
 *    —— 而算错的失败形态是 **yt-dlp 静默不带 cookie**,按日志红线又查不到域名与值。
 *    2026-08-17 探针 B3 实测:`getAll({url})` 返回的 31 条里确实**含前导点域**,原样透传即可。
 * ⚠️ **刻意不含 `session`**:它与「`expirationDate` 缺失」同义,封两个就有两个真源。
 * ⚠️ **刻意不含 `sameSite` / `storeId` / `priority`**:Netscape 文件里没有这几列的位置。
 *    **留在形状里的字段迟早会被用上或被 log 出来。**
 */
export interface BrowserCookie {
  name: string
  value: string
  /** 浏览器给的原样(**可能带前导点**,不许在任何一层归一) */
  domain: string
  path: string
  /** unix 秒(浏览器给的是小数);**缺失 = session cookie** */
  expirationDate?: number
  secure: boolean
  httpOnly: boolean
}

/**
 * ★ v0.4 Task 6 新增的第七块:cookie 读取 —— **第四档「从扩展获取」的唯一读取点**。
 *
 * **只有一支 `getAll`,且只接受 `{ url }`**(spec §3.4 / D4)。三处刻意为之:
 *   ① **按 URL 不按域**:`{ url }` 的语义正是「**会被发往该 URL 的 cookie**」—— 父域 / path /
 *      secure 匹配交给浏览器自己算,比手写域匹配规则可靠。(退路是 `{ domain }` 查询 + 主进程侧
 *      自算匹配,**更差**;2026-08-17 探针 B3 实测通过,退路**不启用**。)
 *   ② **没有 `set` / `remove` / `onChanged`**:我们**从不写入、从不删除、从不订阅变更** ——
 *      这是安装说明里那句承诺的**形状保证**,不是自觉。想写都没有入口。
 *   ③ **没有「取全部 cookie」的形态**:`getAll` 在真实 API 里可以不带任何条件、一次拖走整个
 *      cookie 库。这里的入参**必填 `url`**,故「后台批量收集」在**编译期**就写不出来。
 */
export interface BrowserCookies {
  getAll(input: { url: string }): Promise<BrowserCookie[]>
}

export interface BrowserAdapter {
  readonly storage: BrowserLocalStorage
  readonly session: BrowserSessionStorage
  readonly runtime: BrowserRuntime
  readonly net: BrowserNet
  readonly downloads: BrowserDownloads
  readonly webRequest: BrowserWebRequest
  readonly tabs: BrowserTabs
  readonly cookies: BrowserCookies
}
