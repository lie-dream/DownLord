/**
 * 设置页「浏览器扩展」分组 — 本地通道开关 / 两行状态 / 端口 / 配对码 / 扩展发现引导(v0.4 Task 3 · spec §4.1 五块)。
 *
 * - **自包含组件**(仿 ProxySettings.tsx):挂载读 getExtensionChannelConfig + getExtensionChannelStatus +
 *   getExtensionSideloadInfo;订阅 onExtensionChannelStatusChanged,**卸载即退订**。
 * - **渲染纯 UI、零业务逻辑**(ARCHITECTURE §7.2):token 生成 / 端口校验 / 服务起停 / 状态合成**全在主进程**,
 *   本组件只经 window.api 调 IPC 并回显主进程回的结果 —— 端口合不合法的**结论一律以主进程回的
 *   `lastError: invalid_port:<code>` 为准**,渲染层不自己判(输入框里做的只是「字符串→数字」的转换,不是校验)。
 * - **连接状态是运行时态、不落库**(CONTEXT.md「运行时态」):本组件不缓存、不写任何持久化,刷新即以主进程为准。
 * - **两行状态不合并**(spec §5.3):「端口绑上了」与「扩展连上了」是两件独立的事,
 *   「端口绑成功但没装扩展」完全正常 —— 合并成一行必然要么谎报要么含糊。
 *   两行都是**只读事实陈述行**(DESIGN §3),照 SettingsPage 入站可达诊断行的形制:无 sr-title、只有 .sr-desc.up-note。
 * - **第三态叫「待活动」,绝不写「断开」**(CONTEXT.md「待活动」):握手是事件驱动、无定期心跳,
 *   「久无握手」既可能是扩展挂了、也可能只是用户一天没下载 —— 分不清就不假装分得清。
 * - **端口与 token 正交**(spec §4.4):配对码只含 token,端口不进配对码 ——
 *   **改端口不需重新配对**(但扩展读不了本机文件、不会自动跟上,故必须醒目提示「扩展里的端口也要改」),
 *   **重新生成 token 才需要重新配对**。两处文案不许混。
 * - **token 显示纪律**(spec §3.5 / §4.1):默认遮蔽;**绝不写日志、绝不 console 打印**;
 *   「复制」走 navigator.clipboard.writeText(既有先例:v0.2 Task 5 复制下载链接,§7.2 已定性
 *   「渲染层可自足的浏览器能力不强行走 IPC」)。
 * - **「重新生成」用行内二次确认,不用 `window.confirm`**(2026-07-31 手测 4b 定案):原生模态关闭后
 *   document 尚未拿回焦点,而 Clipboard API 规范要求 `document.hasFocus()` 为真,否则 `writeText` 以
 *   `NotAllowedError` 拒绝 —— 真机表现是「确认完第一次点复制必失败、第二次才成」。行内确认从根上不丢焦点。
 * - **提示分两类**:操作级反馈(复制成败 / 重新生成完成 / 打不开文件夹 / **改端口成功**)走既有 toast;
 *   行内提示只留**「需要你现在就做一件事、而且做完才算完」**的那种 —— 当前只有「端口还没生效」这条脏态
 *   (鼠标点别处不会自动应用,不说出来就等于静默丢弃用户的输入,2026-07-31 手测 3)与「重新生成」的二次确认。
 *   ⚠️ **「扩展里的端口也要改成 N」原为不可自动消失的行内横幅**(spec §4.4 ★),**2026-07-31 用户手测后改判**:
 *   每改一次端口就要点一遍「我知道了」,代价大于收益。改为 **toast + 端口块下方一条常驻只读提示** ——
 *   toast 负责「当场看见」,常驻行负责「事后回来还看得见」,两者合起来仍守住 §4.4 的本意
 *   (扩展读不了本机文件、不会自动跟上,这件事不能只靠一闪而过的提示)。
 * - **#42 应用内发现入口与配对码同屏**(spec §4.5):路径从 getSideloadInfo **运行时取**、不硬编码;
 *   `exists:false` **如实显示**「未找到扩展目录」,不静默、不拿一个不存在的路径当没事;
 *   `edge://extensions/` **不做可点击链接**(Electron 无法可靠地让外部浏览器打开 edge:// 内部页,不假装有一键跳转)。
 * - 色值 / 控件全走 tokens.css 与全局 .btn / .input / .switch / .set-row(DESIGN §6),绝不另造。
 *
 * ── v0.4 Task 4 Step 6a 追加「下载接管」子区(spec §5.5)────────────────────────
 * - **接管配置的唯一真源在主进程**(`takeover.json` + `TakeoverService`):本组件只读快照 + 上报意图,
 *   「此刻是否暂停」「绝对到期时刻」「域名归一」全由主进程算好回传,渲染层**不自己判时钟、不自己归一**
 *   (与端口那条「结论一律以主进程回包为准」同一纪律)。
 * - **订阅 `onTakeoverConfigChanged` 是必需的,不是锦上添花**:暂停有**两个写入口**——设置页与
 *   浏览器 popup 遥控器。不订阅的话,popup 那边一暂停,开着的设置页显示的就是它自己最后写的值
 *   (CONTEXT.md「临时暂停接管」警告的「只能显示最近一次听说的」)。
 * - ⚠️ **界面隔离硬约束**(CONTEXT.md「接管判定」;Step 0 澄清中人与 AI **各误解过一次**):
 *   本子区**一个字都不许提「文件类型 / 扩展名」**,**永不出现扩展名输入框**。类别的扩展名清单管
 *   「抢过来之后放到哪个目录」、**从不拒绝任何文件**;接管判定管「抢不抢」。域名例外表**只收域名**。
 * - **单点实现**:域名例外表的编辑**只在这一处**(README 第 6 条,Task 5 嗅探页只放跳转入口)。
 *
 * ── v0.4 Task 5 Phase 3 追加两条 ────────────────────────────────────────────
 * - **两处共用的文案抽到 `../lib/extensionView`**:连接三态 / 服务三态 / 接管四态 / 暂停三档,
 *   与左导航「浏览器扩展」页(`ExtensionPage`)**从同一个常量、同一个函数取**。spec §5.2 要求
 *   「逐字照搬设置页」—— 靠人手抄一份维持逐字相同,改一处忘另一处就静默漂移;同源取则
 *   **结构上不可能不同**(U-34)。本文件因此**只剩本页专属**的 `PORT_INVALID_NOTE` / 域名归一。
 * - **隐私说明完整版三句**(spec §6.2 · D12)落在「安装浏览器扩展」卡内:那是配对流程的必经之地,
 *   用户照四步装完、配对码就在上方。同一常量也落「浏览器扩展」页,**不各写一份**。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_EXTENSION_CHANNEL_CONFIG,
  type ExtensionChannelConfig,
  type ExtensionChannelStatus,
  type ExtensionSideloadInfo,
  type TakeoverSettingsView
} from '../../../shared/ipc'
import { copyToClipboard } from '../lib/clipboard'
import {
  FALLBACK_STATUS,
  FALLBACK_TAKEOVER,
  LINK_NOTE,
  PAUSE_PRESETS,
  SNIFF_PRIVACY_NOTE,
  invalidPortCode,
  linkText,
  serviceText,
  takeoverStateText
} from '../lib/extensionView'
import { useToast } from '../state/toastStore'
import './ExtensionChannelSettings.css'

/** 配对码遮蔽占位(默认态;真值只在用户点「显示」后才进 DOM) */
const TOKEN_MASK = '••••••••••••••••••••••••'

