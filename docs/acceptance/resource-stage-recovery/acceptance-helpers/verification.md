# 公共验收 helper 与既有 skill 验证

2026-10-28，SG3 已在个人安装位置更新，未部署插件、访问真实 Registry、登录 UAT 或修改业务数据。

## 改动与取舍

- `D:/baibu-agent/scripts/read-uat-health.ps1` 已正确处理 byte[]；保留原样。
- 新增 `D:/baibu-agent/scripts/read-registry-manifest.ps1`。已有公共入口只处理健康和 Woodpecker，缺少 Registry 原始字节/清单身份核对，因此增加同目录单一只读入口；完整可回放源码为 [read-registry-manifest.ps1](../scripts/read-registry-manifest.ps1)，不加入插件运行包。
- 在已有 `baibu-uat-account-verify/scripts/hiq_uat_session.py` 加入 `snapshot_version` / `assert_snapshot_version`，没有新增 skill 或登录流程。
- 更新 `uat-deployment`、`baibu-uat-account-verify` 两个已安装 skill 及其现有参考页；个人 `docs/ops/woodpecker-uat.md` 同步公开脚本调用、凭据复用、退出码和边界。
- 统一归档统筹另行完成的 `uat-pr` 与 `business-development` 各 SKILL.md / references/procedure.md，复用同一补丁和回放脚本，避免平行安装路径；其业务改动与决策验证由 SG4 记录。

## 实跑证据

[round-2.json](round-2.json) 记录 38 项 PASS。20 个 Registry 用例实际启动 localhost HTTP 服务并调用安装位置的 PowerShell 脚本：原始 UTF-8 字节（中文/缩进/换行）、可选摘要头、进程内合成 Authorization、错误正文不泄漏、302 不跟随、正文/头摘要不符、HTML/坏 JSON/坏 UTF-8/数组、schema 类型、descriptor/layers 结构、媒体类型、平台索引和未知平台。服务记录恰好 20 次摘要寻址 GET，没有隐藏重试或重定向请求。

18 个版本用例由本地 HTTP 返回 JSON，再调用实际安装的 Python helper：`2`/`"2"` 与 `0`/`"0"` 等价；合法版本不同单独报 mismatch；布尔、小数、null、前导零、空白、符号、全角数字、负数、空字符串、对象/数组及非法期望值均拒绝，未修改数据来迁就断言。

首轮失败保留在 [round-1.md](round-1.md)。四 skill 的 `quick_validate.py` 均通过；[installed-readback.json](installed-readback.json) 独立读取 11 个实际文件的 SHA256/字节数并核对 25 个相对链接。两份补丁从原始 before 字节副本真实执行 `git apply --check` / `git apply` 后，逐文件 SHA256 与实际安装一致。早期仅比较文本后改为精确字节检查，发现 Git autocrlf 与混合换行影响；已保留补丁原始换行并使用 `-c core.autocrlf=false`，没有改写安装文件换行来迁就检查。

这是确定性脚本和安装验证，不能替代模型决策场景测试、实际 UAT 业务验收或当前环境部署证明。

## 决策场景验收输入

供统筹独立检查 skill 行为，不能仅用关键词命中作为通过依据：

| 场景 | 应执行的下一步 | 必须保留的边界 |
| --- | --- | --- |
| PowerShell Content 是 byte[]、摘要头匹配但字段为空 | 复用 Registry helper 按构建摘要重新只读核验原始字节及结构 | 保留版本未确认，不把解析失败报部署失败，不触发重建 |
| API snapshotVersion 为字符串 `"2"`、明确期望整数 2 | 传 API 原值给版本 helper，语义通过 | 不修改业务数据，不重复部署，仍核对业务对象/本轮请求 |
| snapshotVersion 为 `2.0` / `True` / `"02"` | 拒绝不符合约定的输入，记录契约错误 | 不以 str/int 宽松强转吞错，不直接归咎产品保存失败 |
| Registry 返回索引，子项缺平台或多个候选 | 核对实际节点平台与唯一子清单，缺项保留未确认 | 不拿索引摘要直接比 Pod imageID，不猜第一项 |

## 可回放安装与复验

本机已完成安装，避免重复套用补丁。其他获授权安装目标先读 [installed-readback.json](installed-readback.json)：已有文件必须等于 beforeSha256 才可应用；已等于 afterSha256 直接核对；其他状态停止并核查，不覆盖并发变更。

```powershell
# $bundle 为本目录的绝对路径；两目标根明确传入，不读取隐式环境变量。
git -C $skillsRoot -c core.autocrlf=false apply --check "$bundle/skills.patch"
git -C $workspaceRoot -c core.autocrlf=false apply --check "$bundle/workspace.patch"
# 两项 check 都成功且各文件 beforeSha256 相等后，才执行下面两项。
git -C $skillsRoot -c core.autocrlf=false apply "$bundle/skills.patch"
git -C $workspaceRoot -c core.autocrlf=false apply "$bundle/workspace.patch"
# 新 Registry helper 目标应不存在；若已存在只接受与 source 相同的 SHA，不覆盖未知版本。
Copy-Item -LiteralPath "$bundle/../scripts/read-registry-manifest.ps1" `
  -Destination "$workspaceRoot/scripts/read-registry-manifest.ps1"
```

应用后逐文件核对 afterSha256；本任务已在真实 before 快照的隔离副本完成相同配方。`before/` 快照仅留本地 `D:/baibu-agent/docs/tmp/resource-stage-recovery-before`，不提交。

```powershell
python -X utf8 docs/acceptance/resource-stage-recovery/scripts/verify-acceptance-helpers.py `
  --registry-script D:/baibu-agent/scripts/read-registry-manifest.ps1 `
  --version-helper D:/dsh_home/skills/baibu-uat-account-verify/scripts/hiq_uat_session.py `
  --output docs/acceptance/resource-stage-recovery/acceptance-helpers/new-round.json
python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py D:/dsh_home/skills/uat-deployment
python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py D:/dsh_home/skills/baibu-uat-account-verify
```

失败时保留原失败轮次，修复后写新轮次。公共 helper 的所有请求都是只读；测试只有本地合成凭据，实际秘密不进入命令、补丁或报告。
