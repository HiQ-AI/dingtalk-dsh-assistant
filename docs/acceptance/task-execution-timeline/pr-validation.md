# v9 最终提交验证

基于 main 3ec42be，同步消息结论与耗时功能后无冲突；改动仅任务详情时间图所需采集、持久化、API、UI、测试及设计文档。保持已认可柔和靛蓝/金色、字体与密度，取消图上小标记。

- 定向测试 185 项：182 通过、0 失败、3 跳过。跳过为原生阶段进度测试，缺少完整 native profile 的 @deepseek-ai/dsh-base。
- 隔离浏览器 13 组检查通过：并行、同会话空档、历史缺失、恢复、长名、完成/重开间隔、终态固定、人工介入、窄屏、键盘、深色/强制颜色与对比度。
- scripts/build-web-client.mjs 成功，生成的 assistant web-client 无差异；Observer 为直接加载 JS。
- 三个发行包打包成功；任务时间投影模块纳入 assistant files 清单。
- git diff --check、JS 语法检查、严格 UI audit 和 DESIGN lint 通过（0 错误/警告）。

生命周期时间复用准确回执与 wake，不新增实体/表或更改统筹完成判断。执行活动只从 Host 观察时刻采集，缺失历史不补造；旧版本若缺稳定完成回执则显示不完整。阶段切换依赖显式 activity 报告，未报告期间沿用已有业务短名。

预览使用合成数据、真实 React 与完整 Observer 模块，所有业务 API 隔离。未连接生产数据库，未验证真实模型、Windows 宿主或钉钉收发；未部署。CI workflow 当前仅 workflow_dispatch，不会因 PR 自动触发，本地验证不等同于远端 CI。
