/**
 * 敏感信息扫描(v1.0 Task 1 Phase 3 · 2026-08-27)。
 *
 * **它防的是什么**:v1.0 是开源首发版,仓库要推上 GitHub。一次「把私钥 / 令牌 / 本机路径
 * 随手提交进去」的事故是不可撤销的 —— 推出去之后再删文件也没用,**一个泄露过的密钥,从历史里
 * 抹掉之后它依然是泄露的**。故必须在推之前有一道机器判据。
 *
 * **为什么自建,不上 gitleaks / trufflehog / secretlint**:
 * - ⓐ `scripts/audit-todo-assignments.mjs` 已给出现成同构形状(纯 `node:fs` + 正则 + 分类 +
 *   分段 `console.log` + 只有失败类 `process.exit(1)`;零外部依赖、零 CLI 参数、零配置文件);
 * - ⓑ **规则集必须项目特定** —— 通用规则库是为「任意仓库」写的。本项目规划期实测:一条媒体
 *   扩展名 grep 因 `ts` 撞 TypeScript 捞出 **280 个源码文件**,真报被误报彻底淹没。同理,本项目
 *   源码里 `token` 这个词高频出现(本地通道全链路),按**变量名**匹配必然淹没 —— 故规则 4 判的是
 *   **赋值为字面量**,不是变量名;
 * - ⓒ 不扩大 `npm audit` 的审计面(多一个 dev 依赖就要多分一次「产物面 / 构建期面」档;
 *   Go / Python 二进制在 CI 上还要额外步骤)。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 **防自噬两条(不做就必然踩)**
 *
 * 这个扫描器**会命中它自己** —— 脚本源码里必然写着那些 pattern,而扫描范围包含工作区。
 * 这与「记措辞红线的文档对自己的 pattern 天然不可能零命中」是**同一个坑换了载体**。故:
 *
 * - **ⓐ 规则 pattern 不以字面量形式出现在本文件里** —— 一律经 `cc()` / `hx()` 由
 *   `String.fromCharCode` 构造。**排除清单**(保留域名之类)是**反向**条件、不可能自触发,
 *   故保留可读字面量 —— 那里的可读性对复核更值钱。
 * - **ⓑ 反向探针的假密钥 fixture 只在运行时临时生成、跑完即删、永不入库。**
 *
 * **这比「把自己加进排除名单」更干净,因为排除名单是个会被遗忘的口子。**
 * ⚠️ 写控制字符 / 特殊字节进本文件时同样用 `String.fromCharCode`,🚫 不要落成真实字节 ——
 *    git 会把文件判成二进制。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * **退出码语义(发布闸语义,现在就钉死)**
 *
 * | 情况 | 退出码 |
 * |---|---|
 * | 零未定性命中 | **0** |
 * | 有未定性命中 | **非 0** |
 * | 登记表有失效条目 | **非 0** |
 *
 * 🚫 不许「打印警告后照样退 0」—— 将来发布前推送断言直接用它卡发布。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * **两档输出,处置相反(规则级假阳 / 实例级假阳)**
 *
 * 判据 = **同类的东西以后还会不会源源不断地再出现**。
 * - **规则级假阳**(规则写错 / 过宽,每个新 `.ts` 文件都会再命中一次)→ **收窄规则、不留条目**,
 *   但收窄理由必须写进本文件注释(见下方各规则的「收窄」段)与报告,否则后人既不知道它为什么窄,
 *   也可能顺手放宽回去;
 * - **实例级假阳**(规则正确,只是这一条确实不是秘密)→ **不动规则**,进下方 `ADJUDICATED`
 *   登记表逐条定性。
 *
 * 🔴 **`ADJUDICATED` 不是排除名单** —— 三条性质保证它不会变成被遗忘的口子:
 * ① 每条**每次运行都完整打印**(定性 + 理由),不是静默吞掉;
 * ② 条目**按内容哈希锚定**(不存原文 —— 存原文就等于把假阳原样抄进本文件,又一次自噬);
 * ③ **失效条目(本次零命中)= 失败** —— 登记表自己会腐烂,腐烂就报错。
 * ⚠️ ③ 的边界:扫描面含 git 历史,而历史不可变,故**已提交过的条目几乎不会失效**;
 *    它真正防的是「为某个未提交内容登记后又把内容删了」。如实写在这里,不夸大。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * **已知盲点(如实记,不假装扫得到)**
 *
 * 规则 8 判的是**路径字面量**。本仓库有一处真实用户名以**非路径形态**存在 ——
 * `src/main/binaries/locator.test.ts` 用 `join('C:', 'Users', <真实用户名>, …)` 拼路径,
 * 逐段是独立字符串,**本规则扫不到**。它由人工核实发现,已入命中清单。
 * 🚫 不要因为「扫描器绿了」就以为这一类不存在。
 *
 * 用法:npm run scan:secrets
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { isIP } from 'node:net'

const ROOT = process.cwd()

// ── pattern 构造器(防自噬 ⓐ)──────────────────────────────────────────────
/** 码点 → 字符串。规则 pattern 一律经它构造,🚫 不许写成字面量。 */
const cc = (...codes) => String.fromCharCode(...codes)
/** 十六进制码点串 → 字符串(长 pattern 用它,短的直接 `cc`)。同样走 `String.fromCharCode`。 */
const hx = (hex) => cc(...hex.match(/../g).map((h) => parseInt(h, 16)))

// ── 扫描面的边界 ──────────────────────────────────────────────────────────
/** 目录级跳过:非源码、体积大、且都不入库。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'coverage', '.vscode'])
/** 二进制 / 生成物扩展名:内容规则对它们无意义,读进来只会拖慢并产生乱码命中。 */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|svgz|exe|dll|zip|7z|gz|tgz|rar|pdf|woff2?|ttf|otf|eot|db|sqlite|asar|node|wasm|mp4|mkv|webm|mp3|m4a|torrent)$/i
/** 单文件上限 2 MiB:大小守卫保持不变；跳过只表示未覆盖，须另行补检/待验。 */
const MAX_BYTES = 2 * 1024 * 1024

// ── 规则表 ────────────────────────────────────────────────────────────────
// face:'content' = 文件内容(工作区 + git 历史) · 'path' = 文件存在性(工作区文件系统 + 历史路径全集)

/** 私钥 / 证书 PEM 块头。五连字符 + 起始关键字 + 种类 + 五连字符。 */
const PEM_LEAD = hx('2d2d2d2d2d424547494e20') //  五个 '-' + 起始关键字 + 空格
const PEM_PRIV = hx('50524956415445204b4559') //  「私钥」种类词
const PEM_CERT = hx('4345525449464943415445') //  「证书」种类词
const PEM_TAIL = hx('2d2d2d2d2d')

/** 规则 4 的关键字表(判**赋值为字面量**,不判变量名)。 */
const K_RPC = hx('727063') //  RPC 前缀
const K_SECRET = hx('736563726574')
const K_TOKEN = hx('746f6b656e')
const K_PASSWORD = hx('70617373776f7264')
const K_PASSWD = hx('706173737764')
const K_API = hx('617069')
const K_KEY = hx('6b6579')

/** 规则 6 的云厂商前缀(假阳率近零的那几个)。 */
const P_AWS = hx('414b4941') //  AWS 访问密钥 ID 的四字母前缀
const P_GH = hx('6768') //  GitHub 个人 / OAuth 令牌的两字母前缀
const P_GH_PAT = hx('6769746875625f7061745f') //  GitHub 细粒度令牌前缀
const P_OPENAI = hx('736b2d') //  OpenAI 风格密钥前缀

/** 规则 8 的路径形态。 */
const RE_BS = '\\\\' //  正则里的一个字面反斜杠
const W_USERS = hx('5573657273') //  Windows 用户目录名
const POSIX_HOME = hx('2f686f6d652f') //  POSIX 家目录前缀

/** 规则 9 的私网段(RFC 1918)。数字逐段构造,避免本文件里出现完整 IP 形态。 */
const N10 = hx('3130')
const N172 = hx('313732')
const N192 = hx('313932')
const N168 = hx('313638')

/**
 * RFC 2606 / RFC 6761 保留给文档与测试的域名。
 *
 * **收窄①(规则 7 · 真实邮箱)**:规则叫「**真实**邮箱」,而这些域由 RFC 保留给文档使用,
 * **按定义不可能是真实邮箱**。不收窄的话,每写一份带示例邮箱的文档、每加一个用示例域的测试夹具
 * 都会再命中一次 —— 属**规则级**(同类会源源不断再生),故收窄规则、不留清单条目。
 * 实测:收窄前 35 命中 → 收窄后 12 命中;双向对照见交付说明。
 */
const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.edu']
const RESERVED_EMAIL_TLDS = ['.example', '.invalid', '.test', '.localhost']

/**
 * **收窄②(规则 9 · 私网 IP)**:回环段 `127.0.0.0/8` 不在 RFC 1918 私网段内,且它是本项目
 * **本地通道的产品常量**(扩展 ↔ DownLord 的 HTTP 通路只绑回环),全链路源码 / 文档 / 测试里
 * 成百上千次出现。把它算进「私网 IP 泄露」既不符合规则语义,又会一条规则淹掉整份报告 ——
 * 属**规则级**。故规则 9 只判 RFC 1918 三段,回环与链路本地(169.254/16)不在其中。
 * 实测:把回环段加回去 → **2005 命中**(收窄后 55);双向对照见交付说明。
 */

/**
 * **收窄③(规则 8 · 本机绝对路径)**:规则叫「**本机**绝对路径」,判据是它**指向某台真机的
 * 某个真人**。用户名段是占位形态的(尖括号包裹 / 占位词 / 根本不是合法用户名字符 / 单字符),
 * **按定义不是本机路径**:`/home/u/Torrents` 是合成夹具、`C:{反斜杠}Users{反斜杠}<user>` 是文档占位、
 * 而 spec 与 prompt 里**记录本规则本身**的那句说明也会命中自己(与「记措辞红线的文档对自己的
 * pattern 天然不可能零命中」同型)。同类会随每个新测试 / 新文档源源不断再生 ⇒ **规则级**。
 *
 * 🔴 **这条收窄刻意做得很窄,因为它必须放过真命中**:本仓库确有一处真实 Windows 用户名以
 * `C:{反斜杠}Users{反斜杠}<真名>` 形态存在于 `docs/v0.1/superpowers/reviews/`。若图省事把整个
 * `docs/` 或整个测试面从规则 8 排除掉,**那条真命中会被一起埋掉** —— 「假阳有时钉死的是一个
 * 真实事实」,收窄前必须先看一眼它为什么命中。
 * 实测:收窄前 87 命中 → 收窄后 14 命中(全部为那一处真实用户名及其历史副本);双向对照见交付说明。
 */
