/**
 * 接管确认框 —— 三态合一(v0.4 Task 4 · spec §4.1 / §4.2 / §4.3 · DESIGN §3「接管确认小窗口」)。
 *
 * 由**独立 460px frameless 小窗口**承载(`takeover.html`),不是主窗口里的 overlay ——
 * 主窗口全程不动是本 Task 与「主窗口 overlay」方案的全部差别(DESIGN §4「必答的阻塞点」)。
 *
 * **三态与唯一判据**:
 * - **态 C**(查重):`conflict !== null` → 换成**既有** `DuplicateDialog`,优先级最高。
 * - **态 A**(单条):`items.length === 1`。
 * - **态 B**(列表):`items.length > 1`。**就这一条判据**,没有其它条件。
 *   ⚠️ **跨域批次仍用态 B** —— 只是不渲染顶部单一域名行、每条前缀显示自己的 host。
 *   **绝不按 host 把一批拆成多个窗口**(那既违反「屏幕上永远只有一个确认窗口」,又制造多轮弹窗)。
 *   「同域列表」是**常见形态的命名,不是筛选条件**。
 *   ⚠️ 态判据取的是**批次**长度而非可见条数:逐条移除到只剩一条时**不切回态 A**
 *   (界面在用户眼皮底下换形态比多留一个列表框糟得多)。
 *
 * - 骨架复用 `.overlay` / `.dialog` 三段 + `.btn` / `.pill` / `.input` / `.path-row` + token,
 *   **新增仅布局类** `.tk-*`,零新造色值(同 `DuplicateDialog` 的 `.dup-*`、`BtFileDialog` 的 `.bt-*`)。
 * - ★ **落点原样复用 `saveLocationView`**:显示 `previewDir(pickedDir, defaultDir, …)`,提交传
 *   `pickedDir ?? defaultDir` sentinel —— 主进程 `explicitDirOf` 自己判显式 / 走分类,镜像天然成立。
 *   ⚠️ **绝不在小窗口里自己 `join` 出落点再传绝对路径**:那会绕开分类路由,让「跟随类别」这一档消失。
 * - 诚实提示措辞**守死**(spec §4.1):「已经取消」是**已发生的事实**(受理后扩展立即 `cancel()`,
 *   实测 4ms 完成),不是「将会取消」。用户据此知道点「取消」= 这个文件这次不下了 ——
 *   **那是他自己决定的放弃,不是黑洞**(CONTEXT.md「黑洞」的判据是**谁负责**)。
 * - `Esc` / `×` 等同「取消」;**点遮罩不关闭**(防误触,同 `FormatDialog` / `BtFileDialog` 既有规矩)。
 *
 * ⚠️ **列表态不逐条改文件名**(克制取舍,**不是遗漏**):逐条 `.input` 会把 460px 的框撑成表格,
 *    且与「批量快速放行」的心智相反。要精细改名就一条条下载。
 * ⚠️ **刻意不复用 `AddTaskDialog`**:它的心智是「贴一批 URL 进来」(textarea / 批量解析 / 解析方式
 *    select / 选种子文件),与接管场景相反。只复用 `saveLocationView` 那套纯函数。
 * ⚠️ **复用 `DuplicateDialog`**(M-011 仅补可选 pending/error 呈现) —— 它自身不碰 `window.api`,三个回调全由挂载方接线,
 *    故「多一处挂载点」= 再接一次这三个回调。收口时 `git diff` 该组件恒为空。
 */

import { useEffect, useState } from 'react'
import type {
  CategoryConfig,
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateResolution,
  TakeoverItem,
  TakeoverSubmitPayload
} from '../../../shared/ipc'
import { categoryDirForUrl, previewDir } from '../lib/saveLocationView'
import { formatBytes } from '../lib/format'
import DuplicateDialog from './DuplicateDialog'
import './AddTaskDialog.css'
import './buttons.css'
import './TakeoverDialog.css'

