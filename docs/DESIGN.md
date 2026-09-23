# DownLord — 设计规范(DESIGN)

> 本文档是 DownLord 的**设计层**事实来源:基调、设计 Token、组件复用、关键交互、各状态视觉。
> 产品见 [PRD.md](./PRD.md);架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
>
> **标注约定**:✅ 已确立(从已批准原型 / 实现提炼)| ⬜ 待补(需补具体值,当前未明确记录,**请勿编造**)。
> **来源**:以下 Token 源自已批准原型的 `:root`(Fluent 2 / Win11),实现时已迁入代码主题 `src/renderer/src/theme/tokens.css`;DESIGN.md 为**单一来源**,新页面复用、不另起炉灶。
> **本文件同时是 frontend-design 的输入缰绳**——见 §6。

---

# 1. 设计基调(✅ 已确立)

- **Windows 11 Fluent Design**,浅 / 深色双主题。
- **专业、舒服、不廉价**(不必华丽炫酷)。
- **布局守正,气质出奇**:沿用成熟下载器范式(左导航 + 任务列表 + 筛选),不标新立异损害易用性;靠配色克制、图标统一、留白舒适、信息密度拿捏做出质感。

**方向锚点(给任何 UI 实现 / frontend-design)**:DownLord 是**工具型桌面应用**,不是展示型落地页。克制、清晰、稳定优先于「惊艳 / 难忘」;不要 maximalist、不要戏剧化动效、不要装饰性渐变。多页面风格必须**一致**,不允许逐页漂移。

---

# 2. 设计 Token(✅ 源自原型 `:root`)

## 字体 / 圆角
- 字体:`'Segoe UI Variable Display','Segoe UI',system-ui,-apple-system,sans-serif`
- 圆角:窗口 / 卡片 `8px` · 控件 `4px` · 胶囊(chip / tag)`999px`

## 色彩 — 浅色(default)
| 角色 | token | 值 |
|---|---|---|
| 窗口底(Mica) | `--bg-base` | `#f3f3f3` |
| 内容 / 卡片层 | `--bg-layer` | `#ffffff` |
| 侧栏 | `--bg-sidebar` | `#eaecf1` |
| 分隔线 / 描边 | `--stroke` | `rgba(0,0,0,.0578)` |
| 主文字 | `--text-primary` | `#1a1a1a` |
| 次文字 | `--text-secondary` | `#5c5c5c` |
| 三级文字 | `--text-tertiary` | `#8a8a8a` |
| 品牌主色 | `--brand` | `#0f6cbd`(hover `#115ea3` / pressed `#0e4775`) |
| 成功 | `--success` | `#0f7b0f` |
| 警告 | `--warning` | `#9d5d00` |
| 危险 / 错误 | `--danger` | `#c42b1c` |

## 色彩 — 深色
| 角色 | token | 值 |
|---|---|---|
| 窗口底 | `--bg-base` | `#202020` |
| 内容 / 卡片层 | `--bg-layer` | `#2b2b2b` |
| 侧栏 | `--bg-sidebar` | `#1f1f1f` |
| 描边 | `--stroke` | `rgba(255,255,255,.0837)` |
| 主文字 | `--text-primary` | `#ffffff` |
| 次文字 | `--text-secondary` | `#c8c8c8` |
| 品牌主色 | `--brand` | `#479ef5`(hover `#62abf5` / pressed `#2886de`) |
| 成功 / 警告 / 危险 | — | `#6ccb5f` / `#e8b339` / `#ff99a4` |

> 完整阴影 / hover / pressed / subtle 派生值见原型 `:root` 与 `[data-theme="dark"]`;实现时整理为主题对象。

## BT 做种 / 富进度 Token 映射(✅ v0.3 Task 3,复用零新造色值)

> BT 做种 / 富进度**不引入任何新色值**,全部复用既有语义 token;语义对齐 §1 克制。

| 用途 | token | 说明 |
|---|---|---|
| 「做种中」pill 背景 / 字 | `--success-subtle` / `--success` | 语义=正在贡献 / 健康;复用 `.t-icon.file` 已用的成功色 |
| 上行速度 `↑` | `--success`(绿) | 与 `↓ 下行` 的 `--brand`(蓝)区分——绿=分享出去 |
| peers / 分享率副信息 | `--text-secondary` | 与既有副信息同色,不抢主文字 |
| 「停止做种」图标按钮 | 中性 `.icon-btn`(hover `--text-primary`) | **非 danger**——停做种保留文件、不删磁盘,不用危险色 |
| pill 背景 / 进度条底 / 分隔 | `--bg-selected` / `--divider` | 沿用既有 |

---

# 3. 组件复用规范(✅ 来自已批准原型)

- **主列表工具栏搜索（v1.0，2026-09-17 用户实机已验）**：沿用标题→搜索→“全部开始 / 全部暂停”组，14px/20px padding、10px gap；局部flex自然换行，搜索220px基准/160px下限、input min-width:0，13px输入/12px说明、既有圆角与Token。原文非空（含纯空白）时显示24×24的 `icon-btn` 清除按钮；搜索容器focus-within品牌边框，局部按钮2px品牌focus-visible，不全局移除outline。下方单独一行可换行说明“仅搜索已加载任务；全部开始 / 全部暂停不受筛选影响。”并关联输入描述；两个批量按钮各自的隐藏描述同时作title：“继续所有已加载的已暂停任务，不受导航、类别和搜索筛选影响。” / “暂停所有已加载的下载中任务，不受导航、类别和搜索筛选影响。”。不改1040×680初始/640×560最小DIP或外壳；浅深主题与窄窗实际可达性已于 2026-09-17 由用户实机验证（Windows 11、系统缩放150%，浅/深主题各拖到最小与接近初始两档：换行正常、说明不裁、无横向滚动条、×与按钮可点；窗口 DIP 未精测），不沿用旧窗口实测代签新增控件。

