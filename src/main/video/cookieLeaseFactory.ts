/**
 * 持有层 → 租约的接线(v0.4 Task 6 · spec §4.3 / §6.2)。
 *
 * ★ **为什么单独成一个模块,而不是在 `index.ts` 里写一个闭包**:这段「取 → 判 `written === 0`
 * → 物化」的判定就是 `ExtensionCookieContext` 三态里 `missing` 与 `supplied` 的分界线。
 * 它若只活在装配处,集成测试就只能**照抄一遍**同样的逻辑 —— 而照抄出来的测试测的是抄件、
 * 不是真件,两边一旦漂移它还是绿的。抽出来之后 `index.ts` 与 I-C1 / I-C2 / I-C3 用的是**同一个函数**。
 *
 * 纯函数模块:`fs` 与随机源经 `CookieFileLeaseDeps` 注入,**零 `electron` import**。
 */
import type { BorrowedCookieStore } from './borrowedCookieStore'
import { toNetscapeCookieFile } from './netscapeCookies'
import { createCookieFileLease, type CookieFileLeaseDeps, type CookieLease } from './tempCookieFile'
import type { ExtensionCookieContext } from '../errors/mapError'

export interface LeaseCookieFileDeps {
  /** 暂借登录态持有层(纯内存,会话级) */
  store: BorrowedCookieStore
  /** 注入式 fs + 随机源 */
  fileDeps: CookieFileLeaseDeps
  /** 专用临时目录 `<userData>/cookies-tmp/`(启动清扫的对象,与 `sweepCookieTempDir` 同一个) */
  dir: string
}

/**
 * 造 `leaseCookieFile` 回调 —— 两个引擎的注入面就是它(`(hosts) => CookieLease | null`)。
 *
 * 三条**不物化**的短路(任一命中 → `null` → 参数与 `none` 档逐字节相同 → 公开内容照下不误):
 * 1. 没点名任何域(URL 连 host 都解析不出来);
 * 2. `take(hosts)` 空 —— 精确快照与同端口 www 别名均缺,无通用父域回退;
 * 3. `written === 0` —— 拿到了 cookie 但一条都写不出去(全被 `toNetscapeCookieFile` 丢弃)。
 *    ⚠️ 这一条是 `tempCookieFile` 的文档点名要求调用方自己判的:那个函数只负责「建文件 + 负责删掉」,
 *    不替调用方判断「这份文件值不值得建」。**建一个只有魔术注释行的空 cookies.txt 是有害的** ——
 *    它会让 `--cookies` 挂上去,把「等于没有」伪装成「给过了」,错误文案随之从 NONE 变成 STALE。
 */
export function createLeaseCookieFile(
  deps: LeaseCookieFileDeps
): (hosts: string[]) => CookieLease | null {
  return (hosts) => {
    if (hosts.length === 0) return null
    const groups = deps.store.take(hosts)
    if (groups.length === 0) return null
    if (toNetscapeCookieFile(groups).written === 0) return null
    return createCookieFileLease(
      deps.fileDeps,
      deps.dir,
      groups.map((g) => g.host),
      groups
    )
  }
}

/**
 * 租约结果 + 通道连接态 → 前置事实三态(v0.4 Task 6 · spec §6.2 ①)。
 *
 * 🔴 **为什么「没拿到」必须再分成两半**:两半的**下一步完全不同** ——
 * `unpaired` 要用户去「设置 → 浏览器扩展」完成配对,`missing` 要用户回浏览器登录该站再发起一次。
 * 合成一条就必然有一半用户被指错方向。
 *
 * ⚠️ **`isLinked` 未注入 → 保守判 `'unpaired'`**:不知道通道状态时,不能声称它是连着的。
 * (真实装配两个回调一起注入;这只是防御性缺省。)
 */
export function extensionCookieContextOf(
  lease: CookieLease | null,
  isLinked?: () => boolean
): ExtensionCookieContext {
  if (lease) return 'supplied'
  return isLinked?.() === true ? 'missing' : 'unpaired'
}
