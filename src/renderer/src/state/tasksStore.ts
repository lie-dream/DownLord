import { createContext, useContext } from 'react'
import type {
  BatchPick,
  CategoryConfig,
  DuplicateResolution,
  FormatChoice,
  ResolveResult,
  Task
} from '../../../shared/ipc'
import type { NavCounts } from '../lib/types'

// 任务仓库契约 + Context + useTasks —— 从 TasksContext.tsx 拆出(react-refresh:组件文件不应混合导出
// hook / 类型,否则 Fast Refresh 失效)。这些均为非组件,Provider 组件仍留 TasksContext.tsx。
export interface TasksStore {
  tasks: Task[]
  counts: NavCounts
  /** 类别配置(启动经 category:list 拉取一次),供类型筛选 chips 文案 / 顺序(Step 6 chips 消费) */
  categories: CategoryConfig[]
  refresh(): Promise<void>
  /** 重拉类别配置(category:list);改默认目录 / 类别目录 / extensions 后真实目录与扩展名集重算,据此刷新「分类与保存位置」组显示与 knownFileExts */
  reloadCategories(): Promise<void>
  /**
   * 扩展名跨类迁移(设置页冲突确认后):旧类 fromKey 移除 + 新类 toKey 加入 + 重拉刷新(spec §5.3)。
   * 两次既有 category:update 的有序编排(非新业务校验);规范化 / 落库权威在主进程(§7.2)。
   */
  moveExtension(ext: string, fromKey: string, toKey: string): Promise<void>
  addUrls(urls: string[], dir: string): Promise<void>
  /** 添加视频任务(kind:'video' → resolving;解析 / 格式选择由 video IPC 驱动) */
  addVideo(url: string, dir: string): Promise<void>
  /**
   * 添加种子任务(kind:'torrent' → resolving;元数据 / 下载由 BT 引擎驱动,v0.3 Task 1 · spec §10.2)。
   * 严格镜像 addVideo,唯一差异:torrent 无格式选择对话框,故**不记 sessionVideoIds**。
   */
  addTorrent(source: string, dir: string): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(id: string): Promise<void>
  /** 删除任务;deleteFile=true → completed 成品移回收站,false → 仅移记录 / 未完成态后端清残留(§5,§7.3) */
  removeTask(id: string, deleteFile: boolean): Promise<void>
  retry(id: string): Promise<void>
  /**
   * 单任务限速 KB/s → window.api.setTaskLimit(§6.4);aria2 即时 / video 下次继续生效。
   * 三态(v0.3 Task 4 #25):`null` = 清除覆盖 = 跟随全局 / `0` = 本任务不限 / `>0` = 限速值。
   */
  setTaskLimit(id: string, kbps: number | null): Promise<void>
  openFile(path: string): Promise<void>
  showInFolder(path: string): Promise<void>
  startAll(): Promise<void>
  pauseAll(): Promise<void>
  /** 取视频瞬时解析结果(格式 / 批量对话框拉取;失败 / 未解析 → null) */
  getResolved(id: string): Promise<ResolveResult | null>
  /** 选定格式(用户 / 自动)→ 入队下载 */
  selectFormat(id: string, choice: FormatChoice): Promise<void>
  /** 播放列表批量提交,展开为 N 子任务 */
  submitBatch(parentId: string, picks: BatchPick[]): Promise<void>
  /**
   * 提交 BT 文件选择(勾选的 1-based 索引集)→ 主进程定型 files[].selected + 出队下载(v0.3 Task 2 · spec §8)。
   * 仿 selectFormat:guard + loadTasks;校验 / 定型 / select-file 映射 / 落点全在主进程 TaskManager(§7.2)。
   */
  applyTorrentSelection(id: string, selectedIndices: number[]): Promise<void>
  /**
   * 停止单任务做种(v0.3 Task 3 · spec §7):仿 pause,纯转发 window.api.stopSeeding。
   * 校验(torrent + 做种中)/ 引擎 forcePause / 清 runtime / 广播 {seeding:false} 全在主进程 TaskManager(§7.2);
   * 渲染层零业务。**只对「已 completed + 做种中」torrent 生效**;做种数据经 TaskProgress 广播即时回落 UI。
   */
  stopSeeding(id: string): Promise<void>
  /**
   * 提交重复检测决策(v0.2 Task 3 · spec §8):覆盖 / 跳过 / 重命名 / 已存在。
   * 落地后重拉任务列表 —— 覆盖 / 重命名会新建任务、需即时出现在列表(§6.1)。
   */
  resolveDuplicate(res: DuplicateResolution): Promise<void>
  /** 该任务是否本会话用户主动添加的视频(仅对新解析的 awaiting 自动弹对话框,重启恢复的不弹) */
  isSessionVideo(id: string): boolean
  /** 该任务是否本会话用户主动添加的种子(仅对新解析的多文件种子 awaiting 自动弹 BtFileDialog,重启恢复的不弹,v0.3 Task 2 · §7) */
  isSessionTorrent(id: string): boolean
}

export const Ctx = createContext<TasksStore | null>(null)

export const useTasks = (): TasksStore => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTasks 必须在 TasksProvider 内')
  return v
}