- **任务行(task)**:图标(按类别配色)+ 名称 + 副信息 + 进度条 + 速度 / 百分比 + 操作按钮;覆盖 8 状态(见 §5)。（✅ **Task 9.5** 已完成态操作按钮加**「更多(⋯)」菜单**〔`TaskRowMoreMenu`,自定义轻量 popover〕:锚定 ⋯ `.icon-btn`,结构=**信息区**〔只读:文件大小 / 完成时间 / 保存位置,label→`--text-tertiary`、value→`--text-secondary`、路径 `ellipsis`+`title` 悬浮全路径〕+ **分隔线**〔`--divider`〕+ **操作区**〔「从列表删除(保留文件)」,hover→`--danger`,复用既有 `task:remove`,**不删磁盘文件**§7.3〕;容器色值全走 token〔`--bg-layer` / `--stroke` / `--shadow-flyout`〕、浅 / 深一致、零新造;点菜单外 / `Esc` / 点操作项关闭,底部空间不足向上展开〔不溢出窗口〕;操作区**✅ v0.2 Task 5 补「复制下载链接」中性项**〔在两删除项**之前**,常用 → 危险秩序;新增 `IconCopy` 双叠矩形描边图标;点击 `copyToClipboard(task.source)`=`navigator.clipboard.writeText` + Toast「已复制下载链接」/「复制失败」,**纯渲染零后端**——不经 IPC / 不引 Electron clipboard / 不新增 API〕。**仅 `completed` 态**,其他态零回归。）（✅ **v0.2 Task 2** 新增同范式的**单任务限速** popover `TaskRowLimitMenu`〔`downloading` / `paused` 态操作区前部,IconGauge `.icon-btn`;复用 `--bg-layer` / `--stroke` / `--shadow-flyout` + 点外 / `Esc` / 应用后关闭 + 向上翻转,见 §5〕。）
- **左导航**:任务区(全部 / 下载中 / 已完成 / 失败,带计数)+ 功能区(BT〔✅ **v0.3 Task 3** 激活为可点,见下「左导航 · BT 入口激活」〕/ **浏览器扩展**〔✅ **v0.4 Task 5**,原「嗅探」「接管」两个 `soon` **合并激活**为这一行,见下「左导航 · 浏览器扩展入口激活」〕)+ 底部「历史」(✅ **v0.2 Task 5**,`nav-bottom` 设置**上方**,`IconHistory`,**无计数**——历史总量在历史页统计卡呈现,不污染左导航)/ 设置;选中项左侧 3px 主色指示条。
- **类型筛选 chip**:全部 / 视频 / 音频 / 压缩包 / 文档 / 程序 / 其他;选中态主色 subtle 背景。（✅ Task 6 已渲染 + 真实过滤:文案来自 `category:list` displayName，icon 前端映射，与左导航状态分类正交。）
- **对话框(dialog)**:添加任务 / 格式选择;遮罩 + 居中卡片 + 头 / 体 / 底三段。（✅ **v0.2 Task 1** 格式对话框 `FormatDialog` 在「仅音频」开关之后、落点之前新增**字幕区** `.subtitle-opt`〔仿 `.audio-opt`:标题 `.so-title`「下载字幕」+ 描述 `.so-desc`「下载视频自带或自动生成的字幕(SRT / VTT)」+ `.switch`〕,开启展开:语言多选 `.sub-langs`〔复用 `.chip`/`.chip.active`,文案=`name ?? lang`,自动生成后缀「(自动)」〕+ 格式 `.sub-format`〔`.chip` 二选一 SRT / VTT〕+「含自动生成字幕」`.switch`;**`audioOnly` 开启隐藏字幕区**〔音频提取不配字幕〕、**该视频无可用字幕时开关禁用 + 提示**;复用既有 class / token、**零新造色值**,合规文案诚实〔仅下载已有 / 自动生成,不翻译〕。)（✅ **v0.2 Task 3** 新增**重复检测决策对话框** `DuplicateDialog`(复用 `.overlay`/`.dialog` 三段 + `.btn`/`.pill`/`.select` + token,新增仅布局类 `.dup-list`/`.dup-item`,**零新造色值**):`.dialog-head`「检测到重复下载」+ `.dialog-body`〔诚实说明句 + `.dup-list`〔每项文件名 + 清晰度 `.pill`〔复用基类,`.dup-item` 作用域补 `--bg-selected`/`--text-secondary`〕+「已存在于〈目录〉」+ 命中态文案(completed / diskOnly / active,§5)〕+ 覆盖 / 重命名可逆诚实副文案〕。**单条**(http / 视频)`.dialog-foot` 四决策按钮 `[跳过][重命名][已存在·打开][覆盖]`——「已存在·打开」**仅 completed / diskOnly 可用**(active 无已存在文件不提供);「覆盖」为主操作 `.btn-primary` 但**不用 `.danger` 背景**(避免与「删除」混淆),以文案「旧文件移入回收站(可恢复)」传达可逆诚实。**批量**(playlist)`.dialog-body` 加「应用到全部」`.select`(全部覆盖 / 跳过 / 重命名)+ 逐条覆盖 `.select`(继承),`.dialog-foot` 为 `[取消][确定]`(批量不逐条打开,避免弹一堆窗口)。纯 UI 经 `window.api` 读写、查重 / 决策落地全在主进程(§7.2)。)
- **设置卡片(set-card / set-row)**:每行「图标 + 标题 / 描述 + 右侧控件」;代理用 `radio-row`(单选 + 推荐标签 + 展开输入)——✅ Task 7 落地为自包含 `ProxySettings` 组件(三档 radio + manual 展开 `.input` + 无效态),嵌入设置页;radio 样式 scoped 在 `.radio-row` 下,色值全走 `theme/tokens.css`(`--brand` / `--brand-subtle` / `--danger`),Task 8 设置页骨架直接复用本组件。（✅ **Task 8 落地六分组** `SettingsPage`,对照已批准原型的设置页:**外观**〔主题三档 `.theme-seg`〕/ **下载**〔默认目录 `.path-row` + 最大并发 `.slider-wrap`〕/ **分类与保存位置**〔5 具体类别目录 `.path-row`,**过滤 other**——其目录恒=默认下载目录,已在「下载」组〕/ **代理**〔嵌 `<ProxySettings/>`〕/ **视频**〔默认清晰度 `.select` + 提取音频 `.switch`〕/ **关于**〔版本 + 内核版本 + 检查更新占位 toast〕。复用全局 `.path-row` / `.input` / `.btn` / `.theme-seg`,色值全走 `theme/tokens.css`、浅 / 深一致。)（✅ **Task 8.5 体验完善**:设置页加**左侧分区子导航** `.set-nav`(6 项:外观 / 下载 / 分类与保存位置 / 代理 / 视频 / 关于),点击 `scrollIntoView` 平滑滚动到对应分组、`IntersectionObserver` 驱动当前区高亮,选中项左侧 **3px 主色指示条**〔`.set-nav-item.active`,复用 `--brand`,复刻本节左导航视觉〕;「分类与保存位置」组显示**解析后真实目录**,自定义类带 `.cat-tag`「自定义」标签 + 「重置为默认」、跟随类次文字色无重置;扩展名由只读文案改为**可增删标签编辑器**〔复用 `.chip` 基类〔`.ext-chip`〕+ 删除 `×`〔`.ext-x`,hover→`--danger`〕,末尾输入框 Enter / 失焦新增,扩展名已属他类时弹确认**迁移**〕——**色值全走 token、零新造**,渲染纯 UI、校验 / 落库在主进程〔§7.2〕。）（✅ **v0.2 Task 1** 视频组在既有两行之后追加:**Cookie 来源**〔`.select` 三档「不使用 / 从浏览器 / 从 Cookie 文件」;`browser` 展开浏览器 `.select` + 诚实小字「Chrome/Edge 新版可能读取失败,可改用 Firefox 或 Cookie 文件;读取时请关闭该浏览器」;`file` 展开「选择 Cookie 文件…」`.btn` → `window.api.selectFile` 回显路径〕+ **默认下载字幕**〔`.switch`,langs 非空视为开;展开常用语言 `.chip`〔中文 / 英文〕+ 格式 `.select`〔SRT / VTT〕+「含自动生成」`.switch`〕;经 `onPatch({ video })` 落 `settings.json`,复用 `.set-row` / `.select` / `.switch` / `.chip`、**零新造色值**;合规文案诚实——Cookie desc「使用浏览器中你**已登录**的 Cookie…仅用你自己的登录态,**不保证**可下载受限内容」,**无「破解 / 绕过 / 保证可下 / 翻墙」**。)（✅ **v0.2 Task 2** 下载组在「最大并发」`.slider-wrap` 行**之后**加**全局限速**行〔IconGauge + 数值 `.input`〔`type=number` min=0 step=0.1〕 + 单位 `.select`〔MB/s / KB/s〕,`.limit-control` flex 布局;本地态 `onBlur` / Enter 提交、换算 KB/s 落 `settings.json`——**对 `.slider-wrap` 的合理偏差**:并发 1–10 离散小区间用滑块合适,限速值域跨度大〔几百 KB/s ~ 几十 MB/s〕且需精确,用数值输入 + 单位下拉更实用〔类比 Task 8 `.select` 对原型的据实偏差〕;复用全局 `.input` / `.select`,**零新造色值**〕;视频组在「默认提取音频」`.switch` 行**之后**加 **aria2c 加速开关**〔IconZap + `.switch`,结构逐字同「默认提取音频」〕;合规文案诚实〔§5.4:限速「每个任务各自的上限,单任务限速可覆盖;多个任务同时下载时总速度可能超过此值;0 = 不限速」(v1.0 改,原「均分给所有下载任务」已撤)不承诺「精确保证不超速」也不承诺总带宽上限,加速「不可用时自动回退默认下载器」不承诺「必定加速 N 倍 / 破解限速」〕。)（✅ **v0.2 Task 6** 关于组从「检查更新占位 toast」接**真实自动更新体系**,复用既有类 / token **零新造色值 / 零新造分组样式**:版本行不动;新增**两自动开关**`.switch`〔「自动更新 yt-dlp 组件」/「自动检查应用更新」,默认开 + 诚实副文案〕+ **yt-dlp 组件更新**行〔`IconTerminal` + 「当前 X · 最新 Y|检查中…」+ `.btn`「检查 yt-dlp 更新」;进行中**复用 `.bar`**〔downloading 按 `percent` 填充 span 宽度〕/ **`.bar.indet`**〔checking / verifying 不确定态流动〕,applied / pending-restart / error 经 **Toast 诚实告知**〔非静默〕+ `.up-note` 状态行〔仅 `--text-secondary`,无新色值〕〕+ **应用更新**行〔`IconInfo` + 「当前 vX · 有新版本 Y|已是最新」+ 不静默流程:`available`→`.btn`「下载」→`downloading` `.bar` 进度→`ready`→`.btn-primary`「重启安装」〕+ **未签名诚实小字**〔`.sr-desc`:「应用未做代码签名,Windows 可能提示『未知发布者』→『更多信息 → 仍要运行』」,不隐瞒 SmartScreen,PRD §4.4〕。渲染层**纯展示 + 触发**〔订阅 `onUpdateStatus` 驱动 phase/percent、卸载取消订阅〕,检查 / 下载 / 三重校验 / 原子替换全在主进程 updater〔§7.2〕。)（✅ **v0.4 Task 4** 在「浏览器扩展」组**末尾**追加**「下载接管」子区** `ExtensionChannelSettings` 的 `.set-card.ec-takeover`,三行、**复用既有类与 token、零新造色值**:①**接管总开关** `.set-row` + `.switch`(**默认开** —— 装了扩展即视为授权,与默认关的本地通道 / 剪贴板监控刻意相反;描述「在浏览器里点下载时,由 DownLord 接管。需要安装并配对浏览器扩展。」);②**临时暂停**(`.set-row` + 动态 `.sr-desc` + `.sr-control` 内三个 `.btn.btn-default`,**仿关于组 yt-dlp / BT 组 tracker 的「状态行 + 按钮」组合**;四态文案 `接管中` / `已暂停 · 剩余 N 分钟(至 HH:MM)` / `已关闭` / `本地通道未启动 · 接管不会发生`;时长档**恰好三档纯时间**〔15 分钟 / 1 小时 / 4 小时〕,暂停中时三档换成单个「恢复接管」`.btn-primary`);③**域名例外表**(`.set-row` + **原样复用 Task 8.5 扩展名标签编辑器范式**:`.ext-tags` / `.chip.ext-chip` / `.ext-x`〔hover→`--danger`〕/ `.ext-add` 末尾输入框 Enter / 失焦新增;描述「这些域名的下载不接管,交回浏览器自己处理。」+ **一条常驻说明行**〔2026-08-03 手测补:「填的是『下载地址』的域名,常与网页域名不同(网盘 / CDN 另有一套域名)。接管确认框里『来自 …』那一行显示的就是它,照抄即可。」—— 判定比的是**下载地址的 host**、不是网页域名(referrer 可能为空或被 Referrer-Policy 剥掉,下载地址是唯一一定拿得到的);**不改成同时比 referrer**,一条规则只留一种命中方式,好排查、不意外命中〕)。**新增仅两条布局声明**（`.ec-takeover` 的上间距、`.ec-domain-add` 的宽度〔「+ 添加域名」比「+ 添加」长〕）。⚠️ **界面隔离硬约束**(CONTEXT.md「接管判定」,澄清中人与 AI 各误解过一次):本子区**一个字都不许提「文件类型 / 扩展名」、永不出现扩展名输入框** —— 类别的扩展名清单管「抢过来之后放到哪个目录」、从不拒绝任何文件,接管判定管「抢不抢」,同屏必被误解;**域名例外表只收域名**,且编辑**只在这一处**(嗅探页不重复造)。⚠️ **三行的 `.sr-icon` 位一律保留空占位**(见下「只读诊断行」的 34px 坑)。**诚实措辞守死**:时长档**无「直到关闭浏览器」**(通道无反向推送、sw 空闲即销毁,分不清就不假装分得清)、**无「永久暂停」**(那是总开关,语义与入口都不同);第四态**不写**「扩展尚未连接 · 接管不会发生」——扩展上报 intent 不需要先握手,「本次启动未握手」既可能是没装也可能只是没下载过,故改绑在**确实为真**的判据「本地通道未启动」上,「未握手」另作一条如实陈述、**不下结论**。）
- **BT 文件选择对话框(✅ v0.3 Task 2)** `BtFileDialog`:多文件种子元数据解析出文件清单后进入 `awaiting_selection`,自动弹出供勾选(仿 `FormatDialog` 三段:`.overlay` 遮罩 + `.dialog` 520px 卡片 + 头 / 体 / 底;复用 `AddTaskDialog.css` 骨架 + `buttons.css` `.btn`/`.pill` + `BatchDialog` 的 `.link-btn` 全选链接,**零新造色值 / 色值全走 token**)。五要点:
  1. **头部信息条** `.bt-info`:种子名(ellipsis + `title`,`.bt-name`)+「N 个文件 · 共 X」总大小(`.bt-sub`,`--text-secondary`)——退化自 `.vinfo`,不含缩略图。
  2. **多选方形复选框** `.check`(关键控件缺口补齐:此前仅 `FormatDialog` 圆形单选 `.radio` / `.chip.active` 胶囊多选,无方形复选框):**未选 `--text-tertiary` 描边 / 选中 `--brand` 填充 + 白色对勾**,`5px` 圆角方形——为「文件多选」心智,**沿用 `BatchDialog` 已确立的方形勾选范式**(两处一致,零新造色值)。
  3. **全选 / 反选 + 已选合计头部条** `.bt-bar`:左「全选 / 反选」`.link-btn`(`--brand`,复用 `BatchDialog`)+ 右「已选 N · 共 X」实时汇总 `.bt-count`(`--text-secondary`,`tabular-nums`);**不用** `DuplicateDialog` 的 `.select` 下拉(下拉不适合文件多选)。
  4. **扁平文件清单行** `.bt-list`(边框容器,仿 `.fmt-list`)+ `.bt-row`(**镜像 `.dup-item` 结构**:`.check` + 相对路径 ellipsis + `title` 悬浮全路径 + `.pill` 大小胶囊〔复用 `.pill` 基类 + `.bt-row` 作用域补 `--bg-selected`/`--text-secondary`,同 `DuplicateDialog`〕;`.bt-row + .bt-row` 用 `--divider` 分隔、hover `--bg-hover`、选中 `.sel` → `--brand-subtle`);**MVP 扁平不做树 / 不虚拟列表 / 无半选三态**(§1 克制),上百文件靠 `.dialog-body` `overflow-y:auto` 天然滚动。目录层级靠 `path` 字符串如实展示,不聚合。
  5. **落点行** `.bt-save`(仿 `FormatDialog` `.save-to`:「保存到 `<Torrents>/<种子名>`」,`--text-tertiary` ellipsis)+ **底部** `[取消 .btn-default][开始下载 .btn-primary]`;打开**默认全选**(整包默认,全选 = 整包零回归)、空选禁用「开始下载」(`canSubmit = 已选 ≥ 1`,防呆);取消 / × / `Esc` 关闭,**点遮罩不关闭**(防误触,同 `FormatDialog`)。数据源**直取 `task.torrentMeta.files`**(不经 `getResolved` 拉瞬时态——与视频关键差异);**纯 UI**——选择定型 / `--select-file` 映射 / 落点全在主进程 `TaskManager.applyTorrentSelection`(§7.2),渲染层经 `window.api.applyTorrentSelection(id, 1-based 索引集)` 上抛。自动弹窗复用视频侧 `dismissed` + `isSessionTorrent`(仅本会话主动添加的多文件种子自动弹,重启恢复的不弹);torrent 不接查重,与 `DuplicateDialog` 天然不撞车。
