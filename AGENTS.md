# 小蝌蚪点读制作

- 仓库通用名为 reading-pen-maker，后续可扩展其他笔；当前应用名和资料库标识保留以兼容已有书籍。

- 默认中文。此处是独立 Electron 应用，不修改原 Windows 程序或点读包工坊。
- 首版范围为本地书籍、MP3 导入、码值映射、试听、普通 NOB V3 制作；不接入厂商账户、NOD/NOS 或设备授权。
- 用户原件只读；音频复制至应用资料库，生成的包使用新文件名。
- Intel 目标为 macOS 13+ x64；实际交付需验证成品启动和生成包，Rosetta 测试不等于 Intel 实机测试。
- 打包不携带私人书籍、音频、测试资料库；个人数据不提交 Git。
- 安全边界是 Electron IPC 和文件选择；renderer 不接受任意文件系统权限。
- NOB 制作保留 MP3 原始字节，只验证完整解码；不得把毛毛虫云盘的转码预设套用到小蝌蚪。
- 独立「批量转 MP3」使用用户指定的毛毛虫云盘 MP3／ABR 128 kbps 配置，输出新目录，保留源文件；这不代表厂商完整规格。
- 更新源固定为 jadechoulu/reading-pen-maker 的公开 GitHub Releases，不需要 Token。安装包名 reading-pen-maker-版本-macos-x64.zip；使用系统安装脚本，不依赖用户安装 Python 或 Node。
