/**
 * 自定义标题栏(无边框窗口)— 对齐原型 prototype-downlord.html 的 .titlebar。
 *
 * - 左侧:app logo + 名称;中间拖拽区;右侧窗口控制(最小化 / 最大化 / 关闭)。
 * - 走 IPC bridge window.api.{minimize,toggleMaximize,close} 控制窗口(§2.2 窗口控制 IPC)。
 * - `-webkit-app-region: drag` 使标题栏可拖动窗口;按钮区设 `no-drag` 保持可点击。
 * - 最大化/还原按钮图标根据窗口状态动态切换(监听 resize 事件判定)。
 */

import { useState, useEffect } from 'react'
import './TitleBar.css'

export default function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // 监听窗口 resize 事件判定是否最大化(通过对比窗口尺寸与屏幕尺寸)
    const checkMaximized = (): void => {
      const maximized =
        window.innerWidth === window.screen.availWidth &&
        window.innerHeight === window.screen.availHeight
      setIsMaximized(maximized)
    }

    checkMaximized()
    window.addEventListener('resize', checkMaximized)
    return () => window.removeEventListener('resize', checkMaximized)
  }, [])

  const handleMinimize = (): void => window.api.minimize()
  const handleToggleMaximize = (): void => window.api.toggleMaximize()
  const handleClose = (): void => window.api.close()

  return (
    <div className="titlebar">
      {/* App logo + 名称 */}
      <svg
        className="app-logo"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v12" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      <span className="app-name">DownLord</span>

      {/* 拖拽区占位(flex 撑开) */}
      <div className="tb-spacer"></div>

      {/* 窗口控制按钮(no-drag 保持可点击) */}
      <button className="win-btn" onClick={handleMinimize} title="最小化">
        <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        className="win-btn"
        onClick={handleToggleMaximize}
        title={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? (
          // 还原图标:两个叠加的矩形
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="7" y="5" width="11" height="11" rx="1" />
            <path d="M6 9H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
          </svg>
        ) : (
          // 最大化图标:单个矩形
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="5" width="14" height="14" rx="1" />
          </svg>
        )}
      </button>
      <button className="win-btn win-btn-close" onClick={handleClose} title="关闭">
        <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>
  )
}
