# DWS Bridge Recovery Plan

| 项目 | 内容 |
| --- | --- |
| 症状 | Web 健康显示正常，但群消息未持久化；DWS 可直接读到遗漏消息。 |
| 根因 | listener 退出无重连、初始补拉误用不完整读取、范围读取被 500 条上限截断、健康接口未包含 bridge 实态。 |
| 修复 | listener 监督重连、无上限的 range backfill、bridge 状态快照与 HTTP 健康降级、告警恢复顺序串行化。 |
| 验证 | bridge / adapter / runtime / HTTP 回归、全量测试、包清单检查；合并部署后再做存活/health/状态回读。 |
