# DownLord — 架构与开发约束(ARCHITECTURE)

> 本文档是 DownLord 的**技术层**事实来源:技术栈、目录结构、数据模型、服务层约定、开发约束、**禁止破坏的逻辑**与技术验收。
> 产品定位与范围见 [PRD.md](./PRD.md);视觉规范见 [DESIGN.md](./DESIGN.md);术语口径见根 [CONTEXT.md](../CONTEXT.md)。
> **改动架构或触及 §7「禁止破坏的逻辑」前必读本文件。**
>
> **标注约定**:✅ 已确立(需求澄清敲定 / 已有产物)| ⬜ 待填(脚手架或实现后对照源码回填,**请勿编造**)。
> ⬜ **是欠账不是装饰**:对应模块一旦落地,应在该 Task 收口时回填为 ✅ + 真实产物,不要留到下个版本。

---

# 1. 技术栈(✅ 已确立)

## 桌面端
- **Electron**(脚手架:`electron-vite`)
- **TypeScript**(强类型,质量优先)
- **React** + **Fluent UI**(`@fluentui/react-components`,Windows 11 Fluent Design)

## 主进程
- **运行时:Electron 内置 Node**(业务大脑)。测试与 App **统一在 Electron 内置 Node** 运行(ABI 由所用 Electron 决定):测试经 `ELECTRON_RUN_AS_NODE=1 electron`(electron-as-node)跑;**宿主 Node 仅用于构建 / 类型检查**(纯 JS / `tsc`),去 native(Task 3.5)后**不再受 native ABI 约束**、无 Node 版本上限钉子。
- 持久化:**SQLite — `node:sqlite`**(Electron 内置 `DatabaseSync`,**去 native**;写出标准 SQLite3 文件)。经引擎无关适配层 + 单一工厂 `src/main/db/engine.ts`,**可一文件回退 `better-sqlite3`**(详见 §7.3)。其 JS API 表面在当前 Electron 标记 experimental(仅 API 表面,存储为标准 SQLite3;复评触发器与升级 checklist 见下)。

> **node:sqlite 实验状态 / 复评触发器 / Electron 升级 checklist(Task 3.5 ADR 摘要)**:`DatabaseSync` 启动有 `ExperimentalWarning`(诚实暴露,不抑制)。任一触发即复评 node:sqlite vs 回退 better-sqlite3:① node:sqlite 在所用 Electron 转 Stable → 维持现状、去本节 experimental 标注;② Electron 大版本升级令 CI / Section A 转红 → 改 `src/main/db/engines/nodeSqlite.ts` 适配器几行,或经 `engine.ts` **一行回退** better-sqlite3;③ 出现影响 §7.3 的功能缺口 / 确证 bug → **立即一文件回退**。**每次 Electron 升级 checklist**:复核 node:sqlite Stability + 跑 CI(Section A 真跑即自动探针)+ 核对启动 `ExperimentalWarning`。

## 下载 / 解析内核(均为独立子进程)
- **aria2c** — 多线程分段下载 + BT/磁力;经 **JSON-RPC** 通信
- **yt-dlp** — 视频站点解析与下载;经 **CLI + JSON** 输出
- **ffmpeg** — 音视频合并 / 音频提取;由 yt-dlp 内部调用

## 工程
- 测试:`node --test` + `tsx`;React 用 jsdom / happy-dom + RTL(沿用既有项目约定)
- 打包:`electron-builder`(NSIS 安装包 + 可选 Portable)
- 构建命令 / 脚本:✅ 见下表

| script | 命令 | 用途 |
|---|---|---|
| `dev` | `electron-vite dev` | 起开发态(HMR) |
| `typecheck` | `npm run typecheck:node && npm run typecheck:web` | 三侧类型检查 |
| `test` | `node scripts/run-node-tests.mjs` | 跑全部单测(内部经 **electron-as-node**:`ELECTRON_RUN_AS_NODE=1 electron`,使 `node:sqlite` 可用、Section A 真跑) |
| `build` | `electron-vite build` | 产出 `out/`(main/preload/renderer) |
| `package` | `npm run build && electron-builder --win --config` | 出 NSIS 安装包到 `dist/`(去 native:`npmRebuild=false`、无 native 依赖需重建) |
| `start` | `electron-vite preview` | 预览打包前产物 |

> **已退役脚本(Task 3.5 去 native)**:`postinstall`(`electron-builder install-app-deps`)/ `rebuild:sqlite` / `dev:node22` / `typecheck:node22` / `test:node22` / `build:node22` 双 Node 包装、`scripts/with-node22.ps1` / `use-node22.ps1`、`.nvmrc` / `.node-version`、`.tools/` 双 Node 目录——`node:sqlite` 无需 native rebuild,这些机制不再需要。CI 门禁见 `.github/workflows/ci.yml`(windows-latest,经 electron-as-node 跑 `npm test` + `typecheck` + `build`,`CI=true` 下 Section A 真跑、不可静默 skip)。

---

# 2. 目录结构

## 2.1 用户数据结构(运行时 · ✅ 已落地)

```
%APPDATA%/DownLord/
├── bin/           # yt-dlp 可写副本(热更新落点,见 §7.5;更新期同目录临时 yt-dlp.exe.download / .pending)
├── database/      # SQLite:任务 / 历史 / 类别配置(✅ Task 3 / 6)
├── logs/          # 运行日志(✅ Task 9:electron-log 落盘 main.log + 滚动归档,接管 console)
└── config/        # 标量配置 JSON:proxy.json(✅ 代理,Task 7)/ settings.json(✅ 通用设置,Task 8)/ updateState.json(✅ 更新节流缓存,v0.2 Task 6)

下载产物：存到用户配置的目录,按文件类别(Category)归类(见 §4,Task 6)
打包内置：<安装目录>/resources/bin/  →  aria2c.exe / yt-dlp.exe / ffmpeg.exe
  (dev 态:`<项目根>/resources/bin`,定位逻辑见 `src/main/binaries/locator.ts`)
```

## 2.2 代码包结构(✅ v0.1 Task 1 建骨架 · 业务模块已随各 Task 落地,v0.3 收口回填至真实产物)

> Task 1 建立三侧骨架 + IPC bridge + 二进制定位 + 主题外壳 + 测试基建;此后各 Task 在预留位置补业务模块。**下表「落地状态」列记录的是截至 v0.3 收口(2026-07-28)的真实产物**,与源码目录逐一对照,非计划态。

| 区 | 职责 | Task 1 落地状态 | 后续 Task |
|---|---|---|---|
| `src/main/binaries/` | 二进制定位 / 可写副本 / 自检 | ✅ `locator.ts` / `ensureWritable.ts` / `selfCheck.ts` | Task 2/5/9 补真实二进制 |
| `src/main/ipc/` | IPC handler | ✅ `app.ts` / `window.ts` / `theme.ts` | Task 2+ 增业务 IPC |
| `src/main/window/` | 窗口创建 | ✅ `createMainWindow.ts` | - |
| `src/main/tasks/` | 任务枢纽 | ✅ Task 3 落地 | `taskManager.ts`(`TaskManager`:队列 / 出队 / 持久化协调 / 三创建路径 / BT 文件选择定型 / 做种编排)+ `stateMachine.ts`(8 态合法迁移)+ `concurrency.ts`(并发槽位)+ `recovery.ts`(重启恢复计划)+ `duplicateDetect.ts`(查重纯函数,v0.2 Task 3) |
| `src/main/engine/` | aria2 后端 | ✅ Task 2 落地 | `downloadEngine.ts`(`DownloadEngine`:守护 aria2c 子进程 + 轮询 + 崩溃重提)+ `compositeEngine.ts`(双执行器路由)+ `fakeEngine.ts`(dev / 测试)+ `aria2Process.ts` / `aria2Args.ts` / `aria2Limit.ts`(启动参数 / 限速纯函数)+ `rpcClient.ts` / `rpcCodec.ts`(JSON-RPC)+ `taskModel.ts` / `port.ts` / `secret.ts`;**v0.3 Task 1–3 加 `btOptions.ts`**(BT 任务级选项 / `--select-file` 映射 / 做种档纯函数) |
| `src/main/bt/` | BT 路径 | ✅ v0.3 Task 1 落地 | `torrentPaths.ts`(BT 路径纯函数:`torrentSaveDir` = `<defaultDir>/Torrents` 整包落点兜底子目录 / `managedTorrentDir` / `managedTorrentPath` = `<userData>/torrents/<taskId>.torrent` 托管副本,路径由 id 派生免额外持久化) |
| `src/main/video/` | yt-dlp 后端 | ✅ Task 5 落地 | `VideoResolver`(解析元信息 / 取格式)+ `VideoEngine`(yt-dlp 每任务一进程下载)+ 解析 / 参数 / 进度 / 选择器 / 文件名 / 链接识别纯函数 |
| `src/main/media/` | ffmpeg | ✅ Task 5 落地 | `MediaTool`(退化:仅 `resolveFfmpegLocation` 定位内置 ffmpeg,供 yt-dlp `--ffmpeg-location`) |
| `src/main/db/` | 持久层 | ✅ Task 3 落地 | `schema.ts`(建表 DDL 常量)+ `migration.ts`(迁移数组 + `LATEST_MIGRATION_VERSION`,当前 = 4)+ `connection.ts`(打开 / WAL / `quick_check` / 迁移前主动备份 / 损坏备份重建)+ `taskDao.ts`(任务 CRUD + 历史检索 / 统计 + `findBySource`)+ `categoryDao.ts` + `engine.ts`(引擎无关适配层单一工厂)+ `engines/nodeSqlite.ts`·`betterSqlite.ts` |
| `src/main/proxy/` | 代理 | ✅ Task 7 落地 | `ProxyService`(主动读系统代理 / `getResolved` / `setConfig` / 端口探测)+ 纯函数(`systemProxy` 解析 / `proxyArgs` 校验+三档映射 / `proxyStatus` 状态合成)+ `proxyStore`(proxy.json 读写)+ `systemProxyReader`(`session.resolveProxy`)/ `proxyProbe`(`net.connect` 只探代理端口)|
| `src/main/category/` | 文件类别 | ✅ Task 6 落地 | `categoryModel`(CategoryDef / CATEGORY_KEYS / DEFAULT_CATEGORIES)+ `categorize`(extractExt / buildExtIndex / categorize / resolveCategoryDir);判定纯函数,直链 / 视频共用 |
| `src/main/settings/` | 通用设置 | ✅ Task 8 落地 | `SettingsService`(init / get / set + onChange 联动:并发 / 默认目录 / 主题 / 视频偏好)+ 纯函数(`validateSettings` clamp / 白名单守卫 / mergeSettings + `settingsStore` settings.json 原子写 / 损坏回退重写)+ `nodeSettingsStoreFs` |
| `src/main/update/` | 自动更新 | ✅ v0.2 Task 6 落地 | `YtdlpUpdater`(yt-dlp 独立热更新编排:check / run;依赖全注入)+ `AppUpdater`(封装 `electron-updater`,事件→`UpdateStatus`,`autoDownload=false` 不静默)+ 纯函数(`ytdlpUpdate` 版本比对 / releases 解析 / SHA256)+ `updateHttp`(Electron `net` + 独立 update Session,`configureProxy`)+ `applyPendingYtDlp`(启动期应用 `.pending`)+ `paths`(`.download` / `.pending` 同目录派生)+ `updateStateStore`(updateState.json 24h 节流缓存,复用原子写)+ `nodeUpdateStateStoreFs` |
| `src/main/config/` | **json 配置存储的唯一权威** | ✅ **v0.4 Task 3 落地** | `jsonConfigStore.ts` —— `createJsonConfigStore<T>()` 泛型:原子写(`mkdir(dirname)` → 写 `<path>.tmp` → `rename`,内容 `JSON.stringify(v,null,2)` **无尾换行**)+ 读回守卫 + 损坏回退。**仓内五份 json 配置全部委托它**:`proxyStore`(v0.1 Task 7)/ `settingsStore`(v0.1 Task 8)/ `updateStateStore`(v0.2 Task 6)/ `btTrackerStore`(v0.4 Task 1)/ `channelConfig`(v0.4 Task 3)。差异**恰好只落在三个轴**上:`repairOnInvalid`(用户配置 ✅ 修复 / 派生缓存 ❌ 不修复、下次写入自愈)、`normalize`(取显式字段 / 补默认 / `mergeSettings` clamp)、`cloneDefaults`(**工厂而非常量** —— 含数组的默认值浅展开会被跨次读写污染)。fs 经 `JsonConfigStoreFs` 注入,本模块**不 import `fs`**;四份既有 store 的**导出名与签名逐字不变**,故五个调用点零改动 |
| `src/main/extensionChannel/` | **浏览器扩展本地通道**(只绑 `127.0.0.1` 的 HTTP 服务 + 三闸鉴权 + 握手) | ✅ **v0.4 Task 3 落地** | **纯函数与副作用的分界是本模块的组织原则**:<br>**纯函数(零 IO,时钟 / 配置全由参数进)** —— `channelAuth.ts`(三闸判定:token 头全等 / `OPTIONS` 零跨源放行头 / `Origin` 前缀)· `failureWindow.ts`(失败窗口限速工厂,**只作用于失败请求**)· `channelDispatch.ts`(信封校验 + 版本协商 + `type` 分发)· `linkState.ts`(扩展三态推导)· `portValidation.ts`(端口校验,带具体 code 供 UI 出能指路的文案)· `sideloadInfo.ts`(扩展目录定位,与 `binaries/locator.ts` 同形、运行态与路径全注入)。<br>**副作用(集中且可注入)** —— `channelServer.ts`(起停 socket / 读 body 两道上限 / 写回响应 / 聚合口径打日志;`BIND_HOST` 是**模块级字面量常量**,不进配置、不进 IPC)· `extensionChannelService.ts`(编排:配置读写 + token 保障 → 起停 → 持连接态 → 合成两行状态 → 广播;**一个 `electron` import 都没有**,与 `ProxyService` 同一纪律)· `channelConfig.ts`(委托 `config/jsonConfigStore`)· `nodeChannelStoreFs.ts` / `nodeHttpFactory.ts`(`node:fs` / `node:http` 薄封装,仅在 `index.ts` 装配点与集成测试注入)。<br>IPC handler 在 `src/main/ipc/extension.ts`(纯转发,五条 invoke + 一条 main→renderer 推送);渲染层 `ExtensionChannelSettings.tsx` **纯 UI**(§7.2) |
| `src/main/takeover/` | 浏览器下载接管,含域名例外表的精确/后缀匹配及设置页入口。 | ✅ **v0.4 Task 4 落地** | **纯函数与副作用同 `extensionChannel/` 一样分界**:<br>**纯函数** —— `takeoverRules.ts` 的 `decideTakeover`(**四道判定**:总开关关 / 暂停中〔`pausedUntil` 未到期〕/ 域名例外表命中 / `danger !== 'safe'`,任一命中即不接管;**时刻与配置全由参数进**)· `pauseState.ts`(三档时长 → `pausedUntil` 与剩余时间推导)· `takeoverBuffer.ts`(同域 500ms 聚合缓冲,单条 ↔ 列表两态)。<br>**副作用** —— `takeoverService.ts`(编排:收意图 → 判定 → **受理即回**〔`{taken:true}`,不等用户〕→ 开窗 → 收决策 → 走既有 `addTask` 全链路;**四种拒绝走同一条代码路径、回同一个 `{taken:false}`**,§7.6「绝不制造黑洞」)· `takeoverWindow.ts`(**DownLord 第一个独立 `BrowserWindow` 对话框**:预热 + `showOnce` + 主题通路 + frameless 拖动)· `takeoverConfig.ts`(委托 `config/jsonConfigStore` 的**第六份** store,落 `<userData>/config/takeover.json`,键集合**恰好** `enabled` / `pausedUntil` / `excludedDomains` 三个)。<br>**接管状态的唯一真源在主进程**(扩展 popup 的暂停开关只是遥控器,§7.2);渲染层 `TakeoverDialog` 纯 UI,查重命中**原样挂载既有 `DuplicateDialog`**(组件零改动) |
| `src/shared/` | 跨进程类型 | ✅ `ipc.ts`(通道名 + payload 类型) | Task 2+ 扩展 IPC 类型;**v0.4 Task 2/3 加 `extensionProtocol.ts`** —— 扩展与主进程的**唯一契约真源**(通道常量 + 信封 / 响应 / 原因码,**只有类型与常量、零函数**;扩展侧只准 `import type` 它,见下方 `extension/` 行 ②) |
| `src/preload/` | IPC bridge | ✅ `index.ts` / `index.d.ts`(强类型 contextBridge) | Task 2+ 扩展 API |
| `src/renderer/` | UI | ✅ 最小外壳(TitleBar / 主题切换 / 版本号) | Task 4+ 业务界面 |
| `src/renderer/src/theme/` | 主题 | ✅ `fluentTheme.ts` / `tokens.css` | - |
| `src/renderer/src/components/` | 组件 | ✅ `TitleBar.tsx` / `Versions.tsx` | Task 4+ 任务列表 / 添加 / 设置 |
| `resources/bin/` | 内置二进制 | ✅ Task 9 起为**真三引擎**(`aria2c` 1.37.0 / `yt-dlp` 2026.06.09 / `ffmpeg` 8.1.2) | `.exe` 不入库(`.gitignore`),来源 URL + SHA256 记于 `resources/bin/README.md` |
| `scripts/` | 构建脚本 | ✅ `run-node-tests.mjs` | **v0.4 Task 2 加 `build-extension.mjs`**(扩展构建链:esbuild bundle → 从 `package.json` 注版本 → 拷图标 → 打 zip → 派生并打印扩展 ID)+ `extensionVersion.mjs`(版本校验纯函数,非法版本**报错退出、绝不裁剪**) |
| `extension/` | **浏览器扩展(MV3)** | ✅ **v0.4 Task 2 落地**(工程地基,**无业务功能**) | **DownLord 的第二个可分发工件** —— 与 `src/` 平级、**独立构建链**(esbuild,不经 electron-vite),产物 `extension/dist/` 为可加载解压目录,经 `extraResources` 落安装态 `<resources>/extension`(**源码与 dist 均不进 asar**)。源 `manifest.json` **故意不含 `version`**(构建时注入,免手抄漂移)。<br>**① 适配层约束**:`chrome.*` **只准出现在 `extension/src/adapter/chromeAdapter.ts` 一个文件**,sw / popup / model 一律经 `BrowserAdapter` 接口**运行时注入**取用;由 eslint `no-restricted-globals` 对 `extension/src/**` 生效、仅对 `chromeAdapter.ts` 开例外 —— **越界即 lint 红,不靠自觉**。<br>**② 契约单向穿透**:扩展**只能 `import type`** 主仓 `src/shared/extensionProtocol.ts`,**禁值导入、禁碰 `ipc.ts`**(后者是主进程↔渲染进程的 IPC,与扩展无关);由 eslint `no-restricted-imports` 钉死。`import type` 编译后消失 → 耦合只停在类型层、**零运行时**,Electron 代码不会被 bundle 进扩展。<br>**③ Firefox 扩展本版不做**：保留 `BrowserAdapter` 适配边界，不把预留口当作支持承诺。适配层能隔离命名空间（`chrome.*` / `browser.*`）、Promise / 回调和能力差异，**不能消除 manifest 的独立差异**（Firefox MV3 事件页 `background.scripts`、`browser_specific_settings.gecko.id` 及 `moz-extension://<uuid>` 身份）。这些是技术边界，不是“只改这一层”或下一版交付承诺；当前不新增 Firefox target 或 manifest 变体。<br>**④ 权限最小化可核验**:`permissions` 按「权限增长表」逐 Task 增(Task 2 仅 `storage`),产物断言用**全等**而非 `includes` —— 悄悄多要一个权限当场变红。<br>**工程沿革**：Task 3 本地通道 + 配对 / Task 4 下载接管 / Task 5 网页嗅探 / Task 6 取 Cookie；**Firefox 扩展本版不做**，不影响 Firefox 直接读取 Cookie 的既有路径。 |
| `tests/setup/` | 测试环境 | ✅ `jsdom.ts` | - |
| `build/` | 打包资源 | ✅ 图标(icon.ico / icon.png / icon.icns) | - |

