export function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}
export function parseUrlLines(text: string): { urls: string[]; invalidCount: number } {
  const seen = new Set<string>()
  const urls: string[] = []
  let invalidCount = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (isHttpUrl(line)) {
      if (!seen.has(line)) {
        seen.add(line)
        urls.push(line)
      }
    } else invalidCount++
  }
  return { urls, invalidCount }
}
