# Round 1 验证记录

## 自动验证

- `node --test`：255 项通过，0 失败、0 跳过；覆盖配置修订与并发版本、索引按需加载、选择持久化、目标转换清空、旧修订完成拒绝、Session 恢复重注入及 Web profile 启动入口选择。
- 连续执行 `node scripts/build-web-client.mjs`：生成前后 SHA-256 均为 `0FBDDB1A8C1B2AD4D1963F2E5DB0AA957A35B56B6EE2B5151D778E1C59A805D2`。
- frontend-design-premium strict 静态审计：0 finding、0 warning、0 error。
- `npm pack --dry-run`：19 个发布文件，`client.js`、`web-client.js`、`runtime.js` 和 `store.js` 均进入包。

## 本地部署

- 来源提交：`88e1e12`。
- 安装包：`C:\Users\64554\.dsh\artifacts\dingtalk-dsh-assistant\88e1e12\zzusp-dingtalk-dsh-assistant-0.5.13.tgz`；101853 bytes；SHA-256 `7D30E945F0AF3208614F4564F16D08154D7BC6C6FD73119690F02C179C83983C`。
- profile 独立回读到上述新路径；安装目录同时命中 `load_task_prompt` 和“可用任务流程索引”。
- 首次重启发现 `start-web.ps1` 解析到已失效的旧全局 `dsh.cmd`；修复为优先使用当前 Web profile 中的 DSH 入口，再次通过同一脚本启动成功。
- 新进程 PID 666024 同时监听 3080/18998；`/health` 为 `status=ok`、`transport=dws`、`modelMode=real`、`recoveryIssueCount=0`；DWS bridge healthy，群 listener ready、backfill ok、人工回复 listener ready。
- 重启前两个活动 Task 均按原 `taskId/inputVersion/runSequence` 恢复为 running，没有重建业务输入或执行轮次。

## 浏览器 smoke

- 独立 Chrome 标签进入“设置 → 插件 → 钉钉个人助理”，页面从真实接口加载 `taskPromptsVersion=0` 和空流程库。
- “添加流程”生成带名称、适用说明、流程与验收提示词、启用开关的 fieldset；三个字段填满后“保存配置”由 disabled 变为可用，关闭启用开关后值变为 0。
- 页面使用 label/fieldset/legend，截图中字段、开关、保存按钮和下方群职责边界清晰，无溢出或遮挡。
- 未点击保存；关闭独立标签后再次从 `/state/agent-config` 回读仍为空流程库、版本 0，现有通用叶子提示词未改写。

## 边界

- 本轮未把示例开发流程自动迁入真实配置，避免在存在活动 Task 时改变其指导规则；配置内容由用户按场景维护。
- 删除按钮的真实服务端效果由 Store/API 自动测试覆盖；浏览器 smoke 未保存或删除真实配置数据。