---

# 3. 数据模型(✅ schema 定稿 · Task 3 · 2026-06-23)

SQLite 持久化,**存真实下载历史(源数据)**——见 §7.3。

## 3.1 `tasks` — 统一任务 / 历史

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                -- 内部任务 id(UUID 或时间戳+随机)
  kind TEXT NOT NULL,                  -- 'http' | 'video' | 'torrent'(torrent 自 v0.3 Task 1 · schema v3)
  source TEXT NOT NULL,                -- 原始 URL / 磁力链接(真实历史源数据)
  status TEXT NOT NULL,                -- TaskStatus 枚举(8 态)
  filename TEXT NOT NULL,              -- 最终文件名(含扩展名)
  savePath TEXT NOT NULL,              -- 完整保存路径(绝对路径)
  category TEXT,                       -- 'video'|'audio'|'archive'|'document'|'program'|'other'(Task 6 驱动)
  totalBytes INTEGER DEFAULT 0,        -- 文件总大小(字节),0=未知
  downloadedBytes INTEGER DEFAULT 0,   -- 已下载字节(仅关键节点写,非实时)
  videoMeta TEXT,                      -- JSON:{ title, selectedFormat, postProcess, playlistIndex, qualityLabel? }(视频用)
  torrentMeta TEXT,                    -- JSON:{ name, infoHash, files[] }(torrent 用,v0.3 Task 1;http/video 恒 null)
  error TEXT,                          -- 错误信息(error 态)
  createdAt INTEGER NOT NULL,          -- 创建时间戳(ms)
  startedAt INTEGER,                   -- 首次开始下载时间戳(downloading 首次进入)
  completedAt INTEGER,                 -- 完成时间戳(completed 态)
  CHECK(kind IN ('http', 'video', 'torrent')),
  CHECK(status IN ('resolving','awaiting_selection','queued','downloading','paused','processing','completed','error'))
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_createdAt ON tasks(createdAt DESC);
```

- **运行时**字段(`gid` aria2 句柄、瞬时 `speed`)只在内存,不落库(见 §4)。**（✅ v0.3 Task 2 单任务 `limitKBps` + Task 3 BT 富进度 `seeding` / `uploadSpeed` / `uploadLength` / `numSeeders` / `connections` 亦为运行时内存态,经 `TaskProgress` 广播合并进渲染层 task、**绝不落库**(§4 / §7.3);做种「做种中」表示走 runtime,持久化仍 `completed`——**不新增 status、不改 `CHECK`、无迁移**。）**
- `torrentMeta`:JSON 字符串,**v0.3 Task 1 驱动**(承载 `name` / `infoHash` / `files[]`;元数据完成 + 文件选择定型时写);http / video 任务为 NULL。**做种 / 富进度不写此列**(runtime,§4)。
- `downloadedBytes`:仅关键节点写(started/paused/completed),**非实时**(实时进度只在内存)。
- `videoMeta`:JSON 字符串,**Task 5 驱动**(承载 title / selectedFormat / postProcess / playlistIndex);http 任务为 NULL。**Task 8.5 增可选 `qualityLabel`**(友好清晰度标签:仅音频 MP3 / `${height}P` / `≤${cap}P` / 最高,`qualityLabelOf` 纯函数算,`applySelection` / `submitBatch` 填;可选 → 存量行 / 待选占位 meta 无此字段向后兼容)。
- `category`:**Task 6 驱动**——`TaskManager` 创建 / 定型任务时按文件扩展名经纯函数 `categorize` 判定写入(`'video'|'audio'|'archive'|'document'|'program'|'other'`);视频任务按**最终输出容器**判定(mp4→video / 仅音频 mp3→audio),`other` / 未命中 → 默认下载目录兜底;视频前置态(resolving / awaiting_selection,无 filename)为 NULL,选定格式 / 完成校正时才写入。
- 状态机 `status`(8 态):`resolving` → `awaiting_selection` → `queued` → `downloading` ⇄ `paused` →(仅视频)`processing` → `completed`;任意 → `error`(可重试)。**视频三态(`resolving` / `awaiting_selection` / `processing`)Task 5 起真正驱动(Task 3 仅枚举预留)。**（✅ **v0.3 Task 1 / 2** torrent 复用 `resolving`(取种子元数据)+ `awaiting_selection`(**多文件种子待选文件**;单文件豁免直下)——**零新状态机边**:磁力元数据完成经引擎 `torrentInfo` 回报 `files[]`,`onTorrentInfo` 按数量分流〔`>1` → `awaiting_selection` 弹 `BtFileDialog`,`≤1` → `queued`〕;用户勾选经 `torrent:applySelection` → `applyTorrentSelection` 定型 `torrentMeta.files[].selected` + 落既有 JSON 列〔**零 schema / DAO 改动**,§7.3〕→ `selectFileArg(files)` 映射 aria2 原生 `--select-file`〔全选 → `null` 省略 = 整包零回归〕→ `queued → dequeue → downloading`;续传仍归 aria2 `.aria2`〔§7.4〕。渲染层 `BtFileDialog` 纯 UI〔直取 `task.torrentMeta.files`,不经 `getResolved`;落点 / 映射 / 定型全在主进程,§7.2〕。)
- **历史检索 / 统计(✅ v0.2 Task 5)**:本表即「完整下载历史」,历史页经 `taskDao.searchHistory`(`filename` / `source` LIKE + 状态 / 类别 / `createdAt` 范围过滤)/ `historyStats`(按类别 `GROUP BY` + 时间窗口聚合,仅 `completed` 计入、按 `completedAt`)**只读检索 / 统计**——纯 SELECT / GROUP BY、**零 INSERT / UPDATE / DELETE**,复用既有三索引(`status` / `category` / `createdAt`)**不新增**;`LIKE %x%` 前置通配走全表扫描,个人下载器量级 + `LIMIT 500` 兜底可接受(见 §4「历史检索」/ §7.3 只读)。

## 3.2 `categories` — 文件类别配置

```sql
CREATE TABLE categories (
  key TEXT PRIMARY KEY,                -- 'video'|'audio'|'archive'|...
  displayName TEXT NOT NULL,           -- 显示名称
  extensions TEXT NOT NULL,            -- JSON 数组:["mp4","mkv",...]
  savePath TEXT NOT NULL               -- 保存目录:空串 ''=跟随默认目录子目录 / 非空=自定义绝对路径覆盖(Task 8.5 语义)
);
```

一处定义,两处复用:① 列表类型筛选(取 `displayName`);② 下载按类别归类保存(IDM 式,运行时由 `resolveCategoryDir` 解析目录)。**Task 6 落地 + Task 8.5 改语义**:默认 6 类(视频 / 音频 / 压缩包 / 文档 / 程序 / 其他〔兜底用默认位置〕)经**应用启动期幂等 seed** 写入(`seedDefaultCategories`:空表才插、非空跳过绝不覆盖用户已改配置)。**`savePath` 语义(Task 8.5 单一真相)**:`''`(空串)=跟随默认目录子目录(运行时 `resolveCategoryDir` = `join(defaultDir, categorySubdir(key))`,`other` / 未知 key → `defaultDir`)/ 非空=自定义绝对路径覆盖;`seedDefaultCategories` 恒写 `''`(「跟随」干净初值,改默认目录即实时跟随、无需同步,§4)。初版扩展名清单见 `src/main/category/categoryModel.ts` 的 `DEFAULT_CATEGORIES`。`icon` **不落库**,按 key 在渲染层映射(`categoryView`,与 `TaskRow` 图标同源);**表结构零变更**,Task 8.5 新增 **v2 数据迁移**(`UPDATE categories SET savePath=''`:重置存量「绝对路径烤死」为「跟随」语义,§3.3;§7.3 合规——只动 `categories` 派生配置、零触碰 `tasks` 源数据)。Task 3 只建表,Task 6 驱动数据 + 逻辑,Task 8.5 重构 `savePath` 语义。

## 3.3 `schema_version` — 迁移框架

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,         -- 迁移版本号
  appliedAt INTEGER NOT NULL           -- 迁移应用时间戳(ms)
);
```

当前版本 `version = 4`(源码真值:`src/main/db/migration.ts` 的 **`LATEST_MIGRATION_VERSION`**,由 `migrations` 数组 `reduce` 取最大版本号自动派生——**不存在 `SCHEMA_VERSION` 常量**,`schema.ts` 只导出建表 DDL;v1 = Task 3 初始 schema 建表;**v2 = Task 8.5 纯数据迁移** `UPDATE categories SET savePath=''`,重置 `savePath` 语义,不改表结构;**v3 = v0.3 Task 1** `kind` 加 `'torrent'` + 新增 `torrentMeta` 列——SQLite 无法原地改 `CHECK`,故**事务内重建 `tasks` 表**〔迁移**前主动备份** + 显式列名 INSERT 杜绝列序错位 + 迁移后逐字段零丢失断言,`torrentMeta` 缺省 NULL;`status` CHECK 8 态原样,§7.3〕;**v4 = v0.3 Task 4** `CREATE INDEX idx_tasks_source ON tasks(source)`——供查重按来源命中(`taskDao.findBySource`),**只加索引、零数据触碰**〔无 INSERT / UPDATE / DELETE,不改表结构 / 不动 `kind`·`status` CHECK;索引是**纯派生结构**(可随时重建,与 `tasks` 行的不可重建性相对),仍走单事务 + `schema_version` 记录 + 迁移前主动备份 + 迁移后**逐行 `deepEqual` 字节级零变化**断言,§7.3〕;§3.2 / §7.3)。启动时读取最大版本,与迁移数组比对,执行缺失迁移(事务内);全新库 v1 建表(即新 `CHECK` + `torrentMeta`)→ v2 空表 no-op → v3 fresh 跳过 → v4 建 `source` 索引(fresh / 存量同建),存量库按缺失版本顺序补迁。**v0.3 Task 3 BT 做种 / 富进度零 schema 改动**——做种配置落 `settings.json`、seeding 走 runtime、富进度不落库,`tasks` 表 / migration 均不动。

## 3.4 设置 / 配置(✅ Task 8 敲定 · DB + `config/*.json` 混合)

**持久化方案敲定为「DB + `config/*.json` 混合」**:源数据 / 结构化多行入 SQLite;app 级标量配置入 `<userData>/config/*.json`。**理由**:源数据需事务 / 查询 / 与续传归属绑定;标量配置轻、变更频繁、无需 schema 迁移,直接复用 Task 7 `proxyStore` 的「原子写 + 损坏回退重写」成熟模式即可。

| 配置 | 落点 | 服务 | Task |
|---|---|---|---|
| 任务 / 历史 | SQLite `tasks` 表 | `TaskManager` / `taskDao` | 3 |
| 文件类别(displayName / extensions / savePath) | SQLite `categories` 表 | `categoryDao` | 6 |
| 代理三档(mode / manualUrl) | `<userData>/config/proxy.json` | `ProxyService` | 7 |
| 通用设置(defaultDir / maxConcurrent / video / themeMode / clipboardWatch / autoUpdateYtDlp / autoUpdateApp) | `<userData>/config/settings.json` | `SettingsService` | 8 / v0.2 |
| 更新节流缓存(lastYtDlpCheckAt / lastYtDlpLatest / lastAppCheckAt / lastAppLatest) | `<userData>/config/updateState.json` | `updateStateStore`(v0.2 Task 6) | 6 |
| tracker 表缓存(updatedAt / sourceUrls / trackers) | `<userData>/config/btTrackers.json` | `btTrackerStore`(v0.4 Task 1;**派生缓存非源数据**,可从公开源重建) | v0.4 T1 |
| 扩展本地通道(enabled / port / token) | `<userData>/config/extensionChannel.json` | `channelConfig` + `ExtensionChannelService`(v0.4 Task 3) | v0.4 T3 |

- ★ **五份 json 的读写机制自 v0.4 Task 3 起收敛到唯一权威 `src/main/config/jsonConfigStore.ts`**(此前是四份**手写同形**的 store,原 2026-07-11 审计只记了两份、触发条件早在 v0.4 Task 1 就已达成而无人回头核对)。原子写路径(`mkdir(dirname)` → 写 `<path>.tmp` → `rename`,`JSON.stringify(v,null,2)` 无尾换行)**逐字节相同**,差异**恰好只在三个轴**:`repairOnInvalid` / `normalize` / `cloneDefaults`(见 §2.2 `src/main/config/` 行)。迁移守三条纪律:**导出名与签名逐字不变**(五个调用点零改动)、**既有 521 行单测一字不改**(它们是迁移唯一的回归护栏)、**写出字节逐字相同**(泛型自带字节级调用序列断言)。
- **扩展本地通道配置(✅ v0.4 Task 3 落地)**:`<userData>/config/extensionChannel.json`,**键集合恰好 `enabled` / `port` / `token`**(有单测断言 —— 防日后有人把 `lastHandshakeAt` 顺手塞进来)。**连接状态是运行时态、故意不落库**:`lastActiveAt` 只在内存,重启回落「未配对」是设计而非缺陷。`repairOnInvalid: **false**` + **自己保障 token**(读回后 token 非 64 hex 才生成并**一次**写回)—— 用 `true` 会先写一份 `token:''` 的默认再写一次带 token 的,首次运行白写两遍。token 生成**不以「用户已启用通道」为条件**,否则设置页打开时配对码是空的;它**绝不进 `settings.json`**(那是全量回显包、被多处消费,混进去等于把密钥散播到渲染层每个消费点,§7.6)。**服务默认关**(`enabled: false`)—— 不装扩展的用户不该白开一个监听端口。

