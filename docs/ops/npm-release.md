# npm 正式发布

本仓库使用 npm Trusted Publishing（OIDC）从 GitHub Actions 发布三个公开包，不再使用 `NPM_PUBLISH_TOKEN` 或 `NPM_TOKEN`。GitHub Actions 的短期身份只用于 `npm publish`；npm 查询和 GitHub Release 分别使用公开 registry 与 `github.token`。

## 一次性配置

在 npmjs.com 的以下三个包中分别打开 `Settings → Trusted publishing`，添加同一条 GitHub Actions 配置：

- `@zzusp/dingtalk-dsh-observer`
- `@zzusp/dingtalk-dsh-assistant`
- `dingtalk-dsh-assistant`

配置值必须完全一致：

| 字段 | 值 |
| --- | --- |
| Organization or user | `HiQ-AI` |
| Repository | `dingtalk-dsh-assistant` |
| Workflow filename | `release.yml` |
| Environment name | `NPM_PUBLISH` |
| Allowed actions | 允许 `npm publish` |

npm 保存配置时不会验证字段。三个包都配置完成后，再将 Publishing access 设为 `Require two-factor authentication and disallow tokens`；Trusted Publisher 不受该 token 限制影响。修改 Trusted Publisher 或 Publishing access 必须由维护者交互式完成 2FA，不能用 bypass-2FA GAT 代办。

GitHub Environment `NPM_PUBLISH` 保留审批/保护规则，但应删除不再使用的 `NPM_PUBLISH_TOKEN`、`NPM_TOKEN`。不要在仓库、Environment 或 workflow 中新增写权限 npm token。

## 发布

1. 同步根包、assistant、observer 的版本号，并更新 `CHANGELOG.md` 的版本章节和 Release 链接。
2. 在本地使用 Node.js 24.19.0 执行 `pnpm install --frozen-lockfile`、构建和 `pnpm test`，再检查三个实际 `pnpm pack` 产物。
3. 将版本改动合入 `main`，创建指向该提交的带注释 `v<version>` Tag 并推送。
4. `release.yml` 在 GitHub 托管的 Windows runner 上安装固定 npm 12.0.2，通过 `id-token: write` 获取 OIDC 身份，按 observer → assistant → 根包发布。Trusted Publishing 会自动生成 provenance，无需 `--provenance`。
5. workflow 最多等待约两分钟回读三个精确 npm 版本；全部一致后才创建带三个 tgz 的 GitHub Release。

Tag 推送未触发或某个包发布失败时，可以手工运行 Release workflow，并输入已存在、指向 `main` 历史的 Tag。不要为重试创建新版本或新 Tag；先修正 npm Trusted Publisher 配置，再对原 Tag 使用 `workflow_dispatch`。重跑时，workflow 会对已存在的包比较 registry `dist.shasum` 与本次 tgz SHA-1：一致才跳过，不一致立即停止；缺失的包继续按依赖顺序发布。任何 `npm publish` 非零退出都会立即停止，不能被后续命令掩盖。

## 验证与故障定位

发布完成后分别回读，不能用 Actions 成功替代 registry 或 Release 证据：

```powershell
npm view @zzusp/dingtalk-dsh-observer@<version> version --registry https://registry.npmjs.org/
npm view @zzusp/dingtalk-dsh-assistant@<version> version --registry https://registry.npmjs.org/
npm view dingtalk-dsh-assistant@<version> version --registry https://registry.npmjs.org/
gh release view v<version> --json tagName,url,assets
```

OIDC 发布失败时依次核对：workflow 使用 GitHub 托管 runner；权限含 `id-token: write`；npm CLI 不低于 11.5.1；三个包的 Trusted Publisher 均精确匹配组织、仓库、`release.yml` 和 `NPM_PUBLISH`；三个 `package.json` 的 `repository.url` 精确指向当前公开仓库。`npm whoami` 不会显示 OIDC 身份，不能用它判断 Trusted Publishing 是否生效。
