/**
 * BT 任务级选项与种子编码纯函数(v0.3 Task 1 · spec §4.1 / §4.2;Task 2 文件选择映射 · spec §3.3)。
 *
 * 仿 `engine/aria2Limit.ts` / `proxy/proxyArgs.ts` 范式:只做选项组装 / query 解析 / base64 编码 /
 * 索引映射,不碰 fs / 网络 / 子进程。产出的是**任务级** options(随 `addUri([magnet])` / `addTorrent(base64)`
 * 传,与 `dir` / proxy / `out` 同层),不改 aria2 启动参数;BT 协议全交 aria2 原生(§6.1)。
 */
import type { TorrentFile } from '../../shared/ipc'

/**
 * 全局做种配置(v0.3 Task 3 · spec §2 / §5;注入式回调实时读,仿 `getSpeedLimit`)。
 * 主进程内部形状(**非 IPC 契约**):`enabled` 做种总开关、`ratio` 分享率(0=不按比率停)、
 * `timeMin` 做种分钟(0=不按时间停)、`maxPeers` 单任务 peer 上限(0/省略=跟随 aria2 全局默认 128)。
 */
export interface SeedConfig {
  enabled: boolean
  ratio: number
  timeMin: number
  maxPeers?: number
}

/**
 * 做种配置 → aria2 任务级做种选项(纯函数,v0.3 Task 3 · spec §2.2)。
 * - 未传 / `enabled===false` → `{ 'seed-time': '0' }`(**下载完即停做种**,与现状逐字节等价、零回归);
 * - `enabled===true` → `{ 'seed-ratio': String(ratio) }` ⊕(`timeMin>0`→`seed-time`)⊕(`maxPeers>0`→`bt-max-peers`)。
 * aria2 在 `seed-time` 与 `seed-ratio` **任一先达到即停**(自然转 complete);`timeMin=0` 省略 seed-time(不按时间停),
 * `ratio=0` 传 `seed-ratio='0'`(不按分享率停)。值取字符串(aria2 RPC 选项值均为字符串,与 buildBtOptions 一致)。
 */
export function toSeedOptions(seed?: SeedConfig): Record<string, string> {
  if (!seed || !seed.enabled) {
    return { 'seed-time': '0' }
  }
  const options: Record<string, string> = { 'seed-ratio': String(seed.ratio) }
  if (seed.timeMin > 0) {
    options['seed-time'] = String(seed.timeMin)
  }
  if (seed.maxPeers !== undefined && seed.maxPeers > 0) {
    options['bt-max-peers'] = String(seed.maxPeers)
  }
  return options
}

/**
 * BT 任务级 options(纯函数,spec §4.2;Task 2 扩展 select-file / pause-metadata / pause · spec §3.3)。
 * **恒含** Task 1 四项:`dir`(落点)/ `follow-torrent='true'`(磁力元数据完成后自动跟进真实下载,两段 gid
 * 前提)/ 做种档(`...toSeedOptions(input.seed)`,缺省 `seed-time='0'` 下载完即停、PRD §4.4 诚实;开档
 * `seed-ratio` / `seed-time`,v0.3 Task 3 · §2.2)/ `bt-save-metadata='true'`(元数据存
 * `<infoHash>.torrent` 便于诊断)。以下三项**按需叠加**(缺省 = Task 1 整包,逐字节等价、零回归):
 * - `selectFile` 有值(非空 / 非 null)→ `select-file`(aria2 原生只下选中文件,§3.2;出队 / 恢复重建);
 * - `pauseMetadata` → `pause-metadata='true'`(磁力:元数据下完后暂停跟进的真实下载,待选,§5.1);
 * - `pause` → `pause='true'`(`.torrent`:无元数据阶段,addTorrent 即以暂停态加入,待选,§5.1)。
 * **不用 `bt-metadata-only`**(那会只取元数据即停,不再下文件,与「选后继续下选中」冲突,§5.1)。
 * 值取字符串——aria2 RPC 选项值均为字符串(与 `aria2Limit` / `proxyArgs` 一致)。
 */
