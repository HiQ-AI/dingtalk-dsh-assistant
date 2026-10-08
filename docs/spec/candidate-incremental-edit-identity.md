# 同代候选增量编辑身份

## 真实症状与排除
SG18 原 Run 第 4 代在事件 42790 正式接纳 candidate-in-place 修复后，保留工作区并重新经过模型提案、验证与 apply。apply 的 nodeRunId 未改变，新 input a297… 与旧成功 edit 的 input 8303… 不同；仅按 nodeRunId/action 生成效果编号导致 DELIVERY_IDENTITY_CONFLICT。只读证明位于 docs/tmp/sg18-in-place-edit-conflict-proof.json：旧 8 个文件仍匹配成功结果，新提案仅编辑另一测试文件。

三种方案：删除身份检查会允许同号异义写，拒绝；换 nodeRunId 受现有唯一约束且需要不必要 schema 迁移，拒绝；采用正式修复事件限定的增量效果身份，不改变节点、Run、generation 或既有函数摘要。

## 最小合同
首次编辑及同输入重投维持现状。仅遇同节点旧编辑输入不同，Host 向控制账读取真实 candidate-in-place 审计：同 Task/Run/generation/workflow，当前节点及新 input 一致，原 invalidated input 对应已成功 managed-edit，事件先后正确，所有先前效果均为已成功 workspace/edit，无外部或未决效果。新身份绑定 nodeRunId、新 inputDigest、修复事件序号与旧 effectId；新定义保存该审计，effect.prepare 事务内再次核验。没有真实审计不能直接生成新身份。

派发前只读核原编辑当前结果，验证新 prepared 不是旧补丁重放（同路径必须以前次目标哈希为基线且实际产生新字节）。旧效果与回执保留；重复合法修复使用稳定身份。现有 dispatch 身份、授权、来源、维护及 lease 检查不变。适配器继续只执行新 prepared。

## 验证
覆盖一次增量、并发/重投不重复、缺失或伪修复、同旧输入异内容、未知/外部效果、原补丁重放、旧记录可读，以及真实原账隔离副本形态。只修改插件和测试，现场由主线程正式恢复。
