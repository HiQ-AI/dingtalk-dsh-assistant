# 常驻回复 Steer 门禁验收报告

## 结论

Round 1 的 30 个用例全部通过。常驻主会话现在会在非空回复可靠提交前声明并校验其已审阅的全部同群普通 Steer；消息是否相关、部分相关或独立仍由模型判断，Runtime 没有加入关键词、上一条消息或固定时间窗规则。

## 已验证行为

- 新 Steer 影响回复时，与原请求合并为同一 submission 并重新生成完整 Decision。
- 新 Steer 不影响回复时，可以仅观察并保持 pending；当前回复写入可靠 Outbox 后再继续处理。
- 提交瞬间存在未观察消息时，旧候选原子拒绝，不执行 Task 动作、不写 Outbox。
- Decision、recheck 和 Task 完成/等待通知使用同一语义屏障；Task 通知通过独立 `group_reply_submit` 提交。
- 同群门禁只线性化 `reply commit → next steer admission`；其他群和并行 Task 不受该门禁串行。
- Outbox 落库前工具不返回成功；落库后的发送监听器失败不反向否定 Decision。首次完成通知写入失败可按稳定结果键补发。
- 完成通知补发跳过已无群目标的历史 Task，并隔离单项 Resident 故障，后续有效群不会被饿死。
- 配置切换、历史导入、退订和关闭覆盖 transition 前后两种调度，不会换掉仍在使用的 Resident 或形成 Task/群尾链死锁。

## 质量证据

- 聚焦 Runtime：48/48 PASS。
- 关键竞态压力回归：20/20 PASS。
- 全仓测试：147/147 PASS。
- Web 生成物一致、`git diff --check` 通过。
- 三个 npm 发行包均成功生成并完成 SHA256 回读。
- 独立只读审查未发现 P0/P1。

## 未声称的范围

本报告不把单元测试或 fake adapter 当作真实钉钉群的业务 E2E。真实模型在具体群语境中的相关性判断质量、真实 DWS 投递和跨进程崩溃恢复仍是独立验收层。