const PLACEHOLDER_USERS = new Set([
  'user',
  'users',
  'username',
  'u',
  'me',
  'you',
  'youruser',
  'your-user',
  'someone',
  'runner',
  'runneradmin',
  'administrator'
])
/** 取路径里的用户名段,判断它是不是占位形态。 */
function isPlaceholderUserPath(hit) {
  const seg = hit.slice(hit.lastIndexOf(cc(92)) + 1, hit.length).replace(/\/+$/, '')
  const name = hit.includes(cc(47)) ? hit.split('/').filter(Boolean).pop() : seg
  if (!name) return true
  if (name.startsWith('<')) return true
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return true // markdown 标点残留之类,不可能是用户名
  if (name.length < 2) return true
  return PLACEHOLDER_USERS.has(name.toLowerCase())
}

/**
 * **收窄④(规则 4 · 凭据关键字赋值为字面量)**:本项目的**本地通道全链路**与 aria2 RPC 测试
 * 必须声明合成的 `TOKEN` / `secret` 常量,**每加一个通道测试就再命中一次** ⇒ **规则级**。
 * 故规则 4 不扫测试文件与测试 helper。
 *
 * 🔴 **收窄前逐条看过「它为什么命中」**(护栏:假阳有时钉死的是一个真实事实):11 组原文全部是
 * `'0123456789abcdef'.repeat(4)` / `'test-secret'` / `'rpc-secret'` / `'should-never-arrive'`
 * 这类构造式合成值,**无一条是真凭据**;且**非测试面命中数实测为 0** ⇒ 收窄不埋任何真命中。
 * **代价如实记**:测试文件里粘进真凭据将扫不到;缓解是 R1(私钥块)与 R6(云厂商前缀)
 * **仍扫测试文件** —— 真凭据最常见的两种形态仍在网内。
 * 实测:收窄前 120 命中 → 收窄后 0 命中;双向对照见交付说明。
 */
const TEST_FACE = /(\.test\.tsx?$|^tests\/helpers\/)/

// ── R10 / R11 / R12:本机身份与公网地址 ──────────────────────────────────────
/**
 * 🔴 **这三条是补上一个被实测证明存在的盲点,不是锦上添花。**
 *
 * 规则 8 判的是**路径字面量**,而本仓库的真实身份信息偏偏是**分段拼接**形态:
 * `join('C:', 'Users', <真名>, …)` 与 `join('D:', <目录>, …, 'DownLord')` —— 逐段是独立字符串,
 * 路径正则一个都看不见。同理规则 9 只判 RFC 1918 私网 IPv4,而仓库里躺着一个**真实公网 IPv6**。
 * 这三处全在 `src/**` 里,而 `src/`(含全部测试)是**保留上线**的 ⇒ **它们会被推上公网**。
 * 三处都是人工交叉核实查出来的;查出来之后就必须变成机器判据,否则下一次还是靠人记得住。
 *
 * ⚠️ **R10 / R11 是「机器相关判据」,如实标注**:它们扫的是**当前这台机器**的用户名与仓库根路径。
 * 在 CI 上跑,扫的就是 CI 的用户名与路径 ⇒ **CI 绿不等于开发机绿**,它**不能替代**开发机上跑一次。
 * 这是这类规则的固有性质,不是缺陷 —— 「我这台机器的身份有没有漏进仓库」本来就是相对本机的问题。
 *
 * ⚠️ **R11 的分段判据要求「连续 ≥3 段」**:单看项目名那一段是满仓都有的;连续三段(仓库根路径里
 * 相邻的三个目录名)才足以指认某台具体机器上的具体位置。
 * 🚫 **本段刻意不举字面例子** —— 举了就等于把 pattern 写进本文件,扫描器当场命中自己(实测踩过一次)。
 *
 * ⚠️ **R10–R12 只扫发布树面**(收窄⑥,见下方 `STRIPPED`):它们问的问题是「这台机器的身份 / 真实
 * 网络地址会不会被**推上公网**」。剥离清单里的东西按构造不进发布树,而发布树走 orphan 分支、
 * 本地 git 历史永不推送 ⇒ 那些位置的命中在语义上就不属于这三条规则,且本项目纪律要求 spec /
 * review / prompt **逐字记录实测取证**(`ipconfig` 输出、引擎自检日志、仓库根路径),故它们会
 * **持续再生** —— 规则级。
 */
const MACHINE_USER = userInfo().username ?? ''
const REPO_SEGS = ROOT.split(sep).filter(Boolean)
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => cc(92) + c)

/** 用户名太短或本身就是占位词时,这条规则会淹掉报告 —— 那种机器上直接停用并在报告里说明。 */
const USER_RULE_ON = MACHINE_USER.length >= 3 && !PLACEHOLDER_USERS.has(MACHINE_USER.toLowerCase())

/** 仓库根不足 3 段时无法构造「连续三段」判据 —— 同样停用并说明,🚫 不许退化成空分支(会恒匹配空串)。 */
const REPO_RULE_ON = REPO_SEGS.length >= 3
function repoPattern() {
  const q = cc(91, 34, 39, 93) // ["']
  const parts = []
  for (let i = 0; i + 2 < REPO_SEGS.length; i++) {
    const [a, b, c] = REPO_SEGS.slice(i, i + 3).map(reEsc)
    parts.push(`${q}${a}${q}\\s*,\\s*${q}${b}${q}\\s*,\\s*${q}${c}${q}`)
  }
  parts.push(REPO_SEGS.map(reEsc).join(`[${RE_BS}/]`)) // 完整路径字面量(两种分隔符都认)
  return new RegExp(`(?:${parts.join('|')})`, 'g')
}

/** RFC 3849 保留给文档的 IPv6 前缀 —— 与 R7 的保留域同理,按定义不是真实地址。 */
const DOC_V6_PREFIX = /^2001:0?db8/i

/**
 * **收窄⑤(规则 12 · 公网 IPv6)**:要求**至少 4 个非空 hextet 组**。
 * 少于 4 组的写法不是「能指认一条线路的地址」,而是**前缀记法或压根不是 IPv6**:
 * 实测噪音三类 —— ① 产品代码里的协议常量注释(全球单播段 / Teredo 段 / 6to4 段,均 1–2 组)
 * ② 压缩写法的段前缀(2 组)③ **时间串 `23:59:59`**(3 组,`historyView.ts` 的注释)。
 * 三类都会随每份新代码 / 新注释再生 ⇒ **规则级**。
 * 🔴 收窄前逐条看过:真实公网地址(8 组)与它的 /64 前缀写法(5 组)**都在 4 组以上,不受影响**。
 * 实测:收窄前 225 命中 → 收窄后见报告;双向对照见交付说明。
 */
const V6_MIN_GROUPS = 4
const v6TooShort = (m) =>
  m.split(':').filter((group) => /^[0-9a-f]{1,4}$/i.test(group)).length < V6_MIN_GROUPS

/**
 * **收窄⑥(规则 10 / 11 / 12 · 只扫发布树面)** —— 剥离面来自**唯一发布规则**,不再在本文件抄一份清单。
 * 🔴 I-03:一份规则同时控制构树的剥离 / 保留与扫描的发布面;旧的 `^docs/v\d` 比规则宽(会把 docs/v2.0 也当剥离面),
 *    与规则校准后由规则的 stripPaths 逐条派生。规则缺失或形态非法 = **执行错误**(退出 1),不是「按全树扫」
 *    也不是「零命中」—— 发布面无法确定时 R10–R12 的语义就不成立,静默任选一边都是假结论。
 * ⚠️ 候选适配器(scripts/release/checks.mjs)按冻结 blob 整块替换下方的剥离表常量(从声明行到独占一行的
 *    右方括号),故该块的多行形态是它的接口,🚫 不要压成一行;🚫 也不要在注释里写出那一行声明的原文 ——
 *    适配器的正则会先命中注释、把中间的定义一并吞掉(2026-09-20 实测:候选扫描直接变成执行错误)。
 */
const POLICY_PATH = 'scripts/release-policy.json'
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
const HEX12 = /^[0-9a-f]{12}$/
/** 仓库相对 POSIX 字面量:不含盘符 / 反斜杠 / 通配 / 空段 / `.` `..` 段,不以 `/` 开头。 */
const isRepoRelativeLiteral = (p) =>
  typeof p === 'string' &&
  p.length > 0 &&
  !p.startsWith('/') &&
  !/^[A-Za-z]:/.test(p) &&
  !p.includes(cc(92)) &&
  !/[*?[\]]/.test(p) &&
  p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
function loadReleasePolicy() {
  let buf
  try {
    buf = readFileSync(join(ROOT, ...POLICY_PATH.split('/')))
  } catch (error) {
    return { policy: null, sha256: null, error: 'POLICY_UNAVAILABLE', code: error.code ?? null }
  }
  let policy
  try {
    policy = JSON.parse(buf.toString('utf8'))
  } catch {
    return { policy: null, sha256: null, error: 'POLICY_INVALID' }
  }
  const pathRule = (r) =>
    r !== null &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    (r.kind === 'directory' || r.kind === 'file') &&
    typeof r.path === 'string' &&
    isRepoRelativeLiteral(r.kind === 'directory' ? r.path.replace(/\/$/, '') : r.path) &&
    (r.kind !== 'directory' || r.path.endsWith('/'))
  const valid =
    policy !== null &&
    typeof policy === 'object' &&
    policy.schemaVersion === 1 &&
    Array.isArray(policy.stripPaths) &&
    policy.stripPaths.length > 0 &&
    policy.stripPaths.every(pathRule) &&
    Array.isArray(policy.forbiddenCandidatePaths) &&
    policy.forbiddenCandidatePaths.every(pathRule)
  if (!valid) return { policy: null, sha256: null, error: 'POLICY_INVALID' }
  return { policy, sha256: createHash('sha256').update(buf).digest('hex'), error: null }
}
const policyState = loadReleasePolicy()
const pathRuleCovers = (rule, file) =>
  rule.kind === 'directory' ? file.startsWith(rule.path) : file === rule.path
const pathRuleRegExp = (rule) =>
  rule.kind === 'directory'
    ? new RegExp(`^${reEsc(rule.path)}`)
    : new RegExp(`^${reEsc(rule.path)}$`)
function releaseFaceStripRules() {
  return policyState.policy ? policyState.policy.stripPaths.map(pathRuleRegExp) : []
}
const STRIPPED = [
  // 由唯一发布规则的 stripPaths 派生(见上);候选适配器会整块替换本表
  ...releaseFaceStripRules()
]
const inReleaseTree = (f) => !STRIPPED.some((r) => r.test(f))