- **接管确认小窗口(✅ v0.4 Task 4)** `TakeoverDialog`:**DownLord 第一个独立 `BrowserWindow` 承载的对话框**(460px、frameless、不可缩放、**不置顶**、任务栏可见)。三态**同窗切换** —— **单条**(文件名 `.input` 可改 + 落点 `.path-row` 可改 + 大小 `.pill`)/ **列表**(`.tk-list` 逐条 `×` 移除 + 统一落点 + `[全部取消][开始下载 (N)]`)/ **查重**(原样挂载既有 `DuplicateDialog`,**组件零改动**)。复用 `.overlay` / `.dialog` 三段 + `.btn` / `.pill` / `.input` / `.path-row` + token,**新增仅布局类** `.tk-origin` / `.tk-list` / `.tk-item` / `.tk-x` / `.tk-label` / `.tk-note`,**零新造色值**(与 `DuplicateDialog` 的 `.dup-list` / `.dup-item`、`BtFileDialog` 的 `.bt-row` 同一先例)。`.overlay` 在独立窗口内**保留**——窗口本身即「模态」,遮罩不再承担「压暗背景」的语义,而是承担 `.dialog` 的**居中与内边距布局**(既有 `.overlay` 是 flex 居中容器,移除它要另写一套定位),故只把背景覆写为 `transparent`(**`transparent` 不是色值**)。**frameless 拖动**:`.dialog-head` 加 `-webkit-app-region: drag`、其内 `.icon-btn`(×)加 `no-drag`——**仅布局两行、零色值**。落点显示 / 传值**原样复用 `saveLocationView` 的 `previewDir` + `pickedDir ?? defaultDir` sentinel**,**不自算落点**。诚实措辞守死:「浏览器那边的下载**已经**取消。点「取消」就不会下载这个文件。」—— 如实告知**已发生**的事实,让用户的「取消」是**知情的放弃**而非意外丢失。
- **任务行 · BT 种子变体(✅ v0.3 Task 3,下载中 / 做种中)**:在既有 `TaskRow` 结构上**加性最小扩展、零新造色值**。①**torrent 下载中**——副信息在「已下 / 总」后中点拼接 `· N 节点`(peers,`connections` 透传);**0 速可观测**:`N 节点 · 等待数据…`(N>0)/`正在寻找节点…`(N=0),消除真机「分不清加载还是卡住」;速度仍 `↓` 下行(`--brand`),actions 不变(`limit / pause / cancel`)。②**torrent 做种中**(`completed && seeding`)——meta 位「做种中」pill `.pill.seed`(`--success-subtle`/`--success`);速度位 `↑ 上行`(`.t-speed.upload`,`--success`);副信息中点文本 `分享率 r · N 节点`(`--text-secondary`);actions 前部加**「停止做种」中性 `.icon-btn`**(非 danger,保留文件)→ `onStopSeeding(id)`,其后仍 `openFile / showInFolder / more`。副信息一律**纯文本中点拼接**(taskView 纯函数内组装,复用既有 `renderSub` 单 text 渲染,**不改 `TaskRowView.sub` 结构、不引 `.dot`**)。富进度(`seeding / uploadSpeed / numSeeders / connections`)为**运行时内存态**(仿 `speed / limitKBps`,不落库),memo 比较器纳入以免变化被吞。
- **设置页 · BT 分组(✅ v0.3 Task 3)**:`SettingsPage` 六分组之外新增「BT · 磁力」组(置「视频」与「关于」间,`.set-group > .sg-title + .set-card`,复用 `.set-row` / `.switch` / `.input`,**零新造色值**):①**做种开关** `.switch`(仿剪贴板监控,默认关);②**分享率上限** `.input`(number step 0.1,本地态 `onBlur`/Enter 提交,仿全局限速);③**做种时间上限(分钟)** `.input`;④**最大连接数(可选)** `.input`(`.sr-desc`「留空 / 0 = 跟随默认 128」)。**诚实措辞守死**(§7.6 / PRD §7):做种是「下载完成后继续把已下载的数据分享给正在下载同一种子的其他用户」「默认关闭——下载完即停止上传」「做种是自愿的,能否连接到其他节点取决于网络环境」;ratio/time「达该倍数 / 时长后停止,任一先达即停,0=不按该维度停」;脚注「通过 aria2 原生做种能力实现」——**无「加速他人 / 私有网络 / 保证上传 / P2SP」**。（✅ **v0.4 Task 1** 同组末尾再加三行,**复用既有类与 token、零新造色值**:⑤**自动更新 tracker 列表**开关 `.switch`(默认开;描述「添加 BT 任务时,若距上次更新超过 12 小时,从公开列表拉取最新的 tracker 地址。拉取失败会继续使用内置列表。」);⑥**tracker 列表状态 + 「立即更新」**(`.set-row` + 动态 `.sr-desc` + `.sr-control` 内单个 `.btn.btn-default`,**仿关于组 yt-dlp 的「状态行 + 单按钮」组合**;四态文案 `尚未更新 / 上次更新 <MM-DD HH:mm> · N 条 / 上次更新失败(原因)· 当前使用… / 自动更新已关闭 · 当前使用…`,`busy` 时按钮文案「更新中…」且 disabled;**手动路径成败都 toast、自动路径永不 toast**);⑦**入站可达诊断**(见下「只读诊断行」,三态如实陈述)。**诚实措辞守死**(§7.6):三行全文**无「提速 / 加速 / 保证连上更多节点 / 装了就能上传」**,不说换 tracker 表会更快、不提 peer 数与连接数;**状态行不提「追补」**(其 announce 实效未经验证,UI 不得暗示);**BT 组内不提代理**(`all-proxy` 不管 BT peer / DHT 的 UDP,提了会误导)。）
- **只读诊断行(✅ v0.4 Task 1)**:**陈述事实、而非可改设置**的行(如 BT 组「入站可达」自检)。**不用 `.set-row` 的「标题 + 控件」**——无 `.sr-title` / 无 `.sr-control`,只保留一段 `.sr-desc`(可叠 `.up-note` 提到 `--text-secondary`),**零新造色值**;与关于组的 `.up-note` 状态行同族(§3 弱化文本)。⚠️ **`.sr-icon` 位必须保留为空占位**(`<span className="sr-icon" />`,不放任何图标)——`.set-row` 是 `flex` + `gap:14px`,省掉占位会让整段文字比同卡片其余行**左移 34px**(2026-07-29 手测发现;同卡片 v0.3 既有脚注行「通过 aria2 原生做种能力实现」本就是这个写法,照抄即可)。读者一眼即知它**不可拨动**,不会误当成开关。**存在的意义**:后续版本接 UPnP 时,诊断结果会新增一条因子(入站可达 = 多条独立证据的汇总),有本规范才不会跑偏成「又一个开关」——新因子只让这段文字变长,不长出控件。文案守诚实死条款:**只报检测到的事实 + 限定条件**(「还取决于路由器与系统防火墙是否放行」),**不承诺打通、不修改任何网络设置**。
- **左导航 · BT 入口激活(✅ v0.3 Task 3)**:功能区「BT · 磁力」由 `soon` 灰显**激活为可点**(仿任务区项:`active={nav==='torrent'}` + 计数 `countByNav().torrent`);点击 = 主列表只看 `kind==='torrent'` 任务。**落在状态维(`nav` / `filterTasksByNav`),与类别维(`categoryFilter`)天然正交叠加**——不塞进 `categoryFilter`(那会与视频 / 音频类别互斥、破坏正交)。**嗅探 / 接管仍 `soon`**(→ ✅ **v0.4 Task 5 已把这两个 `soon` 合并激活为「浏览器扩展」一行**,见下条)。

