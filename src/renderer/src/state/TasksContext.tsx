import { useEffect, useMemo, useRef, useState } from 'react'
import type { CategoryConfig, Task, TaskProgress } from '../../../shared/ipc'
import { progressMerge } from '../lib/progressMerge'
import { countByNav } from '../lib/taskFilter'
import { Ctx, type TasksStore } from './tasksStore'
import { useToast } from './toastStore'

const FLUSH_MS = 200

const sortByCreated = (a: Task, b: Task): number => b.createdAt - a.createdAt

export function TasksProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  // 类别配置:启动拉取一次(category:list),供类型筛选 chips(Step 6)消费;过滤仍在渲染层做
  const [categories, setCategories] = useState<CategoryConfig[]>([])
  // 本会话用户主动添加的视频任务 id:仅对这些任务的 awaiting 自动弹对话框,重启恢复的不弹(修复①)
  const sessionVideoIds = useRef<Set<string>>(new Set())
  // 本会话用户主动添加的种子任务 id:仅对这些多文件种子 awaiting 自动弹 BtFileDialog(v0.3 Task 2,§7)
  const sessionTorrentIds = useRef<Set<string>>(new Set())
  const pending = useRef(new Map<string, TaskProgress>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const counts = useMemo(() => countByNav(tasks), [tasks])
  const { showToast } = useToast()

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      // 操作失败必须可见(2026-07-09):静默吞错时「暂停 / 继续点了没反应」无从分辨,
      // 主进程抛的已是可读中文(errorCatalog),直接透出;同时保留 console 供日志定位。
      console.error('[tasks] 操作失败:', e)
      showToast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const loadTasks = async (): Promise<void> => {
    const list = await window.api.listTasks()
    // 保留运行时富进度(v0.3 Task 3):seeding / uploadSpeed / uploadLength / numSeeders / connections 不落库,
    // 而 completed 做种帧会触发全量重拉(见 flush),DB 列表不含这些字段 → 若不回补,做种态每帧被冲掉、UI 闪断。
    // 按 id 从当前内存态回补(仿 progressMerge 的运行时语义);新任务(不在 prev)无需回补。
    setTasks((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]))
      return [...list]
        .map((t) => {
          const r = byId.get(t.id)
          return r
            ? {
                ...t,
                seeding: r.seeding,
                uploadSpeed: r.uploadSpeed,
                uploadLength: r.uploadLength,
                numSeeders: r.numSeeders,
                connections: r.connections
              }
            : t
        })
        .sort(sortByCreated)
    })
  }

  const loadCategories = async (): Promise<void> => {
    setCategories(await window.api.listCategories())
  }

  const refresh = async (): Promise<void> => guard(loadTasks)

  // 删除任务:乐观从列表剔除 → IPC(deleteFile 透传后端:completed 删文件 / 未完成清残留)→ 兜底重载对齐真源(§5)
  const removeTaskImpl = (id: string, deleteFile: boolean): Promise<void> =>
    guard(async () => {
      setTasks((prev) => prev.filter((task) => task.id !== id))
      try {
        await window.api.removeTask(id, deleteFile)
      } finally {
        await loadTasks()
      }
    })

  const flush = (): void => {
    timer.current = null
    const frames = [...pending.current.values()]
    pending.current.clear()
    if (frames.length === 0) return
    setTasks((prev) => progressMerge(prev, frames))
    // 完成帧:completedAt 未进 TaskProgress,yt-dlp after_move 校正也仍靠此处重拉。
    // HTTP 的 filename/savePath/category 已随进度合并,完成时仍追加一次全量重拉对齐
    // 真源,否则「完成时间 --」「打开文件指旧路径」整个会话无法自愈(批内多个完成共享一次重拉)
    //
    // 待选帧(v0.3 Task 2):torrent 转 awaiting_selection 时 torrentMeta 同样不在 TaskProgress 里,
    // BtFileDialog 直取 task.torrentMeta(不经 getResolved)→ 不重拉则 meta 恒 null、对话框弹不出;
    // 故 awaiting_selection 帧一并触发重拉拿回 torrentMeta(video 待选无害,仅多一次对齐,零回归)。
    if (frames.some((f) => f.status === 'completed' || f.status === 'awaiting_selection')) {
      void refresh()
    }
  }

  useEffect(() => {
    void refresh()
    void guard(loadCategories)
    const off = window.api.onTaskProgress((progress) => {
      pending.current.set(progress.id, progress)
      if (!timer.current) timer.current = setTimeout(flush, FLUSH_MS)
    })
    // v0.4 Task 4:接管路径由**主进程侧**建任务 —— 渲染层没有 invoke 可以顺手 refresh,
    // 而 progressMerge 只合并已在列表里的任务(新任务的进度帧会被整批丢弃)。故收到这条空载荷
    // 广播就重拉一次真源,否则新任务要等到「完成帧触发全量重拉」才突然出现(2026-08-02 真机)。
    const offAdded = window.api.onTaskAdded(() => {
      void refresh()
    })
    return () => {
      off()
      offAdded()
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      pending.current.clear()
    }
  }, [])

  const store: TasksStore = {
    tasks,
    counts,
    categories,
    refresh,
    reloadCategories: () => guard(loadCategories),
    moveExtension: (ext, fromKey, toKey) =>
      guard(async () => {
        const from = categories.find((c) => c.key === fromKey)
        const to = categories.find((c) => c.key === toKey)
        if (!from || !to) return
        // 旧类移除 → 新类加入(跨类唯一性由两步保证);权威规范化 / 落库在主进程(§7.2)
        await window.api.updateCategory(fromKey, {
          extensions: from.extensions.filter((e) => e !== ext)
        })
        await window.api.updateCategory(toKey, { extensions: [...to.extensions, ext] })
        await loadCategories()
      }),
    addUrls: (urls, dir) =>
      guard(async () => {
        for (const url of urls) {
          await window.api.addTask({ kind: 'http', source: url, dir })
        }
        await loadTasks()
      }),
    addVideo: (url, dir) =>
      guard(async () => {
        const id = await window.api.addTask({ kind: 'video', source: url, dir })
        sessionVideoIds.current.add(id)
        await loadTasks()
      }),
    // torrent 镜像 addVideo;v0.2 起不记 session,**v0.3 Task 2 反转**:记 sessionTorrentIds,
    // 使多文件种子解析出待选态时自动弹 BtFileDialog(重启恢复的不在本集合 → 不弹,§7)
    addTorrent: (source, dir) =>
      guard(async () => {
        const id = await window.api.addTask({ kind: 'torrent', source, dir })
        sessionTorrentIds.current.add(id)
        await loadTasks()
      }),
    pause: (id) => guard(() => window.api.pauseTask(id)),
    resume: (id) => guard(() => window.api.resumeTask(id)),
    // 停止做种(仿 pause):纯转发,主进程 forcePause + 清 runtime + 广播 {seeding:false}(§7.2)
    stopSeeding: (id) => guard(() => window.api.stopSeeding(id)),
    cancel: (id) => removeTaskImpl(id, false),
    removeTask: (id, deleteFile) => removeTaskImpl(id, deleteFile),
    retry: (id) => guard(() => window.api.retryTask(id)),
    // 单任务限速纯转发:kbps 三态(null=跟随全局 / 0=本任务不限 / N=限速值)原样透传主进程(#25)
    setTaskLimit: (id, kbps) => guard(() => window.api.setTaskLimit(id, kbps)),
    openFile: (path) =>
      guard(async () => {
        const err = await window.api.openPath(path)
        if (err) showToast(err, 'error')
      }),
    showInFolder: (path) =>
      guard(async () => {
        const err = await window.api.showItemInFolder(path)
        if (err) showToast(err, 'error')
      }),
    startAll: () =>
      guard(async () => {
        for (const task of tasks) {
          if (task.status === 'paused') await window.api.resumeTask(task.id)
        }
      }),
    pauseAll: () =>
      guard(async () => {
        for (const task of tasks) {
          if (task.status === 'downloading') await window.api.pauseTask(task.id)
        }
      }),
    // 只读拉取:需返回数据,故不套返回 void 的 guard,但沿用同一「吞错误 + 记日志」语义
    getResolved: async (id) => {
      try {
        return await window.api.getResolved(id)
      } catch (e) {
        console.error('[tasks] 操作失败:', e)
        return null
      }
    },
    selectFormat: (id, choice) =>
      guard(async () => {
        await window.api.selectFormat(id, choice)
        await loadTasks()
      }),
    submitBatch: (parentId, picks) =>
      guard(async () => {
        await window.api.submitBatch(parentId, picks)
        await loadTasks()
      }),
    // BT 文件选择定型(仿 selectFormat):上抛主进程 → 定型 + 出队 → 重拉列表反映 queued/downloading(§8)
    applyTorrentSelection: (id, selectedIndices) =>
      guard(async () => {
        await window.api.applyTorrentSelection(id, selectedIndices)
        await loadTasks()
      }),
    resolveDuplicate: (res) =>
      guard(async () => {
        await window.api.resolveDuplicate(res)
        // 覆盖 / 重命名会新建(http)或转 queued(video)任务 → 重拉列表使其即时可见(§6.1)
        await loadTasks()
      }),
    isSessionVideo: (id) => sessionVideoIds.current.has(id),
    isSessionTorrent: (id) => sessionTorrentIds.current.has(id)
  }

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}