const RULES = [
  {
    id: 'R1',
    name: '私钥 / 证书 PEM 块',
    face: 'content',
    re: new RegExp(`${PEM_LEAD}[A-Z0-9 ]{0,24}(?:${PEM_PRIV}|${PEM_CERT})${PEM_TAIL}`, 'g')
  },
  {
    id: 'R2',
    name: '密钥 / 证书文件存在性',
    face: 'path',
    re: /\.(pfx|p12|key|pem)$/i
  },
  {
    id: 'R3',
    name: '扩展 manifest 的 key 字段 / 独立 key 文件',
    face: 'content',
    only: /(^|[/\\])manifest\.json$/i,
    re: new RegExp(`${cc(34)}${K_KEY}${cc(34)}\\s*:\\s*${cc(34)}[A-Za-z0-9+/=]{40,}${cc(34)}`, 'g')
  },
  {
    id: 'R4',
    name: '凭据关键字赋值为字面量',
    face: 'content',
    // 命中 `const token = 'a1b2…'`;不命中 `const token = process.env.X`(值不带引号)、
    // 也不命中 `token: string`(值不是字符串字面量)。这是本规则与通用规则库的关键差别。
    //
    // ⚠️ **关键字与 `[:=]` 之间的可选引号必须是字符类 `["']?`,不是两字符串 `"'?`**
    //    (2026-08-27 反向探针实测抓到):写成后者时它要求关键字后**紧跟一个双引号**,于是
    //    JSON 形态 `"token": "…"` 照常命中、而 JS 赋值形态 `const token = '…'` **永不命中** ——
    //    工作区扫描给出的那个 0 是**半死规则**的 0,不是「真的没有」。只跑干净态那一边看不出来。
    re: new RegExp(
      `(?<![A-Za-z0-9_])(?:${K_RPC}[-_]?${K_SECRET}|${K_API}[-_]?${K_KEY}|${K_SECRET}|${K_TOKEN}|${K_PASSWORD}|${K_PASSWD})(?![A-Za-z0-9_])\\s*${cc(91, 34, 39, 93)}?\\s*[:=]\\s*(${cc(91, 34, 39, 93)})([^${cc(34, 39)}\\n\\\\$]{8,})\\1`,
      'gi'
    ),
    skipFace: TEST_FACE,
    // 值形如占位符的一律不是秘密(规则级:模板 / 示例文档会源源不断再生)。
    ignoreValue: /^(<|\{\{|\$\{|xxx|your|change ?me|placeholder|todo|例如|示例)/i
  },
  {
    id: 'R5',
    name: '.env 本体',
    face: 'path',
    re: /(^|[/\\])\.env(\.|$)/i
  },
  {
    id: 'R6',
    name: '云厂商凭据前缀',
    face: 'content',
    re: new RegExp(
      `(?:${P_AWS}[0-9A-Z]{16}|${P_GH}[pousr]_[A-Za-z0-9]{36,}|${P_GH_PAT}[A-Za-z0-9_]{50,}|${P_OPENAI}[A-Za-z0-9]{20,})`,
      'g'
    )
  },
  {
    id: 'R7',
    name: '真实邮箱',
    face: 'content',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ignoreMatch: (m) => {
      const domain = m.slice(m.indexOf('@') + 1).toLowerCase()
      return (
        RESERVED_EMAIL_DOMAINS.includes(domain) ||
        RESERVED_EMAIL_TLDS.some((t) => domain.endsWith(t))
      )
    }
  },
  {
    id: 'R8',
    name: '本机绝对路径',
    face: 'content',
    re: new RegExp(
      `(?:[A-Za-z]:${RE_BS}${W_USERS}${RE_BS}[^${RE_BS}/:*?${cc(34)}<>|\\s]{1,64}|${POSIX_HOME}[A-Za-z0-9._-]{1,32}/)`,
      'g'
    ),
    ignoreMatch: isPlaceholderUserPath
  },
  {
    id: 'R9',
    name: '私网 IP(RFC 1918)',
    face: 'content',
    re: new RegExp(
      `(?<![0-9.])(?:${N10}\\.\\d{1,3}|${N192}\\.${N168}|${N172}\\.(?:1[6-9]|2\\d|3[01]))\\.\\d{1,3}\\.\\d{1,3}(?![0-9.])`,
      'g'
    )
  },
  {
    id: 'R10',
    name: '本机用户名(机器相关)',
    face: 'content',
    releaseOnly: true,
    off: !USER_RULE_ON,
    offWhy: `本机用户名 ${MACHINE_USER.length < 3 ? '短于 3 字符' : '本身是占位词'},启用会淹掉报告`,
    re: USER_RULE_ON
      ? new RegExp(`(?<![A-Za-z0-9_])${reEsc(MACHINE_USER)}(?![A-Za-z0-9_])`, 'g')
      : /$^/
  },
  {
    id: 'R11',
    name: '本机仓库根路径(机器相关 · 含分段拼接)',
    face: 'content',
    releaseOnly: true,
    off: !REPO_RULE_ON,
    offWhy: '仓库根不足 3 段,无法构造「连续三段」判据',
    re: REPO_RULE_ON ? repoPattern() : /$^/
  },
  {
    id: 'R12',
    name: '公网 IPv6 地址(全球单播段)',
    face: 'content',
    releaseOnly: true,
    // 与 R9 是一对:那条管「内网地址漏出去」,这条管「本机的公网地址漏出去」——
    // 一个全球单播 IPv6 能指认某条具体的宽带线路,比内网地址更敏感。
    re: /(?<![0-9A-Fa-f:])[23][0-9A-Fa-f]{0,3}:(?:[0-9A-Fa-f]{0,4}:){1,6}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})(?![0-9A-Fa-f:]|\.\d)/g,
    // Step3.5:候选须完整提取 IPv4 尾段，不能把尾段前半截当 hextet；尾段不计入≥4个hextet。
    // 冒号/十六进制片段还可能是滤镜参数，仍须验证完整IPv6语法。
    // 原三条过渡地址均为合法IPv6，精确登记不变；首2/3、文档前缀和≥4组约束继续有效。
    ignoreMatch: (m) => DOC_V6_PREFIX.test(m) || v6TooShort(m) || isIP(m) !== 6
  }
]

/**
 * 已定性条目登记表(**不是排除名单**,见文件头的三条性质)。
 *
 * 每条:`rule` 规则号 · `file` 仓库相对路径 · `sha` 命中原文的 sha256 前 12 位
 * (🚫 不存原文 —— 存原文就是把假阳原样抄进本文件,又一次自噬)· `desc` 中文描述
 * · `verdict` 定性 · `why` 理由。
 */
const ADJUDICATED = [
  // ── R8:开发机 Windows 用户名(v0.1 真机验收日志逐字抄录进 review)────────────
  // §6.0 的三条件:ⓐ「当前有效的**凭据**」**不成立** —— 用户名不是凭据,没有可撤销 / 轮换的东西,
  // 而「当场处置」处置的是**凭据的有效性,不是文件的存在性**(删文件改历史都不算处置)。
  // ⇒ 三条件缺一,不走当场处置,进命中清单交 Task 2。
  // 影响面:`docs/v0.*/` 整体在剥离清单内 ⇒ 不进发布树;发布走 orphan 分支,本地历史永不推送。
  {
    rule: 'R8',
    file: 'docs/v0.1/superpowers/reviews/2026-06-22-task1-project-scaffold-review.md',
    sha: '6a48839a5d34',
    desc: '开发机 Windows 用户名(v0.1 引擎自检日志原样抄录)',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '不是凭据(无从撤销 / 轮换),§6.0 三条件 ⓐ 不成立;所在目录在剥离清单内。已入命中清单。'
  },
  {
    rule: 'R8',
    file: 'docs/v0.1/superpowers/reviews/2026-06-23-task3.5-persistence-denative-nodesqlite-review.md',
    sha: '6a48839a5d34',
    desc: '同上 —— 真实 userData 路径取证',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '同上。'
  },
  {
    rule: 'R8',
    file: 'docs/v0.1/superpowers/reviews/2026-06-25-task5-video-download-ytdlp-review.md',
    sha: '6a48839a5d34',
    desc: '同上 —— yt-dlp 可写副本路径取证',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '同上。'
  },

  // ── R9:v0.4 Task 1 的 `ipconfig` 实测取证(真实内网地址 + 网关)──────────────
  // 与上面同一判据:不是凭据 ⇒ 不当场处置;`docs/v0.4/` 在剥离清单内 ⇒ 不进发布树。
  {
    rule: 'R9',
    file: 'docs/v0.4/prompt/task1-bt-connectivity-plan.md',
    sha: '18459bb5a002',
    desc: '开发机真实内网 IPv4(2026-07-29 入站可达性取证)',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '不是凭据;所在目录在剥离清单内。已入命中清单(同行还有一个真实公网 IPv6,本规则扫不到,人工核实所得)。'
  },
  {
    rule: 'R9',
    file: 'docs/v0.4/prompt/task1-bt-connectivity-plan.md',
    sha: '48805b1485dc',
    desc: '开发机真实家用路由器网关地址',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '同上。'
  },
  {
    rule: 'R9',
    file: 'docs/v0.4/superpowers/specs/2026-07-29-task1-bt-connectivity-design.md',
    sha: '18459bb5a002',
    desc: '同上 —— spec 侧的同一份事实表',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '同上。'
  },
  {
    rule: 'R9',
    file: 'docs/v0.4/superpowers/specs/2026-07-29-task1-bt-connectivity-design.md',
    sha: '48805b1485dc',
    desc: '同上 —— spec 侧的同一份事实表',
    verdict: '真命中 · 非凭据 · 不进发布树',
    why: '同上。'
  },

  // ── R9:合成测试向量与它们在文档里的引用 ──────────────────────────────────
  // 规则正确(它确实是私网 IP),只是这一条不是秘密 ⇒ **实例级**,不动规则。
  // 🚫 不许因为「测试里还会再出现」就把整个测试面从规则 9 排除 —— 那会把上面四条真命中一起埋掉。
  {
    rule: 'R9',
    file: 'docs/v0.4/prompt/task1-bt-connectivity-plan.md',
    sha: 'c5eb5a4cc76a',
    desc: 'IPv4-mapped IPv6 的合成测试向量(文档里的用例清单)',
    verdict: '实例级假阳',
    why: '合成数据,取的是最典型的网关形态用于说明 `hasGlobalUnicastIPv6` 对 IPv4-mapped 返回 false。'
  },
  {
    rule: 'R9',
    file: 'docs/v0.4/superpowers/specs/2026-07-29-task1-bt-connectivity-design.md',
    sha: 'c5eb5a4cc76a',
    desc: '同上 —— spec 侧的同一份用例清单',
    verdict: '实例级假阳',
    why: '同上。'
  },
  {
    rule: 'R9',
    file: 'src/main/bt/inboundDiagnosis.test.ts',
    sha: 'c5eb5a4cc76a',
    desc: '入站自检单测:IPv4-mapped 分支的合成夹具',
    verdict: '实例级假阳',
    why: '合成夹具。'
  },
  {
    rule: 'R9',
    file: 'src/main/bt/inboundDiagnosis.test.ts',
    sha: 'bb466c99efaf',
    desc: '入站自检单测:普通内网 v4 的合成夹具',
    verdict: '实例级假阳',
    why: '合成夹具(规划期实测点名的三个已知样本之一)。'
  },
  {
    rule: 'R9',
    file: 'src/main/bt/btTracker.integration.test.ts',
    sha: 'b0d56c1d2839',
    desc: 'tracker 表整表替换用例里的合成 announce 地址',
    verdict: '实例级假阳',
    why: '合成夹具。'
  },
  {
    rule: 'R9',
    file: 'src/main/proxy/proxyProbe.test.ts',
    sha: 'f5047344122f',
    desc: '代理地址解析单测的合成 socks5 地址',
    verdict: '实例级假阳',
    why: '合成夹具。'
  },
  {
    rule: 'R9',
    file: 'docs/v1.0/README.md',
    sha: 'bb466c99efaf',
    desc: '规划期扫描结论里逐字列出的已知假阳样本',
    verdict: '实例级假阳',
    why: '文档在**记录本规则的已知假阳**,故天然命中自己 —— 与「记措辞红线的文档对自己的 pattern 天然不可能零命中」同型。'
  },
  {
    rule: 'R9',
    file: 'docs/v1.0/prompt/task1-test-hardening-plan.md',
    sha: 'bb466c99efaf',
    desc: '同上 —— 提示词里逐字列出的已知假阳样本',
    verdict: '实例级假阳',
    why: '同上。'
  },
  {
    rule: 'R9',
    file: 'docs/v1.0/superpowers/specs/2026-08-23-task1-test-hardening-design.md',
    sha: 'bb466c99efaf',
    desc: '同上 —— spec §5.1 里逐字列出的已知假阳样本',
    verdict: '实例级假阳',
    why: '同上。'
  },

  // ── R3:扩展 manifest 的 key 字段 ────────────────────────────────────────
  {
    rule: 'R3',
    file: 'extension/manifest.json',
    sha: 'd57d68dd550a',
    desc: '扩展的 RSA **公钥**(SPKI DER / base64),用途是把扩展 ID 钉死',
    verdict: '实例级假阳',
    why:
      '它是公钥不是私钥 —— 打包扩展时 Chrome 生成的那份 `.pem` **私钥**才是秘密。' +
      '规则本身要留着(manifest 的 key 字段每次都值得看一眼);对应私钥已核实:工作区与 git 历史零命中(R2 全 0)。'
  },

  // ── R7:上游 npm 元数据里的第三方作者邮箱 ─────────────────────────────────
  // ── R7:上游 npm 元数据里的第三方作者邮箱 ─────────────────────────────────
  {
    rule: 'R7',
    file: 'package-lock.json',
    sha: 'b0373516d594',
    desc: '上游包弃用公告文本里的作者联系邮箱(由 `npm install` 生成)',
    verdict: '实例级假阳',
    why:
      '非本项目内容,是上游发布到 registry 的公开元数据。' +
      '🚫 不因此把 lockfile 整体排除 —— 注册表凭据也可能落进 lockfile,凭据类规则(R1 / R4 / R6)必须继续扫它。'
  },

  // ── R12:过渡地址的实例级假阳，保留精确命中与分类语义 ───────────────────────
  {
    rule: 'R12',
    file: 'src/main/bt/inboundDiagnosis.test.ts',
    sha: 'eb709fb88435',
    desc: 'Teredo 过渡隧道地址的测试向量',
    verdict: '实例级假阳',
    why: '已解码核实:服务器段是公开的 Microsoft Teredo 服务器(40.81.120.44),客户端段按位取反解出 90.78.129.211(欧洲地址),与本机线路不符 ⇒ 非本机地址,是抄来的样例。'
  },
  {
    rule: 'R12',
    file: 'src/main/bt/inboundDiagnosis.test.ts',
    sha: '7949f53b4fd0',
    desc: 'ISATAP 压缩写法的测试向量',
    verdict: '实例级假阳',
    why: '内嵌的 IPv4 段是合成私网地址,非本机。'
  },
  {
    rule: 'R12',
    file: 'src/main/bt/inboundDiagnosis.test.ts',
    sha: '31c8ed0d2b19',
    desc: '6to4 过渡隧道地址的测试向量',
    verdict: '实例级假阳',
    why: '同上,内嵌 IPv4 段是合成私网地址。'
  },
  // ── Step3.5:逐项核验的56个有限非秘密键；不接收真实内部处置 ────────────
  {
    rule: 'R4',
    file: '.codex/hooks/load-context-docs.test.mjs',
    sha: '991ef87df7ba',
    desc: '指定诊断单测的合成不回显标记（Step3.5 组6）',
    verdict: '实例级假阳',
    why: 'diagnostic-mode 单测使用人类可读的合成命令标记，断言返回内容不回显输入；TEST_FACE 仅识别 test.ts/tsx，未覆盖此 test.mjs。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'THIRD-PARTY-NOTICES.md',
    sha: '8dc7a4227947',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组9）',
    verdict: '实例级假阳',
    why: '根第三方声明中的 OpenSSL/Eric Young 必需署名致谢，不能为消除扫描命中删改许可文字。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'docs/v1.0/prompt/task5-opensource-release-prep-plan.md',
    sha: '3faf2d391109',
    desc: '用户确认的公开 GitHub noreply 身份（Step3.5 组13）',
    verdict: '实例级假阳',
    why: '与已由用户提供并在设计中确认的 GitHub noreply 地址相同；公开身份，不是私人邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'docs/v1.0/superpowers/plans/2026-09-13-task5-release-prep-plan.md',
    sha: '3faf2d391109',
    desc: '用户确认的公开 GitHub noreply 身份（Step3.5 组14）',
    verdict: '实例级假阳',
    why: '与已由用户提供并在设计中确认的 GitHub noreply 地址相同；公开身份，不是私人邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'docs/v1.0/superpowers/reviews/2026-09-01-task2-pu2-ci-evidence.md',
    sha: '789a82b2f15a',
    desc: '用户确认的公开 GitHub noreply 身份（Step3.5 组15）',
    verdict: '实例级假阳',
    why: 'CI 演练记录中的 GitHub noreply 提交身份；不同于当前维护者地址，但不是私人收件邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'docs/v1.0/superpowers/specs/2026-09-13-task5-invariants.md',
    sha: '3faf2d391109',
    desc: '用户确认的公开 GitHub noreply 身份（Step3.5 组17）',
    verdict: '实例级假阳',
    why: '与已由用户提供并在设计中确认的 GitHub noreply 地址相同；公开身份，不是私人邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'docs/v1.0/superpowers/specs/2026-09-13-task5-release-prep-design.md',
    sha: '3faf2d391109',
    desc: '用户确认的公开 GitHub noreply 身份（Step3.5 组18）',
    verdict: '实例级假阳',
    why: '与已由用户提供并在设计中确认的 GitHub noreply 地址相同；公开身份，不是私人邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'scripts/release-policy.json',
    sha: '3faf2d391109',
    desc: '用户确认的公开 GitHub noreply 身份（Step6b：发布规则 publicGit.maintainer 字段，公开元数据检查的对照值）',
    verdict: '实例级假阳',
    why: '与已由用户提供并在设计中确认的 GitHub noreply 地址相同；公开身份，不是私人邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '73b0d78e7a52',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组19）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '06899de277f6',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组20）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '3c205d8fc749',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组21）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '5fb691953db1',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组22）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '2b9590b92eab',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组23）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'df8aca96f007',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组24）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'b706176186ef',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组25）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'ded123193d9d',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组26）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '9b6863e6b854',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组27）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '509259eb2a2f',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组28）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '8b8f719dc9d2',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组29）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'cd5cd8d4c0a0',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组30）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'ae4d1dae7556',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组31）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '26fc824771f7',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组32）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: '1ed31b0ffc30',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组33）',
    verdict: '实例级假阳',
    why: 'aria2 附带 ChangeLog 中的上游 author/committer/Signed-off-by 公开署名。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R8',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'cbb14683a7aa',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组34）',
    verdict: '实例级假阳',
    why: 'aria2 上游 ChangeLog 的调试调用栈源路径，不是 DownLord 本轮加入的开发机路径。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R9',
    file: 'resources/bin/license-notices/aria2/ChangeLog',
    sha: 'c5eb5a4cc76a',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组35）',
    verdict: '实例级假阳',
    why: 'aria2 上游 ChangeLog 调试记录中的 RFC1918 Host 地址，属于附带上游记录而非本轮本机网络取证。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: '91ebb2ac5811',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组36）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: '8dc7a4227947',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组37）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/LICENSE.OpenSSL',
    sha: 'bd85be195d29',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组38）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/aria2/README.html',
    sha: 'af0449c16d4d',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组39）',
    verdict: '实例级假阳',
    why: 'aria2 附带 HTML 的样式作者版权信息。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/developer.html',
    sha: 'c7f2ffdcf0b2',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组40）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: 'aa173b67be6a',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组41）',
    verdict: '实例级假阳',
    why: '上游公开 SSH/git user@host 端点被 R7 邮箱形态匹配；上下文是命令端点，不是泄露的凭据。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: 'd0c46d919351',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组42）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R8',
    file: 'resources/bin/license-notices/ffmpeg/doc/fate.html',
    sha: '7f1527bf8965',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组43）',
    verdict: '实例级假阳',
    why: 'FFmpeg FATE 文档中 rsync 远端服务器路径被 R8 当作本机 home 路径。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffmpeg-formats.html',
    sha: '0387f8c569a2',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组48）',
    verdict: '实例级假阳',
    why: 'FFmpeg tee/UDP 或 PulseAudio sources/sinks 使用示例里的私网地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffmpeg.html',
    sha: 'ff13fcc2ae8b',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组49）',
    verdict: '实例级假阳',
    why: 'FFmpeg tee/UDP 或 PulseAudio sources/sinks 使用示例里的私网地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffplay.html',
    sha: 'ff13fcc2ae8b',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组50）',
    verdict: '实例级假阳',
    why: 'FFmpeg tee/UDP 或 PulseAudio sources/sinks 使用示例里的私网地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R9',
    file: 'resources/bin/license-notices/ffmpeg/doc/ffprobe.html',
    sha: 'ff13fcc2ae8b',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组51）',
    verdict: '实例级假阳',
    why: 'FFmpeg tee/UDP 或 PulseAudio sources/sinks 使用示例里的私网地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'e0dbf78908d1',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组52）',
    verdict: '实例级假阳',
    why: '上游公开 SSH/git user@host 端点被 R7 邮箱形态匹配；上下文是命令端点，不是泄露的凭据。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: '89b6ce958b19',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组53）',
    verdict: '实例级假阳',
    why: '上游公开 SSH/git user@host 端点被 R7 邮箱形态匹配；上下文是命令端点，不是泄露的凭据。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'c7f2ffdcf0b2',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组54）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'fe2fb8becf38',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组55）',
    verdict: '实例级假阳',
    why: 'FFmpeg GPG 生成密钥命令示例中的身份参数，不含私钥本体或访问凭据。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/git-howto.html',
    sha: 'ef7196ce213c',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组56）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'a0f0a74af3a7',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组57）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: '7951d1c23785',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组58）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'c7f2ffdcf0b2',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组59）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: '828ed3e40b6c',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组60）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/mailing-list-faq.html',
    sha: 'dda596d51125',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组61）',
    verdict: '实例级假阳',
    why: 'FFmpeg 开发、服务管理或邮件列表的公开联系地址。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/ffmpeg/doc/style.min.css',
    sha: '05dd11d43a77',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组62）',
    verdict: '实例级假阳',
    why: 'FFmpeg 附带 CSS 版权声明中的公开作者邮箱。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/README.md',
    sha: 'db015cdc4faa',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组63）',
    verdict: '实例级假阳',
    why: 'yt-dlp netrc 文档显式 E.g. 示例，配套合成用户名/密码标记；不是本机 Cookie 或密码。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '4bafcb8c075f',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组64）',
    verdict: '实例级假阳',
    why: 'yt-dlp 成品第三方许可中的版权作者/联系人，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '59190f05e806',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组65）',
    verdict: '实例级假阳',
    why: 'yt-dlp 成品第三方许可中的版权作者/联系人，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '3c51116159b6',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组66）',
    verdict: '实例级假阳',
    why: 'yt-dlp 成品第三方许可中的版权作者/联系人，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: '5914717faf21',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组67）',
    verdict: '实例级假阳',
    why: 'yt-dlp 成品第三方许可中的版权作者/联系人，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt',
    sha: 'bfb44e6ce4e8',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组68）',
    verdict: '实例级假阳',
    why: 'yt-dlp 成品第三方许可中的版权作者/联系人，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: '91ebb2ac5811',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组69）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: '8dc7a4227947',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组70）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  },
  {
    rule: 'R7',
    file: 'resources/bin/license-notices/yt-dlp/components/openssl-1.1.1t/LICENSE',
    sha: 'bd85be195d29',
    desc: '随引擎分发的上游公开许可/署名/示例/诊断材料（Step3.5 组71）',
    verdict: '实例级假阳',
    why: '原 OpenSSL 许可条款/版权/致谢中的公开联系信息，保留原文。 只认此规则、此文件与命中文本哈希；其他值仍扫描。'
  }
]

// ── 工具 ──────────────────────────────────────────────────────────────────
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const sha12 = (s) => sha256(s).slice(0, 12)

/** 不回显命中片段。凭据形态的 open 连指纹也不输出；已核验非秘密登记另行打印。 */
const credentialShaped = (rule) => /^R[1-6]$/.test(rule)
const redact = (s) => `<内容隐藏>(${s.length} 字符)`
const coverage = {
  maxBytes: MAX_BYTES,
  workspace: { candidateFiles: 0, scannedFiles: 0, skipped: [] },
  history: { listedObjects: 0, uniqueBlobs: 0, scannedBlobs: 0, skipped: [] },
  paths: { workspace: 0, history: 0 }
}
const inputErrors = []
if (policyState.error)
  inputErrors.push({ face: 'policy', file: POLICY_PATH, code: policyState.error })

function checkedGit(result, operation) {
  if (result.error || result.status !== 0)
    throw new Error(`SCAN_INPUT_ERROR git ${operation} exit=${result.status ?? 'unavailable'}`)
  return result
}
function git(args, opts = {}) {
  return checkedGit(
    spawnSync('git', args, {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
      ...opts
    }),
    args[0]
  )
}
const toPosix = (p) => p.split(sep).join('/')
const isBinaryPath = (p) => BINARY_EXT.test(p)
const looksBinary = (buf) => buf.includes(0)

// ── 面一:工作区内容(追踪文件 + 未忽略的未追踪文件)───────────────────────
const trackedPaths = new Set()
function workspaceFiles() {
  const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean)
  for (const p of tracked) trackedPaths.add(p)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .stdout.split('\0')
    .filter(Boolean)
  const candidates = [...new Set([...tracked, ...untracked])]
  coverage.workspace.candidateFiles = candidates.length
  return candidates.filter((file) => {
    if (!isBinaryPath(file)) return true
    coverage.workspace.skipped.push({ file, reason: 'binary-path' })
    return false
  })
}

// ── 面二:git 历史内容(全部可达 blob,按 sha 去重)─────────────────────────
function historyBlobs() {
  const lines = git(['rev-list', '--objects', '--all']).stdout.split('\n')
  const bySha = new Map()
  for (const line of lines) {
    const i = line.indexOf(' ')
    if (i < 0) continue // 无路径的 commit / root tree 对象不作为内容输入
    const sha = line.slice(0, i)
    const file = line.slice(i + 1)
    if (!file || bySha.has(sha)) continue
    if (isBinaryPath(file)) {
      coverage.history.skipped.push({ file, blob: sha, reason: 'binary-path' })
      continue
    }
    bySha.set(sha, file)
  }
  coverage.history.listedObjects = bySha.size
  return bySha
}

/** cat-file 的命名对象可能是 tree；区分类型后才计 blob，匹配次数不作对象数。 */
function readBlobs(shas) {
  const res = git(['cat-file', '--batch'], {
    input: Buffer.from(shas.join('\n') + '\n', 'utf8'),
    maxBuffer: 512 * 1024 * 1024,
    encoding: null
  })
  const out = res.stdout
  const map = new Map()
  let i = 0
  while (out && i < out.length) {
    const nl = out.indexOf(0x0a, i)
    if (nl < 0) throw new Error('SCAN_INPUT_ERROR incomplete cat-file header')
    const parts = out.subarray(i, nl).toString('utf8').split(' ')
    const size = Number(parts[2])
    const start = nl + 1
    if (parts.length !== 3 || !Number.isSafeInteger(size) || size < 0 || start + size >= out.length)
      throw new Error('SCAN_INPUT_ERROR incomplete cat-file object')
    map.set(parts[0], { type: parts[1], buffer: out.subarray(start, start + size) })
    i = start + size + 1
  }
  if (shas.some((sha) => !map.has(sha))) throw new Error('SCAN_INPUT_ERROR missing cat-file object')
  return map
}

// ── 面三:文件存在性(工作区文件系统,含被 .gitignore 挡住的)────────────────
function walkPaths(dir, acc) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    inputErrors.push({
      face: 'path',
      file: toPosix(relative(ROOT, dir)),
      code: error.code ?? 'READ_ERROR'
    })
    return acc
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkPaths(full, acc)
    else acc.push(toPosix(relative(ROOT, full)))
  }
  return acc
}