/**
 * 端口被拒的具体文案(键 = 主进程 `validateChannelPort` 回的 code,经 `lastError: invalid_port:<code>` 下发)。
 * 渲染层**只做 code → 文案的映射**,判定本身不在这里(§7.2)。
 */
const PORT_INVALID_NOTE: Record<string, string> = {
  not_integer: '端口必须是整数,请只填数字(如 52330)。',
  out_of_range: '端口必须在 1024–65535 之间。',
  reserved_bt: '52301–52320 已被 BT 与 DHT 的监听端口占用,请换一个(如 52330)。'
}

/**
 * 通道未启用时的引导句(v1.0 Task 3 `M-014`;逐字真源在 spec §4「如实说清单」)。
 *
 * 成因(裁决表 `M-014`):这句引导原先是「安装浏览器扩展」卡里 `<ol>` 的**第 1 步、且恒可见** ——
 * 通道**已经开着**的用户照样被要求「去打开通道」,让人困惑且自相矛盾;而**真正该说这句话的地方**
 * (通道状态行)当时显示的是另一句。
 * ⇒ 归位到通道状态行 + **只在通道未开时出现**;`<ol>` 里那一步随之删掉(**不两处各留一份** ——
 *   同一条指令出现在两个地方,改一处忘另一处就是下一轮的漂移)。
 */
const CHANNEL_OFF_GUIDE =
  '本地通道未启用 —— 扩展的接管 / 嗅探 / Cookie 功能全部不可用。请打开上方「启用本地通道」开关。'

