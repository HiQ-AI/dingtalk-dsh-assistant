# 插件发布与版本检查

## 目标

将当前仅支持本地 `file:` 安装的双包插件整理为可从 GitHub 安装、可被社区 DSH 插件市场发现的单一发行物，并在 DSH 设置页展示当前版本、CHANGELOG 和新版本状态。

## 现状

- 根包和两个子包都标记为 `private`，且三个版本号不一致。
- 根包没有 DSH bundle 描述，`dsh plugin --profile web add github:HiQ-AI/dingtalk-dsh-assistant` 无法装配两个子插件。
- 仓库没有 Release 和 CHANGELOG，UI 也不展示版本。
- DSH 官方提供 npm/GitHub 插件发布与安装机制；当前可见的插件市场均为社区项目，尚无官方统一市场。

## 方案

1. 根包作为唯一面向用户的发行包，通过 workspace 依赖携带 assistant 与 observer 两个子包，并用根 bundle patch 一次装配二者。
2. 三个包使用同一产品版本，根 `package.json` 作为版本真源；发布时同步更新三处版本。
3. GitHub Release 的 `v<version>` tag 作为线上最新版本真源。resident Runtime 通过 GitHub Releases API 检查并缓存结果，Web 客户端只访问本机 Runtime，避免浏览器跨域和多处版本判断。
4. 设置页始终展示当前版本；检查成功时展示最新版本和 Release 链接，失败时明确展示检查失败，不把失败当作“已是最新”。
5. CHANGELOG 使用 Keep a Changelog 结构，并在设置页提供仓库 CHANGELOG 链接。

## 验证

- 单元测试覆盖语义版本比较、无 Release、上游失败与缓存。
- `pnpm test` 验证现有 Runtime 契约未回归。
- `pnpm pack --dry-run` 验证根发行包包含 bundle patch、README、CHANGELOG，并携带两个子包依赖。
- 独立读取 package tarball 清单和 git diff，确认版本一致且没有本机配置或凭据进入发行物。
