/**
 * 文件名清洗与扩展名预测(纯函数,spec §7.7 / §8.1)。
 *
 * `sanitizeBasename` 是文件名清洗的**唯一权威实现**:TaskManager(http 路径)与视频路径共用此处,
 * 消除两处漂移(Phase 2 起 TaskManager 已删本地副本、改 import 此函数)。
 * `predictExt` 据格式选择预测落盘扩展名(最终以 yt-dlp `--print after_move:filepath` 校正)。
 */
import type { FormatChoice, ResolvedFormat } from '../../shared/ipc'

/**
 * Windows 非法文件名字符:`< > : " / \ | ? *` 与控制字符 U+0000–U+001F。
 * 控制范围用 String.fromCharCode 运行时拼,避免源码内联真实控制字符(被工具落成 NUL → git 误判二进制);
 * 与 TaskManager Task 3 既有清洗逻辑逐字符等价(http 文件名零回归)。
 */
const ILLEGAL_FILENAME_CHARS = new RegExp(
  '[<>:"/\\\\|?*' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + ']',
  'g'
)

/**
 * Windows 保留设备名(不分大小写),针对去最后扩展名后的 basename 整段匹配:
 * `CON PRN AUX NUL COM1-9 LPT1-9`——直接以此为文件名会被系统拒绝。
 * 命中加前缀 `_` 使其不再是设备名(如 `CON`→`_CON`、`COM1.txt`→`_COM1.txt`)。
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * 清洗标题为合法 basename(http 与视频路径**共用唯一权威**):
 * 1. 非法字符替换为 `_`,再 trim;
 * 2. 去尾部点/空格(Windows 静默剥离尾部点/空格 → 记录名≠真实落盘名 → 查重 stem 错位);
 * 3. 去扩展名后的 basename 命中保留设备名 → 加前缀 `_`;
 * 4. 清洗后为空 → 兜底名 `download`(避免空 basename)。
 *
 * 只在命中保留名/尾部点/空串时改写,正常标题(含中文、含合法点如 `1.2.3 教程`)逐字节不变。
 */
export function sanitizeBasename(title: string): string {
  let s = title.replace(ILLEGAL_FILENAME_CHARS, '_').trim()
  s = s.replace(/[. ]+$/, '') // 去尾部点/空格(Windows 会静默剥离)
  const stem = s.split('.')[0] ?? s // 保留名判定针对去扩展名后的 basename
  if (WINDOWS_RESERVED.test(stem)) s = '_' + s // CON→_CON、COM1.txt→_COM1.txt
  return s || 'download' // 全清空 → 兜底名(避免空 basename)
}

/**
 * 预测落盘扩展名:
 * - audioOnly → `mp3`(提取音轨转 MP3)
 * - 无具体 format(批量 heightCap)或纯视频(acodec==='none',需 +bestaudio 合并)→ `mp4`
 * - muxed(自带音轨,无需合并)→ 该 format 的原 ext
 */
export function predictExt(choice: FormatChoice, format?: ResolvedFormat): string {
  if (choice.audioOnly) {
    return 'mp3'
  }
  if (!format || format.acodec === 'none') {
    return 'mp4'
  }
  return format.ext
}