- **左导航 · 浏览器扩展入口激活(✅ v0.4 Task 5)**:功能区原「网页嗅探」「浏览器接管」两行 `soon` **合并为一行「浏览器扩展」**(图标沿用 `IconTakeover`,`IconSniff` 删除),复刻历史 / 设置的**独立页范式**(`NavKey` 加值 `'extension'` + `App.tsx` 的 `NAV_TITLE` 与三元链各加一支 + 独立组件 `ExtensionPage`,**无计数**)——它是一整页信息、不筛任务,故不走 BT 那种「状态维过滤型」。**继续 `soon` 灰显是不诚实的**:接管在 v0.4 Task 4 已交付、嗅探在 Task 5 交付。**为什么合并而不是各占一行**:两个功能各自都撑不起一整页,合一后一页正好说清「扩展是什么 / 连上没有 / 接管在不在跑 / 嗅探怎么用」。页面三块:①**连接状态**(**只读镜像**,复用设置页 `getExtensionChannelStatus` / `onExtensionChannelStatusChanged` **同一对 IPC**,不新增通道;无端口输入 / 无配对码 / 无重新生成 / 无启用开关,只有「前往设置页配置」)②**接管状态与三档暂停**(可切换,真源在主进程 `takeover.json`,**四态文案与三档时长逐字照搬设置页、不新造措辞** —— 同一状态在两处说两种话是最典型的不一致源)③**嗅探引导 + 隐私说明三句**。**本页无资源列表、无嗅探开关、无域名例外表编辑** —— 三者各有唯一落点(popup / 扩展侧 / Task 4 设置页):资源列表**不经通道上行**故主进程根本没有这份数据,嗅探开关真源在扩展侧而通道无反向推送、显示出来只会是「最近一次听说的」。
- **基础控件**:按钮(primary / default / subtle / icon)、开关(switch)、下拉(select)、进度条(普通 / 处理中 / 不确定 indeterminate)。
- **剪贴板检测提示(✅ v0.2 Task 4)** `ClipboardPrompt`:右下角**克制角标**(复用 `Toast` 的右下角定位与卡片 token `--bg-layer` / `--stroke-strong` / `--shadow-flyout` / `--radius-control`,左 3px `--brand` 色条,仅容器 `pointer-events:auto`——**零新造色值**),结构=类型图标(视频 / 文件,与 `AddTaskDialog` `d-ico` 同源 SVG)+ 标题「检测到可下载链接」+ 类型标签 `.clip-kind`(视频 / 直链下载,`--brand-subtle`/`--radius-pill`)+ URL 一行(尾段可辨、`title` 全量)+ 底部 `[添加]`(`.btn-primary`)/`[忽略]`(`.btn-default`)。行为:**不夺焦**(主进程只 `webContents.send`,渲染层不 `focus`)、**~8s 自动消失**、**同时只一个**(新链接替换旧态)、`addOpen` 时抑制;入场沿用 Toast 上浮淡入,**无其它装饰动效**。是既有 Toast 视觉的克制扩展(原型无 toast / 剪贴板标记),经 DESIGN §1/§3 缰绳复用 token、不另起原型。
- **历史页(✅ v0.2 Task 5)** `HistoryPage`:独立页(左导航「历史」,复刻设置页独立页模式),**100% 复用既有组件 / token 零新造色值**——顶部搜索框 `.input` + 类别筛选**原样复用 `<CategoryChips>`** + 状态 / 时间 `.select`(自定义时间两个原生 `date` 输入);统计区 4 数字卡(今日 / 本周 / 本月 / 累计,`.set-card` 基调 + 仅布局 `.stat-card`)+ 按类别**纯 CSS 占比条**(`--brand` / `--brand-subtle`,宽度=`totalBytes/max` **按数据量降序**(B8 手测反馈:维度用数据量而非数量,数量已在右侧文字呈现),**零图表库**);历史列表**原样复用 `TaskRow`**(视觉与主列表 100% 一致,completed 态天然带更多菜单 → 复制链接一处实现两页可用);空态两子态(完全无历史 / 筛选无匹配 +「清除筛选」)。筛选为**页内独立局部态**,与主列表「状态 × 类别」正交筛选**物理隔离、互不影响**(渲染纯 UI 经 `window.api`,§7.2);`LIMIT 500` 兜底 + 达上限**诚实提示**(不静默截断,DESIGN §1 克制)。

