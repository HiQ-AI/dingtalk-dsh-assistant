# 按插件会话职责组织工作区

## 目标与现状

用户要求名称直观、没有内部 ID，工作区按插件实际会话职责拆分，不按业务或任务编排阶段分类。新版消息判断 C/G/I/IB/R 直接 llm.stream，不产生原生会话，不能为其虚构工作区会话。

真实创建入口：execution-session 的 message-unit（消息问答）、task-node（任务执行）；task-owner-session（任务负责）；runtime 的 resident（群聊常驻）、coordination route/decision/review（消息归类、话题决策、结果审阅）、legacy leaf（任务执行）。原生子代理沿用父执行工作区，不另创业务分类。

## 实施

在配置的 Agent workspaceDir 下自动创建 session-workspaces/<中文职责>。共享模块只负责确定性目录及标题，避免各入口复制。新目录必须解析到配置根目录内，拒绝外部 junction/symlink；指引由宿主原生读取，部署需确认 projectRootMarkers 能识别配置根；普通目录可配置 AGENTS.md/CLAUDE.md 标记，不复制个人配置。只在新建时传 meta.cwd，resume 不改变历史 cwd。标题使用现有任务标题、话题标题、问答目标或群名加职责；去除内部身份、路径、网址，限定显示长度。标题交给原生 sessionTitle 服务，不增加模型调用；服务未挂载的测试/Host 不生成假事件。

消息意图记录仍在已有消息账中，单独汇总，不新建模型会话。code 节点、Delivery、外部效果不属于会话目录分类，不改变权限与执行根。

## 验证与边界

运行原生 execution/owner、message controller、coordination 与相关 runtime 定向测试。新增职责目录测试涵盖跨根目录、外部链接拒绝与标题去 ID，原生测试验证新 cwd、恢复不变与标题持久化。另用原生指引加载器验证普通目录默认未继承的反例及明确根标记后的继承。真实旧会话只汇总，不移动或改写旧日志：当前旧日志未知事件、子代理入口限制及一条序号不连续阻碍批量重命名，不属本次目录切换。

交付 PR，未合并部署前不声称新会话已使用目录。保存本机摘要，不提交原始会话正文、凭据或个人路径。
