# 第22轮：默认处理模型热更新

## 症状与根因

现场`D:/dsh_home/settings.yaml`已保存`gpt-6-sol`，插件`GET /state/agent-config`仍返回`gpt-5.6-sol`；直接`PUT /config/agent {model:gpt-6-sol}`在7条非终态Task存在时返回400 `agent_config_has_active_tasks`。

根因有两项：模型选择与工作目录共用活动Task门禁，导致插件页面保存被拒；Runtime启动时复制一次`agentDefaultModel.currentSelection()`并长期缓存，因此DSH原生设置更新也不会进入插件读回或模型请求。

## 修复

- 活动Task期间允许保存模型和推理深度；工作目录切换仍受活动Task门禁保护。
- 配置读回、Agent创建、状态查询及每次提示组装均读取DSH原生默认模型服务的当前值。
- 提示组装时复制本次选择，已组装的在途请求保持原模型；下一请求使用新模型。
- 页面和手册明确生效边界。

## 验证

- 针对性3/3：活动Task保存、在途请求稳定/下一请求更新、DSH原生外部变化同步读回和请求。
- `node --test`：633/633 PASS，0 fail/cancel/skip，47.69秒；完整输出round-22/full-tests.txt。
- Web客户端重新生成；`git diff --check`通过。

## 本地部署与真实请求回读

- 部署前自检v9数据0 invalid/stripped/unknown，识别7条非终态Task及当前DSH进程树；按既有中断重启授权停止后备份完整存储/profile至`D:/dsh_home/backups/default-model-f9e67af-20260923`，备份hash一致。
- 源码f9e67af，包SHA256 `601805A1DE622E0A79C708C4FE749711A646836C710E2590856CB7530F2DD969`；34个JS安装摘要逐一匹配，Observer及其它依赖保持。
- 新PID113788于10:46:52启动，3080/18998同进程；认证Web握手303、页面200 HTML。健康ok、恢复告警0、入站处理与DWS桥接正常。
- `D:/dsh_home/settings.yaml`持久值及`GET /state/agent-config`均为`openai-codex/gpt-6-sol`、reasoningEffort low。
- 部署后8个不同协调/任务Session的真实`request/context`记录均为`openai-codex/gpt-6-sol`，证明实际请求已切换，不只页面回显。脱敏证据见runtime-readback.json；不包含正文或凭据。