## 窗口尺寸与设置行断点（2026-09-10 实测）

- 主窗口初始尺寸保持 **1040×680 DIP**，最小尺寸为 **640×560 DIP**。用户分别实测的内容区临界值为宽 **624 CSS px**、高 **534 CSS px**；宽留 16、高留 26 的独立余量。本机 zoom=1、DPR=1.5 时 CSS px 与内容 DIP 对应，外框取整差由余量覆盖，不乘 DPR 设窗口下限。
- 设置行按内容宽度自动换行，不另设固定媒体查询断点；文字列下限为 `min(100%, 12rem)`（根字号 16px 时为 192px），控制组不压缩、最大宽度为行可用宽度，组内允许换行。

下表为同机、根字号 16px / DPR=1.5 的相邻宽度实读，单位均为 CSS px：

| 控制组形态 | 换行侧：窗口内宽 / 行宽 | 并排侧：窗口内宽 / 行宽 | 并排时控制组宽度 |
|---|---|---|---|
| 标准路径控制组 | 972 / 522.6667 | 973 / 524 | 251.3333 |
| 含附加复位控件的路径控制组 | 1072 / 622.6667 | 1073 / 624 | 351.6667 |

这些是当前字体与控件组合的内在换行边界，不是跨系统固定断点，也不是窗口最小宽度；更窄时采用纵向排列，而非继续挤压文字列。

