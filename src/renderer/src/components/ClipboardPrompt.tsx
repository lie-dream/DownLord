/**
 * 剪贴板检测提示 — 右下角克制角标(v0.2 Task 4 · spec §9.1)。
 *
 * - 主进程 `ClipboardWatcher` 检测到可下载新链接 → 广播 `clipboard:linkDetected` → App 订阅置态 → 本组件弹出。
 * - **纯展示**(ARCHITECTURE §7.2):识别 / 去重 / 监控权威全在主进程;本组件只把「添加 / 忽略」意图经 props 回调上抛,自身无业务逻辑。
 * - 复用 Toast 的右下角定位与卡片 token(`.toast` 系),仅容器 `pointer-events:auto`(需可点);零新造色值(DESIGN §1/§6)。
 * - 克制不打扰(DESIGN §4):不夺焦(主进程只 `webContents.send`,渲染层不 focus)、~8s 自动消失、同时只一个(App 侧新链接替换旧态)、仅复用 `toast-in` 入场,无其它动效。
 */

import { useEffect } from 'react'
import type { ClipboardLink } from '../../../shared/ipc'
import './ClipboardPrompt.css'

interface Props {
  /** 待提示链接;null → 渲染 null(不占位) */
  link: ClipboardLink | null
  /** 点「添加」:App 打开添加对话框预填该 URL(复用现有添加流程) */
  onAdd: (url: string) => void
  /** 点「忽略」/ ~8s 自动消失:App 清空 clipboardLink 态 */
  onDismiss: () => void
}

/** 自动消失时长:8s(长于纯提示 toast 的 4s,因需给用户点击时间;spec §5.1) */
const AUTO_DISMISS_MS = 8000

/** 类型标签(spec §9.1;video → 视频 / http → 直链下载) */
const KIND_LABEL: Record<ClipboardLink['kind'], string> = {
  video: '视频',
  http: '直链下载'
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** 头部省略保留尾段(完整 URL 经 title 提示;长阈值内原样渲染,便于识别) */
function ellipsizeHead(url: string): string {
  return url.length > 52 ? `…${url.slice(-52)}` : url
}

export default function ClipboardPrompt({
  link,
  onAdd,
  onDismiss
}: Props): React.JSX.Element | null {
  // 挂载 / 换链接起 ~8s 自动消失(link.url 变即重置计时);link=null 时不计时
  useEffect(() => {
    if (!link) return
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [link?.url, onDismiss]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!link) return null

  return (
    <div className="clip-prompt" role="status">
      <div className="clip-ico">
        {link.kind === 'http' ? (
          // 直链:文件图标(与 AddTaskDialog d-ico 同源)
          <svg {...svgProps}>
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <path d="M14 2v6h6" />
          </svg>
        ) : (
          // 视频:胶片图标(与 AddTaskDialog d-ico 同源)
          <svg {...svgProps}>
            <path d="m22 8-6 4 6 4V8Z" />
            <rect x="2" y="6" width="14" height="12" rx="2" />
          </svg>
        )}
      </div>
      <div className="clip-body">
        <div className="clip-title">
          检测到可下载链接
          <span className="clip-kind">{KIND_LABEL[link.kind]}</span>
        </div>
        <div className="clip-url" title={link.url}>
          {ellipsizeHead(link.url)}
        </div>
        <div className="clip-actions">
          <button className="btn btn-primary" onClick={() => onAdd(link.url)}>
            添加
          </button>
          <button className="btn btn-default" onClick={onDismiss}>
            忽略
          </button>
        </div>
      </div>
    </div>
  )
}