- **SettingsService(✅ Task 8 落地)**:`<userData>/config/settings.json` 存 `AppSettings`(`{ defaultDir, maxConcurrent, video, themeMode }`),收纳此前**未持久化**(themeMode)/ **硬编码**(maxConcurrent / defaultDir)/ **占位**(video)的四项标量配置。复用 Task 7 `proxyStore` 成熟模式:**原子写**(tmp→rename,先 mkdir 父目录)+ 缺失 / JSON 损坏 / 结构非法 → 回退 `DEFAULT_APP_SETTINGS` 并**重写修复**(非源下载数据,可安全重建,符合 §7.3「不静默丢弃」精神;修复写失败也不崩、仍返回默认)。`init()` 读盘缓存 + 空 `defaultDir` 解析为系统下载目录;`get()` 同步取副本(供 `getVideoPrefs` 注入回调实时读);`set(patch)` 合并校验(`mergeSettings`:仅接受已知键 / maxConcurrent 取整 clamp `[1,10]` / themeMode 守卫 / defaultHeight 白名单 `{null,480,720,1080,2160}` / defaultAudioOnly 布尔)→ 原子写 → `onChange` 联动 → 回 clamp 后最新全量。
- **联动即时生效**:`index.ts` 的 `onChange` 闭包调 `TaskManager.setMaxConcurrent`(调大即 `dequeueNext` 出队补足 / 调小不中断运行中)/ `setDefaultDir`(后续新任务兜底,已存不回迁,§7.4)/ `nativeTheme.themeSource`(主题即时,触发 `theme:changed` 回流);视频偏好经 `getVideoPrefs: () => settingsService.get().video` **每次解析实时读**(无需 onChange 推送)。主题持久化只**叠加**(启动 `nativeTheme.themeSource = settings.themeMode` + `setTheme` 内 `setSettings({themeMode})`),不改 Task 1 的 `theme:set`;双路径设同值幂等。**校验 / 持久化 / 联动全在主进程 SettingsService**,渲染层 `SettingsPage` 纯 UI 经 `settings:get/set`(§7.2)。
- **代理配置(✅ Task 7 落地 · `config/*.json` 路线先行实例)**:持久化到 `<userData>/config/proxy.json`(内容即 `ProxyConfig`:`{ mode, manualUrl }`);原子写(临时文件 + rename),缺失 / 损坏 → 回退 `DEFAULT_PROXY_CONFIG` 并**重写修复**(非源下载数据,可安全重建,符合 §7 数据安全精神)。Task 8 敲定混合方案后 **proxy.json 与 settings.json 各自服务自包含、不并入**(`ProxyService` / `SettingsService` 各持一份 json、共用同款 store 模式),非合表。
- **更新节流缓存(✅ v0.2 Task 6 落地)**:`<userData>/config/updateState.json`(`{ lastYtDlpCheckAt, lastYtDlpLatest, lastAppCheckAt, lastAppLatest }`)。**非用户配置、非源数据**,是运行态节流缓存——避免频繁查 GitHub 触发 60 req/h 限流(后台自动检查每 24h 至多一次;手动「检查更新」无视节流)。与 `settings.json` **语义分离**(不污染用户设置回显);复用同款原子写模式,损坏 / 缺失 → 回退默认(可安全重建,派生缓存非源数据,符合 §7.3 精神)。两自动开关本身(`autoUpdateYtDlp` / `autoUpdateApp`,默认 `true`)仍归 `settings.json`。

---

# 4. 服务层约定(✅ 已确立 · 双执行器 Task 5 落地)

- **双执行器后端(✅ Task 5 落地)**:直链走 `DownloadEngine`(aria2),视频走 **yt-dlp 后端**(`VideoResolver` 解析 + `VideoEngine` 每任务一进程下载,合并 / 音频提取交 yt-dlp 内部 ffmpeg via `--ffmpeg-location`,MediaTool 退化);两后端经 `CompositeDownloadEngine`(实现 `TaskEngine`,按 `AddUriInput.video` 分支路由)对 **TaskManager 透明**——上层只见归一的 Task。yt-dlp 内部挂 aria2c 分片加速(`--downloader`)**✅ v0.2 Task 2 落地**(见下「下载限速 + aria2c 加速」条),v0.1 不实现。
- **下载限速 + aria2c 加速(✅ v0.2 Task 2 落地)**:两项均**经引擎原生参数**(纯函数组装 argv / RPC 选项),不自研下载协议、**不改 SQLite schema**、**全程不读写 `.aria2`**(§7.4),沿既有注入缝扩展。
  - **限速(对标 proxy + maxConcurrent 双通道;✅ v1.0 语义修订)**:内部统一存 `KB/s`(`0`=不限)。**全局限速 = 每个「跟随全局」任务各自的上限**(aria2 `max-download-limit` 的全局默认值),**不是总带宽上限**:N 个跟随任务并发时总量可达 N × 全局值,文案如实说、不承诺总量(修订前 aria2 侧用 `max-overall-download-limit` 总量硬上限,单任务 0 / N 永远突破不了它,与视频引擎的每任务语义矛盾,2026-09-17 归一)。双通道——① **push(即时改运行中)**:`SettingsPage → setSettings → SettingsService.onChange → downloadEngine.setGlobalLimit(kbps)` → `rpcClient.changeGlobalOption({'max-download-limit'})`(**只对此后新任务生效**,2026-09-17 裸跑探针实证)+ **逐任务 `changeOption` 追补跟随者**(只发给 `limitKBps === undefined`、gid 在 `gidToId` 中、非 completed / error 的任务;覆盖任务不动;每条单独 try/catch,失败只记日志),不重启进程;② **pull(启动 / 崩溃重启初值)**:`buildAria2Args` 带 `--max-download-limit` 启动初值(字段名沿用 settings 键 `maxOverallLimitKBps`,不改名)+ `startAria2Internal` 成功后 `getSpeedLimit()` re-apply(崩溃重启自动带当前值;此时 `gidToId` 已清空,追补全部跳过,重提的新 gid 继承全局默认)。**单任务限速三态**:`task:setLimit → TaskManager.setTaskLimit(经 taskIdToEngineId 转引擎)→ CompositeEngine 按 id 路由 → aria2 `changeOption(gid,{'max-download-limit'})` 即时生效`;`null`(跟随全局)下发**当前全局值**(不是 0)、`0` 真不限、`N` 可大于全局;**任务级优先于全局**,**不落库**(`InternalTask.limitKBps` 仅内存,运行时瞬时态,重启回归全局,§7.3);同一进程内的**崩溃重提 / followedBy 转移后对覆盖任务在新 gid 上补发一次**(走 `changeOption`,失败不置 error)。**视频侧(v1.0 一字不动)**:yt-dlp 每任务一进程无常驻 RPC,全局 / 单任务限速经 `getSpeedLimit` 注入 `VideoEngine`,**每次 spawnFor(新任务 / resume / 崩溃恢复)实时读** `rec.limitKBps ?? 全局值`(本就是每任务上限语义)、运行中进程不改速(诚实语义:视频限速「下次继续」生效)。限速传导按「是否挂 aria2c」二分支(`toYtdlpDownloaderArgs`):挂 → `--downloader-args aria2c:… --max-download-limit=`;未挂 → `--limit-rate`。
  - **aria2c 加速(可开关 + 健壮回退)**:`useAria2cForVideo` 持久化 `settings.json`(默认开)。装配期注入 `getVideoAccel = () => ({ enabled: useAria2cForVideo && existsSync(aria2cPath), aria2cPath })`——开关 && 内置 aria2c 存在才挂 `--downloader <绝对路径>`(定位契合 `--ffmpeg-location` 先例,不污染子进程 env)。**三层回退**:① 预探测 gate(二进制缺失 → 不挂,零风险);② 运行时回退(挂 aria2c 的进程非主动 kill 的非零退出 → 置 `accelFallbackTried`、**用自带下载器分支重起一次**、回退期间保持 `downloading` 不闪 error,限速自动改用 `--limit-rate`);③ 二次(自带下载器)仍失败才真 `error`。回退经 `log.warn` 可见、状态不误导(§7.1 崩溃隔离精神)。**不精细解析 aria2c 错误内容**——带 aria2c 的失败一律回退一次,最简健壮。
- **视频 Cookie 登录 + 字幕(✅ v0.2 Task 1 落地)**:两项均**经 yt-dlp CLI 参数**实现、不自研解密 / 解析,沿 v0.1 既有注入缝扩展、**不新增架构机制、不改 SQLite schema**。
  - **Cookie(与 proxy 完全对称:全局、实时、解析 + 下载都注入)**:三态 `none`(默认,零附加 → 与 v0.1 逐字节等价)/ `browser`(`--cookies-from-browser <browser[:profile]>`)/ `file`(`--cookies <path>`);纯函数 `toYtdlpCookieArgs` 只组装不碰 fs / 网络;经**注入式回调** `getCookie = () => settingsService.get().video.cookie ?? DEFAULT_COOKIE_CONFIG`(`index.ts` 装配)在每次 `VideoResolver.resolve`(`-J` 解析)/ `VideoEngine.spawnFor`(下载,含 resume 重起)前**实时取**,切档对后续新任务即时生效。**持久化只存来源选择**(`settings.json` 的 `video.cookie`:source / browser / file 路径),**绝不存 cookie 内容本身**——cookie 值始终由 yt-dlp 运行时从浏览器 / 文件即时读取(§7.6 合规)。失败(Chrome/Edge ABE / DPAPI / 浏览器占用 / 文件非法)由 `mapError` 在 login 判定**前**优先分流为 `COOKIE_BROWSER_FAILED` / `COOKIE_FILE_INVALID` 诚实回退,不静默、不误导网络 / 代理。
  - **字幕(与 selectedFormat 同构:任务级、随 `videoMeta` 持久化、出队 / 恢复重建)**:解析阶段 `parseSubtitleTracks` 从 `-J` 的 `subtitles`(人工)+ `automatic_captions`(自动)合并去重回填 `ResolvedVideo.subtitles`;下载阶段用户选择归一为 `SubtitleChoice`(langs / format srt·vtt / includeAuto),`toYtdlpSubtitleArgs` 映射 `--write-subs [--write-auto-subs] --sub-langs … --sub-format …/best --convert-subs …`(转格式复用内置 ffmpeg)。选择随 `videoMeta.subtitle`(既有 JSON 列)持久化 → `rebuildVideoSubmit` 出队 / 重启恢复时重建 `VideoSubmit.subtitles` → 下载 args 逐字节一致。字幕作**附属产物**旁挂视频(同 `dir` 同类别),文件名经 `outputBase`(sanitizeBasename)+ `--windows-filenames` 双保险清洗(§7.7)。**空 langs / 存量任务 / 无选择 → 零附加,与 v0.1 逐字节等价**(§7.4 续传不变)。
- **检测重复下载(✅ v0.2 Task 3 落地)**:三创建路径在「目标落点(含清晰度)精确已知」时刻**主进程查重**——直链 http 在 `addTask` 的 `routeForFilename` 后 / `insertTask` 前;视频单条在 `applySelection`(用户 FormatDialog 选 / 默认清晰度自动选)算出 `标题 [清晰度].ext` 后;批量在 `submitBatch` 循环内逐条。判据纯函数 `detectConflict`(`duplicateDetect.ts`,**只读**注入 `this.tasks` 值集 + `existsSync`/`readDir`,**零 DB 查询 / 零索引 / 零 schema 改动**):「同源 URL + 同目录 + 同 `stem`(视频含 `[1080p]` 标签,忽略 ext 差异)」查历史 + 磁盘,命中态 `completed`(记录 + 文件在)> `diskOnly`(仅磁盘)> `active`(非终态,已在列表)。命中 → **parked**(http 存待插 `Task` 不落库 / 视频复用既有 `awaiting_selection` 态 / 批量父占位聚合,**均内存瞬时不新增 status**)+ 经 `onDuplicate` 订阅广播 `task:duplicate` → 渲染层 `DuplicateDialog` 四决策 → `duplicate:resolve` 落地:**覆盖**先 `trashItem` 旧文件入回收站再正常重下(**不用 `--force-overwrites`**,保 `--continue` 续传语义,§7.4)/ **跳过** 丢弃 / **重命名** `nextAvailableStem` 序号 `(1)` 双留 / **已存在** 渲染层 `openPath` / `showItemInFolder`。**0B 假完成从源头消解**(查重拦截同名重下)+ `parseYtDlpLine` 识别 `has already been downloaded` 行兜底(destination → `close` statSize 校正真实大小 / 路径,残留 skip 场景也不再 0B)。**savePath 落点不因查重改变**(仍走 §4「Category 判定」的 `routeForFilename`);**覆盖** = trash 旧文件 + **移除被覆盖的旧完成记录**(`removeTask(deleteFile:false)` 仅移记录、文件回收站可恢复,消除同路径「两条完成记录」僵尸重复,2026-07-12 手测反馈)+ 新建;**重命名**双留(旧记录保留 + 新名新记录)。语义 URL 等价不做(`youtu.be` ↔ `watch?v=` 视为不同,honest);**历史极大时的 `source` 索引 ✅ v0.3 Task 4 落地**(migration v4 `idx_tasks_source` + `taskDao.findBySource`,查重候选集从「全量内存拷贝」缩到「同源命中」;每行再以 `this.tasks.get(row.id) ?? row` 取最新 runtime 态,`active` / `completed` 判定与内存扫描等价,§3.3 / §7.3)。
- **BT / 磁力执行路径(✅ v0.3 Task 1 / 2 落地)**:**全走 aria2 原生 BitTorrent**——**不自研 BT / DHT / tracker / 分片协议**(§6.1 / §7.1),BT 复用直链 `DownloadEngine`(同一 aria2 守护进程 + 同一 RPC 客户端)对 `TaskManager` 透明,**不新增执行器**。
  - **两条提交入口**:magnet → `rpcClient.addUri([magnet], btOptions)`;`.torrent` → `rpcClient.addTorrent(base64, [], btOptions)`(`btOptions.toBase64` 纯函数编码,`.torrent` 内容仅内存 + `<userData>/torrents/<taskId>.torrent` 托管副本,崩溃重提用)。任务级选项由纯函数 `buildBtOptions` 组装(`src/main/engine/btOptions.ts`,与 `dir` / `all-proxy` / `out` 同层,**不改 aria2 启动参数**):恒含 `dir`(= `torrentSaveDir(defaultDir)` = `<defaultDir>/Torrents`)/ `follow-torrent='true'` / 做种档 / `bt-save-metadata='true'`;按需叠加 `select-file`(⊕ `bt-remove-unselected-file`)/ `pause-metadata` / `pause`。
  - **元数据阶段(两段 gid 转移)**:磁力先由 aria2 下**元数据**(metaGid),完成后 aria2 自身跟进真实下载并在 `tellStatus` 的 **`followedBy`** 给出新 gid;`DownloadEngine` 在轮询的离场分支识别 `followedBy` 完成 **gid 转移 + `gidToId` 重绑**(不是走 `checkFinalStatus` 的完成路径)。此期间 status 复用 `resolving`、**`totalBytes` 不落库**(数值不可信)。`BT_STATUS_KEYS = [...PROGRESS_KEYS, 'following', 'followedBy', 'infoHash', 'bittorrent', 'files']`(DownLord 侧只读 aria2 原生返回,不自研种子解析)。
  - **文件选择**:元数据完成回报 `files[]` → `onTorrentInfo` 按数量分流(`>1` → `awaiting_selection`;`≤1` → 直接 `queued`,单文件豁免);多文件用 `pause-metadata`(磁力)/ `pause`(`.torrent`)让 aria2 停在暂停态待选,选定后 `changeOption(select-file)` + `unpause` 继续——**不用 `bt-metadata-only`**(那会只取元数据即停,与「选后继续下选中」冲突)。`selectFileArg` 纯函数把勾选映射为 1-based 压缩区间串(`"1,3-5,7"`),**全选 → `null` 省略参数 = 整包,与 Task 1 逐字节等价**。
  - **连通性配置(2026-07-22 / 07-25 真机修订)**:`buildAria2Args` 的 BT 引导段(`--enable-dht` / `--dht-entry-point` / `--enable-dht6` / `--dht-entry-point6` / 内置 47 条 `--bt-tracker` 静态快照 / 固定端口 `--listen-port=52301-52310`·`--dht-listen-port=52311-52320` / tracker 10s 快速轮询 / `--peer-agent=Transmission/3.00` 伪装 / `--bt-max-peers=128`)+ `--dht-file-path`·`--dht-file-path6`(`<userData>/dht.dat`·`dht6.dat` 路由表持久化)。**这些参数只对 BT 任务生效,http / video 下载零影响(零回归)**。**诚实缺口(v0.3 当时)**:UPnP / NAT-PMP 自动端口映射与 tracker 表应用内自动更新**均未做**——NAT 后仍可能不可入站、tracker 快照会随时间衰减;v0.4 的处置见 §7.6。
  - **落点与查重**:BT 统一落 `<defaultDir>/Torrents`(种子按 `info.name` 自建子文件夹)、category 恒 `'other'`,**不经 `routeForFilename` 扩展名路由**;**torrent 不接查重**(与 `DuplicateDialog` 天然不撞车)。`.torrent` 托管副本在完成时按种子名更名伴生、**随内容命运一并删除**;`.aria2` 控制文件完成即由 aria2 清理(§7.4)。
