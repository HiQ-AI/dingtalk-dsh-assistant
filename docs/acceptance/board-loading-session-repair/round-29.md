# 常驻会话工作区成员绑定

真实原生session/list证明当前两群会话cwd=D:/baibu-agent、标题对应群名、danger-full-access；原生workspace/create返回已有baibu-agent工作区，但sessionIds仅含旧手工空会话，没有当前两群会话。因此目录迁移已完成，页面工作区成员关系漏登记。D:/dsh_home/storages/workspace.json不是本进程使用的原生工作区状态，不能据此认定没有工作区。

先经原生workspace/archiveSession归档5条旧群聊常驻目录会话；保留两条当前会话及全部任务。创建/恢复在flush后调用原生resolveByPath/create/attachSession，Resident依赖workspaceRegistry保证启动可用。10/10定向原生会话测试通过，覆盖新建及派生恢复成员关系和原目录/权限/历史不变量。正式部署及工作区独立回读待完成。

正式包SHA256 `79ec330afdc15b5a16c5e9781a297a9d480a709acba947e437c7c7f3996fa9d3`，Check/安装/Readback/Resume通过。独立回读PID43468、health=ok、维护解除revision405、自启Ready。原生workspace/create回读已有baibu-agent工作区15e62d41-15f6-45d1-b866-8c78f3845529，其sessionIds包含当前两条群协调会话；session/list核对cwd、群名及danger-full-access。原生工作区实际持久文件为D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116/workspace.json，独立确认5条旧常驻均在archivedSessionIds，新两条成员关系已保存。原已完成Task仍completed/7成功阶段，未重跑任务。

私有证据：docs/tmp/resident-directory-native-before.json、resident-directory-repair.json、resident-workspace-membership-after.json、resident-workspace-runtime-after.json及workspace-membership-r29-deployment；不提交原始业务会话内容。
