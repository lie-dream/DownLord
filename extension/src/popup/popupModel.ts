/**
 * popup **数据层** — 纯函数,输入事实 → 输出 view model(v0.4 Task 2 · spec §2.1)。
 *
 * 与渲染层分文件的理由:MV3 popup 每次打开都是一份全新文档,冷启动延迟直接反映到手感,
 * 所以零框架、原生 DOM;分层则让数据层成为可在 Node 里跑的纯函数(`popupModel.test.ts`)。
 *
 * 本文件不碰 DOM、不碰 `chrome`、不做 I/O。
 *
 * ⚠️ **token 不进 model**:model 只知道「有没有配对」,拿不到配对码本身 ——
 * 渲染层因此**不可能**把明文 token 写进 DOM(spec §4.2)。
 *
 * v0.4 Task 4 追加**接管状态一行**(spec §5.4)。它与上面那些事实有个根本区别:
 * 上面的都读自本机 storage,这一行**只能问 DownLord** —— 故它多带一个「没问到」的取值,
 * 且**一个字节都不落 storage**(约定 L1 的正向应用)。
 *
 * v0.4 Task 5 Phase 1 追加**两件**:嗅探的一行「本页资源」与诊断区的 **buildId 一致性告警**
 * (`docs/TODO.md` #53)。
 * Phase 2 把资源列表本身接上:**判断仍全在纯函数里** —— 分组 / 徽章 / 大小 / 分片归属 /
 * 计数提示 / 四种非列表状态全落在 `sniff/sniffView.ts` 的 `buildSniffSections`,
 * 本文件只多两行字段与一处调用(spec §3.4)。
 *
 * v0.4 Task 6 追加**一件**:「用 DownLord 下载此页视频」那个按钮的可点性与它下面那一行实话
 * (`describeVideoIntent`)。⚠️ **「已附 `<域名>` 的登录态」那半句的出现条件就写在那个函数里** ——
 * 它是本 Task 唯一一句可能不为真的话,故判定必须留在可逐条断言的纯函数一侧。
 */
import type { Pairing } from '../channel/handshake'
import type { LastHandshake } from '../channel/handshakeClient'
import type { TakeoverConfigView } from '../contract'
import type { SniffBucket } from '../sniff/sniffBucket'
import {
  buildSniffSections,
  type SniffSectionsView,
  type SniffSendState
} from '../sniff/sniffView'
import type { WakeState } from '../sw/lifecycle'

/**
 * ★ v0.4 Task 6:「用 DownLord 下载此页视频」这一次点击的处境。
 *
 * **只活在本次 popup 打开期间**(popup 每次打开都是全新文档),`undefined` = 还没点过。
 * **一个字节都不落 storage** —— 「上次点过」对这次毫无意义。
 */
export type VideoIntentState =
  | { phase: 'sending' }
  | {
      phase: 'taken'
      /** DownLord **明确收下**了登录态的域;空数组 = 一个都没有,那半句话就不出现 */
      cookieDomains: string[]
      /** 有域因载荷超 64KB 而没发出去 */
      cookieTooLarge: boolean
    }
  | { phase: 'failed' }
  /** ★ 读不到当前标签页地址(受限页 —— 探针 B4 实测确有此情形)。**不能崩、也不能装作拿到了** */
  | { phase: 'no_url' }

/** 缺失事实的统一占位(约定 L5:任何一项都可能读不到,不许崩、不许显示 `undefined`) */
export const MISSING_PLACEHOLDER = '—'

/** 一分钟的毫秒数(与主进程 `pauseState.ts` 同一常量;此处**只用于显示**,不参与任何判定) */
const MS_PER_MINUTE = 60_000

/**
 * 暂停时长档(**纯时间三档**,spec §5.2)。
 *
 * ⚠️ **手抄自 DownLord 侧的同名常量,不是值导入** —— 「契约单向穿透」只许 `import type`
 *    (值导入会把主仓代码 bundle 进扩展,断言 A9 当场变红)。两侧取值不一致**不会出错**
 *    (`minutes` 是自由数字,主进程照单全收),但会让同一个用户在 popup 与设置页看到两套档位。
 * ⚠️ **没有「直到关闭浏览器」**:DownLord 无从得知浏览器何时关闭(通道无反向推送、sw 空闲即销毁,
 *    「久无握手」既可能是浏览器关了、也可能只是用户一天没下载)。分不清就不假装分得清。
 * ⚠️ **没有「永久暂停」**:那是**关闭接管**(总开关),语义不同、入口不同 —— 在 DownLord 设置页,
 *    不在这里。混在一起会让用户以为「暂停」也是永久的。
 */
