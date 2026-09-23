/**
 * 配对输入的校验与规整 —— **纯函数**(v0.4 Task 3 · spec §4.2 / §6.3)。
 *
 * 不碰 DOM、不碰 storage,于是「粘贴带了换行怎么办」「端口填了 80 怎么办」这类
 * 最琐碎也最容易出错的判断,在 Node 里逐条可断言。
 *
 * **非法就不存、不发请求**,并告诉用户**具体哪一项**不合法 —— 不写「输入有误」这类空话。
 */

/** DownLord 侧 `crypto.randomBytes(32).toString('hex')` 的长度 */
export const TOKEN_LENGTH = 64

/** 只认小写 hex:token 是逐字节比对的身份,大小写混用一定是抄错了或抄漏了 */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/** 1023 及以下是特权端口,DownLord 不会在那里监听 */
export const MIN_PORT = 1024
export const MAX_PORT = 65535

export interface PairingFormInput {
  /** 配对码输入框原文。**粘贴常带首尾空白与换行,必须容忍** */
  token: string
  /** 端口输入框原文 */
  port: string
  /**
   * storage 里是否已有配对码。
   * 已有则允许把配对码留空 = **沿用旧的**(端口与 token 正交,**改端口不必重新配对**,
   * 见 CONTEXT.md「配对」)—— 也免得为了改端口把 token 再往 DOM 里塞一遍。
   */
  hasSavedToken: boolean
}

export type PairingFormResult =
  /** `token` 为 `null` = 用户没重填,沿用已保存的那个 */
  | { ok: true; port: number; token: string | null }
  | { ok: false; field: 'token' | 'port'; message: string }

function invalid(field: 'token' | 'port', message: string): PairingFormResult {
  return { ok: false, field, message }
}

/** `token: null` = 用户没重填,沿用已保存的 */
type TokenCheck = { ok: true; token: string | null } | { ok: false; message: string }
type PortCheck = { ok: true; port: number } | { ok: false; message: string }

function checkToken(raw: string, hasSavedToken: boolean): TokenCheck {
  const token = raw.trim()

  if (token.length === 0) {
    return hasSavedToken
      ? { ok: true, token: null }
      : { ok: false, message: '请粘贴 DownLord 设置页「浏览器扩展」里的配对码' }
  }
  if (token.length !== TOKEN_LENGTH) {
    return {
      ok: false,
      message: `配对码应为 ${TOKEN_LENGTH} 位,当前 ${token.length} 位 —— 请在 DownLord 里点「复制」后完整粘贴`
    }
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, message: '配对码只能含 0-9 与小写 a-f —— 请在 DownLord 里点「复制」,不要手打' }
  }
  return { ok: true, token }
}

function checkPort(raw: string): PortCheck {
  const port = raw.trim()

  if (port.length === 0) {
    return { ok: false, message: '请填写端口(DownLord 设置页第一行显示的那个数字)' }
  }
  // 不用 parseInt:它会把 "52330abc" 读成 52330,静默吞掉用户的笔误
  if (!/^\d+$/.test(port)) return { ok: false, message: '端口必须是纯数字整数' }

  const value = Number(port)
  if (value < MIN_PORT || value > MAX_PORT) {
    return { ok: false, message: `端口须在 ${MIN_PORT}–${MAX_PORT} 之间,当前填的是 ${value}` }
  }
  return { ok: true, port: value }
}

/** 校验整张表单。任一项不合法即返回**那一项**;两项都合法才给出可落库的值。 */
export function validatePairingForm(input: PairingFormInput): PairingFormResult {
  const token = checkToken(input.token, input.hasSavedToken)
  if (!token.ok) return invalid('token', token.message)

  const port = checkPort(input.port)
  if (!port.ok) return invalid('port', port.message)

  return { ok: true, port: port.port, token: token.token }
}