- **BT 做种 + 富进度(✅ v0.3 Task 3 落地)**:**经 aria2 原生做种能力**实现、**不自研 P2P / P2SP**,沿既有注入缝扩展、**不改 SQLite schema**、续传仍归 `.aria2`(§7.4)。**做种默认关**(下载完即停):`btOptions.ts` 原硬编码 `'seed-time':'0'` 改为经**注入式回调** `getSeedConfig`(完全复刻 `getSpeedLimit` 范式,pull 实时读 `settings.json`)——关档恒 `seed-time=0`(逐字节等价现状),开档注入 `seed-ratio` ⊕ `seed-time`(任一先达即停)⊕ `bt-max-peers`(0=跟随全局 128)。**做种表示走 runtime**:字节 100% 落盘即持久化 `completed`,`seeding` 由引擎派生(`isTorrent && 已下≥总>0 && rawStatus==='active' && 做种开档`),经 `TaskProgress` 广播,渲染层「已 completed + seeding」渲染做种变体——**不新增持久化 status、不改 `CHECK`、无迁移**(§7.3)。**单任务「停止做种」**:`torrent:stopSeeding → TaskManager.stopSeeding`(校验「torrent + 做种中」)→ `DownloadEngine.stopSeeding` = `rpcClient.forcePause(gid)` + 解绑 `gidToId`(**保留文件 + `.aria2`,不删磁盘**,任务留静止 `completed`);**只对已完成 + 做种中生效**,护栏杜绝误伤下载中续传。**富进度**(`numSeeders / uploadSpeed / uploadLength / connections`):`connections` 对所有任务透传(0 速可观测「已连接 N 节点」/「正在寻找节点」),其余仅 torrent 透传;分享率 `computeShareRatio` 渲染层现算不进 payload;**全为运行时瞬时量,仅内存 + IPC 推 UI,绝不落库**(§4 / §7.3)。**合规诚实**(§7.6 / PRD §7):全链路无「加速他人 / 私有网络 / 保证上传 / P2SP」;做种自愿、能否连上取决于网络。
- **浏览器扩展本地通道(✅ v0.4 Task 3 落地)**:**经 Node 原生 `http` 起一个只绑 `127.0.0.1` 的服务**(与既有 aria2 RPC + `--rpc-secret` 同构),**不自研传输协议、不引第三方 web 框架、不改 SQLite schema**、**默认关**(不装扩展的用户不白开监听端口)。鉴权**三闸分层**:① token 走自定义请求头 `X-DownLord-Token`(**身份**,全等比较)② **拒绝一切 CORS 预检**——`OPTIONS` 一个跨源放行头都不回,网页 JS 由浏览器自己拦死,不靠我们判断 ③ `Origin` 前缀校验(**纵深而非主闸**,本机程序能任意伪造 Origin,那部分靠 token 挡);叠加**只作用于失败请求**的失败窗口限速。传输形态是 **JSON over POST 单端点**,按信封 `type` 分发(`channelDispatch.ts` 校验信封 + 协商 `protocolVersion`,**版本不等一律 409 拒绝、不尽力兼容**;分发表增删任何一行必 bump,v0.4 已 bump 到 `3`)。**只传意图,不传决策**——是否接管 / 落点 / 查重 / 分类全在主进程(§7.2)。**不上 WebSocket / SSE / 反向推送**:MV3 的 service worker 会空闲销毁,长连接不可靠;连接三态(未配对 / 已连接 / 待活动)由握手事件派生,**纯运行时不落库**。
- **浏览器下载接管(✅ v0.4 Task 4 落地)**:**经 `chrome.downloads` 原生拦截**实现、**不自研浏览器 hook / 不做 MITM 抓包**,沿既有 `addTask` 注入缝扩展、**零新增 `kind`、零 schema 改动**。链路 = 扩展 `onCreated` 拦截 → 上报意图 → 主进程 `decideTakeover` 四道判定 → **受理即回**(`{taken:true}` 当场返回,扩展才 `cancel()` 原生下载;等任务真建成再取消做不到——人类确认要多久不可知,而浏览器一直在写盘)→ 独立 `BrowserWindow` 小窗口确认 → **走既有 `addTask` 全链路**(分类路由 / 查重 / 引擎提交一条不旁路)。`headers` 只收 `referrer` / `userAgent` **两个语义字段**(协议层就没有任意 header map 的容身之处,§3),且为**运行时态不落库**——重启即丢,与 `limitKBps` 同构;接管配置落 `takeover.json`(§3.4),**不进 SQLite**。同域 **500ms 聚合**为列表态;**查重命中在同一小窗口内换既有 `DuplicateDialog`**(不另开窗、组件零改动)。**头号红线是绝不制造黑洞**(§7.6):四种拒绝(总开关 / 暂停中 / 例外表 / `danger`)走**同一条代码路径**、回**同一个 `{taken:false}`**,扩展据此放行浏览器原生下载;用户在确认框里主动点「取消」不算黑洞——前提是那句告知恒为真(实装说的是「**已请求**浏览器取消……若它此前已下完,文件可能已在浏览器下载目录里」)。
- **网页资源嗅探(✅ v0.4 Task 5 落地)**:**经 MV3 观察型 `chrome.webRequest`** 识别页面媒体请求(`onBeforeRequest` / `onHeadersReceived` 只读,**不阻塞、不改写、不注入 content script**),**不自研协议解析**、**零落库零 schema 迁移**。分片流**聚合成一条不是把分片拼起来**——是**把分片归属到它们的清单那一条**上(归属判据是**同一标签页**,不猜 URL 路径);自研分片拼接被 §6.1 堵死,m3u8 交给 yt-dlp 下。**popup 是唯一呈现处**:结果存 `storage.session`、**不经通道上行**、不落库、关浏览器即清;呈现范围是**本页**(当前标签页)不是本会话。**未被用户选中的资源从不离开浏览器** —— DownLord 只在用户点了某一条时才收到那一条,故左导航「浏览器扩展」页**没有资源列表、没有嗅探开关**(开关真源在扩展侧,通道无反向推送)。合规对冲三条:嗅探开关**默认 OFF**(被动监听按「剪贴板监控默认关」那把尺子)+ 只处理 `tabId >= 0` + **日志零 URL**(§7.6)。
- **扩展取 Cookie(✅ v0.4 Task 6 落地)**:**经 `chrome.cookies` 在浏览器内部读取**(这正是第四档存在的理由——`--cookies-from-browser` 在 Chrome / Edge 运行中时读不到),再经既有 yt-dlp `--cookies <file>` 参数喂进去,**不自研解密、不碰 ABE / DPAPI、不改 SQLite schema**、既有三档零回归。**两步是「点名—给予」而非索取**:扩展报 `video.intent` → DownLord 在**应答**里点名 `needCookieFor`(**≤2 项**)→ 扩展在下一次请求里以 `cookie.offer` 给予(**零回显**)。DownLord **从不主动索取**(本地通道无反向推送),故「用户直接粘 URL 且从未借过该站」拿不到 cookie 是**结构性的**、任何设计都堵不上,UI 与错误文案如实交代。收来的是**暂借登录态**:**只活在主进程内存 / 会话级**,不落盘、不落库、不写 settings、**连域名都不写日志**;同域再借整份覆盖不合并;精确快照(含空)优先,仅缺项时复用同端口 `www.X` / `X` 别名快照,实际快照去重最多 2 组、原 cookie.domain/value 不改写;不做通用父域回退(`a.github.io` 与 `b.github.io` 仍不互通)。喂给 yt-dlp 时落一个临时 `cookies.txt`,那是它的**一次性投影、不是真源** —— 锚在**一次 yt-dlp 进程**、进程退出即删,另有启动清扫兜底(§7.6)。**不加密落盘是刻意的**:持久化的登录态会静默腐坏,会话级免疫这一整类问题。
- **TaskManager 是唯一枢纽**:无论来源,最终都是同构 Task,状态 / 进度 / 持久化只写一套。
- **进度分层**:瞬时速度 / 已下字节高频变化,**仅内存 + IPC 推 UI,不落库**;仅状态关键节点(新建 / 开始 / 暂停 / 完成 / 失败)写库。
- **代理(✅ Task 7 落地)**:三档(跟随系统 / 手动 / 不用)。主进程 `ProxyService` 主动读系统代理(`session.resolveProxy`),经**注入式回调** `() => getResolved()` 在每次发起任务时取当前解析态注入——aria2 **任务级** `all-proxy` / yt-dlp `--proxy`(direct 与系统未读到 → **显式空串关闭**,杜绝继承环境 / 进程级代理),**切档对后续新任务即时生效**、运行中任务不变。分流交给 Clash(见 §7.6);配置持久化 `proxy.json`(§3.4);状态栏显真实档位 + 连通点(诚实文案)。
- **Category 判定(✅ Task 6 落地 · Task 8.5 改实时跟随)**:`TaskManager` 创建 / 定型任务时按文件扩展名经纯函数 `categorize` 映射到 category,决定 savePath(`resolveCategoryDir`),同时供列表筛选。**直链 / 视频共用同一 `categorize`**(双执行器透明);视频任务按**最终输出容器**判定(mp4→video / 仅音频 mp3→audio);用户**显式指定目录优先**,`other` / 未命中 → 默认下载目录兜底;提交引擎前 `ensureDir` 自动建目录(失败 → 任务 error、可重试)。重启恢复用已落库 savePath / category,**不重路由**(§7.4)。列表筛选**状态 × 类别正交**(左导航状态维 × 顶部 chips 类别维独立组合,左导航计数不受 chips 影响)。`updateCategory` 改配置后刷新缓存,**后续任务用新配置、已存不回迁**。
- **保存位置「诚实归类」(✅ Task 8.5 落地)**:`resolveCategoryDir(key, categories, defaultDir)` 改**实时计算**——`savePath` 非空=自定义覆盖,空=跟随 `join(defaultDir, categorySubdir(key))`(`other` / 未知 key → `defaultDir`)。`setDefaultDir(dir)` 仅更新 `this.defaultDir`,未自定义类别下一次路由即按新默认目录跟随,**无需任何「同步」步骤 / 写库 / 刷缓存**(取代并移除 Task 8 临时的「分类目录智能同步」C2 回调)。`category:list` 投影**复用同一 `resolveCategoryDir`** 下发解析后真实目录 + `isCustom`,与路由落盘**同源同值**;添加 / 格式对话框经渲染层纯函数 `saveLocationView`(`previewDir` 镜像主进程 `explicitDirOf`,目录字符串全部来自 `category:list`、**渲染层不拼 `join`、不算 savePath**,§7.2)显示「所见即所存」落点。改默认目录 / 类别目录 / extensions 均**只影响后续新任务、不回迁**已存任务(§7.4)。
- **剪贴板监控(✅ v0.2 Task 4 落地)**:主进程 `ClipboardWatcher` 服务(`src/main/clipboard/`)——Electron **无剪贴板变化事件**,故定时(默认 1000ms)`clipboard.readText()` 与上次值比对。**依赖全注入、核心决策纯函数**(`decideClipboard` / `classifyClipboardText` / `normalizeClipboardText`):整段(trim 后)须为单个 http(s) URL(**不从散文抓取**),复用 `classifyLink` 判「明确可下载」——仅 `video`(已知视频站)/ `http`(已知直链扩展名)广播,`ambiguous`(普通网页)/ 非 URL **不弹**(克制)。去重三闸:变化门(`lastText`)+ 会话已提示集(`promptedUrls`)+ 已在任务列表(注入 `TaskManager.getTrackedSourceUrls()`);识别加固注入 `TaskManager.getKnownFileExts()`(与直链加固同一并集)。检测经**注入式 `onDetected`**(装配 `broadcastClipboardLink`,仿 `broadcastProxyStatusChanged` 遍历窗口 `webContents.send`)广播 `clipboard:linkDetected` → 渲染层弹**不夺焦**角标(`ClipboardPrompt`,主进程只 `send`、**绝不 `focus` / `flashFrame` / `show` 抢焦**),点「添加」复用既有 `AddTaskDialog` 预填 URL + `addTask` / `addVideo`(**不旁路查重**)。开关 `settings.json.clipboardWatch`(默认 **关**)经既有 `settings:set` → `onChange` 联动 `setEnabled` 即时启停;退出 `before-quit` `stop()`。**隐私红线(§7.6)**:只读文本、`lastText`/`promptedUrls` 全内存会话级(`setEnabled(false)` 即清)、**不落库 / 不写 settings / 不写 electron-log(含 `console.*`)剪贴板内容**、仅运行时(退出即停,无 OS hook / 自启)。
- **历史检索 / 统计服务(✅ v0.2 Task 5)**:历史页数据源走**主进程只读 DAO**(`history:search` / `history:stats` IPC,仿 `category.ts` **注入 db 句柄、handler 纯转发**,**不经 TaskManager**——历史是对源数据的只读回看,与 TaskManager 管理的活动态职责分离)。`searchHistory`(LIKE + 状态 / 类别 / 时间过滤)/ `historyStats`(类别 + 时间窗口聚合)纯 SELECT / GROUP BY(§7.3 只读);时间口径(今天 / 本周 / 本月边界、`custom` from/to)由主进程纯函数 `historyTime.ts`(`resolveTimeRange` / `statWindowStarts`,本地时区 / 周一起始 / 月初起始)**单一来源**换算,`escapeLike` 防注入、`clampHistoryLimit` 兜底 500,渲染层只传语义 query(§7.2)。**统计按 `completedAt` + 仅 `completed`(成果口径),搜索 / 列表按 `createdAt`(发起口径)**——面向不同问题、口径各自恰当,显式声明避歧义。
- **可测性**:「调外部进程」封在 DownloadEngine / VideoResolver 接口后——单测 mock 接口,集成测试才用真二进制。

---

# 5. AI 协作与文档引用机制

| 层 | 文件 | 加载 | 职责 |
|---|---|---|---|
| 入口 / 红线 | `CLAUDE.md`(根) | 每次会话自动 | 提交纪律 + 硬约束摘要 + 文档地图 |
| 产品 | `docs/PRD.md` | 按需 | 定位 / 用户 / 痛点 / 旅程 / MVP / 黑名单 |
| 架构 | `docs/ARCHITECTURE.md`(本文件) | 按需 | 技术栈 / 结构 / 约束 / 禁止破坏的逻辑 |
| 设计 | `docs/DESIGN.md` | 按需 | 视觉与交互规范(frontend-design 缰绳) |
| 变更 | `CHANGELOG.md`(根) | 按需 | 各版本对外有影响的变更 |

**开始任何改动前 AI 必读**:`CLAUDE.md` + 本文件 §7。

## 5.1 文档工作改后核对（跨工具共享）

涉及文档同步、交接或结论承接,修改结束前逐项核对**本轮自己的产出**,即使本轮修改的恰好就是这些规则。来源只读 / 已注入不是遵守证据,也不替代以下核对。

1. **后续承接**:列出本轮新结论的所有接收方,把执行所需事实写进每个受影响的**后续执行说明**;事实记录回填既有设计 / 计划文档,不能靠修改已完成的部分代替后续交接。无接收方时说明不适用的原因。
2. **执行说明独立完整**:把可单独复制执行的提示词单独抽出阅读,既查指代落空,也把块外本轮新增事实逐条对照到块内;链接、块外表格、其他步骤的内容不算已内联。`CLAUDE.md` 保证在场的红线不必抄写,执行提醒按根规则保留。
3. **长期约束就地落库**:跨阶段有效的约束写到对应规范或受约束对象旁,在共享入口保留可找到它的引用,不只留在待办、阶段记录或收口评审中。
4. **指派双向闭合**:新指派或改指派按 `CLAUDE.md` 的指派纪律回写目标执行说明;目标尚不存在时按拉取方式承接。事实内联是否完整须人工逐条判断。

核对结果回填对应计划或最终评审,面向用户简述适用项、证据和未覆盖项,不新增平行进度台账。没有改动执行说明 / 没有新增指派时据实标明“不适用”,不要为制造闭环去改无关内容。

---

# 6. 开发约束(工程原则)

## 6.1 引擎复用,不重造轮子
下载 / 解析协议交给 aria2 / yt-dlp;DownLord 专注整合、状态管理、体验。

## 6.2 可测性优先
外部进程调用封装在接口后,纯逻辑(文件名清洗 / 链接识别 / 状态机 / 进度解析 / 代理解析)做成可单测纯函数。

## 6.3 错误可读
每个错误映射到「可读中文提示 + 可操作下一步」;原始 stderr / 异常栈只进日志,不糊用户脸上;失败任务保留可重试。

## 6.4 实现纪律
- 分步实现、小步验证、保持应用可运行。
- 不一次性重构整个项目;不擅自改未关联模块。
- 先更新对应的设计 / 计划文档,再实现功能。

---

# 7. 禁止破坏的逻辑(红线 · 跨版本)

> 本文件核心。以下逻辑在任何版本、任何 Task 中**不得破坏或重新设计**,除非经用户明确决策。

