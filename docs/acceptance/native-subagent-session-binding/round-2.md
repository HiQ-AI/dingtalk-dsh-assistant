# 第2轮：扩展超时定位与校验开销修复

## 原始问题的对照

相同原32轮续办用例、完整本机profile、原120秒门槛，使用scripts/profile-filesystem.mjs仅统计API调用次数与累计等待，不记录调用参数或文件内容。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 用例运行时间 | 91522.9ms | 54309.7ms |
| lstat调用 | 39322 | 26797 |
| lstat累计等待 | 25901ms | 19730ms |
| realpath调用 | 39252 | 2561 |
| realpath累计等待 | 32446ms | 2339ms |
| readdir调用 | 3167 | 2144 |
| open调用 | 3149 | 3160 |

真实32轮模型请求、来源/权限及UNKNOWN_EFFECT保留断言均通过，未减少轮次、读取或放大超时。独立运行能完成，反证不支持死锁；重复祖先realpath与缓存backend重复全树扫描是主要实测开销。磁盘/机器负载仍可能影响绝对时间，不据一次采样宣称通用吞吐保证。

## 修复与边界

- checkedTaskDirectory逐层lstat仍拒绝junction/symlink；已有目录仅末端realpath完整路径一次，mkdir前仍realpath真实父链。
- backendFor只在新装配前创建检查，等待装配后和每次缓存公共访问仍无条件全树检查；不跨调用缓存安全结论。
- 子Agent任务路由、Host writer、原生日志和生命周期未放宽。
- 只读反偏置审阅未发现本轮退化；既有TOCTOU及须先drain再close边界保留。

## 当前验证

- 最终目录优化后persistence-native：16 pass，0 fail，0 skip，包含祖先及缓存root/project/session/log/index链接替换拒绝、重启、取消和原Host writer拒绝。
- 测试映射check：299文件恰好一次，history=3、deleted=0。仅补列既有task-boundary-instructions.js的56处静态闭包；无测试退出Release、无移动或删除用例。
- 原完整扩展组合正在运行；以最后结果补充，不提前计PASS。

## 登录与现场

- 原登录内联脚本seq494在缺Authorization响应头时于finally前throw，非当前前端要求；前端允许Cookie会话。
- 现存控制库blockers.operations=[]，旧登录会话未知不构成新的操作账阻塞。
- 已经正式POST /tasks/<原task>/context，以preserve/authorizationChange=none给原执行补入真实浏览器表单登录路径；独立回读requirementRevision=5不变、contextRevision=2。沿原执行续办，不并发登录/改密/重跑UAT。
- 当前现场四文件差异已通过Git blob确认属于安装版本早于main的0885fcb阶段边界修复，不是未知私改；最终安装仍以已合并main精确包核验。

## 完整扩展组合结果

`DSH_NATIVE_TEST_PROFILE=D:/dsh_home/profiles/web/package.json; node --test --test-concurrency=1 test/task-session-http-integration.test.js test/task-session-service-native.test.js test/task-session-skills-native.test.js`：46 pass，0 fail，0 cancelled，0 skip，262255ms。

原5项：网页读取4611ms（门槛20000）、32轮49597ms（120000）、工作区恢复5181ms（20000）、容量1/1=4191ms和2/1=4086ms（15000）。其余容量组合、并行读、取消排空、同会话恢复、未知通知回读与技能能力均通过。原失败轮不删除。

## 相关回归首轮失败与修复

扩展46项已全绿后，追加相关回归首次187项中185通过、2失败，无取消/跳过：

1. dynamic-execution-session-native的32代输入Host预算断言要求短物理TEMP/TMP；当前默认C:/Users/.../AppData/Local/Temp使绝对路径撑大输入。按既有scripts/prepare-release-tests.ps1准备C:/dsh-release-tests，逐祖先检查非reparse并设置当前测试进程TEMP/TMP；不修改字节预算。
2. session-workspaces旧测试仍写7种职责，而main的5faad2e已添加coordination实际共8种；更正测试名称和明确计数为8，保持目录隔离与未知职责拒绝断言，不改变生产职责。

两个失败保留在matrix与首轮日志，不冒充通过。目前在上述准确测试环境中重跑相关组合，再接续共享材料历史用例与release smoke。
