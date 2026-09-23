/**
 * 主区工具栏：只转发 App 持有的原始查询和清除意图，清除后的聚焦也归 App。
 * 搜索仅筛选已加载任务的展示；全部开始 / 全部暂停始终保持全局已加载任务范围。
 * 不另存查询、不额外展示或记录来源 / 查询，不增加持久化或网络请求。
 */

import { useId, useRef } from 'react'
import './Toolbar.css'

interface Props {
  title: string
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  onClearSearch: () => void
  searchInputRef: React.RefObject<HTMLInputElement>
  onStartAll: () => void
  onPauseAll: () => void
}

const scopeDescription = '仅搜索已加载任务；全部开始 / 全部暂停不受筛选影响。'
const startDescription = '继续所有已加载的已暂停任务，不受导航、类别和搜索筛选影响。'
const pauseDescription = '暂停所有已加载的下载中任务，不受导航、类别和搜索筛选影响。'

export default function Toolbar({
  title,
  searchQuery,
  onSearchQueryChange,
  onClearSearch,
  searchInputRef,
  onStartAll,
  onPauseAll
}: Props): React.JSX.Element {
  const descriptionId = useId()
  const scopeId = `${descriptionId}-scope`
  const startId = `${descriptionId}-start`
  const pauseId = `${descriptionId}-pause`
  const isComposing = useRef(false)

  return (
    <div className="ctoolbar">
      <h2>{title}</h2>
      <div className="search">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          role="searchbox"
          aria-label="搜索当前列表任务"
          aria-describedby={scopeId}
          placeholder="搜索文件名或来源"
          autoComplete="off"
          spellCheck={false}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onCompositionStart={() => {
            isComposing.current = true
          }}
          onCompositionEnd={() => {
            isComposing.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              event.currentTarget !== event.currentTarget.ownerDocument.activeElement ||
              searchQuery.length === 0 ||
              isComposing.current ||
              event.nativeEvent.isComposing
            ) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            onClearSearch()
          }}
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            aria-label="清除搜索"
            title="清除搜索（Esc）"
            onClick={onClearSearch}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        )}
      </div>
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn-default"
          aria-describedby={startId}
          title={startDescription}
          onClick={onStartAll}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          全部开始
        </button>
        <button
          type="button"
          className="btn btn-subtle"
          aria-describedby={pauseId}
          title={pauseDescription}
          onClick={onPauseAll}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          全部暂停
        </button>
      </div>
      <p id={scopeId} className="toolbar-scope">
        {scopeDescription}
      </p>
      <span id={startId} className="toolbar-sr-only">
        {startDescription}
      </span>
      <span id={pauseId} className="toolbar-sr-only">
        {pauseDescription}
      </span>
    </div>
  )
}
