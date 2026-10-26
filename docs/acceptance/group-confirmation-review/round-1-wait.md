# SG1 群业务答复与等待解除验证

2026-10-26，工作分支 `worktree-group-confirmation-review`。仅修改当前隔离检出，未操作真实任务库、发送钉钉消息、提交、推送或部署。

## 实现与边界

- 新接纳的同任务、同群、`im` 来源，消息时间不早于待答问题且不晚于当前时间，才能生成复核候选。发起人与其他业务成员统一进入只读核对；普通补充不再直接解除 requester 等待。
- 统筹保持原会话、租约体系、需求版本及执行身份，只认领本次候选唤醒；执行结果、巡检和其他唤醒保持未消费。未判断为答复时保存 wait 结论并消费本次候选，不重复空转。
- `task_human_resolve` 要求当前只读复核租约、当前问题、已接纳候选来源及非空理由/证据。完整原文、真实作者、来源、租约、判断理由和证据入账，不能用话题摘要作为答复。角色与语义对应由统筹结合原文判断，Host 校验来源与状态边界，不以任意群成员消息自动批准。
- 存储、服务回调及原生工具门禁共同拒绝复核轮派发、续办、反馈、取消、完成和写入。解除后本轮仍只读，以 wait 结束；独立 `human.responded` 唤醒由下一正常统筹轮接续。
- 待答补充不提前转发给运行中执行；原执行、作业及原来源保留。明确授权/目标改变仍走已有 replan、取消旧授权执行的路径。Web/operator 与精确私聊身份答复保持原边界。
- 空返回/暂态模型失败保留候选并沿原有有界退避恢复。工具错误上限保留实际错误到 `reviewFailures` 和决定记录，不 ack、不当作空返回自动重试；只有新合格候选 wake 才重新复核，普通摘要/旧来源/Web 导致的 context 变化不重新激活。既有 provider 重试预算不被工具错误清空。

## 最终实跑

命令使用 PowerShell 7，`TEMP` 与 `TMP` 指向本目录下 `round-1`。原生宿主依赖预检确认 `DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json` 可用；没有跳过 native 测试。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `node --test test/dynamic-task-store.test.js` | 117 PASS，0 FAIL，0 SKIP；9.765 秒 | `round-1/store-final-2.log` |
| `node --test test/task-session-human-native.test.js` | 12 PASS，0 FAIL，0 SKIP；56.784 秒 | `round-1/human-native-final.log` |
| `git diff --check` | 无空白错误 | 本轮独立命令回读 |

关键反例包括：伪造 sourceId、过期租约、空证据、旧/未来/跨群/Web 来源、operator 群答复、发起人无关消息、复核前后派发与完成、真实 native write 拒绝、执行结果不能越过等待、成功解除幂等且后续 wake 不被 ack、crash/provider-failure/已解除但未 drain 恢复、工具失败重启保留及非候选 context 不激活。正常完成后旧申请再次答复也仍拒绝。

原生组合用例的 none、empty、tool-limit 分别覆盖正常解除、实际空返回后原会话退避恢复、连续三次伪造来源触发真实工具上限。原生验证使用真实宿主、工具、持久化和调度，模型为受控测试模型；不代表真实钉钉成员业务验收或线上模型语义质量已经验证。

## 本轮修正记录

首次新增组合夹具没有实现历史 Topic 标题迁移和回复候选审阅，导致辅助会话未收敛；最终为初始化提供短标题，并按原生 `group_reply_review_get` 读取候选后提交 substantive 回复，不修改或绕过业务运行门禁。空返回分支一度错误断言未调用过的拒绝工具输出，已仅在实际调用拒绝工具的分支断言。

独立审查发现初版把工具上限错误一概转换为 `TASK_SESSION_NO_SUBMISSION`；现已分离真实空返回与明确工具错误，补齐新合格候选恢复、非候选反例和重试预算保留验证。无代码缺陷被作为夹具问题跳过。

## 主会话继续核对

其余 service/provider/progress/dialogue/coordination/model 集成回归及交付说明由主会话负责。真实业务角色是否足以回答原问题仍需模型读取完整来源作判断；本轮证明原生边界、恢复和审计，不将受控模型结果当作真实业务语义验收。
