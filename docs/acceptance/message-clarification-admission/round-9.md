# Round 9：共同锚点修正后真实回放

- 同批 PASS，23165 ms：四条来源绑定同一话题，仅最后明确开发消息产生一个 create 候选；标题摘要演进，无无关 SQL。
- 逐条 FAIL，40774 ms：话题始终为一个，但仅材料加点名阶段擅自生成 research，最后开发又生成 create，累计 2 个而非 1 个。原始失败保留在 round-9/native-topic-replay/topic-chain-sequential.json。

根因是把“授权不明按分析”的执行范围限制误读成凭空创建分析任务。修正通用提示边界：尚无处理动作的材料加点名只记录 fact；明确动作后才创建 Task。没有硬编码四条正文。

证据：round-9/native-topic-replay/summary.json 及两例 JSON。实际模型 openai-codex / gpt-6-sol / low；隔离 store，无业务外部效果。