// ── 扫描 ──────────────────────────────────────────────────────────────────
/** 原文及指纹只在内存中参与精确键配对；来源携带独立 blob 身份供报告去重。 */
const findings = []
const perRule = new Map(RULES.map((r) => [r.id, 0]))
function record(rule, file, where, text, source) {
  findings.push({
    rule: rule.id,
    name: rule.name,
    file,
    where,
    sha: sha12(text),
    red: redact(text),
    source
  })
  perRule.set(rule.id, perRule.get(rule.id) + 1)
}
function scanContent(file, text, where, source) {
  for (const rule of RULES) {
    if (rule.face !== 'content' || rule.off) continue
    if (rule.only && !rule.only.test(file)) continue
    if (rule.skipFace && rule.skipFace.test(file)) continue
    if (rule.releaseOnly && (where === null || !inReleaseTree(file))) continue
    rule.re.lastIndex = 0
    let m
    while ((m = rule.re.exec(text)) !== null) {
      const hit = m[0]
      // 必须在任意 continue 前推进零长匹配，防止退化正则死循环。
      if (hit.length === 0) {
        rule.re.lastIndex++
        continue
      }
      if (rule.ignoreMatch && rule.ignoreMatch(hit)) continue
      if (rule.ignoreValue && m[2] && rule.ignoreValue.test(m[2])) continue
      const line = where === null ? null : text.slice(0, m.index).split('\n').length
      record(rule, file, line === null ? '(git 历史)' : `:${line}`, hit, source)
    }
  }
}
function scanPath(file, where, source) {
  for (const rule of RULES) {
    if (rule.face !== 'path') continue
    if (rule.re.test(file)) record(rule, file, where, file, source)
  }
}

