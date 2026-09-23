/**
 * 「本次任务需要哪些域」的推导(v0.4 Task 6 · spec §2.4)。
 *
 * ★ **同一个纯函数在两处算,输入同源,故天然一致**(与 Task 5 的 U-34 守卫同一思路):
 * - `TakeoverService` 侧:算应答里的 `needCookieFor`(输入 = intent 的 url + referrer);
 * - `VideoResolver` / `VideoEngine` 侧:算要物化哪些域(输入 = 任务的 source + `headers['Referer']`)。
 *
 * `referrer` 经 Task 4 的 `filterDownloadHeaders` 白名单进 `headers`,而 `Referer` 正在白名单内,
 * 故两侧看到的是**同一对事实**。由此得到本 Task 一个重要的架构简化:
 * `AddTaskInput` / `Task` / SQLite schema / `taskManager.ts` **一个字段都不加、一行都不改** ——
 * 需要哪些域是**从已有数据当场重算的**,不是跟着任务传的。
 *
 * 纯函数模块:**零 `electron` import**。
 */
import type { CookieSource } from '../../shared/ipc'

/**
 * 点名域的上界(红线 R8「不批量」)。
 *
 * 2 = 页面域 + referrer 域。**这不是性能考虑,是外泄面的硬边界** ——
 * 一次任务最多让两个站的 cookie 离开浏览器。
 */
export const MAX_COOKIE_HOSTS = 2

/** 仅用于快照取值的受限别名 key;不扩点名,不剥非 www 子域,保留端口。 */
export function cookieHostAliasKey(host: string): string {
  return host.replace(/^www\./, '')
}

/** 取 URL 的 host;非法 URL / 无 host → `null`(跳过,不抛) */
function hostOf(url: string | undefined): string | null {
  if (url === undefined || url === '') return null
  try {
    const host = new URL(url).host
    return host === '' ? null : host
  } catch {
    return null
  }
}

/** 去重、保序、截到上界 */
function normalize(hosts: (string | null)[]): string[] {
  const out: string[] = []
  for (const host of hosts) {
    if (host === null) continue
    if (out.includes(host)) continue
    out.push(host)
    if (out.length >= MAX_COOKIE_HOSTS) break
  }
  return out
}

/**
 * 由任务的 URL(+ referrer)推出要点名哪些域(spec §2.4)。
 *
 * 取 `new URL(url).host`;若 `referrer` 合法且 host 不同则追加;**去重、保序、最多 2 项**;
 * 非法 URL 跳过;全非法 → `[]`。
 */
export function resolveCookieHosts(url: string, referrer?: string): string[] {
  return normalize([hostOf(url), hostOf(referrer)])
}

/**
 * 档位闸门 —— ⚠️ **「没选第四档 = 零外泄」的机器保障**(红线 R10)。
 *
 * `source` 不是 `'extension'`、或扩展侧没接管(`taken === false`)→ **恒 `[]`**。
 * 只有两个条件同时成立,才从 `urls` 里推域。
 *
 * ⚠️ **`source` 已由 Phase 2 从 `string` 收窄为 `CookieSource`**(Phase 1 时 `ipc.ts` 的并集里
 * 还没有 `'extension'`,而那时的红线是「零既有文件被改」)。收窄后「拼错档位名」这一整类错误
 * 在**编译期**就没了 —— 与字面量 `'extension'` 比较的语义此后一字未变。
 * 运行时那道判据**仍然保留**:类型可以被 `as` 强转绕过,值比较绕不过。
 */
export function needCookieForOf(
  source: CookieSource,
  taken: boolean,
  urls: (string | undefined)[]
): string[] {
  if (source !== 'extension' || !taken) return []
  return normalize(urls.map(hostOf))
}
