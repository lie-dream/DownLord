import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // electron-updater 必须保持 external(v0.2 Task 6):其含动态 require / 读 yaml / 依赖
        // builder-util-runtime 等,打包内联会破坏;运行时经 require 从 node_modules 解析
        // (electron-builder 将生产依赖打入 asar)。仅外置它,不动既有依赖打包行为(零回归)。
        external: ['electron-updater']
      }
    }
  },
  // ★ 保持**单入口**(v0.4 Task 4 · spec §3.6):electron-vite 的 lib 模式与 CJS 输出保持默认。
  // 接管小窗口与主窗口**共用这一个 preload 文件**,靠 `additionalArguments` 的窗口标记在文件内分支
  // 暴露 `takeoverApi` / `api` —— 不碰 `rollupOptions.input`,构建风险直接消失。
  preload: {},
  renderer: {
    // dev 白屏修复(2026-07-25 真机):Clash 全局 TUN / fake-ip DNS 会劫持 `localhost` 域名解析,
    // electron 连不上 vite dev server 白屏。绑定并以字面 IP 127.0.0.1 生成 ELECTRON_RENDERER_URL,
    // 回环字面 IP 不经 DNS / 不进 TUN 路由;仅影响 dev(打包版走 file://)。
    server: {
      host: '127.0.0.1'
    },
    build: {
      rollupOptions: {
        // v0.4 Task 4 · spec §3.5:接管确认框由**独立 BrowserWindow** 承载,故 renderer 由单 html
        // 入口扩为两个。**本 Task 唯一的构建配置改动**;dev 下 vite 直接按路径服务 `/takeover.html`。
        input: {
          index: resolve('src/renderer/index.html'),
          takeover: resolve('src/renderer/takeover.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