## 样式策略与复用约定(✅ Task 4 落地确立,2026-06-24)

> 原「待补 ⬜」据 Task 4 实际实现回填。

- **样式策略**:业务 UI 以 `tokens.css` 驱动的**自定义 CSS class 复刻已批准原型**(每组件一份同名 `.css`);`FluentProvider` 保留供字体 / 主题基线,不强制引入 Fluent 组件(避免与原型像素级漂移,守 §1「多页一致」)。`tokens.css` 已把原型 `:root` / `[data-theme=dark]` 全部变量原样迁入,**禁止另造色值**。
- **何时抽公共 React 组件**:重复 ≥3 次的视觉单元才抽。已抽:`NavItem`(导航项)、`TaskRow`(任务行)。
- **约定 class(沿用原型命名,不过早抽组件)**:按钮 `.btn` / `.btn-primary` / `.btn-default` / `.btn-subtle` / `.icon-btn`(+`.danger`);进度条 `.bar`(+`.indet` / `.proc` / `.paused`);胶囊 `.pill`(+`.wait` / `.action`);类型筛选 `.chip`(+`.active`,✅ **Task 6 已渲染 + 真实过滤**:复刻原型 `.filter-bar`、复用 `.chip` 绝不另造色值,文案来自 `category:list`、不带计数)。公共按钮 / 胶囊 / chip 集中 `components/buttons.css`,由 `App.tsx` 全局 import 一次。
- **(✅ Task 8)控件样式抽取与新增**:`.switch` / `.switch.on`(从 `FormatDialog.css`)与 `.select`(从 `AddTaskDialog.css`,**实测来源**)抽到全局 `components/controls.css`(单一来源,消除「设置页 / 对话框样式依赖彼此 `.css` 被加载」隐患;`FormatDialog` / `BatchDialog` / `AddTaskDialog` / `SettingsPage` 均经 tsx import 引用,1:1 搬运、视觉零变化)。新增滑块 `.slider-wrap` / `.sv` / `input[type=range]` 于 `SettingsPage.css`,**token 化**:轨道用 `linear-gradient`(已填充段 `--brand` 至 `--pct`、未填充 `--stroke`)、拇指 `--brand`、数值 `--text-primary`,`--pct` 由组件按当前值注入(`((value−1)/9)×100%`),Win11 细轨道圆拇指、浅 / 深随 token 自适应。`SettingsPlaceholder.{tsx,css}` 随 `SettingsPage` 落地后删除。

---

# 4. 关键交互(✅ 已确立)

- **主列表搜索/焦点（v1.0，2026-09-17 用户实机已验）**：受控文本框 `role=searchbox`，可访问名“搜索当前列表任务”、placeholder“搜索文件名或来源”、autoComplete off/spellCheck false；输入原文保留，trim+忽略大小写只用于filename/source字面子串匹配，与nav/category AND，无防抖或Enter提交。App保留会话查询，导航/类别及历史/设置/扩展往返不清，App真正重新挂载清空；不持久化、不自动聚焦、不加全局快捷键或逐键aria-live，也不因source命中新添URL展示。×的名称“清除搜索”、title“清除搜索（Esc）”；×和搜索空态清除仅清query并回焦输入，保留nav/category。输入聚焦且原文非空时，非IME Escape清除并阻止这次默认/冒泡；组合ref与native isComposing双守护，组合Escape交输入法、空Escape放行、Enter无动作，每次change含临时组合文本都筛选。DOM顺序为输入→×（有时）→全部开始→全部暂停→chips/行操作，无正数tabIndex；原生Tab/Shift+Tab/IME/焦点已于 2026-09-17 由用户在 Windows 11 系统自带输入法下实机验证；读屏未实测，aria 属性的自动化绿不等于读屏已验。全局批量与nav计数/状态栏始终使用原始已加载集合，无搜索结果也不因此禁用批量按钮。

- **导航**:左导航常驻可点,任意分类项即时切换主列表;顶部与侧栏选中态同步。
- **进度条**:确定态按百分比填充;解析 / 处理态用 indeterminate 流动动画;暂停态进度条转灰。
- **hover**:任务行 / 导航项 / 按钮均有克制 hover 背景;不加干扰性动效。
- **原则**:动效服务于状态反馈(进度 / hover / 切换),不做装饰性炫技。
- **克制不打扰(✅ v0.2 Task 4 剪贴板监控)**:复制到可下载链接的提示为**右下角角标**,**永不抢焦**——无论应用是否聚焦,主进程只 `webContents.send`,**绝不 `focus` / `flashFrame` / `show`**;可「忽略」或 ~8s 自动消失,同时只一个;添加对话框开着时抑制(不叠弹)。隐私诚实:开关默认**关**,设置项旁透明说明「内容仅本机识别、不上传 / 不保存 / 不记录、仅运行时」。
- **必答的阻塞点:独立小窗口 + 一次 focus(✅ v0.4 Task 4 接管确认)**:上一条「永不抢焦」的主语是**剪贴板角标**——一条**可无视的通知**(不理它 8 秒自动消失,代价为零),该口径对**通知类提示继续完全有效**。接管确认框是 DownLord 里**第一个「必须交互才能继续」的阻塞点**:不点它下载就不开始,而浏览器那边**已经取消且零线索**(2026-08-01 实机实测:`cancel()` 4ms 完成、下载**目录**零残渣;2026-08-04 复测补正:下载**条目**会先出现、约一秒后随 `cancel` + `erase` 消失 —— `downloads.onCreated` 是下载**已经创建之后**才触发的,浏览器必然先显示那一条,**做不到「从不出现」**)—— 用户连「我确实点过下载」的旁证都没有。让一个必答的问题永远不出现在眼前,不是克制,是失职。故口径**按形态分两档**:**通知类 → 永不抢焦**(`ClipboardPrompt` 等,主进程只 `webContents.send`);**必答的阻塞点 → 允许对承载它的独立小窗口 `show()` + `focus()` 一次**,且守四条克制:**(a) 主窗口全程不动**(不 `show` / 不 `focus` / 不 `restore` / 不 `flashFrame`,处理完焦点**自然**回到用户原来所在的应用);**(b) 不 `alwaysOnTop`**(不遮挡用户正在工作的窗口——接管的整个价值就是「用户在浏览器里连续操作」,永远置顶会把这个场景直接消解掉);**(c) 不 `flashFrame`**(框已在最前,再闪是噪音);**(d) 同一窗口换内容时不再 `focus`**(不打断用户正在进行的输入)。**新增此类阻塞点必须先在本条登记形态与理由,不得默认继承。**

