/**
 * 子进程环境净化(纯函数,真机 2026-07-09 代理修复)。
 *
 * DownLord 的代理注入全靠**显式参数**(aria2 任务级 `all-proxy` / yt-dlp `--proxy`,Task 7 §4),
 * 引擎子进程不应看到宿主环境的代理变量:
 * - aria2 的优先级是「协议级 http(s)-proxy(由 HTTP_PROXY 等环境变量填充)**覆盖** all-proxy」,
 *   宿主带 HTTP_PROXY(如从 Clash 终端跑 dev)时任务级注入被整个压掉——direct 档照走代理、
 *   manual 档走的是环境代理而非用户所设(真机 2026-07-09 mock 代理验收 A7 实锤);
 * - yt-dlp(Python requests)同样读这些变量,`--proxy ''` 之外多一道兜底;
 *   yt-dlp 内部 spawn 的 aria2c(挂加速时)继承净化后的环境,一并覆盖。
 */
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy', 'no_proxy']

/** 复制 env 并剔除代理变量(大小写不敏感;不改动传入对象) */
export function stripProxyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (PROXY_ENV_KEYS.includes(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}
