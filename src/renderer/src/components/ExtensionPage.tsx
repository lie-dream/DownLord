/**
 * 「浏览器扩展」页(v0.4 Task 5 · spec §5)—— 左导航功能区原「网页嗅探」「浏览器接管」两行 `soon`
 * 合并激活后的落点。走 **独立页型**(与 `HistoryPage` / `SettingsPage` 同类:`NavKey` 加值 +
 * `App.tsx` 三元链加一支 + 独立组件),**无计数**:它不筛任务,是一整页信息。
 *
 * **三块**(spec §5.2):
 * ① 连接状态 —— **只读镜像**:复用设置页**同一对** IPC(`getExtensionChannelStatus` +
 *    `onExtensionChannelStatusChanged`),**不新增通道**。本页**没有**端口输入框 / 配对码 /
 *    「重新生成 token」/ 启用开关,要改配置只有一个出口:「前往设置页配置」。
 *    ⚠️ 「只读镜像」不是靠注释保证的,是靠**接口形状** —— 本文件压根没有引入任何写通道配置的 api
 *    (`setExtensionChannelConfig` / `regenerateExtensionToken` 在这里连名字都不出现)。
 * ② 下载接管 —— **可切换**(与①不矛盾:①是*连接状态*,本来也没法在这边切;②是*接管状态*,
 *    有真源、有写通道)。复用 `getTakeoverConfig` / `setTakeoverPause` / `onTakeoverConfigChanged`。
 *    **四态文案与三档时长从 `../lib/extensionView` 取,与设置页同源** —— 同一个状态在两个地方说
 *    两种话是最典型的不一致源(U-34)。总开关与域名例外表**只在设置页一处**,本页不重复造。
 * ③ 网页嗅探 —— 引导 + 隐私说明三句。
 *    **没有资源列表**:`sniff.report` 已取消,未选中的资源从不离开浏览器,主进程根本没有这份数据。
 *    **没有嗅探开关**:真源在扩展侧 `storage.local`,而本地通道**无反向推送** ⇒ DownLord 只能显示
 *    「最近一次听说的」,与「待活动」是同一种分不清(CONTEXT.md「临时暂停接管」已为这种情形定过性)。
 *
 * **渲染纯 UI**(ARCHITECTURE §7.2):本页零业务逻辑 —— 状态合成 / 校验 / 持久化全在主进程,
 * 这里只 invoke + 订阅 + 展示,一切结论以主进程回包为准。
 *
 * ⚠️ **IPC 缺失时 `window.api.xxx()` 是同步抛 `TypeError`**(不是 rejected promise)——
 *    照 `ExtensionChannelSettings` 既有写法用 `try/catch` 包住,只挂 `.catch()` 接不住(2026-08-04 踩过)。
 * ⚠️ 两条订阅**卸载即退订**(既有 `onXxx` 返回取消函数)。
 *
 * 样式:结构类 `.set-group` / `.set-card` / `.set-row` / `.sr-*` / `.up-note` 全部复用 SettingsPage.css
 * (全局,App 静态 import SettingsPage 故必被注入);本页只加容器与两个布局细节类,零新造色值。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ExtensionChannelStatus, TakeoverSettingsView } from '../../../shared/ipc'
import {
  FALLBACK_STATUS,
  FALLBACK_TAKEOVER,
  LINK_NOTE,
  PAUSE_PRESETS,
  SNIFF_PRIVACY_NOTE,
  linkText,
  serviceText,
  takeoverStateText
} from '../lib/extensionView'
import type { NavKey } from '../lib/types'
import { useToast } from '../state/toastStore'
import './ExtensionPage.css'

interface Props {
  /** 页内跳转(唯一用途:「前往设置页配置」→ `'settings'`),与 App 的 gotoNav 同构 */
  onNavChange: (key: NavKey) => void
}

/**
 * 行首图标(描边风格与左导航 / 设置页同源)。
 *
 * ⚠️ 2026-08-11 用户手测提出:① 区文字量少、又全是浅色小字,**没有图标**,整块糊成一片读不清。
 *    故状态行填上真图标(此前只有 `.sr-icon` 空占位),并把**值**提到主文本色 —— 标签与说明维持浅色。
 */
