/**
 * ★ 唯一允许跨目录取主仓契约的文件(v0.4 Task 2 · spec §2.1「contract.ts 收口」)。
 *
 * 只用 `export type { … } from`(纯类型 re-export)—— esbuild 整条擦除,产物里不留任何痕迹。
 * **绝不可**改成值导出 `export { … }`:那会把 `src/shared/` 真的 bundle 进扩展,
 * 「契约单向穿透」当场破功。判据见 plan 1.8 第 5 条(产物 grep 计数为 0)。
 *
 * 其余扩展代码一律从本文件再取,不直接跨目录 import —— 边界从「靠人记住」变成「配置上只有一个门」。
 *
 * v0.4 Task 3 追加连接参数 / 信封 / 原因码 —— **真消费点**在 `channel/protocol.ts`
 * (四个常量的字面量类型标注)与 `channel/handshake.ts`(信封与响应形状)。此前本文件被零人 import,
 * 断言 A9 因而空转(`docs/TODO.md` #45)。
 *
 * v0.4 Task 4 追加 `DownloadIntent` / `DownloadIntentAck` —— 消费点在 `downloads/intent.ts`;
 * Phase 4 再追加 `TakeoverConfigView` / `TakeoverSetPause` —— 消费点在 `channel/takeoverConfigClient.ts`
 * (popup 遥控器)。**仍只加真用到的** —— `TakeoverSettingsView` 那种带 `excludedDomains` 的形状
 * 是设置页走 IPC 的类型,**永不经本地通道下发**,故这里连名字都不出现。
 *
 * ★ v0.4 Task 5 起本文件有了**第二个来源** `src/shared/sniffMedia.ts`(嗅探清单的真源)。
 *   这不是把门开大 —— 门仍然只有本文件一个(eslint 只对本文件关掉 `no-restricted-imports`),
 *   只是门后多了一个房间。取的同样**只有 tuple 类型**,消费点在 `sniff/mediaExts.ts`
 *   (五个清单的手抄字面量各带一个类型标注),主仓改一个元素 → 那边立刻 `typecheck:ext` 红。
 *
 * v0.4 Task 6 追加四支:`VideoIntent`(消费点 `popup/videoIntentClient.ts`)与
 * `CookieOffer` / `OfferedCookie` / `CookieOfferAck`(消费点 `cookies/cookieClient.ts`
 * 与 `cookies/cookieCollect.ts`)。⚠️ **`needCookieFor` 不在这里出现** —— 它是既有
 * `DownloadIntentAck` 的一个可选键,不是新类型。
 */
export type {
  CookieOffer,
  CookieOfferAck,
  DownloadIntent,
  DownloadIntentAck,
  ExtensionChannelDefaultPort,
  ExtensionChannelMaxBodyBytes,
  ExtensionChannelPath,
  ExtensionChannelReason,
  ExtensionChannelRequest,
  ExtensionChannelResponse,
  ExtensionChannelTokenHeader,
  ExtensionHello,
  ExtensionHelloAck,
  ExtensionProtocolVersion,
  OfferedCookie,
  SniffAddSelected,
  TakeoverConfigView,
  TakeoverSetPause,
  VideoIntent
} from '../../src/shared/extensionProtocol'

export type {
  SniffMediaExts,
  SniffSegmentContentTypes,
  SniffSegmentExts,
  SniffStreamContentTypes,
  SniffStreamExts
} from '../../src/shared/sniffMedia'
