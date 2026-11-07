# 小蝌蚪点读制作 Mac 版

源码仓库：[jadechoulu/reading-pen-maker](https://github.com/jadechoulu/reading-pen-maker)。仓库使用通用名称，便于后续扩展其他点读笔；当前功能和界面为独立的小蝌蚪制作工具。

最新正式版本：[0.3.1 下载与发布说明](https://github.com/jadechoulu/reading-pen-maker/releases/tag/v0.3.1)。

独立的离线 Electron 应用，面向 Intel Mac（macOS 13 及以上）。本地管理书籍、导入 MP3、对应点读码、试听并生成普通 NOB V3；另提供独立的批量转 MP3 工具。

## 使用

1. 解压 Intel ZIP，双击里面的 `Electron.app`。应用窗口和菜单名称为「小蝌蚪点读制作」。首版保留这个应用文件名以兼容已验证的 Intel 运行时，请暂时不要重命名；也可把它连同外层「小蝌蚪点读制作」文件夹放到「应用程序」。
2. 新建书籍，导入 MP3。`10000.mp3` 会识别为码值 10000；`10000-1.mp3` 和 `10000-2.mp3` 会识别为同一码的多段音频。
3. 在表格填写或修改码值、音频说明，用上下箭头调整顺序，点击「保存修改」。同一码的音频按表格顺序连续播放。
4. 「连续填码」仅填写空白项，跳过已有的码值。只有你确认一组实际贴纸码连续时才使用。
5. 点击「生成 NOB」，选择输出目录。成品使用独立新文件名，生成记录可定位输出文件。

此版本有书籍列表、表格编辑和试听，没有 PDF/书页热点编辑，也不会通过书名或图片自动读取纸上微型点码。已经铺码的书需提供原有码值；普通书需使用与笔兼容、码值已知的点读贴纸。多本书使用互不重叠的码段。

## 独立批量转 MP3

侧栏点击「批量转 MP3」，选择多个 WMA、MP3、WAV、M4A、AAC、FLAC、OGG 或 AIFF，再选择保存位置。应用在该位置新建「毛毛虫云盘_MP3_ABR128_时间_编号」文件夹。每个文件完整解码检查后，使用 `libmp3lame -abr 1 -b:a 128k` 转为 MP3；不强制设置采样率或声道，MP3 编码支持范围内沿用原音频。输出再次完整解码，检查时长差不超过 0.15 秒。同名文件自动加序号；失败项单独列出，成功项保留，源文件不会删除或修改。文件夹内的「转换记录.json」保存逐项结果、时长和 SHA256。

此预设来自用户在「处理毛毛虫标准音频格式」会话中的 MP3／ABR 128 kbps 配置，用于准备毛毛虫云盘上传音频；不是厂商完整规格，也不是小蝌蚪 NOB 要求。ABR 的 128 kbps 是编码平均目标，实际值随内容变化。本工具只生成本地音频，不自动上传云盘。转换窗口右上角提供带云朵图标的「小彼恩网盘」入口，点击后在默认浏览器打开 https://cloud.xiaobien.com/，方便手动上传转换结果。

## 文件与边界

- 制作与转码全程离线，不需要 Windows、Python、Java 或另装 FFmpeg。应用自带 Intel Electron 和 FFmpeg。
- MP3 导入时复制到本机资料库，不移动、不重命名、不修改原始文件。应用资料通常位于 `~/Library/Application Support/小蝌蚪点读制作/library/`；备份时退出应用后复制整个资料库。
- 从 0.2.0 起，生成 NOB 时只验证 MP3 能否完整解码，直接打包原始音频字节；不重编码，不改变采样率、声道或码率。0.1.0 曾固定转为 44.1kHz／单声道／64kbps，这只是当时的实现选择，没有被证实是小蝌蚪要求，已取消。
- 成品用本地 `book_id=0`、`customer_id=54` 的 NOB V3 普通点位格式；连续真实码值合并成范围，不占用中间未使用的空码。
- 成品保存后重新读取，核对长度、头校验、正文摘要、点位和每段音频内容。适用目标是支持此类 NOB 的小蝌蚪 T6；本工具生成的新书仍需真实点读笔验证安装、切书和点读。文件核对通过不等于设备验收。
- 本版不含 NOD/NOS、厂商账号、设备授权、DAB/XDR 转换、字幕、双语场景或互动游戏，不调用原软件 Windows DLL，不使用其内嵌测试账号或凭据。
- 应用为个人用途独立实现，非厂商官方 Mac 客户端。Electron 保留官方 x64 原始二进制，应用未签名、未进行 Apple Developer 公证。如果系统提示无法验证开发者，可在确认来源后使用 Finder 右键「打开」，或系统「隐私与安全性」中的「仍要打开」。

## 版本更新（0.3.0 起）

侧栏或应用菜单打开「版本更新」。默认启动时和每 6 小时检查公开 GitHub Releases；「发现新版后自动下载」可单独开启。安装始终需要点击「安装并重启」并确认。可选择是否接收候选版本，公开库无需 GitHub Token。

流程参考点读包工坊：按版本与当前芯片选择成品，核对 GitHub 提供的大小和 SHA256，再检查 ZIP 路径、符号链接、应用标识、版本、最低系统版本及主程序／Framework／FFmpeg 架构。应用退出后由 macOS 自带 `/bin/sh` 和文件工具替换；新版本完成资料库加载与界面初始化后确认启动，失败则恢复旧 App。安装不触碰书籍资料库，不需要安装 Python、Node.js、FFmpeg 或 CLI。

网络只用于固定 GitHub 更新服务，书籍和音频不会上传。源码模式使用 Git 更新。App 必须放在可写目录，不能直接在磁盘镜像或系统隔离的临时位置更新。首次从 0.1/0.2 升级到 0.3 需要手动替换完整 App；旧版本没有更新模块。自实现更新中的 GitHub SHA256 校验不等同于 Apple Developer ID 签名，当前 Electron 仍未签名、未公证。

后续发布约定：GitHub Release tag 为 `v主版本.次版本.修订号`，Intel 附件必须是打包脚本生成的 `reading-pen-maker-版本-macos-x64.zip`；同时发布源码包可使用其他名称。应用只选择完成上传、具有 GitHub SHA256 digest 的匹配架构安装包。首个正式 Release v0.3.1 已发布，包含 Intel 安装包、源码 ZIP 和 SHA256 校验文件。

## 开发与构建

需要 macOS、Node.js 22.12+。依赖版本由 package-lock.json 固定。

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build
npm test
```

打包脚本会下载并核对固定版 Electron x64、FFmpeg x64 和 GPLv3 全文，构建 Intel 应用；分发中包含 FFmpeg 的许可、构建来源和上游源码位置。构建好的应用无需下载任何内容。

`npm start` 会自动准备 Intel Electron 和音频工具；Apple 芯片电脑运行此 Intel 开发版需要 Rosetta。`npm run build` 会准备独立运行时，可直接运行生成的 App。只有首次准备依赖需要联网。

`npm test` 中的音频集成测试需要先准备内置 FFmpeg。`APP_PATH='/绝对路径/Electron.app' VALIDATION_DIR='/新的验收目录' npm run test:e2e` 验收真实成品。只替代系统文件对话框选择，导入、试听、独立批量转换、NOB 生成和重启读取均运行真实逻辑。独立 Python 格式核对需要 Python 3，也可通过 `REFERENCE_PYTHON` 指定其可执行路径；用户日常使用不需要 Python。

`APP_PATH='/绝对路径/Electron.app' UPDATE_VALIDATION_DIR='/新的更新验收目录' npm run test:update` 使用独立 App 副本执行真实升级和启动失败回退，并逐文件核对书籍资料库 SHA256；仅替代 GitHub 响应和安装确认，不上传测试版本。

## 格式来源与许可

NOB V3 普通点位格式沿用本机点读包工坊中的 `vendor-engine/bnl_to_nob.py`、`package_tool.py` 已核对布局，重新以 JavaScript 实现普通连续播放；原项目代码未修改。FFmpeg 来源为 `ffmpeg-static b6.1.1`，为 GPLv3 构建，随应用保留许可和对应构建资料。Electron 许可证及 Chromium notices 由 Electron 包保留。私人音频、书籍和资料库不随应用打包。

构建说明：本机 macOS 26.6.2、Apple Silicon + Rosetta 对照中，保留 `Electron.app` 文件名时可运行；同一副本仅修改外层应用文件名后，GPU/网络辅助进程退出，恢复原名又可运行。具体系统原因未确证，首版保留官方应用文件名、内部进程名称与原始二进制，设置独立的应用标识、菜单名称和图标；不重写 Framework，不关闭页面沙箱。原始发行 ZIP 使用 Electron 官方 SHA256 校验。Electron 未做 Developer ID 签名和 Apple 公证，FFmpeg 保留单独的本地签名。Rosetta 流程通过不等于 Intel 原生硬件或真实点读笔通过。