let fsPaths = []
function scanInputs() {
  const wsFiles = workspaceFiles()
  for (const file of wsFiles) {
    let buf
    try {
      const bytes = statSync(join(ROOT, file)).size
      if (bytes > MAX_BYTES) {
        coverage.workspace.skipped.push({ file, reason: 'oversize', bytes })
        continue
      }
      buf = readFileSync(join(ROOT, file))
    } catch (error) {
      coverage.workspace.skipped.push({ file, reason: 'read-error' })
      inputErrors.push({ face: 'content', file, code: error.code ?? 'READ_ERROR' })
      continue
    }
    if (looksBinary(buf)) {
      coverage.workspace.skipped.push({ file, reason: 'binary-content', bytes: buf.length })
      continue
    }
    coverage.workspace.scannedFiles++
    scanContent(file, buf.toString('utf8'), 0, {
      kind: 'workspace-content',
      inputSha256: sha256(buf)
    })
  }

  const blobs = historyBlobs()
  const allShas = [...blobs.keys()]
  for (let i = 0; i < allShas.length; i += 300) {
    const chunk = allShas.slice(i, i + 300)
    const contents = readBlobs(chunk)
    for (const sha of chunk) {
      const { type, buffer: buf } = contents.get(sha)
      const file = blobs.get(sha)
      if (type !== 'blob') {
        coverage.history.skipped.push({ file, blob: sha, reason: 'non-blob' })
        continue
      }
      coverage.history.uniqueBlobs++
      if (buf.length > MAX_BYTES) {
        coverage.history.skipped.push({ file, blob: sha, reason: 'oversize', bytes: buf.length })
        continue
      }
      if (looksBinary(buf)) {
        coverage.history.skipped.push({
          file,
          blob: sha,
          reason: 'binary-content',
          bytes: buf.length
        })
        continue
      }
      coverage.history.scannedBlobs++
      scanContent(file, buf.toString('utf8'), null, {
        kind: 'history-content',
        blob: sha,
        inputSha256: sha256(buf)
      })
    }
  }

  fsPaths = walkPaths(ROOT, [])
  const historyPaths = new Set(blobs.values())
  coverage.paths = { workspace: fsPaths.length, history: historyPaths.size }
  for (const p of fsPaths) scanPath(p, '(工作区)', { kind: 'workspace-path' })
  for (const p of historyPaths) scanPath(p, '(git 历史)', { kind: 'history-path' })
}
// 只捕获输入链；不回显底层错误、stderr 或堆栈，不把报告/退出混入捕获边界。
try {
  scanInputs()
} catch {
  inputErrors.push({ face: 'input', code: 'SCAN_INPUT_ERROR' })
}

