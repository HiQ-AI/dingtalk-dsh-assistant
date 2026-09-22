# 第20轮：同稿检查点重启恢复

## 修复与回归

生产权限核查Task原报告已收到协调reject，但input-wait后重启时存储schema重排字段，JSON字符串比较误判另一待审稿。使用原生结构相等，按原报告形状恢复待审对象并保留checkpointId/submittedAt，复用既有审阅ID；不修改全局指纹算法。

- `node --test`：630/630 PASS，0 fail/cancel/skip，58.37秒；输出round-20/full-tests.txt。
- 真实字段顺序变化、input-wait重启、已持久reject组合反例通过：报告接收一次、审阅一次、原ID不变、拒绝仍拒绝；真实不同稿继续failed且不覆盖旧checkpoint。
- 生产部署及原报告重试待独立回读。三条旧重开Task因历史Session缺失保持queued，不计为恢复。
