/**
 * 应用外壳 — 组合标题栏 + 左导航 + 主区 + 状态栏 + 添加对话框。
 *
 * - 持 nav 选中态(useState),用 filterTasksByNav 过滤主列表、NAV_TITLE 映射标题。
 * - 业务态全部来自 TasksContext(useTasks);组件只经 props 回调与 window.api 通信(渲染纯 UI)。
 * - 任务屏:Toolbar + TaskList/EmptyState;设置屏:SettingsPage;状态栏常驻底部。
 * - 添加对话框预填配置的默认下载目录(settings.defaultDir;改设置即时生效),非系统目录;本 Task 固定直链(kind:'http')。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import TaskList from './components/TaskList'
import CategoryChips from './components/CategoryChips'
import StatusBar from './components/StatusBar'
import AddTaskDialog from './components/AddTaskDialog'
import FormatDialog from './components/FormatDialog'
import BatchDialog from './components/BatchDialog'
import DuplicateDialog from './components/DuplicateDialog'
import BtFileDialog from './components/BtFileDialog'
import SettingsPage from './components/SettingsPage'
import HistoryPage from './components/HistoryPage'
import ExtensionPage from './components/ExtensionPage'
import ClipboardPrompt from './components/ClipboardPrompt'
import { useTasks } from './state/tasksStore'
import { filterTasksByNav } from './lib/taskFilter'
import { filterTasksBySearch, normalizeTaskSearchQuery } from './lib/taskSearch'
import { filterTasksByCategory, type CategoryFilterKey } from './lib/categoryFilter'
import { parentDir, landingDirForTorrent } from './lib/saveLocationView'
import { statusBarStats } from './lib/statusBarStats'
import type { NavKey } from './lib/types'
import type {
  ClipboardLink,
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateResolution,
  ProxyStatus,
  ResolvedPlaylist,
  ResolvedVideo
} from '../../shared/ipc'
import './components/buttons.css'
import './App.css'

const NAV_TITLE: Record<NavKey, string> = {
  all: '全部任务',
  active: '下载中',
  completed: '已完成',
  failed: '失败',
  torrent: 'BT · 磁力',
  history: '下载历史',
  extension: '浏览器扩展',
  settings: '设置'
}

export default function App(): React.JSX.Element {
  const [nav, setNav] = useState<NavKey>('all')
  /**
   * 切到设置页时落在哪个分区(v0.4 Task 5)。`undefined` = 落最顶部(左导航点「设置」的既有行为)。
   *
   * 从「浏览器扩展」页点「前往设置页配置」时置为扩展分组的锚点 —— 不然跳过去停在最上方,
   * 跟用户自己点左下角「设置」没区别(2026-08-11 手测提出)。**锚点 id 是设置页的内部细节**,
   * 故在这里接线:扩展页只说「我要去设置页」,不需要知道那一页里分组叫什么 id。
   */
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined)
  /** 导航唯一入口:切走或从左导航进设置页都会清掉分区锚点(否则下次点「设置」还会跳到扩展组) */
  const gotoNav = (key: NavKey, section?: string): void => {
    setSettingsSection(key === 'settings' ? section : undefined)
    setNav(key)
  }
  // 类型筛选 chips 选中态(与 nav 并列、正交):'all' + 6 类(spec §4.4)
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilterKey>('all')
  // 主列表查询只活在 App 内存：跨筛选/独立页保留，真正卸载后清空；不落存储或发起查询。
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const clearSearch = (): void => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }
  const [addOpen, setAddOpen] = useState(false)
  const [defaultDir, setDefaultDir] = useState('')
  // 剪贴板监控(v0.2 Task 4):onClipboardLink 到达即置 clipboardLink 弹克制提示(不夺焦);
  // addInitialText = 「添加」入口预填的 URL(普通「+」入口置 '')
  const [clipboardLink, setClipboardLink] = useState<ClipboardLink | null>(null)
  const [addInitialText, setAddInitialText] = useState('')
  // 格式选择对话框:当前任务 + 其瞬时解析结果(单视频)
  const [fmtTaskId, setFmtTaskId] = useState<string | null>(null)
  const [fmtVideo, setFmtVideo] = useState<ResolvedVideo | null>(null)
  // 批量对话框:当前父任务 + 其瞬时解析结果(playlist)
  const [batchTaskId, setBatchTaskId] = useState<string | null>(null)
  const [batchPlaylist, setBatchPlaylist] = useState<ResolvedPlaylist | null>(null)
  // BT 文件选择对话框(v0.3 Task 2):当前种子任务 id(meta 直取 task.torrentMeta,无需单独存瞬时态)
  const [btTaskId, setBtTaskId] = useState<string | null>(null)
  // 代理状态(状态栏显示):启动拉取 + 订阅 proxy:statusChanged(Task 7)
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>()
  // 重复检测冲突队列(v0.2 Task 3):onTaskDuplicate 到达即入队,串行弹 DuplicateDialog、不丢弃
  const [dupQueue, setDupQueue] = useState<DuplicateConflict[]>([])
  // 已处理过自动弹窗的任务 id(防同一 awaiting_selection 重复弹)
  const dismissed = useRef<Set<string>>(new Set())
  // 有 pending 查重决策的任务 id(video conflictId=taskId / batch conflictId=parentId):
  // 这些 awaiting_selection 任务由 DuplicateDialog 处理,须抑制 FormatDialog / BatchDialog 自动弹(§6.2 不撞车)
  const parkedDuplicateIds = useRef<Set<string>>(new Set())
  const {
    tasks,
    counts,
    categories,
    addUrls,
    addVideo,
    addTorrent,
    getResolved,
    selectFormat,
    submitBatch,
    applyTorrentSelection,
    isSessionVideo,
    isSessionTorrent,
    pause,
    resume,
    cancel,
    removeTask,
    retry,
    setTaskLimit,
    stopSeeding,
    openFile,
    showInFolder,
    resolveDuplicate,
    startAll,
    pauseAll
  } = useTasks()

  // 读取配置的默认下载目录用于添加对话框预填(settings.defaultDir,非系统目录;SettingsService 已解析为绝对路径)
  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => setDefaultDir(s.defaultDir))
      .catch(() => {})
  }, [])

  // 代理状态:启动拉取一次 + 订阅主进程广播(切档 / 系统代理重读后即时刷新状态栏)
  useEffect(() => {
    window.api
      .getProxyStatus()
      .then(setProxyStatus)
      .catch(() => {})
    return window.api.onProxyStatusChanged(setProxyStatus)
  }, [])

  // 重复检测:订阅主进程 task:duplicate 广播 → 入队串行弹窗(§6.1);记 parked 任务 id 抑制自动弹格式对话框。
  // 冲突条目**不丢弃**:多冲突串行处理,当前处理完再弹下一个。
  useEffect(() => {
    return window.api.onTaskDuplicate((conflict) => {
      parkedDuplicateIds.current.add(conflict.conflictId)
      setDupQueue((q) => [...q, conflict])
    })
  }, [])

  // 剪贴板监控(v0.2 Task 4 · spec §9.2):订阅主进程 clipboard:linkDetected 广播 → 置 clipboardLink 弹克制提示。
  // 主进程只 webContents.send(不夺焦,§5.3);渲染层纯展示(§7.2)。新链接替换旧态(同时只一个,§5.1)。
  useEffect(() => {
    return window.api.onClipboardLink((link) => setClipboardLink(link))
  }, [])

  // 经 ref 持最新打开逻辑,使传给 TaskRow 的回调身份稳定(保 React.memo 优化)
  const openRef = useRef<(id: string) => Promise<void>>()
  // latest-ref 模式:render 期写入最新打开逻辑,供空 deps 的 onSelectFormat 稳定引用(保 React.memo);
  // 消费在用户点击的事件回调(commit 后),无并发读写风险。React 暂无稳定替代(useEffectEvent 仍实验),刻意保留。
  // eslint-disable-next-line react-hooks/refs
  openRef.current = async (id: string): Promise<void> => {
    // torrent 待选:文件清单在 task.torrentMeta(已随 task:list 在渲染层),直接开 BtFileDialog,
    // 不走 getResolved(torrent 不在 VideoResolver;与视频关键差异,§6.2)
    const task = tasks.find((t) => t.id === id)
    if (task?.kind === 'torrent') {
      setBtTaskId(id)
      return
    }
    const resolved = await getResolved(id)
    if (!resolved) return
    if (resolved.kind === 'video') {
      setFmtTaskId(id)
      setFmtVideo(resolved)
    } else {
      // playlist → 批量对话框(与单视频 FormatDialog 分流,§7)
      setBatchTaskId(id)
      setBatchPlaylist(resolved)
    }
  }
  const onSelectFormat = useMemo(() => (id: string) => void openRef.current?.(id), [])

  // 自动弹窗:仅对「本会话用户主动添加」的任务首次进入 awaiting_selection 时弹
  // (单视频 → 格式对话框 / playlist → 批量对话框 / 多文件种子 → BtFileDialog);重启恢复的 awaiting 任务不弹,
  // 等用户主动点「选择清晰度」/「选择文件」(修复①:避免一打开就被历史任务对话框轰炸)。
  // 有 pending 查重决策的任务(parkedDuplicateIds)由 DuplicateDialog 处理,抑制此处自动弹(§6.2 不撞车):
  // 尤其视频「默认清晰度自动选」分支命中冲突时(D4),任务转 awaiting_selection 但从未走过 FormatDialog,
  // 若不抑制会与 DuplicateDialog 撞车。torrent 不接查重(Task 1 定),故与 DuplicateDialog 天然不撞。
  useEffect(() => {
    if (fmtTaskId !== null || batchTaskId !== null || btTaskId !== null) return // 已开着对话框,不并发再开
    const target = tasks.find(
      (t) =>
        t.status === 'awaiting_selection' &&
        !dismissed.current.has(t.id) &&
        !parkedDuplicateIds.current.has(t.id) &&
        (isSessionVideo(t.id) || isSessionTorrent(t.id))
    )
    if (target) {
      dismissed.current.add(target.id)
      void openRef.current?.(target.id)
    }
    // isSessionVideo / isSessionTorrent 读 ref(语义稳定),不入 deps;tasks 变化时以最新闭包求值
  }, [tasks, fmtTaskId, batchTaskId, btTaskId]) // eslint-disable-line react-hooks/exhaustive-deps

  // nav → category → search 三维 AND 仅派生展示；计数/统计及全局批量始终消费原始 tasks。
  const visibleTasks = useMemo(
    () =>
      filterTasksBySearch(
        filterTasksByCategory(filterTasksByNav(tasks, nav), categoryFilter),
        searchQuery
      ),
    [tasks, nav, categoryFilter, searchQuery]
  )
  const stats = useMemo(() => statusBarStats(tasks), [tasks])

  // FormatDialog 落点显式目录:添加时若浏览过非默认目录,task.savePath(= join(显式目录, 占位名))的父目录
  // !== defaultDir → 该显式目录;否则(跟随)→ null。previewDir/landingDirForVideo 据此镜像 main 落点(spec §2.3)
  const fmtExplicitDir = useMemo(() => {
    const t = tasks.find((x) => x.id === fmtTaskId)
    if (!t) return null
    const parent = parentDir(t.savePath)
    return parent !== defaultDir ? parent : null
  }, [tasks, fmtTaskId, defaultDir])

  // BtFileDialog(v0.3 Task 2):meta 直取当前种子任务 torrentMeta;落点 <Torrents>/<种子名> 由 saveLocationView 派生(§7.2)
  const btTask = useMemo(() => tasks.find((t) => t.id === btTaskId) ?? null, [tasks, btTaskId])
  const btLandingDir = useMemo(
    () => landingDirForTorrent(defaultDir, btTask?.torrentMeta?.name ?? ''),
    [defaultDir, btTask]
  )

  const openAdd = (): void => {
    setAddInitialText('') // 普通「+」入口:不预填(剪贴板「添加」入口走 openAddWithUrl)
    setAddOpen(true)
    // 重拉最新默认目录:用户可能刚在设置页改过 defaultDir(无变更推送通道,故打开对话框时主动取最新)。
    // 对话框同步打开,预填随 getSettings 解析后即时更新 —— 避免预填旧/系统目录被 explicitDirOf 误判为「显式指定」
    // 而绕过分类路由 + 落错目录(修复 G:改默认目录后新任务仍落系统目录的问题)。
    window.api
      .getSettings()
      .then((s) => setDefaultDir(s.defaultDir))
      .catch(() => {})
  }

  // 剪贴板提示「添加」入口(spec §5.2):预填检测到的 URL 打开添加对话框,复用现有添加流程
  // (AddTaskDialog 内部 describeLink 照常识别视频 / 直链、addUrls / addVideo 照常提交、Task 3 查重照常生效)。
  const openAddWithUrl = (url: string): void => {
    setAddInitialText(url)
    setAddOpen(true)
    window.api
      .getSettings()
      .then((s) => setDefaultDir(s.defaultDir))
      .catch(() => {})
  }

  const closeFormat = (): void => {
    setFmtTaskId(null)
    setFmtVideo(null)
  }

  const closeBatch = (): void => {
    setBatchTaskId(null)
    setBatchPlaylist(null)
  }

  const closeBt = (): void => setBtTaskId(null)

  // 重复决策落地:调 resolveDuplicate(主进程按 decision 覆盖 / 跳过 / 重命名 / 打开清理)→ 出队 + 解除抑制。
  const dupCurrent = dupQueue[0] ?? null
  const resolveDup = (res: DuplicateResolution): void => {
    void resolveDuplicate(res)
    parkedDuplicateIds.current.delete(res.conflictId)
    setDupQueue((q) => q.slice(1))
  }
  // 「已存在·打开」:渲染层发起打开(§7.2)——completed 开文件,diskOnly 在文件夹中显示。
  const openExisting = (item: DuplicateConflictItem): void => {
    if (!item.existingPath) return
    if (item.existing === 'completed') void openFile(item.existingPath)
    else void showInFolder(item.existingPath)
  }
  // 关闭(取消 / × / Esc):不落地,任务留在 awaiting_selection 待稍后再决策(§6.2);仅出队,保留 parked 抑制
  const dismissDup = (): void => {
    setDupQueue((q) => q.slice(1))
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <Sidebar nav={nav} counts={counts} onNavChange={gotoNav} onAddClick={openAdd} />
        <div className="content">
          {nav === 'settings' ? (
            <SettingsPage initialSectionId={settingsSection} />
          ) : nav === 'history' ? (
            <HistoryPage />
          ) : nav === 'extension' ? (
            // 「浏览器扩展」页(v0.4 Task 5 · spec §5):独立页型,与 history / settings 同支路;
            // 页内「前往设置页配置」经 gotoNav 跳到设置页并**直达扩展分组**(锚点在此接线)
            <ExtensionPage onNavChange={(k) => gotoNav(k, 'set-extension')} />
          ) : (
            <>
              <Toolbar
                title={NAV_TITLE[nav]}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                onClearSearch={clearSearch}
                searchInputRef={searchInputRef}
                onStartAll={startAll}
                onPauseAll={pauseAll}
              />
              <CategoryChips
                categories={categories}
                value={categoryFilter}
                onChange={setCategoryFilter}
              />
              <TaskList
                tasks={visibleTasks}
                hasLoadedTasks={tasks.length > 0}
                searchActive={normalizeTaskSearchQuery(searchQuery) !== ''}
                onClearSearch={clearSearch}
                onAddClick={openAdd}
                onPause={pause}
                onResume={resume}
                onCancel={cancel}
                onRemove={removeTask}
                onRetry={retry}
                onLimit={setTaskLimit}
                onOpenFile={openFile}
                onShowInFolder={showInFolder}
                onSelectFormat={onSelectFormat}
                onStopSeeding={stopSeeding}
              />
            </>
          )}
        </div>
      </div>
      <StatusBar stats={stats} proxyStatus={proxyStatus} />
      {/* 剪贴板检测提示(v0.2 Task 4 · spec §9.2):addOpen 时抑制(用户正粘贴进对话框,再弹冗余,§5.3);
          「添加」→ 预填 URL 打开对话框 + 清提示;「忽略」/ 自动消失 → 仅清提示 */}
      <ClipboardPrompt
        link={addOpen ? null : clipboardLink}
        onAdd={(url) => {
          openAddWithUrl(url)
          setClipboardLink(null)
        }}
        onDismiss={() => setClipboardLink(null)}
      />
      <AddTaskDialog
        open={addOpen}
        defaultDir={defaultDir}
        initialText={addInitialText}
        onClose={() => setAddOpen(false)}
        onSubmit={(urls, dir) => {
          void addUrls(urls, dir)
        }}
        onSubmitVideo={(url, dir) => {
          void addVideo(url, dir)
        }}
        onSubmitTorrent={(source, dir) => {
          void addTorrent(source, dir)
        }}
      />
      <FormatDialog
        open={fmtTaskId !== null}
        video={fmtVideo}
        categories={categories}
        explicitDir={fmtExplicitDir}
        onClose={closeFormat}
        onSubmit={(choice) => {
          if (fmtTaskId) void selectFormat(fmtTaskId, choice)
          closeFormat()
        }}
      />
      <BatchDialog
        open={batchTaskId !== null}
        playlist={batchPlaylist}
        onClose={closeBatch}
        onSubmit={(picks, policy) => {
          if (batchTaskId) {
            // (picks, policy) → BatchPick[]:统一策略,各勾选条同值 choice(§7.3)
            void submitBatch(
              batchTaskId,
              picks.map((entryIndex) => ({ entryIndex, choice: policy }))
            )
          }
          closeBatch()
        }}
      />
      <DuplicateDialog
        open={dupCurrent !== null}
        conflict={dupCurrent}
        onResolve={resolveDup}
        onOpenExisting={openExisting}
        onClose={dismissDup}
      />
      <BtFileDialog
        open={btTaskId !== null}
        meta={btTask?.torrentMeta ?? null}
        landingDir={btLandingDir}
        onClose={closeBt}
        onSubmit={(indices) => {
          if (btTaskId) void applyTorrentSelection(btTaskId, indices)
          closeBt()
        }}
      />
    </div>
  )
}
