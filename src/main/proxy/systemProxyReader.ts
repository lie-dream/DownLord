/**
 * 真实系统代理读取实现(Task 7 · spec §3.2 / §3.3)。
 *
 * 经 Electron `session.defaultSession.resolveProxy(url)` 以一个**代表性外网 URL** 让系统 / PAC
 * 给出代理判定 —— `resolveProxy` 只查代理配置 / 执行 PAC 脚本,**不发起真实网络请求**,
 * 返回形如 `"PROXY 127.0.0.1:7890"` / `"DIRECT"` 的原始串,交 `parseResolveProxy` 解析。
 *
 * 读系统代理是**主进程主动行为**(引擎不自动读)。本文件依赖 Electron `session`,故与纯解析
 * (`systemProxy.ts`)分离,只在主进程装配(`index.ts`)引入、注入 `ProxyService`;不被单测加载。
 */
import { session } from 'electron'
import type { SystemProxyReader } from './systemProxy'

/** 代表性外网 URL:仅用于让系统 / PAC 给出代理判定,不发真实请求(spec §3.2) */
const PROBE_URL = 'https://www.google.com'

export function createSystemProxyReader(): SystemProxyReader {
  return {
    async read(): Promise<string> {
      return session.defaultSession.resolveProxy(PROBE_URL)
    }
  }
}
