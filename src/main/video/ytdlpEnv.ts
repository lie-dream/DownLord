/**
 * yt-dlp 子进程环境(纯函数,真机 2026-07-09 编码 + 代理修复)。
 *
 * 一、代理净化(`stripProxyEnv`):代理注入全靠显式 `--proxy` 参数,剔除宿主 HTTP_PROXY 等
 * 环境变量,防 yt-dlp(Python requests)及其内部 spawn 的 aria2c(挂加速时)被环境代理劫持
 * (aria2 协议级代理 > all-proxy,详见 `../childEnv.ts`)。
 *
 * 二、stdio 编码:中文 Windows(locale cp936)下 Python stdio 默认 GBK,Node 按 UTF-8 解码
 * 会 mojibake。`PYTHONIOENCODING` / `PYTHONUTF8` 对官方 PyInstaller win_exe **无效**(bootloader
 * 忽略 PYTHON* 环境变量,实测确认),中文路径回传由 `after_move:%(filepath)j` 的 JSON ASCII
 * 转义兜死(见 ytdlpArgs);两个变量仍保留——用户热更新为非打包构建(pip / python -m)时生效。
 */
import { stripProxyEnv } from '../childEnv'

export function ytdlpSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...stripProxyEnv(base), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
}