/**
 * 浏览器支持范围的诚实边界(v1.0 Task 3 · 随 `M-020` 同批据实订正)。
 *
 * ⚠️ **这是第四处同类措辞**,而裁决表只点了三处:`M-002`(根 `README.md` 两处 → Task 5)与
 *   `Doc-5`(`extension/README.md` 四行加一处 → 本 Task 的 P4)。**本处在 UI 上、无人认领** ——
 *   Step 2 撞见后按 spec §9.2 ③ 报用户拍板,2026-09-03 拍板「当场改,按 M-002 / Doc-5 已定口径」。
 * 两处必须改的理由:
 * ① 「Firefox … 留到 v0.5」是**已被推翻的承诺**(D6 已定 Firefox 本版不做,且 v0.5 别名即本版)——
 *    与 `M-001` 那句括注签名版本号的承诺同类;
 * ② 「Chrome … 未实测、不承诺」是**低报**(v1.0 Task 2 已在 Edge / Chrome 双端各跑一遍全链),
 *    且与本卡片 `M-020` 新增的 Chrome 安装步骤**直接自相矛盾**。
 * 🔴 **末句不许删或收窄**(`TODO #91`):嗅探 / 接管 / cookie **三条通路**的浏览器边界都挂在它上面。
 */
const BROWSER_SUPPORT_NOTE =
  'Edge 与 Chrome 已实测通过,属承诺范围。Firefox 本版不做 —— 它是不同引擎(命名空间、后台脚本形态、正式版强制扩展签名都不同),需单独验证。Brave / Chromium / Opera / Vivaldi 本版未实测,不据此宣称全部 Chromium 浏览器已验证。'

// ── 域名例外表(v0.4 Task 4 Step 6a · spec §5.5)──────────────────────────────
// 接管四态文案 / 三档时长 / 连接状态三态等**两处共用**的纯展示映射已抽到 `../lib/extensionView`
// ——「浏览器扩展」页(v0.4 Task 5)与本分组从同一个常量取,逐字相同由**结构**保证而非人手抄写(U-34)。

/**
 * 域名输入的规范化(小写 / 去 `http(s)://` / 去路径 / 去端口)。
 *
 * ⚠️ 这里做的只是**即时回显**用的轻量归一(与 `SettingsPage` 的 `normalizeOne` 同一定位):
 *    **权威归一在主进程** `normalizeDomainList`,渲染层以回包为准(与端口校验同一纪律)。
 *    两处都做不是重复 —— 少了这一处,用户按下回车会先看到自己粘的整条 URL 变成 chip 再跳回域名。
 */
function normalizeDomainInput(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  s = s.split('@').pop() ?? ''
  return s.split(':')[0].replace(/\.+$/, '')
}

/**
 * 域名例外表末尾的「+ 添加」输入框 —— **原样复用 Task 8.5 扩展名标签编辑器的 `ExtAddInput` 范式**
 * (Enter / 失焦提交、提交后清空)。类名 `.ext-add` 直接复用,零新增样式、零新造色值。
 */
