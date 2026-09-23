/**
 * 本地通道配置持久化(v0.4 Task 3 · spec §3.2 / §5.3 · plan 1.3)。
 *
 * 文件:`<userData>/config/extensionChannel.json`,内容恰好三个键 `enabled` / `port` / `token`。
 * 连接状态是**运行时态**、故意不落库(CONTEXT.md「运行时态」)—— 有单测断言键集合,
 * 防日后有人顺手把 `lastHandshakeAt` 塞进来。
 *
 * 读写机制委托 `../config/jsonConfigStore.ts`(spec §1.4.1 收口),本文件只留本配置特有的轴:
 * 守卫 `isChannelConfig` / 归一(端口非法回落默认)/ **`repairOnInvalid: false` + 自己保障 token**。
 *
 * ★ 为什么 `repairOnInvalid` 是 `false`:用 `true` 会先写一份 `token:''` 的默认、再写一次带 token 的,
 * 首次运行白写两遍。本文件改为「读回后一次性补齐 token 再写一次」,首次运行**只写一次**(有单测守)。
 *
 * ★ token 的生成**不以「用户已启用通道」为条件**(spec §3.2):否则设置页打开时配对码是空的,
 * 用户不知道该等什么。
 */
import { createJsonConfigStore, type JsonConfigStoreFs } from '../config/jsonConfigStore'
import {
  DEFAULT_EXTENSION_CHANNEL_CONFIG,
  type ExtensionChannelConfig
} from '../../shared/ipc'
import { EXTENSION_CHANNEL_TOKEN_HEX_LENGTH } from '../../shared/extensionProtocol'
import { validateChannelPort } from './portValidation'

/** 合法 token 形态:64 位**小写** hex(`crypto.randomBytes(32).toString('hex')` 的唯一产物形态) */
const TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${EXTENSION_CHANNEL_TOKEN_HEX_LENGTH}}$`)

/** token 是否为合法形态(缺失 / 空串 / 大写 / 长度不对一律非法 → 当场重新生成) */
export function isValidChannelToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token)
}

/** 结构守卫:三个字段类型正确即可(取值范围归 `normalize`) */
function isChannelConfig(v: unknown): v is ExtensionChannelConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.enabled !== 'boolean') return false
  if (typeof o.port !== 'number') return false
  if (typeof o.token !== 'string') return false
  return true
}

/** 以本配置的三个轴组装通用 store(每次调用现组,保持既有「path + fs 传参」的无状态签名) */
function channelStore(
  path: string,
  fs: JsonConfigStoreFs
): ReturnType<typeof createJsonConfigStore<ExtensionChannelConfig>> {
  return createJsonConfigStore<ExtensionChannelConfig>({
    path,
    fs,
    cloneDefaults: () => ({ ...DEFAULT_EXTENSION_CHANNEL_CONFIG }),
    guard: isChannelConfig,
    // 合法结构:只取显式字段(丢弃多余键)+ 端口非法回落默认(范围校验归这里)
    normalize: (parsed) => ({
      enabled: parsed.enabled,
      port: validateChannelPort(parsed.port).ok ? parsed.port : DEFAULT_EXTENSION_CHANNEL_CONFIG.port,
      token: parsed.token
    }),
    // ★ 不回写默认:token 的补齐由 `readChannelConfig` 一次性完成,避免首次运行写两遍
    repairOnInvalid: false
  })
}

/** 原子写通道配置(写临时文件 → rename 覆盖;父目录不存在先建) */
export async function writeChannelConfig(
  path: string,
  config: ExtensionChannelConfig,
  fs: JsonConfigStoreFs
): Promise<void> {
  await channelStore(path, fs).write(config)
}

/**
 * 读通道配置(spec §3.2):
 * 文件缺失 / JSON 损坏 / 结构非法 → 回退默认(`enabled:false` / `port:52330`);
 * **token 缺失或非 64 位小写 hex → 当场 `generateToken()` 生成并原子写回一次**。
 *
 * @param generateToken 注入式生成器(真实装配传 `() => generateSecret(crypto)`;单测注入定值)
 */
export async function readChannelConfig(
  path: string,
  fs: JsonConfigStoreFs,
  generateToken: () => string
): Promise<ExtensionChannelConfig> {
  const store = channelStore(path, fs)
  const config = await store.read()
  if (isValidChannelToken(config.token)) return config

  const repaired: ExtensionChannelConfig = { ...config, token: generateToken() }
  await store.write(repaired) // ★ 首次运行的**唯一**一次写
  return repaired
}
