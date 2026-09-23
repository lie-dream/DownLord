/**
 * 「浏览器扩展」相关的纯展示文案与状态→文案映射,供**两处共用**:
 * 设置页分组 `ExtensionChannelSettings`(v0.4 Task 3 / Task 4)与左导航「浏览器扩展」页
 * `ExtensionPage`(v0.4 Task 5 · spec §5)。
 *
 * **为什么抽出来**:同一个状态在两个界面说两种话,是最典型的不一致源。spec §5.2 要求
 * 「四态文案与三档时长**逐字照搬**设置页」—— 若靠人手抄一份维持逐字相同,改一处忘另一处
 * 就会静默漂移;从**同一个常量 / 同一个函数**取则是**结构上不可能不同**(U-34)。
 * 本文件的存在本身就是那道保证,不是「顺手整理」。
 *
 * **渲染纯 UI**(ARCHITECTURE §7.2):这里只做「状态 → 该显示哪句话」的映射,
 * **判定本身全在主进程** —— 端口合不合法(`validateChannelPort` 回 `invalid_port:<code>`)、
 * 此刻是否暂停(`isTakeoverPaused`,零定时器)、绝对到期时刻,渲染层一律以回包为准、不自己判。
 *
 * 文案的出处与措辞纪律(搬家时**原样保留**,不许在搬运途中改字):
 * - 第三态叫「待活动」,**绝不写「断开」**(CONTEXT.md「待活动」)。
 * - 接管第四态绑在**确实为真**的判据上(通道没监听),不拿「没握手」当「接管不会发生」。
 * - 暂停只有**纯时间三档**,没有「直到关闭浏览器」/「永久暂停」。
 */

import type {
  ExtensionChannelStatus,
  ExtensionLinkState,
  TakeoverSettingsView
} from '../../../shared/ipc'
import { DEFAULT_EXTENSION_CHANNEL_CONFIG } from '../../../shared/ipc'
import { formatDate } from './format'

// ── 本地通道连接状态(v0.4 Task 3 · spec §5.2 / §5.3)────────────────────────

/** 未读到主进程状态前的兜底渲染值(仿 SettingsPage 的 `settings ?? DEFAULT_APP_SETTINGS`,避免闪烁) */
export const FALLBACK_STATUS: ExtensionChannelStatus = {
  enabled: DEFAULT_EXTENSION_CHANNEL_CONFIG.enabled,
  service: 'stopped',
  port: DEFAULT_EXTENSION_CHANNEL_CONFIG.port,
  lastError: null,
  link: 'unpaired',
  lastHandshakeAt: null
}

/** 扩展连接三态主文案(spec §5.3 逐字);第三态**必须**是「待活动」 */
export const LINK_TEXT: Record<ExtensionLinkState, string> = {
  unpaired: '未配对',
  connected: '已连接',
  idle_pending: '待活动'
}

/**
 * 扩展连接三态副文案(spec §5.3 逐字)。
 *
 * ⚠️ `unpaired` 只能说**我们真正知道的那件事** —— DownLord 根本不知道用户有没有把配对码粘进扩展,
 * 它只知道「本次启动以来有没有收到过握手」。故**不写**「扩展未安装 / 未配对成功」。
 */
export const LINK_NOTE: Record<ExtensionLinkState, string> = {
  unpaired: '本次启动以来尚未收到扩展的握手。若已配对,打开扩展弹窗即会握手',
  connected: '',
  idle_pending: '已握手过,但最近一段时间没有新活动。扩展可能只是闲着'
}

const INVALID_PORT_PREFIX = 'invalid_port:'

/** `lastError` 是「端口被拒」时取出其 code,否则 null(端口块用它出具体文案) */
export function invalidPortCode(lastError: string | null): string | null {
  return lastError && lastError.startsWith(INVALID_PORT_PREFIX)
    ? lastError.slice(INVALID_PORT_PREFIX.length)
    : null
}

/**
 * 服务状态三态(spec §5.2 逐字)。
 *
 * `stopped` 分两种写法:**真实 listen 失败(EACCES 等)必须显示错误码**,不许被「已关闭」掩盖(诚实);
 * 而 `invalid_port:*` 不是 listen 失败、是「端口输入被拒」—— 那件事在设置页端口块显著呈现,
 * 此处不混进服务状态。
 */
export function serviceText(s: ExtensionChannelStatus): string {
  if (s.service === 'listening') return `监听中 · 127.0.0.1:${s.port}`
  if (s.service === 'port_in_use') return `端口 ${s.port} 被占用,通道未启动`
  if (s.lastError && !invalidPortCode(s.lastError)) return `未启动(${s.lastError})`
  return '已关闭'
}

