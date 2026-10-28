# 第三轮相关回归

- stale-context 新例及两个既有有效绑定 no_submission 用例：3/3 PASS。
- provider-native 整文件：13/13 PASS，0 skipped。旧版本排空后沿原唤醒、同 session lease 1→2 接续；已成功读取不重放，无技术退避。正常空提交、provider 冷却、重启与恢复预算均保留。
- service-native 整文件：45/45 PASS，0 skipped/cancelled。覆盖单执行、并行、11 成员、32 次续办、取消排空、队列及共享资源；本轮只改变职责边界相关夹具。
- 独立源码审查未发现阻断项：绑定准确工具对象、管理工具限制、旧绑定 return 经 finally 排空，均与目标一致。晚注册局部工具仍可能显示 schema，不能声称所有 schema 均隐藏。
- 两处剩余提示词同步为执行会话做业务操作和写产物，统筹读已有证据；人审错误码更新与 guard 顺序一致。
- node scripts/test-suites.mjs check：314 个文件各出现一次，历史 3、删除 0；未改映射。源码及说明文档 git diff --cached --check 通过；原始日志空白与 unified patch 上下文空行保留，二者不参与 whitespace 检查。

跨轮共 93 个不同的相关用例最终通过（7 + 13 + 45 + 28），没有把重复复验计入数量；五文件首轮的两个未通过项分别在第二轮复验。完整日志和首轮失败均保留。
