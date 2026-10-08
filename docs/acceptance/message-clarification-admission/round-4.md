# 定位模型纠错反馈不足

工作方式和按文档开发通过；必要澄清仍失败。模型把 intent 字段放到 decision 顶层，通用 schema 错误无法指出具体位置，多次修正后退出而未提交决定。见 `round-4/native-replay/`。

修复：沿当前原生工具反馈返回 schema 字段路径，并说明澄清字段位于 unit.intent、checkedSourceRefs 使用 sourceKey。新增对应失败形态的回归，不通过增加模型或盲目重试掩盖错误。
