# Agent 自身资源权限部署与验收第三轮

## 已完成

- 当前源码提交 58a83df：资源权限来自 Agent permissions，不按群成员划分。
- 部署预检 writes=0，92 个包内文件与源码一致；包 SHA256 为 b1b2d7c94da6409ec4b1f40e39aae8c024655b621bf9f2e882c9e3b25fb82897。
- 受控维护、排空、备份、原生安装与同一部署记录 Resume 通过；新进程 PID30368，维护已解除，服务健康正常。
- 正式配置不含 grants，permissions 保留原来 2 个资料资源、1 个数据库和3个运行资源，未新增资源。
- 回读保护19任务、76节点、25运行、68旧记录；安装/进程/历史证据见 docs/tmp/agent-owned-permissions-deployment-resume.log。
- 原生隔离真实模型经消息分流实际查询资料、代码和运行信息，0业务任务；结果见 docs/tmp/agent-owned-native-message-r1/result.json。
- 已授权独立测试群实际读取项目资料和UAT表元数据。工具产出及来源均核验，执行succeeded/drained，answer命令applied，0create命令。
- 钉钉独立消息回读完整、0失败、唯一原问题，回复引用原问题并含dataset职责及三列元数据；输入权限集合与正式提案完全一致。证据 docs/tmp/agent-owned-permissions-channel-audit.json、channel-mget.json及channel-final.json（同前缀）。

## 边界

38/38定向回归证明不同发送者使用同一Agent资源目录和权限范围，资源越权仍拒绝。没有要求第二位自然人具有不同资源权限。

本轮未修改平台原生内容。整体方案的真实调查→开发→本地验收→远程UAT链仍需要具体未交付任务及明确UAT环境，不把本轮查询验收当作全链通过。PR129仍为草稿，未合并。