---

# 5. 各状态视觉表现(✅ 原型已定义)

| 状态 | 视觉 |
|---|---|
| resolving(解析中) | 副文案「正在解析链接…」+ indeterminate 进度条（✅ Task 9.6:行内删除按钮 IconTrash danger → 未完成删除 + 清残留至回收站） |
| awaiting_selection(待选清晰度) | 警告色文案「已解析,待选择清晰度」+ 主色「选择清晰度」按钮（✅ Task 9.6:补行内删除按钮 IconTrash danger）（✅ **v0.2 Task 1**:点「选择清晰度」打开的 `FormatDialog` 内含**字幕区**〔见 §3 对话框;语言 / 格式 / 含自动生成,`audioOnly` 隐藏 / 无字幕禁用〕,解析出的可用字幕语言来自 `ResolvedVideo.subtitles`。字幕作视频**附属产物**旁挂视频文件〔`<清洗名>.<lang>.srt|vtt`〕,不占独立任务行;**completed 态 TaskRow 未加字幕标注**〔可选取舍,MVP 未实现;用户打开视频所在文件夹即见旁挂字幕文件〕） |
| awaiting_selection(torrent 待选文件,✅ **v0.3 Task 2**) | 文件图标(非视频)+ 警告色文案「已获取种子信息,待选择文件」+ 主色「选择文件」按钮(仿视频「选择清晰度」)+ 行内删除 IconTrash danger(沿用 Task 9.6);点「选择文件」打开 `BtFileDialog`(见 §3;多选文件清单 + 全选 / 反选 + 已选合计,默认全选 = 整包)。**单文件种子自动跳过待选**〔无可选,直接整包下载,减少无谓一步,与 Task 1 顺滑体验一致〕;**下载中不提供「重新选择」入口**(选择在待选态定型后不改——aria2 `--select-file` 只在下载启动前可安全变更,换文件集需删任务重加,诚实局限,§6.1) |
| queued(排队) | 灰色「排队中」胶囊 |
| downloading(下载中) | 进度条 + 百分比 + 主色速度(↓);暂停 / 取消按钮（✅ **v0.2 Task 2**:操作区**前部**加**单任务限速入口** `TaskRowLimitMenu`〔IconGauge `.icon-btn` + 自定义 popover,仿 `TaskRowMoreMenu`:点外 / `Esc` / 应用后关闭、底部不足向上翻转、复用 `--bg-layer` / `--stroke` / `--shadow-flyout`〕;popover 含标题「单任务限速(临时,重启后恢复全局)」+ 数值 `.input`〔MB/s〕+「应用」,不回显历史值〔每次打开空 + 占位「不限速」〕;视频任务额外灰字「将在下次继续时生效」〔诚实 §5.4,不承诺运行中即时改速〕） |
| paused(暂停) | 进度条转灰 + 「已暂停」+ 继续 / 取消按钮（✅ **v0.2 Task 2**:同 downloading,操作区前部加单任务限速入口 `TaskRowLimitMenu`） |
| processing(合并 / 转码) | 警告色「正在合并音视频…」+ 警告色 indeterminate 进度条（✅ Task 9.6:补行内删除按钮 IconTrash danger） |
| completed(完成) | 成功色✓「已完成」+ 打开文件 / 打开文件夹 + ⋯ 更多菜单（✅ Task 9.5:信息区 + 从列表删除【保留文件，中性 IconListX】；✅ Task 9.6:追加 danger 项「删除文件(→ 回收站)」→ 成品移系统回收站可恢复） |
| torrent downloading(BT 下载中,✅ **v0.3 Task 3**) | 进度条 + 百分比 + `↓` 主色下行速度;副信息在「已下 / 总」后中点拼接 `· N 节点`(peers);**0 速可观测**:`N 节点 · 等待数据…`(已连接 N 节点、正等数据)/`正在寻找节点…`(N=0);操作与直链下载一致(限速 / 暂停 / 取消) |
| torrent seeding(BT 做种中,✅ **v0.3 Task 3**) | 文件已 100% 落盘(持久化仍 `completed`,做种为运行时);meta 位「做种中」`.pill.seed`(`--success-subtle`/`--success`)+ `↑` 上行速度(`--success` 绿,区别下行蓝)+ 副信息 `分享率 r · N 节点`;操作前部加**「停止做种」中性图标按钮**(非 danger,保留文件 + `.aria2`)→ 停后回静止 `completed`,其后仍打开文件 / 文件夹 / 更多。**做种默认关**(下载完即停);措辞诚实——「做种中 · ↑ 上行速度 · 分享率」,**无「正在加速他人」** |
| error(失败) | 危险色图标 + 可读原因(如「连接超时—请检查 Clash/代理」)+ 重试 / 删除 |
| 主列表原始集合空 | 复用EmptyState：「还没有下载任务」及原添加动作；不被查询词改写 |
| 主列表搜索无结果 | 原始任务非空且归一后查询非空、当前结果空：「没有搜索结果」/「当前导航和类别下没有匹配的任务。可更换关键词，或清除搜索。」/「清除搜索」（既有btn btn-default）；不回显查询，不新做页面 |
| 主列表筛选空 | 原始任务非空、无有效搜索而当前结果空：「当前筛选下没有任务」/「试试其他导航或类别，或添加任务。」及原添加动作；清除搜索后仍可能受导航/类别限制为空 |

---

# 6. 作为 frontend-design 的输入(缰绳)

涉及 UI 实现(写页面 / 组件 / 美化)时:

1. **先读本文件**,把 §1 方向锚点 + §2 Token 作为 frontend-design 的**约束输入**。
2. 避免 frontend-design 默认走「大胆 / 多变 / 难忘」路线——那会与 DownLord 的 Win11 克制工具基调冲突,并导致多页风格漂移。
3. §2 Token 为全局唯一来源;新页面复用,不另起炉灶。已批准原型的 Token 已迁入 `src/renderer/src/theme/tokens.css`,现有页面实现是视觉与交互的**参照实现**。

> 没有这份 DESIGN.md,frontend-design 会自己猜方向(易平庸)且每次不一致(易漂移)。本文件是它的方向盘 + 刹车。

---

# 7. 浏览器扩展 popup(✅ v0.4 Task 5)

> **适用范围仅限 `extension/src/popup/`** —— 那是装在用户浏览器里的第二个可分发工件,与主程序分开构建、分开安装。§2 的 Token 表**不适用于它**(理由见下面第 5 条)。

