/**
 * v0.4 Task 4 Phase 3 真机取证靶站(手测辅助,归用户执行)。
 *
 * 覆盖两件自动化测不出来的事:
 * - **P3-1**:`Referer` / `User-Agent` 是否从「浏览器 → 扩展 → 通道 → 主进程 → aria2 → 服务端」贯通。
 *   靶站把服务端**真正收到的**头原样打出来 —— 这是 ground truth,不是从「下成功了」倒推。
 * - **P3-2 / P3-3 / P3-4**:500ms 聚合窗口内的连点。**用按钮一次性触发,不靠手速**
 *   (2026-08-03 真机反馈:手点三次极难落进同一个 500ms 窗口,测的其实是手速不是聚合逻辑)。
 *
 * **为什么自建靶站,不去找真实防盗链站点**(与本目录 README 同一哲学:用本地 HTTP 服务器消除外网变量):
 * 真实站点失败时分不清是「referer 没传到」还是「站点改了规则 / 限了 IP / CDN 302 / UA 黑名单」——
 * 一次失败五种解释,等于没测;而拿一个**其实不校验 referer** 的站点当靶子,成功也什么都证明不了。
 *
 * ⚠️ 本脚本把完整 referer / UA 打在**控制台**上 —— 那是取证需要。它与 spec §7.4
 *    「应用日志不得含 referrer / UA 全串」(测试 I-10)**不冲突**:那条约束的是 DownLord 自己的日志。
 *
 * 用法:
 *   npx tsx scripts/verify/task4-referer-guard.mts          # 起 127.0.0.1:18080 与 18081(跨域伙伴)
 *   npx tsx scripts/verify/task4-referer-guard.mts 19000    # 换成 19000 / 19001
 *   SIZE_MB=200 RATE_KBPS=600 npx tsx scripts/verify/task4-referer-guard.mts   # 下得更久,便于中途重启
 *
 * 起来后浏览器打开 http://127.0.0.1:18080/ ,按页面上的场景逐个点。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash } from 'crypto'

const PORT = Number(process.argv[2] ?? 18080)
/** 跨域伙伴端口:**不同端口 = 不同 origin**,P3-4 靠它造跨域批次(不需要第二台机器 / 第二个域名) */
const PORT2 = PORT + 1
/** 主靶文件大小(MB)。默认 48MB;要中途重启就调大。连点用的小文件走 `?size=` 覆盖 */
const SIZE_MB = Number(process.env.SIZE_MB ?? 48)
/** 发送限速(KB/s)。0 = 不限。默认 1.5MB/s —— 48MB 约 32 秒,够你切到 DownLord 点重启 */
const RATE_KBPS = Number(process.env.RATE_KBPS ?? 1536)

const ORIGIN = `http://127.0.0.1:${PORT}`
const ORIGIN2 = `http://127.0.0.1:${PORT2}`
/** 两个 origin 都放行:跨域下载时浏览器发的是**发起页**的 origin,不是文件所在的那个 */
const ALLOWED = [`${ORIGIN}/`, `${ORIGIN2}/`]

/** 靶文件名一律 `.zip`:Step 0 实测 `.zip` / `.exe` / `.tar.gz` 在 `onCreated` 时刻 danger 均为 `safe`,
 *  不会被「danger !== 'safe' 就不接管」那道终裁挡下(换成生僻扩展名可能白跑一轮) */
const MAIN_FILE = '/file/demo.zip'

// ── 靶文件:确定性内容,便于下完后核对完整性 ────────────────────────────────
const TOTAL = SIZE_MB * 1024 * 1024
const BODY = Buffer.alloc(TOTAL)
{
  const pattern = Buffer.alloc(64 * 1024)
  for (let i = 0; i < pattern.length; i++) pattern[i] = i % 251
  for (let at = 0; at < TOTAL; at += pattern.length) pattern.copy(BODY, at)
}
const SHA256 = createHash('sha256').update(BODY).digest('hex')

let seq = 0

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** UA 截到能认出是谁就够。★ 判据就在这里:`Chrome/…` = UA 贯通了;`aria2/…` = 没贯通 */
function shortUa(ua: string | undefined): string {
  if (!ua) return '(无)'
  const m = /(Edg|Chrome|Firefox|aria2)\/[\d.]+/.exec(ua)
  return m ? m[0] : `${ua.slice(0, 40)}…`
}

