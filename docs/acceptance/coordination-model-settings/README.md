# 协调模型第三行配置验收

基线 main `067caa7`（已合 #239）。新增 Agent 配置第三行“协调模型 / 推理深度”，与统筹行共用模型输入和能力请求逻辑、相同桌面列宽及窄屏分组，唯一 Agent 保存入口。原生候选以 provider/model 展示，标签来自同一模型能力，默认独立 `openai-codex/gpt-6-astra/low`，不随执行默认模型改变。

`coordinationModel` 在 resident 设置同一 record 持久保存；已保存值优先于显式 profile，未保存时保留显式 profile，再使用默认值。支持明确继承深度、模型默认、指定深度，provider/model 始终独立。完整预检后保持 native 全局默认→resident 顺序写入，分项回读失败事实，未知不补偿，不承诺两存储原子。保存不写 enabled，不增加启用开关，协调原本关闭仍关闭。

每次 plan 捕获最新模型选择，当前会话不热切，下一次使用新值；工作目录继续读取 Agent 最新工作目录，Task/执行和历史日志根合同保留。

## 实跑证据

- `test/client.test.js test/http.test.js test/observer-client.test.js test/observer-node-control-display.test.js test/observer-slot-compatibility.test.js test/task-model-config.test.js test/coordination-model-config.test.js`：**104 PASS / 0 FAIL / 0 SKIP**。包含 Premium 配置要求的受影响 UI/API 验证。
- `test/coordination-model-config.test.js test/coordination-model-native.test.js test/task-model-config.test.js test/coordination-workspace-native.test.js`：**9 PASS / 0 FAIL / 0 SKIP**。实际原生 Host 验证活动plan不变、下一plan更新、模型默认能力、Owner与执行委派隔离、disabled保存后实际入口不规划。与104有重叠，不相加。
- 另外原协调入口/cwd/语言框架等17项通过，与上述重叠，不计作真实模型回放。
- Chromium加载真实React、完整生成bundle及CSS，API完全由隔离fixture接管：三行对齐、三标签、候选/能力一致、原生select键盘、唯一保存、在途禁用与防重复、刷新与过期刷新、provider/model逐键输入、清空、unsupported阻止保存、失败/部分成功保留草稿、390px无溢出通过。
- 独立审查发现自动补provider前缀会打断逐键输入，已改为原文草稿与失焦规范化；清空后 `pressSequentially('second/limited')` 复验通过，最终只读复审无实质问题。Premium strict静态审计0发现；测试映射299文件守恒、diff检查通过。

浏览器复验脚本：[scripts/browser.mjs](./scripts/browser.mjs)。截图本地交付：

- `/workspace/coordination-model-settings-evidence/coordination-model-desktop.png`
- `/workspace/coordination-model-settings-evidence/coordination-model-error-narrow.png`

Library批量保存通过本次刷新官方helper执行时返回 `hosted apps tools/call request failed: network`；未取得Library ID，不能称已保存。未改换写入接口或盲目重试；截图原件保留。测试日志在 `/workspace/coordination-model-settings-evidence/affected-ui-api.log` 及 `/workspace/coordination-final-evidence/coord-model-backend-final.log`。

未调用真实模型，不等同远端账号/余额或真实模型可用性验收；未启用协调，未修改生产、部署、发版或触发CI。只提交独立PR。
