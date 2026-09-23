export interface Aria2ArgsInput {
  port: number
  secret: string
  dir: string
  mainPid: number
  /**
   * 全局下载限速 KB/s 启动初值(v0.2 Task 2 · spec §2.2)。
   * `kbps>0` 才加 `--max-download-limit`;`0` / 缺省 → 不加(与 v0.1 逐字节等价,零回归)。
   * 值语义(v1.0 Task 8 · #100)= **每任务默认上限**(新任务继承的 `max-download-limit` 全局默认),
   * 键名沿用 settings 键 `maxOverallLimitKBps`,不代表总量上限。
   */
  maxOverallLimitKBps?: number
  /**
   * DHT 路由表持久化文件路径(v0.3 Task 1 · 2026-07-22 真机修订三 · spec §4.2)。
   * 有值才加 `--dht-file-path`(缺省不加,零回归):aria2 退出时落盘路由表,二次启动带已知节点
   * 回网,显著缩短每次冷启动「找 peers」的等待。文件由 aria2 自管,DownLord 不读写(§6.1)。
   */
  dhtFilePath?: string
  /**
   * IPv6 DHT 路由表持久化文件路径(v0.3 Task 2 · 2026-07-25 真机修订 · spec §14)。
   * 配合 `--enable-dht6`(下方固定参数):有值才加 `--dht-file-path6`,语义同 v4 版。
   */
  dhtFilePath6?: string
  /**
   * BT tracker 生效表(v0.4 Task 1 · spec §4.2 pull 通道)。
   * 非空 → 用它**替换**内置表拼 `--bt-tracker=`;缺省 / 空数组 → 用 `DEFAULT_BT_TRACKERS`
   * (**与现状逐字节等价,零回归**)。缓存表不做过期判断(D10)。
   *
   * ⚠️ 与 `maxOverallLimitKBps`「有值才 push 一条新参数」的范式**不同**:`--bt-tracker=` 是**恒存在**
   * 的参数,故这里是「有值换值、无值用内置」——同一位置、同一参数名、同一 `join(',')`,
   * 缺省输出逐字节不变(由 `aria2Args.test.ts` 的 `deepEqual` 快照钉死)。
   */
  btTrackers?: readonly string[]
}

/**
 * 内置公共 BT tracker 表(v0.3 Task 1 引入;Task 2 · 2026-07-25 真机修订扩充,spec §14)。
 *
 * aria2 **不自带**任何默认 tracker,纯磁力若无有效 `&tr=` 只能靠 DHT;真机 C1(元数据可得、正文 0 速)
 * 对照 Motrix:10 条静态小表不够——死 tracker 无 peer,域名版 udp 在 DNS 污染下解析即失败。
 * 本表 = ngosang/trackerslist 的 `trackers_best.txt` + `trackers_best_ip.txt`(Motrix 同源双表,
 * 2026-07-25 经 jsDelivr CDN 拉取)合并 40 条 + 旧表保留 7 条(国内可达 http(s) 可经 `all-proxy`
 * 走代理;IP 直连版不经 DNS)。静态快照会随时间衰减,**应用内定期自动更新表留后续 Task(见 TODO)**。
 */
export const DEFAULT_BT_TRACKERS: readonly string[] = [
  // ngosang/trackerslist trackers_best.txt(2026-07-25,20 条)
  'udp://tracker.publictracker.xyz:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'http://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.wildkat.net:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.peerfect.org:6969/announce',
  'udp://tracker.opentrackr.com:6969/announce',
  'udp://tracker.ilibr.org:6969/announce',
  'udp://tracker.ducks.party:1984/announce',
  'udp://tracker.corpscorp.online:80/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.auctor.tv:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://torrentclub.online:54123/announce',
  'udp://torrentclub.online:1984/announce',
  'udp://t.overflow.biz:6969/announce',
  'udp://seedpeer.net:6969/announce',
  // ngosang/trackerslist trackers_best_ip.txt(2026-07-25,20 条;IP 直连不经 DNS,抗污染)
  'udp://93.158.213.92:6969/announce',
  'udp://185.121.168.96:1337/announce',
  'http://93.158.213.92:1337/announce',
  'udp://151.242.104.187:80/announce',
  'udp://91.216.110.53:451/announce',
  'udp://164.152.110.70:6969/announce',
  'udp://43.250.54.126:6969/announce',
  'udp://65.109.28.17:6969/announce',
  'udp://95.217.80.20:6969/announce',
  'udp://95.217.80.22:6969/announce',
  'udp://37.120.182.83:1984/announce',
  'udp://34.66.57.33:80/announce',
  'udp://34.66.57.33:1337/announce',
  'udp://109.201.134.183:80/announce',
  'udp://152.53.194.103:54123/announce',
  'udp://152.53.194.103:1984/announce',
  'udp://177.172.61.26:6969/announce',
  'udp://180.131.145.175:6969/announce',
  'udp://83.102.180.21:80/announce',
  'udp://37.120.182.83:15480/announce',
  // 旧表保留(v0.3 Task 1 · 2026-07-22 修订三:老牌稳定 + 国内可达 + https/http 可经 all-proxy 走代理)
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.gbitt.info:80/announce',
  'http://open.acgnxtracker.com:80/announce'
]