## 7.1 引擎独立进程化
aria2 / yt-dlp / ffmpeg 是独立子进程,**崩溃隔离不拖垮 UI**;aria2c 意外退出须**自动重启 + 重新提交未完成任务**(靠 `.aria2` 续传)。不在主进程内自己重写下载 / 解析协议。

**BT 走 aria2 原生(✅ v0.3 Task 1–3)**:BitTorrent / magnet / DHT / tracker / peer 交换 / 做种**全部交 aria2 原生能力**——DownLord 侧只有 `btOptions.ts`(纯函数组装任务级 options)、`torrentPaths.ts`(纯路径拼接)与 `buildAria2Args` 的 BT 引导参数段,**零协议实现、零 peer 通信代码、零种子解析器**(`files[]` / `infoHash` / `name` 均取 aria2 `tellStatus` 原生返回)。BT 复用直链同一 aria2 守护进程与崩溃重启机制:aria2c 挂掉后按 `desiredState` 重提——magnet `re-addUri` / `.torrent` `re-addTorrent`(内存 base64 副本),续传仍归 `.aria2`(§7.4)。

**tracker 表热更新仍是 aria2 原生(✅ v0.4 Task 1)**:tracker 表的拉取 / 解析 / 合并去重 / 合格性校验全在主进程纯函数(`src/main/bt/trackerText.ts`),下发**只经 aria2 原生接口** —— 启动期拼 `--bt-tracker=`(pull,`aria2Args.ts:100/130`)、运行期 `changeGlobalOption({'bt-tracker'})` + 逐任务 `changeOption(gid, {'bt-tracker'})`(push + 追补,`downloadEngine.ts:554-586`)。**零协议实现、零 tracker 自研、零 announce 代码**;`DEFAULT_BT_TRACKERS` 47 条保留为失败兜底,缺省不传缓存表与 v0.3 逐字节等价(`aria2Args.test.ts` 以 `deepEqual` 快照钉死)。

**精细化挂 aria2c「回退不退化」(✅ v0.3 Task 4)**:视频侧按 `ResolvedFormat.protocol` 判定是否挂 aria2c——**仅已确认 fragmented(`m3u8` / `m3u8_native` / `http_dash_segments` / `dash`)才主动不挂**并改用 yt-dlp `--concurrent-fragments 4`;**`https` / `http` / `null` / `undefined` 一律保守视为非 fragmented → 照旧挂 aria2c**,三层回退安全网(预探测 gate → 运行时回退自带下载器 → 二次失败才 error)**逐字节保留、不因优化而拆除**。即优化只是「少踩一脚注定失败的尝试」,不缩小兜底面。

**崩溃风暴不静默(✅ v0.3 Task 4)**:aria2c 反复崩溃触发退避上限后,`watchAria2Exit` 经 `onGiveUp` 回调把非终态任务转为 error 终态并通知 UI,**不再只 `console.error` 后静默 return**——「下载中 0 速永久假死」变为可见终态、可重试。

## 7.2 进程职责分离
主进程是业务大脑(TaskManager / DownloadEngine / VideoResolver / MediaTool),渲染进程**纯 UI**,两者只经**强类型 IPC bridge** 通信。业务逻辑不下沉到渲染层。

**示例(✅ Task 8 设置页)**:`SettingsPage`(渲染层)挂载经 `settings:get` 回显、改值经 `settings:set` 回写,**零业务逻辑**——校验(maxConcurrent clamp / themeMode·清晰度白名单守卫)、持久化(原子写 `settings.json`)、联动(并发出队补足 / 默认目录 / 主题 / 视频偏好即时生效)全在主进程 `SettingsService`;`set` 返回 clamp 后最新全量供渲染层回显真实值。代理三档同理(`<ProxySettings/>` 经 `proxy:*`)、分类目录经 `category:update`。渲染层不直接读写配置文件 / 不触 `nativeTheme` / 不算 savePath。

**示例(✅ v0.2 Task 4 剪贴板监控)**:监控 / 识别 / 去重 / 广播全在主进程 `ClipboardWatcher` + 纯函数;渲染层 `ClipboardPrompt` **纯展示**——只经 `window.api.onClipboardLink` 订阅主进程推送、把「添加 / 忽略」意图经 props 回调上抛,**不写识别 / 去重 / 校验逻辑**。开关经既有 `settings:set`(校验 / 联动在主进程)。主进程只 `webContents.send` 广播,**绝不 `focus` / `flashFrame` 抢焦**;「addOpen 时抑制提示」是渲染层克制(主进程不知 UI 态、照常广播)。

**示例(✅ v0.2 Task 5 历史检索 / 复制链接)**:历史检索 / 聚合 / 时间口径换算 / limit clamp / LIKE 转义全在主进程(`taskDao.searchHistory` / `historyStats` + `historyTime.ts` 纯函数),渲染层 `HistoryPage` 只传语义 query、纯展示结果 + 行操作经既有 `window.api`(`removeTask` / `retryTask` / `openPath` / `showItemInFolder`),**零业务下沉**。**复制下载链接是纯渲染层 Web API**(`navigator.clipboard.writeText(task.source)`)——**无对应 IPC 通道 / 无 `DownLordApi` 方法 / 不引 Electron `clipboard` 模块**,是「渲染层可自足的浏览器能力不强行走 IPC」的合理边界(与必须落主进程的配置读写 / 剪贴板监控相对)。

**示例(✅ v0.4 Task 3 浏览器扩展本地通道)—— 职责分离在这里多出一条边界:除了「主进程 ↔ 渲染进程」,还有「主进程 ↔ 浏览器扩展」。两条边界的口径一致:意图上行,决策留在主进程。**

- **通道只传意图**:本 Task 唯一的 `type` 是 `handshake`,**payload 只有 `extensionVersion` 一个字段**(即「我是扩展 vX、协议 v1」),`handshake` handler **只读、零副作用** —— 不建任务、不写盘、不碰 DB(`channelDispatch.ts` 的 `ChannelHandlers.handshake` docstring 把这条写在类型上)。**是否接管 / 落点 / 查重 / 分类等业务决策一律在主进程**;扩展不做决策(后续 Task 的增长表里,连 `takeover.getConfig` 的语义也写死是「扩展只读并照做」)。
- **渲染层 `ExtensionChannelSettings.tsx` 纯 UI**:token 生成、端口校验、服务起停、两行状态合成**全在主进程**(`ExtensionChannelService` + `portValidation.ts` / `linkState.ts` 纯函数),渲染层经 `window.api` 调五条 invoke(`extension:getChannelConfig` / `setChannelConfig` / `regenerateToken` / `getChannelStatus` / `getSideloadInfo`)+ 订阅一条推送(`extension:channelStatusChanged`)。**渲染层连「字符串转数字」都不当成校验** —— 输入框空串给出 `NaN` 交主进程回 `not_integer`,一个合法性判断都不做。
- ⚠️ **`extension:setChannelConfig` 刻意只接受 `{enabled, port}`、不接受 `token`** —— 渲染层不该有能力写入任意密钥;重新生成走独立的 `extension:regenerateToken`。这是「职责分离」用**接口形状**而非注释来强制的一处。
- 唯一的渲染层自足能力仍是 `navigator.clipboard.writeText`(复制配对码 / 复制扩展目录路径),沿用上一条的既有定性。
- **扩展侧对称地不做决策**:`chrome.*` 只准出现在 `extension/src/adapter/chromeAdapter.ts` 一个文件(eslint 钉死),`fetch` 只准出现在 `adapter/fetchNet.ts` 一个文件(同样 eslint 钉死,**反向自证已跑**:业务文件里写 `fetch('x')` → `npm run lint` 报 `no-restricted-globals`)。

**示例(✅ v0.4 Task 4 浏览器下载接管)—— 同一条边界上第一次出现「扩展的上报能真的改变主进程状态」,故职责分离在这里不只是整洁,而是安全边界(§7.6 的威胁模型正建立在它上面)。**

- **扩展只上报意图,连粗筛都不是决策**:扩展侧唯一的过滤是 **scheme 粗筛**(排掉 `blob:` / `data:` 这类 DownLord 根本处理不了的协议),它的定性是「**不适用**」而非「不接管」;真正的接管判定(总开关 / 暂停中 / 域名例外表 / `danger !== 'safe'`)**全部在主进程**的纯函数里(`src/main/takeover/takeoverRules.ts` 的 `decideTakeover`),扩展不知道也不需要知道判定规则。
- **载荷用协议形状强制,不靠注释**:`DownloadIntent`(`src/shared/extensionProtocol.ts`)**刻意没有** `dir`(落点归主进程按分类路由算)、**没有** `filename`(建议名由主进程从 URL 末段推断,与 `resolveFilename` 同一份纯函数)、**没有任意 header map**(只有 `referrer` / `userAgent` 两个**语义字段**,故 `Cookie:` 在协议层就没有容身之处)。这是 Task 3 里 `extension:setChannelConfig` 刻意不收 `token` 的同一手法 —— **用接口形状而非注释来强制**。
- **应答同样用形状收敛**:`download.intent` 的响应 payload **只有 `{ taken }`、不带 reason** —— 「DownLord 未运行 / 通道不通 / 暂停中 / 规则不接管」四种情况因此走**同一条代码路径**,扩展无从据 reason 分叉出别的行为(第二层保证是 `handleDownloadCreated` 全文**唯一** cancel 点)。
- **确认小窗口是纯 UI**:`TakeoverDialog` 显示落点调的是与主窗口**同一份**纯函数(`saveLocationView` 的 `previewDir` / `categoryDirForUrl`),提交时传 `pickedDir ?? defaultDir` sentinel、主进程 `explicitDirOf` 照旧解析,**渲染层自己绝不拼路径**;文件名清洗(§7.7)、分类路由、查重、限速、错误映射全在主进程既有链路,小窗口一样都不算。
- **⚠️ 窗口归属校验(本项目第一次出现「同一应用内多个渲染窗口权限不等」)**:`ipcMain` 的通道对**所有**渲染进程开放、不区分是哪个窗口发来的,而接管这**四条**渲染→主的消息(`takeover:ready` / `takeover:submit` / `takeover:dismiss` / `takeover:settled`)**能真的建任务**。故 `src/main/ipc/takeover.ts` 对四条**逐条**校验 `event.sender.id` 是否属于当前接管窗口(`service.ownsSender(senderId)`),不属于就**记一行 warn 后忽略**。不校验就等于把「建任务」这个能力开放给任意一个渲染页面。
- **反过来,主进程也不越界干预浏览器**:扩展侧 `cancel()` 的调用点全文唯一且**只在拿到 `{taken:true}` 之后**;主进程从不指示扩展做别的事(无反向推送,见 `CONTEXT.md`「本地通道」)。

**★ 红线(✅ v0.4 Task 5 网页资源嗅探)—— 扩展侧三条不许做的事:不注入网页 DOM / 不记录浏览历史 / 不上报远端。三句一体,缺一条另两条就守不住。**

- **不注入网页 DOM**:`extension/manifest.json` **无 `content_scripts` 字段**(判据 `grep -n "content_scripts" extension/manifest.json` 零命中;正向对照搜 `permissions` 应命中)。嗅探全靠**观察型 `webRequest`** —— 只看请求的**地址与响应头**,不进页面、不读页面内容、不改页面。
- **不记录浏览历史**:嗅探结果只在 `chrome.storage.session`(按 `tabId` 分桶,浏览器进程退出即清),**不落 `storage.local`、不落 SQLite**(§7.3 的判据 `grep -rn "sniff" src/main/db/` 零命中,正向对照搜 `task` 命中三个文件);`extension/src/sniff/` 全目录**恰 2 条 log,均不含 URL 变量**(只报「已开启」与「已关闭,已清空 N 个标签页」)。
- **不上报远端**:扩展**没有任何外联通路** —— `fetch` 全局的读取被 eslint `no-restricted-globals` 收进 `extension/src/adapter/fetchNet.ts` 一个文件(反向自证已跑),而它的唯一去处是本地通道 `http://127.0.0.1:<port>/channel`。
- **「未被用户选中的资源从不离开浏览器」不是承诺,是协议形状的后果**:分发表里**根本没有**「上报嗅探结果」这个 type(`sniff.report` 已取消),故 DownLord 只在用户点了某一条时才收到那一条。仍是本节反复用的同一手法 —— **用接口形状而非注释来强制**(对照 `extension:setChannelConfig` 不收 `token`、`DownloadIntent` 不设 `dir`)。

**搬家理由本身要记账,否则下次还会丢**:这条约束此前的**唯一明文出处是一条待办条目的落点行**,而该条目在 v0.4 Task 5 收口时销号 —— **条目一销,搭在它上面的长期约束就跟着没了**。故升入本节。
**为什么落 §7.2 而不是 `CONTEXT.md`**:① **同类相聚** —— §7.2 已经在管这一类扩展侧架构约束(意图上行 / 决策留主进程 / `chrome.*` 只准出现在 `chromeAdapter.ts` / 协议形状不收 `token` 不设 `dir`),本条与它们是同一种东西;② **够得上红线级** —— 注入 DOM 一次性打开**一整类**新攻击面(读页面内容 / 改写页面 / 触到登录态 DOM),而且**一旦注入过就回不去**:那之后所有隐私论证都得重做;③ `CONTEXT.md` 开头明写它是术语表、**不写实现细节、不写方案**,本条是方案性约束,**体例不符**。

## 7.3 数据安全(真实历史)
SQLite 存**真实下载历史(源数据,非派生,无法重建)**:
- 损坏时**备份旧库再新建,绝不静默丢弃**(对比:派生索引可随意重建,本库不行)。
- WAL + 原子写;启动 `quick_check` 自检。
- 瞬时进度只在内存,业务元信息才落库(见 §4)。
- 持久化引擎为 **`node:sqlite`**(Electron 内置,去 native);WAL / `quick_check` / 损坏备份重建经**引擎无关适配层**(`src/main/db/engine.ts` 单一工厂 + `engines/*`)实现,**可一文件回退 `better-sqlite3`**——数据安全语义不变(写标准 SQLite3 文件、底层同一 SQLite 引擎;experimental 仅指 JS API 表面,见 §1)。

**查重 / 覆盖不丢用户资产(✅ v0.2 Task 3)**:检测重复(§4「检测重复下载」)**查重只读历史**——`detectConflict` 只读迭代 `this.tasks`,**不 `updateTask` / `deleteTask`**。四决策**绝不静默丢用户已下文件**:**覆盖**经 `shell.trashItem` 把旧文件移入**系统回收站(可恢复,非永久删)**——源码**无 `fs.unlink` / `rmSync` 永久删**——并**移除被覆盖的旧完成记录**(`removeTask(deleteFile:false)` 仅移记录、文件回收站可恢复,消除同路径僵尸重复,2026-07-12 手测反馈;是用户主动覆盖操作的一部分,非静默丢弃);**重命名**双留(旧文件 / 记录原样保留,新文件加序号);**跳过 / 打开**零磁盘 / 零 DB 改动。**不新增 `status` 枚举 / 不加列 / 不加索引 / 不加 migration**(parked = 内存瞬时 Map)。**存量 0B 记录不自动清理 / 不改写**(有界遗留,诚实标注)。

**查重 `source` 索引(✅ v0.3 Task 4)**:上段「不加索引」是 v0.2 Task 3 当时口径;v0.3 Task 4 按 §3.3 迁移框架补 **migration v4 = 一条 `CREATE INDEX idx_tasks_source ON tasks(source)`**——**零数据触碰**(无 INSERT / UPDATE / DELETE,不改表结构 / 不动 `CHECK` / 不重建表);索引是**纯派生结构**(可随时重建,与 `tasks` 行的不可重建性相对),存量库**仍照常走迁移前主动备份**(不因「非破坏性」绕过)+ 单事务 + `schema_version` 记录。集成测试以**逐行 `deepEqual(after, before)` 字节级零变化** + 索引存在 + `EXPLAIN QUERY PLAN` 实走索引三重断言护航。查重接入后 `detectConflictFor` 经 `findBySource` 取同源候选、每行以内存 runtime 态(`this.tasks.get(row.id) ?? row`)覆盖——**仍纯只读**(`detectConflict` 不 `updateTask` / `deleteTask`),四决策的磁盘 / 回收站行为逐字不变。

