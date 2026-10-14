# 第三轮

- 现场只读日志检查发现原生 user/message 不带 turn，回合身份应来自包围调用的 turn/start。调整证明使用原输入、turn/start、tool/result、turn/end 的顺序与回合匹配。
- `node --test test/dynamic-operation-readback.test.js`：20/20 PASS，无跳过，见 round-3.log。
- 使用现场原日志验证器匹配结果序号 528、结束序号 540。该预览只验证日志内容，活动 Agent/job 的事实仍由部署后的正式 Host 对账核实。
