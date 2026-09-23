/**
 * 设置页 — 分组导航(外观 / 通用 / 下载 / 分类与保存位置 / 代理 / 浏览器扩展 / 视频 / BT · 磁力 / 关于),复刻原型 prototype-downlord.html 设置页(line 538–651)。
 *
 * - 渲染纯 UI(ARCHITECTURE §7.2):一切读写经 window.api;校验 / 持久化 / 联动权威在主进程 SettingsService,组件不写业务逻辑。
 * - 外观主题三档从 SettingsPlaceholder 归位(接 §5 持久化,经 ThemeContext);代理直接嵌 <ProxySettings/>(自包含,零改动);
 *   浏览器扩展同理嵌 <ExtensionChannelSettings/>(v0.4 Task 3,自包含:自己读 IPC / 自己订阅状态广播,本页零业务)。
 * - 下载 / 视频读全量 settings(挂载 getSettings 回显;改值经 setSettings 回 clamp 后最新全量);
 *   分类读 useTasks().categories(category:list 下发 extensions/savePath),过滤 other(其目录恒=默认目录,已在下载组)。
 * - 分区导航(spec §4):两栏 .settings-layout(左 .set-nav 竖向子导航 + 右 .settings-scroll 滚动容器);
 *   点击 → scrollIntoView({behavior:'smooth'});当前区高亮经 IntersectionObserver(root=.settings-scroll)。纯滚动 / observer,零 IPC;
 *   选中项左侧 3px 主色指示条复刻 DESIGN §3 左导航(复用 --brand,绝不另造色值)。
 * - token / class 复刻原型 + theme/tokens.css,绝不另造色值(DESIGN §1/§6);.switch/.select 来自全局 controls.css。
 */

import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_COOKIE_CONFIG,
  DEFAULT_SUBTITLE_CHOICE,
  type AppSettings,
  type AppSettingsPatch,
  type BtTrackerStatus,
  type CategoryConfig,
  type CookieBrowser,
  type CookieSource,
  type EngineVersions,
  type InboundDiagnosis,
  type InboundReachability,
  type ThemeMode,
  type UpdatePhase,
  type UpdateStatus,
  type VideoPrefs
} from '../../../shared/ipc'
import { useTheme } from '../state/themeStore'
import { useTasks } from '../state/tasksStore'
import { useToast } from '../state/toastStore'
import ProxySettings from './ProxySettings'
import ExtensionChannelSettings from './ExtensionChannelSettings'
import './controls.css'
import './SettingsPage.css'

/* ============ 行首图标(.sr-icon)============
 * video/audio/document 与 TaskRow 类别图标同源(同 SVG path);archive(box)/program(terminal)/
 * folder/sliders/info 复刻原型设置页专属图标。统一 svgProps(同 TaskRow)。 */
const svgProps = {
  className: 'sr-icon',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

const IconFolder = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
)
const IconSliders = (): React.JSX.Element => (
  <svg {...svgProps}>
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
)
const IconVideo = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="m22 8-6 4 6 4V8Z" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </svg>
)
const IconAudio = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
)
const IconBox = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
)
const IconFileText = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <path d="M14 2v6h6" />
  </svg>
)
const IconTerminal = (): React.JSX.Element => (
  <svg {...svgProps}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)
const IconInfo = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
)
const IconKey = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
)
const IconCaptions = (): React.JSX.Element => (
  <svg {...svgProps}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 15h4" />
    <path d="M15 15h2" />
    <path d="M7 11h2" />
    <path d="M13 11h4" />
  </svg>
)
const IconGauge = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </svg>
)
const IconZap = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </svg>
)
const IconClipboard = (): React.JSX.Element => (
  <svg {...svgProps}>
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
)

/** 分类 key → 行首图标(video/audio 专属,archive=box / document=file-text / program=terminal,复刻原型) */
const CATEGORY_ICON: Record<string, () => React.JSX.Element> = {
  video: IconVideo,
  audio: IconAudio,
  archive: IconBox,
  document: IconFileText,
  program: IconTerminal
}

/** 轻量规范化单个扩展名(仅渲染层即时回显 / 冲突检测;权威规范化 / 落库在主进程 §7.2) */
function normalizeOne(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, '').trim()
}

/* ============ 外观(主题三档,接 §5 持久化经 ThemeContext)============ */
const MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

