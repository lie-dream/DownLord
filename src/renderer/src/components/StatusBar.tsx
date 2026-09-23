/**
 * 底部状态栏 — 对齐原型 .statusbar。
 *
 * - 全局速度(Σ downloading 速度)+ 活动 / 排队数(实时,App 经 statusBarStats 派生)。
 * - 代理状态接 Task 7 真实状态(proxyStatus:档位文案 + 连通圆点);未就绪时中性占位。
 * - 常驻底部,不随 nav 屏切换。
 */

import { formatSpeed } from '../lib/format'
import type { StatusBarStats } from '../lib/types'
import type { ProxyStatus } from '../../../shared/ipc'
import './StatusBar.css'

export default function StatusBar({
  stats,
  proxyStatus
}: {
  stats: StatusBarStats
  proxyStatus?: ProxyStatus
}): React.JSX.Element {
  // 圆点色按 dot 映射 token 类名(ok=success / warn=warning / off=中性);未就绪 → off + 省略号
  const dot = proxyStatus?.dot ?? 'off'
  const label = proxyStatus?.label ?? '…'
  return (
    <div className="statusbar">
      <span className="s-item">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="12" y1="3" x2="12" y2="17" />
          <polyline points="7 12 12 17 17 12" />
        </svg>
        {formatSpeed(stats.totalSpeed)}
      </span>
      {/* 聚合上行(v0.3 Task 3 · spec §6.5):仅有做种 / 上传活动(totalUpload > 0)时显示,无 BT 活动保持简洁 */}
      {stats.totalUpload > 0 && (
        <span className="s-item">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="12" y1="21" x2="12" y2="7" />
            <polyline points="7 12 12 7 17 12" />
          </svg>
          {formatSpeed(stats.totalUpload)}
        </span>
      )}
      <span className="s-item">
        {stats.activeCount} 个下载中 · {stats.queuedCount} 排队
      </span>
      <span className="spacer" />
      <span className="s-item">
        <span className={`proxy-dot ${dot}`} />
        代理:{label}
      </span>
    </div>
  )
}
