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

## 待部署

本地正式profile仍运行上一包；需精确安装本候选、回读配置为gpt-6-sol，并在重启后验证持久值与后续真实模型请求。业务响应正确性与模型账户授权另行按真实请求结果判断。
