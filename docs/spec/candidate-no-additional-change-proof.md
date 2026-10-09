# 同代候选无新增修改的完整树证明

SG18 已有两个成功 managed-edit；正式同代修复后模型选择 no-change（先前补丁仍在文件中，不应重复应用）。冻结 v18 的 apply 将当前完整候选树强制与最初 mergeTree 比较，因而误拒绝合法保留编辑。不能修改冻结 execute 源码导致全部旧定义摘要漂移，也不能把任意错误变成成功。

在 Controller 受信 code 执行边界，仅对工程 apply-changes/version6 的精确 ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT，调用领域验证器。原节点已经完成 no-change proposal/schema、已读路径、workspace身份和冲突检查；领域验证器另外要求当前正式 candidate-in-place 修复事件、当前 binding、原成功 managed-edit，以及同代仅成功 workspace/edit 效果。无修复、首次 no-change 或未决/外部效果仍原错误。

以成功 workspace 的原 mergeTree 为唯一基线，按成功 edit 因果顺序逐文件核 expectedHash 并叠加目标字节；用 Git blob 身份和文件模式核对当前完整 frozen tree。多余/缺失 tracked/untracked 文件、非法模式、未审计字节变化全部拒绝。比较的是完整候选，不只是 reviewedPaths 或已编辑文件。不会抹去原 diff，也不执行文件写。

证明通过后产出正常 no-change 节点结果，summary明确本轮无新增修改、保留既有候选继续验证，不声称业务需求完成。独立 engineering-no-additional-change-proof 工件含当前身份、修复审计、旧效果链、原 mergeTree、实际 tree/candidate digest，随正常 node.commit evidenceRefs 原生事件持久化。提交仍走原 CAS/来源/控制/维护检查。

验证用真实 Git+managed-edit：初次 no-change无修复拒绝、正确修复保留全部diff、tracked额外变化/untracked新文件拒绝；另读取真实原账快照及复制工作区到docs/tmp隔离证明。业务验收仍待实际实现和验证，不把noop当FR完成。

## 已等待节点的恢复入口

旧 v18 已持久等待 `ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT` 时，仅部署新执行边界还不会再次领取节点。恢复扫描精确识别 apply-changes/version6：全部节点排空、无待接纳输入、无未知/进行中效果，并使用同一完整树验证器证明原 candidate-in-place 审计与当前 binding。证明成功后重读 Run revision/generation/node input/lease，再调用既有 controller.recover；下一次执行重新证明并正常提交证据。每个 nodeRunId/inputDigest 在当前服务进程仅尝试一次证明，失败保留等待，不加入通用暂态重试。不改原 Run、generation、成功前缀和编辑效果，未核验业务验收仍不可完成任务。
