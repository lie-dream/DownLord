const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`
  let v = n,
    i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${UNITS[i]}`
}
export function formatSpeed(n: number): string {
  return `${formatBytes(n)}/s`
}
export function formatPercent(done: number, total: number): string {
  if (!total || total <= 0) return '--'
  return `${Math.min(100, Math.floor((done / total) * 100))}%`
}
/** 秒数 → 时长串(mm:ss / h:mm:ss);null / 非法 / 负数 → '--' */
export function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
/** 毫秒时间戳 → 本地日期串(YYYY-MM-DD HH:mm);null / 非法 → '--';补零(仿 formatDuration) */
export function formatDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '--'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
