/**
 * 添加下载对话框 — 复刻原型 .overlay + .dialog 三段(头 / 体 / 底)。
 *
 * - 多行批量粘贴 URL → lib/urlDetect 识别 http(s) 直链 + 统计非法行(仍走直链)。
 * - **单行链接** → 显示 .detect 视频识别卡(来源名 + 「作为视频解析 / 作为直链下载」select,
 *   默认按 lib/linkClassifyView.describeLink);视频 → onSubmitVideo(addVideo),直链 → onSubmit(addUrls)。
 * - **单行 magnet:** → 种子 / 磁力识别卡(仿视频卡,无 select)→ onSubmitTorrent(addTorrent);
 *   「选择种子文件」按钮 → window.api.selectFile(.torrent filter)→ 得路径直投 onSubmitTorrent(v0.3 Task 1 · spec §10.3)。
 * - 保存位置「所见即所存」(spec §2):显示 = previewDir(pickedDir, defaultDir, autoCategoryDir)、
 *   传值 = pickedDir ?? defaultDir(sentinel,主进程 explicitDirOf 判跟随 / 走分类);单行直链按扩展名显类别目录、
 *   视频 / 多行批量显默认目录 + 文案;浏览(window.api.selectDirectory)= 显式覆盖。目录全来自 category:list,
 *   渲染层不拼 join(§7.2)。
 * - 关闭:取消 / 右上角 × / Esc;点遮罩不关闭(防误触清空已粘贴链接,spec §5.1)。
 * - 链接识别:读 useTasks().categories 的 extensions 聚合「已知文件扩展名集合」传 describeLink 加固直链判定(spec §6.3);仍为纯启发式视图,不含解析 / 下载逻辑。
 */

import { useEffect, useMemo, useState } from 'react'
import { parseUrlLines } from '../lib/urlDetect'
import { describeLink } from '../lib/linkClassifyView'
import { categoryDirForUrl, previewDir, torrentDisplayDir } from '../lib/saveLocationView'
import { useTasks } from '../state/tasksStore'
import './controls.css'
import './AddTaskDialog.css'