/** 扩展连接三态;`connected` 附最近握手时间(spec §5.3) */
export function linkText(s: ExtensionChannelStatus): string {
  const base = LINK_TEXT[s.link]
  return s.link === 'connected' ? `${base}(最近握手 ${formatDate(s.lastHandshakeAt)})` : base
}

// ── 下载接管(v0.4 Task 4 Step 6a · spec §5.5)────────────────────────────────

/**
 * 未读到主进程配置前的兜底渲染值。
 * **默认开** —— 装了扩展即视为授权(与默认关的本地通道刻意相反:那要开一个监听端口,这不要)。
 */
export const FALLBACK_TAKEOVER: TakeoverSettingsView = {
  enabled: true,
  pausedUntil: null,
  paused: false,
  excludedDomains: []
}

/**
 * 暂停时长档(**纯时间三档**,spec §5.2)。
 *
 * ⚠️ **没有「直到关闭浏览器」** —— DownLord 无从得知浏览器何时关闭(通道无反向推送、sw 空闲即销毁,
 *    「久无握手」既可能是浏览器关了也可能是用户一天没下载)。分不清就不假装分得清。
 * ⚠️ **没有「永久暂停」** —— 那是**关闭接管**(设置页里的总开关),语义不同、入口不同。
 *    混在一起会让用户以为「暂停」也是永久的。
 */
export const PAUSE_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 240, label: '4 小时' }
]

/** 一分钟的毫秒数(与主进程 `pauseState.ts` 同一常量,此处只用于显示) */
export const MS_PER_MINUTE = 60_000

/** `至 15:30` 里那个时刻(只到分,不带日期 —— 三档最长 4 小时,不会跨到看不懂的日期) */
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 接管状态四态文案(spec §5.5,**按序**判定)。
 *
 * ⚠️ **第四态与 spec 原文有一处诚实修订**:spec 写的是「扩展尚未连接 · 接管不会发生」,但那句话的
 *    判据不成立 —— 扩展上报 intent **不需要先握手**(`download.intent` 自带 token 直发),
 *    故「本次启动以来没收到过握手」既可能是没装扩展、也可能只是用户还没下载过东西,
 *    **和「待活动」是同一种分不清**(CONTEXT.md)。把它说成「接管不会发生」就是替浏览器打包票。
 *    改为绑在一个**确实为真**的判据上:**本地通道没在监听时**接管必然不会发生。
 *    「本次启动未握手」另作一条副文案如实陈述,不下结论。
 *
 * ⚠️ 传进来的 `now` 必须与 `t.pausedUntil` **同源**(同一批更新):`pausedUntil` 是主进程按
 *    「点击那一刻」算的,若 `now` 还停在组件挂载那一刻,`Math.ceil` 会把差值压成恒 +1,
 *    三档一律显示 16 / 61 / 241 分钟(2026-08-03 手测踩出)。
 */
export function takeoverStateText(
  t: TakeoverSettingsView,
  s: ExtensionChannelStatus,
  now: number
): string {
  if (!t.enabled) return '已关闭'
  if (t.paused && t.pausedUntil !== null) {
    // `paused` 是主进程算的结论,`pausedUntil` 是同一份数据 —— 正常情况下两者一致。
    // 下限 1:万一渲染层时钟比主进程快(或这一帧刚好卡在到期瞬间),宁可显示「剩余 1 分钟」,
    // 也不能显示负数 —— 那看着像 bug,而真相只是「马上就到期」。
    const left = Math.max(1, Math.ceil((t.pausedUntil - now) / MS_PER_MINUTE))
    return `已暂停 · 剩余 ${left} 分钟(至 ${clockText(t.pausedUntil)})`
  }
  if (s.service !== 'listening') return '本地通道未启动 · 接管不会发生'
  return '接管中'
}

// ── 嗅探隐私说明(v0.4 Task 5 · spec §6.2)────────────────────────────────────

/**
 * 隐私说明**完整版三句**,落**两处**:设置页扩展分组(配对流程的必经之地)与「浏览器扩展」页(D12)。
 *
 * 三句的恒真性各由**结构**保证,不靠自觉(spec §6.2 的对照表):
 * - 「不注入页面脚本」← manifest 无 `content_scripts`(ARCHITECTURE §7.2 红线 + 探针 P4)
 * - 「不上传」← `sniff.report` 取消:未选中的资源从不离开浏览器;上行只对 `127.0.0.1`
 * - 「不保存,关闭浏览器即清除」← 嗅探结果存 `chrome.storage.session`(内存态,进程退出即清)
 *
 * ⚠️ 两处**同一个常量**,不各写一份 —— 隐私承诺一旦两处措辞不同,就没有哪一份还算数。
 */
export const SNIFF_PRIVACY_NOTE =
  '本扩展不注入页面脚本,只读取网络请求的地址与响应头。嗅探结果不上传、不保存,关闭浏览器即清除。'