function DomainAddInput({ onAdd }: { onAdd: (raw: string) => void }): React.JSX.Element {
  const [val, setVal] = useState('')
  const commit = (): void => {
    const v = val.trim()
    if (v) onAdd(v)
    setVal('')
  }
  return (
    <input
      className="ext-add ec-domain-add"
      placeholder="+ 添加域名"
      aria-label="添加不接管的域名"
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

export default function ExtensionChannelSettings(): React.JSX.Element {
  // 配置(含 token —— 只用于「显示 / 复制」,不入日志、不进 settings.json)
  const [config, setConfig] = useState<ExtensionChannelConfig | null>(null)
  // 两行状态:全部由主进程合成并广播,组件只回显
  const [status, setStatus] = useState<ExtensionChannelStatus | null>(null)
  // 扩展目录事实(#42;运行时实探,dev / 打包两态不同)
  const [sideload, setSideload] = useState<ExtensionSideloadInfo | null>(null)
  // 接管配置(v0.4 Task 4 Step 6a):**唯一真源在主进程**,本组件只回显 + 上报意图
  const [takeover, setTakeover] = useState<TakeoverSettingsView | null>(null)
  /**
   * 「剩余 N 分钟」是**随时间走**的,而配置本身不变 —— 故每 30 秒取一次当前时刻重算这段文字。
   *
   * ⚠️ **这不是「暂停靠定时器实现」** —— 到期与否恒由主进程现算(`isTakeoverPaused`,零定时器)。
   *    这个 interval 只影响**这段文字**,停掉它最坏的后果是数字不刷新,判定一点不受影响。
   */
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [portInput, setPortInput] = useState(String(DEFAULT_EXTENSION_CHANNEL_CONFIG.port))
  // 端口被拒的 code(主进程给的,不是本地判的)
  const [portRejected, setPortRejected] = useState<string | null>(null)
  // 「重新生成」的**行内**二次确认(不用 window.confirm:那是原生模态,关闭后 document 尚未拿回焦点,
  // 而 Clipboard API 要求 document.hasFocus() 为真 —— 实测表现为「确认完第一次点复制必失败,第二次才成」)
  const [confirmingRegen, setConfirmingRegen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [pending, setPending] = useState(false)
  const portRef = useRef<HTMLInputElement>(null)
  // 操作级反馈走既有 toast 通道(与 v0.2 Task 5「复制下载链接」同一先例),不在分组里堆行内提示
  const { showToast } = useToast()

  /**
   * 接管配置落地的**唯一入口**:配置与「算剩余用的时刻」必须**同一批更新**。
   *
   * ⚠️ 2026-08-03 手测踩出:只 `setTakeover` 不更新 `nowMs`,`nowMs` 就还停在**组件挂载那一刻**,
   *    而 `pausedUntil` 是主进程按**点击那一刻**算的 —— 两者差着「打开设置页到点下按钮」的那段时间,
   *    `Math.ceil` 再把它压成恒 +1,于是三档一律显示 16 / 61 / 241 分钟。
   *    时刻与它要比较的那个值必须来自同一个时间点,否则差多少都会被 ceil 藏起来。
   */
  const applyTakeover = useCallback((next: TakeoverSettingsView): void => {
    setTakeover(next)
    setNowMs(Date.now())
  }, [])

  // 挂载:读配置 + 状态 + 扩展目录;订阅状态广播(起停 / 重绑 / 握手 / 重新生成后主进程推送)
  useEffect(() => {
    let alive = true
    void (async (): Promise<void> => {
      try {
        const [c, s, info] = await Promise.all([
          window.api.getExtensionChannelConfig(),
          window.api.getExtensionChannelStatus(),
          window.api.getExtensionSideloadInfo()
        ])
        if (!alive) return
        setConfig(c)
        setStatus(s)
        setSideload(info)
        setPortInput(String(c.port))
      } catch {
        // 主进程未就绪 / IPC 缺失:保持兜底渲染,不拖垮整个设置页(仿 ProxySettings 的 .catch)
      }
    })()

    let off: (() => void) | undefined
    try {
      off = window.api.onExtensionChannelStatusChanged((s) => {
        if (alive) setStatus(s)
      })
    } catch {
      off = undefined
    }
    return () => {
      alive = false
      off?.() // ★ 卸载退订(plan 2.6 步 2)
    }
  }, [])

  // 接管配置:挂载读一次 + 订阅广播(**popup 遥控器也会写这份真源**,不订阅就会显示自己最后写的值)
  useEffect(() => {
    let alive = true
    // try/catch 与上面那段同理:IPC 缺失时 `window.api.xxx()` 是**同步抛 TypeError**,不是 rejected
    // promise —— 只挂 .catch 接不住,整个设置页会被这一处拖垮
    try {
      void window.api
        .getTakeoverConfig()
        .then((t) => void (alive && applyTakeover(t)))
        .catch(() => {})
    } catch {
      // 主进程未就绪 / IPC 缺失:保持兜底渲染(默认开、未暂停、无例外)
    }

    let off: (() => void) | undefined
    try {
      off = window.api.onTakeoverConfigChanged((t) => {
        if (alive) applyTakeover(t)
      })
    } catch {
      off = undefined
    }
    return () => {
      alive = false
      off?.()
    }
  }, [applyTakeover])

  // 「剩余 N 分钟」的走字(只影响文案,不参与任何判定 —— 判定恒在主进程现算)
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const st = status ?? FALLBACK_STATUS
  const token = config?.token ?? ''
  const rejectedNote = portRejected
    ? (PORT_INVALID_NOTE[portRejected] ?? `端口未被接受(${portRejected})。`)
    : null
  // 输入框里改了数字但**还没提交**:必须看得见 —— 否则用户改完就走,下次回来发现根本没改成(2026-07-31 手测 3)
  const portDirty = portInput.trim() !== String(st.port)

  /**
   * 写配置(开关 / 改端口)→ 主进程起停 / 重绑 → 回即时状态。
   * 端口非法时主进程**整体不落盘**并回 `invalid_port:<code>`,故此处据回包决定是否给无效态 / 提示。
   */
  const applyConfig = useCallback(
    async (enabled: boolean, port: number, noticeOnPortChange: boolean): Promise<void> => {
      const prevPort = status?.port ?? null
      setPending(true)
      try {
        const next = await window.api.setExtensionChannelConfig({ enabled, port })
        setStatus(next)
        const code = invalidPortCode(next.lastError)
        setPortRejected(code)
        if (!code) {
          setPortInput(String(next.port))
          // 端口真的变了才提示 —— 扩展读不了本机文件,不会自动跟上(spec §4.4)。
          // toast 负责「当场看见」;端口块下方那条常驻只读提示负责「事后回来还看得见」。
          if (noticeOnPortChange && prevPort !== null && next.port !== prevPort) {
            showToast(`端口已改为 ${next.port} —— 记得把扩展里的端口也改成 ${next.port}`)
          }
        }
      } catch {
        showToast('无法与主进程通信,配置未改动。', 'error')
      } finally {
        setPending(false)
      }
    },
    [status, showToast]
  )

  // 总开关:端口用**当下生效的端口**,不用输入框里未提交的值(否则切开关会顺带把端口改了)
  const toggleEnabled = (): void => {
    void applyConfig(!st.enabled, st.port, false)
  }

  // 「重新绑定」:字符串 → 数字只是**转换**,合法性结论归主进程(空串给 NaN,让主进程回 not_integer)
  const rebind = (): void => {
    const raw = portInput.trim()
    void applyConfig(st.enabled, raw === '' ? Number.NaN : Number(raw), true)
  }

  const copyToken = (): void => {
    void copyToClipboard(token).then((ok) =>
      ok ? showToast('已复制配对码') : showToast('复制失败', 'error')
    )
  }

  // 行内二次确认的「确定」:新 token 落盘 → 旧配对当场失效;顺手收回明文显示
  const regenerate = (): void => {
    setConfirmingRegen(false)
    setPending(true)
    void window.api
      .regenerateExtensionToken()
      .then((next) => {
        setConfig(next)
        setRevealed(false)
        showToast('已生成新配对码,请到扩展里重新粘一次')
      })
      .catch(() => showToast('重新生成失败,配对码未改动', 'error'))
      .finally(() => setPending(false))
  }

  const copyDir = (): void => {
    const dir = sideload?.dir ?? ''
    void copyToClipboard(dir).then((ok) =>
      ok ? showToast('已复制扩展目录路径') : showToast('复制失败', 'error')
    )
  }

  const revealDir = (): void => {
    const dir = sideload?.dir
    if (!dir) return
    void window.api
      .showItemInFolder(dir)
      .then((err) => {
        if (err) showToast(`打不开文件夹:${err}`, 'error')
      })
      .catch(() => showToast('打不开文件夹', 'error'))
  }

  // ── 下载接管子区的动作(全部「上报意图 → 以主进程回包为准」)────────────────

  const tk = takeover ?? FALLBACK_TAKEOVER
  const tkState = takeoverStateText(tk, st, nowMs)

  /** 写总开关 / 域名例外表 → 以回包为准(域名归一在主进程) */
  const patchTakeover = (patch: { enabled?: boolean; excludedDomains?: string[] }): void => {
    void window.api
      .setTakeoverConfig(patch)
      .then(applyTakeover)
      .catch(() => showToast('无法与主进程通信,接管设置未改动。', 'error'))
  }

  /** 设暂停时长档 / 恢复接管 → 以回包为准(绝对到期时刻由主进程现算) */
  const setPause = (minutes: number | null): void => {
    void window.api
      .setTakeoverPause({ minutes })
      .then((next) => {
        applyTakeover(next)
        showToast(minutes === null ? '已恢复接管' : `已暂停接管 ${minutes} 分钟`)
      })
      .catch(() => showToast('无法与主进程通信,暂停未生效。', 'error'))
  }

  const addDomain = (raw: string): void => {
    const d = normalizeDomainInput(raw)
    if (!d || tk.excludedDomains.includes(d)) return
    patchTakeover({ excludedDomains: [...tk.excludedDomains, d] })
  }

  const removeDomain = (d: string): void => {
    patchTakeover({ excludedDomains: tk.excludedDomains.filter((x) => x !== d) })
  }

  return (
    <div className="set-group extension-channel">
      <div className="sg-title">浏览器扩展</div>

      <div className="set-card">
        {/* ① 启用本地通道(默认关 —— 不装扩展的用户不该白开一个监听端口,spec §5.1) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">启用本地通道</div>
            <div className="sr-desc">
              开启后 DownLord 会在本机 127.0.0.1:52330
              监听,只接受带配对码的请求。不装浏览器扩展就不需要开。
            </div>
            {!st.enabled && (
              <div className="sr-desc ec-sub">
                关闭后扩展的接管 / 嗅探 / Cookie
                功能全部失效(扩展会显示「连不上 DownLord」);已配对的配对码仍有效,重新启用即可继续用。
              </div>
            )}
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={st.enabled}
              aria-label="启用本地通道"
              disabled={pending}
              className={`switch${st.enabled ? ' on' : ''}`}
              onClick={toggleEnabled}
            />
          </div>
        </div>

        {/* ②-1 第一行:服务状态 —— 只读事实陈述行(照 BT 入站可达诊断行的形制:无 sr-title / 无设置控件) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-desc up-note">本地通道:{serviceText(st)}</div>
            {/* v1.0 Task 3 `M-014`:引导句归位到**这一行**,且**只在通道未开时**出现。
                原先它是下方安装卡 <ol> 的第 1 步且恒可见 —— 通道开着的用户照样被要求去开通道。 */}
            {!st.enabled && <div className="sr-desc ec-sub">{CHANNEL_OFF_GUIDE}</div>}
          </div>
          {st.service === 'port_in_use' && (
            <div className="sr-control">
              {/* 就近给「改端口」入口:直接把焦点送到下面的端口输入框(spec §5.2)。
                  用 .btn-default 而非 .btn-subtle —— subtle 无边框无底色,不 hover 看不出是按钮(手测 Me) */}
              <button
                type="button"
                className="btn btn-default"
                onClick={() => {
                  portRef.current?.focus()
                  portRef.current?.select()
                }}
              >
                改端口
              </button>
            </div>
          )}
        </div>

        {/* ②-2 第二行:扩展连接三态 —— 与第一行**分开两行**,不合并(spec §5.3) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-desc up-note">浏览器扩展:{linkText(st)}</div>
            {LINK_NOTE[st.link] !== '' && <div className="sr-desc ec-sub">{LINK_NOTE[st.link]}</div>}
          </div>
        </div>

        {/* ③ 端口 + 「重新绑定」 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">端口</div>
            <div className="sr-desc">
              默认 52330。改完记得把扩展里的端口也改成同一个 —— 扩展读不了本机文件,不会自动跟上。
            </div>
            {/* ★ 常驻只读提示:只在端口**不是默认值**时出现,即「你自己改过、扩展那边多半还没跟上」。
              * 它替代了原先那条要点「我知道了」的横幅(2026-07-31 用户手测:每改一次都要点一遍太烦)——
              * 不需要任何交互,但**不会自动消失**,所以事后回到设置页仍看得见该填哪个数字。 */}
            {st.port !== DEFAULT_EXTENSION_CHANNEL_CONFIG.port && (
              <div className="ec-sub ec-port-align">
                当前生效:{st.port} —— 扩展里的端口也要填 {st.port}
              </div>
            )}
          </div>
          <div className="sr-control ec-inline">
            <input
              ref={portRef}
              className={`input ec-port-input${rejectedNote ? ' invalid' : ''}`}
              aria-label="本地通道端口"
              aria-invalid={rejectedNote !== null}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rebind()
              }}
            />
            {/* 有未提交改动时按钮变主色:把「还差一步」摆在最显眼处 */}
            <button
              type="button"
              className={`btn ${portDirty ? 'btn-primary' : 'btn-default'}`}
              disabled={pending}
              onClick={rebind}
            >
              重新绑定
            </button>
          </div>
        </div>

        {/* ★ 端口这一行的提示条:**跨整行、排在该行下方**(2026-07-31 手测 A10)。
          * 不放进 .sr-text —— 那是左列,而右列控件是垂直居中的,提示会显得比输入框高一截;
          * 且左列窄,长文案换行后与「我知道了」挤作一团。提示是关于**整行**的,就让它占满整行。 */}
        {rejectedNote && <div className="ec-rowmsg ec-err">{rejectedNote}</div>}
        {/* 改了数字但没提交:显式说「还没生效」——鼠标点别处不会自动应用,不提示就等于静默丢弃(手测 3) */}
        {portDirty && !rejectedNote && (
          <div className="ec-rowmsg ec-notice ec-notice-dirty" role="status">
            <span>
              端口 {portInput.trim() || '(空)'} 还没生效 ——
              点右边「重新绑定」或按回车才会应用(当前生效:{st.port})
            </span>
          </div>
        )}

        {/* ④ 配对码:默认遮蔽(明文只在用户点「显示」后才进 DOM) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">配对码</div>
            <div className="sr-desc">
              配对码相当于密码,只粘进你自己浏览器里的 DownLord 扩展。
            </div>
            <div className="ec-token" aria-label="配对码">
              <code>{revealed ? token : TOKEN_MASK}</code>
            </div>
          </div>
          <div className="sr-control ec-inline">
            <button
              type="button"
              className="btn btn-default"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? '隐藏' : '显示'}
            </button>
            <button type="button" className="btn btn-default" onClick={copyToken}>
              复制
            </button>
            <button
              type="button"
              className="btn btn-default"
              disabled={pending || confirmingRegen}
              onClick={() => setConfirmingRegen(true)}
            >
              重新生成
            </button>
          </div>
        </div>

        {/* ★ 行内二次确认(替代 window.confirm):不弹原生模态 → 焦点不丢 → 确认完第一次点「复制」就能成。
          * 与端口提示同一处理:**跨整行、排在该行下方**(2026-07-31 手测 A6),不挤在左列里。 */}
        {confirmingRegen && (
          <div
            className="ec-rowmsg ec-notice ec-confirm"
            role="alertdialog"
            aria-label="确认重新生成配对码"
          >
            <span>旧配对会立即失效,已配对的扩展需要重新粘一次新配对码。</span>
            <span className="ec-confirm-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={regenerate}
              >
                确定重新生成
              </button>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setConfirmingRegen(false)}
              >
                取消
              </button>
            </span>
          </div>
        )}
      </div>

      {/* ⑤ #42 应用内发现入口:与配对码同屏(同一段用户旅程,spec §4.5) */}
      <div className="set-card ec-guide">
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">安装浏览器扩展</div>
            <div className="sr-desc">扩展随 DownLord 一起分发,已解压在本机这个目录:</div>
            <div className="ec-path-row">
              <input
                className="input ec-path"
                readOnly
                aria-label="扩展目录"
                value={sideload?.dir ?? ''}
              />
              <button type="button" className="btn btn-default" onClick={copyDir}>
                复制路径
              </button>
              <button
                type="button"
                className="btn btn-default"
                disabled={!sideload?.exists}
                onClick={revealDir}
              >
                在资源管理器中定位
              </button>
            </div>
            {sideload && !sideload.exists && (
              <div className="ec-err">
                未找到扩展目录:{sideload.dir}(开发态请先跑 npm run build)
              </div>
            )}
            {/* 如实说明 showItemInFolder 的行为:它打开的是**上一级**并选中 dist,不是进到 dist 里面 */}
            <div className="sr-desc ec-sub">
              「在资源管理器中定位」会打开上一级目录并选中 dist —— Edge 选目录时正好停在这一层。
            </div>

            {/* v1.0 Task 3:第 1 步「在上方打开『启用本地通道』开关」已按 `M-014` 归位到通道状态行,
                此处**不再重复一份**;第 2 步按 `M-020` 补上 Chrome —— Chrome 是 v1.0 新承诺的浏览器
                (D6),按引导找不到入口的用户会直接卡在安装第一步。**Edge 那半保留不动**。 */}
            <ol className="ec-steps">
              <li>
                在 Edge 地址栏输入 <code>edge://extensions/</code>,或在 Chrome 地址栏输入{' '}
                <code>chrome://extensions/</code>,打开「开发人员模式」
              </li>
              <li>点「加载解压缩的扩展」,选上面这个目录</li>
              <li>点浏览器工具栏的扩展图标,把上面的配对码粘进去,端口填与上方一致的数字</li>
            </ol>

            {/* ★ 隐私说明完整版三句(v0.4 Task 5 · spec §6.2 · D12):落**两处** —— 这里(配对流程的
              * 必经之地,用户刚照四步装完、配对码就在上面)与「浏览器扩展」页。
              * 文案取自 `SNIFF_PRIVACY_NOTE` **同一个常量**,两处不各写一份 ——
              * 隐私承诺一旦两处措辞不同,就没有哪一份还算数。复用既有 .sr-desc,零新造色值。 */}
            <div className="sr-desc ec-sub">{SNIFF_PRIVACY_NOTE}</div>

            <div className="sr-desc ec-honest">{BROWSER_SUPPORT_NOTE}</div>
          </div>
        </div>
      </div>

      {/* ⑥ 下载接管子区(v0.4 Task 4 Step 6a · spec §5.5):在本分组**末尾**追加三行。
        *
        * ⚠️ **界面隔离硬约束**(CONTEXT.md「接管判定」;Step 0 澄清中人与 AI **各误解过一次**):
        *    本子区**一个字都不许提「文件类型 / 扩展名」**,**永不出现扩展名输入框**。
        *    类别的扩展名清单管「抢过来之后放到哪个目录」、**从不拒绝任何文件**;
        *    接管判定管「抢不抢」。两者放同一界面必被误解 —— 故域名例外表**只收域名**。
        * ⚠️ **单点实现**:域名例外表的编辑**只在这一处**(README 第 6 条:Task 5 的嗅探页不重复造,
        *    只放跳转到本处的入口)。 */}
      <div className="set-card ec-takeover">
        {/* ① 接管总开关(**默认开** —— 装了扩展即视为授权) */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">下载接管</div>
            <div className="sr-desc">
              在浏览器里点下载时,由 DownLord 接管。需要安装并配对浏览器扩展。
            </div>
          </div>
          <div className="sr-control">
            <button
              type="button"
              role="switch"
              aria-checked={tk.enabled}
              aria-label="下载接管"
              className={`switch${tk.enabled ? ' on' : ''}`}
              onClick={() => patchTakeover({ enabled: !tk.enabled })}
            />
          </div>
        </div>

        {/* ② 暂停状态 + 三档 —— 仿关于组 yt-dlp 的「状态行 + 按钮」组合。
          * 暂停中时三档换成单个「恢复接管」(此刻用户要的只有这一个动作)。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">临时暂停</div>
            <div className="sr-desc">{tkState}</div>
            {/* 「本次启动以来没收到过握手」如实陈述、**不下结论** —— 扩展上报 intent 不需要先握手,
              * 故这既可能是没装扩展、也可能只是还没下载过东西(与「待活动」同一种分不清)。 */}
            {tk.enabled && !tk.paused && st.service === 'listening' && st.link === 'unpaired' && (
              <div className="sr-desc ec-sub">
                本次启动以来尚未收到扩展的握手 —— 若还没装扩展 / 还没填配对码,接管不会发生。
              </div>
            )}
          </div>
          <div className="sr-control ec-inline">
            {tk.paused ? (
              <button type="button" className="btn btn-primary" onClick={() => setPause(null)}>
                恢复接管
              </button>
            ) : (
              PAUSE_PRESETS.map((p) => (
                <button
                  key={p.minutes}
                  type="button"
                  className="btn btn-default"
                  disabled={!tk.enabled}
                  onClick={() => setPause(p.minutes)}
                >
                  {p.label}
                </button>
              ))
            )}
          </div>
        </div>

        {/* ③ 域名例外表 —— **原样复用** Task 8.5 的扩展名标签编辑器范式(`.chip` + `×` hover→--danger
          * + 末尾输入框 Enter / 失焦新增),类名直接复用 `.ext-tags` / `.ext-chip` / `.ext-x` / `.ext-add`,
          * **零新造色值**。 */}
        <div className="set-row">
          <span className="sr-icon" />
          <div className="sr-text">
            <div className="sr-title">不接管这些域名</div>
            <div className="sr-desc">这些域名的下载不接管,交回浏览器自己处理。</div>
            {/* ⚠️ 2026-08-03 手测踩出:用户在 uu.163.com 页面点下载,填了 `uu.163.com` 却照样被接管 ——
              * 因为真正的下载地址在 `uu.gdl.netease.com`。**判定比的是下载地址的域名,不是网页域名**
              * (那是唯一可靠拿到的东西:referrer 可能为空、可能被站点剥掉)。这不是缺陷,但**不说清就等于坑**,
              * 故在此如实告知该填哪个、以及去哪儿抄。 */}
            <div className="sr-desc ec-sub">
              填的是「下载地址」的域名,常与网页域名不同(网盘 / CDN 另有一套域名)。接管确认框里「来自
              …」那一行显示的就是它,照抄即可。
            </div>
            <div className="ext-tags ec-domains">
              {tk.excludedDomains.map((d) => (
                <span className="chip ext-chip" key={d}>
                  {d}
                  <button
                    type="button"
                    className="ext-x"
                    aria-label={`删除 ${d}`}
                    onClick={() => removeDomain(d)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <DomainAddInput onAdd={addDomain} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
