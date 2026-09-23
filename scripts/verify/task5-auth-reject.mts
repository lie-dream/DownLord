/**
 * v0.4 Task 5 Phase 2 真机取证靶站(手测辅助,归用户执行)—— **「拒绝时如实带状态码」的 ground truth**。
 *
 * 覆盖手测第 ④ 条:**需要登录的站点 → 转交后任务失败,错误里如实带 HTTP 状态码**
 * (cookie 不在 Task 5 传,这是已知边界)。
 *
 * **为什么自建靶站,不去找真实的「需要登录的站点」**(2026-08-11 真机反馈:找不到合适的;
 * 与本目录 README 及 `task4-referer-guard.mts` 同一哲学):
 * 真实站点失败时分不清是「cookie 没传」还是「站点改了规则 / 限了 IP / CDN 302 / UA 黑名单 /
 * 那条资源本来就下线了」—— 一次失败五种解释,等于没测。靶站把**服务端真正收到了什么、
 * 依据哪一条判的**原样打出来,失败只有一种解释。
 *
 * **怎么做到「浏览器能播、下载器下不了」**(这正是「需要登录」的最小可控模型):
 *   1. 打开首页时靶站下发 `Set-Cookie: dl_probe=1`;
 *   2. 页面里的 `fetch('/media/clip.mp4')` 由浏览器**自动带上**这个 cookie → 200,
 *      响应头带 `Content-Type: video/mp4` + `Content-Length`(**必须 > 1MB**,否则被嗅探的
 *      门槛当成播放器碎片滤掉,你会看到一个空列表而以为是嗅探坏了);
 *   3. 扩展据此把它采进桶 → 你在 popup 里点「下载」;
 *   4. aria2 **不带 cookie** 再来请求 → 靶站回 **401**,并在响应体里写清原因。
 *
 * ⚠️ 靶站把 cookie / UA 打在**控制台**上 —— 那是取证需要,与 spec §7.4「应用日志不得含
 *    referrer / UA 全串」**不冲突**:那条约束的是 DownLord 自己的日志,不是探针。
 *
 * ⚠️ **靶站刻意不发任何 CORS 响应头**:页面与媒体同源,用不着;发了反而会掩盖别的问题。
 *
 * 用法:
 *   npx tsx scripts/verify/task5-auth-reject.mts           # 起 127.0.0.1:18090
 *   npx tsx scripts/verify/task5-auth-reject.mts 19100     # 换端口
 *   SIZE_MB=4 npx tsx scripts/verify/task5-auth-reject.mts # 改靶文件大小(必须 > 1)
 *
 * 起来后:① DownLord 在跑且扩展已配对 ② 打开嗅探开关 ③ 浏览器开 http://127.0.0.1:18090/
 * ④ 按页面上的两个场景走。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

const PORT = Number(process.argv[2] ?? 18090)
/** 靶文件大小(MB)。**必须 > 1** —— 1MB 是嗅探对直链的门槛,小于它只会被计进「已隐藏 N 个」 */
const SIZE_MB = Number(process.env.SIZE_MB ?? 4)

const ORIGIN = `http://127.0.0.1:${PORT}`
const COOKIE_NAME = 'dl_probe'
/** 受保护的媒体:**浏览器带 cookie 拿得到,下载器不带 cookie 拿不到** */
const MEDIA_PATH = '/media/clip.mp4'
/** 对照组:同样是 mp4、同样进「媒体文件」组,但**不校验 cookie** —— 用来证明失败不是别的原因 */
const OPEN_PATH = '/media/open.mp4'
/**
 * 第三档:同样要 cookie,但拒绝时回 **403** 而不是 401。
 *
 * ★ **它存在的理由是 2026-08-11 裸跑取证的结果**:aria2 对两种拒绝给的东西**完全不同** ——
 *   - 401 → `errorCode=24` + `Authorization failed.`(**原文里没有数字**)
 *   - 403 → `errorCode=22` + `The response status is not successful. status=403`(**原文带数字**)
 *   而 `mapError.ts` 对已知码用固定中文、对未知码才拼原文,`24` 在表里、`22` 不在 ——
 *   于是 403 这一档的状态码**会一路露到任务行上**,401 那一档不会。
 *   两档并排跑,才分得清「DownLord 把状态码吞了」与「aria2 压根没给」。
 */