/** `bytes=START-END` → [start, end];解析不出 / 越界 → null(按整文件处理) */
function parseRange(header: string | undefined, total: number): [number, number] | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const start = m[1] === '' ? 0 : Number(m[1])
  const end = m[2] === '' ? total - 1 : Number(m[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= total) return null
  return [start, end]
}

/** 按 RATE_KBPS 分块发送。限速的意义:留出中途重启 DownLord 的时间窗(P3-7) */
function sendThrottled(res: ServerResponse, slice: Buffer): void {
  if (RATE_KBPS <= 0) {
    res.end(slice)
    return
  }
  const chunk = Math.max(4096, Math.floor((RATE_KBPS * 1024) / 20)) // 每 50ms 一块
  let at = 0
  const pump = (): void => {
    if (res.writableEnded || res.destroyed) return // 客户端断开(aria2 探测连接常这样)→ 静默收工
    if (at >= slice.length) {
      res.end()
      return
    }
    res.write(slice.subarray(at, at + chunk))
    at += chunk
    setTimeout(pump, 50)
  }
  pump()
}

// ── 页面 ──────────────────────────────────────────────────────────────────

/** 连点脚本:一次性触发 N 个下载。**这是 P3-2/3/4 能不能测准的关键** —— 手点落不进同一个 500ms 窗口 */
const FIRE_JS = `
// 同源:<a download> —— 这就是真实用户点链接的路径
function fireSame(urls){
  urls.forEach(function(u){
    var a=document.createElement('a');
    a.href=u; a.download='';
    document.body.appendChild(a); a.click(); a.remove();
  });
}
// 跨域:**必须走 iframe**。<a download> 的 download 属性对跨域 URL 被浏览器**直接忽略**
// (规范如此,不是 bug),点下去变成导航;多个导航在同一 tick 里互相取消,结果只有一个下载真的发生
// —— 2026-08-03 真机就是这么只出来一条记录的。iframe + Content-Disposition: attachment
// 能触发下载且不导航,是唯一能程序化并发触发跨域附件下载的方式。
function fireCross(urls){
  urls.forEach(function(u){
    var f=document.createElement('iframe');
    f.style.display='none'; f.src=u;
    document.body.appendChild(f);
    setTimeout(function(){ f.remove(); }, 60000);  // 留久一点,别把正在下的连接掐了
  });
}
function batch(n){
  var ts=Date.now(), urls=[];
  for(var i=1;i<=n;i++) urls.push('/file/batch-'+ts+'-'+i+'.zip?size=2');
  fireSame(urls);
}
function cross(){
  var ts=Date.now();
  fireCross(['/file/cross-'+ts+'-a.zip?size=2', '${ORIGIN2}/file/cross-'+ts+'-b.zip?size=2']);
}`

