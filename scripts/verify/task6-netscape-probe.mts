/**
 * v0.4 Task 6 Phase 0 裸跑探针 —— **B1 / B2:yt-dlp 到底怎么解 Netscape cookies.txt**。
 *
 * 兑现项目教训「规划期假设要裸跑验证」:spec §5.2 的 ③(`#HttpOnly_` 前缀)与 ④(`expires=0`
 * 当 session cookie)两格,是**读 yt-dlp 源码逻辑推出来的**,不是实测。两条若错,失败形态是
 * **yt-dlp 静默不带 cookie** —— 而按 §7.1 日志红线,DownLord 的日志里既没有域名也没有 cookie 值
 * 可供排查。那将是本项目最难诊断的一类 bug,故编码前必须先把它钉死。
 *
 * **为什么自建靶站**(与 `task5-auth-reject.mts` 同一哲学):真实站点分不清「cookie 没送到」
 * 与「站点改规则 / 限 IP / UA 黑名单」。靶站把**服务端真正收到的 `Cookie:` 请求头原样打出来**,
 * 结果只有一种解释。
 *
 * **为什么必须三组并排跑**:只跑 B1 一组时,「靶站没收到」分不清是
 *   ① yt-dlp 不认 `#HttpOnly_` 前缀,还是
 *   ② 整条通路压根没打通(cookie 域匹配不上 / 参数没生效 / 靶站路径写错)。
 * A 组(普通行 + 远期 expires + 无前缀)是**对照**:A 收到 = 通路是通的,此时 B1 / B2 的成败
 * 才唯一归因到「前缀」与「expires=0」这两个变量上。**A 组不是可选项。**
 *
 * ⚠️ 靶站把 cookie 打在控制台上 —— 那是取证需要,与 §7.1「日志零 cookie 零域名」**不冲突**:
 *    那条约束的是 DownLord 自己的日志,不是探针。
 *
 * 用法:
 *   npx tsx scripts/verify/task6-netscape-probe.mts           # 起 127.0.0.1:18091,跑完自动退出
 *   npx tsx scripts/verify/task6-netscape-probe.mts 19101     # 换端口
 *
 * 退出码:三组全部符合期望 → 0;任一组不符 → 1(不符时按 spec §8.4 的预写退路改实现 + 改 spec)。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const PORT = Number(process.argv[2] ?? 18091)
const HOST = '127.0.0.1'
const ORIGIN = `http://${HOST}:${PORT}`

/** 内置 yt-dlp(dev 态落点,`resolveBinDir` 的 dev 分支)—— **不是 pip 版**,验的必须是我们分发的那个 */
const YTDLP = join(process.cwd(), 'resources', 'bin', 'yt-dlp.exe')

/** 远期 expires:now + 400 天(B2 失败时的退路值也是这个,故此处直接用它当对照) */
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 400 * 24 * 3600

interface Group {
  /** 组名(A / B1 / B2) */
  id: string
  /** 该组独占的靶站路径 —— 一组一路径,靶站据此归因,不靠时序猜 */
  path: string
  /** 该组独占的 cookie 名 —— 名字撞了就分不清是谁发的 */
  cookieName: string
  cookieValue: string
  /** 这组在验什么 */
  what: string
  /** cookies.txt 的数据行(不含首行魔术注释) */
  line: string
}

const GROUPS: Group[] = [
  {
    id: 'A',
    path: '/probe/a.mp4',
    cookieName: 'dlp_a',
    cookieValue: 'va_control',
    what: '对照组:普通行 + 远期 expires + 无前缀 → 期望收到(证明整条通路是通的)',
    line: `${HOST}\tFALSE\t/\tFALSE\t${FAR_FUTURE}\tdlp_a\tva_control`
  },
  {
    id: 'B1',
    path: '/probe/b1.mp4',
    cookieName: 'dlp_b1',
    cookieValue: 'vb1_httponly',
    what: '同 A 但整行前缀 #HttpOnly_ → 期望收到(证明 yt-dlp 剥前缀,spec §5.2③)',
    line: `#HttpOnly_${HOST}\tFALSE\t/\tFALSE\t${FAR_FUTURE}\tdlp_b1\tvb1_httponly`
  },
  {
    id: 'B2',
    path: '/probe/b2.mp4',
    cookieName: 'dlp_b2',
    cookieValue: 'vb2_session',
    what: '同 A 但 expires 写 0 → 期望收到(证明 yt-dlp 把 0 当 session cookie 而非已过期,spec §5.2④)',
    line: `${HOST}\tFALSE\t/\tFALSE\t0\tdlp_b2\tvb2_session`
  }
]

/** 靶文件:小即可(本探针与嗅探的 1MB 门槛无关,那是 Task 5 的事) */
const BODY = Buffer.alloc(64 * 1024, 0x42)

/** 每条路径上靶站实际收到的 `Cookie:` 请求头**原文**(按到达顺序,含 HEAD 与 GET 两次) */
const observed = new Map<string, string[]>()

function log(line: string): void {
  console.log(`  [靶站] ${line}`)
}