export function buildAria2Args(input: Aria2ArgsInput): string[] {
  // tracker 生效表(v0.4 Task 1 · spec §4.2 pull):远端缓存表非空 → 整表替换内置表(D6:两表不合并);
  // 缺省 / 空数组 → 内置 47 条,与 v0.3 逐字节等价(零回归)。拉取失败时内置表就是唯一退路。
  const trackers =
    input.btTrackers && input.btTrackers.length > 0 ? input.btTrackers : DEFAULT_BT_TRACKERS
  const args = [
    '--enable-rpc',
    `--rpc-listen-port=${input.port}`,
    '--rpc-listen-all=false',
    `--rpc-secret=${input.secret}`,
    '--continue=true',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--file-allocation=none',
    // 防 IPv6 黑洞类环境单地址连接长挂(默认 60s×多地址;真机 2026-07-09):超时即换下一地址
    '--connect-timeout=10',
    `--dir=${input.dir}`,
    `--stop-with-process=${input.mainPid}`,
    // aria2 语义:`0` = 下载期间**不**保存 `.aria2` 控制文件(仅正常 stop 时保存)——恰与「及时刷盘」
    // 意图相反,崩溃 / 断电 / SIGKILL 时控制文件停留在任务起点,崩溃重启后续传几乎从零(§7.4)。
    // `1` = 每秒保存,崩溃恢复最多丢 1s 进度;与 ytdlpDownloader 的 aria2c 分支(=1)对齐。
    '--auto-save-interval=1',
    // aria2 默认并行任务数为 5,而设置页并发上限是 10(validateSettings MAX_CONCURRENT_MAX):
    // 不设此项时第 6-10 个任务在 aria2 内部 waiting,UI 显示「下载中」却 0 速。取 UI 上限保持同源。
    '--max-concurrent-downloads=10',
    // ===== BT 引导(v0.3 Task 1 · 2026-07-22 真机修订 · spec §4.2)=====
    // aria2 默认 enable-dht=true,但 **DHT 冷启动需引导节点**才能加入网络;缺 --dht-entry-point 时
    // DHT 实际不工作 → 无 tracker 的磁力永远取不到元数据(真机:迅雷可下的活种在此卡死 resolving)。
    // 以下参数**只对 BT 任务生效**,http/video 下载零影响(零回归);listen-port / dht-listen-port 用 aria2 默认。
    '--enable-dht=true',
    '--dht-entry-point=router.bittorrent.com:6881',
    '--enable-peer-exchange=true',
    '--bt-enable-lpd=true',
    `--bt-tracker=${trackers.join(',')}`,
    // ===== BT 连通性四件套(v0.3 Task 2 · 2026-07-25 真机修订 · spec §14,对照 Motrix)=====
    // 真机 C1:元数据可得、正文 0 速。元数据只需摸到任意一个 peer,正文需要足够多可连通且愿意
    // 上传的 peer——对照同为 aria2 内核、同网络可直连下载的 Motrix,差距在下列配置(全部只对 BT
    // 生效:listen-port 是 BT 数据端口,RPC 端口独立;http / video 下载零影响)。
    // ① 固定高位监听端口:aria2 默认 6881-6999 恰是 ISP 重点干扰的经典 BT 段;固定段也便于用户在
    //    路由器 / 防火墙放行(UPnP 自动端口映射留后续 Task,见 TODO)
    '--listen-port=52301-52310',
    '--dht-listen-port=52311-52320',
    // ② IPv6 DHT 双栈:大陆家宽普遍「IPv4 共享 NAT + 公网 IPv6」,v6 swarm 可直连、干扰少,常是
    //    「能不能跑起来」的分水岭;无 v6 环境 aria2 仅告警、v4 不受影响(诚实降级)
    '--enable-dht6=true',
    '--dht-entry-point6=dht.transmissionbt.com:6881',
    // ③ tracker 快速轮询:connect/announce 超时默认各 60s,公共 tracker 表必有死条目,逐条挂 60s
    //    会把「到达活 tracker」拖到分钟级;10s 快速轮过(Motrix 同值)
    '--bt-tracker-connect-timeout=10',
    '--bt-tracker-timeout=10',
    // ④ 主流客户端伪装:aria2 默认 peer id(A2-)/ agent 因历史「只下不传」名声被部分 BT 客户端与
    //    tracker 脚本歧视拒连;伪装 Transmission/3.00(与 Motrix 一致)。仅 BT 扩展握手 / peer id 层,
    //    不动 HTTP user-agent(直链下载行为零变化)
    '--peer-agent=Transmission/3.00',
    '--peer-id-prefix=-TR3000-',
    // 放大器:单任务 peer 池上限 55 → 128(Motrix 同值),①-④ 修好后扩大可用 peer 集
    '--bt-max-peers=128'
  ]
  // 全局限速启动初值(spec §2.2):仅 kbps>0 才加,0 / 缺省 → 不加(消除「启动到首次 RPC」窗口期;
  // 与 v0.1 逐字节等价,零回归)。崩溃重启复用本函数 → 自动带当前限速(§2.2)。
  // v1.0 Task 8 · #100:参数改为 `--max-download-limit`(每任务默认上限的初值),不再是 overall 总量硬上限。
  const kbps = input.maxOverallLimitKBps
  if (typeof kbps === 'number' && kbps > 0) {
    args.push(`--max-download-limit=${kbps}K`)
  }
  // DHT 路由表持久化(修订三,spec §4.2):有值才加,缺省与此前逐字节等价(零回归)
  if (input.dhtFilePath) {
    args.push(`--dht-file-path=${input.dhtFilePath}`)
  }
  // IPv6 DHT 路由表持久化(2026-07-25 真机修订,spec §14):同 v4 语义
  if (input.dhtFilePath6) {
    args.push(`--dht-file-path6=${input.dhtFilePath6}`)
  }
  return args
}
