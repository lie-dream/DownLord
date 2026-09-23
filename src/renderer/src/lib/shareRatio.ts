/**
 * 分享率纯函数(v0.3 Task 3 · spec §4.4):上传量 / 下载量。
 *
 * 分享率不进 IPC payload——由已有字段(uploadLength / downloadedBytes)在渲染层现算,减小帧。
 * `completedLength <= 0`(未知 / 尚未下完)→ 0,避免除零;做种时 completedLength = 总字节。
 */
export function computeShareRatio(uploadLength: number, completedLength: number): number {
  if (completedLength <= 0) return 0
  return uploadLength / completedLength
}