// ── 内部受限处置(仅原开发机内部工作区;C-1 载体 / C-2 消费与失效 / C-3 非递归边界)────────
/**
 * 载体是**内部**文件:它的路径不写在本文件里,而是由唯一发布规则里那条具名的禁止候选路径(id `F-08`)派生 ——
 * 同一份规则既保证它永不进候选、也告诉本扫描器去哪里读它。公开 scanner 因此不含载体文件名字面量。
 *
 * 每条记录每次运行都从零核验,任一环节失败 ⇒ 记录不生效、其命中照常 open、本次运行退出 1:
 *   ① 形态严格:精确键集、无未知字段、无 force / effective 之类开关;只配对 R8 / R10 / R11(凭据规则永不进入);
 *   ② 批准凭证:仓库相对、**未跟踪**的证据文件,sha256 相符;签署文本须逐字列出该记录的对象键与每条来源
 *      (绑定按表格行、同一行含输入 sha256 与 blob;只在正文被提到的哈希不算);对象 / 来源 / 作用域摘要按记录自身内容重算;
 *   ③ 边界:规则 sha256 = 当前规则;字段 + 路径在当前规则里存在且真的覆盖该文件;覆盖类记录的公开输入
 *      = 当前公开文件字节 = 同步登记值;剥离类记录不得伪造公开输入;仅包内排除不构成来源边界;
 *   ④ 边界子证明:未跟踪、sha256 相符,绑定同一规则、同一来源集合、同一原身份,并对该文件有一致的候选断言;
 *   ⑤ 来源集合(C-3):当前索引里全部跟踪条目的 {path, mode, sha256},只精确排除载体自身,按路径字节序
 *      固定编码后取 sha256,与记录绑定值相等 —— 任何新增 / 移除 / 内容 / 模式变化都让旧证据失效;
 *   ⑥ 命中配对:只处置 key 相同**且来源相同**(工作区 inputSha256 / 历史 blob)的命中;零配对 = 活跃失效。
 * 候选 / 包不消费本载体:候选没有证据根,② 必然失败;候选适配器又把它列为禁止路径,泄入即边界失败。
 * 报告只记一致性结论与脱敏引用:不回显身份、命中原文或凭证内容。
 */
const DISPOSITION_RULES = new Set(['R8', 'R10', 'R11'])
const BOUNDARY_FIELDS = new Set([
  'stripPaths',
  'forbiddenCandidatePaths',
  'publicDocuments',
  'artifactRules'
])
const AUTOMATED_REVIEWER = /^(ai|assistant|bot|script|automated|claude|codex|gpt|model)/i
const BOUNDARY_PROOF_KIND = 'internal-disposition-boundary-proof'
const identityContextSha256 = sha256(`downlord-identity-context\n${MACHINE_USER}\n${ROOT}`)
const exactKeys = (obj, keys) =>
  obj !== null &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length &&
  keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
function readRepoFile(rel) {
  try {
    return { buffer: readFileSync(join(ROOT, ...rel.split('/'))) }
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { error: error.code ?? 'READ_ERROR' }
  }
}
function carrierPathFromPolicy() {
  if (!policyState.policy) return { path: null, status: 'policy-unavailable' }
  const rule = policyState.policy.forbiddenCandidatePaths.find((r) => r.id === 'F-08')
  if (!rule || rule.kind !== 'file') return { path: null, status: 'not-declared' }
  if (!policyState.policy.stripPaths.some((s) => pathRuleCovers(s, rule.path)))
    return { path: null, status: 'not-declared' }
  return { path: rule.path, status: 'declared' }
}
function objectSourceScopeDigest(rec) {
  return sha256(
    JSON.stringify({
      key: { rule: rec.key.rule, file: rec.key.file, matchedTextSha12: rec.key.matchedTextSha12 },
      scope: rec.scope,
      sourceBindings: rec.sourceBindings.map((b) =>
        b.kind === 'workspace'
          ? { kind: b.kind, inputSha256: b.inputSha256 }
          : { kind: b.kind, inputSha256: b.inputSha256, blob: b.blob }
      )
    })
  )
}
/** C-3 来源集合:索引跟踪条目 {path, mode, sha256}(工作区字节),精确排除载体;失败只记状态,不进 inputErrors。 */
let sourceSetState = null
function currentSourceSet(carrierPath) {
  if (sourceSetState) return sourceSetState
  try {
    const rows = git(['ls-files', '-s', '-z'])
      .stdout.split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t')
        const [mode, , stage] = line.slice(0, tab).split(' ')
        return { mode, stage, path: line.slice(tab + 1) }
      })
    if (rows.some((r) => r.stage !== '0')) throw new Error('unmerged index entries')
    const entries = []
    for (const r of rows) {
      if (r.path === carrierPath) continue
      entries.push({
        path: r.path,
        mode: r.mode,
        sha256: sha256(readFileSync(join(ROOT, ...r.path.split('/'))))
      })
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
    sourceSetState = {
      sha256: sha256(JSON.stringify(entries)),
      count: entries.length,
      excluded: [carrierPath]
    }
  } catch (error) {
    sourceSetState = { error: 'SOURCE_SET_UNVERIFIABLE', code: error.code ?? null }
  }
  return sourceSetState
}
/** 形态校验:返回问题码数组(空 = 形态合法)。只看结构与取值范围,不读任何外部文件。 */
function recordShapeProblems(rec) {
  const problems = []
  if (!exactKeys(rec, ['recordType', 'scope', 'key', 'sourceBindings', 'approval', 'boundary']))
    return ['RECORD_SCHEMA_INVALID']
  if (
    rec.recordType !== 'real-internal-noncredential' ||
    rec.scope !== 'internal-original-workspace'
  )
    problems.push('RECORD_SCHEMA_INVALID')
  if (!exactKeys(rec.key, ['rule', 'file', 'matchedTextSha12']))
    problems.push('RECORD_SCHEMA_INVALID')
  else {
    if (!DISPOSITION_RULES.has(rec.key.rule)) problems.push('RULE_NOT_ELIGIBLE')
    if (!isRepoRelativeLiteral(rec.key.file)) problems.push('KEY_FILE_INVALID')
    if (!HEX12.test(rec.key.matchedTextSha12)) problems.push('RECORD_SCHEMA_INVALID')
  }
  if (!Array.isArray(rec.sourceBindings) || rec.sourceBindings.length === 0)
    problems.push('RECORD_SCHEMA_INVALID')
  else {
    const seen = new Set()
    for (const b of rec.sourceBindings) {
      const ok =
        (exactKeys(b, ['kind', 'inputSha256']) && b.kind === 'workspace') ||
        (exactKeys(b, ['kind', 'inputSha256', 'blob']) &&
          b.kind === 'history-content' &&
          HEX40.test(b.blob))
      if (!ok || !HEX64.test(b.inputSha256)) problems.push('RECORD_SCHEMA_INVALID')
      const id = `${b.kind}|${b.inputSha256}|${b.blob ?? ''}`
      if (seen.has(id)) problems.push('DUPLICATE_SOURCE_BINDING')
      seen.add(id)
    }
  }
  const a = rec.approval
  if (
    !exactKeys(a, ['reviewer', 'approvedAt', 'proofRef', 'proofSha256', 'objectSourceScopeSha256'])
  )
    problems.push('RECORD_SCHEMA_INVALID')
  else {
    if (
      typeof a.reviewer !== 'string' ||
      a.reviewer.trim().length === 0 ||
      AUTOMATED_REVIEWER.test(a.reviewer.trim())
    )
      problems.push('REVIEWER_INVALID')
    const at = typeof a.approvedAt === 'string' ? Date.parse(a.approvedAt) : NaN
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(a.approvedAt)) || Number.isNaN(at) || at > Date.now())
      problems.push('APPROVED_AT_INVALID')
    if (
      !isRepoRelativeLiteral(a.proofRef) ||
      !HEX64.test(a.proofSha256) ||
      !HEX64.test(a.objectSourceScopeSha256)
    )
      problems.push('RECORD_SCHEMA_INVALID')
  }
  const b = rec.boundary
  const boundaryKeys = [
    'policySha256',
    'exactRuleFieldAndPath',
    'proofRef',
    'proofSha256',
    'sourceSetSha256'
  ]
  const hasOverlay =
    b !== null &&
    typeof b === 'object' &&
    Object.prototype.hasOwnProperty.call(b, 'overlayInputSha256')
  if (!exactKeys(b, hasOverlay ? [...boundaryKeys, 'overlayInputSha256'] : boundaryKeys))
    problems.push('RECORD_SCHEMA_INVALID')
  else {
    if (!HEX64.test(b.policySha256) || !HEX64.test(b.proofSha256) || !HEX64.test(b.sourceSetSha256))
      problems.push('RECORD_SCHEMA_INVALID')
    if (hasOverlay && !HEX64.test(b.overlayInputSha256)) problems.push('RECORD_SCHEMA_INVALID')
    if (!isRepoRelativeLiteral(b.proofRef)) problems.push('RECORD_SCHEMA_INVALID')
    if (
      !Array.isArray(b.exactRuleFieldAndPath) ||
      b.exactRuleFieldAndPath.length === 0 ||
      !b.exactRuleFieldAndPath.every(
        (e) =>
          exactKeys(e, ['field', 'path']) &&
          BOUNDARY_FIELDS.has(e.field) &&
          typeof e.path === 'string' &&
          e.path.length > 0 &&
          !/[*?[\]]/.test(e.path)
      )
    )
      problems.push('RECORD_SCHEMA_INVALID')
  }
  return [...new Set(problems)]
}
/**
 * 签署文本必须**逐字列出**这条记录的精确对象与每条来源:对象以 `规则|文件|sha12` 反引号字面量出现;
 * 每条绑定以**同一行**同时含反引号包住的输入 sha256 与(历史绑定的)blob 的表格行出现。
 * 只在正文里被提到的哈希(例如「仅作未覆盖输入标识、不在批准范围」)不算列出 —— 子串命中会把
 * 「签署时明确排除」读成「已批准」。哈希不相符或缺行 ⇒ 该记录未获逐项批准。
 */
