# DownLord 第三方许可与声明

本记录核对日期：2026-09-14。记录对象是 DownLord **内置的三引擎实物**，不是最新上游版本，也不代表后来独立热更新的用户可写 yt-dlp 副本。

DownLord 自有代码采用 MIT License，Copyright (c) 2026 lie-dream。第三方代码、二进制及原材料仍受各自许可约束；原作者、版权、条件及免责声明保留不变。已发布版本的许可不撤回。独立子进程是工程边界，不是全部分发义务已履行的证明。

## 内置版本、源码与成品许可

| 引擎 | 版本 | 源码许可 / 配置边界 | 本次可执行成品许可 | 构建 |
| --- | --- | --- | --- | --- |
| aria2 | 1.37.0 | GPL-2.0-or-later | GPL-2.0-or-later | Windows 64-bit build1 |
| ffmpeg | 8.1.2 | GPL-3.0-or-later (this configured build) | GPL-3.0-or-later | gyan.dev essentials；启用 GPL 和 version3 |
| yt-dlp | 2026.07.04 | Unlicense | GPL-3.0-or-later | 官方 stable win_exe，PyInstaller，CPython 3.10.11 AMD64 |

- **aria2**：[发行页](https://github.com/aria2/aria2/releases/tag/release-1.37.0)、[对应 Windows ZIP](https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip)、[对应源码 tar.gz](https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz)。此 ZIP 没有单独的上游校验文件；本地计算的 ZIP SHA256 不称为上游校验。
- **FFmpeg**：[构建来源页](https://www.gyan.dev/ffmpeg/builds/)、[对应 ZIP](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip)、[ZIP SHA256](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip.sha256)、[对应源码提交](https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13)、[该提交源码归档](https://github.com/FFmpeg/FFmpeg/archive/38b88335f99e76ed89ff3c93f877fdefce736c13.tar.gz)。原 README 的短提交 38b88335f9 与上述完整 SHA 对应，并保留了构建配置、外库和相关参考。FFmpeg 默认源码以 LGPLv2.1+ 为主，含宽松许可文件及可选 GPL 部分；本次所选配置/组合适用 GPLv3+，不能把默认 LGPL 当成本 EXE 的全部许可。
- **yt-dlp**：[发行页](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04)、[对应 EXE](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe)、[同版 SHA2-256SUMS](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/SHA2-256SUMS)、[同版源码树](https://github.com/yt-dlp/yt-dlp/tree/2026.07.04)、[同版源码 tar.gz](https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.tar.gz)。源码提交为 997fa140840a08df3938b40da470c78049fef1f6。源码仓库/源码包的 Unlicense 不覆盖合并 EXE 中所有第三方代码；同版 README 的 Licensing 明确将 PyInstaller 合并成品声明为 GPLv3+。

上述入口提供上游同版源码及构建参考，不建立 DownLord 源码镜像。GPL 对应源码等义务须结合实际分发方式和所有适用条款核对；一个链接、npm 扫描结果或“独立进程”均不能代替具体义务已履行的结论。

## 随包原文的位置

安装布局中，本文件位于应用的 resources 目录，以下材料在同级的 **bin/** 内。开发仓库中对应前缀是 **resources/bin/**。关于页“第三方许可与声明”仅打开这份本地文件，不需要在线加载阅读器；打开失败会显示错误。这里使用两态路径说明，避免把仓库链接误当成安装路径。

| 相对 bin 的路径 | 内容及原路径 |
| --- | --- |
| aria2-LICENSE.txt | 原 ZIP 的 COPYING，GPLv2 全文；版本适用范围来自 aria2 的 GPLv2+ 声明 |
| license-notices/aria2/ | 原 LICENSE.OpenSSL、AUTHORS、ChangeLog、NEWS、README.html、README.mingw |
| ffmpeg-LICENSE.txt | 原 ZIP 的 LICENSE，GPLv3 全文；本构建声明为 GPLv3+ |
| license-notices/ffmpeg/ | 原 README.txt、完整 doc/（35 文件）及全部 presets/（5 文件） |
| yt-dlp-LICENSE.txt | 同版聚合文件中的完整 GPLv3 法律文本，逐字节提取，含 0–17 条、结束标记及应用说明 |
| license-notices/yt-dlp/LICENSE | yt-dlp 源码 Unlicense 原文，未冒充成品许可 |
| license-notices/yt-dlp/THIRD_PARTY_LICENSES.txt | 同版完整多平台聚合文件，不按平台删改 |
| license-notices/yt-dlp/README.md | 同版 Licensing 及构建/组件说明原文 |
| license-provenance.json | 原发行/源码/校验入口、取得 SHA256、原路径/目标映射、提取关系和适用边界 |

GPL 提取来源 TPL 的 SHA256 为 b085c65586a953cdb4b13c6390d63ec984d66912e4b6a19e66ba3582f2ed104b；零起算字节区间为 **[43768, 78915)**，共 35,147 字节，直接 Buffer.subarray，不重编码、不改换行。提取结果 SHA256 为 8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903。两种 hash 的对象不同。法律文本取自聚合文件的 GNU Readline 条目，但成品许可依据是 yt-dlp README；GNU Readline 等仅 Linux 条目不据此归入 Windows。

## yt-dlp 聚合文件的平台和条件边界

**聚合许可文件不是 Windows 已实测成分清单。** 不沿用旧版本的“39 组件”清单，也不从条目数量推断 EXE 内含数量。

- Python、SQLite、Brotli、curl_cffi、Mutagen、PyCryptodome、certifi、Requests、urllib3、websockets 有与当前 Windows 自报/既有成分记录对应的同名条目；本次不是穷尽式二进制成分审计。
- bzip2、libffi、liblzma、mpdecimal、zlib、Expat、cffi、pycparser、charset-normalizer、idna **未标平台排除**。这只是原文标注，不等于逐项重新测出了 Windows 内含物。
- ncurses：仅 Linux/macOS。
- GNU Readline、libstdc++、libgcc、libuuid、SecretStorage、cryptography、Jeepney：仅 Linux。
- libintl、libidn2 及其 Unicode 数据、libunistring、librtmp、zstd：仅 macOS。
- Microsoft Distributable Code：仅 Windows；Additional Conditions for this Windows binary build 已内嵌。Microsoft 附加条件仅约束微软可分发代码，不扩大到 Python 或其上程序整体。
- curl_cffi/curl-impersonate 仅排除 yt-dlp_x86 和 yt-dlp_musllinux_aarch64，不排除这次 yt-dlp.exe。
- Meriyah/Astring 未标仅 Unix，原版权及 ISC/MIT 全文已内嵌。KFlash 等署名和 David Bonnet 署名保留；README 对 Unix 包的介绍不是 Windows 排除声明。

### 四项补充原文与 liblzma 的版本分层

以下路径均位于 bin/license-notices/yt-dlp/components/（开发时在 resources/bin/ 下）。

1. **openssl-1.1.1t/LICENSE**：取自 [OpenSSL_1_1_1t 原 LICENSE](https://raw.githubusercontent.com/openssl/openssl/OpenSSL_1_1_1t/LICENSE)，同时含 OpenSSL 和 Original SSLeay。当前 Windows 自报 OpenSSL 1.1.1t；聚合文件中 OpenSSL 3.0+ 的 Apache 条目不能替代它。二进制的版权、条件、免责与原许可要求的署名/致谢均保留。

   This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/).

   This product includes cryptographic software written by Eric Young (eay@cryptsoft.com).

   Eric Young 广告致谢仅在原文的广告条件成立时适用；Tim Hudson 致谢仅在包含 apps 目录的 Windows 特定代码或其衍生代码时适用。完整英文原文决定条件，不把条件式广告/apps 条款改成对所有代码的无条件要求。

2. **requests-2.34.2/NOTICE**：来自 [Requests v2.34.2 NOTICE](https://raw.githubusercontent.com/psf/requests/v2.34.2/NOTICE)，原文为 Requests / Copyright 2019 Kenneth Reitz。聚合文件的 Apache 正文不能代替这份 NOTICE。
3. **certifi/index.f75d2927d3c1.txt**：由 [Mozilla MPL 索引](https://www.mozilla.org/MPL/) 指向的 [MPL 2.0 完整原始纯文本](https://www.mozilla.org/media/MPL/2.0/index.f75d2927d3c1.txt)，保留原名、完整 1–10 节及 Exhibit A/B；CA bundle 的来源/MPL 声明不是许可全文。
4. **liblzma/COPYING.0BSD**：同版 TPL 的 XZ Licensing 索引已与 [固定提交的 COPYING](https://github.com/tukaani-project/xz/blob/70f1f203789433b5d7b8b22e1655abc465d659f7/COPYING) 逐字节对应；保存该提交的 [COPYING.0BSD 全文](https://github.com/tukaani-project/xz/blob/70f1f203789433b5d7b8b22e1655abc465d659f7/COPYING.0BSD)，不以总览或链接代全文。0BSD 致谢不是法律强制；XZ 构建系统的 GPL 不因此适用于所构建的二进制。

   **另存 liblzma/xz-5.2.5/COPYING**：[CPython v3.10.11 构建属性](https://github.com/python/cpython/blob/v3.10.11/PCbuild/python.props) 与 [外部源码清单](https://github.com/python/cpython/blob/v3.10.11/PCbuild/get_externals.bat) 指向 XZ 5.2.5，其 [固定构建源原 COPYING](https://github.com/python/cpython-source-deps/blob/c6bc0c612605622aaef101a33a751f9de2ecc193/COPYING) 声明 liblzma 为公有领域。旧版 XZ 的公有领域许可不被追溯改为 0BSD。上述 0BSD 是同版聚合索引的完整配套文本，不宣称已从 Windows EXE 测得新版 liblzma；两份来源分层保留，不把四种 COPYING.* 源码索引扩成全套 XZ GPL 交付要求。

## 其他范围与分发边界

- npm 扫描按锁定输入读取各 package.json 的 license 元数据，产品面为根 dependencies 加 React/React DOM/Fluent UI 闭包，其余为构建面。它不是实际 bundle 清单、许可证原文检查或全包合规证明；历史“141 个宽松 JS 依赖”也不是当前结论。
- Electron/Chromium、原生组件及实际安装展开文件须按其原许可和真正产物另外核对。这里保留的三引擎材料、源代码途径和构建信息不取代那些对象的检查。
- 所有第三方文本保持原字节，原始版权/免责不因项目采用 MIT 改变；原文有不同语言表述时以适用许可原文为准。本文件提供技术来源与许可材料索引，不承诺下载内容的版权或平台 ToS 授权。