interface Props {
  /** 待确认的这一批;空数组 = 尚无内容(窗口在等主进程送批次) */
  items: TakeoverItem[]
  /** 队首查重冲突;非 `null` → 态 C(优先级最高,`TakeoverDialog` 让位给 `DuplicateDialog`) */
  conflict: DuplicateConflict | null
  duplicatePending?: boolean
  duplicateError?: string | null
  /** 默认下载目录(`settings:get`);落点 sentinel 的比较基准 */
  defaultDir: string
  /** 类别配置(`category:list`,含解析后真实目录);算「跟随类别」的落点用 */
  categories: CategoryConfig[]
  /** 点「开始下载」:载荷直接进 `takeover:submit` */
  onSubmit: (payload: TakeoverSubmitPayload) => void
  /** 取消 / 全部取消 / `Esc` / `×` */
  onDismiss: () => void
  /** 「浏览…」:选目录(注入 → 组件不碰 `window.takeoverApi`,单测无需桩) */
  onBrowse: () => Promise<string | null>
  /** 态 C:提交四决策(挂载方接 `takeoverApi.resolveDuplicate` 并出队) */
  onResolveDuplicate: (res: DuplicateResolution) => void
  /** 态 C:「已存在 · 打开」(挂载方接 `openPath` / `showItemInFolder`) */
  onOpenExisting: (item: DuplicateConflictItem) => void
}

