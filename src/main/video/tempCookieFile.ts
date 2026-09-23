/**
 * 投递层「临时 cookies.txt」租约(v0.4 Task 6 · spec §4.3)。
 *
 * 它是持有层的**一次性投影,不是真源**(`CONTEXT.md`「暂借登录态」):锚在**一次 yt-dlp 进程**上,
 * 进程退出即删。「不写磁盘」不可达 —— yt-dlp 的 `--cookies` 只吃文件 —— 所以要写清哪一层不写:
 * **持有层只在内存**,只有这一层落地,且落地即带删除责任。
 *
 * 纯函数模块:`fs` 与随机源全部**注入**,**零 `electron` import**,可单测。
 */
import { join } from 'path'

import { toNetscapeCookieFile, type NetscapeCookieGroup } from './netscapeCookies'

/** 注入式 fs + 随机源(照 `jsonConfigStore.ts` 的注入范式) */
export interface CookieFileLeaseDeps {
  writeFileSync(path: string, data: string, options: { encoding: 'utf8'; mode: number }): void
  rmSync(path: string, options: { force: boolean }): void
  /** `randomBytes(n).toString('hex')`,产 `2n` 个十六进制字符 */
  randomHex(bytes: number): string
}

/**
 * 一次租约。**除 `release()` 外不暴露任何内容访问** —— 文件里装的是 cookie 值,
 * 谁都不该从这里读回去(spec §4.1「谁能看见:谁都不该看见」)。
 */
export interface CookieLease {
  /** 临时文件绝对路径(交给 yt-dlp 的 `--cookies`) */
  path: string
  /** 这份文件覆盖了哪些 host —— 只出 host,供错误上下文用,**不含值** */
  hosts: string[]
  /** 幂等:重复调用只删一次,删不掉只吞异常**不抛** */
  release(): void
}

/** 文件名随机部分的字节数 → 32 个十六进制字符,与 `cookieTempSweep` 的正则同源 */
const RANDOM_BYTES = 16

/** 仅属主可读写。⚠️ 见下方 `createCookieFileLease` 里关于 Windows 的注释 */
const OWNER_ONLY_MODE = 0o600

/**
 * 物化一份临时 cookies.txt 并返回租约(spec §4.3)。
 *
 * - **目录**:`<userData>/cookies-tmp/`,**专用**。专用是启动清扫能成立的前提 ——
 *   清扫共享目录迟早误删别人的东西。
 * - **文件名**:`ck-` + 32 hex + `.txt`。随机化的目的是**同域并发任务各写各的**(D5:
 *   不做共用与引用计数,省掉一整类竞态,代价只是多几个几 KB 的文件)。
 *
 * ⚠️ **调用方若要兑现「`written === 0` 等于没有、不物化文件」**(spec §6.2),
 * 请**先自行调用 `toNetscapeCookieFile(entries)` 看 `written`**,为 0 时干脆别建租约。
 * 本函数不替调用方做这个判断 —— 它的职责只有「建文件 + 负责删掉」。
 */
export function createCookieFileLease(
  deps: CookieFileLeaseDeps,
  dir: string,
  hosts: string[],
  entries: NetscapeCookieGroup[]
): CookieLease {
  const path = join(dir, `ck-${deps.randomHex(RANDOM_BYTES)}.txt`)
  const { text } = toNetscapeCookieFile(entries)

  // ⚠️ `mode` 在 **Windows 上只影响只读属性、不设 ACL**(Node 文档明载)。写它是零成本的
  //    正确性(非 Windows 端真生效),但**不得据此宣称已收紧权限** —— DownLord 只分发 Windows,
  //    此处实际防不住同机其它用户。真正的兜底是「生命周期极短 + 用完即删 + 启动清扫」,
  //    不是文件权限(D5:不做 ACL,理由见 spec §7.4)。
  deps.writeFileSync(path, text, { encoding: 'utf8', mode: OWNER_ONLY_MODE })

  let released = false

  return {
    path,
    hosts: [...hosts],
    release() {
      if (released) return
      released = true
      try {
        deps.rmSync(path, { force: true })
      } catch {
        // 一个删不掉的临时文件**不该让用户的下载失败**(spec §4.3)。
        // 残留由下次启动的 `sweepCookieTempDir` 兜底 —— 那才是这一类的最终防线。
      }
    }
  }
}