export const PAUSE_PRESETS: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 240, label: '4 小时' }
]

/**
 * 一次问到的接管状态 —— **快照与「读到它那一刻的本机时刻」绑成同一个值**。
 *
 * ⚠️ `at` 不是冗余字段:「剩余 N 分钟」= `pausedUntil − at`,这两个数**必须同源**。
 *    Step 6a 的设置页正是在这里踩过 —— 拿一个旧时刻去减刚写回的 `pausedUntil`,
 *    `Math.ceil` 把偏差整个藏了起来,三档一律显示 16 / 61 / 241 分钟。
 *    绑成一个类型之后,**想传一份不带时刻的快照都传不进来**。
 */
export interface TakeoverSnapshot {
  config: TakeoverConfigView
  /** 拿到 `config` 那一刻的本机时刻(epoch ms) */
  at: number
}

/** 装配点读回的原始事实。`wake` 为 `undefined` = storage 里还没有(冷启动 / 尚未被唤醒过)。 */
export interface PopupFacts {
  extensionVersion: string
  extensionId: string
  wake: WakeState | undefined
  /** `undefined` = 未配对 */
  pairing: Pairing | undefined
  /** `undefined` = 本次安装以来还没握过手 */
  lastHandshake: LastHandshake | undefined
  /** 未配对时端口输入框的预填值(装配点注入 `channel/protocol.ts` 的 `DEFAULT_PORT`,数据层不写魔法数) */
  defaultPort: number
  /** 扩展侧协议版本(装配点注入 `PROTOCOL_VERSION`,同上) */
  protocolVersion: number
  /**
   * 接管状态。`undefined` = **这次没问到**(未配对 / 连不上 / 应答不合协议三者收敛到同一个值)。
   *
   * ⚠️ 「没问到」**不等于**「没暂停」—— 故它不是 `TakeoverConfigView` 加个默认值就能替代的。
   */
  takeover: TakeoverSnapshot | undefined
  /**
   * ★ v0.4 Task 5:**popup 自己那份**构建标记(编译期 define 进 `popup.js`)。
   */
  buildId: string
  /**
   * ★ **sw 自己报上来的那份**(经 `SwSyncReply.buildId`)。`undefined` = 没问到 ——
   * sw 没应答 / 应答形状不认(**含旧 sw 回不出这个字段**)。
   *
   * ⚠️ **`undefined` 一律按「不一致」处理,绝不当作一致**:失效模式②(浏览器缓存了旧的 SW 脚本)
   *    下 popup 新、sw 旧,而「沉默」正是那种情形最可能的表现。把沉默读成一致,
   *    给出的就是和 `manifest.version_name` 一模一样的**错误安心感** —— #53 堵的正是这个。
   */
  swBuildId: string | undefined
  /** 嗅探开关(读自 `storage.local`,默认关) */
  sniffEnabled: boolean
  /** 当前标签页的嗅探桶;`undefined` = 该 tab 还没有桶(没嗅到过任何东西 / 开关刚开) */
  sniff: SniffBucket | undefined
  /** 用户**在本次 popup 打开期间**刚把开关拨到「开」—— 此时本页请求早已发生过,嗅不到 */
  sniffJustEnabled: boolean
  /**
   * ★ Phase 2:**本次 popup 打开期间**各条资源的转交结果(key = 完整 URL)。
   *
   * ⚠️ **不落任何 storage**(约定 L1 的正向应用):popup 每次打开都是全新文档,重开即回默认 ——
   *    这正是它该有的语义。「上次那条发过了」对这次毫无意义,留着反而会让用户以为它还在下。
   */
  sniffSent: Readonly<Record<string, SniffSendState>>
  /**
   * ★ v0.4 Task 6:「用 DownLord 下载此页视频」这一次点击的处境;`undefined` = 还没点过。
   * **不落 storage**(与 `sniffSent` 同一条约定)。
   */
  videoIntent: VideoIntentState | undefined
}

