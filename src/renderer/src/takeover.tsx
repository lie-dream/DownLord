/**
 * 接管确认小窗口的渲染入口(v0.4 Task 4 · spec §3.5)。
 *
 * 与主窗口 `main.tsx` **平级但独立**:同一个 renderer 构建的第二个 html 入口,由主进程的
 * 独立 `BrowserWindow` 加载(`takeover.html`)。本文件**只做挂载**(与 `main.tsx` 同一形态),
 * 应用外壳在 `TakeoverApp.tsx`、UI 在 `components/TakeoverDialog.tsx`。
 */
import './theme/tokens.css'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TakeoverApp from './TakeoverApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TakeoverApp />
  </StrictMode>
)