**历史检索 / 统计只读(✅ v0.2 Task 5)**:历史页经 `searchHistory` / `historyStats` **纯 SELECT / GROUP BY 只读回看**源数据——**零 INSERT / UPDATE / DELETE**,`history.integration` 集成测试以「查询前后 `tasks` 表行数 + 逐字段内容零变化」断言护航(复用 Task 8.5 migration 集成测试的零变化断言法）;历史页删除 / 重试**复用既有 `removeTask` / `retryTask`**(不新增删除路径)。搜索 / 统计**不改写、不迁移**历史,**不新增列 / 索引 / migration**。复制下载链接纯读 `task.source`、零 DB 触碰。

**`kind='torrent'` 的 v3 迁移:重建源数据表而不丢一行(✅ v0.3 Task 1)**:新增 `kind='torrent'` 触碰 `CHECK(kind)`,SQLite **无法原地改 CHECK**,故 migration **v3 必须重建 `tasks` 这张源数据表**——本版最重的一次 §7.3 操作,守四条:①**迁移前主动备份**旧库(`connection.ts` 见「存量库版本 < `LATEST_MIGRATION_VERSION`」即备份,不因迁移「看起来安全」而绕过);②全部 DDL / DML 在 `runMigrations` **单一事务**内,任何异常整体 `ROLLBACK`、库停在 v2、数据无损;③`INSERT INTO tasks_new (…) SELECT …` 用**显式列名**(而非 `SELECT *`)杜绝列序错位,`torrentMeta` 缺省 NULL(存量无 BT);④迁移 DDL **字面自包含**——不引用可变的 `schema.ts::TASKS_TABLE_SQL`(迁移历史一经发布即为定值,引用会随 schema 演进而漂移)。集成测试以**迁移后逐字段零丢失断言**护航;`status` CHECK 8 态原样不动。

**BT 文件选择 / 做种 / 富进度:零 schema 改动(✅ v0.3 Task 2 / 3)**:三者都**没有加列、没有加索引、没有加 migration、没有新增 `status` 枚举**——①**文件选择**定型写进**既有** `torrentMeta` JSON 列的 `files[].selected`(DAO 零改);②**做种**是运行时事实,持久化状态恒为 `completed`,`seeding` 只经 `TaskProgress` 广播(不改 `CHECK`);③**富进度**(`numSeeders` / `uploadSpeed` / `uploadLength` / `connections`)与**单任务限速** `limitKBps` 同属运行时瞬时量,**仅内存 + IPC 推 UI,绝不落库**(`src/main/db/` 对 `limitKBps` 零命中)。BT 任务的**删除**沿用既有语义:「删除文件」走 `shell.trashItem` 进系统回收站,**源码无 `fs.unlink` / `rmSync` 永久删**。

**浏览器下载接管:两样新东西都不触 SQLite(✅ v0.4 Task 4)**:
- **`headers` 是运行时态,不落库**:接管带来的 `Referer` / `User-Agent` 只活在内存里的 `Task.headers`,与 `limitKBps` / BT 富进度**同构** —— **不加列、不加索引、不加 migration、不新增 `status`**;接管任务就是普通 `kind='http'`,**零新增 kind**。判据两条:`grep -rn "headers" src/main/db/` **零命中**;跑完一整条接管流程后 `schema_version` 与流程前**同值**、`PRAGMA table_info(tasks)` 不含 `headers`(集成断言 I-09)。
- ⚠️ **代价要如实说,不许用「同构」搪塞**:重启后从库恢复的接管任务**没有 referer**,站点若强校验 referer 则续传可能 403。失败**可见、可重试、不静默**(黑洞红线未破),但这与 `limitKBps` 丢失「只是慢一点」**不是同一量级** —— 同一个机制、不同量级的后果。有界遗留,已评估、本版不做。
- **接管配置落 JSON 配置,不进 SQLite**:总开关 / 暂停到期时刻 / 域名例外表落 `<userData>/config/takeover.json`(经既有 `jsonConfigStore` 组装的**第六份** store,键集合**恰好** `enabled` / `pausedUntil` / `excludedDomains`),与 `settings.json` / `proxy.json` / `extensionChannel.json` / `btTrackers.json` 同一范式 —— **配置不是下载历史**,不该进源数据库。
- **查重仍纯只读**:接管路径复用 `detectConflictFor`(**零改动**),四决策的磁盘 / 回收站行为逐字不变。唯一差别是冲突广播被**定向**到接管小窗口(`ipc/task.ts` 一行可选注入,缺省短路逐字等价),那是 UI 归属问题,**不触 DB**。

## 7.4 断点续传归属
**aria2 管字节级进度与续传**(`.aria2` 控制文件);**DownLord 的库只管业务信息**(来源 / 类型 / 视频元数据 / 保存路径 / 状态)。重启后从库读回未完成任务、重新提交 aria2 续传——不靠 aria2 运行时 `gid` 持久化。

**HTTP 取名/查重的路径保护(v1.0 Task 3)**:DownLord 可构造数据路径对应的 `.aria2` 路径并检查存在性,用于保护既有下载,**不读取、不写入、不解析控制文件内容**。rename / overwrite 的占用检查与预约都使用完整 data/control 路径集合,不能只保护其中一个;查重回收只由用户明确选择 overwrite 触发,失败保留决策。路径构造/存在性检查不等于接管字节级续传,`gid` 仍只在内存、绝不入 DB;源码扫描器只为这些严格整行形态作受限分类,未知/嵌套调用与同行副作用仍不得放行。

**BT 同样归 aria2(✅ v0.3 Task 1–3)**:torrent 任务的字节级进度与续传**完全由 aria2 的 `.aria2` 控制文件承担**,DownLord 侧**不读、不写、不解析 `.aria2`**;`gid`(含元数据阶段的 metaGid 与 `followedBy` 转移后的 realGid)**只活在内存、绝不落库**(`grep -rn "gid" src/main/db/` 零命中),重启恢复靠库里的 `source`(magnet)/ `<userData>/torrents/<taskId>.torrent` 托管副本重新提交,由 aria2 自行读 `.aria2` 续传。**停止做种**用 `forcePause` + 解绑 `gidToId`,**保留文件与 `.aria2`**、不删磁盘。**单任务限速三态**(未设 = 跟随全局 / `0` = 本任务不限 / `N` = 限速)经 aria2 `changeOption` 即时生效,**不碰 `.aria2`、不落库**。

**用户暂停路径已统一为 `forcePause`(✅ v0.3 Task 1 真机修订四 · 据源码订正)**:`DownloadEngine.pause(id)` 是**通用路径、不按 `kind` 分叉**,`src/main/engine/downloadEngine.ts:350` 统一 `await this.rpcClient.forcePause(task.gid)`,对 **http / video / torrent 全 kind 生效**(不是「仅 BT 侧改、直链侧仍 `aria2.pause`」)。改因:优雅 `pause` 存在「pause pending」窗口,窗口内 `unpause` 会报 `cannot be unpaused now`(BT 收尾要联系 tracker,窗口更长);**续传不受影响**——`--auto-save-interval=1` 保证 `.aria2` 每秒刷盘。`rpcClient.pause` 仍保留但**唯一生产调用点是 `downloadEngine.ts:710`**——崩溃重提后按 `desiredState` 把**新 gid** 复位为暂停,属恢复路径的状态复位,**不再承担用户暂停语义**。

## 7.5 二进制内置 + yt-dlp 独立热更新
三引擎随安装包分发、开箱即用;**yt-dlp 必须能脱离应用整体升级独立热更新**(放 `%APPDATA%/DownLord/bin/` 用户可写区,后台查 GitHub releases 替换),否则站点改版会让用户「昨天能下今天下不了」。

**实现 / 验收(✅ Task 9)**:
- **真二进制内置**:aria2c `1.37.0` / yt-dlp `2026.06.09` / ffmpeg `8.1.2` 放 `resources/bin/`(**不入库**,`.gitignore` 忽略 `*.exe`;`resources/bin/README.md` 记录来源 URL + SHA256,可复现可审计)。
- **打包态定位一致性**:`electron-builder.yml` 经 **`extraResources`** 把 `resources/bin` 复制到打包态 `process.resourcesPath/bin`,与 `locator.resolveBinDir` 打包态落点一致(原 `extraFiles` 落 app 根 `bin/` 与 locator 不一致 → 打包态定位不到,已修复)。`npm run package` 解包实测:三 exe 在 locator 落点、SHA256 与源逐一致、旧根 `bin/` 不再生成。
- **yt-dlp 可写副本**:`ensureWritableYtDlp`(Task 1)首启把内置 yt-dlp 拷入 `%APPDATA%/DownLord/bin/`,`resolveYtDlpPath` 优先可写副本;aria2c / ffmpeg 始终内置、不进可写区。
- **完整自动热更新(查 GitHub releases / 下载替换 / 开关)v0.1 未做**——v0.1 仅确保可写目录架构就位,不实现自动更新逻辑(v0.2 已落地,见下段)。

**完整自动热更新落地(✅ v0.2 Task 6)**:`src/main/update/YtdlpUpdater`(依赖全注入,`ytdlpUpdater.ts`)实现独立热更新全链路,逐条守 §7.5 / §7.1 / §7.2:
- **只动可写副本**:替换目标恒为 `resolveYtDlpPath` 优先的用户可写副本 `<userData>/bin/yt-dlp.exe` + 同目录 `.download`(下载临时)/ `.pending`(占用降级暂存,`paths.ts` 派生保证 `rename` 同卷原子);**绝不触碰内置 `resources/bin/`**;aria2c / ffmpeg 不在本更新范围(随应用整体升级)。
- **检查 / 下载走代理**:查 `api.github.com/repos/yt-dlp/yt-dlp/releases/latest`(User-Agent 头)+ 下载 `yt-dlp.exe` 均经 **Electron `net` + 独立 update Session**(`updateHttp.ts`,`configureProxy(getResolved().effectiveUrl)`;null → `direct://`),与业务下载引擎(aria2)完全隔离——不污染任务列表 / 不需 gid / 不走分类路由;跟随 302 重定向;**不承诺翻墙**(代理沿用 Task 7 边界)。
- **三重校验(择优)**:临时文件 ①size ≥ `MIN_VALID_YTDLP_BYTES`(与占位检测同源下限)②SHA2-256SUMS 完整性(权威;缺 sums 或不匹配即中止保留旧版,安全优先)③`--version` 可执行性解析须 == `tag`(复用 `probeVersion` 注入式 spawn)。任一失败清理临时 + **保留旧版**(旧 yt-dlp 原样可用),`phase:'error'` + `UPDATE_*` 可读错误。
- **原子替换 + 占用不 kill(§7.1)**:三重校验全过后,**空闲**(`hasActiveYtDlp()` 无 video 任务处于 resolving/downloading/processing)→ `fs.rename(tmp→target)` 原子覆盖(`applied`);**有占用**或 `rename` 抛 EBUSY/EPERM(Windows 文件锁)→ 降级 `rename(tmp→.pending)`(`pending-restart`),**绝不 kill 运行中 yt-dlp**。
- **applied 后校正当前版本(避免重复下载)**:真正生效(applied,非 pending)后经注入 `onApplied(tag)` 回调用**已过 `--version==tag` 校验的 tag** 刷新 `engineVersionsCache.ytdlp`(即 probeVersion 校正的等价、更省一次 spawn)——否则 `getCurrentVersion()` 恒读旧版 → `needsYtDlpUpdate` 恒 true → **重复下载同一版本**(2026-07-14 GUI 手测 U4 修复);pending 不刷(下次启动 `applyPendingYtDlp` 后由启动期 probeVersion 校正)。
- **启动期应用 pending + 占位检测不倒退**:`applyPendingYtDlp`(`setupBinaries()` 前、任何引擎 spawn 前)——`.pending` 有效(size ≥ `MIN_VALID_YTDLP_BYTES`)→ rename 覆盖 + 删;无效仅删;无 pending no-op。之后 `ensureWritableYtDlp` 见有效副本自然 `skipped`——**校验用同一 `MIN_VALID_YTDLP_BYTES` 下限,绝不以「等于内置大小」判定占位**(Task 9 修复不倒退)。
- **开关 / 节流 / 诚实**:`autoUpdateYtDlp`(默认 `true`,`settings.json`);后台自动检查 24h 节流缓存 `updateState.json`(手动检查无视节流);**非静默**——自动应用后必 toast 告知(`applied` / `pending-restart` message)。
- **占用替换端到端**由集成测试(注入 fake 网络 + 真实 FS)覆盖(A1 空闲替换 / A2 占用降级 + 重启 applyPending);**真实网络下载 / 真实站点回归**归用户手测(§7.3 手测归属)。

**应用本体自更新(✅ v0.2 Task 6,非 yt-dlp 热更新,补充)**:`AppUpdater` 封装 `electron-updater` + GitHub Releases(公开仓库),`autoDownload=false` / `autoInstallOnAppQuit=false` **不静默强制**——检查有新版仅提示,下载 / 重启安装均用户点击;check/download 前 `configureAppUpdaterProxy` 走代理;`electron-builder.yml` `publish: github`(owner/repo 占位待用户填)打包生成 `latest.yml`;**未签名 NSIS + `latest.yml` 可正常更新**,`quitAndInstall` 触发的安装器 Windows SmartScreen 可能提示「未知发布者」,关于组 UI 如实说明(不隐瞒,PRD §4.4;代码签名继续留后续)。

## 7.6 代理与合规
- **不提供翻墙能力**:仅对接用户已有的系统代理 / Clash 节点(读系统代理传给引擎),DownLord 不内置节点 / 不做墙外中转。
- 分流交给代理软件(Clash 规则),MVP 不自研分流。
- 下载内容受版权 / 平台 ToS 约束,**如实声明,不做虚假翻墙 / 安全承诺**。

**实现(✅ Task 7)**:
- 三档 → 引擎参数:`direct` → `all-proxy:''` / `--proxy ''`(显式关闭);`manual`(校验通过)→ 用户值(含 `user:pass@host:port` 认证**原样透传**);`manual`(校验失败)→ null 显式关闭 + 状态栏「手动代理(地址无效)」;`system`(读到 / 未读到)→ 系统代理 / 显式关闭。**崩溃恢复重提任务同样注入**(防 aria2 回退环境 `HTTP_PROXY` 致 direct 档泄漏)。
- 读系统代理是**主进程主动行为**(引擎不自动读 Windows 系统代理):`session.defaultSession.resolveProxy(代表性 URL)` 仅做判定**不发真实请求**,取第一个非 DIRECT 节点映射 `http://` / `socks5://`。
- 连通探测**只对代理端口本身**做一次 TCP 连接(`net.connect`,超时 1.5s),**不向外网发请求**、不周期轮询;状态「已连接」仅指到代理端口连通,**不承诺墙外可达**(诚实)。
- IPC 四通道(强类型,`src/shared/ipc.ts`):`proxy:get` / `proxy:set` / `proxy:getStatus`(invoke)+ `proxy:statusChanged`(主→渲染推送);渲染层 `ProxySettings` 纯 UI,经 `window.api` 调用、**零代理业务逻辑**。
- **逐 URL 精确遵守 Windows 系统 bypass 列表**未做(已评估为新增能力、推后):MVP 用「统一交系统代理 + Clash 规则兜底分流」简单实现,本 Task 边界不变。

**Cookie 登录合规(✅ v0.2 Task 1)**:
- **Cookie = 用户自己的登录态**:只读用户自备浏览器 / Netscape 文件中**已登录**的 Cookie(经 yt-dlp `--cookies-from-browser` / `--cookies`),**不内置 cookie、不帮用户登录、不破解会员 / 不绕过付费墙**——落在 [PRD.md](./PRD.md) §7「Cookie 登录用用户自己的登录态,不在黑名单」授权边界内。
- **只存来源、不存内容**:`settings.json` 的 `video.cookie` 仅存 source / browser / file 路径,**绝不持久化 cookie 值本身**(集成测试 CS1 断言落盘 JSON 不含任何 cookie 内容)。
- **诚实措辞、不承诺规避封锁**:UI / 文案 / 错误 nextStep 均**无「破解 / 绕过会员 / 保证可下 / 翻墙」**,统一表述「使用你浏览器中**已登录**的 Cookie…**不保证**可下载受限内容」;`--cookies-from-browser` 打包态真实失败面(Chrome/Edge ABE / DPAPI)诚实回退提示改用 Firefox / 文件,不宣称「一定可读」。三处 v0.1「当前版本不支持 Cookie 登录」旧文案(`YTDLP_NEED_LOGIN` / `SITE_REJECTED` / `HTTP_403`)已更新为「可尝试导入你自己的登录态后重试」(不承诺「导入后一定可下」)。

**BT / 做种合规与诚实(✅ v0.3 Task 1–3)**:
- **做种默认停、可选开启、用户自愿**:`btOptions.toSeedOptions` 缺省 / `enabled===false` 恒产 `{'seed-time':'0'}`(下载完即停上传,与 Task 1 逐字节等价);开启后由用户在设置页自行设 `seed-ratio` / `seed-time` / `bt-max-peers`。定位是**下载器不是 P2P 客户端**——**不做迅雷式 P2SP / 私有加速网络 / 会员通道**(PRD §7 黑名单),`--bt-*` 参数只用 aria2 原生公共 BT 语义。
- **措辞红线**:BT / 做种全链路(UI 文案 / 设置页 / README / 错误提示)**无「加速他人 / 私有网络 / 保证上传 / P2SP / 中转加速」**;统一表述「做种是自愿的,能否连上其他节点取决于你的网络环境」。
- **两个诚实缺口的现状(原为 v0.3 有界遗留;**v0.4 Task 1 据实更新**,2026-07-29)**:
  - ①**入站可达性**——NAT / 家用路由器 / 运营商默认不允许外部主动连入,做种上传速度**可能长期为 0**。**UPnP / NAT-PMP 仍未实现**,且 **v0.4 Task 1 明确决议不做**(校园网出口设备不归用户管、CGNAT 家宽同样无效,而本机已有公网 IPv6 时 UPnP(IGD)只映射 IPv4 端口、完全用不着;为覆盖不到一半场景的能力引入第三方依赖不成立)——**现行处置：本体不做，不再指定后续版本**（已有多因子结构与固定端口段 `52301-52310` 不是将实现 UPnP 的承诺）。改为交付**入站状态自检**(`src/main/bt/inboundDiagnosis.ts`:纯本地读 `os.networkInterfaces()` 判有无全局单播 IPv6,**零外联、零依赖、换网自动重算**;不查 Windows 防火墙规则——**给假结论比不给更坏**),设置页以只读诊断行如实呈现 `likely` / `unlikely` / `unknown` 三态。**仍只检测与如实呈现,不承诺打通、不承诺一定能上传**;判 `likely` 也只陈述「检测到公网 IPv6」这一事实,能否真被连入仍取决于路由器 v6 入站策略与系统防火墙。
  - ②**tracker 静态快照**——**已支持应用内自动更新**(✅ v0.4 Task 1):添加 BT 任务时按需拉取(**启动不联网、非 BT 用户零外联**)、≥12h 节流、双源堆叠(jsDelivr → GitHub raw)、双远端源合并去重截长 ≤100、**远端为准整表替换**,内置 47 条(2026-07-25 快照)**只作失败兜底**;落 `<userData>/config/btTrackers.json` 自包含原子写,经 `changeGlobalOption` 热应用**不重启引擎** + 逐个 `changeOption` **追补**活跃 torrent 任务;拉取走既有代理三档;**失败逐项诚实降级、退回内置表**(不静默、不假装成功)。⚠️ **追补属尽力而为**:仅验证「`changeOption` 调用被 aria2 接受 + `getOption` 读回新值」,**未验证下一轮 announce 是否真用新表**(需抓包;已评估:它是验证手段不是产品能力,不做)。**仍不宣称「已优化连接速度」**——只是换一份更新的地址表。两项现状均已同步根 `README.md` 的如实告知段。
- **代理边界不变**:`all-proxy` 只作用于 aria2 的 **HTTP(S) / tracker 请求**,**不代理 BT peer / DHT 的 UDP 流量**(BT 协议本身如此,非缺陷);仍**不提供翻墙能力**,不因 BT 而放宽。⚠️ 实现注记:`--no-proxy-server` 与 `resolveProxy` 注入互斥(曾致自引回归,已回滚),不得再加。
- **不做种子索引 / 资源聚合**:DownLord 不内置、不提供任何种子搜索 / 索引 / 站点聚合;种子与磁力**全部由用户自行提供**,下载与分享内容的合规责任在用户(PRD §7)。

**浏览器扩展本地通道的隐私与安全(✅ v0.4 Task 3)—— 明写不宣称绝对安全**:

- **只绑 `127.0.0.1`,绝不 `0.0.0.0`**:`BIND_HOST` 是 `channelServer.ts` 的**模块级字面量常量**,**不进 `extensionChannel.json`、不进任何 IPC、不可配** —— 配置项一旦存在就有人会去改它。绑回环的 socket 在**内核层面**就不接受其它网卡的连接,这是**唯一一条不依赖我们代码正确性的防线**;集成测试 I7 从本机非回环 IPv4 反向探一次(期望 `ECONNREFUSED`),无非回环地址的机器**显式 skip 并打印跳过原因**,不假装通过。
- **三闸分层(P1–P4 真机取证后确认,**未退化**)**:① **token** 走请求头 `X-DownLord-Token`(64 hex,复用 `generateSecret`;**不放 query** —— query 会进各类 URL 记录)② **`OPTIONS` 一律 `405` 且零个跨源放行响应头**,所有其它响应也一律不带 —— 让**浏览器**根据我们的沉默替我们拒掉网页 JS 的非简单请求 ③ **`Origin` 前缀校验**(`startsWith('chrome-extension://')`,不用 `includes`;**不做 ID 白名单** —— Firefox 的 `moz-extension://<uuid>` 每装必变,且本机程序能任意伪造 Origin)。⚠️ **三闸分工不同、不叠加**:真正在挡**本机攻击者**的**只有 token 一件事**,闸②③ 挡的是**浏览器里的网页 JS**(另一类攻击者)。把它说成「三倍安全」是错的。
- **日志红线(有机器守着)**:**绝不记 token(一个字符都不记,不记前缀 / 后缀 / 指纹)· 不记完整查询串 · 不记 cookie · 不记请求体原文 · 不记 `Origin` 的值本身**。鉴权失败只记**计数与原因码**(`鉴权失败 ×3(原因码 unauthorized)`);内部诊断码(`token_missing` / `token_mismatch` / `origin_missing` / `origin_bad` / `rate_limited`)**只用于聚合计数**,既不回给对方也不逐条落日志。集成测试 I9 注入捕获式 logger 跑通过 / 失败两条路径,**断言任何一行日志都不含 token 串 / Origin 值 / body 原文**。
- **连接状态是运行时态、不落库**:`extensionChannel.json` 的键集合**恰好** `enabled` / `port` / `token`(有断言);`lastActiveAt` 只在内存,重启回落「未配对」。**服务默认关**、启用后随应用启停、设置页可整体关闭(关闭后扩展功能全失效,但配对码仍有效 —— 提示里写明)。
- **端口被占不顺延、不扫描**:如实显示「端口 N 被占用,通道未启动」并给改端口入口(I6 断言**没有在 `port+1` 监听**)。顺延会让「一次配对长期有效」失去意义。
- **窗口限速只作用于失败请求**(60s / 20 次):token 正确的请求**永不被限速** —— 否则本机任意程序可以靠刷失败把**合法扩展一起挡死**(自制拒绝服务)。诚实标注:它限制的是**失败处理与日志的开销**,不是「让 token 猜不出来」(64 hex 本来就猜不出来),**不夸大成防暴力破解的主力**。
- **残余风险七条(逐条如实,不宣称绝对安全)**:① 本机同用户权限的程序能读 `<userData>/config/extensionChannel.json` 拿到 token 并完整冒充扩展 —— **可接受,同用户权限边界**,与 2026-07-11 审计对 aria2 `--rpc-secret` 的定性**同级**,但⚠️**攻击向量不同**(aria2 是命令行可见且**每次启动重生成**,本通道是**静态存于文件**)② 扩展侧 token **明文存于浏览器 profile**(`storage.local`;换 `storage.session` 可不落盘,但那会让「一次配对长期有效」当场破功)③ **不做恒定时间 token 比较** —— **刻意不做并如实写明理由**:本威胁模型下无意义(能读 config 的攻击者何必打时序攻击),**不假装加固** ④ **用 HTTP 不用 HTTPS**(本地自签证书扩展会拒);回环流量**不出网卡**,但**同机进程仍可抓** ⑤ **端口被占时,扩展那次配对会把 token 发给占用该端口的程序**(缓解:DownLord 侧如实显示异常 + 文档建议此后重新生成;且能抢占该端口的本机程序本就能读 config)⑥ 同一 token **允许多实例共用**,`lastActiveAt` 只记最近一次、**分不清是哪个浏览器连的**(v0.4 只保 Edge)⑦ 限速只作用于失败请求(见上,对「有 token 的攻击者」零作用)。
- **措辞红线**:通道相关的 UI 文案 / README / 错误提示**一律不得出现**「绝对安全 / 加密传输 / 保证不被访问 / 军工级」这类承诺。**本 Task 的实际暴露面很小**(唯一 type `handshake`,handler 只读零副作用 —— 拿到 token 的本机程序在本 Task 能得到的全部好处 = 知道 DownLord 的版本号与协议版本);**真正的副作用面从 Task 4 的接管开始** —— ✅ **已于 v0.4 Task 4 重新评估完毕(2026-08-04)**,重估结论、三条缓解与残余风险见下一段「浏览器下载接管的隐私与安全」。
- **通道不放宽任何既有合规口径**:不承诺规避封锁,不因扩展而改变代理 / Cookie / 下载内容的责任归属;本 Task **连 `cookies` 权限都没有**,**绝不传输 / 落盘 cookie 内容**(那是 Task 6 的红线)。

**浏览器下载接管的隐私与安全(✅ v0.4 Task 4)—— 暴露面确实变大了,故重新论证,不继承 Task 3 的结论**:

- **暴露面量化对比(不含糊其辞)**:

  | | Task 3 交付态 | Task 4 交付后 |
  |---|---|---|
  | 持 token 的本机程序能做什么 | 知道 DownLord 的**版本号与协议版本**(唯一 type `handshake`,handler 只读零副作用) | ①让 DownLord **带 `Referer` / `User-Agent` 去下载任意 URL** ②让 DownLord **弹出一个用户没点过的确认窗口** ③读接管配置、**改暂停状态** |
  | 能不能静默落盘 | — | **不能**(见下条) |
  | 能不能指定落盘目录 | — | **不能**(协议无 `dir`) |
  | 能不能注入任意头 / cookie | — | **不能**(白名单三层) |

- **确认框把最坏后果降了一级 —— 从「静默下载」降到「让用户看到一个他没点过的窗口」**。这是本 Task 全部安全论证的支点。而这个框:①显示的是**主进程自己从 URL 解析出的真实 host**(`new URL(url).host`),**不是**攻击者提供的任意展示字符串 —— 攻击者**无法伪装成「来自 microsoft.com」**;②文件名**恒过 `sanitizeBasename`**(§7.7),无法用 `..\..\` 写到别处;③落点由主进程按分类路由算,攻击者控制不了;④**不提供「静默接管 / 记住选择」开关** —— **没有任何配置能让这个框消失**(判据:`grep -rn "silent\|autoAccept\|skipConfirm" src/main/takeover/` 零命中;`takeover.json` 键集合恰好三个)。故最坏后果 = **用户被骗着下了一个文件到自己的下载目录**,与「用户在浏览器里被骗着点了下载」**同级,未升级**。
- **三条缓解各挡什么**:①**接管路径永不绕过确认框**(无静默接管开关)→ 挡「静默下载任意 URL」;②**intent 载荷不设 `dir`**,用协议形状把落点钉死在主进程(与 `extension:setChannelConfig` 不收 `token` 同一手法)→ 挡「写盘到任意目录」;③**`headers` 白名单三层**(协议形状无 header map / `filterDownloadHeaders` 只放行 `Referer`·`User-Agent` / aria2 用**专用选项** `referer`·`user-agent` 而**刻意不用 `--header`**)→ 挡「cookie 红线被绕开 + 任意头注入」,判据 `grep -rn "'header'" src/main/engine/` 零命中。
- **设计期新发现的三条(如实补入)**:
  - **`referrer` 是一个新的敏感字段**。Task 3 那条日志红线写的是「不记**完整查询串**」,主语是**请求 URL**;而 `referrer` 同样可能携带会话 token(如 `https://site/page?sid=…`),**不在那条的字面覆盖范围内**。故**日志只记 `new URL(referrer).host`,绝不记完整值**。⚠️ 另一半必须说清:referrer 经白名单进 headers 后**会被发给目标站点** —— 但**这正是浏览器本来就会做的事**(不接管时浏览器自己也发这个 referer),故**不新增外泄面**,只是把同一次发送的执行者从浏览器换成了 aria2。
  - **确认窗口本身是一个新的 UI 面**,能被用来诱导点击(社工)。已由上面四条降级,但**残余风险如实写明:社工仍可能奏效** —— 这与「用户在浏览器里被骗着点下载」同级,**DownLord 不宣称能识别恶意内容**。
  - **`byExtensionId` 意味着别的扩展发起的下载也会被接管**。这不是漏洞(别的扩展本就能在用户浏览器里发起下载),但需要立场:**只采集事实进日志(记 id、不记 URL),不据它做任何决策**。若日后要按扩展来源过滤,那是新的规则维度,须重新评估。
- **`danger` 检查的诚实边界**:`danger !== 'safe'` 时不接管、交回浏览器自己处理。⚠️ **`onCreated` 时刻浏览器的危险度判定很可能尚未完成**,故这一层是**尽力而为,不是可靠拦截**,只准表述为「浏览器若已判出危险则不接管(尽力而为)」。
- **两项曾被提议的加固(`extensionChannel.json` 文件 ACL / 挑战应答式配对)在新暴露面下重新检验,结论均不变(2026-08-04)**:
  - **文件 ACL 加固仍不做** —— 暴露面变大了,ACL 加固的收益理应也变大,**但检验后发现它在本威胁模型下从来就不起作用**:ACL 收紧(`icacls` 去继承 + 只留当前用户)挡的是**同机其它用户**与**低完整性级别进程**,而本威胁模型里的攻击者**就是当前用户身份的进程** —— 对它,任何「只留当前用户」的 ACL **完全不设防**。故 Task 4 的暴露面扩大**不改变成本收益比**。
  - **挑战应答式配对仍不做** —— 假 DownLord 拿到 token 后能做的事从「知道版本号」变成「让真 DownLord 弹确认框」,看似更严重;**但**它能拿到 token 的前提是**它占了那个端口**,而那意味着**真 DownLord 根本没在监听**(既有行为:端口被占**不顺延、不扫描**,如实显示「端口 N 被占用,通道未启动」),故它拿到 token 也**无从驱动真 DownLord**。Task 4 **不改变它的风险量级**,且挑战应答与「粘一次配对码就长期可用」的产品形态**直接冲突**。
- **总定性:维持「同用户权限边界,可接受」—— 这是重新论证后的同一结论,不是继承**。能打这个端口的前提是**已拿到 token**,而 token 静态明文存于 `<userData>/config/extensionChannel.json`,**只有同用户权限的本机程序读得到**;这样的程序**本身就能**弹窗、读文件、起进程、改注册表 —— 绕过 DownLord 直接干这些事成本更低、收益更大。接管路径给它的**边际能力增量**是:多一个「让用户看到一个带真实 host 的确认框」的社工渠道。**这个增量存在,但不改变定性。**⚠️「弹框轰炸」**不单列**为独立威胁 —— 能刷 intent 的前提同上,它已被「同用户权限边界」这条定性本身覆盖,单列属于推理上的**重复计数**。
- **日志红线扩到接管路径(有机器守着)**:只记 **host + 决策 + 计数**;**不记完整 URL 查询串、不记 `referrer` 完整值、不记 UA 全串、不记 token**;拒绝路径的日志**只有 host 与原因码**。
- **措辞红线(接管相关,逐字守死)**:接管相关的 UI 文案 / README / 错误提示 / spec / review **一律不得出现**「绝对安全 / 加密传输 / 保证不被访问 / 军工级 / **已覆盖恶意文件** / **已过滤危险下载**」。`danger` 检查**只准表述为**「浏览器若已判出危险则不接管(尽力而为)」。
- **接管不放宽任何既有合规口径**:**本 Task 不传 cookie**(Task 6 边界;白名单三层是它的机器保障,不靠自觉);不承诺规避封锁;下载内容的版权与平台 ToS 责任仍在用户。**接管只是把同一次下载的执行者从浏览器换成 aria2**,不改变「下什么、能不能下」。
- **有界遗留如实标注,不夸大也不隐瞒**:接管任务**重启后 referer 丢失** · 确认小窗口开着时关主窗口的**退出竞态** · `pendingConflicts` **无超时清理**(既有缺口非本 Task 引入)。三项均已评估、本版不做。
- **「链接失效需回浏览器重取」已如实说（v1.0 Task 3 已交付）**：HTTP 403/404保留旧句并追加“链接可能已失效 —— 若这次下载是从浏览器点过来的,回浏览器重新点一次下载即可拿到新链接。”；aria2码22有无detail均追加。这里只补人工操作指引，不判断任务来源、不落库、零schema变化，不是自动重取链接或全面修复。本次只依据既有交付订正文档，未重跑Task 3测试。

**网页资源嗅探的隐私(✅ v0.4 Task 5)—— 权限要得比行为宽,故这一段的重点是把那个差距如实说出来**:

- **日志红线扩到嗅探路径,扩展侧同守**:只记 **host + 决策 + 计数**,**不记完整 URL、不记查询串、不记 `referrer` 完整值、不记 UA 全串**。⚠️ **扩展侧比主进程更严:`extension/src/sniff/` 全目录一条 URL 都不 log** —— 实测全目录恰 2 条 log(「嗅探已开启」与「嗅探已关闭,已清空 N 个标签页」),均不含 URL 变量。理由是它的输出去处不同:扩展的 console **任何装了它的人都能在 sw DevTools 里翻**,而嗅探路径上流过的正是用户完整的浏览地址。
- **`<all_urls>` 的权限声明比实际行为宽 —— 如实告知,不辩解**:浏览器安装时提示「**读取您在所有网站上的数据**」,而我们实际只用观察型 `webRequest` 看**请求地址与响应头**,既不注入页面脚本也不读页面内容(§7.2 红线)。**这个差距只有我们自己知道,所以必须由我们自己说** —— 根 `README.md` 与 `extension/README.md` 的安装说明各写了一段。⚠️ **不许把它说成「所以其实没风险」**:声明宽就是宽,浏览器是按声明授权的,能不能兑现全靠我们守 §7.2 那三条;对冲手段(嗅探开关默认关 / 只处理 `tabId >= 0` / 结果只在 `storage.session`)是**降低影响**,不是**取消权限**。
- **不传 cookie;失败要如实报,但「如实」的边界得写准**(2026-08-11 裸跑 aria2 四档取证后订正):嗅探来的任务打到要登录态的资源会失败,我们**不静默、不说空话、原因如实**。⚠️ **规划期写的「如实带 HTTP 状态码」对 401 不成立** —— 401 走 aria2 `errorCode 24`,而 **aria2 自己的 `errorMessage` 原文里就没有那个数字**(`Authorization failed.`),任务行显示「HTTP 认证失败」是 code 24 的准确翻译,**不是映射层把状态码藏了**;403 / 500 走 code 22、原文自带 `status=403`,那两档确实带。故口径是「**原因如实**」而非「必带状态码」。「401 那一档缺少可操作的下一步」如实记为缺口(已于 v0.4 Task 6 与 Cookie 一并改到位)。
- **措辞红线沿用,且补一条**:嗅探相关的 UI 文案 / README / 错误提示 / spec / review **一律不得出现**「绝对安全 / 加密传输 / 保证不被访问 / 军工级 / 已覆盖恶意文件 / 已过滤危险下载」;**新增禁「已覆盖 / 全都能抓到」这类把边界说没了的词** —— 嗅探认得的只有四个清单里那些扩展名与 content-type,**认不出的站点要让用户看得出是「没抓到」而不是「这页没有」**(空状态明写去向:先开开关、再强制刷新本页)。

**扩展取 Cookie 的隐私与安全(✅ v0.4 Task 6)—— DownLord 第一次真的持有用户凭据,故整段重算,不继承 Task 3 / Task 4 的结论**:

- **两条最容易被后人当 bug 修掉的,写在最前面(逐字,不许改弱)**:
  1. **cookie 必然先于用户确认到达内存**。时序是「扩展报意图 → DownLord 在应答里**点名** `needCookieFor` → 扩展**给予** `cookie.offer` → 存入暂借登录态 → **此后**才弹确认框」。**确认之后 DownLord 无法再向扩展要任何东西** —— 本地通道**无反向推送**(MV3 的 service worker 会空闲销毁),唯一的补救是轮询,而轮询要 `alarms`(**表外权限**,红线 R9 明令不加)。**这是通道形态的必然,不是实现偷懒,别当 bug 修**。用户在确认框点「取消」不会、也无法「把已经拿到的 cookie 退回去」——它只是留在内存里等下一次覆盖或用户点清除,设置页那行常驻可见行就是为此存在的。
  2. **不落盘的理由是「会静默腐坏」,不是嫌加密麻烦**。`safeStorage` 走 DPAPI 是现成的,成本从来不是障碍;真正的障碍是**状态无法同步** —— cookie 会过期、用户会在浏览器里退登 / 换账号,而 DownLord **收不到任何通知**。持久化 = 保存一份**注定腐坏**的副本,失效形态还特别恶劣:**用户明明授权过,某天起全报「需要登录」,而界面上那份授权看起来还好端端在**。会话级内存对这一整类问题天然免疫 —— 重启后的第一次下载必然是从浏览器点过来的,拿到的**恒是新鲜的**;「卸载 / 退出清理策略」它零代码满足。
- **三层不落盘承诺(v0.2 那条「只存来源不存内容」在本 Task 语义扩大,故升级为三段式)**:①**不持久化**(旧承诺,不变)—— 任何落盘位置都没有 cookie 值,`CookieConfig` **一个字段都不加**;②**持有是会话级的**(新)—— 内存、重启即空、可在设置页显式清除、**不加 TTL**(隐形定时器会制造「有时候能用有时候不能」的不可预测行为,而躺 30 分钟与躺 8 小时的暴露面没有量级差别;换成**把持有状态做成可见的**);③**投影是进程级的**(新)—— 唯一落盘的是临时 `cookies.txt`,它是**一次性投影、不是真源**,锚在**一次 yt-dlp 进程**,进程退出即删(五条终止路径 + 幂等 release)+ 应用启动清扫残留。
- **连域名都不写日志(这一条比 Task 3 / 4 的日志红线更严,理由要写在这里)**:**日志会比它记录的东西活得更久** —— 持有层是会话级、重启即消失,而「用户在 bilibili.com 有登录态」这句话一旦写进日志文件就**持久化到了磁盘、跨会话留存**,等于**从后门违反了「会话级」这个设计承诺**。故 cookie 路径的 logger **在形态上就拿不到 payload**(只接收原因码枚举与计数),不靠自觉;与嗅探侧「`extension/src/sniff/` 全目录一条 URL 都不 log」是同一把尺子。
- **威胁模型重算 —— 支点是「通道上不存在任何『读出 cookie』的形状」**:`cookie.offer` 的方向只有**扩展 → DownLord** 一条,应答是 `{accepted:boolean}`、**零回显**(协议里明令不许为「方便调试」加收了几条 / 哪些 name 之类的字段);没有任何 type 的响应体携带 cookie。故**打这个端口的攻击者拿不到 cookie,他能做的只有塞进来**。逐类攻击者的**边际**能力增量:

  | 攻击者 | 本 Task 的边际增量 | 定性 |
  |---|---|---|
  | 局域网 / 外网主机 | 无 | **连不上**(只绑 `127.0.0.1`,内核层面拒) |
  | 浏览器里的网页 JS | 无 | 自定义头 + JSON ⇒ 非简单请求 ⇒ 预检 ⇒ 我们的沉默让**浏览器自己**拒掉 |
  | 同浏览器里的其它扩展 | 无 | 需要 token(闸①);⚠️ **即便有 token 也白搭** —— 它要能读 cookie,自己就得先有 `cookies` 权限,有了就不需要我们 |
  | 本机同用户程序(不知 token) | 无 | 闸① 挡住 |
  | 本机同用户程序(能读 `extensionChannel.json`) | ①往持有层**塞伪造 cookie** ②从 `needCookieFor` 应答**得知用户刚点了哪个站** | **可接受,同用户权限边界**(见下) |
  | **占了通道端口的假 DownLord** | 换到**用户此刻正操作那一个域**的 cookie | **本 Task 唯一真正新增的风险**(见下) |

- **塞伪造 cookie 的后果**:攻击者能让 yt-dlp 在下载某域时带上一份他伪造的 cookie,**但拿不到任何回传** —— 响应落到用户自己磁盘上的文件里,他还得再控制那个文件才能读到。而一个已经能读 `<userData>/config/` 的同用户程序,**直接读浏览器自己的 cookie 数据库成本更低、收益大得多**。
- **假 DownLord(端口占用)是本 Task 唯一真正新增的风险,如实写明**:
  - **能拿到什么**:它可以对扩展的 `video.intent` 回 `{taken:true, needCookieFor:[<该页面的 host>]}`,于是拿到**用户此刻正在操作的那一个域**的 cookie。
  - **拿不到什么**:它**不能点任意域的名**。扩展侧 `pickCookieUrls` **只认本次请求自己携带过的 URL** —— 应答被伪造成 `needCookieFor:["bank.com"]` 时,扩展手里根本没有那个域的候选 URL,`chrome.cookies.getAll` 压根不会被调用。**这是结构约束,不是策略**(改不改配置都绕不过)。
  - **前置条件有多硬**:它必须**先于 DownLord 占住那个端口**,而那意味着**真 DownLord 根本没在监听** —— 既有行为是「端口被占**不顺延、不扫描**,如实显示『端口 N 被占用,通道未启动』并给改端口入口」,**用户看得见异常**。且能抢占该端口的本机程序本就能读 `extensionChannel.json`、本就能直接读浏览器的 cookie 数据库。
  - **总定性:同用户权限边界内,可接受;暴露面确实扩大了一格,但不改变定性** —— 与 Task 4 对 `download.intent` 的重估同一形式的结论。**不加第四道闸**:挑战应答式配对在本 Task 理由更强(假 DownLord 拿到 token 的前提就是真 DownLord 没在监听,故它无从驱动真 DownLord),且与「粘一次配对码就长期可用」的产品形态直接冲突;「只接受最近点过名的域」的服务端白名单要引入时间窗口,与「等用户确认要多久不可知」直接冲突。
- **临时文件没有 ACL —— 如实交代,不含糊**:Node 的 `fs` mode 在 Windows 上**只影响只读属性、不设 ACL**,要真设得调 `icacls` / Win32 API。当前是四条纵深:①落在 `userData`(已是当前 Windows 用户的私有目录,**别的用户账户默认访问不到**)②随机名 ③极短窗口(锚一次 yt-dlp 进程,退出即删)④只含本次必要的域。⚠️ **对「同机同一用户下的其他程序」确实无防护** —— 但在那个威胁模型里,攻击者同样能**直接读浏览器自己的 cookie 数据库**,**DownLord 不是短板**,为它上 ACL 是防错了地方(与文件 ACL 的两次论证同一条推理)。
- **权限增长审计:`cookies` 是表内条目,按表增,本 Task 无表外新增**。理由:扩展要读 `chrome.cookies` 才能在浏览器**内部**取到登录态 —— 这正是第四档存在的全部理由(`--cookies-from-browser` 在 Chrome / Edge 运行中时读不到,ABE 挡的是外部进程),**没有更窄的写法能覆盖同一能力**。`host_permissions` **一个字不改**(仍是 Task 5 交付后的 `["http://127.0.0.1/*", "<all_urls>"]`;⚠️ 那次的 `<all_urls>` 是**表外新增、已在上一段显式记过一笔**,本 Task **不继承、不复述、也不再扩**)。另含**两处刻意的「不加」**:①**不加 content script 注入权限** —— popup 那个按钮**恒可点、不判断当前页是不是视频页**,要判断就得注入 content script(表外)或写不可靠的 URL 启发式,而 yt-dlp 支持上千站点,**我们本来就判断不了**;点了就把页面 URL 交给 yt-dlp 试,不是视频页走既有解析失败路径 —— 诚实且零新权限。②**不加 `tabs` 权限** —— `chrome.tabs.query` 本身不需要它,`Tab.url` 的可见性由「有 `tabs` 权限**或**匹配该 URL 的 host 权限」决定,我们已有 `<all_urls>`(Task 5 已付出的代价)故 URL 可见(**探针 B4 实机验过:7 个 tab 中 6 个可见**);⚠️ 受限页(`edge://…` / 新标签页 / 商店)不在 `<all_urls>` 内、`Tab.url` 恒被抹掉,故 popup 留了一条**如实报错**的分支,**不为它追加 `tabs` / `activeTab`**(表外须回用户拍板)。
- **`cookies` 权限的告知**:安装时浏览器提示的是「**读取和更改您在所有网站上的 Cookie**」。与 `<all_urls>` **同一处理** —— 根 `README.md` 与 `extension/README.md` 的安装说明各写一句:**我们只在你点击下载时、只读被点名那一个站点的 Cookie,从不写入、从不删除、从不后台收集**。⚠️ **不许把它说成「所以其实没风险」**:声明宽就是宽,浏览器是按声明授权的。
- **措辞红线沿用**:Cookie 相关的 UI 文案 / README / 错误提示 / spec / review **一律不得出现**「绝对安全 / 加密传输 / 保证不被访问 / 军工级」,以及既有的「破解 / 绕过会员 / 保证可下 / 翻墙」;统一表述沿用 v0.2 那句「使用你浏览器中**已登录**的 Cookie……**不保证**可下载受限内容」。**本段不宣称绝对安全** —— 上面把新增的那一格风险原样写出来,就是这条红线的兑现方式。
- **有界遗留如实标注,不夸大也不隐瞒**:「**用户直接把 URL 粘进 DownLord 且此前从未借过该站**」这个洞**任何设计都堵不上**(通道无反向推送),已在 UI 与错误文案里如实交代 · host 匹配仅允许同端口 `www.X` / `X` 的受限别名,一般父子域与不同端口仍不互通 · `COOKIE_EXTENSION_*` 三码挂在「站点明说要登录」这道闸后面,而 2026 年的真实站点多用反爬风控 / 静默降级回应匿名访问,**可达性有限**。

## 7.7 文件名清洗
视频标题常含 Windows 非法字符(`< > : " / \ | ? *`)、控制字符、保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)与尾部点/空格,写盘前**必须清洗**,否则下载失败或记录名≠真实落盘名。清洗的**唯一权威**是 DownLord 侧的 `sanitizeBasename`(http + 视频共用):非法/控制字符 → `_`、保留设备名加前缀 `_`、去尾部点/空格、空串兜底 `download`。