/** 交给渲染层的成品:全部是可直接写进 DOM 的字符串,渲染层不再做判断。 */
export interface PopupModel {
  version: string
  extensionId: string
  wakeCount: string
  lastEvent: string
  /** 是否已保存过配对码 —— 渲染层据此决定配对码输入框的 placeholder 措辞 */
  paired: boolean
  /**
   * 配对码这一行的取值:**只说「保存了没有」**,不说「配对成不成」。
   *
   * ⚠️ **刻意不叫「已配对 / 未配对」**:那两个词在 DownLord 侧是**基于握手**的结论
   * (`lastActiveAt` 有没有值),在扩展侧却只能表示「storage 里有没有这串字符」——
   * 同词不同义会让人看到「连不上 DownLord」+「已配对」这种自相矛盾的组合
   * (2026-07-31 手测 B3/B4 实际踩到)。**我们不知道这串码对不对,就不声称它对**;
   * 对不对由下面的 `connection` 行如实说。
   */
  pairingStatus: string
  /** 端口输入框的预填值 */
  portValue: string
  /** 结果行:最近一次握手的诚实结论(spec §2.4 四原因码逐条) */
  connection: string
  /**
   * ★ Phase 2:**连接结论异常时**提升到三区之间的那一行常驻告警;正常(`reason === 'ok'`)时空串。
   *
   * 判据刻意**不只看失败码,也把「还没配对 / 本次尚无结果」算进异常**:这两种情形下点资源行的
   * 「下载」必然什么都不会发生,而那正是最该常驻一句话的时候。文案与诊断区里那一行**同源同字**
   * (就是 `connection` 本身),不另写一套 —— 两处各说各话比埋在下面更糟。
   *
   * 「异常时提升为常驻行、正常时折回诊断区」这个模式 **Task 3 Step 5 已有先例**
   * (端口提示改 toast + 常驻行),不是新发明。
   */
  connectionAlert: string
  /**
   * 接管状态这一行的取值:`接管中` / `已暂停 · 剩余 N 分钟(至 HH:MM)` / `已关闭` / 占位符。
   *
   * ★ **措辞纪律的一处例外 —— 写明,免得日后有人机械套用「配对」那条教训把它改坏**:
   *   CONTEXT.md「配对」词条踩出的推广口径是「**两侧都有的词,若判定依据不同,就不许共用**」,
   *   popup 因此只能说「配对码**已保存 / 未保存**」而不能说「已配对」—— 后者在 DownLord 侧是
   *   **基于握手**的结论,扩展侧却只知道「storage 里存没存过这串字符」,判据根本不是一回事。
   *   **但接管状态这一行不受此限**:它的取值直接来自 DownLord 对 `takeover.getConfig` 的应答,
   *   连 `paused` 都是**服务端算好的**(免得两侧各判一次时钟),判定依据与 DownLord 侧**完全同源**。
   *   同一个事实、同一个判据 → **可以且应当**共用同一套词。
   */
  takeoverStatus: string
  /** 是否正暂停中 —— 渲染层据此在「三档按钮」与单个「恢复接管」之间二选一 */
  takeoverPaused: boolean
  /** 时长按钮能不能按(没问到 / 接管已关闭时不能,见 `describeTakeover` 的注释) */
  takeoverActionable: boolean
  /** 诊断区那一行显示的构建标记(popup 自己那份) */
  buildId: string
  /** popup 与 sw 的标记是否不一致(**含 sw 没回**)—— 渲染层据此决定要不要出告警行 */
  buildIdMismatch: boolean
  /** 不一致时的整句告警;一致时是空串 */
  buildIdWarning: string
  /** 嗅探开关当前状态 —— 渲染层据此设复选框 */
  sniffEnabled: boolean
  /** 「本页资源」那一行的取值:`已关闭 · N 条` / `N 条` / `N 条 · 另检测到 M 个分片请求` */
  sniffCount: string
  /**
   * ★ Phase 2:资源区的**成品视图**(两组 + 三种提示行 + 四种非列表状态)。
   *
   * 由 `sniff/sniffView.ts` 的 `buildSniffSections` 产出,里面**全是可直接写进 DOM 的字符串**——
   * 渲染层只做「数组 → DOM」,一个业务 `if` 都不写。
   */
  sniff: SniffSectionsView
  /**
   * ★ v0.4 Task 6:「用 DownLord 下载此页视频」按钮**能不能按**。
   *
   * ⚠️ **只在「正在发送」时为 `false`**(防连点,与资源行按钮同一手法)。
   *    **绝不因为「这一页看起来不像视频页」而禁用** —— 要判断就得注入 content script(表外权限)
   *    或写不可靠的 URL 启发式,而 yt-dlp 支持上千站点,**我们本来就判断不了**(spec §7.4)。
   */
  videoIntentEnabled: boolean
  /** 按钮下方那一行实话;空串 = 不渲染(还没点过) */
  videoIntentMessage: string
}

