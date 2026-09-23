/**
 * chrome 实现 — **全仓唯一允许出现 `chrome.*` 的文件**(v0.4 Task 2 · spec §3.1 / §3.4);
 * v0.4 Task 4 起同样是**唯一允许读 `navigator` 的文件**(Task 4 spec §2.5)。
 *
 * 该约束由 Step 3 的 eslint `no-restricted-globals` 对 `extension/src/**` 生效、并对本文件单独开例外
 * —— 越界就 lint 红,不靠自觉。它也是「v0.5 加 Firefox = 代码层只改适配层」这个论证的支点:
 * 判据可核验(`grep -rn "\bchrome\." extension/src/` 只命中本文件)。
 *
 * `createDefaultAdapter()` 是零参工厂:装配点(`sw/index.ts` / `popup/main.ts`)只调它,
 * 于是连「装配时读一次 chrome 全局」也被收进本文件,`chrome` 字面真的只剩这一处。
 */
import type {
  BrowserAdapter,
  BrowserCookie,
  BrowserCookies,
  BrowserDownloads,
  BrowserLocalStorage,
  BrowserNet,
  BrowserRuntime,
  BrowserSessionStorage,
  BrowserTabs,
  BrowserWebRequest,
  CreatedDownload,
  SniffedResponse
} from './browserAdapter'
import { createDefaultFetchNet } from './fetchNet'

/** 归一后的安装 / 更新原因 —— 屏蔽各浏览器的额外取值(如 Chromium 的 `chrome_update`) */
type InstallReason = 'install' | 'update' | 'other'

/**
 * 只依赖真用到的那几个成员,便于测试注入最小 fake(不必伪造整个 chrome 命名空间)。
 * 后续 Task 要用新 API 时往这里加,加一个才封一个。
 */
export interface ChromeApiSubset {
  storage: {
    local: Pick<chrome.storage.LocalStorageArea, 'get' | 'set' | 'remove'>
    /**
     * v0.4 Task 5:嗅探结果的落点。**内存态、浏览器关闭即清**。
     *
     * ⚠️ 这个 `Pick` 里**只有三支读写** —— 放开访问级别的那个方法根本没被封进来,
     *    想放开都没有入口(它的名字刻意不写出来:判据靠 grep 零命中,注释照抄就废了)。
     */
    session: Pick<chrome.storage.SessionStorageArea, 'get' | 'set' | 'remove'>
    /** v0.4 Task 5:变更订阅(sw 的嗅探开关模块级缓存靠它刷新) */
    onChanged: typeof chrome.storage.onChanged
  }
  runtime: Pick<
    typeof chrome.runtime,
    'getManifest' | 'id' | 'onInstalled' | 'onStartup' | 'onMessage' | 'sendMessage'
  >
  /**
   * v0.4 Task 4:`onCreated` / `cancel` / `erase` 三支。
   *
   * ⚠️ `erase` 是 Phase 4 补的 —— Step 0 实测⑤「零残渣、下载项自然消失、不需要 erase」
   *    在真机被推翻(`docs/TODO.md` #52)。**权限没有增长**:`downloads` 本就含 erase。
   */
  downloads: Pick<typeof chrome.downloads, 'onCreated' | 'cancel' | 'erase'>
  /** v0.4 Task 5:嗅探的唯一事件源(观察型) */
  webRequest: Pick<typeof chrome.webRequest, 'onHeadersReceived'>
  /** v0.4 Task 5:取当前 tab 的 id / 刷新 / 关闭事件;v0.4 Task 6 起同一支 `query` 还读 `url` */
  tabs: Pick<typeof chrome.tabs, 'query' | 'reload' | 'onRemoved'>
  /**
   * v0.4 Task 6:**只有 `getAll` 一支**。
   *
   * ⚠️ `set` / `remove` / `onChanged` 一个都不封 —— 「从不写入、从不删除、从不后台收集」
   *    这句承诺靠这个 `Pick` 兑现,不靠自觉。
   */
  cookies: Pick<typeof chrome.cookies, 'getAll'>
}

