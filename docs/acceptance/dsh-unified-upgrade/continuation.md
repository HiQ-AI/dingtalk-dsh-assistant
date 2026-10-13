# 已封存宿主启动失败续接

`continue-host-upgrade.ps1 -Check -HostUpgradeProposal <新提案绝对路径> -OriginEvidenceDirectory <原失败证据目录> -EvidenceDirectory <全新证据目录>` 零写检查；核验与review通过后移除 `-Check` 才执行。

该入口仅接续首次计划任务失败退出1且启动秒与旧launch相符的已封存宿主升级。原冻结脚本、helper、提案与包均不修改；按旧inputHashes核验后通过原生PowerShell AST只加载六个固定函数定义，不执行原脚本顶层。原launch、host proof及deployment control摘要链必须一致，源profile SHA与已安装patch SHA分别沿原record保留。

新提案只有dependencies增加原生required peer/dependency闭包，旧依赖、五个本地override、bundle和patch保持；每项增加核实真实父manifest身份、声明及SHA，父manifest与冷候选证据均冻结。正式pnpm-workspace.yaml与冷候选字节相同，不能切autoInstallPeers绕过。Check不建立证据目录、不锁库、不安装、不启动。

执行在无原进程、launcher子进程和双端口、原maintenance完整seal/busy零、控制快照tasks/nodes/runs/legacy深等后持owner锁，锁内再次复核再CAS更新、原生pnpm安装、实际入口/worker字节验证及package/control回读。持续持锁必须成立，正常释放锁后再次确认停机封存，才按原固定计划任务启动。新证据继承tasks/control/seal/autostart字节基线，不覆盖旧证据。新launch/control可沿冻结原部署脚本 `-Readback`、`-Resume` 验证；默认只启动并保持封存，不自动恢复派发。

guard回归调用实际入口AST中的函数，覆盖Windows launcher路径、残留子进程、失效owner锁、非原失败计划任务、非零busy、core声明/哈希漂移、额外任务；测试不代表真实安装或正式启动通过。

在线历史seal与离线当前状态必须分开核验：历史seal仍须stopPermitted=true且processIncarnation=sealedIncarnation；原checker调用maintenanceStatus(db)无活process参数，当前必须processIncarnation为null/缺省、stopPermitted=false、resumePermitted=false，持久化ID/revision/sealedIncarnation与历史seal相同，active/stopping/drained/busy零不变。该差异来自原生计算语义，不能伪造离线许可；CIM与端口独立证明没有活实例。测试使用准确离线形状，并拒绝离线伪造在线许可及revision漂移。

唯一安装命令为 `pnpm --dir D:/dsh_home/profiles/web install`，固定Node 24 PATH并核pnpm 10.13.1；pnpm入口shim也冻结SHA。新宿主bin.js静态导入app-boot，在缺core group时CLI尚未进入命令处理便失败，所以不调用新CLI再兜底。完整新manifest已含原五个本地插件、五个受控override与bundle，pnpm按正式hoisted/autoInstallPeers=false策略安装后，通过helper/package/control独立核验。冷候选已另行验证安装后CLI和功能；正式实际安装/启动/Readback/Resume仍需分别证明。
