/**
 * 启动清扫 —— 兜住「应用崩溃 / 断电」这唯一一类租约兜不住的残留(v0.4 Task 6 · spec §4.5)。
 *
 * 正常路径上,临时 cookies.txt 由 `CookieLease.release()` 在 yt-dlp 进程结束时删掉(spec §4.4
 * 逐条列了释放点)。**唯一兜不住的是进程根本没机会跑到那些释放点** —— 故清扫不是可选项,
 * 它是红线 R5「临时文件用完即删」在异常路径上的那一半。
 *
 * 纯函数模块:`fs` 注入,**零 `electron` import**,可单测。
 */
import { join } from 'path'

/** 注入式 fs(照 `jsonConfigStore.ts` 的注入范式;同步版够用 —— 只在启动期跑一次) */
export interface CookieTempSweepFs {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: boolean }): void
  readdirSync(path: string): string[]
  rmSync(path: string, options: { force: boolean }): void
}

/**
 * 🔴 **只删自己命名规则的东西**(spec §4.5)。
 * 与 `tempCookieFile.ts` 的文件名同源:`ck-` + 32 hex + `.txt`。
 */
const COOKIE_TEMP_NAME = /^ck-[0-9a-f]{32}\.txt$/

/**
 * 清扫专用临时目录里的残留 cookies.txt。
 *
 * - 目录不存在 → `mkdirSync(recursive:true)` 建之,`removed: 0`(顺带保证后续租约有地方落);
 * - 存在 → **只删文件名匹配 `ck-<32hex>.txt` 的条目**。
 *   🔴 **绝不 `rm -rf` 整个目录** —— 万一有人把该路径配歪了(指到文档目录之类),
 *   只删自己命名规则的东西是唯一安全的做法;
 * - 单条删除失败**只计数不抛**,不中断其余条目。
 *
 * 返回 `{ removed }` —— 调用方只该记**计数**,**零文件名、零域名**(§7.1 日志红线)。
 */
export function sweepCookieTempDir(fs: CookieTempSweepFs, dir: string): { removed: number } {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    return { removed: 0 }
  }

  let removed = 0
  for (const name of fs.readdirSync(dir)) {
    if (!COOKIE_TEMP_NAME.test(name)) continue
    try {
      fs.rmSync(join(dir, name), { force: true })
      removed += 1
    } catch {
      // 删不掉就留着 —— 下次启动再清。启动期的清扫失败不该拦住应用起来
    }
  }
  return { removed }
}
