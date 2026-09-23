# M2 候选交付最终本地回归

2026-09-23，沿用 round-4 环境与全部合成范围。

`pnpm test` 最终读回：**708 tests / 708 pass / 0 fail / 0 cancelled / 0 skipped**，113.2秒。覆盖本轮17项新增测试及M1/旧路径回归。旧100ms计时竞态修订后，全量原生Session排空测试通过，历史失败见round-4。

实际Git组合测试使用受信代码检查固定字节，无模型、shell业务测试或生产写入。模拟commit回执丢失后，unknown只读对账，再恢复push；远端SHA独立读取，commit/push各1次，原HEAD不变。完整验证回执保存在prepared和控制账，超64KiB拒绝。

重新 `pnpm --filter @zzusp/dingtalk-dsh-assistant pack`，独立 `tar -tf` 读回10个execution模块，包含新增candidate/delivery/git。包SHA256：`7DE7631EDD56EBD640ACF674B7F00FCF53F31609F39B07FA38F8E0AAEAA6BE24`。`git diff --check`通过。

## 仍未完成

M2整体保持进行中：没有自动开发工作区/新代基线管理、真实项目shell验证、远端GitHub PR适配器、业务结果通知或真实任务准入；仅本地bare remote。权限回调必须由受信Host接真实授权，参数字段不是认证凭据。旧resident未加载此入口，未合并部署，未证明生产性能改善。
