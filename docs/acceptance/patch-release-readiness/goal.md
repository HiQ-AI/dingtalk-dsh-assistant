# 目标
修复发布阻塞并发布2.0.1，npm三个包和GitHub Release均独立回读。保留无关工作与历史事实，不减测试不放宽预算和安全门禁。

## sub goal matrix
| 子目标 | 状态 | 证据 |
| --- | --- | --- |
| 版本准备与三包检查 | PASS | docs/tmp/release-2.0.1-pack |
| 完整测试失败归类 | 进行中 | docs/tmp/release-2.0.1-tests.log |
| 最小修复及定向回归 | 待完成 | |
| 完整发布检查 | 待完成 | |
| 版本合入与Tag发布 | 待完成 | |
| npm及Release回读 | 待完成 | |

## 决策
2026-10-19：用户明确授权先修复发布阻塞，再发布。普通CI不手工触发，使用既有Tag发布流程。人工技术回复用例单独重跑仍出现inputVersion预期2实际1，不能当作一次性并发失败。

## 修复进展
- 上下文根因：超预算字段是contextPath，旧fixture未读就以executions.length判断。改为先通过真实model_content_read读取，最多4条独立读取同轮并发；不直接读取私有快照、不改变产品3000字节预算。人工回复7/7通过。
- Windows三例EPERM发生在file symlink创建阶段；改用原生directory junction验证最终路径重解析点拒绝，POSIX保留file symlink。增强原文件不变/外部目录零新增断言。9/9通过，Windows file symlink未验证的边界明确保留。
- Provider未恢复用例真实执行3次冷审阅和后续事件，新增真实引用读取后31.8秒完成全部断言，超出原30秒；仅该分支测试墙钟预算60秒，Provider生产重试/冷却次数不变。
- 两代工程用例第一代16节点真实成功，耗时187.156秒；第二代仍正常推进时撞240秒。仅此用例按每代原240秒设2*240000，完整两代定向复核中。
- 初次全量日志保留，不将失败改写为通过；修复回归覆盖全部导入受影响公共fixture的26个测试文件，最终Tag发布workflow仍运行完整pnpm test。

技能剩余失败是专用TEMP的ACL：当前用户仅Modify，native grantWrite需要ACL控制。仅专用测试根增加当前用户继承FullControl，未改产品策略；原技能断言不动，5/5通过。