function orPlaceholder(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : MISSING_PLACEHOLDER
}

/**
 * 四原因码的文案 —— **逐字取自 spec §2.4 表格的「扩展侧文案」列**。
 * 三种修法互不重叠(开应用 / 重新配对 / 升级某一边),不写「未知错误」「请重试」这类空话。
 */
function describeHandshake(facts: PopupFacts): string {
  const { lastHandshake, pairing, defaultPort, protocolVersion } = facts

  if (!lastHandshake) {
    return pairing
      ? '配对码已保存,本次尚无握手结果 —— 点「保存并连接」可立刻试一次'
      : '尚未保存配对码 —— 填入端口与配对码后点「保存并连接」'
  }

  switch (lastHandshake.reason) {
    case 'ok':
      return lastHandshake.appVersion
        ? `已连接 DownLord(应用 v${lastHandshake.appVersion})`
        : '已连接 DownLord'
    case 'unreachable':
      return '连不上 DownLord。请确认:① DownLord 正在运行 ② 设置页「浏览器扩展」里的本地通道已启用 ③ 端口填的是 DownLord 里显示的那个'
    case 'unauthorized':
      return '配对码不被接受。请到 DownLord 设置页「浏览器扩展」重新复制配对码后重新配对'
    case 'protocol_mismatch':
      // 拿得到对端版本 → 直说哪边旧;拿不到(响应形状都不对)→ 改口说端口上可能是别的程序,
      // 这是**必要的诚实**:端口确实可能被别人占了(spec §3.7⑤)
      return lastHandshake.appProtocolVersion === undefined
        ? `端口 ${pairing?.port ?? defaultPort} 上的服务没有按 DownLord 协议应答 —— 可能是别的程序占用了这个端口,或两侧版本不一致`
        : `协议版本不一致:DownLord 侧 v${lastHandshake.appProtocolVersion}、扩展侧 v${protocolVersion},请升级较旧的一边`
  }
}