interface Props {
  open: boolean
  defaultDir: string
  onClose: () => void
  onSubmit: (urls: string[], dir: string) => void
  /** 单行视频链接 + 选「作为视频解析」时提交(App 接 TasksContext.addVideo);未传则单行视频回退直链 */
  onSubmitVideo?: (url: string, dir: string) => void
  /**
   * 单行 magnet: / 选中 `.torrent` 文件路径时提交种子(App 接 TasksContext.addTorrent,v0.3 Task 1 · spec §10.3);
   * 未传则「选择种子文件」按钮不渲染、magnet 回退直链批量(退化零害)。
   */
  onSubmitTorrent?: (source: string, dir: string) => void
  /** 打开时预填的链接文本(剪贴板提示「添加」入口传入检测到的 URL;普通「+」入口不传 / 传 '');v0.2 Task 4 · spec §9.3 */
  initialText?: string
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/**
 * 多行批量的能力边界(v1.0 Task 3 `M-024`;逐字真源在 spec §4「如实说清单」)。
 *
 * 成因(裁决表 `M-024`):占位已写「粘贴一个或多个**直链**」,但用户按单行那套心智把视频页链接
 * 混在多行里粘进来时,它被**静默当成直链**下载,回给用户的是 `下载失败(引擎代码 22):… status=412`
 * —— **用内部错误码回答一个输入格式问题**。结构上「只有单行才走视频路径」是既定设计(见下方 submit),
 * 不改判定,只把这条边界**说出来**。
 * 🔴 **落成独立提示行,不塞进 `saveHint`** —— `saveHint` 说的是「文件存到哪」,与「收不收这种链接」
 *   是两件事;而且既有用例钉着「`saveHint` 只在多行时出现」,塞进去等于把两条事实压在一个断言上。
 */
const BATCH_HTTP_ONLY_NOTE =
  '多行批量只收直链。视频页链接请一行一条单独添加 —— 多行路径不会走视频解析。'

/**
 * 「添加」按钮禁用时的原因(v1.0 Task 3 `M-010`;逐字真源在 spec §4)。
 *
 * 成因(裁决表 `M-010`):空输入与纯中文输入表现一致 —— 按钮灰着,**一个字都不说为什么**。
 * 红线没破(不建任务、不崩溃、不静默建半成品),但灰按钮对用户是个死胡同。顺带把「收哪几种链接」
 * 一次讲清,省得用户靠试。
 */
const SUBMIT_DISABLED_REASON = '未识别到有效链接(需要 http(s) 链接、磁力链接或 .torrent 地址)。'

/**
 * 用户**改选**解析方式后的识别卡文案(v1.0 Task 3 `M-007`;逐字真源在 spec §4)。
 *
 * 成因(裁决表 `M-007`):`desc` 只由链接本身算出,渲染 `desc.title` / `desc.sub` 处**不读 `linkKind`**
 * —— 于是把「未知链接」切到「作为直链下载」之后,卡片仍写着「将尝试视频解析」,**提示与此刻真实行为矛盾**。
 * 🔴 **只在改选时生效**:`linkKind === desc.suggestedKind`(即没改)时逐字取 `describeLink` 的原值,
 *   既有识别文案**零回归**。`kind === 'torrent'` 那一支没有 select,更不适用。
 */
const KIND_OVERRIDE_DESC: Record<'video' | 'http', { title: string; sub: string }> = {
  video: { title: '已改为:作为视频解析', sub: '将用 yt-dlp 解析可选清晰度' },
  http: { title: '已改为:作为直链下载', sub: '将作为普通文件直接下载' }
}

export default function AddTaskDialog({
  open,
  defaultDir,
  onClose,
  onSubmit,
  onSubmitVideo,
  onSubmitTorrent,
  initialText
}: Props): React.JSX.Element | null {
  const [text, setText] = useState('')
  // 浏览选定的目录:null = 跟随(未浏览 / 选回默认目录);显示 / 传值据此分离(spec §2.1)
  const [pickedDir, setPickedDir] = useState<string | null>(null)
  const [linkKind, setLinkKind] = useState<'video' | 'http'>('video')
  const { categories } = useTasks()
  // 运行时类别扩展名并集:用户改类别 extensions → category:update → category:list 重取 → 重算(spec §6.3)
  const knownFileExts = useMemo(
    () => new Set(categories.flatMap((c) => c.extensions)),
    [categories]
  )

  // 每次打开重置输入 + 跟随态(pickedDir=null → 显示随 defaultDir / autoCategoryDir 实时算)
  // 剪贴板提示「添加」入口经 initialText 预填该 URL;普通「+」入口 initialText 未传 → 回退 ''(spec §9.3)
  // 用「渲染期调整 state」(React 官方 derived-state 模式)而非 useEffect:少一轮级联渲染,
  // 且避免打开瞬间先渲染出上次输入再跳预填值。语义与原 effect 一致(三个依赖任一变化时,open 才重置)。
  const [prevOpenKey, setPrevOpenKey] = useState<{
    open: boolean
    defaultDir: string
    initialText: string | undefined
  } | null>(null)
  if (
    prevOpenKey?.open !== open ||
    prevOpenKey?.defaultDir !== defaultDir ||
    prevOpenKey?.initialText !== initialText
  ) {
    setPrevOpenKey({ open, defaultDir, initialText })
    if (open) {
      setText(initialText ?? '')
      setPickedDir(null)
    }
  }

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const { urls, invalidCount } = parseUrlLines(text)
  // 恰好一个合法 URL 且无非法行 → 单链识别(多行 / 混合非法 → 直链批量)
  const singleUrl = urls.length === 1 && invalidCount === 0 ? urls[0] : null
  // 单行 magnet:(parseUrlLines 只认 http,magnet 不入 urls)→ 独立识别为种子(spec §10.3);
  // 非空行恰一条且以 magnet: 开头才算,避免多行 / 混合时误判(其余按直链批量)
  const magnetLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const singleMagnet =
    onSubmitTorrent && magnetLines.length === 1 && magnetLines[0].startsWith('magnet:')
      ? magnetLines[0]
      : null
  const desc = singleMagnet
    ? describeLink(singleMagnet)
    : singleUrl
      ? describeLink(singleUrl, knownFileExts)
      : null

  // 所见即所存(spec §2):
  // - 单行直链(linkKind=http)→ 按扩展名归类目录(categoryDirForUrl;无匹配回落 defaultDir);
  // - 视频 / 多行批量 → 默认目录 + 文案(落点按类别 / 各文件分类,无法在添加时逐一预览);
  // - 浏览到非默认目录 → previewDir 取该显式目录(显式覆盖,无文案)。
  const autoCategoryDir =
    singleUrl && linkKind === 'http'
      ? (categoryDirForUrl(singleUrl, categories) ?? defaultDir)
      : defaultDir
  // 真 BT(单行 magnet)= 整包落 <defaultDir>/Torrents,主进程 torrentSaveDir 固定,浏览无效 → 显诚实落点 + 文案;
  //(远程 `.torrent` URL 走直链下载文件本身,落点仍按分类,不属 BT 分支)
  const isBt = singleMagnet !== null
  const displayDir = isBt
    ? torrentDisplayDir(defaultDir)
    : previewDir(pickedDir, defaultDir, autoCategoryDir)
  const explicit = pickedDir !== null && pickedDir !== defaultDir
  const saveHint = isBt
    ? '种子按整包保存到 Torrents 目录'
    : explicit
      ? null
      : singleUrl && linkKind === 'video'
        ? '视频将按类别保存(可在选清晰度时确认)'
        : urls.length > 1
          ? '各文件按类型分类保存'
          : null

  // 单链识别建议变化:select 重置为识别建议(用户后续可手动改);
  // 哨兵含 singleUrl + suggestedKind,使 categories 异步到达 / 改类别 extensions 后建议变时同步(spec §6.3)。
  // 用「渲染期调整 state」替代 useEffect 后,原先为对齐依赖而加的 exhaustive-deps 豁免也一并去掉。
  const [prevSuggest, setPrevSuggest] = useState<{
    url: typeof singleUrl
    kind: 'video' | 'http'
  } | null>(null)
  if (desc && (prevSuggest?.url !== singleUrl || prevSuggest?.kind !== desc.suggestedKind)) {
    setPrevSuggest({ url: singleUrl, kind: desc.suggestedKind })
    setLinkKind(desc.suggestedKind)
  }

  if (!open) return null

  // v1.0 Task 3 `M-007`:识别卡随 select **改口**。没改选(或 torrent 那一支)时逐字取 describeLink 原值。
  const shown =
    desc && desc.kind !== 'torrent' && linkKind !== desc.suggestedKind
      ? KIND_OVERRIDE_DESC[linkKind]
      : desc
  // v1.0 Task 3 `M-010`:按钮为什么灰,得说出来(条件与 disabled **同一个表达式**,不许各写一份)
  const submitDisabled = urls.length === 0 && !singleMagnet

  const browse = async (): Promise<void> => {
    const picked = await window.api.selectDirectory()
    if (picked) setPickedDir(picked)
  }

  // 「选择种子文件」:选中 `.torrent` → 直投 addTorrent(源=文件绝对路径;主进程拷托管副本 + BT 提交,§10.3)。
  // 落点由主进程 torrentSaveDir 固定,dir 仅按既有 sentinel 透传(torrent 创建路径忽略之)。
  const pickTorrent = async (): Promise<void> => {
    const path = await window.api.selectFile({
      filters: [{ name: '种子文件', extensions: ['torrent'] }]
    })
    if (path && onSubmitTorrent) {
      onSubmitTorrent(path, pickedDir ?? defaultDir)
      onClose()
    }
  }

  const submit = (): void => {
    // 传值用 sentinel:跟随时传 defaultDir → 主进程 explicitDirOf 判未显式 → 走分类路由(spec §2.1)
    const dir = pickedDir ?? defaultDir
    if (singleMagnet && onSubmitTorrent) {
      onSubmitTorrent(singleMagnet, dir)
    } else if (singleUrl && linkKind === 'video' && onSubmitVideo) {
      onSubmitVideo(singleUrl, dir)
    } else {
      onSubmit(urls, dir)
    }
    onClose()
  }

  return (
    <div className="overlay show">
      <div className="dialog">
        <div className="dialog-head">
          <h3>添加下载</h3>
          <button className="dialog-close" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          <div className="field">
            <label>下载链接</label>
            <textarea
              className="textarea"
              placeholder="粘贴一个或多个直链,每行一个"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {/* 种子文件入口(v0.3 Task 1 · spec §10.3):选中 .torrent 直投 addTorrent;仅接线时渲染 */}
            {onSubmitTorrent && (
              <div className="torrent-pick">
                <button className="btn btn-default" onClick={pickTorrent}>
                  选择种子文件…
                </button>
                <span className="torrent-pick-hint">或在上方粘贴磁力链接 / 直链</span>
              </div>
            )}
          </div>
          {desc ? (
            <div className="detect">
              <div className="d-ico">
                {desc.kind === 'torrent' ? (
                  <svg {...svgProps}>
                    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" />
                    <path d="m5 8 4 4" />
                    <path d="m12 15 4 4" />
                  </svg>
                ) : desc.kind === 'http' ? (
                  <svg {...svgProps}>
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <path d="M14 2v6h6" />
                  </svg>
                ) : (
                  <svg {...svgProps}>
                    <path d="m22 8-6 4 6 4V8Z" />
                    <rect x="2" y="6" width="14" height="12" rx="2" />
                  </svg>
                )}
              </div>
              <div className="d-text">
                <div className="d-title">{shown?.title}</div>
                <div className="d-sub">{shown?.sub}</div>
              </div>
              {/* torrent 无「视频 / 直链」选择(magnet 直投 BT,`.torrent` URL 走直链);仅 video/http/ambiguous 出 select */}
              {desc.kind !== 'torrent' && (
                <select
                  className="select"
                  value={linkKind}
                  onChange={(e) => setLinkKind(e.target.value as 'video' | 'http')}
                >
                  <option value="video">作为视频解析</option>
                  <option value="http">作为直链下载</option>
                </select>
              )}
            </div>
          ) : (
            <div className="detect-hint">
              {urls.length > 0 && <span>识别到 {urls.length} 个直链</span>}
              {invalidCount > 0 && (
                <span className="warn">{invalidCount} 行无法识别(仅支持 http/https 直链)</span>
              )}
              {/* v1.0 Task 3 `M-024`:多行批量只收直链 —— 独立提示行(.detect-hint 是纵向 flex,
                  这里自成一行),不塞进「保存到」下方的 saveHint */}
              {urls.length > 1 && <span className="batch-http-note">{BATCH_HTTP_ONLY_NOTE}</span>}
            </div>
          )}
          <div className="field">
            <label>保存到</label>
            <div className="path-row">
              <input className="input" value={displayDir} readOnly />
              {/* BT 整包落点由主进程固定(torrentSaveDir),浏览无效 → 不出浏览按钮(避免误导,诚实 §10.3) */}
              {!isBt && (
                <button className="btn btn-default" onClick={browse}>
                  浏览
                </button>
              )}
            </div>
            {saveHint && <div className="save-hint">{saveHint}</div>}
          </div>
        </div>
        <div className="dialog-foot">
          {/* v1.0 Task 3 `M-010`:禁用原因就在按钮旁边(margin-right:auto 顶到左侧,不动按钮排布) */}
          {submitDisabled && <span className="foot-reason">{SUBMIT_DISABLED_REASON}</span>}
          <button className="btn btn-default" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={submitDisabled} onClick={submit}>
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
