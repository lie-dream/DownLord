/**
 * 持有层「暂借登录态」(v0.4 Task 6 · spec §4.2)—— **纯内存、零 IO、零依赖**。
 *
 * 装的是用户的登录凭据,故它的「会话级」不只是取舍、更是安全承诺(见 `CONTEXT.md`「暂借登录态」):
 * 关掉 DownLord 即消失,**不落盘、不落库、不写 settings、不写日志**,连域名都不写日志。
 *
 * ⚠️ **不加密落盘是刻意的**(spec §4.1):持久化的登录态会**静默腐坏** —— 用户在浏览器里退登 /
 * 换账号 / cookie 过期,DownLord 收不到任何通知,表现为「明明授权过却全报需要登录,而界面上
 * 那份授权看起来还好端端在」。会话级免疫这一整类问题。
 *
 * 纯函数模块:**零 `electron` import**,可直接单测。
 */
import type { OfferedCookie } from '../../shared/extensionProtocol'
import { cookieHostAliasKey, MAX_COOKIE_HOSTS } from './cookieDomains'

/**
 * 暂借登录态的持有层。
 *
 * 🔴 **刻意没有 `getAll()` / `toJSON()` / 任何能取出全部 cookie 值的方法** ——
 * 「渲染层拿不到 cookie 值」(红线 R3)是靠**接口形状**保证的,不是靠纪律。
 * 唯一能取值的 `take()` 要求调用方先点名 host,缺项仅试同端口 www 别名;持有域列表由 `hosts()` 给出。
 */
export interface BorrowedCookieStore {
  /** 同域再借 = **整份覆盖,不合并** */
  offer(host: string, cookies: OfferedCookie[]): void
  /** 精确快照(含空)优先,缺项仅试同端口 www 别名;实际快照去重、最多 2 组,无通用父域回退 */
  take(hosts: string[]): { host: string; cookies: OfferedCookie[] }[]
  /** ★ 只出 host,不出值 —— 设置页可见行只吃这一个 */
  hosts(): string[]
  clear(): void
  size(): number
}

/**
 * 建一个持有层实例(每个主进程一个,生命周期 = 应用进程)。
 *
 * 设计取舍(spec §4.2,均出自 Step 0 的 D3):
 * - **整份覆盖不合并**:cookie 是集合快照;合并会让用户退登重登后旧 session cookie 阴魂不散。
 * - **精确优先、仅 www 别名**:不引入通用父域回退;`a.github.io` 与 `b.github.io` 不互通,
 *   实际 cookie.domain/value 原样返回,不合并快照。
 * - **不设域数量上限**:设上限就要处理「被挤掉的域下次得重新点」这类**不可见失效**。
 * - **不加时间 TTL**:隐形定时器会制造「有时候能用有时候不能」的不可预测行为,用户无从判断
 *   自己撞上了哪一种(与否决上限同一理由)。
 */
export function createBorrowedCookieStore(): BorrowedCookieStore {
  /** host → 该域的 cookie 快照。`Map` 的插入序即 `hosts()` 的输出序 */
  const byHost = new Map<string, OfferedCookie[]>()

  return {
    offer(host, cookies) {
      // 存副本:调用方此后改自己那份数组不该影响持有层(整份覆盖的语义靠 set 而非 push)
      byHost.set(host, [...cookies])
    },

    take(hosts) {
      const out: { host: string; cookies: OfferedCookie[] }[] = []
      const emitted = new Set<string>()
      for (const host of hosts) {
        const aliasKey = cookieHostAliasKey(host)
        const snapshotHost = byHost.has(host)
          ? host
          : [...byHost.keys()].find((candidate) => cookieHostAliasKey(candidate) === aliasKey)
        if (snapshotHost === undefined || emitted.has(snapshotHost)) continue
        const cookies = byHost.get(snapshotHost)!
        out.push({ host: snapshotHost, cookies: [...cookies] })
        emitted.add(snapshotHost)
        if (out.length >= MAX_COOKIE_HOSTS) break
      }
      return out
    },

    hosts() {
      return [...byHost.keys()]
    },

    clear() {
      byHost.clear()
    },

    size() {
      return byHost.size
    }
  }
}
