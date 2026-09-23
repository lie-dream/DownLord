/**
 * 默认清晰度偏好(占位,spec §6.5)。
 *
 * 本 Task 仅**读占位默认** `{ defaultHeight: null, defaultAudioOnly: false }`(= 每次询问 / 弹格式对话框);
 * 真实设置项 + 持久化归 Task 8。TaskManager 经 dep `getVideoPrefs?` 注入(默认取此处),
 * 解析成功后据此决定「自动选并跳过对话框」还是「进 awaiting_selection 等用户」(§4.4.2)。
 */
import type { VideoPrefs } from '../../shared/ipc'

export function getVideoPrefs(): VideoPrefs {
  return { defaultHeight: null, defaultAudioOnly: false }
}
