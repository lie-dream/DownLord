# 内置引擎与许可材料

本目录的三个 Windows EXE 是已核对的内置基线。2026-09-14核验只修正来源/静态版本登记，不替换 EXE、不升级引擎，也不把应用版本同步到引擎版本。

| 文件 | 实际版本 / 构建 | 成品许可 | 字节数 | SHA256 |
| --- | --- | --- | --- | --- |
| aria2c.exe | 1.37.0 / Windows 64-bit build1 | GPL-2.0-or-later | 5649408 | be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2 |
| yt-dlp.exe | 2026.07.04 / stable win_exe / PyInstaller | GPL-3.0-or-later；源码 Unlicense | 18226085 | 52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8 |
| ffmpeg.exe | 8.1.2 / gyan.dev essentials | GPL-3.0-or-later | 101897728 | 1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e |

精确来源、全量逐文件 SHA256/字节数/原路径、平台限制及提取关系在 **license-provenance.json**。它记录原材料和本地实物，不是安装器内容或离线体验签收。第三方声明的唯一维护源是仓库根 **THIRD-PARTY-NOTICES.md**。

## 原发行材料及同版源码

### aria2 1.37.0 Windows 64-bit build1

- [发行页](https://github.com/aria2/aria2/releases/tag/release-1.37.0)
- [原 ZIP](https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip)，SHA256：67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288。
- 此 ZIP **没有独立上游校验文件**；以上是自算 hash。包内 aria2-1.37.0-win-64bit-build1/aria2c.exe 与本地 EXE 逐字节相同。
- [对应源码](https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz)，SHA256：8e7021c6d5e8f8240c9cc19482e0c8589540836747744724d86bf8af5a21f0e8；configure.ac 版本 1.37.0，源码/发行包 COPYING 相同。
- 原 COPYING → aria2-LICENSE.txt。其余原名 LICENSE.OpenSSL、AUTHORS、ChangeLog、NEWS、README.html、README.mingw → license-notices/aria2/。保留 OpenSSL/Original SSLeay 条件，不以“独立进程”代替分发义务。

### FFmpeg 8.1.2 gyan.dev essentials

- [来源页](https://www.gyan.dev/ffmpeg/builds/)、[原 ZIP](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip)。
- ZIP SHA256：db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec，与[对应 .zip.sha256](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip.sha256)一致；ZIP 校验与包内 EXE/本地 EXE 的上述 hash 分开记账。
- 原 README 短 SHA 38b88335f9 对应[完整源码提交 38b88335f99e76ed89ff3c93f877fdefce736c13](https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13)。[该提交源码归档](https://github.com/FFmpeg/FFmpeg/archive/38b88335f99e76ed89ff3c93f877fdefce736c13.tar.gz) SHA256：2ae7e42343cfffb811d15cfe98b6d005f082595fcdf034d30a4ff90cfed9f9c6。
- 包内 bin/ffmpeg.exe 与本地相同，自报 --enable-gpl / --enable-version3 和 GPLv3+；不是默认 LGPL 构建，也不是“最新版”承诺。
- 原 LICENSE → ffmpeg-LICENSE.txt；原 README.txt、完整 doc/（35 文件）、全部 presets/（5 文件）→ license-notices/ffmpeg/。不分发原 ZIP 中的 ffplay/ffprobe EXE。

### yt-dlp 2026.07.04

- [发行页](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04)、[EXE](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe)、[SHA2-256SUMS](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/SHA2-256SUMS)。EXE 官方同名校验项、取得文件与现有内置 EXE 相同。
- 自报 stable@2026.07.04 / 997fa1408 / win_exe / CPython 3.10.11 AMD64 / OpenSSL 1.1.1t。[同版源码树](https://github.com/yt-dlp/yt-dlp/tree/2026.07.04)、[源码包](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.tar.gz)，SHA256：31c32457d1a573a341bb0929386c624fe47339a5338829e6e9c9454bdfa7397a，也匹配同版校验表。
- 同版源 LICENSE（Unlicense）、完整 THIRD_PARTY_LICENSES.txt 及 README.md 原样位于 license-notices/yt-dlp/。README Licensing 明确 PyInstaller **合并成品 GPLv3+**，不拿源码许可冒充成品许可。
- yt-dlp-LICENSE.txt 从该 TPL 的零起算字节区间 **[43768, 78915)** 提取，共 35147 字节，保留 GPL 0–17 条、结束标记和应用说明。原 TPL SHA256：b085c65586a953cdb4b13c6390d63ec984d66912e4b6a19e66ba3582f2ed104b；提取结果：8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903。Buffer.subarray 不重编码/改换行；Readline 条目提供法律文本不等于 Windows 内含 Readline。
- components/ 下保留 OpenSSL 1.1.1t LICENSE、Requests 2.34.2 NOTICE、Mozilla 原名 index.f75d2927d3c1.txt（MPL 2.0 全文）、同版 TPL 固定 XZ 索引的 COPYING.0BSD 全文，以及 CPython v3.10.11 构建源对应 XZ5.2.5 原 COPYING。0BSD 配套索引与旧版公有领域范围分别记录；不将文本标注冒称逐项 EXE 成分实测，不追溯改许可。

## 打包与字节保持

- electron-builder 的 extraResources 从本目录复制三个明确命名的 EXE、三份规范全文、license-notices/ 的全部核定材料和 license-provenance.json 至 **process.resourcesPath/bin**。
- 根 THIRD-PARTY-NOTICES.md 自动复制到 **process.resourcesPath/THIRD-PARTY-NOTICES.md**，不维护第二份声明、不用 resources/licenses、不把临时下载/解压目录加入打包。
- .gitattributes 只为三份规范全文和 license-notices/ 原件设置定点 -text；其他文件仍用全仓 LF 规则。修改/补充引擎时必须重新核对版本/构建/全文/条件/来源/hash，不能只更新登记使冲突消失。
- 可用 PowerShell Get-FileHash -LiteralPath 后跟确切文件路径及 -Algorithm SHA256 复核；自算 hash 不自动成为上游签名或校验证明。

## 运行时定位、版本与热更新边界

- 开发态内置根为 app.getAppPath()/resources/bin；打包态为 process.resourcesPath/bin，由 locator.resolveBinDir 决定。扩展仍独立复制 extension/dist → resources/extension，不与引擎目录合并。
- ENGINE_VERSIONS 是探测前/失败时的静态回退值；关于页优先显示 probeVersion 启动后台探测的真实版本。它与内置实物基线一致，不与 DownLord 应用版本联动。
- yt-dlp 运行时优先用户可写副本，再回退内置 EXE；aria2/ffmpeg 始终使用内置位置。本次仅对齐静态登记，既有探测、首次复制及独立热更新行为不改。本目录许可记录不冒称覆盖未来热更新的任意版本。
- 启动存在性自检不等于 SHA256/许可审计；npm 许可扫描的静态 ENGINES 表也不验证 EXE 或实际安装展开内容。