/** `至 15:30` 里那个时刻(只到分、不带日期 —— 三档最长 4 小时,不会跨到看不懂的日期) */
function clockText(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 接管状态这一行的文案(spec §5.4)。
 *
 * ⚠️ **措辞逐字对齐 DownLord 设置页的 `takeoverStateText`** —— 第一态取「**接管中**」而不是
 *    spec §5.4 行文里的「已开启」。spec 在 §5.4(popup)与 §5.5(设置页)对**同一个态**给了两个词,
 *    而共用词这条纪律的**目的**正是「同一事实两侧说法一致」;照 §5.4 的字面写,反倒会让用户在
 *    两个界面看到两种说法。取值同源、判据同源,措辞就该同字。
 *
 * ⚠️ **popup 天然没有设置页的第四态**(「本地通道未启动 · 接管不会发生」):通道没在监听时,
 *    popup 连 `takeover.getConfig` 都发不出去 —— 那种情形会落进下面的「没问到」分支,
 *    由既有的握手结果行如实说明原委(「连不上 DownLord。请确认 …」)。这不是遗漏,是同一个事实
 *    在两侧各自能拿到的最诚实形态。
 *
 * ⚠️ **没问到就说不知道,绝不留上次的值** —— 那正是 CONTEXT.md「临时暂停接管」警告的
 *    「只能显示最近一次听说的」。popup 不存接管状态,所以这里连「上次的值」都拿不到(约定 L1)。
 */
function describeTakeover(snapshot: TakeoverSnapshot | undefined): string {
  if (!snapshot) return MISSING_PLACEHOLDER

  const { config, at } = snapshot
  if (!config.enabled) return '已关闭'
  if (config.paused) {
    // 服务端说在暂停中却没给到期时刻(形状允许、实现不会) —— 如实说「已暂停」,**不编一个时长出来**
    if (config.pausedUntil === null) return '已暂停'
    // 下限 1:本机时钟与主进程时钟同源(同一台机器),但这一帧仍可能卡在到期瞬间。
    // 宁可显示「剩余 1 分钟」也不显示 0 / 负数 —— 后者看着像 bug,而真相只是「马上就到期」。
    const left = Math.max(1, Math.ceil((config.pausedUntil - at) / MS_PER_MINUTE))
    return `已暂停 · 剩余 ${left} 分钟(至 ${clockText(config.pausedUntil)})`
  }
  return '接管中'
}

/**
 * 时长按钮能不能按。
 *
 * - **没问到** → 不能:遥控器此刻够不着 DownLord,按下去不会有任何事发生,给个能按的按钮是骗人。
 * - **已关闭** → 不能:暂停一个已经关掉的接管**没有任何可观察效果**;要开回来得去 DownLord
 *   设置页(「关闭」与「暂停」语义不同、入口不同,spec §5.2)。
 */
function isTakeoverActionable(snapshot: TakeoverSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.config.enabled
}

/**
 * buildId 一致性告警(`docs/TODO.md` #53)。一致 → 空串;不一致 → 整句告警。
 *
 * ⚠️ **不许只读 popup 自己那份**:`popup.js` 与 `sw.js` 是两个独立产物,失效模式②下
 *    popup 新、sw 旧 —— 只读自己那份会给出**和 `manifest.version_name` 一模一样的错误安心感**。
 *    #53 堵的不只是 manifest,是**任何不由 sw 自己开口的读法**。
 *
 * ⚠️ `swBuildId === undefined`(sw 没回)天然落进「不一致」分支 —— 这是有意的,
 *    **沉默不是一致**。
 */
function describeBuildIdWarning(popupBuildId: string, swBuildId: string | undefined): string {
  if (swBuildId === popupBuildId) return ''
  return (
    `⚠ popup 与后台脚本版本不一致(popup ${orPlaceholder(popupBuildId)} / ` +
    `后台 ${orPlaceholder(swBuildId)}),请在 edge://extensions 里重新加载扩展`
  )
}

/**
 * 「本页资源」那一行。**提示语一律写「本页」不写「本会话」** ——
 * 切了标签页就看不到原页面的资源,「本会话」会让人以为切回去还在(CONTEXT.md「嗅探」条)。
 *
 * 分片**只报计数、不列条目**:分片流聚合成一条是指「归属到它们的清单那一条上」,不是拼起来。
 * Phase 1 还没有列表,故这里先如实说「另检测到 N 个分片请求」。
 *
 * ★ **关着时也报条数**(2026-08-09 真机验收改):原先关着一律只说「已关闭」,
 *   于是「桶到底清干净没有」在界面上**不可观察** —— 清桶失败会被一句安心的「已关闭」盖住。
 *   现在写成「已关闭 · 0 条」:正常态用户能确认真的清了,异常态(残留 N 条)当场看得见。
 */
function describeSniffCount(facts: PopupFacts): string {
  const items = facts.sniff?.items.length ?? 0
  const segments = facts.sniff?.segmentCount ?? 0
  const detail = segments > 0 ? `${items} 条 · 另检测到 ${segments} 个分片请求` : `${items} 条`

  return facts.sniffEnabled ? detail : `已关闭 · ${detail}`
}

/**
 * 连接结论要不要提升为常驻行。
 *
 * ⚠️ **「没握过手」也算异常**:握手是事件驱动的,而 popup 一打开就会叫醒 sw 握一次 ——
 *    等到渲染完仍拿不到结果,对用户而言与「连不上」在**可观察行为**上没有区别
 *    (点下载照样没反应)。分不清就不假装分得清,但也不能因为分不清就不说。
 *
 * ⚠️ 这**不是** CONTEXT.md「待活动」那条的反例:「待活动」说的是 **DownLord 侧**不该把
 *    「久无握手」判成「断开」——那是**长期**没听到消息;这里是**本次打开当场**没握上。
 */
function describeConnectionAlert(facts: PopupFacts, connection: string): string {
  return facts.lastHandshake?.reason === 'ok' ? '' : connection
}

/**
 * ★ v0.4 Task 6:「用 DownLord 下载此页视频」那一行实话。
 *
 * 🔴 **「(已附 `<域名>` 的登录态)」只在确实收到 `cookie.offer` 的成功应答时才追加** ——
 *    没选第四档、没点名、送不出去、超上限,这半句**一律不出现**。
 *    与 CONTEXT.md「黑洞」词条那次订正是同一把尺子:「浏览器那边**已经**取消」被改成
 *    「**已请求**浏览器取消……」,原话是**诚实的前提是那句话恒为真,不是听起来干脆**。
 *    这里若把它写成「已附登录态(如果有)」或恒显示,用户就会把随后的「需要登录」
 *    当成站点问题去查 —— 而按日志红线,日志里既没有域名也没有值可查。
 *
 * ⚠️ 「读不到地址」那一档**必须存在且必须说实话**(探针 B4):`edge://…` / 新建标签页 /
 *    扩展商店这类页面不在 `<all_urls>` 匹配范围内,`Tab.url` 恒被抹掉。
 *    **按钮恒可点 ≠ 恒能拿到地址**。
 */
function describeVideoIntent(state: VideoIntentState | undefined): string {
  if (!state) return ''

  switch (state.phase) {
    case 'sending':
      return '正在交给 DownLord…'
    case 'taken': {
      const cookie =
        state.cookieDomains.length > 0
          ? `(已附 ${state.cookieDomains.join('、')} 的登录态)`
          : ''
      const tooLarge = state.cookieTooLarge ? ' · 登录态过大,未能提供' : ''
      return `已交给 DownLord,请在 DownLord 窗口确认${cookie}${tooLarge}`
    }
    case 'failed':
      return '没能交给 DownLord,请确认它正在运行'
    case 'no_url':
      return '读不到当前标签页地址 —— 浏览器内置页面(设置、新标签页、扩展商店)不对扩展提供地址,请在普通网页上使用'
  }
}

export function buildPopupModel(facts: PopupFacts): PopupModel {
  const count = facts.wake?.count
  const paired = facts.pairing !== undefined
  const buildIdWarning = describeBuildIdWarning(facts.buildId, facts.swBuildId)
  const connection = describeHandshake(facts)

  return {
    version: orPlaceholder(facts.extensionVersion),
    extensionId: orPlaceholder(facts.extensionId),
    wakeCount:
      typeof count === 'number' && Number.isFinite(count)
        ? String(Math.floor(count))
        : MISSING_PLACEHOLDER,
    lastEvent: orPlaceholder(facts.wake?.lastEvent),
    paired,
    pairingStatus: paired ? '已保存' : '未保存',
    portValue: String(facts.pairing?.port ?? facts.defaultPort),
    connection,
    connectionAlert: describeConnectionAlert(facts, connection),
    takeoverStatus: describeTakeover(facts.takeover),
    // ⚠️ 带上 `enabled`:接管已关闭时,`paused` 是什么都不该影响按钮组 —— 状态那一行按序判定的
    //    第一条就是「已关闭」,按钮组要跟它一致,否则会出现「已关闭 + 恢复接管」这种自相矛盾的组合。
    takeoverPaused: facts.takeover?.config.enabled === true && facts.takeover.config.paused,
    takeoverActionable: isTakeoverActionable(facts.takeover),
    buildId: orPlaceholder(facts.buildId),
    buildIdMismatch: buildIdWarning !== '',
    buildIdWarning,
    sniffEnabled: facts.sniffEnabled,
    sniffCount: describeSniffCount(facts),
    sniff: buildSniffSections(
      facts.sniff,
      facts.sniffEnabled,
      facts.sniffJustEnabled,
      facts.sniffSent
    ),
    videoIntentEnabled: facts.videoIntent?.phase !== 'sending',
    videoIntentMessage: describeVideoIntent(facts.videoIntent)
  }
}