1. **宽度 380px**(原 280px);高度自适应,**资源区超高时内部滚动**,接管行与诊断区**不被顶出视口**。
   加宽的理由:资源行要放「文件名 + 类型徽章 + 大小 + 下载按钮」四段,280px 会把文件名截到看不出是什么,而**文件名正是用户判断「要不要下这条」的唯一依据**。

2. **三区顺序:本页资源 / 接管状态(常驻一行)/ 诊断信息(`<details>` 默认折叠)**。
   顺序即优先级:资源列表是**日常每次**都看的,配对码 / 端口 / 扩展 ID 是**配置期一次性**用的,高频被低频埋在下面是明确的信息架构错误。
   **连接结论异常时,那一行从诊断区提升为两区之间的常驻行**(正常时折回诊断区)。此模式**不是新发明** —— v0.4 Task 3 的端口提示已有先例(toast + 常驻行)。

3. **两组分组:视频流(m3u8 / mpd,交 yt-dlp)/ 媒体文件(mp4 / webm / flv / mp3 / m4a,交 aria2)**。
   两组恰好等于主进程 `classifySniffed` 的两个出口 —— 用户看到的分组与背后实际走的引擎一致。**空组不渲染**(不显示「视频流(0)」这种噪音)。

4. **资源行四段**:文件名(**CSS 截断,不截字符串**)+ 类型徽章 + 大小(无则 `—`,**不写「未知」更不写 0**)+ 下载按钮。
   **完整 URL 只走原生 `title` tooltip**:长 URL 会撑爆 380px,且 URL 本身对判断「下不下」几乎没帮助。
   ⚠️ **文件名末段在本页内重名时,补上一级目录**(2026-08-11 真机反馈):HLS 站点极常见的形态是
   `_1920_2.7M/prog_index.m3u8` 与 `_864_1.1M/prog_index.m3u8` —— 只显示末段的话,几条清单在列表里**长得一模一样**。
   补的那一级恰好是站点用来区分码率 / 音轨 / 字幕的目录名。**这是呈现不是判定**:不排序、不标注、不猜哪条是主清单,判据是「重名」这个客观事实。**只补一级、不递归**(补完仍重名就止步——完整 URL 本来就在 tooltip 里)。

5. **配色自成一体**:以品牌蓝 `#0f6cbd` 为主色、系统字体、暗色**跟随系统 `prefers-color-scheme`**。
   ⚠️ **popup 不共享 `src/renderer/src/theme/tokens.css`,也不承诺与主程序同步** —— 写在这里免得日后有人来「修」这个不一致。
   两条理由各自独立:① 手抄一份 token 副本 + 约定「两处人工同步」会制造一份**必然漂移**的副本,而人工同步靠自觉、无机器兜底;② 跟随 DownLord 的主题设置要实时查主进程,而**通道可能根本没连上** —— 未配对时 popup 照样要好看,**外观不能依赖连接状态**。
   popup 的色值写在 `popup.html` 的内联 `<style>` 里,**本节就是它的真源**。(MV3 CSP:内联 `<script>` 禁用、必须外链 `popup.js`;内联 `<style>` 允许。)

6. **不静默截断** —— 三行提示逐字如下,与历史页 `LIMIT 500` 达上限时如实提示是同一做法:
   - 隐藏计数:「已隐藏 {N} 个小于 1MB 的媒体请求」
   - 上限提示:「仅显示最近 50 条」
   - 分片提示(按归属分三种,判据只有标签页,**不猜 URL 路径**):恰好 1 条清单 → 挂在该条下方的「已聚合 {N} 片」;≥ 2 条清单 → 挂在**分组级**的「本页有 {N} 个分片请求属于上方清单,不单独列出」;0 条清单 → 一条**灰显、无下载按钮**的「本页检测到分片流,但未找到可下载的清单文件」。
     ⚠️ 分组级那句 2026-08-11 据真机反馈订正过:原文是「本页另检测到 {N} 个分片请求(**已归入上方视频流**)」,用户读成「有 N 个东西被折叠在上面,但我展不开」——「归入」暗示**容器关系**,而真实关系只是**归属**(桶里根本没存分片 URL,展不开是设计)。**此类提示只陈述事实,不得暗示存在可展开的下级内容。**
     ⚠️ 另一处易误读:**{N} 是「浏览器到目前为止请求过几片」,不是视频总片数** —— 用户看 30 秒就关页面,N 就只有几片。**这个数字不能用来判断资源完不完整。**

7. **克制基调延续**(与 §4「克制不打扰」同源):popup **只在用户主动点扩展图标时出现**,**不注入页面、不弹角标、不抢焦**。
   页面**绝不被自动刷新**(用户可能正在填表单)——「强制刷新本页」是一个要用户自己点的按钮。

⚠️ **多条 m3u8 该点哪一条 —— 已知的能力边界,如实写在这里**(2026-08-11 真机反馈):
一个 HLS 视频页常常同时采到 master playlist 与若干 media playlist(还可能有音轨 / 字幕 / 缩略图轨),而**观察型 `webRequest` 拿不到 body**,故我们**无从判定**哪条是主清单。当前只有两个**弱信号**:采集顺序(HLS 里不解析 master 就拿不到任何子清单的 URL,故 master 必然排在前面)与上面第 4 条的重名补目录。
**不做的三件事**:不按 URL 关键词过滤(脆弱启发式,漏报代价大于误报)、不按大小排序(两次真机取证方向相反 —— Apple 样片里 master 最大 29585 B,hls.js demo 里 master 最小 700 B,**大小是噪音**)、不加「这是主清单」的标注(我们并不知道)。
**点错的代价是有界的,这是可以对用户明说的**:点中 master → 清晰度对话框列出多条;点中 media playlist → 照样下得到,只是**只有一个清晰度可选**。**「清晰度只列一条」本身就是「点错了」的信号**,不会出现下不到东西的情形。

⚠️ **措辞纪律两条**(与 `docs/ARCHITECTURE.md` §7.6 措辞红线同口径):
- 提示语一律写「**本页**」,不写「本会话」—— 切了标签页就看不到原页面的资源。
- 扩展侧**不得出现「已配对」** —— 那是 DownLord 侧的词、判据是握手;popup 那一行叫「**配对码**」、取值「**已保存 / 未保存**」(见 `CONTEXT.md`「配对」条)。

⚠️ **核对这两条时判据要收窄到「用户可见文案」,别整目录 grep**(v0.4 Task 5 收口核对实测,本项目第四次踩同一个坑):`grep -rn "本会话" extension/src/` 与 `grep -rn "已配对" extension/src/` **都不可能零命中** —— 命中的正是**记录这两条纪律的注释本身**与**钉死它们的反向测试断言**(`assert.equal(view.empty?.text.includes('本会话'), false)` / `/已配对/.test(field)` 期望为假)。**一条禁某措辞的规范,天然会让那个措辞出现在守它的代码里。**可用的判据是:①跑那几支反向断言(它们才是机器兜底)②要 grep 就只搜产出用户可见字符串的那几个文件(`sniffView.ts` / `popupModel.ts` 的返回值构造处),**不搜注释与 `.test.ts`**。另注:`src/renderer/src/` 里的「本会话」是**另一个语义**(v0.3「本会话用户主动添加的任务」),与嗅探措辞无关,**不该被这条判据牵连**。