function normalizeInstallReason(reason: string): InstallReason {
  if (reason === 'install') return 'install'
  if (reason === 'update') return 'update'
  return 'other'
}

/**
 * `net` 由调用方注入而非在此新建:`fetch` 是 Web 标准、与 chrome 命名空间无关,
 * 塞进本文件只会让「唯一碰 fetch 的文件」变成两个。装配在 `createDefaultAdapter()` 里发生。
 *
 * `userAgent` 同样由调用方注入 —— **值本身**读自 `navigator.userAgent`,那一行就在本文件的
 * `createDefaultAdapter()` 里(故 `navigator` 字面仍只有一处);把它做成参数只是为了可测。
 */
export function createChromeAdapter(
  api: ChromeApiSubset,
  net: BrowserNet,
  userAgent: string
): BrowserAdapter {
  const storage: BrowserLocalStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      // MV3 的 chrome.storage.local.get(key) 原生返回 Promise,取回的是「只含该 key 的对象」;
      // 未命中时该对象里根本没有这个 key → 取出即 undefined。不兜默认值(约定 L5)。
      const bag = await api.storage.local.get(key)
      return (bag as Record<string, unknown>)[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      await api.storage.local.set({ [key]: value })
    },
    async remove(key: string): Promise<void> {
      await api.storage.local.remove(key)
    },
    /**
     * v0.4 Task 5:**只把变更的 key 名交出去**,不交 `StorageChange`(新旧值)。
     * 业务代码要值自己回头读 —— 少一个能顺手读到别的键内容的通路。
     * 非 `local` 区的变更直接忽略:嗅探开关只住在 `local`。
     */
    onChanged(listener: (changedKeys: string[]) => void): void {
      api.storage.onChanged.addListener((changes, areaName): void => {
        if (areaName !== 'local') return
        listener(Object.keys(changes))
      })
    }
  }

  /**
   * v0.4 Task 5:会话存储 —— **内存态,浏览器关闭即清**(嗅探结果的落点)。
   *
   * ⚠️ 本块只做读写三支。**默认访问级别只有扩展自身**,放开就等于把用户的媒体请求记录
   *    递给网页脚本 —— 那个放开用的方法在全仓 grep 零命中,是**红线的形状保证**而不是遗漏
   *    (故这里也不写出它的名字)。
   */
  const session: BrowserSessionStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      const bag = await api.storage.session.get(key)
      return (bag as Record<string, unknown>)[key] as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      await api.storage.session.set({ [key]: value })
    },
    async remove(key: string): Promise<void> {
      await api.storage.session.remove(key)
    },
    async keys(): Promise<string[]> {
      // `get(null)` 是取全量的原生写法(不是「取键名为 null 的项」)
      const bag = await api.storage.session.get(null)
      return Object.keys(bag as Record<string, unknown>)
    }
  }

  const runtime: BrowserRuntime = {
    getVersion(): string {
      return api.runtime.getManifest().version
    },
    getId(): string {
      return api.runtime.id
    },
    onInstalled(listener: (reason: InstallReason) => void): void {
      api.runtime.onInstalled.addListener((details): void => {
        listener(normalizeInstallReason(String(details.reason)))
      })
    },
    onStartup(listener: () => void): void {
      api.runtime.onStartup.addListener(listener)
    },
    /**
     * ★ MV3 的回调形态(spec §5.4.3):Chrome 的 `onMessage` **不接受返回 Promise**
     * (那是 Firefox / WebExtension polyfill 的形态),必须 `return true` 保持通道开放、
     * 稍后调 `sendResponse`。这正是适配层「Promise / 回调差异」那一栏的活例。
     *
     * `return true` 把异步工作交回浏览器等 = **约定 L4 在这条路径上首次真兑现**。
     * 失败也应答(`{ error }`),否则 popup 会一直干等到通道被关。
     */
    onMessage(listener: (message: unknown) => Promise<unknown>): void {
      api.runtime.onMessage.addListener(
        (
          message: unknown,
          _sender: unknown,
          sendResponse: (response?: unknown) => void
        ): boolean => {
          listener(message).then(sendResponse, (error: unknown) => {
            sendResponse({ error: String(error) })
          })
          return true
        }
      )
    },
    sendMessage(message: unknown): Promise<unknown> {
      return api.runtime.sendMessage<unknown, unknown>(message)
    },
    getUserAgent(): string {
      return userAgent
    }
  }

  /**
   * v0.4 Task 4:下载事件与取消。
   *
   * `onCreated` 在这里就把 `DownloadItem` **收窄成 `CreatedDownload` 六字段** ——
   * 业务代码于是拿不到 `filename`(空串)/ `finalUrl`(带签名)/ `state` 之类的东西,
   * 「只报事实、不做决策」在类型上就已经成立。
   */
  const downloads: BrowserDownloads = {
    onCreated(listener: (item: CreatedDownload) => void): void {
      api.downloads.onCreated.addListener((item): void => {
        listener({
          id: item.id,
          url: item.url,
          referrer: item.referrer,
          danger: String(item.danger),
          totalBytes: item.totalBytes,
          state: String(item.state),
          startTime: item.startTime,
          byExtensionId: item.byExtensionId
        })
      })
    },
    async cancel(id: number): Promise<void> {
      await api.downloads.cancel(id)
    },
    async eraseCanceled(id: number): Promise<void> {
      // ★ `state: 'interrupted'` 是**红线本身**,不是优化:erase 只删记录不删文件,
      //   而 cancel 打在已下完的项目上是静默无效的 —— 两条叠起来,若这里漏掉 state 条件,
      //   一条「文件已在浏览器下载目录」的记录就会被悄悄抹掉,用户再也看不到那份文件的来历。
      //   实测(Edge 151):带 state 打在 complete 记录上返回 `ids: []`、记录原封不动。
      await api.downloads.erase({ id, state: 'interrupted' })
    }
  }

  /**
   * v0.4 Task 5:响应头观察 —— 嗅探的唯一事件源。
   *
   * ★ 第三参 `['responseHeaders']` **必须传**:它是**读**响应头的 opt-in,不带它
   *   `details.responseHeaders` 恒为 `undefined`,嗅探会全程零命中却一声不吭
   *   (最难诊断的那种形态)。它与 `'blocking'` / `'extraHeaders'` 无关 ——
   *   那两个我们**不传**,故本监听器是**观察型**:回调无返回值,不改动任何请求。
   */
  const webRequest: BrowserWebRequest = {
    onHeadersReceived(
      listener: (details: SniffedResponse) => void,
      filter: { urls: string[] }
    ): void {
      api.webRequest.onHeadersReceived.addListener(
        (details): undefined => {
          listener({
            tabId: details.tabId,
            url: details.url,
            // ★ 浏览器给的 `initiator` 本身就是 **origin 级**(`https://a.example`,不带路径与 query)——
            //   「不记 referrer 完整值」这条红线因此由**取值形态**保证,不靠调用方自觉。
            //   没给时归成空串,不引入第二个「没有」的取值。
            initiator: details.initiator ?? '',
            responseHeaders: details.responseHeaders ?? []
          })
          return undefined
        },
        filter,
        ['responseHeaders']
      )
    }
  }

  /**
   * v0.4 Task 5:标签页。**Task 5 只交出 `id`**;v0.4 Task 6 起多一支 `queryActiveUrl`
   * —— `title` 仍然一个字都不往外递。
   */
  const tabs: BrowserTabs = {
    async queryActiveId(): Promise<number | undefined> {
      const found = await api.tabs.query({ active: true, currentWindow: true })
      return found[0]?.id
    },
    /**
     * ★ v0.4 Task 6:活动标签页地址。
     *
     * **两种「没有」在这里就合并成 `undefined`**:没有活动 tab,或浏览器把 `url` 抹成了
     * 空串 / 不给(受限页 —— `edge://…` / 新建标签页 / 扩展商店**不在 `<all_urls>` 匹配范围内**,
     * 探针 B4 实测确有此情形)。调用方于是只需处理一个「读不到」,**且不可能把空串当地址发出去**。
     */
    async queryActiveUrl(): Promise<string | undefined> {
      const found = await api.tabs.query({ active: true, currentWindow: true })
      const url = found[0]?.url
      return url === undefined || url === '' ? undefined : url
    },
    async reloadBypassingCache(tabId: number): Promise<void> {
      // ★ `bypassCache: true` 是**红线本身**,不是优化(2026-08-09 实测 R2):缓存命中不触发
      //   `onHeadersReceived`,普通刷新照样走缓存 → 照样嗅不到 → 按钮等于没有。
      await api.tabs.reload(tabId, { bypassCache: true })
    },
    onRemoved(listener: (tabId: number) => void): void {
      api.tabs.onRemoved.addListener((tabId): void => {
        listener(tabId)
      })
    }
  }

  /**
   * v0.4 Task 6:cookie 读取 —— 第四档「从扩展获取」的唯一读取点。
   *
   * ★ **入参只透传 `url`,别的一律不往下传**:真实 API 的 `getAll` 还认 `domain` / `name` /
   *   `session` 等条件,甚至可以**不带任何条件一次拖走整个 cookie 库**。这里把入参焊死成
   *   `{ url }`,「后台批量收集」在**编译期**就写不出来(与 `eraseCanceled` 同一手法)。
   *
   * ★ **返回值当场收窄成 `BrowserCookie` 七字段**:`hostOnly`(前导点已承载)、`session`
   *   (与 `expirationDate` 缺失同义)、`sameSite` / `storeId` **一个都不递出去**。
   *   `domain` **原样搬运** —— 前导点就是 `hostOnly`,归一掉会让主进程侧的 Netscape 第 2 列写错,
   *   而失败形态是 yt-dlp **静默**不带 cookie(日志里既没有域名也没有值可查)。
   *
   * ⚠️ **本块不写一行 log**:流过这里的是用户的登录凭据,而扩展的 console 任何装了它的人
   *    都能在 DevTools 里翻。异常原样抛给调用方,由 `cookies/cookieFlow.ts` 静默降级。
   */
  const cookies: BrowserCookies = {
    async getAll(input: { url: string }): Promise<BrowserCookie[]> {
      const found = await api.cookies.getAll({ url: input.url })
      return found.map(
        (cookie): BrowserCookie => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expirationDate: cookie.expirationDate,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly
        })
      )
    }
  }

  return { storage, session, runtime, net, downloads, webRequest, tabs, cookies }
}

/**
 * 零参工厂 —— 装配点专用。
 *
 * `chrome` 全局的类型是完整命名空间,与刻意收窄的 `ChromeApiSubset` 不是同一形状,
 * 故走一次 `as unknown as`;这是本文件的职责所在(把浏览器全局收敛成窄接口),
 * 不是类型逃逸 —— 真正的 API 形状由 `ChromeApiSubset` 的 `Pick<chrome.…>` 钉在编译期。
 *
 * ⚠️ 下面这一行是**全仓唯一读 `navigator` 的地方**(v0.4 Task 4 起由 eslint
 * `no-restricted-globals` 钉死,判据:`grep -rn "\bnavigator\." extension/src/` 只命中本文件)。
 */
export function createDefaultAdapter(): BrowserAdapter {
  return createChromeAdapter(
    chrome as unknown as ChromeApiSubset,
    createDefaultFetchNet(),
    navigator.userAgent
  )
}