const FORBIDDEN_PATH = '/media/forbidden.mp4'

const TOTAL = Math.max(1, SIZE_MB) * 1024 * 1024
const BODY = Buffer.alloc(TOTAL, 0x42)

let seq = 0

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** UA 截到能认出是谁就够:`Edg/…` = 浏览器自己来的;`aria2/…` = DownLord 的下载器来的 */
function shortUa(ua: string | undefined): string {
  if (!ua) return '(无)'
  const m = /(Edg|Chrome|Firefox|aria2)\/[\d.]+/.exec(ua)
  return m ? m[0] : `${ua.slice(0, 48)}…`
}

function hasCookie(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? '').split(';').some((c) => c.trim() === `${COOKIE_NAME}=1`)
}

/** `bytes=START-END` → [start, end];解析不出 / 越界 → null(按整文件处理) */
function parseRange(header: string | undefined, total: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!m) return null
  const start = m[1] === '' ? 0 : Number(m[1])
  const end = m[2] === '' ? total - 1 : Number(m[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= total) return null
  return [start, end]
}

function log(line: string): void {
  seq += 1
  console.log(`[${stamp()}] #${String(seq).padStart(3, '0')} ${line}`)
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Task 5 · 拒绝探针</title>
<style>
 body{font:14px/1.7 system-ui,'Segoe UI',sans-serif;margin:32px auto;max-width:760px;color:#202020}
 h1{font-size:18px} h2{font-size:15px;margin-top:24px}
 code{background:#f3f3f3;padding:1px 5px;border-radius:3px}
 .ok{color:#0f7b0f} .bad{color:#a4262c} .box{border:1px solid #e0e0e0;border-radius:6px;padding:12px 16px;margin:12px 0}
 ol{padding-left:20px}
</style></head><body>
<h1>v0.4 Task 5 · 「拒绝时如实带状态码」靶站</h1>
<p id="probe">正在请求两个 mp4…</p>
<p><b>请先确认 DownLord 在跑、扩展已配对、嗅探开关已打开</b>,然后打开扩展 popup ——
「媒体文件」组里应当出现 <code>clip.mp4</code> 与 <code>open.mp4</code> 两条。
若一条都没有,多半是<b>嗅探开关刚打开</b>(本页的请求早已发生过)—— 用 popup 里的「强制刷新本页」再来一次。</p>

<div class="box">
<h2>场景 A(主角):<code>clip.mp4</code> —— 需要 cookie,拒绝时回 <b>401</b></h2>
<ol>
 <li>浏览器请求它时<b>自动带上了</b> <code>${COOKIE_NAME}=1</code>(本页打开时靶站下发的)→ <b>200</b>,于是被嗅探采到。</li>
 <li>在 popup 里点这一条的「下载」。</li>
 <li>aria2 <b>不带 cookie</b> 来请求 → 靶站回 <b class="bad">401</b>。</li>
 <li><b>期望</b>:DownLord 里这个任务失败,显示 <code>HTTP 认证失败</code>。</li>
</ol>
<p>⚠️ <b>这一档看不到「401」三个字是正常的,不是 DownLord 吞了状态码</b>(2026-08-11 裸跑 aria2 取证):
aria2 对 401 只给 <code>errorCode=24</code> + <code>Authorization failed.</code>,<b>原文里根本没有那个数字</b>。
「HTTP 认证失败」就是 code 24 的准确翻译。要分清「谁吞了」,跑下面的场景 C。</p>
</div>

<div class="box">
<h2>场景 C(对照):<code>forbidden.mp4</code> —— 同样要 cookie,但拒绝时回 <b>403</b></h2>
<p><b>期望</b>:任务失败,且错误里<b class="bad">如实出现 403</b>
(形如 <code>下载失败(引擎代码 22):The response status is not successful. status=403</code>)。</p>
<p>⚠️ <b>这一档是用来把 A 的成因钉死的</b>:同一条链路、同一个下载器,403 能把状态码露到任务行上、401 不能 ——
证明差别在 <b>aria2 给了什么</b>,不在 DownLord 藏了什么。</p>
</div>

<div class="box">
<h2>场景 B(对照):<code>open.mp4</code> —— 不校验 cookie</h2>
<p>同样是 mp4、同样进「媒体文件」组,但靶站对它<b>不做任何校验</b>。
点它的「下载」应当<b class="ok">正常下完</b>。</p>
<p>⚠️ <b>这一条是必须跑的</b>:少了它,场景 A 的失败有第二种解释(通道 / 转交 / aria2 本身出了问题),
一次失败两种解释等于没测。B 成功 + A 失败,才把原因钉死在「没带 cookie」上。</p>
</div>

<p>靶站控制台会把<b>每一次请求由谁发起、带没带 cookie、依据哪一条判的</b>原样打出来 —— 那是 ground truth,
不要从「下成功了 / 下失败了」倒推。</p>

<script>
// ★ 用 fetch 而不是 video 元素:video 会发 Range 请求,浏览器可能只要头几百 KB,
//   那样响应的 Content-Length 会**小于 1MB 门槛**,资源被计进「已隐藏 N 个」而不进列表 ——
//   你会看到一个空列表却以为是嗅探坏了。fetch 默认不发 Range → 恒定 200 + 完整 Content-Length。
Promise.all(
  ['${MEDIA_PATH}', '${FORBIDDEN_PATH}', '${OPEN_PATH}'].map((p) =>
    fetch(p).then((r) => p + ' → ' + r.status).catch(() => p + ' → 请求失败')
  )
).then((lines) => {
  document.getElementById('probe').textContent = '本页已请求:' + lines.join('   |   ')
})
</script>
</body></html>`

const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  const url = req.url ?? '/'
  const who = shortUa(req.headers['user-agent'])

  if (url === '/' || url === '/index.html') {
    // 下发 cookie:此后**浏览器**发出的同源请求都会自动带上它,而下载器不会
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=1; Path=/; SameSite=Lax`)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    log(`GET /            ← ${who}  下发 ${COOKIE_NAME}=1`)
    return
  }

  if (url === MEDIA_PATH || url === OPEN_PATH || url === FORBIDDEN_PATH) {
    const guarded = url !== OPEN_PATH
    const cookied = hasCookie(req)

    if (guarded && !cookied) {
      // ★ 这就是「需要登录」的最小模型。**两档拒绝码并排,是因为 aria2 对它们的处置完全不同**
      //   (2026-08-11 裸跑取证,见 FORBIDDEN_PATH 的注释):401 的原文不带数字,403 的带。
      const status = url === FORBIDDEN_PATH ? 403 : 401
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        // 不发 WWW-Authenticate:发了浏览器会弹原生登录框,而我们要模拟的是「cookie 登录态」,
        // 不是 HTTP Basic —— 弹框会把手测引到另一条路上去
        'Cache-Control': 'no-store'
      })
      res.end(`${status} 未登录:本资源要求 cookie ${COOKIE_NAME}=1\n`)
      log(`GET ${url}  ← ${who}  \x1b[31m${status} 拒绝\x1b[0m(无 cookie)`)
      return
    }

    const range = parseRange(req.headers.range, TOTAL)
    const [start, end] = range ?? [0, TOTAL - 1]
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${TOTAL}` } : {})
    })
    res.end(BODY.subarray(start, end + 1))
    log(
      `GET ${url}  ← ${who}  \x1b[32m${range ? 206 : 200}\x1b[0m` +
        `(cookie ${cookied ? '有' : '无'}${guarded ? '' : ' · 本路径不校验'})`
    )
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('404\n')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  v0.4 Task 5 · 拒绝探针靶站\n`)
  console.log(`  页面        ${ORIGIN}/`)
  console.log(`  A 受保护    ${ORIGIN}${MEDIA_PATH}       (无 cookie → 401)`)
  console.log(`  C 受保护    ${ORIGIN}${FORBIDDEN_PATH}  (无 cookie → 403)`)
  console.log(`  B 对照组    ${ORIGIN}${OPEN_PATH}        (不校验,应当下得成)`)
  console.log(`  靶文件      ${SIZE_MB} MB(嗅探对直链的门槛是 1MB,小于它会被滤掉)\n`)
  console.log(`  先确认:DownLord 在跑 · 扩展已配对 · 嗅探开关已打开,然后浏览器开上面那个页面。`)
  console.log(`  Ctrl+C 结束。\n`)
})
