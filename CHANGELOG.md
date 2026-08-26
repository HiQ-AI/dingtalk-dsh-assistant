# 更新日志

本文件记录 `dingtalk-dsh-assistant` 每个正式版本的用户可见变化。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，日期使用 `YYYY-MM-DD`。

## [0.4.0] - 2026-08-26

### 新增

- 增加单一发行包，可通过 DSH 插件命令一次安装 resident Runtime、设置页和任务看板。
- 设置页展示当前版本，并基于 GitHub Release 检查新版本。
- 增加 CHANGELOG 和插件市场发现所需的仓库元数据。

### 变更

- assistant、observer 与发行包统一使用同一个产品版本号。
- Node.js 最低版本与实际 zstd Runtime 要求一致，调整为 24。

[0.4.0]: https://github.com/HiQ-AI/dingtalk-dsh-assistant/releases/tag/v0.4.0