function approvalListingProblems(rec, proofBuffer) {
  const text = proofBuffer.toString('utf8')
  const q = (v) => cc(96) + v + cc(96)
  const problems = []
  if (!text.includes(q(`${rec.key.rule}|${rec.key.file}|${rec.key.matchedTextSha12}`)))
    problems.push('OBJECT_NOT_IN_APPROVAL_PROOF')
  const rows = text.split(cc(10)).filter((line) => line.trim().startsWith('|'))
  for (const b of rec.sourceBindings) {
    const listed = rows.some(
      (line) =>
        line.includes(q(b.inputSha256)) &&
        (b.kind !== 'history-content' || line.includes(q(b.blob)))
    )
    if (!listed) problems.push('BINDING_NOT_IN_APPROVAL_PROOF')
  }
  return problems
}
/** 读一份证据文件:必须存在、未被 Git 跟踪(证据根在忽略面)、sha256 相符。 */
function verifyEvidenceRef(ref, expectedSha, codes) {
  if (trackedPaths.has(ref)) return { problem: 'PROOF_REF_TRACKED' }
  const read = readRepoFile(ref)
  if (read.missing) return { problem: codes.missing }
  if (read.error) return { problem: codes.unreadable }
  if (sha256(read.buffer) !== expectedSha) return { problem: codes.mismatch }
  return { buffer: read.buffer }
}
function verifyBoundary(rec, problems) {
  const policy = policyState.policy
  const b = rec.boundary
  if (b.policySha256 !== policyState.sha256) problems.push('POLICY_CHANGED')
  let sourceCovered = false
  let overlayRow = null
  for (const e of b.exactRuleFieldAndPath) {
    if (e.field === 'stripPaths' || e.field === 'forbiddenCandidatePaths') {
      const rule = policy[e.field].find((r) => r.path === e.path)
      if (!rule) problems.push('BOUNDARY_RULE_NOT_IN_POLICY')
      else if (pathRuleCovers(rule, rec.key.file)) sourceCovered = true
    } else if (e.field === 'publicDocuments') {
      const row = (policy.publicDocuments?.documents ?? []).find((d) => d.targetPath === e.path)
      if (!row) problems.push('BOUNDARY_RULE_NOT_IN_POLICY')
      else if (row.targetPath === rec.key.file) {
        sourceCovered = true
        overlayRow = row
      }
    } else if (e.field === 'artifactRules') {
      if (!(policy.artifactRules?.forbiddenInPackage ?? []).includes(e.path))
        problems.push('BOUNDARY_RULE_NOT_IN_POLICY')
      // 包内排除只约束成品,不构成源码公开边界
    }
  }
  if (!sourceCovered) problems.push('BOUNDARY_NOT_COVERING_FILE')
  const hasOverlay = Object.prototype.hasOwnProperty.call(b, 'overlayInputSha256')
  if (overlayRow) {
    if (!hasOverlay) problems.push('OVERLAY_REQUIRED')
    else {
      const pub = readRepoFile(overlayRow.publicPath)
      if (pub.missing || pub.error) problems.push('OVERLAY_INPUT_MISSING')
      else if (sha256(pub.buffer) !== b.overlayInputSha256) problems.push('OVERLAY_INPUT_MISMATCH')
      const reg = readRepoFile(policy.publicDocuments.registry)
      let registryRow = null
      try {
        if (!pub.missing && reg.buffer)
          registryRow = (JSON.parse(reg.buffer.toString('utf8')).documents ?? []).find(
            (d) => d.targetPath === overlayRow.targetPath && d.publicPath === overlayRow.publicPath
          )
      } catch {
        registryRow = null
      }
      if (!registryRow) problems.push('OVERLAY_REGISTRY_UNAVAILABLE')
      else if (registryRow.publicSha256 !== b.overlayInputSha256)
        problems.push('OVERLAY_REGISTRY_MISMATCH')
    }
  } else if (hasOverlay) problems.push('OVERLAY_NOT_APPLICABLE')
  return { overlayRow }
}
function verifyBoundaryProof(rec, overlayRow, carrierPath, problems) {
  const b = rec.boundary
  const proofRead = verifyEvidenceRef(b.proofRef, b.proofSha256, {
    missing: 'BOUNDARY_PROOF_MISSING',
    unreadable: 'BOUNDARY_PROOF_UNREADABLE',
    mismatch: 'BOUNDARY_PROOF_MISMATCH'
  })
  if (proofRead.problem) {
    problems.push(proofRead.problem)
    return
  }
  let proof
  try {
    proof = JSON.parse(proofRead.buffer.toString('utf8'))
  } catch {
    proof = null
  }
  if (
    !proof ||
    typeof proof !== 'object' ||
    proof.schemaVersion !== 1 ||
    proof.kind !== BOUNDARY_PROOF_KIND ||
    !Array.isArray(proof.assertions)
  ) {
    problems.push('BOUNDARY_PROOF_INVALID')
    return
  }
  if (proof.policySha256 !== b.policySha256) problems.push('BOUNDARY_PROOF_POLICY_MISMATCH')
  if (proof.sourceSetSha256 !== b.sourceSetSha256)
    problems.push('BOUNDARY_PROOF_SOURCE_SET_MISMATCH')
  if (proof.identityContextSha256 !== identityContextSha256) problems.push('IDENTITY_MISMATCH')
  const assertion = proof.assertions.find((a) => a && a.path === rec.key.file)
  if (!assertion) problems.push('BOUNDARY_PROOF_ASSERTION_MISSING')
  else if (overlayRow) {
    if (assertion.inCandidate !== true || assertion.candidateSha256 !== b.overlayInputSha256)
      problems.push('BOUNDARY_PROOF_ASSERTION_MISMATCH')
  } else if (assertion.inCandidate !== false) problems.push('BOUNDARY_PROOF_ASSERTION_MISMATCH')
  const set = currentSourceSet(carrierPath)
  if (set.error) problems.push('SOURCE_SET_UNVERIFIABLE')
  else if (set.sha256 !== b.sourceSetSha256) problems.push('SOURCE_SET_CHANGED')
}
function loadInternalDispositions() {
  const located = carrierPathFromPolicy()
  const state = {
    path: located.path,
    status: located.status,
    sha256: null,
    problems: [],
    records: [],
    sourceSet: null
  }
  if (!located.path) return state
  const read = readRepoFile(located.path)
  if (read.missing) return { ...state, status: 'absent' }
  if (read.error) return { ...state, status: 'invalid', problems: [{ code: 'CARRIER_UNREADABLE' }] }
  state.sha256 = sha256(read.buffer)
  let carrier
  try {
    carrier = JSON.parse(read.buffer.toString('utf8'))
  } catch {
    return { ...state, status: 'invalid', problems: [{ code: 'CARRIER_PARSE_ERROR' }] }
  }
  if (
    !exactKeys(carrier, ['schemaVersion', 'records']) ||
    carrier.schemaVersion !== 1 ||
    !Array.isArray(carrier.records)
  )
    return { ...state, status: 'invalid', problems: [{ code: 'CARRIER_SCHEMA_INVALID' }] }
  state.status = 'loaded'
  const identityOk = USER_RULE_ON && REPO_RULE_ON
  const keyCounts = new Map()
  for (const rec of carrier.records) {
    const k =
      rec?.key && typeof rec.key === 'object'
        ? `${rec.key.rule}|${rec.key.file}|${rec.key.matchedTextSha12}`
        : null
    if (k) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1)
  }
  for (const rec of carrier.records) {
    const row = {
      rule: rec?.key?.rule ?? null,
      file: rec?.key?.file ?? null,
      sha: rec?.key?.matchedTextSha12 ?? null,
      status: 'rejected',
      problems: recordShapeProblems(rec),
      disposed: { workspace: 0, history: 0 },
      bindings: []
    }
    const k = `${row.rule}|${row.file}|${row.sha}`
    if (row.rule !== null && keyCounts.get(k) > 1) row.problems.push('DUPLICATE_OBJECT')
    if (row.problems.length === 0) {
      if (!identityOk) row.problems.push('IDENTITY_UNAVAILABLE')
      else {
        const approval = verifyEvidenceRef(rec.approval.proofRef, rec.approval.proofSha256, {
          missing: 'APPROVAL_PROOF_MISSING',
          unreadable: 'APPROVAL_PROOF_UNREADABLE',
          mismatch: 'APPROVAL_PROOF_MISMATCH'
        })
        if (approval.problem) row.problems.push(approval.problem)
        else row.problems.push(...approvalListingProblems(rec, approval.buffer))
        if (objectSourceScopeDigest(rec) !== rec.approval.objectSourceScopeSha256)
          row.problems.push('OBJECT_SCOPE_MISMATCH')
        const { overlayRow } = verifyBoundary(rec, row.problems)
        verifyBoundaryProof(rec, overlayRow, located.path, row.problems)
      }
    }
    row.problems = [...new Set(row.problems)]
    if (row.problems.length === 0) {
      row.status = 'effective'
      row.bindings = rec.sourceBindings
    }
    state.records.push(row)
  }
  state.sourceSet = sourceSetState
  return state
}
const internalDispositions = loadInternalDispositions()
/** 命中配对:只有生效记录、同 key、同来源(工作区 inputSha256 / 历史 blob + inputSha256)才处置。 */
function disposeFinding(f) {
  for (const row of internalDispositions.records) {
    if (
      row.status !== 'effective' ||
      row.rule !== f.rule ||
      row.file !== f.file ||
      row.sha !== f.sha
    )
      continue
    const matched = row.bindings.some((b) =>
      f.source.kind === 'workspace-content'
        ? b.kind === 'workspace' && b.inputSha256 === f.source.inputSha256
        : f.source.kind === 'history-content' &&
          b.kind === 'history-content' &&
          b.blob === f.source.blob &&
          b.inputSha256 === f.source.inputSha256
    )
    if (matched) {
      row.disposed[f.source.kind === 'workspace-content' ? 'workspace' : 'history']++
      return true
    }
  }
  return false
}

// ── 分流:公开登记表只配对精确非秘密;内部受限处置只配对生效记录 + 相同来源;其余 open ────
const ackKey = (rule, file, sha) => `${rule}|${file}|${sha}`
const ackIndex = new Map(ADJUDICATED.map((a) => [ackKey(a.rule, a.file, a.sha), a]))
const ackSeen = new Map()
const open = []
const disposed = []
for (const f of findings) {
  const key = ackKey(f.rule, f.file, f.sha)
  const ack = ackIndex.get(key)
  if (disposeFinding(f)) disposed.push(f)
  else if (ack) {
    const bucket = ackSeen.get(key) ?? { ack, hits: [] }
    bucket.hits.push(f)
    ackSeen.set(key, bucket)
  } else open.push(f)
}
const stale = ADJUDICATED.filter((a) => !ackSeen.has(ackKey(a.rule, a.file, a.sha)))
const groups = new Map()
for (const f of open) {
  const key = ackKey(f.rule, f.file, f.sha)
  const group = groups.get(key) ?? { f, hits: [] }
  group.hits.push(f)
  groups.set(key, group)
}
// 凭据可能同时命中邮箱/地址规则；按来源关联脱敏，不能只看当前分组的规则编号。
// 只改变报告，不改变 findings/登记配对/open/stale 或历史二进制别名的读取行为。
const credentialFindings = open.filter((f) => credentialShaped(f.rule))
const credentialFiles = new Set(credentialFindings.map((f) => f.file))
const credentialBlobs = new Set(credentialFindings.map((f) => f.source.blob).filter(Boolean))
const credentialInputs = new Set(
  credentialFindings.map((f) => f.source.inputSha256).filter(Boolean)
)
const credentialSource = (f) =>
  credentialFiles.has(f.file) ||
  credentialBlobs.has(f.source?.blob) ||
  credentialInputs.has(f.source?.inputSha256)
const credentialMatchHashes = new Set(findings.filter(credentialSource).map((f) => f.sha))
// 同值可把凭据关联传播到另一输入；求到闭包后再输出，不能依赖遍历顺序。
let redactionChanged = credentialFindings.length > 0
while (redactionChanged) {
  redactionChanged = false
  for (const f of findings) {
    if (!credentialSource(f) && !credentialMatchHashes.has(f.sha)) continue
    for (const [set, value] of [
      [credentialFiles, f.file],
      [credentialBlobs, f.source.blob],
      [credentialInputs, f.source.inputSha256],
      [credentialMatchHashes, f.sha]
    ]) {
      if (value && !set.has(value)) {
        set.add(value)
        redactionChanged = true
      }
    }
  }
}
const fingerprintSensitive = (f) =>
  credentialShaped(f.rule) || credentialSource(f) || credentialMatchHashes.has(f.sha)
