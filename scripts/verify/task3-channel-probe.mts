/**
 * v0.4 Task 3 · P1–P4 真机取证探针(spec §7.4 / plan Phase 1 §1.0)。
 *
 * 起一个绑 `127.0.0.1`、默认端口 52330 的**临时** HTTP 服务,把每个进来的请求的
 * **method / 完整请求头 / body 原文**原样打印,并一律回 `200 {"ok":true}`。
 *
 * ⚠️ **它是探针,不是产品服务**,故打印 Origin 与全部请求头是允许的 ——
 * **产品服务(Step 3 才写)永远不许打印这些**,那是 ARCHITECTURE §7.6 的日志红线(spec §3.5)。
 *
 * ⚠️ **有意不发任何 CORS 响应头**:闸②(浏览器强制的预检拒绝)全靠「响应里没有
 * `Access-Control-Allow-Origin`」生效 —— 探针一旦补上 CORS 头,P4 就会假阳性通过。
 *
 * 用法:
 *   node --import tsx scripts/verify/task3-channel-probe.mts            # 默认 127.0.0.1:52330
 *   node --import tsx scripts/verify/task3-channel-probe.mts --port 52331
 *   node --import tsx scripts/verify/task3-channel-probe.mts --port=52331
 * 停止:Ctrl+C。
 */
import { createServer } from 'node:http'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 52330

/** 解析 `--port N` / `--port=N`(开发机 52330 被占时换端口用) */
function parsePort(argv: string[]): number {
  const inline = argv.find((a) => a.startsWith('--port='))
  const raw = inline ? inline.slice('--port='.length) : argv[argv.indexOf('--port') + 1]
  if (!argv.some((a) => a === '--port' || a.startsWith('--port='))) return DEFAULT_PORT

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port 非法:${raw ?? '(缺参数)'}(应为 1–65535 的整数)`)
    process.exit(2)
  }
  return port
}

const port = parsePort(process.argv.slice(2))
let seq = 0

const server = createServer((req, res) => {
  const n = ++seq
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    console.log(`\n──────── 请求 #${n}  ${new Date().toISOString()} ────────`)
    console.log(`method : ${req.method}`)
    console.log(`url    : ${req.url}`)
    console.log(`from   : ${req.socket.remoteAddress}:${req.socket.remotePort}`)
    console.log(`origin : ${req.headers.origin ?? '(无 Origin 头)'}   ← P2 记这个值`)
    console.log('headers:')
    console.log(JSON.stringify(req.headers, null, 2))
    console.log(`body   : ${body.length > 0 ? body : '(空)'}`)

    // 一律 200 + {"ok":true};**不发 CORS 头**(见文件头说明)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用 —— 换一个:--port ${port + 1}(并同步改下面 fetch 里的端口)`)
  } else {
    console.error('探针启动失败:', err)
  }
  process.exit(1)
})

server.listen(port, HOST, () => {
  const url = `http://${HOST}:${port}/channel`
  console.log(`探针已就绪:${url}(仅绑 ${HOST},不发 CORS 头)`)
  console.log('停止:Ctrl+C\n')
  console.log('把下面这段粘进 devtools console —— P1/P2/P3 在扩展的 service worker console,')
  console.log(
    'P4 在任意普通网页(如 https://example.com)的 console(期望失败,且探针侧收不到 POST):\n'
  )
  console.log(
    `fetch('${url}',{method:'POST',headers:{'Content-Type':'application/json','X-DownLord-Token':'${'0'.repeat(64)}'},body:'{"type":"handshake","protocolVersion":1,"payload":{"extensionVersion":"probe"}}'}).then(r=>r.text()).then(t=>console.log('响应:',t)).catch(e=>console.log('失败:',e))`
  )
  console.log(
    '\n记录:P1 请求是否到达 / P2 origin 是什么 / P3 有没有先来一条 OPTIONS / P4 两侧都要看。'
  )
})