const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** 本地通道:插头(lucide plug) */
const IconPlug = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
)
/** 浏览器扩展:拼图块(lucide puzzle) */
const IconPuzzle = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />
  </svg>
)
/** 临时暂停:时钟(lucide clock) */
const IconClock = (): React.JSX.Element => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)
/** 网页嗅探:雷达扫描(lucide radar 简化) */
const IconScan = (): React.JSX.Element => (
  <svg {...svgProps}>
    <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
    <path d="M4 6h.01" />
    <path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" />
    <path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" />
    <path d="M12 18h.01" />
    <path d="M17.99 11.66A6 6 0 0 1 15.77 16.67" />
    <circle cx="12" cy="12" r="2" />
  </svg>
)

/** 一行「标签 + 值」:值提到主文本色,标签维持浅色 —— 层次靠字号与颜色,不靠新色值 */
function StatLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="ep-stat">
      <span className="ep-k">{label}:</span>
      <span className="ep-v">{value}</span>
    </div>
  )
}

export default function ExtensionPage({ onNavChange }: Props): React.JSX.Element {
  // 连接状态:**只读**镜像,全部由主进程合成并广播,本页只回显
  const [status, setStatus] = useState<ExtensionChannelStatus | null>(null)
  // 接管配置:唯一真源在主进程,本页只回显 + 上报意图
  const [takeover, setTakeover] = useState<TakeoverSettingsView | null>(null)
  /**
   * 「剩余 N 分钟」随时间走,而配置本身不变 —— 每 30 秒取一次当前时刻重算这段文字。
   * **这不是「暂停靠定时器实现」**:到期与否恒由主进程现算,停掉它最坏只是数字不刷新。
   */
  const [nowMs, setNowMs] = useState(() => Date.now())
  const { showToast } = useToast()

  /**
   * 接管配置落地的**唯一入口**:配置与「算剩余用的时刻」必须**同一批更新**。
   * (与设置页同一纪律:时刻若停在挂载那一刻,`Math.ceil` 会把差值压成恒 +1,三档显示 16/61/241。)
   */
  const applyTakeover = useCallback((next: TakeoverSettingsView): void => {
    setTakeover(next)
    setNowMs(Date.now())
  }, [])

  // 连接状态:挂载读一次 + 订阅广播(起停 / 重绑 / 握手 / 重新生成后主进程推送)
  useEffect(() => {
    let alive = true
    try {
      void window.api
        .getExtensionChannelStatus()
        .then((s) => void (alive && setStatus(s)))
        .catch(() => {})
    } catch {
      // 主进程未就绪 / IPC 缺失:保持兜底渲染,不白屏(同步抛,.catch 接不住)
    }

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
      off?.()
    }
  }, [])

  // 接管配置:挂载读一次 + 订阅广播(**设置页与 popup 遥控器都会写这份真源**,不订阅就会显示自己最后写的值)
  useEffect(() => {
    let alive = true
    try {
      void window.api
        .getTakeoverConfig()
        .then((t) => void (alive && applyTakeover(t)))
        .catch(() => {})
    } catch {
      // 同上:保持兜底渲染(默认开、未暂停)
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

  // 「剩余 N 分钟」的走字(只影响文案,不参与任何判定)
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const st = status ?? FALLBACK_STATUS
  const tk = takeover ?? FALLBACK_TAKEOVER
  const tkState = takeoverStateText(tk, st, nowMs)

  /** 设暂停时长档 / 恢复接管 → 以主进程回包为准(绝对到期时刻由主进程现算) */
  const setPause = (minutes: number | null): void => {
    void window.api
      .setTakeoverPause({ minutes })
      .then((next) => {
        applyTakeover(next)
        showToast(minutes === null ? '已恢复接管' : `已暂停接管 ${minutes} 分钟`)
      })
      .catch(() => showToast('无法与主进程通信,暂停未生效。', 'error'))
  }

  return (
    <div className="extension-page">
      {/* ① 连接状态 —— 只读镜像(两行状态照设置页形制:只读事实陈述行,无 sr-title、只有 .sr-desc.up-note) */}
      <div className="set-group">
        <div className="sg-title">连接状态</div>
        <div className="set-card">
          {/* 两行**不合并**:「端口绑上了」与「扩展连上了」是两件独立的事,
            * 「端口绑成功但没装扩展」完全正常 —— 合并成一行必然要么谎报要么含糊。 */}
          <div className="set-row">
            <span className="sr-icon">
              <IconPlug />
            </span>
            <div className="sr-text">
              <StatLine label="本地通道" value={serviceText(st)} />
            </div>
          </div>

          <div className="set-row">
            <span className="sr-icon">
              <IconPuzzle />
            </span>
            <div className="sr-text">
              <StatLine label="浏览器扩展" value={linkText(st)} />
              {LINK_NOTE[st.link] !== '' && <div className="sr-desc ep-sub">{LINK_NOTE[st.link]}</div>}
            </div>
          </div>

          {/* 要改配置只有这一个出口 —— 端口 / 配对码 / 重新生成 / 启用开关都只在设置页一处 */}
          <div className="set-row">
            <span className="sr-icon" />
            <div className="sr-text">
              <div className="sr-desc">
                端口、配对码与本地通道开关都在设置页里改 —— 这一页只如实显示当下的连接状态。
              </div>
            </div>
            <div className="sr-control">
              <button
                type="button"
                className="btn btn-default"
                onClick={() => onNavChange('settings')}
              >
                前往设置页配置
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ② 下载接管 —— 状态四态 + 三档暂停(可切换,真源在主进程) */}
      <div className="set-group">
        <div className="sg-title">下载接管</div>
        <div className="set-card">
          <div className="set-row">
            <span className="sr-icon">
              <IconClock />
            </span>
            <div className="sr-text">
              <div className="sr-title">临时暂停</div>
              {/* 四态文案与设置页**同源**(../lib/extensionView),不各写一份;`.ep-v` 只提颜色不改字 */}
              <div className="sr-desc ep-v">{tkState}</div>
              {/* 关掉时如实指路:总开关不在本页(它是配置,与域名例外表一样只在设置页一处) */}
              {!tk.enabled && (
                <div className="sr-desc ep-sub">
                  接管总开关与「不接管这些域名」都在设置页里改。
                </div>
              )}
              {/* 「本次启动以来没收到过握手」如实陈述、**不下结论** —— 扩展上报 intent 不需要先握手,
                * 故这既可能是没装扩展、也可能只是还没下载过东西(与「待活动」同一种分不清)。 */}
              {tk.enabled && !tk.paused && st.service === 'listening' && st.link === 'unpaired' && (
                <div className="sr-desc ep-sub">
                  本次启动以来尚未收到扩展的握手 —— 若还没装扩展 / 还没填配对码,接管不会发生。
                </div>
              )}
            </div>
            <div className="sr-control ep-inline">
              {/* 暂停中只给「恢复接管」(此刻用户要的只有这一个动作),与设置页同构 */}
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
        </div>
      </div>

      {/* ③ 网页嗅探 —— 引导 + 隐私说明三句。**无资源列表、无嗅探开关**(见文件头) */}
      <div className="set-group">
        <div className="sg-title">网页嗅探</div>
        <div className="set-card">
          <div className="set-row">
            <span className="sr-icon">
              <IconScan />
            </span>
            <div className="sr-text">
              <div className="sr-desc ep-v">
                嗅探到的资源在扩展 popup 里查看 —— 点浏览器工具栏上的 DownLord 图标。
              </div>
              {/* 如实说明开关为什么不在这儿:真源在扩展侧,通道无反向推送,DownLord 看不到它的状态。
                * 与其显示一个「最近一次听说的」值,不如说清它在哪儿。 */}
              <div className="sr-desc ep-sub">
                嗅探开关在 popup 里,默认关闭 —— 它的状态由扩展自己保存,DownLord 这边看不到。
              </div>
              {/* 隐私说明完整版三句:与设置页**同一个常量**(SNIFF_PRIVACY_NOTE),不各写一份 */}
              <div className="sr-desc ep-sub">{SNIFF_PRIVACY_NOTE}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
