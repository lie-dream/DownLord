/**
 * 本地通道的网络出口 — **全仓唯一允许出现 `fetch` 全局的文件**(v0.4 Task 3 · spec §5.4.2)。
 *
 * 与 `chromeAdapter.ts` 同一机制:eslint `no-restricted-globals` 对 `extension/src/**` 禁 `fetch`,
 * 只对本文件放行(且**仍禁 `chrome` / `browser`** —— 两个例外放的东西不同)。
 * 判据可核验:`grep -rn "\bfetch(" extension/src/` 只命中本文件。
 *
 * ⚠️ **只透传,不判成败**:`{ status, text }` 原样返回,连「200 算不算成功」都不知道 ——
 * 那是纯函数 `channel/handshake.ts` 的 `classifyHandshakeResponse` 的活(纯函数在外、副作用在内)。
 */
import type { BrowserNet, PostJsonInput, PostJsonResult } from './browserAdapter'

/** 只依赖真用到的那两个成员(照 `ChromeApiSubset` 同一纪律),便于注入最小 fake */
export interface FetchResponseLike {
  status: number
  text(): Promise<string>
}

/**
 * 注入口:形状刻意贴着标准 `fetch`,故 `createFetchNet(fetch)` 零适配代码。
 * 测试注入 fake 时只需实现这一条签名。
 */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  }
) => Promise<FetchResponseLike>

/**
 * 工厂:注入 `fetch` 实现。超时用 `AbortSignal.timeout()` ——
 * **不是** `setTimeout`(约定 L3:sw 一销毁定时器就没了;而 `AbortSignal.timeout` 挂在这一次请求上,
 * 请求本身随 sw 一起消失,不留悬空回调)。
 *
 * 超时 / 连接被拒 / 中止一律**原样抛出**,由 `handshakeClient` 归为 `unreachable` ——
 * 「压根没连上」是**客户端侧**判定,服务端无从应答(spec §2.4)。
 */
export function createFetchNet(fetchImpl: FetchLike): BrowserNet {
  return {
    async postJson(input: PostJsonInput): Promise<PostJsonResult> {
      const response = await fetchImpl(input.url, {
        method: 'POST',
        headers: input.headers,
        body: input.body,
        signal: AbortSignal.timeout(input.timeoutMs)
      })

      return { status: response.status, text: await response.text() }
    }
  }
}

/**
 * 零参工厂 —— 装配点专用(`createDefaultAdapter()` 调它)。
 * `fetch` 全局的读取被收进本文件这一行,于是 `fetch` 字面真的只剩这一处。
 */
export function createDefaultFetchNet(): BrowserNet {
  return createFetchNet(fetch)
}
