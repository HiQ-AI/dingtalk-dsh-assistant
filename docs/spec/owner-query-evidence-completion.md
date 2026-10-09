# Owner 历史查询证据完成验收

当前 controller 每轮已通过 readTaskEvidence 从持久登记读取工件并验证 Task、需求版本、原 turn/lease、来源引用及结果摘要；workflow-service 的 authorizeCompletion 再通过该读取器收集当前证据，核引用绑定、交付清单和领域验收。readArtifacts 是当前工具调用轮的临时 Map，不能代表同原生会话是否已知不可变证据。因此仅对具备 Host authorizeCompletion 的 complete 路径去掉重复的本轮重读要求；没有 Host 验收回调的路径不放宽。领域拒绝诊断可引用 Host 已核验的当前需求 queryEvidence，仍拒绝外国 Task/旧版本/未知引用。

不新增持久 read-mark，不自动完成、不复用旧语义验收回执。Host 每次候选继续重新读取证据并实际验收。验证同会话前轮查询后本轮不readArtifact仍进入Host；外来/陈旧引用、缺证据、实际事实不足继续拒绝，真正拒绝诊断仍能交回Owner修正。
