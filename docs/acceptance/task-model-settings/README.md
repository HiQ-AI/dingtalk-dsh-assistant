# 任务统筹模型配置验收

独立分支 `fix/task-session-model-settings`，基线 `94f99720836e134f0615dc7e02f0f4d4bd72b7e9`。无协调开发代码、依赖或锁文件变更，未部署或修改生产配置。

## 最终行为

Agent 配置内两行模型/推理深度对齐，标签均为“推理深度”，唯一保存配置入口。统筹默认 openai-codex/gpt-6-astra/low；显式inherit及模型默认保持可用。默认模型保留 DSH 原生全局profile含义。统筹保存不改变执行选择；同时编辑默认选择时按用户提交更新。

全量预检后按native profile→resident单record顺序保存，均成功且回读一致才整体成功。没有跨存储事务；失败回读当前有效配置，分项显示默认模型与插件设置是否符合提交值，保留草稿；回读不可用则说明未知，不盲目补偿或重试。活动轮次不变，下一轮正常原Session resume生效。

## 实跑证据

- `node --test test/task-model-config.test.js test/client.test.js test/http.test.js`：43/43。含新默认low、显式继承、读写/重开、两模型预检、native与resident写前失败及已写入但确认丢失的分项回读；保持原生全局保存语义。
- DSH rc2脚本化原生适配器：owner/executor隔离、活动轮次、原Session resume、模型默认与unsupported拒绝。初次12例11过，1例因测试适配器新增high声明破坏原high拒绝断言失败；修正为仅声明low，保留拒绝断言后受影响模型4/4通过。
- 真实Chromium加载React、生成bundle和完整CSS，所有API由内存fixture接管：两标签/low/唯一按钮、列坐标、候选与深度标签一致、保存刷新、模型联动、错误草稿、旧刷新竞态、在途禁用与重复提交、部分写成功回读提示、390px无溢出通过。
- Premium strict 0发现；独立审查要求补齐在途署名禁用，已修正。

## 当前截图

桌面成功态 `libfile_d80466d447508191a4b1e3c3d8b5894c`；窄屏部分写失败 `libfile_9d9c2d67cacc81918a868d49b1d55775`。旧截图不代表最终统一保存布局。

## 边界

未调用真实模型、未验收生产宿主页面/凭据/余额/远端调用；未合并、部署、发版或手动触发CI。不承诺跨存储任意崩溃全有全无。回滚代码不恢复数据库或会话历史。
