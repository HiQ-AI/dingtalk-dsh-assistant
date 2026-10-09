# 会话恢复集成验证

本轮仍在实施，尚未部署，不代表五个原任务完成。

- 执行底座、工作流合同、Owner 原生会话与动作账、HTTP 和 Observer 相关六个测试文件联合实跑：267/267 PASS，80.9 秒。完整日志 `docs/tmp/conversation-integrated-regression.log`。
- 任务详情当前步骤投影相关测试：4/4 PASS。任务专属节点通过 Host 当前定义的可信 `revisionRoles` 投影 `templateNodeId`，沿原 Observer 中文职责名称展示，避免动态节点改名后只显示“执行步骤”。Observer 实跑 27/27 PASS。
- 真实云模型回放首轮正确选择受管检查配置，第二轮收到陌生 Host 错误后改变策略；第二轮提交被 Owner 额外证据范围校验错误拒绝。证据 `docs/tmp/native-owner-revision-cloud-4/summary.json` 及原生会话事件。此次结果 FAIL，正在修复，不将脚本模型验证替代真实模型闭环。
- 原运行服务健康、原定义恢复和隔离工程全链验证见 round-68；现场四个工程任务仍需新包部署后推进及真实业务验收。

## 现场只读预演发现

`docs/tmp/four-current-recovery-preflight.json` 沿真实控制账验证恢复能力，没有业务写入。SG18 实际要求的 reviewedPaths 只有一条，当前原生读取记录吻合，原编辑审计及九个成功效果存在。SG19 当前方案含等值替换，后缀保留两次成功编辑，不能用零效果删除夹具推断可直接删节点；修复原方案续行门禁并保留编辑。SG20 检查在 Host 重启后保留 drained=false，不能因效果账为空就称无操作系统子进程；需真实进程排空证明与后续持久生命周期记录。SG22 的旧 accepted/blocked 决定需自动将完整诊断交回原 Owner，不能只支持新失败。

这些真实路径仍在修复，不称本轮已根治。

未提交或推送本轮代码。
