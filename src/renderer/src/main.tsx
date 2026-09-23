import './theme/tokens.css'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FluentProvider } from '@fluentui/react-components'
import { lightTheme, darkTheme } from './theme/fluentTheme'
import { ToastProvider } from './state/ToastContext'
import { ThemeProvider } from './state/ThemeContext'
import { TasksProvider } from './state/TasksContext'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ThemeProvider>
        {(resolved) => (
          <FluentProvider theme={resolved === 'dark' ? darkTheme : lightTheme}>
            <TasksProvider>
              <App />
            </TasksProvider>
          </FluentProvider>
        )}
      </ThemeProvider>
    </ToastProvider>
  </StrictMode>
)
