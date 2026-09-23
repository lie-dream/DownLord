/**
 * 接管确认小窗口的应用外壳(v0.4 Task 4 · spec §3.6 / §4.3)。
 *
 * 与主窗口 `App.tsx` **平级但独立**:这里**没有** ThemeProvider / TasksProvider / ToastProvider ——
 * 小窗口只做一件事(确认一次下载),不承载主界面的任何状态。
 *
 * ★ **握手方向刻意是「渲染层就绪后来拉」**(`ready()`),不是主进程先推:
 *   `present` 若早于挂载完成就 send,载荷会掉进虚空(黑洞的一个微型变体)。
 *   且 `ready()` 排在设置 / 类别都拿到之后 —— 那样第一帧的落点就是**最终落点**,不会先显空目录再跳。
 *
 * ★ 主题:小窗口不挂 `ThemeProvider`,故初值随 `takeover:present` 的 `batch.theme` 到达,
 *   呈现期间用户改主题由 `onThemeChanged`(复用既有 `theme:changed` 广播)跟上。
 *
 * ★ **查重队列(态 C)**:`takeover:duplicate` 到达即入队,**队首唯一渲染**、串行处理 ——
 *   形态照抄主窗口 `App.tsx` 的 `dupQueue`,只是 `window.api` 换成 `window.takeoverApi`。
 *   一批 4 条里若 3 条命中查重,就在**同一个窗口内**依次弹 3 次 `DuplicateDialog`。
 *   队列清空 → `duplicatesSettled()` 回报主进程 → 主进程推进下一批 / 关窗
 *   (**点完四决策才关窗**,Step 0 第 6 条)。
 */
import { useEffect, useRef, useState } from 'react'
import type {
  CategoryConfig,
  DuplicateConflict,
  DuplicateConflictItem,
  DuplicateResolution,
  ResolvedTheme,
  TakeoverItem,
  TakeoverSubmitPayload
} from '../../shared/ipc'
import TakeoverDialog from './components/TakeoverDialog'

/** 应用已解析主题(与主窗口 `ThemeProvider` 逐字同形:只改 `<html data-theme>`) */
function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

export default function TakeoverApp(): React.JSX.Element {
  const [items, setItems] = useState<TakeoverItem[]>([])
  const [defaultDir, setDefaultDir] = useState('')
  const [categories, setCategories] = useState<CategoryConfig[]>([])
  /** 查重冲突队列:到达即入队,队首唯一渲染、不丢弃(照抄 App.tsx 的形态) */
  const [dupQueue, setDupQueue] = useState<DuplicateConflict[]>([])
  /** 本批是否出现过查重 —— 只有出现过才需要在队列清空时回报 `settled`(没出现过主进程早就自己推进了) */
  const hadDuplicate = useRef(false)
  const resolvingDuplicate = useRef(false)
  const [duplicatePending, setDuplicatePending] = useState(false)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)

  useEffect(() => {
    // 小窗口内 preload 只 expose 了 takeoverApi(标记分支,spec §3.6),故此处必有值
    const api = window.takeoverApi
    if (!api) {
      // 真到不了这一步(B-03 产物级测试钉死了分支);万一走到,窗口会一直隐藏着不出现 ——
      // 如实喊一声,别让它无声消失(主进程侧另有 did-fail-load 的日志)
      console.error('[takeover] window.takeoverApi 缺失,确认框无法工作')
      return
    }

    const offPresent = api.onPresent((batch) => {
      applyTheme(batch.theme)
      // 整批送到:1 条 → 态 A,>1 条 → 态 B(判据在 TakeoverDialog 里,就这一条)
      setItems(batch.items)
      setDupQueue([])
      setDuplicateError(null)
      hadDuplicate.current = false
    })
    const offDuplicate = api.onDuplicate((conflict) => {
      hadDuplicate.current = true
      setDupQueue((q) => [...q, conflict])
    })
    const offTheme = api.onThemeChanged(applyTheme)

    // 先把落点算料备齐,再 ready() —— 免得第一帧显示一个还没算准的目录
    void Promise.all([api.getSettings(), api.listCategories()])
      .then(([settings, cats]) => {
        setDefaultDir(settings.defaultDir)
        setCategories(cats)
      })
      .catch(() => {
        // 拿不到设置也要把窗口带起来(落点回落到主进程的分类路由),不能卡在空白窗口里
      })
      .finally(() => api.ready())

    return () => {
      offPresent()
      offDuplicate()
      offTheme()
    }
  }, [])

  const submit = (payload: TakeoverSubmitPayload): void => window.takeoverApi?.submit(payload)
  const dismiss = (): void => window.takeoverApi?.dismiss()
  const browse = async (): Promise<string | null> =>
    (await window.takeoverApi?.selectDirectory()) ?? null

  /** 四决策落地 + 出队;队列空了就回报主进程(它据此推进下一批 / 关窗) */
  const resolveDup = (res: DuplicateResolution): void => {
    if (resolvingDuplicate.current) return
    resolvingDuplicate.current = true
    setDuplicatePending(true)
    setDuplicateError(null)
    void (async () => {
      try {
        await window.takeoverApi?.resolveDuplicate(res)
        setDupQueue((q) => {
          const rest = q.slice(1)
          if (rest.length === 0 && hadDuplicate.current) {
            hadDuplicate.current = false
            window.takeoverApi?.duplicatesSettled()
          }
          return rest
        })
      } catch (err) {
        // 严格覆盖可能因占用/回收失败被拒绝;保留原决策框,不能提前关窗吞掉错误。
        setDuplicateError(
          err instanceof Error ? err.message : '处理重复下载失败,请重试或选择重命名'
        )
      } finally {
        resolvingDuplicate.current = false
        setDuplicatePending(false)
      }
    })()
  }

  /** 「已存在·打开」:渲染层发起打开(§7.2)——completed 开文件,diskOnly 在文件夹中显示 */
  const openExisting = (item: DuplicateConflictItem): void => {
    if (!item.existingPath) return
    void (item.existing === 'completed'
      ? window.takeoverApi?.openPath(item.existingPath)
      : window.takeoverApi?.showItemInFolder(item.existingPath))
  }

  return (
    <TakeoverDialog
      items={items}
      conflict={dupQueue[0] ?? null}
      duplicatePending={duplicatePending}
      duplicateError={duplicateError}
      defaultDir={defaultDir}
      categories={categories}
      onSubmit={submit}
      onDismiss={dismiss}
      onBrowse={browse}
      onResolveDuplicate={resolveDup}
      onOpenExisting={openExisting}
    />
  )
}