**HTTP 原生取名也先过同一权威(v1.0 Task 3)**:仅新 HTTP 且无非空显式名时,先用独立 gid 的有界零落盘 dry-run 取得 aria2 原生路径,取 basename 后经 `sanitizeBasename`,再分类/查重并以显式 `out` 正式提交;失败回到原 URL 取名。显式名、视频、BT、恢复路径不探测,`filenameFromUrl` 与原清洗实现不改。实际路径回报同步 DB / 引擎重启参数 / UI;主侧 `path.normalize` 只统一平台路径表示,**不是第二份文件名清洗**。

**字幕文件名清洗(✅ v0.2 Task 1)**:字幕作视频附属产物旁挂(`<outputBase>.<lang>.<subExt>`),`outputBase` 已经 `sanitizeBasename` 清洗故合法;下载命令的 `--windows-filenames` 只让 yt-dlp 侧对**自算文件名**再清一遍(且不处理保留设备名),对 DownLord 已先算好的 `outputBase` 不生效——**权威仍是 `sanitizeBasename`**,§7.7 不破坏。

**接管路径两支都过同一份清洗(✅ v0.4 Task 4)**:接管带来的文件名有两个来源,**都归 `sanitizeBasename`** —— ①**建议名**:`filenameFromUrl`(`taskManager.ts`,从 `resolveFilename` **原样提取**为导出纯函数,供接管确认框预填)从 URL 末段推断后过 `sanitizeBasename`,清洗后为空 / URL 非法则落回 `download-<时间戳>` 兜底名;②**用户在确认框里改的名**:经 `AddTaskInput.filename` → `resolveFilename` → `sanitizeBasename`。故**路径穿越无需新增缓解**(路径分隔符被清成 `_`,不把合法点号一并改写),`sanitizeBasename` **零改动、仍是唯一权威**,接管**没有引入第二份清洗实现**。⚠️ 提取 `filenameFromUrl` 的唯一理由是「确认框要预填同一个建议名」——**不得复制**那段逻辑(复制出的第二份迟早与本体漂移),单测 U-12 钉死两者对同一输入输出相同。

