# 真机验收脚本(scripts/verify)

无 GUI 直接驱动**真实引擎代码路径**(`DownloadEngine` / `VideoEngine` + `resources/bin` 真二进制),
用本地 HTTP 服务器消除外网变量。dev:fake 全绿 ≠ 真机可用(2026-07-09 教训),每次触碰引擎链路后建议复跑。

| 脚本 | 覆盖 | 外部依赖 |
|---|---|---|
| `verify-aria2.mts` | aria2 启动/RPC、下载进度、**真暂停**(服务器字节冻结)、续传、限速(读回+降速)、取消、**任务级 all-proxy 注入**(mock 代理) | 无(全本地) |
| `verify-video.mts` | yt-dlp 自带下载器、挂 aria2c 加速、**中文路径 after_move 不乱码**、两种下载器下的**真暂停**(进程树死透+字节冻结) | 无(全本地) |
| `verify-bili.mts` | B 站真实端到端:解析+下载(aria2c 加速+限速+代理)、aria2c readout 进度帧、中文 savePath | 网络 + Firefox 已登录 B 站 + 本地代理(缺省 `http://127.0.0.1:7890`) |
| `task4-referer-guard.mts` | v0.4 Task 4 P3-1:**防盗链靶站**(校验 `Referer`,支持 Range/206),把服务端真正收到的 Referer / UA 原样打出来 —— `Referer` 是否贯通到 aria2 的 ground truth | 浏览器 + 已装并配对的扩展 + DownLord 在跑 |
| `task5-auth-reject.mts` | v0.4 Task 5 手测④:**拒绝靶站**(受保护媒体校验 cookie,无 cookie → **401**;另带一条不校验的对照组)—— 「转交后失败、错误里如实带状态码」的 ground truth。cookie 不在 Task 5 传,这是已知边界 | 浏览器 + 已装并配对的扩展 + **嗅探开关已开** + DownLord 在跑 |

用法:

```bash
npx tsx scripts/verify/verify-aria2.mts
npx tsx scripts/verify/verify-video.mts
npx tsx scripts/verify/verify-bili.mts [proxyUrl]
npx tsx scripts/verify/task4-referer-guard.mts [port]   # 然后浏览器开 http://127.0.0.1:18080/
npx tsx scripts/verify/task5-auth-reject.mts [port]     # 然后浏览器开 http://127.0.0.1:18090/
```

判据说明:
- 「真暂停 / 真取消」以**服务器侧字节停止流出**与 `tasklist` 无 `yt-dlp.exe` / `aria2c.exe` 残留为铁证,不信任 UI 状态。
- 限速在**环回**场景 aria2 精度很低(TCP 无背压、内核缓冲深),脚本判据为「`getGlobalOption` 读回正确 + 速率显著下降」;
  真实网络下限速是精确的(B 站实测 ~934KB/s ≈ 1024K)。
- 本机若有 `HTTP_PROXY` 等环境变量不影响结果:引擎 spawn 已净化代理环境(`src/main/childEnv.ts`)。
