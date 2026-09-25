# 第八轮：两项真实 UAT 任务发布与业务回归

本轮状态以 `matrix.csv` 的 `round_8` 列为准。P05 是两项业务任务在各自目标环境的发布与业务验证；P04 是本地 Assistant Host 四类外部流程准入，两者不能互相代替。

| 用例 | 结果与证据 |
| --- | --- |
| P04 | FAIL：本地 Resident 精确安装、健康和客户端摘要解析均已验证，但 Host profile 尚无四类平台目标及受信凭据装配，工作流目录继续显示 unavailable。此次真实 UAT 发布由目标仓库 PR 与 Poller 完成，未由 Assistant 工作流发起。成功构建的同提交重建门禁通过隔离测试，未重复触发真实成功流水线。 |
| P05 | PASS：dataset-web 草稿任务由 PR #369 合入 UAT2（merge SHA `198e04afffff02dc1e865fe65f6eefff8a07f4ac`），Woodpecker #318 成功，构建/Registry/Pod digest 同为 `sha256:50460dc619700691cdfadabfbb0f5cb179eab182ce19c07b628efd7e0c9be299`。最终环境 dataset-web 420/420、dataset 515/515 且均 Ready 1/1，独立 Chrome 重新完成保存→离开→重进，恢复提示与内容正确、服务端写入 0、控制台错误 0，测试标记已清理。dataset 合并任务由 PR #374 合入 UAT3（merge SHA `6d87153d09f645b2b461db87ce0451057c168fc4`），Woodpecker repo1 #276 success，Pod `dataset-5f89c6594b-mwqk2` Ready，Registry/Pod digest 均为 `sha256:cc00a10a126a34c1239497f6d6bf5dce96b3a2cbd51ac4379996caf29dba7d7e`，`/api/dataset/ready` HTTP 200/UP。受控 0.5 kg→t 双来源场景从修复前预览 `0.001 t` 变为 `1 t`；真实 do-merge 结果 `21dc07d5-4246-4092-b9ad-62aa0c4a5d39`，独立数据库连接回读 7 行，参考结果为 `1 t`，其余目标组为 `2000000 kg`。来源夹具 finally 恢复成功，独立 `--check` PASS。 |

UAT3 修复在提交前完成 25/25 定向测试与 Maven 打包。先前误投到 UAT2 的 dataset 改动已通过 PR #373 和 pipeline #275 恢复：UAT2 目标源码与误投前字节相同，回滚镜像和 Ready Pod 摘要相同；上述 UAT2 页面回归是在此最终状态重新执行。两个 UAT 流程的隔离测试覆盖交付与同提交重建；真实成功流水线不为测试重复构建。