function page(opts: { noRef: boolean }): string {
  const meta = opts.noRef ? '<meta name="referrer" content="no-referrer">' : ''
  const title = opts.noRef ? '靶站 · 无 Referer 页' : 'DownLord 防盗链靶站'
  const banner = opts.noRef
    ? `<p class="warn">本页带 <code>&lt;meta name="referrer" content="no-referrer"&gt;</code> ——
       从这里发起的下载<b>不带 Referer</b>,应当被靶站 403 拒绝。</p>`
    : `<p class="n">本页地址会成为下载的 <code>Referer</code>。靶站只放行 <code>Referer</code> 以
       <code>${ORIGIN}/</code> 或 <code>${ORIGIN2}/</code> 开头的请求,其余一律 <code>403</code>。
       每个请求真实收到的 Referer / UA 都打在控制台上。</p>`

  const scenarios = opts.noRef
    ? `<h2>A3 · 接管路径 + 无 Referer(应当失败)</h2>
       <p><a class="dl" href="${MAIN_FILE}?size=2" download>下载 demo.zip(本页不带 Referer)</a></p>
       <p class="n">照常被接管、照常弹小窗,但靶站会 403 → DownLord 任务失败。
       它排除掉「接管路径自己变出了一个 Referer」这种可能 —— 我们只是<b>如实转发浏览器给的那个</b>。</p>
       <p class="n"><a href="/">← 回正常页</a></p>`
    : `<h2>A1 · Referer 贯通(应当成功)</h2>
       <p><a class="dl" href="${MAIN_FILE}" download>下载 demo.zip(${SIZE_MB} MB,带 Referer)</a></p>
       <p class="n">★ 判据看控制台两行:<code>referer=${ORIGIN}/</code> 且 <code>ua=Chrome/…</code>。
       UA 若显示 <code>aria2/…</code>,说明 User-Agent 那一条没贯通(Referer 可能仍是对的)。</p>

       <h2>A3 · 接管路径 + 无 Referer(应当失败)</h2>
       <p><a class="dl" href="/noref">→ 去「无 Referer 页」</a></p>
       <p class="n">⚠️ <code>rel="noreferrer"</code> 对 <code>&lt;a download&gt;</code> <b>无效</b>
       (2026-08-03 实测:Chrome 仍带完整 Referer)。必须整页 <code>meta referrer</code> 才造得出无 Referer 的下载。</p>

       <h2>A2 · 对照:把这个地址贴进 DownLord 添加任务框(应当失败)</h2>
       <p><code>${ORIGIN}${MAIN_FILE}</code></p>
       <p class="n">★ 这条<b>必须跑</b>:它证明靶站真的在校验。少了它,A1 的成功也可能只是因为服务端根本不管
       (恒绿的假绿灯和真绿灯输出一模一样)。控制台应显示 <code>referer=(无)</code> + <code>ua=aria2/…</code>。</p>

       <hr>
       <h2>P3-2 · 一次触发 3 个同域下载(态 B 列表)</h2>
       <p><button onclick="batch(3)">一次触发 3 个(各 2 MB)</button></p>
       <p class="n">期望:<b>只弹一个</b>窗口,3 行列表 + 统一落点 + 「全部取消」。</p>

       <h2>P3-3 · 窗口还开着时,再触发 2 个(同窗换批次)</h2>
       <p><button onclick="batch(2)">再触发 2 个</button></p>
       <p class="n">★ 顺序要紧:<b>在上面那个 3 行窗口还开着的时候</b>点它 → 这 2 条进缓冲;
       然后回窗口点「开始下载」→ 窗口<b>不关</b>,直接换成 2 行,不闪烁、不重开、不再抢焦。<br>
       若先把 3 行处理完再点,窗口本就该关掉、这 2 条会<b>新开一个窗口</b> —— 那是正确行为,不是 bug。</p>

       <h2>P3-4 · 跨域批次</h2>
       <p><button onclick="cross()">一次触发 2 个(${PORT} + ${PORT2})</button></p>
       <p class="n">期望:仍是<b>一个</b>窗口、<b>两条</b>记录;不显示顶部单一域名行;每条前缀显示自己的 host。<br>
       ⚠️ 跨域这条走 <code>iframe</code> 而非 <code>&lt;a download&gt;</code> —— <b>download 属性对跨域 URL 被浏览器直接忽略</b>
       (规范如此),点下去变成导航,多个导航同 tick 互相取消,只会剩一个下载。<br>
       ★ 若仍只出来一条:<b>先看靶站控制台 <code>:${PORT2}</code> 有没有收到请求</b> —— 收到了才是产品侧问题,
       一条都没有说明浏览器压根没发起(仍是触发方式的问题,与接管逻辑无关)。</p>

       <h2>P3-5 · 查重(固定文件名,重复下载即命中)</h2>
       <p><a class="dl" href="/file/dup.zip?size=2" download>下载 dup.zip</a></p>
       <p class="n">连下两次:第二次应在<b>同一个小窗口</b>里换成查重框,四决策各点一次;主窗口不弹任何框。</p>

       <p class="n" style="margin-top:28px">⚠️ 连点按钮会让浏览器问「此网站尝试下载多个文件」——<b>要点允许</b>,否则只有第一个生效。</p>`

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">${meta}<title>${title}</title>
<style>
 body{font:14px/1.7 system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px}
 h1{font-size:20px} h2{font-size:15px;margin-top:26px}
 a.dl,button{display:inline-block;padding:8px 14px;border:1px solid #888;border-radius:6px;
   text-decoration:none;color:inherit;background:none;font:inherit;cursor:pointer}
 code{background:#eee;padding:1px 5px;border-radius:3px}
 .n{color:#666;font-size:13px} .warn{color:#a40;font-size:13px}
 hr{border:none;border-top:1px solid #ddd;margin:30px 0}
</style></head><body>
<h1>${title}</h1>
${banner}
${scenarios}
<script>${FIRE_JS}</script>
</body></html>`
}

// ── 服务 ──────────────────────────────────────────────────────────────────

function handle(port: number, req: IncomingMessage, res: ServerResponse): void {
  const raw = req.url ?? '/'
  const url = new URL(raw, `http://127.0.0.1:${port}`)
  const n = ++seq

  if (url.pathname === '/' || url.pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page({ noRef: false }))
    return
  }
  if (url.pathname === '/noref') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page({ noRef: true }))
    return
  }
  if (!url.pathname.startsWith('/file/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  const name = decodeURIComponent(url.pathname.slice('/file/'.length)) || 'demo.zip'
  const wantMb = Number(url.searchParams.get('size') ?? SIZE_MB)
  const size = Math.min(TOTAL, Math.max(1, Math.floor(wantMb * 1024 * 1024)))

  const referer = req.headers.referer
  const ua = req.headers['user-agent']
  const rangeHeader = req.headers.range
  const head =
    `[${stamp()}] #${n} :${port} ${req.method} /file/${name}\n` +
    `        range   = ${rangeHeader ?? '(无)'}\n` +
    `        referer = ${referer ?? '(无)'}\n` +
    `        ua      = ${shortUa(ua)}`

  // ★ 防盗链判定 —— 唯一判据,放在最前面
  if (!referer || !ALLOWED.some((p) => referer.startsWith(p))) {
    console.log(`${head}\n        → 403 REFUSE(无 Referer 或来源不符)\n`)
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('403 hotlink protected: bad or missing Referer')
    return
  }

  const range = parseRange(rangeHeader, size)
  const [start, end] = range ?? [0, size - 1]
  const length = end - start + 1

  // 「计划发送」而非「已发送」:aria2 会先开一条连接拿 Content-Length 再断开重开分片,
  // 那条的实际字节远小于这里的数(不是异常)
  console.log(
    `${head}\n        → ${range ? '206' : '200'} ALLOW(计划发送 ${(length / 1048576).toFixed(1)} MB)\n`
  )

  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${name}"`
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  sendThrottled(res, BODY.subarray(start, end + 1))
}

for (const p of [PORT, PORT2]) {
  const srv = createServer((req, res) => handle(p, req, res))
  // 端口占用是这个脚本最常见的失败(上一轮没关干净)。裸抛 EADDRINUSE 会打十几行栈,
  // 看起来像脚本坏了 —— 如实说清楚是哪个端口、怎么办。
  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✗ 端口 ${p} 已被占用 —— 多半是上一轮靶站还活着。`)
      console.error(`  处理:关掉那个终端,或换端口重跑,例如`)
      console.error(`      npx tsx scripts/verify/task4-referer-guard.mts ${PORT + 100}\n`)
    } else {
      console.error(`\n✗ 端口 ${p} 监听失败:${err.message}\n`)
    }
    process.exit(1)
  })
  srv.listen(p, '127.0.0.1')
}

console.log('─'.repeat(78))
console.log(`  DownLord Task 4 靶站已启动`)
console.log(`  页面      ${ORIGIN}/            ← 从这里开始`)
console.log(`  跨域伙伴  ${ORIGIN2}/           (P3-4 用,不必直接打开)`)
console.log(
  `  主文件    ${ORIGIN}${MAIN_FILE}  ${SIZE_MB} MB,限速 ${RATE_KBPS > 0 ? `${RATE_KBPS} KB/s` : '不限'}`
)
console.log(`  SHA256    ${SHA256}`)
console.log(`            (下完核对:certutil -hashfile "<落点>\\demo.zip" SHA256)`)
console.log('─'.repeat(78))
console.log('每个 /file 请求真实收到的 Referer / UA 都会打在下面。Ctrl+C 停止。\n')