function AppearanceSection(): React.JSX.Element {
  const { themeMode, resolvedTheme, setTheme } = useTheme()
  return (
    <div className="set-group">
      <div className="sg-title">外观</div>
      <div className="set-card">
        <div className="set-row">
          <div className="sr-text">
            <div className="sr-title">主题</div>
            <div className="sr-desc">当前生效:{resolvedTheme === 'dark' ? '深色' : '浅色'}</div>
          </div>
          <div className="sr-control theme-seg">
            {(['system', 'light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                className={`btn ${themeMode === mode ? 'btn-primary' : 'btn-default'}`}
                onClick={() => setTheme(mode)}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ 通用(剪贴板监控;隐私诚实,默认关,spec §6/§9.4)============
 * 独立「通用」组给隐私说明应有的显著位,并为后续通用开关留位。剪贴板监控开关经既有 settings:set 通道
 * 落 clipboardWatch;主进程 onChange 联动即时启停 ClipboardWatcher(渲染纯 UI,校验 / 联动权威在主进程 §7.2)。 */
function GeneralSection({
  settings,
  onPatch
}: {
  settings: AppSettings
  onPatch: (patch: AppSettingsPatch) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="set-group">
      <div className="sg-title">通用</div>
      <div className="set-card">
        <div className="set-row">
          <IconClipboard />
          <div className="sr-text">
            <div className="sr-title">剪贴板监控</div>
            {/* 诚实文案(spec §6.3):开什么 / 内容去哪 / 仅运行时 / 不打断 —— 不上传、不保存、不记录 */}
            <div className="sr-desc">
              开启后,应用运行时会读取剪贴板文本以识别下载链接。内容仅在本机识别,不上传、不保存、不记录;仅在应用运行时生效,退出即停。复制到可下载链接时,右下角会出现「添加」提示(不打断你的操作)。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={settings.clipboardWatch}
              aria-label="剪贴板监控"
              className={`switch${settings.clipboardWatch ? ' on' : ''}`}
              onClick={() => void onPatch({ clipboardWatch: !settings.clipboardWatch })}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ 下载(默认目录 + 最大并发 + 全局限速)============ */

/** 限速单位:MB/s(默认)/ KB/s */
type SpeedUnit = 'MB' | 'KB'

/** 显示值 → KB/s 整数(空 / 非有限 / <=0 → 0 = 不限速;主进程仍 clampSpeedLimit,§5.1) */
function toKbps(display: string, unit: SpeedUnit): number {
  const n = parseFloat(display)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * (unit === 'MB' ? 1024 : 1))
}

/**
 * 默认目录旁的两条既定取舍(v1.0 Task 3 `M-005` / `M-012-b`;逐字真源在 spec §4「如实说清单」)。
 *
 * 🔴 **这两句原先只活在本文件头注释与 `CONTEXT.md` 词条里,UI 上查无此物** —— 而那正是它们
 *   在 v1.0 Task 2 手测里被当成缺陷重新捡回来的原因(改完目录发现老文件没搬 / 设置页找不到「其他」类)。
 *   **既定取舍必须说出来才叫诚实**:不说,取舍就变成了「看起来像 bug 的行为」。
 * ⚠️ 两句**各自独立成句**、由**两条独立用例**分别钉住 —— 合成一句会让其中一条失去护栏。
 */
const DEFAULT_DIR_NO_MIGRATE_NOTE =
  '改默认目录只对之后的任务生效:已下载的文件留在原地不搬,历史里记的仍是原路径。'
const DEFAULT_DIR_OTHER_CATEGORY_NOTE =
  '未匹配任何类别的文件(「其他」)保存在默认目录,故它不单列在「分类与保存位置」里。'

/**
 * KB/s → 该单位显示串(0 → 空;KB 原样;MB 取 0–4 位小数中**最短且能经 toKbps 换算回同一 KB/s** 的那个:
 * 2048 → "2"、512 → "0.5"、102 → "0.1"、10 → "0.01"、1500 → "1.465";4 位小数误差 ≤ 0.0512 KB/s,必能回到原值;§5.1)。
 * 2026-09-18 实机卡口 F1:旧实现固定一位小数,10 KB/s 切 MB/s 显「0.0」,再失焦会把限速静默改成 0 = 不限。
 */
function displayLimit(kbps: number, unit: SpeedUnit): string {
  if (kbps <= 0) return ''
  if (unit === 'KB') return String(kbps)
  const mb = kbps / 1024
  for (let digits = 0; digits < 4; digits++) {
    const s = mb.toFixed(digits)
    if (toKbps(s, 'MB') === kbps) return s
  }
  return mb.toFixed(4)
}

function DownloadSection({
  settings,
  sysDir,
  onPatch
}: {
  settings: AppSettings
  sysDir: string
  onPatch: (patch: AppSettingsPatch) => Promise<void>
}): React.JSX.Element {
  // 并发滑块本地态:拖动实时更新显示(.sv),松手 / 键盘抬起才提交(避免每帧调 IPC)
  const [concurrent, setConcurrent] = useState(settings.maxConcurrent)
  // 外部 settings.maxConcurrent 变化 → 同步本地态(React 官方「渲染期调整 state」模式,替代 effect:无级联渲染)
  const [prevMaxConcurrent, setPrevMaxConcurrent] = useState(settings.maxConcurrent)
  if (settings.maxConcurrent !== prevMaxConcurrent) {
    setPrevMaxConcurrent(settings.maxConcurrent)
    setConcurrent(settings.maxConcurrent)
  }

  // 全局限速本地态(数值 + 单位):onBlur / Enter 提交(仿并发,避免每次按键调 IPC);默认 MB/s 回显(§5.1)
  const [limitUnit, setLimitUnit] = useState<SpeedUnit>('MB')
  const [limitVal, setLimitVal] = useState(() => displayLimit(settings.maxOverallLimitKBps, 'MB'))
  // 落盘值变化(外部回写)→ 按当前单位重新回显;单位切换在 changeUnit 内自处理,不触发此同步。
  // React 官方「渲染期调整 state」模式:仅当 maxOverallLimitKBps 变化时回写(用当前 limitUnit 换算),替代 effect。
  const [prevLimitKBps, setPrevLimitKBps] = useState(settings.maxOverallLimitKBps)
  if (settings.maxOverallLimitKBps !== prevLimitKBps) {
    setPrevLimitKBps(settings.maxOverallLimitKBps)
    setLimitVal(displayLimit(settings.maxOverallLimitKBps, limitUnit))
  }

  const dir = settings.defaultDir || sysDir
  const pct = `${((concurrent - 1) / 9) * 100}%`

  const browse = async (): Promise<void> => {
    const picked = await window.api.selectDirectory()
    if (picked) void onPatch({ defaultDir: picked })
  }
  const commit = (): void => {
    if (concurrent !== settings.maxConcurrent) void onPatch({ maxConcurrent: concurrent })
  }
  // 换算 KB/s → 落库(仅变化才 patch);value<=0 / 空 → 0(不限速)
  const commitLimit = (): void => {
    const kbps = toKbps(limitVal, limitUnit)
    if (kbps !== settings.maxOverallLimitKBps) void onPatch({ maxOverallLimitKBps: kbps })
  }
  // 单位切换:保持当前速率不变,按新单位重算显示串(不触发提交,由 onBlur / Enter 提交)
  const changeUnit = (next: SpeedUnit): void => {
    const kbps = toKbps(limitVal, limitUnit)
    setLimitUnit(next)
    setLimitVal(displayLimit(kbps, next))
  }

  return (
    <div className="set-group">
      <div className="sg-title">下载</div>
      <div className="set-card">
        <div className="set-row">
          <IconFolder />
          <div className="sr-text">
            <div className="sr-title">默认保存位置</div>
            <div className="sr-desc">新任务默认下载到此文件夹</div>
            {/* v1.0 Task 3 `M-005` / `M-012-b`:两条既定取舍**说出来**(此前只在文件头注释里) */}
            <div className="sr-desc">{DEFAULT_DIR_NO_MIGRATE_NOTE}</div>
            <div className="sr-desc">{DEFAULT_DIR_OTHER_CATEGORY_NOTE}</div>
          </div>
          <div className="sr-control path-row">
            <input className="input" style={{ width: 220 }} value={dir} readOnly />
            <button className="btn btn-default" onClick={browse}>
              浏览
            </button>
          </div>
        </div>
        <div className="set-row">
          <IconSliders />
          <div className="sr-text">
            <div className="sr-title">最大同时下载数</div>
            <div className="sr-desc">超出的任务进入排队队列</div>
          </div>
          <div className="sr-control slider-wrap">
            <input
              type="range"
              min={1}
              max={10}
              value={concurrent}
              aria-label="最大同时下载数"
              style={{ '--pct': pct } as React.CSSProperties}
              onChange={(e) => setConcurrent(Number(e.target.value))}
              onMouseUp={commit}
              onKeyUp={commit}
            />
            <span className="sv">{concurrent}</span>
          </div>
        </div>
        {/* 全局限速(§5.1;数值 .input + 单位 .select — 对 .slider-wrap 的合理偏差,值域跨度大且需精确)。
            诚实文案(v1.0 Task 8 · #100):每任务上限、不承诺总带宽、不承诺「精确保证不超速」 */}
        <div className="set-row">
          <IconGauge />
          <div className="sr-text">
            <div className="sr-title">下载限速(全局)</div>
            <div className="sr-desc">
              每个任务各自的上限,单任务限速可覆盖;多个任务同时下载时总速度可能超过此值;0 =
              不限速;正在下载的视频任务在下次继续时生效
            </div>
          </div>
          <div className="sr-control limit-control">
            <input
              className="input limit-input"
              type="number"
              min={0}
              step={0.1}
              placeholder="不限速"
              aria-label="下载限速"
              value={limitVal}
              onChange={(e) => setLimitVal(e.target.value)}
              onBlur={commitLimit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  // 2026-09-18 实机卡口 F2:原直接 commitLimit(),焦点仍在框内、零可见反馈,被读成「Enter 无效」;
                  // 改为失焦 → 经 onBlur 提交恰一次(反馈与点别处一致,且不重复 patch)
                  e.currentTarget.blur()
                }
              }}
            />
            <select
              className="select"
              aria-label="限速单位"
              value={limitUnit}
              onChange={(e) => changeUnit(e.target.value as SpeedUnit)}
            >
              <option value="MB">MB/s</option>
              <option value="KB">KB/s</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ 分类与保存位置(收编 Task 6;过滤 other)============
 * 显示 category:list 下发的「解析后真实目录」(c.savePath;main resolveCategoryDir 解析,显示 ≡ 落盘):
 * - isCustom(自定义绝对路径)→ 正常色 + 「自定义」标签 + 「重置为默认」(updateCategory(key,{savePath:''}));
 * - !isCustom(跟随默认目录)→ 次文字色、无重置;改默认目录后真实目录自动重算(无 C2 同步,spec §1.7)。
 * 浏览 / 重置后 reloadCategories() 重取真实目录刷新显示。渲染纯 UI,不拼路径(§7.2)。
 *
 * extensions 在线编辑(spec §5):每类扩展名为 .chip 标签(可删 ×)+ 末尾输入框新增(Enter / 失焦提交);
 * 改后经 window.api.updateCategory(key,{extensions}) 落库(权威规范化在主进程)+ reloadCategories 实时同步路由 / 识别。
 * 冲突(新增 ext 已属他类 Y)→ 弹确认迁移 → moveExtension(两次 updateCategory + 刷新);取消 no-op(§5.3)。 */
function CategorySection(): React.JSX.Element {
  const { categories, reloadCategories, moveExtension } = useTasks()
  // 待确认的扩展名跨类迁移(冲突:新增 ext 已属他类);null = 无冲突 / 无弹窗
  const [conflict, setConflict] = useState<{
    ext: string
    fromKey: string
    fromName: string
    toKey: string
    toName: string
  } | null>(null)

  const browse = async (key: string): Promise<void> => {
    const picked = await window.api.selectDirectory()
    if (!picked) return
    await window.api.updateCategory(key, { savePath: picked })
    await reloadCategories()
  }

  const reset = async (key: string): Promise<void> => {
    // 重置为「跟随默认目录」:savePath='' → 下次解析按默认目录子目录实时算(spec §1.1）
    await window.api.updateCategory(key, { savePath: '' })
    await reloadCategories()
  }

  // 删除扩展名:落库经既有 updateCategory + 刷新(规范化权威在主进程 §7.2)
  const removeExt = async (cat: CategoryConfig, ext: string): Promise<void> => {
    await window.api.updateCategory(cat.key, {
      extensions: cat.extensions.filter((e) => e !== ext)
    })
    await reloadCategories()
  }

  // 新增扩展名:轻量规范化(仅即时回显 / 冲突检测)→ 已在本类 no-op / 已属他类弹确认迁移 / 否则直接加入(§5.1 / §5.3)
  const addExt = async (cat: CategoryConfig, raw: string): Promise<void> => {
    const ext = normalizeOne(raw)
    if (!ext || cat.extensions.includes(ext)) return
    const owner = categories.find((c) => c.key !== cat.key && c.extensions.includes(ext))
    if (owner) {
      setConflict({
        ext,
        fromKey: owner.key,
        fromName: owner.displayName,
        toKey: cat.key,
        toName: cat.displayName
      })
      return
    }
    await window.api.updateCategory(cat.key, { extensions: [...cat.extensions, ext] })
    await reloadCategories()
  }

  const confirmMove = async (): Promise<void> => {
    if (!conflict) return
    await moveExtension(conflict.ext, conflict.fromKey, conflict.toKey)
    setConflict(null)
  }

  // 过滤 other(其目录恒=默认下载目录,已在「下载」组配置;spec §2 / §4.2)
  const rows = categories.filter((c) => c.key !== 'other')

  return (
    <div className="set-group">
      <div className="sg-title">分类与保存位置</div>
      <div className="set-card">
        {rows.map((c) => {
          const Icon = CATEGORY_ICON[c.key] ?? IconFileText
          return (
            <div className="set-row" key={c.key}>
              <Icon />
              <div className="sr-text">
                <div className="sr-title">
                  {c.displayName}
                  {c.isCustom && <span className="cat-tag">自定义</span>}
                </div>
                <div className="ext-tags">
                  {c.extensions.map((ext) => (
                    <span className="chip ext-chip" key={ext}>
                      {ext}
                      <button
                        type="button"
                        className="ext-x"
                        aria-label={`删除 ${ext}`}
                        onClick={() => void removeExt(c, ext)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <ExtAddInput onAdd={(raw) => void addExt(c, raw)} />
                </div>
              </div>
              <div className="sr-control path-row">
                <input
                  className={`input cat-dir${c.isCustom ? '' : ' follow'}`}
                  style={{ width: 190 }}
                  value={c.savePath}
                  readOnly
                />
                {c.isCustom && (
                  <button className="btn btn-subtle" onClick={() => reset(c.key)}>
                    重置为默认
                  </button>
                )}
                <button className="btn btn-default" onClick={() => browse(c.key)}>
                  浏览
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 冲突迁移确认(spec §5.3;复用 .overlay/.dialog,非原生 confirm) */}
      {conflict && (
        <div className="overlay show">
          <div className="dialog conflict-dialog">
            <div className="dialog-head">
              <h3>扩展名冲突</h3>
              <button
                className="dialog-close"
                onClick={() => setConflict(null)}
                title="关闭"
                aria-label="关闭"
              >
                <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
            <div className="dialog-body">
              <p className="conflict-msg">
                .{conflict.ext} 当前属于「{conflict.fromName}」类,改归「{conflict.toName}」类?
              </p>
            </div>
            <div className="dialog-foot">
              <button className="btn btn-default" onClick={() => setConflict(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void confirmMove()}>
                改归「{conflict.toName}」
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 末尾「添加扩展名」输入:本地态,Enter / 失焦提交(空值 no-op);融入标签流(spec §5.1) */
function ExtAddInput({ onAdd }: { onAdd: (raw: string) => void }): React.JSX.Element {
  const [val, setVal] = useState('')
  const commit = (): void => {
    const v = val.trim()
    if (v) onAdd(v)
    setVal('')
  }
  return (
    <input
      className="ext-add"
      placeholder="+ 添加"
      aria-label="添加扩展名"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      onBlur={commit}
    />
  )
}

/* ============ 视频(默认清晰度 + 默认提取音频;联动 Task 5 getVideoPrefs)============ */
// 「最高可用」MVP 封顶 2160(经 autoSelectChoice heightCap 选 ≤2160 最佳);「每次都问我」→ null(弹格式对话框)
const HEIGHT_OPTIONS: { label: string; value: number | null }[] = [
  { label: '最高可用', value: 2160 },
  { label: '1080P', value: 1080 },
  { label: '720P', value: 720 },
  { label: '480P', value: 480 },
  { label: '每次都问我', value: null }
]
const heightToStr = (h: number | null): string => (h === null ? 'ask' : String(h))
const strToHeight = (v: string): number | null => (v === 'ask' ? null : Number(v))

/** Cookie 来源四档 label(诚实措辞,spec §5.3;「从文件」标高级,弱化——2026-07-04 用户决策 TODO #23) */
const COOKIE_SOURCE_LABEL: Record<CookieSource, string> = {
  none: '不使用',
  browser: '从浏览器',
  file: '从 Cookie 文件(高级)',
  // v0.4 Task 6 Phase 4:第四档已上架下拉(顺序见下方 COOKIE_SOURCE_ORDER),引擎侧 Step 3a/3b 已接通。
  extension: '从扩展获取'
}
/**
 * 下拉里的**档位顺序**(v0.4 Task 6 · plan Phase 4):none → browser → **extension** → file(高级)。
 *
 * ⚠️ **这是第二份档位清单**,与 `COOKIE_SOURCE_LABEL` 的失效形态完全不同:那份是
 *   `Record<CookieSource, string>`,加档漏了 label **编译期就红**;而这份是字面量数组,
 *   加档不写进来只会**静默上不了架**(HEAD 上第四档就是这么被按住的)。**加档两处必须同改。**
 */
const COOKIE_SOURCE_ORDER = ['none', 'browser', 'extension', 'file'] as const
/**
 * Cookie 来源主说明(v0.4 Task 6 · plan Phase 4 的逐字文案;v1.0 Task 3 `M-003` 改写)。
 *
 * ⚠️ **写成模块级字符串常量而非 JSX 文本,是为了防 prettier 折行**:红线 R11 的 A-5 禁词扫描
 *   逐**行**剔除否定式(`| grep -v "不保证"`),一旦「不保证可下载受限内容」被折成两行,
 *   后半行就成了一条**命中禁词却不含「不保证」**的假红。字符串字面量 prettier 不拆。
 *
 * 🔴 **v1.0 Task 3 `M-003`:去掉「Chrome / Edge **运行中时**通常无法读取」这个时机限定。**
 *   它把用户导向一个**在本机实测过的两家 Chromium 浏览器上全部无效**的动作(关掉浏览器再试)——
 *   v1.0 Task 2 手测 N01–N04 实测:Chrome 152 / Edge 152 **进程全部退出后仍然失败**,
 *   成因是 Chrome 127+ 的应用绑定加密(ABE),与浏览器是否运行无关。
 *   ⇒ 改为「确定句(读不到)+ 推论句(去用 Firefox 或第四档)」,并附实测版本号。
 * 🚫 **不自己绕过 ABE**(需调 Chrome elevation service 或进程注入,与安全红线冲突且会被杀软报毒)。
 */
const COOKIE_SOURCE_DESC =
  '使用你浏览器中已登录的 Cookie 帮助 yt-dlp 访问需登录的内容,不保证可下载受限内容。「从浏览器」由 yt-dlp 直接读取浏览器的 Cookie 数据库;Chrome / Edge 的新版加密方式使 DownLord 无论浏览器是否运行都读不到(实测 Chrome 152 / Edge 152),Firefox 可以读到(实测 Firefox 154,运行中亦可)。「从扩展获取」则由 DownLord 浏览器扩展在你点击下载时按需提供登录态,不受此限制。'
/**
 * 第四档首次说明的五条(v0.4 Task 6 · plan Phase 4 逐字文案;防折行理由同 `COOKIE_SOURCE_DESC`)。
 *
 * ⚠️ **第 4 条是 D7 ② 定死的**:「取消某个下载不会清除已暂借的登录态」必须点名说出来 ——
 *   不说,「取消不清除」就从一条**用户知情的取舍**变成了**偷偷留存**。
 */
const EXTENSION_COOKIE_NOTICE: readonly string[] = [
  '你在扩展里点击下载时,DownLord 会点名向扩展请求该站点的 Cookie;未被点名的站点,Cookie 从不离开浏览器。',
  '取到的登录态只存在于内存,不写配置文件、不写数据库、不写日志;关闭 DownLord 即消失。',
  '每次调用 yt-dlp 会在应用数据目录写一个临时文件供其读取,进程结束即删。',
  '取消某个下载不会清除已暂借的登录态——需要时在本页「当前暂借」一行清除。',
  'DownLord 不保证可下载受限内容。'
]
/**
 * 下拉里的**分组标题**(v1.0 Task 3 `M-003` · Step 0 决策 4)。
 *
 * 按「读得到 / 读不到」两组呈现,证据级落到**每一项的行内标注**上。
 * 🔴 **一个数字都不写**:`docs/v1.0/README.md` D7 说「5 个」、名单推出「6 个」——
 *   两个都不成立,写死任一个都是不诚实;不写数字反而是本条最准确的形态。
 */
const COOKIE_BROWSER_GROUPS = ['通常可用', '新版通常读不到'] as const
type CookieBrowserGroup = (typeof COOKIE_BROWSER_GROUPS)[number]

/**
 * yt-dlp 支持、Windows 常见浏览器(下拉,spec §2.1)。
 *
 * 🔴 **恒 7 项、一项不删**(v1.0 Task 3 `M-003`):读不到是**上游能力边界**,不是我们该替用户
 *   砍掉的选项 —— 用户完全可能装的是旧版 Chrome,或日后上游恢复可读。**如实标注,不做减法。**
 * 证据级三档(v1.0 Task 2 手测 N01–N06 实测):
 *   - **实测可用**:`firefox`(Firefox 154,**运行中亦成功**);
 *   - **实测读不到**:`chrome` / `edge`(Chrome 152 / Edge 152,**进程全退出后仍失败**);
 *   - **未实测 · 预计同样受限**:`brave` / `chromium` / `opera` / `vivaldi`(同为 Chromium 内核,本版未实测)。
 *   ⚠️ 第三档**必须标「未实测」**:把没测过的写成「实测读不到」是另一种不诚实。
 */
const COOKIE_BROWSERS: { value: CookieBrowser; label: string; group: CookieBrowserGroup }[] = [
  { value: 'firefox', label: 'Firefox', group: '通常可用' },
  { value: 'chrome', label: 'Chrome(实测读不到)', group: '新版通常读不到' },
  { value: 'edge', label: 'Edge(实测读不到)', group: '新版通常读不到' },
  {
    value: 'brave',
    label: 'Brave(未实测 · 同为 Chromium 内核,预计同样受限)',
    group: '新版通常读不到'
  },
  {
    value: 'chromium',
    label: 'Chromium(未实测 · 同为 Chromium 内核,预计同样受限)',
    group: '新版通常读不到'
  },
  {
    value: 'opera',
    label: 'Opera(未实测 · 同为 Chromium 内核,预计同样受限)',
    group: '新版通常读不到'
  },
  {
    value: 'vivaldi',
    label: 'Vivaldi(未实测 · 同为 Chromium 内核,预计同样受限)',
    group: '新版通常读不到'
  }
]
/**
 * 「浏览器」那一行的展开小字(v1.0 Task 3 `M-003`)—— 说清**成因**并给**去处**。
 *
 * 原文是「…推荐改用 Firefox…;**读取时请关闭该浏览器**」,末句在 Edge / Chrome 上实测无效、
 * 在 Firefox 上多余(N05 运行中即成功)⇒ 整句删掉,换成 ABE 这个真成因 + 第四档这个真出路。
 */
const COOKIE_BROWSER_NOTE =
  'Chrome 127+ 对 cookie 库做了应用绑定加密(App-Bound Encryption),任何外部程序都读不到。请改用 Firefox,或用「从扩展获取」——它由扩展在浏览器内部取,不受此限制。'
/**
 * 第三档选到非 Netscape 文件时的当场提示(v1.0 Task 3 `M-015`)。
 *
 * 🔴 **逐字等于 `ERR.COOKIE_FILE_INVALID.message`** —— 选择时与下载失败时是同一条结论,
 *   两处措辞不同会让用户以为是两回事。
 * 🔴 **格式判定不在这里,在主进程**(ARCHITECTURE §7.2:渲染层「连字符串转数字都不当成校验」)——
 *   本组件只做「我要的路径 vs 主进程回包里的路径」这一次比较,与端口那条「结论一律以主进程回包为准」同一纪律。
 */
const COOKIE_FILE_REJECTED_NOTE = 'Cookie 文件无效或不存在（需 Netscape cookies.txt 格式）'
/** 默认字幕常用语言(MVP:中文 / 英文;下载前按实际解析语言精选,spec §5.2) */
const COMMON_SUB_LANGS: { code: string; label: string }[] = [
  { code: 'zh-Hans', label: '中文' },
  { code: 'en', label: '英文' }
]

/** 长路径头部省略回显(保留文件名可辨;完整路径经 title 提示) */
function ellipsizePath(p: string): string {
  return p.length > 44 ? `…${p.slice(-44)}` : p
}

/**
 * 「当前暂借」常驻可见行(v0.4 Task 6 · plan Phase 4 · D7 ①)。
 *
 * 🔴 **它是唯一的撤销出口**,故三条形态是定死的:
 * 1. **不得折叠进任何「高级」区**,必须与第四档**同屏可见** —— 用户选了档却要去别处撤销,
 *    这个出口就等于不存在;
 * 2. **无暂借时不隐藏整行**,改说「当前未暂借任何站点的登录态」—— 隐藏会让用户以为功能坏了;
 * 3. **不放到左导航「浏览器扩展」页**:那页是**只读镜像**(「写配置的 api 名在该文件里根本不出现」
 *    是它的结构保证),且「唯一出口」一分成两处就不再是唯一出口。
 *
 * ⚠️ **只在第四档选中时挂载** —— 于是前三档这条 IPC 一次都不发,既有三档的渲染逐字节零回归。
 * 🔴 三条通道的载荷**只有 `hosts`**(`BorrowedCookieHosts`),本组件从头到尾**没有任何通路**
 *   能拿到 cookie 值 —— 红线 R3 由**接口形状**保证,不是靠这里的自觉(A-3 / I-C7)。
 */
function BorrowedCookiesRow(): React.JSX.Element {
  const [hosts, setHosts] = useState<string[]>([])
  // 挂载回显 + 订阅持有层变更(offer 在设置页开着时到达 → 这一行当场更新);卸载退订。
  // 范式沿用本文件 BtSection 的 getBtTrackerStatus + onBtTrackerStatusChanged。
  useEffect(() => {
    window.api
      .getBorrowedCookieHosts()
      .then((snapshot) => setHosts(snapshot.hosts))
      .catch(() => {})
    const off = window.api.onBorrowedCookiesChanged((snapshot) => setHosts(snapshot.hosts))
    return off
  }, [])

  // 清除回的是**回写后快照**(恒 `{hosts:[]}`),就地更新、不再回读一次(spec §6.4)
  const clear = async (): Promise<void> => {
    const snapshot = await window.api.clearBorrowedCookies()
    setHosts(snapshot.hosts)
  }

  return (
    <div className="set-row">
      <span className="sr-icon" />
      <div className="sr-text">
        <div className="sr-title">暂借登录态</div>
        <div className="sr-desc">
          {hosts.length > 0 ? `当前暂借:${hosts.join('、')}` : '当前未暂借任何站点的登录态'}
        </div>
      </div>
      <div className="sr-control">
        {/* 无暂借时不渲染按钮 —— 定死的是**这一行**不隐藏,不是「按钮恒在」;没东西可清时给一个
            点了什么都不发生的按钮,反而不诚实 */}
        {hosts.length > 0 && (
          <button className="btn btn-default" onClick={() => void clear()}>
            清除
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 第四档首次说明(v0.4 Task 6 · plan Phase 4)——**必须点「我知道了」才落档**。
 *
 * 骨架逐字复用本文件既有的「扩展名冲突」确认框(`.overlay show` + `.dialog conflict-dialog` +
 * `.conflict-msg` + `.dialog-foot` 两按钮),**零新造色值、零新 CSS 类、零新组件形态**。
 * × / 取消 = 不落档(受控 `<select>` 的 `value` 仍是旧档,重渲染即弹回)。
 */
function ExtensionCookieNotice({
  onConfirm,
  onCancel
}: {
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="overlay show">
      <div className="dialog conflict-dialog">
        <div className="dialog-head">
          <h3>从扩展获取 Cookie</h3>
          <button className="dialog-close" onClick={onCancel} title="取消" aria-label="取消">
            <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-body">
          {EXTENSION_COOKIE_NOTICE.map((line) => (
            <p className="conflict-msg" key={line}>
              {line}
            </p>
          ))}
        </div>
        <div className="dialog-foot">
          <button className="btn btn-default" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 视频组(v0.3 Task 4 审计#10 根治「快速连点丢改动」):各 onPatch **只发单一变化子字段**,
 * 不再 `{ video: { ...video, <字段> } }` spread 整包 —— 连点两个 video 控件时,两个 handler 闭包
 * 捕获同一份旧 `video` 快照,整包补丁会带着 stale 兄弟字段把第一次改动覆盖回去。
 * 主进程 `mergeVideoPrefs` 本就逐字段合并(`if ('field' in o)`),部分补丁天然被按键累积(spec §7)。
 */
function VideoSection({
  video,
  useAria2cForVideo,
  cookieNoticeAcked,
  onPatch
}: {
  video: VideoPrefs
  useAria2cForVideo: boolean
  /** 第四档首次说明是否已确认(可选字段,缺省 = 未确认 → 首次切档弹说明) */
  cookieNoticeAcked: boolean
  onPatch: (patch: AppSettingsPatch) => Promise<void>
}): React.JSX.Element {
  // cookie / subtitle 为可选字段(旧 settings.json 零迁移补全);展示 / 编辑前用默认兜底
  const cookie = video.cookie ?? DEFAULT_COOKIE_CONFIG
  const sub = video.subtitle ?? DEFAULT_SUBTITLE_CHOICE
  // 「默认下载字幕」开 = langs 非空(SubtitleChoice 无独立开关位,空 langs 即关闭,spec §5.2)
  const subOn = sub.langs.length > 0

  // Cookie 来源切档:browser 补默认 Chrome,file 保留已选路径,其它档清空(只存来源选择,不存内容,§2.6)
  // ⚠️ **第四档与 none 档同形**(browser / profile / file 三者恒 null)—— `CookieConfig` 一个字段
  //    都没加,故 settings.json 的落盘形状里**没有位置能装 cookie 值**(v0.4 Task 6 · spec §2.1)。
  const cookiePatchFor = (source: CookieSource): AppSettingsPatch => ({
    video: {
      cookie: {
        source,
        browser: source === 'browser' ? (cookie.browser ?? 'chrome') : null,
        profile: null,
        file: source === 'file' ? cookie.file : null
      }
    }
  })
  // 首次切到第四档时待确认的档位(非 null = 说明框开着);确认前**不发任何补丁**
  const [pendingSource, setPendingSource] = useState<CookieSource | null>(null)
  /**
   * 用户**刚选中的** cookie 文件路径(v1.0 Task 3 `M-015`)。
   *
   * 🔴 它只用来和主进程回包里的 `cookie.file` 做**一次相等比较** —— 主进程收下了就相等,
   *   拒收(非 Netscape 格式)就不等,于是当场出提示。**渲染层不读文件、不判格式、不看扩展名**
   *   (ARCHITECTURE §7.2:渲染层「连字符串转数字都不当成校验」),与端口那条
   *   「合不合法的结论一律以主进程回包为准」是同一纪律。
   */
  const [pickedCookieFile, setPickedCookieFile] = useState<string | null>(null)
  const setCookieSource = (source: CookieSource): void => {
    // 换档即丢弃上一次的选择记录 —— 否则切回第三档时会拿旧路径去比,报一条早已过期的错
    setPickedCookieFile(null)
    // 第四档 + 首次说明未确认 → 拦下来先弹说明。**点「我知道了」才落档**(plan Phase 4 第 4 条):
    // 这一档会让 DownLord 真的持有用户的登录凭据,静默生效不合适。其余三档一字未改。
    if (source === 'extension' && !cookieNoticeAcked) {
      setPendingSource(source)
      return
    }
    void onPatch(cookiePatchFor(source))
  }
  // 「我知道了」:确认标记与档位**一次补丁一起落**(两次 setSettings 会出现「确认了但没落档」的中间态)
  const confirmCookieNotice = (): void => {
    setPendingSource(null)
    void onPatch({ ...cookiePatchFor('extension'), cookieExtensionNoticeAcked: true })
  }
  const setCookieBrowser = (browser: CookieBrowser): void => {
    void onPatch({ video: { cookie: { ...cookie, source: 'browser', browser } } })
  }
  const pickCookieFile = async (): Promise<void> => {
    const picked = await window.api.selectFile()
    if (picked) {
      setPickedCookieFile(picked)
      void onPatch({ video: { cookie: { ...cookie, source: 'file', file: picked } } })
    }
  }
  // 主进程收下了 → 回包里就是这个路径;拒收 → 回包里不是它 ⇒ 当场提示(纯比较,零格式判断)
  const cookieFileRejected = pickedCookieFile !== null && cookie.file !== pickedCookieFile

  // 默认字幕:开启补默认中文语言(否则空 langs 立即视为关闭),关闭清空 langs
  const setSubOn = (on: boolean): void => {
    void onPatch({ video: { subtitle: { ...sub, langs: on ? ['zh-Hans'] : [] } } })
  }
  const toggleSubLang = (code: string): void => {
    const langs = sub.langs.includes(code)
      ? sub.langs.filter((l) => l !== code)
      : [...sub.langs, code]
    void onPatch({ video: { subtitle: { ...sub, langs } } })
  }
  const setSubFormat = (format: 'srt' | 'vtt'): void => {
    void onPatch({ video: { subtitle: { ...sub, format } } })
  }
  const setSubIncludeAuto = (includeAuto: boolean): void => {
    void onPatch({ video: { subtitle: { ...sub, includeAuto } } })
  }

  return (
    <div className="set-group">
      <div className="sg-title">视频</div>
      <div className="set-card">
        <div className="set-row">
          <IconVideo />
          <div className="sr-text">
            <div className="sr-title">默认清晰度</div>
            <div className="sr-desc">解析后自动选择,可在下载前手动改</div>
          </div>
          <div className="sr-control">
            <select
              className="select"
              aria-label="默认清晰度"
              value={heightToStr(video.defaultHeight)}
              onChange={(e) =>
                void onPatch({ video: { defaultHeight: strToHeight(e.target.value) } })
              }
            >
              {HEIGHT_OPTIONS.map((o) => (
                <option key={heightToStr(o.value)} value={heightToStr(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="set-row">
          <IconAudio />
          <div className="sr-text">
            <div className="sr-title">默认提取音频</div>
            <div className="sr-desc">开启后视频任务默认只下音频并转 MP3</div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={video.defaultAudioOnly}
              aria-label="默认提取音频"
              className={`switch${video.defaultAudioOnly ? ' on' : ''}`}
              onClick={() => void onPatch({ video: { defaultAudioOnly: !video.defaultAudioOnly } })}
            />
          </div>
        </div>

        {/* aria2c 加速开关(§5.2;诚实文案 §5.4:不可用时自动回退默认下载器,不承诺「必定加速 N 倍」) */}
        <div className="set-row">
          <IconZap />
          <div className="sr-text">
            <div className="sr-title">用 aria2c 加速视频下载</div>
            <div className="sr-desc">
              用内置 aria2c 多线程分片下载,加速大视频;不可用时自动回退默认下载器
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={useAria2cForVideo}
              aria-label="用 aria2c 加速视频下载"
              className={`switch${useAria2cForVideo ? ' on' : ''}`}
              onClick={() => void onPatch({ useAria2cForVideo: !useAria2cForVideo })}
            />
          </div>
        </div>

        {/* Cookie 来源(§2.1 / §5.2;诚实措辞 §5.3 + v0.4 Task 6 D9:不保证可下载受限内容) */}
        <div className="set-row">
          <IconKey />
          <div className="sr-text">
            <div className="sr-title">Cookie 来源</div>
            <div className="sr-desc">{COOKIE_SOURCE_DESC}</div>
          </div>
          <div className="sr-control">
            <select
              className="select"
              aria-label="Cookie 来源"
              value={cookie.source}
              onChange={(e) => setCookieSource(e.target.value as CookieSource)}
            >
              {COOKIE_SOURCE_ORDER.map((s) => (
                <option key={s} value={s}>
                  {COOKIE_SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* 第四档:常驻可见行(唯一撤销出口,必须与档位同屏 —— D7 ①) */}
        {cookie.source === 'extension' && <BorrowedCookiesRow />}
        {cookie.source === 'browser' && (
          <div className="set-row">
            <span className="sr-icon" />
            <div className="sr-text">
              <div className="sr-title">浏览器</div>
              <div className="sr-desc">{COOKIE_BROWSER_NOTE}</div>
            </div>
            <div className="sr-control">
              {/* v1.0 Task 3 `M-003`:两个 <optgroup> —— 七项一个不少,只是按「读得到 / 读不到」
                  分组呈现,证据级落到每一项的行内标注上。**分组不改变任何取值**。 */}
              <select
                className="select"
                aria-label="Cookie 浏览器"
                value={cookie.browser ?? 'chrome'}
                onChange={(e) => setCookieBrowser(e.target.value as CookieBrowser)}
              >
                {COOKIE_BROWSER_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {COOKIE_BROWSERS.filter((b) => b.group === g).map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}
        {cookie.source === 'file' && (
          <div className="set-row">
            <span className="sr-icon" />
            <div className="sr-text">
              <div className="sr-title">Cookie 文件</div>
              <div className="sr-desc" title={cookie.file ?? undefined}>
                {cookie.file
                  ? ellipsizePath(cookie.file)
                  : '高级:选择 Netscape 格式 cookies.txt(需浏览器扩展导出;多数用户用「从浏览器 / Firefox」更简单)'}
              </div>
              {/* v1.0 Task 3 `M-015`:选到非 Netscape 文件 → **当场**说,不拖到下载失败才报。
                  判定在主进程(§7.2),这里只是「我要的路径 ≠ 主进程给回的路径」这一次比较的回显。 */}
              {cookieFileRejected && <div className="sr-desc up-note">{COOKIE_FILE_REJECTED_NOTE}</div>}
            </div>
            <div className="sr-control">
              <button className="btn btn-default" onClick={() => void pickCookieFile()}>
                选择 Cookie 文件…
              </button>
            </div>
          </div>
        )}

        {/* 默认下载字幕(§3.4 / §5.2;诚实措辞 §5.3:仅下载已有 / 自动生成,不翻译) */}
        <div className="set-row">
          <IconCaptions />
          <div className="sr-text">
            <div className="sr-title">默认下载字幕</div>
            <div className="sr-desc">新视频任务默认下载字幕(可在下载前调整语言 / 格式)</div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={subOn}
              aria-label="默认下载字幕"
              className={`switch${subOn ? ' on' : ''}`}
              onClick={() => setSubOn(!subOn)}
            />
          </div>
        </div>
        {subOn && (
          <div className="set-row">
            <span className="sr-icon" />
            <div className="sr-text">
              <div className="sr-title">默认字幕</div>
              <div className="sr-desc">常用语言与格式(下载前仍可按实际字幕调整)</div>
              <div className="sub-pref-langs">
                {COMMON_SUB_LANGS.map((l) => (
                  <button
                    type="button"
                    key={l.code}
                    className={`chip${sub.langs.includes(l.code) ? ' active' : ''}`}
                    onClick={() => toggleSubLang(l.code)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sr-control sub-pref-control">
              <select
                className="select"
                aria-label="默认字幕格式"
                value={sub.format}
                onChange={(e) => setSubFormat(e.target.value as 'srt' | 'vtt')}
              >
                <option value="srt">SRT</option>
                <option value="vtt">VTT</option>
              </select>
              <div className="sub-auto-inline">
                <span>含自动生成</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sub.includeAuto}
                  aria-label="默认含自动生成字幕"
                  className={`switch${sub.includeAuto ? ' on' : ''}`}
                  onClick={() => setSubIncludeAuto(!sub.includeAuto)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      {/* 首次说明:切到第四档时弹一次,点「我知道了」才落档(再切回来不再弹,标记落 settings.json) */}
      {pendingSource !== null && (
        <ExtensionCookieNotice
          onConfirm={confirmCookieNotice}
          onCancel={() => setPendingSource(null)}
        />
      )}
    </div>
  )
}

/* ============ BT · 磁力(做种开关 + ratio / time / maxPeers;诚实措辞,spec §6.3 / §2.5)============
 * 做种默认关(下载完即停上传);开启后经 aria2 原生 seed-ratio / seed-time 做种。
 * 措辞守死(§7.6 / PRD §7):无「加速他人 / 私有网络 / 保证上传 / P2SP」;做种是自愿、能否连上取决于网络。
 * 数值输入本地态 onBlur / Enter 提交(仿全局限速);clamp / 布尔守卫权威在主进程 validateSettings(§7.2)。 */
const IconShare = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
)

/** BT 数值设置行(本地态 onBlur / Enter 提交;空 / 非有限 → 0,主进程 clamp 权威)。
 *  本地态随外部提交值同步——**沿用 DownloadSection 并发 / 限速输入的同一 useEffect 同步惯用法**(文件既有)。 */
function BtNumRow({
  title,
  desc,
  value,
  step,
  disabled,
  onCommit
}: {
  title: string
  desc: string
  value: number
  step: number
  disabled: boolean
  onCommit: (n: number) => void
}): React.JSX.Element {
  const [val, setVal] = useState(String(value))
  // 外部 value 变化 → 同步本地态(React 官方「渲染期调整 state」模式,替代 effect)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setVal(String(value))
  }
  const commit = (): void => {
    const n = parseFloat(val)
    onCommit(Number.isFinite(n) && n > 0 ? n : 0)
  }
  return (
    <div className="set-row">
      <span className="sr-icon" />
      <div className="sr-text">
        <div className="sr-title">{title}</div>
        <div className="sr-desc">{desc}</div>
      </div>
      <div className="sr-control">
        <input
          className="input"
          style={{ width: 96 }}
          type="number"
          min={0}
          step={step}
          aria-label={title}
          disabled={disabled}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur() // 同全局限速 F2(2026-09-18):Enter = 失焦提交,可见反馈且恰一次
            }
          }}
        />
      </div>
    </div>
  )
}

/* ---- tracker 表状态 + 入站可达诊断(v0.4 Task 1 · spec §6)----
 * 渲染层零业务逻辑(ARCHITECTURE §7.2):文本解析 / 合并去重 / 节流窗口 / usingBuiltin / IPv6 判定 /
 * 三态汇总**全在主进程纯函数**,这里只 invoke 拉状态、订阅广播、把主进程给的字段渲染成文字。
 * 唯一在渲染层的「逻辑」是 60s 重新 invoke —— 那是**拉取节奏**不是判定(spec §3.4 ④)。 */

/** 设置页可见期的入站诊断轮询间隔:兜住「设置页开着时切 WiFi / 插拔网线」;离开(卸载)即停 */
const INBOUND_POLL_MS = 60_000

/**
 * 入站可达三态文案(spec §3.3 逐字)。**只检测与如实呈现,不承诺打通**(CONTEXT.md「入站可达」):
 * `likely` 只陈述「检测到公网 IPv6」这一事实,后果一律加「还取决于…」限定;无「装了就能上传」。
 * v0.5 接 UPnP 后 `factors` 会多一条,届时本表按 factors 扩写(spec §3.5 接缝)。
 */
const INBOUND_NOTE: Record<InboundReachability, string> = {
  likely:
    '入站可达:检测到公网 IPv6 地址。能否真的被外部连入,还取决于路由器与系统防火墙是否放行 —— DownLord 只检测,不修改任何网络设置。',
  unlikely:
    '入站可达:未检测到公网 IPv6 地址。处于 NAT / 校园网之后时,外部通常无法主动连入,做种上传速度可能长期为 0。这由所在网络决定,应用层无法改变。',
  unknown: '入站可达:未能读取本机网络接口,无法判断。'
}

/** 上次更新时间戳 → `MM-DD HH:mm`(纯展示) */
function fmtTrackerTime(ts: number): string {
  const d = new Date(ts)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * tracker 状态行文案(四态,`BtTrackerStatus.state` 驱动;spec §6.2)。
 * 条数与 `usingBuiltin` 由主进程算好直接用,渲染层不判定生效表口径。
 * ⚠️ **不提追补**(spec §4.6 表述禁令:追补的 announce 实效未经验证,UI 不得暗示)。
 */
function trackerDesc(st: BtTrackerStatus | null): string {
  if (!st) return '读取中…'
  const current = st.usingBuiltin
    ? `当前使用内置列表(${st.count} 条)`
    : `当前使用上次拉取的 ${st.count} 条`
  switch (st.state) {
    case 'ok':
      // 成功但有保留(未落盘 / 未热应用,spec §4.5 #7 / #8)时如实附注,不静默
      return (
        `上次更新 ${fmtTrackerTime(st.updatedAt)} · ${st.count} 条` +
        (st.lastError ? `(${st.lastError})` : '')
      )
    case 'failed':
      return `上次更新失败(${st.lastError ?? '未知原因'})· ${current}`
    case 'disabled':
      return `自动更新已关闭 · ${current}`
    default:
      return `尚未更新 · ${current}`
  }
}

function BtSection({
  settings,
  onPatch
}: {
  settings: AppSettings
  onPatch: (patch: AppSettingsPatch) => Promise<void>
}): React.JSX.Element {
  const on = settings.btSeedEnabled
  const autoOn = settings.btAutoUpdateTrackers
  const { showToast } = useToast()
  const [tracker, setTracker] = useState<BtTrackerStatus | null>(null)
  const [inbound, setInbound] = useState<InboundDiagnosis | null>(null)
  // 「立即更新」在途(主进程 busy 之外的本地即时反馈,避免点击到广播回来之间按钮可再点)
  const [updating, setUpdating] = useState(false)

  // 挂载回显 + 订阅自动路径广播(**自动路径不弹 toast**,成功也不弹;D15);卸载退订
  useEffect(() => {
    window.api
      .getBtTrackerStatus()
      .then(setTracker)
      .catch(() => {})
    const off = window.api.onBtTrackerStatusChanged(setTracker)
    return off
  }, [])

  // 入站诊断:挂载拉一次 + 订阅换网重算广播 + 可见期 60s 重新 invoke(每次都由主进程实算);卸载停表并退订
  useEffect(() => {
    const pull = (): void => {
      window.api
        .getBtInboundDiagnosis()
        .then(setInbound)
        .catch(() => {})
    }
    pull()
    const off = window.api.onBtInboundChanged(setInbound)
    const timer = setInterval(pull, INBOUND_POLL_MS)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [])

  const busy = updating || (tracker?.busy ?? false)

  // 手动路径:**成败都 toast**(D15);成败判定取主进程给的 state,渲染层不替它判
  const updateNow = (): void => {
    setUpdating(true)
    window.api
      .updateBtTrackersNow()
      .then((st) => {
        setTracker(st)
        showToast(
          st.state === 'ok'
            ? `tracker 列表已更新 · ${st.count} 条`
            : st.state === 'failed'
              ? `tracker 列表更新失败(${st.lastError ?? '未知原因'})`
              : `tracker 列表:${trackerDesc(st)}`
        )
      })
      .catch(() => showToast('tracker 列表更新失败'))
      .finally(() => setUpdating(false))
  }

  return (
    <div className="set-group">
      <div className="sg-title">BT · 磁力</div>
      <div className="set-card">
        {/* 做种开关(诚实措辞 §2.5:分享已下载数据 / 默认关 / 自愿,能否连上取决于网络;无「加速他人」) */}
        <div className="set-row">
          <IconShare />
          <div className="sr-text">
            <div className="sr-title">下载完成后做种(上传)</div>
            <div className="sr-desc">
              开启后,下载完成会继续把已下载的数据分享给正在下载同一种子的其他用户。默认关闭——下载完即停止上传。做种是自愿的,能否连接到其他节点取决于你的网络环境。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label="下载完成后做种"
              className={`switch${on ? ' on' : ''}`}
              onClick={() => void onPatch({ btSeedEnabled: !on })}
            />
          </div>
        </div>

        {/* ratio / time / maxPeers:未开做种时禁用(视觉弱化,克制) */}
        <BtNumRow
          title="分享率上限"
          desc="上传量达下载量的该倍数后停止做种;与做种时间任一先达到即停。0 = 不按分享率停。"
          value={settings.btSeedRatio}
          step={0.1}
          disabled={!on}
          onCommit={(n) => void onPatch({ btSeedRatio: n })}
        />
        <BtNumRow
          title="做种时间上限(分钟)"
          desc="做种达该时长后停止;与分享率任一先达到即停。0 = 不按时间停。"
          value={settings.btSeedTimeMin}
          step={1}
          disabled={!on}
          onCommit={(n) => void onPatch({ btSeedTimeMin: n })}
        />
        <BtNumRow
          title="最大连接数(可选)"
          desc="单个 BT 任务的最大 peer 连接数。留空 / 0 = 跟随默认(128)。"
          value={settings.btMaxPeers}
          step={1}
          disabled={!on}
          onCommit={(n) => void onPatch({ btMaxPeers: n })}
        />

        {/* 脚注(§2.5):通过 aria2 原生做种能力实现——不承诺私有网络 / 中转加速 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-desc">通过 aria2 原生做种能力实现。</div>
          </div>
        </div>

        {/* ① 自动更新 tracker 列表开关(默认开;只下载公开文本,不读用户数据、不上传任何内容,D14)
         *    措辞不说「提速 / 连上更多节点」——只说拉取地址表这一事实,失败退内置(spec §6.2)。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">自动更新 tracker 列表</div>
            <div className="sr-desc">
              添加 BT 任务时,若距上次更新超过 12 小时,从公开列表拉取最新的 tracker
              地址。拉取失败会继续使用内置列表。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={autoOn}
              aria-label="自动更新 tracker 列表"
              className={`switch${autoOn ? ' on' : ''}`}
              onClick={() => void onPatch({ btAutoUpdateTrackers: !autoOn })}
            />
          </div>
        </div>

        {/* ② tracker 列表状态 + 「立即更新」(仿关于组 yt-dlp 的「状态行 + 单按钮」组合)
         *    手动路径成败都 toast;自动路径的广播一律不弹(成功也不弹,D15)。状态行**不提追补**(§4.6)。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">tracker 列表</div>
            <div className="sr-desc">{trackerDesc(tracker)}</div>
          </div>
          <div className="sr-control">
            <button className="btn btn-default" disabled={busy} onClick={updateNow}>
              {busy ? '更新中…' : '立即更新'}
            </button>
          </div>
        </div>

        {/* ③ 入站可达诊断 —— **只读事实陈述,不是设置**(DESIGN §3「只读诊断行」):
         *    无 sr-title / 无 sr-control,只有一段 .sr-desc.up-note,结构上即与可改项区分。
         *    `sr-icon` 位**留空占位不放图标** —— 与同卡片 v0.3 既有脚注行(上方「通过 aria2 原生做种
         *    能力实现」)逐字同构:`.set-row` 是 flex + gap 14px,缺了这个 20px 占位文字会比同卡片
         *    其余各行左移 34px(2026-07-29 手测 C1 反馈)。占位是**空 span**,不引入图标、零新增 CSS。
         *    判定全在主进程(每次实算 → 换网自动重算);渲染层只显示,不承诺打通。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-desc up-note">
              {inbound ? INBOUND_NOTE[inbound.state] : '入站可达:检测中…'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ 关于(版本 + 内核版本 + 自动更新体系:yt-dlp 热更新 + 应用本体自更新)============
 * 纯 UI 展示 + 触发(ARCHITECTURE §7.2):一切检查 / 下载 / 三重校验 / 原子替换全在主进程 updater;
 * 渲染层只 invoke 触发 + 订阅 onUpdateStatus 驱动进度 / 阶段(仿 onProxyStatusChanged)。
 * 进度条复用 TaskRow.css 的 .bar / .bar.indet;按钮 .btn-default / .btn-primary;色值全走 tokens.css(DESIGN §5,绝不另造)。
 * 诚实(PRD §4.4):未签名如实说明;不静默强制(应用需用户点下载 / 重启;yt-dlp 应用后 toast 告知)。 */

/** 更新「进行中」阶段:按钮禁用 + 进度条显示(§5.2) */
const UPDATE_IN_PROGRESS: UpdatePhase[] = ['checking', 'downloading', 'verifying']

/**
 * 未签名诚实小字(v1.0 Task 3 · `M-001`;逐字真源在 spec §4「如实说清单」)。
 *
 * ⚠️ **原文末尾曾括注一个具体的签名版本号 —— 一句已被推翻的承诺**:`#17` 至今四度推后,
 *   v1.0 复评仍维持「不做」(个人开源项目、无发布主体,买证书=建立一条持续付费义务)。
 *   把一个**永远不会兑现**的版本号摆在用户眼前,是最直白的一类不诚实,故改为「不承诺何时签名」。
 * ⚠️ **写成模块级字符串常量而非 JSX 文本**(理由同 `COOKIE_SOURCE_DESC`):防 prettier 折行 ——
 *   折行后逐字断言与措辞扫描都会在半句话上判定。
 */
const ABOUT_UNSIGNED_NOTE =
  '应用未做代码签名,Windows 安装 / 更新时可能提示「未知发布者」,可点「更多信息 → 仍要运行」继续。本项目是个人开源项目、无发布主体,不承诺何时签名。'

function AboutSection({
  settings,
  onPatch
}: {
  settings: AppSettings
  onPatch: (patch: AppSettingsPatch) => Promise<void>
}): React.JSX.Element {
  const { showToast } = useToast()
  const [version, setVersion] = useState('')
  const [eng, setEng] = useState<EngineVersions | null>(null)
  // yt-dlp / 应用更新运行态(派生自 onUpdateStatus 广播 + 检查触发;纯展示,业务在主进程 §7.2)
  const [yt, setYt] = useState<UpdateStatus | null>(null)
  const [app, setApp] = useState<UpdateStatus | null>(null)

  // showToast 存 ref:onUpdateStatus 订阅仅挂载一次(避免 showToast 入 deps 反复重订阅),终态 toast 取最新
  const toastRef = useRef(showToast)
  // latest-ref 模式:render 期同步最新 showToast,供只挂载一次的订阅 effect 读取;消费在异步回调(commit 后),
  // 无并发读写风险。刻意保留并放行本规则(React 暂无稳定替代 useEffectEvent)。
  // eslint-disable-next-line react-hooks/refs
  toastRef.current = showToast

  useEffect(() => {
    window.api
      .getVersion()
      .then(setVersion)
      .catch(() => {})
    window.api
      .getEngineVersions()
      .then(setEng)
      .catch(() => {})
  }, [])

  // 订阅更新进度 / 阶段广播(仿 onProxyStatusChanged);组件卸载取消订阅(诚实:终态 toast 告知,非静默)
  useEffect(() => {
    const off = window.api.onUpdateStatus((status) => {
      if (status.target === 'ytdlp') {
        setYt(status)
        // 已生效(applied,非 pending)→ 刷新「当前」显示为新版(主进程缓存亦已刷新;
        // 避免「已更新至 X · 当前仍 Y」矛盾,U4 修复)。pending-restart 不刷(尚未生效,下次启动才生效)。
        if (status.phase === 'applied' && status.latestVersion) {
          setEng((prev) => (prev ? { ...prev, ytdlp: status.latestVersion as string } : prev))
        }
        if (status.phase === 'applied' || status.phase === 'pending-restart') {
          toastRef.current(status.message ?? 'yt-dlp 更新完成')
        } else if (status.phase === 'up-to-date') {
          toastRef.current(
            `yt-dlp 已是最新版本${status.latestVersion ? ` ${status.latestVersion}` : ''}`
          )
        } else if (status.phase === 'error') {
          toastRef.current(status.error ?? 'yt-dlp 更新失败')
        }
      } else {
        setApp(status)
        if (status.phase === 'up-to-date') {
          toastRef.current('当前已是最新版本')
        } else if (status.phase === 'error') {
          toastRef.current(status.error ?? '检查应用更新失败')
        }
      }
    })
    return off
  }, [])

  const kernel = eng
    ? `内核 aria2 ${eng.aria2} · yt-dlp ${eng.ytdlp} · ffmpeg ${eng.ffmpeg}`
    : '内核版本读取中…'

  // ---- yt-dlp 组件更新行派生 ----
  const ytPhase = yt?.phase ?? 'idle'
  const ytBusy = UPDATE_IN_PROGRESS.includes(ytPhase)
  const ytCurrent = eng?.ytdlp ?? '—'
  // 描述文案:未检查(无最新版本且非检查中)→ 只显「当前 X」,不显「· 最新 —」(U1 文案修复)
  const ytDesc =
    ytPhase === 'checking'
      ? `当前 ${ytCurrent} · 检查中…`
      : yt?.latestVersion
        ? `当前 ${ytCurrent} · 最新 ${yt.latestVersion}`
        : `当前 ${ytCurrent}`
  // 终态状态文案(applied / pending-restart 用 message;error 用 error)
  const ytNote =
    yt?.error ?? (ytPhase === 'applied' || ytPhase === 'pending-restart' ? yt?.message : undefined)

  // 手动检查 = 全流程(check → 有更新则下载 / 三重校验 / 原子替换;yt-dlp 是非破坏 drop-in,§2.5);进度经广播回显
  const checkYtDlp = (): void => {
    setYt({ target: 'ytdlp', phase: 'checking', currentVersion: ytCurrent })
    window.api.runYtDlpUpdate().catch(() => {})
  }

  // ---- 应用更新行派生 ----
  const appPhase = app?.phase ?? 'idle'
  const appBusy = UPDATE_IN_PROGRESS.includes(appPhase)
  const appLatest = app?.latestVersion ?? null
  const appVerLine =
    appPhase === 'available' && appLatest
      ? `有新版本 ${appLatest}`
      : appPhase === 'up-to-date'
        ? '已是最新'
        : appPhase === 'ready'
          ? '已下载,待重启安装'
          : ''

  // 应用更新不静默(§4.4):检查 → 有新版仅提示;下载 / 重启安装均由用户点击
  const checkApp = (): void => {
    setApp({ target: 'app', phase: 'checking', currentVersion: version })
    window.api.checkAppUpdate().catch(() => {})
  }
  const downloadApp = (): void => void window.api.downloadAppUpdate().catch(() => {})
  const restartApp = (): void => void window.api.quitAndInstallApp().catch(() => {})

  const openThirdPartyNotices = async (): Promise<void> => {
    try {
      const error = await window.api.openThirdPartyNotices()
      if (error) showToast(error)
    } catch (error) {
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
      showToast(`打开第三方许可与声明失败：${detail || '未知错误，请重试。'}`)
    }
  }

  return (
    <div className="set-group">
      <div className="sg-title">关于</div>
      <div className="set-card">
        {/* 版本 + 内核(既有,不动) */}
        <div className="set-row">
          <IconInfo />
          <div className="sr-text">
            <div className="sr-title">DownLord v{version}</div>
            <div className="sr-desc">{kernel}</div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              className="btn btn-default"
              onClick={() => void openThirdPartyNotices()}
            >
              第三方许可与声明
            </button>
          </div>
        </div>

        {/* 自动更新 yt-dlp 组件开关(默认开;非破坏 drop-in,应用后 toast 告知,§2.5 / §5.1) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">自动更新 yt-dlp 组件</div>
            <div className="sr-desc">
              yt-dlp 随视频站点频繁改版,保持组件新鲜可避免「昨天能下今天下不了」。更新经 SHA256
              校验后原子替换,失败保留旧版、不影响运行中任务;每次自动应用后会提示你。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoUpdateYtDlp}
              aria-label="自动更新 yt-dlp 组件"
              className={`switch${settings.autoUpdateYtDlp ? ' on' : ''}`}
              onClick={() => void onPatch({ autoUpdateYtDlp: !settings.autoUpdateYtDlp })}
            />
          </div>
        </div>

        {/* 自动检查应用更新开关(默认开;仅检查 + 提示,下载 / 安装需用户确认,不静默,§3.4 / §4.4) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">自动检查应用更新</div>
            <div className="sr-desc">
              仅自动检查是否有新版本并提示;下载与重启安装始终由你点击确认,绝不静默强制更新。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoUpdateApp}
              aria-label="自动检查应用更新"
              className={`switch${settings.autoUpdateApp ? ' on' : ''}`}
              onClick={() => void onPatch({ autoUpdateApp: !settings.autoUpdateApp })}
            />
          </div>
        </div>

        {/* yt-dlp 组件更新(手动检查即全流程:检查 → 下载 → 三重校验 → 原子替换 / 占用降级) */}
        <div className="set-row">
          <IconTerminal />
          <div className="sr-text">
            <div className="sr-title">yt-dlp 组件更新</div>
            <div className="sr-desc">{ytDesc}</div>
            {ytBusy &&
              (ytPhase === 'downloading' ? (
                <div className="bar">
                  <span style={{ width: `${yt?.percent ?? 0}%` }} />
                </div>
              ) : (
                // checking / verifying:不确定进度用 indeterminate(复用 .bar.indet,DESIGN §5)
                <div className="bar indet">
                  <span />
                </div>
              ))}
            {ytNote && <div className="sr-desc up-note">{ytNote}</div>}
          </div>
          <div className="sr-control">
            <button className="btn btn-default" disabled={ytBusy} onClick={checkYtDlp}>
              {ytPhase === 'checking'
                ? '检查中…'
                : ytPhase === 'downloading'
                  ? '下载中…'
                  : ytPhase === 'verifying'
                    ? '校验中…'
                    : '检查 yt-dlp 更新'}
            </button>
          </div>
        </div>

        {/* 应用更新(不静默:available → [下载] → downloading → ready → [重启安装]) */}
        <div className="set-row">
          <IconInfo />
          <div className="sr-text">
            <div className="sr-title">应用更新</div>
            <div className="sr-desc">
              当前 v{version}
              {appVerLine && ` · ${appVerLine}`}
            </div>
            {appPhase === 'downloading' && (
              <div className="bar">
                <span style={{ width: `${app?.percent ?? 0}%` }} />
              </div>
            )}
            {app?.error && <div className="sr-desc up-note">{app.error}</div>}
          </div>
          <div className="sr-control">
            {appPhase === 'available' ? (
              <button className="btn btn-default" onClick={downloadApp}>
                下载
              </button>
            ) : appPhase === 'downloading' ? (
              <button className="btn btn-default" disabled>
                下载中…
              </button>
            ) : appPhase === 'ready' ? (
              <button className="btn btn-primary" onClick={restartApp}>
                重启安装
              </button>
            ) : (
              <button className="btn btn-default" disabled={appBusy} onClick={checkApp}>
                {appPhase === 'checking' ? '检查中…' : '检查应用更新'}
              </button>
            )}
          </div>
        </div>

        {/* 未签名诚实小字(PRD §4.4 / spec §4.4):不隐瞒 SmartScreen 提示。
            v1.0 Task 3 `M-001`:末句由一个具体版本号的签名承诺改为如实的「不承诺何时签名」。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-desc">{ABOUT_UNSIGNED_NOTE}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ 分区导航子项(id 与各分组 .set-anchor 一一对应;label = 分组标题)============ */
const SECTIONS = [
  { id: 'set-appearance', label: '外观' },
  { id: 'set-general', label: '通用' },
  { id: 'set-download', label: '下载' },
  { id: 'set-category', label: '分类与保存位置' },
  { id: 'set-proxy', label: '代理' },
  // 通信类设置紧邻代理(v0.4 Task 3 · spec §4.1);左导航「网页嗅探」项属 Task 5,本 Task 不动
  { id: 'set-extension', label: '浏览器扩展' },
  { id: 'set-video', label: '视频' },
  { id: 'set-bt', label: 'BT · 磁力' },
  { id: 'set-about', label: '关于' }
] as const

interface SettingsPageProps {
  /**
   * 打开时直接落到哪个分区(取 `SECTIONS` 的 id,如 `'set-extension'`)。缺省 = 落在最顶部。
   *
   * 由「浏览器扩展」页的「前往设置页配置」传入(v0.4 Task 5):不带它的话跳过来停在设置页最上方,
   * 与用户自己点左下角「设置」毫无区别 —— 那个按钮就白按了(2026-08-11 用户手测提出)。
   * **锚点 id 是设置页的内部细节**,故由 App 外壳接线,调用方(扩展页)不需要知道它。
   */
  initialSectionId?: string
}

export default function SettingsPage({ initialSectionId }: SettingsPageProps = {}): React.JSX.Element {
  // 全量 settings 回显(挂载 getSettings;改值经 setSettings 回 clamp 后最新全量回写本地态)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  // 默认目录为空串时回落显示的系统下载目录(SettingsService 首启已解析绝对路径,此为防御兜底)
  const [sysDir, setSysDir] = useState('')
  // 改默认目录后跟随类的真实目录依新默认目录重算(category:list 投影 resolveCategoryDir);据此重拉刷新「分类与保存位置」组显示
  const { reloadCategories } = useTasks()

  // 分区导航:当前高亮区 + 右侧滚动容器引用(IntersectionObserver root)
  // 初值直接取 initialSectionId —— 高亮属于「渲染出来就该是对的」,不是挂载后再纠正的东西
  // (在 effect 里 setState 会引发级联渲染,eslint `react-hooks/set-state-in-effect` 也会拦)
  const [activeId, setActiveId] = useState<string>(initialSectionId ?? SECTIONS[0].id)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 点击子导航后短暂锁定 active:smooth 滚动途经的中间分组不抢高亮(避免闪现),滚动结束(超时)解锁
  const clickLockRef = useRef(false)
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(lockTimerRef.current ?? undefined), [])

  useEffect(() => {
    window.api
      .getSettings()
      .then(setSettings)
      .catch(() => {})
    window.api
      .getDownloadDir()
      .then(setSysDir)
      .catch(() => {})
  }, [])

  /**
   * 滚到某个分组。**防御式调用**:jsdom 无 `scrollIntoView`,且「挂载即滚动」这条路径比点击更容易
   * 撞上元素尚未就绪 —— 滚不动是纯视觉退化(停在顶部),不该把整页拖垮。
   */
  const scrollToSection = (id: string, behavior: ScrollBehavior): void => {
    const el = scrollRef.current?.querySelector(`#${id}`)
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior, block: 'start' })
    }
  }

  // 外部指定初始分区(v0.4 Task 5:从「浏览器扩展」页点「前往设置页配置」直达扩展分组)。
  // 高亮已由 activeId 初值给出,这里只做**滚动**(effect 的正当职责:与 DOM 这个外部系统同步)。
  // 用 'auto' 不用 'smooth' —— 打开就该已经在那儿,不必让用户看一段从顶部滑下来的动画。
  useEffect(() => {
    if (!initialSectionId) return
    // 滚动期间锁住 IO:途经的中间分组不抢高亮(与 goto 同一处理)
    clickLockRef.current = true
    clearTimeout(lockTimerRef.current ?? undefined)
    lockTimerRef.current = setTimeout(() => {
      clickLockRef.current = false
    }, 600)
    scrollToSection(initialSectionId, 'auto')
    // scrollToSection 只读 ref、无状态依赖;此 effect 只在「外部要求跳哪一区」变化时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSectionId])

  // 滚动监听:分组顶部进入容器上区 → 高亮对应子导航(纯 UI;jsdom 无 IntersectionObserver 时静默跳过)
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (clickLockRef.current) return // 点击滚动期间不跟随,避免高亮在途经的中间分组闪现
        // 同一批 entries 里可能有多个分组同时在触发带内(刚打开设置页时「外观」与「通用」都在)。
        // 逐条 setActiveId 会让**数组里最后一条**赢 —— 表现为初次进入高亮停在「通用」而不是「外观」
        // (2026-07-31 手测发现)。取 SECTIONS 顺序里**最靠上**的那个,才与「当前读到哪一区」一致。
        let best = -1
        for (const e of entries) {
          if (!e.isIntersecting || !e.target.id) continue
          const idx = SECTIONS.findIndex((s) => s.id === e.target.id)
          if (idx >= 0 && (best === -1 || idx < best)) best = idx
        }
        if (best >= 0) setActiveId(SECTIONS[best].id)
      },
      // 仅当分组顶部落入容器顶部 30% 视野时视为当前区(底部 -70% 收窄触发带)
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    )
    for (const s of SECTIONS) {
      const el = root.querySelector(`#${s.id}`)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])

  const goto = (id: string): void => {
    // 点击意图优先:立即高亮(末尾短分组 IntersectionObserver 触发不到容器顶部触发带,
    // 仅靠 IO 会令点击「视频 / 关于」高亮停在「代理」、且两者结果一致;点击直接置 active 修复)
    setActiveId(id)
    // 点击锁:smooth 滚动期间忽略 IO,避免高亮在途经的中间分组闪现;~600ms 后(滚动通常已停)解锁
    clickLockRef.current = true
    clearTimeout(lockTimerRef.current ?? undefined)
    lockTimerRef.current = setTimeout(() => {
      clickLockRef.current = false
    }, 600)
    scrollToSection(id, 'smooth')
  }

  const patch = async (p: AppSettingsPatch): Promise<void> => {
    const next = await window.api.setSettings(p)
    setSettings(next)
    // 改默认目录 → 跟随类的真实目录依新默认目录重算(category:list 投影);重拉刷新分类组显示(否则显示滞后于新目录)
    if (p.defaultDir !== undefined) {
      await reloadCategories()
    }
  }

  // 加载前用默认值兜底渲染(避免闪烁;下载 / 视频控件离散,加载后回显真实值)
  const s = settings ?? DEFAULT_APP_SETTINGS

  return (
    <div className="settings-layout">
      <nav className="set-nav">
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            type="button"
            className={`set-nav-item${activeId === sec.id ? ' active' : ''}`}
            onClick={() => goto(sec.id)}
          >
            {sec.label}
          </button>
        ))}
      </nav>
      <div className="settings-scroll" ref={scrollRef}>
        <section id="set-appearance" className="set-anchor">
          <AppearanceSection />
        </section>
        <section id="set-general" className="set-anchor">
          <GeneralSection settings={s} onPatch={patch} />
        </section>
        <section id="set-download" className="set-anchor">
          <DownloadSection settings={s} sysDir={sysDir} onPatch={patch} />
        </section>
        <section id="set-category" className="set-anchor">
          <CategorySection />
        </section>
        <section id="set-proxy" className="set-anchor">
          <ProxySettings />
        </section>
        <section id="set-extension" className="set-anchor">
          <ExtensionChannelSettings />
        </section>
        <section id="set-video" className="set-anchor">
          <VideoSection
            video={s.video}
            useAria2cForVideo={s.useAria2cForVideo}
            cookieNoticeAcked={s.cookieExtensionNoticeAcked === true}
            onPatch={patch}
          />
        </section>
        <section id="set-bt" className="set-anchor">
          <BtSection settings={s} onPatch={patch} />
        </section>
        <section id="set-about" className="set-anchor">
          <AboutSection settings={s} onPatch={patch} />
        </section>
      </div>
    </div>
  )
}