export function buildBtOptions(input: {
  dir: string
  selectFile?: string | null
  pauseMetadata?: boolean
  pause?: boolean
  seed?: SeedConfig
}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    dir: input.dir,
    'follow-torrent': 'true',
    // 做种档注入(v0.3 Task 3 · spec §2.2):缺省 seed-time='0'(下载完即停,零回归);开档 seed-ratio/seed-time
    ...toSeedOptions(input.seed),
    'bt-save-metadata': 'true'
  }
  // 空串 / null 均不加 select-file(全选 = 整包 = 逐字节零回归,§2.3):非空才叠加。
  // bt-remove-unselected-file 随 select-file 成对(2026-07-25 真机修订三):aria2 按 piece 下载会给
  // 未选文件预创建 0B 条目 + 写入同 piece 边界字节;完成时由 aria2 删未选文件,磁盘只留选中项。
  // 全选不叠加(无未选文件,保持零回归);若后续做「补选」功能须重估此项(会删此前未选的文件)。
  if (input.selectFile) {
    options['select-file'] = input.selectFile
    options['bt-remove-unselected-file'] = 'true'
  }
  if (input.pauseMetadata) {
    options['pause-metadata'] = 'true'
  }
  if (input.pause) {
    options['pause'] = 'true'
  }
  return options
}

/**
 * 勾选布尔(`files[].selected`)→ aria2 `--select-file` 索引串(1-based,升序,压缩区间;纯函数,spec §3.3)。
 * **全选**(`files.every(selected)`,含空数组的 vacuous true)→ `null`（= 不传 select-file = 整包,零回归）;
 * 否则收集选中项的 1-based 索引 → 连续段压缩为 `"1,3-5,7"`(减小参数长度,大种子友好)。
 * 索引不变式(§3.2):`files[i]`(0-based 数组位)↔ aria2 `--select-file` 索引 `i + 1`
 * (`torrentMeta.files[]` 按 aria2 `files` 顺序构建,见 `downloadEngine.tryEmitTorrentInfo`)。
 */
export function selectFileArg(files: readonly Pick<TorrentFile, 'selected'>[]): string | null {
  if (files.every((f) => f.selected)) {
    return null
  }
  const indices: number[] = []
  files.forEach((f, i) => {
    if (f.selected) {
      indices.push(i + 1)
    }
  })
  return compactIndexRanges(indices)
}

/**
 * 渲染层勾选(1-based 索引集)→ 定型 `files[].selected`(返回**新数组**,不可变,spec §3.3)。
 * 供 `TaskManager.applyTorrentSelection` 落 `torrentMeta`。按 1-based 索引集置位:索引在集内 → `selected=true`,
 * 否则 `false`;**越界索引忽略**(不匹配任何 `files[i]`),**保序**(`map` 逐位),原数组不改(每项浅拷贝新对象)。
 */
export function applyFileSelection(
  files: readonly TorrentFile[],
  selectedIndices: readonly number[]
): TorrentFile[] {
  const selected = new Set(selectedIndices)
  return files.map((file, i) => ({ ...file, selected: selected.has(i + 1) }))
}

/**
 * 升序去重索引 → aria2 `--select-file` 串(连续段压缩为 `a-b`,纯函数,spec §3.3)。
 * 如 `[7,3,4,1,5,3]` → 去重升序 `[1,3,4,5,7]` → `"1,3-5,7"`;空 → `""`。单测直接覆盖。
 */
function compactIndexRanges(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b)
  if (sorted.length === 0) {
    return ''
  }
  const parts: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]
    if (n === prev + 1) {
      prev = n
    } else {
      parts.push(start === prev ? String(start) : `${start}-${prev}`)
      start = n
      prev = n
    }
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`)
  return parts.join(',')
}

/**
 * 从磁力链接提取 `dn`(display name)参数作占位名(纯函数,spec §5.1 创建路径)。
 * 有 `dn` 且非空白 → 解码后名字(`URLSearchParams` 处理 percent / `+`);无 `?` / 无 `dn` / 全空白 → null。
 * 仅解析 `?` 之后的 query 片段(不经 `new URL`,规避磁力非特殊 scheme 的解析差异)。
 */
export function magnetDisplayName(magnet: string): string | null {
  const q = magnet.indexOf('?')
  if (q < 0) {
    return null
  }
  const dn = new URLSearchParams(magnet.slice(q + 1)).get('dn')
  return dn && dn.trim() ? dn : null
}

/**
 * 种子文件字节 → base64(纯函数,供 `aria2.addTorrent`,spec §4.1)。
 * 读盘 / addTorrent 调用在引擎侧(Phase 3);此处仅做编码。
 */
export function toBase64(buf: Buffer): string {
  return buf.toString('base64')
}
