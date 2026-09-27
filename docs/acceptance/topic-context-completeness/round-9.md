# 第六至九轮：消息过程可读性、耗时与共享批次

## 用户选择

默认界面优先展示处理步骤与判断结论；随后增加每步耗时，以及连续同话题消息的共享批次来源。

## 改动

原消息、当前状态置顶；步骤展示事项、关联对象/依据、意图动作及限制；原始输入输出折叠。耗时使用本次 startedAt/completedAt，缺失不报零，进行中显示已用时，重试注明次数。共享判断以 nodeRunId 保持唯一，列出同群来源消息及发送者/时间，高亮当前来源，可切换查看其他来源自己的处理记录。后续重判保持独立记录。

trace API 增加 message、startedAt、attempt、topicTitle、sourceMessages，保持群边界；只读取已有账目，不写业务状态。

## 失败与修正

- 第六轮 81/82：默认详情重构时遗漏了历史缺口未知的解释文字，补回。
- 第七轮组合 82/82；随后优化容量原因中文表达，observer 单测 8/9，旧断言要求原错误码在默认文字中。错误码保留到技术详情，更新展示断言。
- 第八轮 103/104：另一断言要求“必要材料未能完整提供”，统一中文措辞后重跑。
- 浏览器多步骤夹具最初命中多个同名折叠项；改为明确定位当前判断的详情，完整复跑。

## 最终证据

- 第九轮 `node --test test/observer-client.test.js test/workflow-service.test.js test/http.test.js`：104/104 通过，0 失败、0 跳过，28.83 秒。见 round-9/tests.log。
- 完整 React/observer、Edge headless：20 项通过，17 次只读请求、0 写入、0 页面错误。覆盖结论直接可见、详情默认折叠、390px 无横向溢出、键盘、耗时、同批切换后判断不重复、话题分页及返回。见 round-9/browser-results.json。
- premium strict 静态检查无 findings；见 round-8/premium-audit.json。静态扫描不替代浏览器验证。
- 截图仅本地保存，脚本可再生成；浏览器夹具不证明真实钉钉收发或真实模型判断质量。

## 本地更新回读

停机前仍为 72 completed、1 waiting，无 running/queued；备份位于 D:/dsh_home/backups/readable-trace-20260926-bde8dee，保留 profile、控制库/工件、Domain 和会话，此次无 schema 迁移。原生 CLI 安装两个独立 tgz，83 个 JS/patch 文件哈希全部匹配源码，profile patch 未改变。新 PID 54208 同时监听 3080/18998；health=ok、inboundProcessing=true、recoveryIssueCount=0、DWS healthy=true、listener=ready、backfill=ok，带认证 Web 200。真实消息 trace 返回原文及 5 个有开始/结束时间的步骤，两个判断记录各返回 1 条真实来源。多消息共享分组与切换由隔离浏览器夹具验证，未人为制造真实业务消息。
