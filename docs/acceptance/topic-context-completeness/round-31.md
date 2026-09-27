# Round 31：审查方案 R1–R10 修复

日期：2026-09-27。授权：用户“按照方案修复”。源码在隔离 worktree，未改活动 profile、旧冻结控制账或远端 PR/UAT。总体 SG15 仍未完成。

## 修复与实跑

| 方案 | 实施 | 本轮证据 |
| --- | --- | --- |
| R1 | UAT 精确 base 租约快进，保留保护规则及 PR merged/SHA/tree 回读，不降级 REST 写入 | targeted-tests.log，真实本地 bare Git 检查后并发推进被拒绝；C38 PASS |
| R2 | 同事务维护屏障；排空后封存 stopping；旧进程不能撤销，新进程才可恢复 | store-tests.log 24/24、service-tests.log 5/5（含其他恢复用例）；C43 PASS |
| R3 | 确定性失败不重派，明确暂态三次持久退避，未知效果只对账 | service-tests.log；C41 PASS |
| R4 | 前端 prepare 首项初始化资源账，失败按实际已登记资源清理 | targeted-tests.log、lifecycle-backup-tests.log；C39 PASS |
| R5 | 编译 JAR 的隔离 Spring 上下文及后台入口扫描，证明绑定 JAR SHA | compiled-background-tests.log；真实候选 3170 类，注释伪控制、未使用开关、新增消费者均拒绝；C44 PASS |
| R6 | prepare 后、case/cleanup 后及交付门禁重复校验原 manifest；只允许受信生成目录 | lifecycle-backup-tests.log；新增 src 文件、修改/删除/链接替换拒绝；C45 PASS |
| R7 | 从 JSON 原始数值字面量及 DB numeric 字符串精确比较，actual 取实测结果 | targeted-tests.log；C40 PASS |
| R8 | 固定两组 Surefire 专项+原生 XML 非零/无跳过/无失败门禁；冻结脚本与 Java 资产 | compiled-background-tests.log、backend-checks-proposal.json；配置提案未激活 |
| R9 | 源/备份清单、一致 SQLite 恢复、逐表及工件引用闭包；健康与认证 Web 独立验证 | lifecycle-backup-tests.log 含备份7项；C46 PASS |
| R10 | 包与 profile 摘要分参；接续绑定 launch 输入；Readback 零写/Resume 独立 | deploy-script-tests.log 12/12；C42 PASS |

组合执行：targeted-tests.log 58 PASS、1 SKIP；跳过项是需指定实际 JAR 的后台测试，随后 compiled-background-tests.log 实际执行 4/4（含 XML 门禁等，不能相加称独立用例总数）。生命周期与备份组合 23/23；Store 24/24；Service 定向5/5；PowerShell12/12。上述定向组无失败；随后真实 Maven 入口发现报告目录参数未生效，见下述追加。

早期子代理 R6 夹具曾在服务未启动时调用 HTTP cleanup，修正夹具后最终生命周期通过；没有将初次失败删成通过。实跑日志保留在 docs/tmp/review-r6-runner-tests-final.log，整合复跑以本目录日志为准。

## 二次复审修正

1. 仅 active+drained 仍可能被合法 leave 解锁，增加原子 seal 和 Host 进程身份校验；真实子进程重开控制账后才允许 resume。
2. 只验证 DB 直接工件引用不够，增加可信引用字段闭包遍历、哈希、数量/字节/深度界限；源和备份同样缺失/损坏间接工件也必须失败。正文中的普通哈希不当作引用。
3. 部署接续还需绑定初始 profile 摘要及 bundle/policy 内容，防止换参数恢复错误部署。

## 包与运行边界

新包：docs/tmp/review-repair-package-20260927/zzusp-dingtalk-dsh-assistant-0.5.15.tgz。
SHA256：e64ce6a7c313f6298e7625fffce8445b4d2c46877722eb29b5476adff5be76e0。
package-readback.json：84 文件匹配。尚未安装；活动实例和远端未修改。

新 runner identity 和 UAT rulesDigest 会使前端旧 waiting Run、两条 pending UAT 计划拒绝恢复。后端旧工程 Run 已成功，不等于新 R5/R8 门禁通过。正式切换须先经任务控制入口结束旧待执行计划、排空并保留审计，再用新定义/新 requestId 接纳，复用既有开发分支与原 PR。不能热改 digest 或冒用旧凭证。

首次升级还有独立边界：旧实例未实现维护接口，新自动部署脚本明确拒绝退回检查后强停。磁盘后续回查 C 650289152 字节、D 8342843392 字节，已恢复空间；不能继续把磁盘写成唯一阻点。未执行任何清理。

原任务 C33/C34 本轮 NOT_RUN；PR #368 目标纠正、两条 UAT 合入/精确镜像部署及真实业务复验仍未完成。此记录不是全绿 report。

## R8 实际入口追加验证

首次执行新 verify-dataset-unit-tests.mjs 时 Maven 返回 0，但 Surefire 2.22.2 未采纳 surefire.reportsDirectory 参数：XML 实际写入默认 target/surefire-reports，新唯一报告目录为空，Host 按缺失报告正确拒绝。首失败日志 backend-native-check.log；7:38:37 的实际两报告存在，不能手工搬报告冒充新入口通过。已改为原生 surefire.reportNameSuffix，本次 UUID 同时绑定文件名和 XML suite 名称。实际重跑两组 16+6=22 项全部通过（失败/错误/跳过均0），见 backend-native-check-rerun.log、backend-native-check-readback.json。最终 Host 定向 9/9 通过，见 backend-host-gate-tests.log；C47 PASS。配置提案工具摘要已重新生成，未激活。
