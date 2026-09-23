/**
 * tracker 表文本处理纯函数(v0.4 Task 1 · spec §4.4)。
 *
 * 全部**无 IO、无时钟、无随机、无全局状态** —— 网络拉取、落盘、热应用都在编排层(后续 Step)。
 * 节流判定**不在本文件重写**:直接复用 `../update/updateStateStore` 的 `shouldCheckNow`,
 * 本文件只提供两个窗口常量(`BT_TRACKER_THROTTLE_MS` / `BT_TRACKER_RETRY_MS`)。
 *
 * ⚠️ 【内置 / 远端 / 生效】三态口径(CONTEXT.md):远端表拿到即**整表替换**,
 * `mergeRemoteTrackers` **只接受远端源的列表** —— 内置表(`DEFAULT_BT_TRACKERS`)不参与合并,
 * 否则静态快照里的死条目永不淘汰(D6)。
 */

/** 合并后生效表的条数上限(超出截断,防 `--bt-tracker=` 参数无限膨胀) */
export const MAX_TRACKERS = 100

/** 合格性下限:少于此数视同本次拉取失败(退内置表,绝不写盘、绝不 push) */
export const MIN_TRACKERS = 10

/** 成功后的节流窗口:12h 内不再自动拉取(配合 `shouldCheckNow`,窗口传本常量) */
export const BT_TRACKER_THROTTLE_MS = 12 * 60 * 60 * 1000

/**
 * 失败后的内存短退避窗口(细则 S3):失败**不更新** `updatedAt`(否则被 12h 节流锁死、当天无法
 * 重试),改用不落盘的 `lastAttemptAt` + 本窗口,避免每次添加 BT 任务都重试。判定同样走 `shouldCheckNow`。
 */
export const BT_TRACKER_RETRY_MS = 30 * 60 * 1000

/** 允许的 announce scheme(其余一律丢);scheme 大小写不敏感,比对前统一转小写 */
const ALLOWED_SCHEMES = ['udp://', 'http://', 'https://', 'ws://', 'wss://'] as const

/** 去重键:忽略前后空白与大小写(原文照旧保留,不改写用户可见的条目) */
function dedupeKey(entry: string): string {
  return entry.trim().toLowerCase()
}

/**
 * 解析 tracker 列表文本(spec §4.4 ④)。**按真实文件的脏形态写,不按想象写**:
 * ngosang/trackerslist 的文件以空行分隔条目,可能带 BOM、CRLF、注释行。
 *
 * 逐行处理:去开头 BOM → 按 `\r\n` / `\r` / `\n` 切行 → `trim()` → 丢空行 / `#` 注释行 /
 * **含逗号条目**(S2:`--bt-tracker=` 以逗号分隔,含逗号会把一条注入成两条 / 破坏参数结构)/
 * 非法 scheme / 无 host(用**不抛异常**的方式判定)→ 源内去重(保留首现原文)。
 *
 * **全部非法 → 返回空数组**(不抛),由调用方交给 `isTrackerListQualified` 判失败。
 */
export function parseTrackerText(text: string): string[] {
  // 仅去开头的 BOM;行内出现的 BOM 属脏数据,由后续 scheme / host 判定拦掉。
  // 用 `\uFEFF` 转义而非裸字符:BOM 不可见,写进源码易被编辑器 / diff 吞掉或改写
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text
  const out: string[] = []
  const seen = new Set<string>()

  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line) continue // 空行 / 全空白行
    if (line.startsWith('#')) continue // 注释行
    if (line.includes(',')) continue // S2:含逗号 → 丢

    const lower = line.toLowerCase()
    if (!ALLOWED_SCHEMES.some((scheme) => lower.startsWith(scheme))) continue

    // 无 host 判定:`new URL` 对非法输入会抛,catch 即丢(不让脏数据炸掉整次解析)
    let host: string
    try {
      host = new URL(line).host
    } catch {
      continue
    }
    if (!host) continue

    const key = dedupeKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }

  return out
}

/**
 * 合并多个**远端源**的表(spec §4.4 ①):按 `lists` 顺序拼接(`best` 在前、`best_ip` 在后 ——
 * 域名版优先,IP 版抗污染兜底),去重后截取前 `limit` 条。
 *
 * 去重键 = `trim().toLowerCase()`,**保留首次出现的原文**。
 * ⚠️ **内置表不参与**(D6):调用方不得把 `DEFAULT_BT_TRACKERS` 传进来。
 */
export function mergeRemoteTrackers(
  lists: readonly (readonly string[])[],
  limit: number = MAX_TRACKERS
): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const list of lists) {
    for (const entry of list) {
      const key = dedupeKey(entry)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }

  return out.slice(0, Math.max(0, limit))
}

/**
 * 合格性校验(spec §4.4 ③):条数达标才认这次拉取成功。
 * 不合格 = 视同本次失败(退内置 / 保持原样),**绝不写盘、绝不 push**。
 */
export function isTrackerListQualified(
  list: readonly string[],
  min: number = MIN_TRACKERS
): boolean {
  return list.length >= min
}