export default function TakeoverDialog({
  items,
  conflict,
  defaultDir,
  categories,
  onSubmit,
  onDismiss,
  onBrowse,
  onResolveDuplicate,
  duplicatePending = false,
  duplicateError = null,
  onOpenExisting
}: Props): React.JSX.Element | null {
  const [filename, setFilename] = useState('')
  const [pickedDir, setPickedDir] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  /** 态 B 里被逐条 `×` 掉的条目 id(**移除该条**,不是「取消该条的下载」——它早就被浏览器取消了) */
  const [removed, setRemoved] = useState<string[]>([])

  const batchKey = items.map((i) => i.id).join(',')
  // 换批次(同窗换内容)→ 重置为新的建议名与落点。用「渲染期调整 state」而非 useEffect,
  // 与 `BtFileDialog` / `AddTaskDialog` 既有先例同形(少一轮级联渲染)。
  const [prevKey, setPrevKey] = useState<string | null>(null)
  if (items.length > 0 && prevKey !== batchKey) {
    setPrevKey(batchKey)
    setFilename(items[0].filename)
    setPickedDir(null)
    setSubmitted(false)
    setRemoved([])
  }

  // Esc 等同「取消」(沿用 FormatDialog / BtFileDialog)。
  // 态 C 时让位给 `DuplicateDialog` 自己的 Esc —— 两个都监听会一次按键关两层。
  const escActive = conflict === null && items.length > 0
  useEffect(() => {
    if (!escActive) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escActive, onDismiss])

  // ── 态 C:同一小窗口内换成既有 DuplicateDialog(复用挂载;可选 pending/error 为 M-011 严格覆盖反馈)──────────
  if (conflict) {
    return (
      <DuplicateDialog
        open
        conflict={conflict}
        onResolve={onResolveDuplicate}
        pending={duplicatePending}
        error={duplicateError}
        onOpenExisting={onOpenExisting}
        // ⚠️ 与主窗口 `App.tsx` 刻意不同:那里「关闭」= 只出队、任务留在 awaiting_selection 待稍后
        //    再决策(§6.2 兜底)。**接管路径没有那个兜底** —— http 冲突扣留在内存里、不在列表、
        //    没有任何入口能再找回来,只出队就等于让它静默蒸发(CONTEXT.md「黑洞」第三变体)。
        //    故这里把 × / Esc 如实落成 `skip`:关掉这个框 = 放弃这个文件,与关窗同一语义,
        //    **有人负责了**。确认框已如实告知「浏览器那边已经取消」,用户知情。
        onClose={() => onResolveDuplicate({ conflictId: conflict.conflictId, decision: 'skip' })}
      />
    )
  }

  if (items.length === 0) return null

  const isList = items.length > 1
  const visible = items.filter((i) => !removed.includes(i.id))
  const hosts = new Set(items.map((i) => i.host))
  /** 全批同 host 才渲染顶部那一行(跨域批次不渲染,改由每条自己前缀显示 host) */
  const singleHost = hosts.size === 1 ? items[0].host : null
  /**
   * 态 A 且这一条是**视频流**(v0.4 Task 5 · spec §4.6 第 2 点)。
   *
   * ⚠️ 此时**不给文件名输入框** —— `video` 任务的 `filename` / `savePath` 在 `addTask` 阶段
   *    都是**占位**,最终由 `applySelection` 按「标题 [清晰度].ext」重算。
   *    **用户改了名却静默不生效是不诚实的**,故换成一行只读说明。
   * ⚠️ **`kind === 'http'` 时逐字保持现状**(单测断言 http 条目渲染结构不变)。
   * ⚠️ 列表态(态 B)本来就不逐条改名,故无需分支 —— 那里没有「改了不生效」这回事。
   */
  const isSingleVideo = !isList && items[0].kind === 'video'
  /**
   * 这一批**将会用到**的暂借登录态域名(v0.4 Task 6 · plan Phase 4)。
   *
   * - 取自 **`visible`**(态 B 里被 `×` 掉的条目不会下载,它的域自然不该出现在这句里);
   * - **`present` 时刻实读 + 不做实时推送**(spec §10.2 第 9 条):`cookieHosts` 是主进程在
   *   拉取这一批时从持有层实读后随批次下发的结论,**缺则整行不渲染**;
   * - 🔴 **只有 host,没有任何 cookie 值** —— 红线 R3 由 `TakeoverItem` 的**接口形状**保证。
   */
  const cookieHosts = [...new Set(visible.flatMap((i) => i.cookieHosts ?? []))]

  // 所见即所存(spec §1.2 三段镜像):显示目录 ≡ 落盘目录。
  // 列表态一个统一落点作用于整批 → 跟随时的「自动落点」就是 defaultDir(各条按类型分流由主进程做)。
  const autoDir = isList ? defaultDir : (categoryDirForUrl(items[0].url, categories) ?? defaultDir)
  const displayDir = previewDir(pickedDir, defaultDir, autoDir)
  const following = pickedDir === null || pickedDir === defaultDir
  const canSubmit = isList
    ? visible.length > 0 && !submitted
    : // 视频流条目没有文件名输入框可填 —— 用「名字非空」当判据会让按钮永远可点也永远无意义,
      // 故它只看「还没提交」
      (isSingleVideo || filename.trim().length > 0) && !submitted

  const browse = async (): Promise<void> => {
    const picked = await onBrowse()
    if (picked) setPickedDir(picked)
  }

  const submit = (): void => {
    if (!canSubmit) return
    setSubmitted(true)
    onSubmit({
      items: isList
        ? visible.map((i) => ({ id: i.id, filename: i.filename }))
        : // 视频流:**不回传建议名** —— 框里刚说了「文件名将在解析后确定」,再把一个名字送过去
          //   就等于说一套做一套。空串 → 主进程 `filename?.trim() || undefined` → 走
          //   `resolveFilename` 自己推占位名,与从主窗口添加视频任务**同一条路径**。
          [{ id: items[0].id, filename: isSingleVideo ? '' : filename.trim() }],
      // 传值用 sentinel:跟随时传 defaultDir → 主进程 explicitDirOf 判未显式 → 走分类路由
      dir: pickedDir ?? defaultDir
    })
  }

  return (
    <div className="overlay show tk-overlay">
      <div className="dialog tk-dialog">
        <div className="dialog-head">
          <h3>{isList ? `接管 ${items.length} 个下载` : '接管下载'}</h3>
          <button className="dialog-close" onClick={onDismiss} title="取消" aria-label="取消">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          {/* 顶部来源行:态 A 恒有;态 B 仅全批同 host 时有(跨域批次改由每条自己前缀) */}
          {singleHost && (
            <div className="tk-origin">
              <span className="tk-host" title={singleHost}>
                来自 {singleHost}
              </span>
              {/* 大小未知(浏览器给 -1 / 0)→ 整个 pill 不渲染,不写「未知大小」这种噪音 */}
              {!isList && items[0].totalBytes > 0 && (
                <span className="pill">{formatBytes(items[0].totalBytes)}</span>
              )}
            </div>
          )}

          {isList ? (
            <>
              <div className="tk-list">
                {visible.map((item) => (
                  <div className="tk-item" key={item.id}>
                    <span className="tk-item-name" title={item.filename}>
                      {/* 跨域批次:每条前缀显示自己的 host(顶部那一行此时不存在) */}
                      {!singleHost && <span className="tk-item-host">{item.host}</span>}
                      {item.filename}
                    </span>
                    {item.totalBytes > 0 && (
                      <span className="pill">{formatBytes(item.totalBytes)}</span>
                    )}
                    <button
                      className="tk-x"
                      title="移除"
                      aria-label={`移除 ${item.filename}`}
                      onClick={() => setRemoved((cur) => [...cur, item.id])}
                    >
                      <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
              {visible.length === 0 && (
                <div className="tk-note">已全部移除,点「全部取消」关闭。</div>
              )}
            </>
          ) : isSingleVideo ? (
            // 视频流:不给输入框,如实说明名字与落点由解析后决定(spec §4.6 第 2 点)
            <div className="field">
              <label>文件名</label>
              <div className="tk-readonly">
                文件名与保存位置将在解析后确定(视频流由 yt-dlp 解析)
              </div>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="tk-filename">文件名</label>
              <input
                id="tk-filename"
                className="input"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label>保存到</label>
            <div className="path-row">
              <input className="input" value={displayDir} readOnly />
              <button className="btn btn-default" onClick={browse}>
                浏览…
              </button>
            </div>
            {/* 跟随时的诚实文案 —— 逐字复用 AddTaskDialog 多行批量那一句 */}
            {isList && following && <div className="save-hint">各文件按类型分类保存</div>}
            {/* 视频流:落点在 applySelection 才按类别定型,故这里只能说「预计」 */}
            {isSingleVideo && <div className="save-hint">预计保存到此处(解析后可能按类别调整)</div>}
          </div>

          {/* ⚠️ 措辞 2026-08-04 据真机取证修订(`docs/TODO.md` #52 的 ②)。
           * 原文是「浏览器那边的下载**已经取消**」—— 那是一个**并不总为真**的断言:
           * `downloads.cancel()` 打在一个**已经下完**的项目上是**静默无效**的(Edge 151 实测:
           * lastError 为 null、state 仍 complete、文件已落在浏览器下载目录),而小文件确实会
           * 在受理往返期间下完(手测抓到四条 1441 KB 的 complete 记录)。
           * 改为「已请求…」+ 条件句:**每一个字都永远为真**,且把「可能有第二份」如实告诉用户
           * —— 这是 #52 的 ② 选定的处置(不补撤回 type:那删不掉已经落盘的文件)。 */}
          <div className="tk-note">
            {isList
              ? '已请求浏览器取消这些下载 —— 若其中有此前已下完的,文件可能已在浏览器下载目录里。移除的条目 DownLord 不会下载。'
              : '已请求浏览器取消这次下载 —— 若它此前已下完,文件可能已在浏览器下载目录里。点「取消」DownLord 就不下载它。'}
          </div>

          {/* 将用到暂借登录态时如实告知 + **给出撤销出口**(D7 ③:这一行必须带「可在设置页清除」)。
           * 不带出口就等于只告知不给回路 —— 用户此刻正被告知 DownLord 手里有他的登录态,
           * 却不知道去哪儿收回。⚠️ 「取消这次下载」**不清除**已暂借的登录态(取舍已在设置页
           * 首次说明里点过名),故这句在取消路径上同样成立。 */}
          {cookieHosts.length > 0 && (
            <div className="tk-note">将使用 {cookieHosts.join('、')} 的登录态(可在设置页清除)</div>
          )}
        </div>
        <div className="dialog-foot">
          <button className="btn btn-default" onClick={onDismiss}>
            {isList ? '全部取消' : '取消'}
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {isList ? `开始下载 (${visible.length})` : '开始下载'}
          </button>
        </div>
      </div>
    </div>
  )
}
