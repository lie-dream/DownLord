/**
 * 代理设置三档 — 复刻原型 prototype-downlord.html 595–621 代理 set-group。
 *
 * - 三档:跟随系统代理(推荐)/ 手动指定代理 / 不使用代理(直连);文案逐字采用原型(诚实措辞已审,
 *   不承诺规避封锁,PRD §4.4)。
 * - 自包含组件(spec §7.3):挂载读 getProxyConfig;选档 / 手动地址经 setProxyConfig 落库并即时生效;
 *   主进程广播 proxy:statusChanged 由 App 下发状态栏(本组件不订阅,状态显示单一来源在状态栏)。
 * - 渲染纯 UI(ARCHITECTURE §7.2):不写代理业务逻辑,经 window.api 调 IPC;手动地址校验授权主进程——
 *   setConfig 回的 ProxyStatus 中「manual 档 effectiveUrl===null」⟺ 地址非法(spec §2.4),据此给可见无效态、不静默。
 * - 供 Task 8 完整设置页直接复用(嵌入本组件,不重做代理 UI)。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ProxyConfig, ProxyMode } from '../../../shared/ipc'
import './ProxySettings.css'

interface RowDef {
  mode: ProxyMode
  title: string
  recommended?: boolean
  desc: string
}

// 文案逐字复刻原型 601 / 602 / 608 / 609 / 616 / 617 行(诚实措辞已审)
const ROWS: RowDef[] = [
  {
    mode: 'system',
    title: '跟随系统代理',
    recommended: true,
    desc: '自动复用 Windows 系统代理(如 Clash 的系统代理模式),国内/国外分流交给代理软件处理。'
  },
  { mode: 'manual', title: '手动指定代理', desc: '为 DownLord 单独指定代理服务器。' },
  { mode: 'direct', title: '不使用代理(直连)', desc: '所有下载强制直连,不走任何代理。' }
]

export default function ProxySettings(): React.JSX.Element {
  const [mode, setMode] = useState<ProxyMode>('system')
  const [manualUrl, setManualUrl] = useState('')
  // 手动地址无效态(仅当用户填了非空地址而主进程校验失败时为 true;空地址不算「填了非法」,保持中性)
  const [invalid, setInvalid] = useState(false)

  // 挂载读取持久化配置(缺失/损坏由主进程回退默认)
  useEffect(() => {
    window.api
      .getProxyConfig()
      .then((c) => {
        setMode(c.mode)
        setManualUrl(c.manualUrl ?? '')
      })
      .catch(() => {})
  }, [])

  // 写配置 → 主进程校验/解析/探测后回 ProxyStatus;manual 档 effectiveUrl===null ⟺ 地址校验失败(spec §2.4)
  const apply = useCallback(async (next: ProxyConfig): Promise<void> => {
    const status = await window.api.setProxyConfig(next)
    const url = (next.manualUrl ?? '').trim()
    setInvalid(next.mode === 'manual' && url !== '' && status.effectiveUrl === null)
  }, [])

  const choose = (m: ProxyMode): void => {
    setMode(m)
    if (m === 'manual') {
      void apply({ mode: 'manual', manualUrl: manualUrl.trim() || null })
    } else {
      setInvalid(false)
      void apply({ mode: m, manualUrl: null })
    }
  }

  // 手动地址 onBlur / 回车提交校验(防抖留待按需;onBlur 已满足 spec §7.2)
  const commitManual = (): void => {
    if (mode !== 'manual') return
    void apply({ mode: 'manual', manualUrl: manualUrl.trim() || null })
  }

  return (
    <div className="set-group proxy-settings">
      <div className="sg-title">代理</div>
      <div className="set-card" role="radiogroup" aria-label="代理模式">
        {ROWS.map((row) => {
          const selected = mode === row.mode
          return (
            <div
              key={row.mode}
              className={`radio-row${selected ? ' sel' : ''}`}
              role="radio"
              aria-checked={selected}
              tabIndex={0}
              onClick={() => choose(row.mode)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  choose(row.mode)
                }
              }}
            >
              <div className="radio" />
              <div className="rr-text">
                <div className="rr-title">
                  {row.title}
                  {row.recommended && <span className="tag-rec">推荐</span>}
                </div>
                <div className="rr-desc">{row.desc}</div>
                {row.mode === 'manual' && selected && (
                  // 阻止冒泡:在输入区交互不应再触发整行 choose(避免重复 setProxyConfig / 抢焦点)
                  <div className="rr-extra" onClick={(e) => e.stopPropagation()}>
                    <input
                      className={`input${invalid ? ' invalid' : ''}`}
                      placeholder="127.0.0.1:7890 或 socks5://..."
                      value={manualUrl}
                      aria-invalid={invalid}
                      onChange={(e) => setManualUrl(e.target.value)}
                      onBlur={commitManual}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitManual()
                      }}
                    />
                    {invalid && (
                      <div className="rr-err">
                        地址无效,请用 http:// 或 socks5:// 等格式并包含端口。
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