const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  const url = (req.url ?? '/').split('?')[0]
  const raw = req.headers.cookie ?? '(无 Cookie 请求头)'

  if (GROUPS.some((g) => g.path === url)) {
    const seen = observed.get(url) ?? []
    seen.push(`${req.method} → Cookie: ${raw}`)
    observed.set(url, seen)
    log(`${String(req.method).padEnd(4)} ${url}  Cookie: ${raw}`)

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(BODY.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(BODY)
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('404\n')
})

const workDir = mkdtempSync(join(tmpdir(), 'dl-task6-probe-'))

function runGroup(g: Group): Promise<{ cmd: string; exitCode: number | null; stderrTail: string }> {
  const cookieFile = join(workDir, `cookies-${g.id}.txt`)
  const text = `# Netscape HTTP Cookie File\n${g.line}\n`
  writeFileSync(cookieFile, text, { encoding: 'utf8' })

  const outFile = join(workDir, `out-${g.id}.mp4`)
  const args = [
    '--ignore-config', // 不吃用户 ~/.config 里的 yt-dlp 配置,否则结果不可复现
    '--no-cache-dir',
    // ★ 必须显式直连(2026-08-14 首跑踩到):本机开着 Clash,yt-dlp 会继承 shell 的
    //   HTTP(S)_PROXY,连 127.0.0.1 的靶站都被送去 127.0.0.1:7890 → 三组全部 20s 超时、
    //   靶站一次请求都没收到。**这正是 A 组对照的价值**:A 也没到 = 通路没通,而不是
    //   「前缀 / expires=0 不成立」。空串 = 直连(yt-dlp `--proxy ""` 的约定语义)。
    '--proxy',
    '',
    '--no-part',
    '--no-progress',
    '--cookies',
    cookieFile,
    '-o',
    outFile,
    `${ORIGIN}${g.path}`
  ]

  const cmd = `"${YTDLP}" ${args.map((a) => (a === '' || a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  console.log(`\n──── ${g.id} 组 ────`)
  console.log(`  验什么: ${g.what}`)
  console.log(`  cookies.txt 原文(两行):`)
  for (const l of text.split('\n')) if (l !== '') console.log(`    ${l.replace(/\t/g, '\\t')}`)
  console.log(`  命令: ${cmd}`)

  // 双保险:除 `--proxy ""` 外,把环境里的代理变量也摘掉(有的走 env、有的走参数)
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k]
  }

  // ★ 必须异步 spawn,**不能用 spawnSync**(2026-08-14 第二跑踩到):spawnSync 会把 Node 的
  //   事件循环整个堵住 → 同进程内的靶站收得到 TCP 连接却永远来不及应答,yt-dlp 报
  //   `Read timed out`、靶站一条日志都没有。表象与「代理劫持」几乎一样,但成因完全不同。
  return new Promise((resolve) => {
    const child = spawn(YTDLP, args, { windowsHide: true, env })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.resume()
    child.on('close', (code) => {
      const stderrTail = stderr.trim().split('\n').slice(-4).join('\n')
      console.log(`  yt-dlp 退出码: ${code}`)
      if (stderrTail) console.log(`  yt-dlp stderr(末 4 行): ${stderrTail}`)
      resolve({ cmd, exitCode: code, stderrTail })
    })
  })
}

server.listen(PORT, HOST, () => {
  void (async (): Promise<void> => {
    console.log(`\n  v0.4 Task 6 Phase 0 · Netscape cookies.txt 裸跑探针`)
    console.log(`  靶站      ${ORIGIN}`)
    console.log(`  yt-dlp    ${YTDLP}`)
    console.log(`  临时目录  ${workDir}`)
    console.log(`  远期 expires = ${FAR_FUTURE}(now + 400 天)\n`)

    for (const g of GROUPS) await runGroup(g)

    console.log(`\n════════ 逐字取证:靶站收到的 Cookie 请求头原文 ════════`)
    let allOk = true
    for (const g of GROUPS) {
      const seen = observed.get(g.path) ?? []
      const hit = seen.some((s) => s.includes(`${g.cookieName}=${g.cookieValue}`))
      if (!hit) allOk = false
      console.log(`\n  ${g.id} 组  路径 ${g.path}  期望收到 ${g.cookieName}=${g.cookieValue}`)
      if (seen.length === 0) {
        console.log(`    (靶站一次请求都没收到 —— yt-dlp 根本没打到这个路径上)`)
      } else {
        for (const s of seen) console.log(`    ${s}`)
      }
      console.log(`    判定: ${hit ? '✅ 收到' : '❌ 未收到'}`)
    }

    const b1 = (observed.get(GROUPS[1].path) ?? []).some((s) => s.includes('dlp_b1='))
    const b2 = (observed.get(GROUPS[2].path) ?? []).some((s) => s.includes('dlp_b2='))
    console.log(`\n════════ 结论 ════════`)
    console.log(`  A  通路对照      ${observed.has(GROUPS[0].path) ? '有请求到达' : '无请求到达'}`)
    console.log(`  B1 #HttpOnly_    ${b1 ? '成立 → 保留前缀' : '不成立 → 按退路:不加 #HttpOnly_ 前缀'}`)
    console.log(`  B2 expires=0     ${b2 ? '成立 → session 写 0' : '不成立 → 按退路:改写 now+400 天'}`)
    console.log('')

    server.close()
    rmSync(workDir, { recursive: true, force: true })
    process.exit(allOk ? 0 : 1)
  })()
})