const reportedEntry = ({ rule, file, sha }) =>
  fingerprintSensitive({ rule, file, sha })
    ? { rule, file, fingerprintRedacted: true }
    : { rule, file, sha }
function reportSkipped(row) {
  if (!row.blob || (!credentialBlobs.has(row.blob) && !credentialFiles.has(row.file))) return row
  const safe = { ...row, fingerprintRedacted: true }
  delete safe.blob
  return safe
}
const reportedCoverage = {
  ...coverage,
  workspace: { ...coverage.workspace, skipped: coverage.workspace.skipped.map(reportSkipped) },
  history: { ...coverage.history, skipped: coverage.history.skipped.map(reportSkipped) }
}
function summarizeGroup({ f, hits }) {
  const sensitive = hits.some(fingerprintSensitive)
  const current = hits.filter((h) => h.source.kind.startsWith('workspace'))
  const historical = hits.filter((h) => h.source.kind.startsWith('history'))
  const historyContent = new Map()
  for (const h of historical.filter((h) => h.source.kind === 'history-content')) {
    const row = historyContent.get(h.source.blob) ?? {
      blob: h.source.blob,
      inputSha256: h.source.inputSha256,
      occurrences: 0
    }
    row.occurrences++
    historyContent.set(h.source.blob, row)
  }
  return {
    rule: f.rule,
    file: f.file,
    ...(sensitive ? { fingerprintRedacted: true } : { sha: f.sha }),
    currentOccurrences: current.length,
    currentLocations: current.map((h) => h.where),
    ...(!sensitive && current[0]?.source.inputSha256
      ? { currentInputSha256: current[0].source.inputSha256 }
      : {}),
    historyOccurrences: historical.length,
    historyBlobCount: historyContent.size,
    historyPathOccurrences: historical.filter((h) => h.source.kind === 'history-path').length,
    ...(sensitive ? {} : { historySources: [...historyContent.values()] })
  }
}
const openSummary = [...groups.values()].map(summarizeGroup)
for (const row of internalDispositions.records)
  if (row.status === 'effective' && row.disposed.workspace + row.disposed.history === 0) {
    row.status = 'stale'
    row.problems.push('ACTIVE_STALE')
  }
const dispositionProblems =
  internalDispositions.problems.length +
  internalDispositions.records.filter((r) => r.status !== 'effective').length
const status = inputErrors.length
  ? 'ERROR'
  : open.length || stale.length || dispositionProblems
    ? 'FAIL'
    : 'PASS'

// ── 报告:候选数量、实际覆盖、blob 和匹配次数各自命名 ────────────────────
console.log(
  `敏感信息扫描(工作区候选 ${coverage.workspace.candidateFiles} 个文件 / 已读文本 ${coverage.workspace.scannedFiles} 个; git 历史非二进制路径去重 blob ${coverage.history.uniqueBlobs} 个 / 已读文本 blob ${coverage.history.scannedBlobs} 个; 文件系统 ${fsPaths.length} 个路径 / ${RULES.length} 条规则)\n`
)
console.log('逐规则命中数(含已定性条目;用于误报率对照集的前后差分):')
for (const r of RULES)
  console.log(
    `   ${r.id.padEnd(3)} ${r.off ? '  —' : String(perRule.get(r.id)).padStart(4)}  ${r.name}${r.off ? `  ⚠️ 本机停用:${r.offWhy}` : ''}`
  )
console.log(
  `   ⚠️ R10/R11 按本次机器的原身份读取(身份值不回显 / 仓库根 ${REPO_SEGS.length} 段)。\n` +
    '      CI 绿不等于开发机绿；默认输入链不代表实际候选或安装包。'
)
for (const face of ['workspace', 'history']) {
  const rows = reportedCoverage[face].skipped
  const reasons = Object.fromEntries(
    [...new Set(rows.map((r) => r.reason))].map((reason) => [
      reason,
      rows.filter((r) => r.reason === reason).length
    ])
  )
  console.log(
    `   覆盖边界 ${face}:跳过 ${rows.length} 项 ${JSON.stringify(reasons)}；跳过不表示干净。`
  )
  for (const row of rows.filter((r) => r.reason === 'oversize'))
    console.log(
      `      未覆盖 >2MiB: ${row.file} (${row.bytes} bytes)${row.blob ? ` blob=${row.blob}` : ''}；需补检/待验。`
    )
}
console.log()
if (open.length > 0) {
  console.log(
    `🚨 未定性命中 ${groups.size} 组 / ${open.length} 处(精确处置，不因材料公开而豁免真实秘密):`
  )
  for (const [index, { f }] of [...groups.values()].entries()) {
    const row = openSummary[index]
    const loc =
      row.currentLocations.slice(0, 4).join(' ') +
      (row.currentOccurrences > 4 ? ` …共 ${row.currentOccurrences} 处` : '')
    const hist =
      row.historyBlobCount > 0
        ? `  + git 历史 ${row.historyBlobCount} 个 blob / ${row.historyOccurrences} 次匹配`
        : row.historyPathOccurrences > 0
          ? `  + git 历史路径 ${row.historyPathOccurrences} 次匹配`
          : ''
    console.log(`   [${f.rule} ${f.name}] ${f.file}${loc}${hist}`)
    console.log(
      `       命中内容:${f.red}   ${row.fingerprintRedacted ? '凭据关联指纹不记录' : `sha12=${f.sha}`}`
    )
  }
  console.log()
}
if (ackSeen.size > 0) {
  console.log(`📌 已定性条目 ${ackSeen.size} 条(每次运行完整打印，仍执行适用性和stale检查):`)
  for (const { ack, hits } of ackSeen.values()) {
    const hidden = hits.some(fingerprintSensitive)
    console.log(
      `   [${ack.rule}] ${ack.file}  ${hidden ? '凭据关联指纹不记录' : `sha12=${ack.sha}`}  ×${hits.length}  —— ${ack.verdict}`
    )
    console.log(`       ${ack.desc}`)
    console.log(`       理由:${ack.why}`)
  }
  console.log()
}
if (internalDispositions.status !== 'absent' && internalDispositions.path) {
  console.log(
    `🔒 内部受限处置(仅原开发机内部工作区):载体 ${internalDispositions.path} 状态=${internalDispositions.status}` +
      `${internalDispositions.sha256 ? ` sha256=${internalDispositions.sha256}` : ''};记录 ${internalDispositions.records.length} 条,每次运行完整核验批准 / 边界 / 来源集合 / 原身份:`
  )
  for (const p of internalDispositions.problems) console.log(`   ❌ 载体问题:${p.code}`)
  for (const r of internalDispositions.records) {
    const hidden = fingerprintSensitive({
      rule: r.rule ?? '',
      file: r.file ?? '',
      sha: r.sha ?? ''
    })
    console.log(
      `   [${r.rule}] ${r.file}  ${hidden ? '凭据关联指纹不记录' : `sha12=${r.sha}`}  ${r.status === 'effective' ? '生效' : r.status === 'stale' ? '活跃失效' : '未生效'}  工作区×${r.disposed.workspace} 历史×${r.disposed.history}` +
        (r.problems.length ? `  问题:${r.problems.join(',')}` : '')
    )
  }
  console.log()
}
if (stale.length > 0) {
  console.log(`❌ 登记表失效 ${stale.length} 条(登记了却零命中 —— 登记表腐烂即失败):`)
  for (const a of stale)
    console.log(
      `   [${a.rule}] ${a.file}  ${fingerprintSensitive(a) ? '凭据关联指纹不记录' : `sha12=${a.sha}`}  ${a.desc}`
    )
  console.log()
}
console.log('已收窄的规则(理由同时写在本文件注释里,🚫 不要顺手放宽回去):')
console.log('   收窄① R7 真实邮箱 —— 排除 RFC 2606 / 6761 保留域')
console.log('   收窄② R9 私网 IP —— 只判 RFC 1918 三段;回环是本地通道的产品常量')
console.log('   收窄③ R8 本机绝对路径 —— 只排除占位用户名;真实用户名仍被抓住')
console.log('   收窄④ R4 凭据关键字赋值 —— 原 TEST_FACE 不变;指定 .test.mjs 仅登记精确合成实例')
console.log('   收窄⑤ R12 公网 IPv6 —— 语法完整且≥4个非空hextet;文档前缀排除，滤镜参数不是地址')
console.log('   收窄⑥ R10/R11/R12 —— 只扫唯一发布规则剥离面之外的工作区文件;不扫历史，不换原身份')
// 现有 CLI 的报告数据,不是 release CLI / 候选适配的接口;内部受限处置只报一致性结论与脱敏引用。
console.log(
  'SCAN_SUMMARY ' +
    JSON.stringify({
      schemaVersion: 1,
      scope: 'default-workspace-history-not-candidate',
      status,
      identity: {
        userRuleOn: USER_RULE_ON,
        repoRuleOn: REPO_RULE_ON,
        rootSegments: REPO_SEGS.length
      },
      counts: {
        openGroups: groups.size,
        openOccurrences: open.length,
        stale: stale.length,
        acknowledgedGroups: ackSeen.size,
        disposed: disposed.length,
        dispositionProblems
      },
      releaseFace: {
        policy: POLICY_PATH,
        policySha256: policyState.sha256,
        stripRules: STRIPPED.length,
        error: policyState.error
      },
      coverage: reportedCoverage,
      inputErrors,
      open: openSummary,
      stale: stale.map(reportedEntry),
      internalDispositions: {
        path: internalDispositions.path,
        status: internalDispositions.status,
        sha256: internalDispositions.sha256,
        problems: internalDispositions.problems,
        sourceSet: internalDispositions.sourceSet,
        records: internalDispositions.records.map((r) => ({
          ...(fingerprintSensitive({ rule: r.rule ?? '', file: r.file ?? '', sha: r.sha ?? '' })
            ? { rule: r.rule, file: r.file, fingerprintRedacted: true }
            : { rule: r.rule, file: r.file, sha: r.sha }),
          status: r.status,
          problems: r.problems,
          disposed: r.disposed
        }))
      }
    })
)
if (inputErrors.length) {
  console.log(
    `❌ 执行错误: ${inputErrors.length} 项读取错误；上述计数仅反映已读取部分，不是完整扫描。`
  )
  process.exit(1)
}
if (open.length > 0 || stale.length > 0 || dispositionProblems > 0) {
  console.log(
    `❌ 扫描未过:未定性命中 ${open.length} 条 / 登记表失效 ${stale.length} 条 / 内部处置问题 ${dispositionProblems} 项\n` +
      '   → 规则误报修规则；精确非秘密才可登记；真实内部非凭据等待逐项批准与公开边界，不自动放行。\n' +
      '     真实凭据泄露 → 停下告知用户并撤销/轮换；不保存凭据及其指纹，删除文件不算处置。'
  )
  process.exit(1)
}
console.log('✅ 零未定性命中；未覆盖范围仍按报告另行补检')
