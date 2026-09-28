# 第三轮

`node --test test/runtime.test.js test/task-owner-session-native.test.js`：167 项全部通过。负责人原生测试新增目录与持久化标题断言。第二轮其他相关测试已通过，最终仅复跑变更相关部分。

原生 `loadBaselineInstructions` 对照检查：普通目录默认 `.git` 标记未读取父根指引；显式配置 `.git`、`AGENTS.md`、`CLAUDE.md` 后读取成功。部署文档明确根标记要求，不能默认普通目录自动继承。使用独立临时 home 排除全局 AGENTS.md 造成的假阳性。

本机清理：555 → 193，移出 362 个会话（351 个已终态临时协调、9 个明确测试、2 个空白）。逐文件校验归档 SHA256，原目录已不存在；原生列表删除项全不在、保留项全存在。21 个任务、76 个旧节点、27 个旧运行、68 个旧任务的历史摘要一致。新进程健康正常，维护已退出，启动任务恢复 Ready。没有发送群消息。

最终补充：`node --test test/session-workspaces.test.js test/execution-session-native.test.js`：36 项全部通过。本机宿主使用的根标记已独立检查存在；未改正式配置。