---

# 8. 验收标准(技术层)

> 产品级验收见 [PRD.md](./PRD.md) §8。

- aria2c 崩溃能自动重启 + 未完成任务续传,UI 不崩。
- 持久化往返一致(写库→读回===原值);应用重启恢复任务列表。
- 断点续传零丢失(中断→重启→续完,文件大小 / 哈希校验通过)。
- 关键纯函数(文件名清洗 / 链接识别 / 状态机 / 进度解析 / 代理解析)有单测覆盖。
- 每类错误有可读提示映射;失败任务不消失、可重试。
- 三引擎内置可用;yt-dlp 可独立热更新;§7 红线零回归。

**v0.1 收口对照(✅ Task 9 Phase 5,2026-06-30)**:
- **自动化门禁**:`npm test` 552 用例 543 pass / 0 fail / 9 skip(9 skip 为 Section B 真 aria2c 集成,默认 `SKIP_INTEGRATION`)、`typecheck`(node + web)/ `build` 全绿、`npm run package` 出 `downlord-0.1.0-setup.exe`(NSIS x64,~159 MiB,含真三引擎)。
- **错误可读映射**:统一错误目录 `src/main/errors/`(`errorCatalog` 单一文案 + `mapError` 分领域纯函数),覆盖引擎 RPC / 网络 / FS errno(ENOSPC/EACCES/EBUSY)/ 数据 / 解析;失败任务保留 `retry`;原始栈只进日志。
- **崩溃兜底 + 日志**:electron-log 落盘 `%APPDATA%/DownLord/logs/` + 接管 console(既有 `console.*` 零改动落盘);主进程 `uncaughtException`/`unhandledRejection` + `render-process-gone` 重载兜底;aria2c 崩溃重启 / SQLite 损坏重建 / 重启恢复**逻辑零改动**(衔接 Task 2 / 3)。
- **三引擎内置 + 打包态定位**:真二进制 + `extraResources` 定位一致(SHA256 实测一致、旧根 `bin/` 消失);yt-dlp 可写副本就位;关于分组显真实 `--version`(探测失败回退静态常量)。
- **手测矩阵(归用户真实桌面 / 安装包态)**:真下载 / 真续传 / 真崩溃恢复 / 真 yt-dlp 解析 + 音频 + 批量 / 真 Clash 墙外下载 / 安装卸载 —— 自动化覆盖不到的实装路径交用户实测。
