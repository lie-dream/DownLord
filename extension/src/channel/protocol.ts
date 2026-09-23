/**
 * 扩展侧协议常量 —— **契约的真消费点**(v0.4 Task 3 · spec §2.5 · `docs/TODO.md` #45)。
 *
 * **为什么是手抄字面量而不是值导入**:「契约单向穿透」只许 `import type`,值导入会把主仓代码
 * bundle 进扩展(断言 A9 当场变红)。于是**值不能穿透、只能手抄** —— 而下面每个常量都带了
 * 主仓那侧的**字面量类型标注**,把「手抄错」变成**编译期错误**:
 * 改主仓的 `EXTENSION_CHANNEL_DEFAULT_PORT`,这里的 `52330` 立刻 `typecheck:ext` 红。
 *
 * ⚠️ **命名陷阱(踩过就回不了头)**:断言 A9 断言产物**不含字符串 `EXTENSION_PROTOCOL_VERSION`**。
 * 故扩展侧常量**必须**叫 `PROTOCOL_VERSION`(`'PROTOCOL_VERSION'.includes('EXTENSION_PROTOCOL_VERSION')`
 * 为 `false`,安全);图省事加上 `EXTENSION_` 前缀会让 A9 变红。`DEFAULT_PORT` 同理。
 */
import type {
  ExtensionChannelDefaultPort,
  ExtensionChannelMaxBodyBytes,
  ExtensionChannelPath,
  ExtensionChannelTokenHeader,
  ExtensionProtocolVersion
} from '../contract'

/**
 * ★ 协议版本。改主仓的 `EXTENSION_PROTOCOL_VERSION` → 这一行立刻 typecheck 红(断言 A10)。
 *
 * `1` → `2` 由 v0.4 Task 5 的 `sniff.addSelected` 触发;`2` → `3` 由 v0.4 Task 6 触发
 * (`video.intent` 新增 + `cookie.offer` 转正 + 应答加 `needCookieFor`,**一次 bump 覆盖三处**)。
 * ⚠️ **bump 后必须重装扩展**:版本不等一律 `409` 拒绝、不尽力兼容,旧扩展的表现是
 * 「接管好使、嗅探点了没反应」—— 那正是 bump 规则要在发布前避免的形态。
 */
export const PROTOCOL_VERSION: ExtensionProtocolVersion = 3

/** 默认端口。**用户可改**(popup 里填),这里只是输入框的预填值 —— 端口是连接参数,不是身份。 */
export const DEFAULT_PORT: ExtensionChannelDefaultPort = 52330

/** 通道唯一端点路径(单端点 `POST /channel`) */
export const CHANNEL_PATH: ExtensionChannelPath = '/channel'

/** token 请求头名。**走请求头不走 query** —— query 会进各类 URL 记录(spec §3.5 日志红线)。 */
export const TOKEN_HEADER: ExtensionChannelTokenHeader = 'X-DownLord-Token'

/**
 * ★ v0.4 Task 6:请求体上限(手抄自主仓 `EXTENSION_CHANNEL_MAX_BODY_BYTES`)。
 *
 * **这是 Task 3 的安全参数,本 Task 一个字节不动**。扩展侧要知道它,只为一件事:
 * `cookies/cookieClient.ts` 在**发之前**预检 —— 超限就**不发**并如实告知,
 * **绝不裁剪到放得下**(静默丢几条 cookie 会得到「有 cookie 却仍被拒」这个最难诊断的形态)。
 *
 * ⚠️ 本行原先**没有编译期锚**(主仓那侧写作 `64 * 1024`,算式被 widen 成 `number`,`typeof` 拿不到
 * 字面量)——已于 **Phase 5 补齐**:主仓改成裸字面量 `65536` 并导出 `ExtensionChannelMaxBodyBytes`,
 * 于是这一行与上面四个同构,改主仓那个数字 → 这里立刻 `typecheck:ext` 红。
 */
export const MAX_BODY_BYTES: ExtensionChannelMaxBodyBytes = 65536
