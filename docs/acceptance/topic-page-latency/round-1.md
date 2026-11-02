# 话题页共享主线程停顿：第一轮验证

## 代码与范围

2026-11-02；基线 d07056a670801b1700d8729e992e7ffd4b3d914b，验证对象为其上本轮未提交工作树：topic-model.js、store.js、task-session-service.js、两份定向测试及隔离对照脚本。origin/main 核对仍为 27416826d9bb013d18c1efb81db0b53207c7dd89，无待整合增量。没有替换安装代码、重启业务或触发 CI。

## 根因证据

运行进程同属 Web 与 Resident。连接建立 0 ms 时，health、话题列表、Web 401 首字节同时等待约 3150/3151/3152 ms；话题列表正常 5–15 ms、仅约 8 KB。20 秒 CPU 采样实际跨度 22970 ms：topic-model 正文投影内部两个匿名节点 exclusive 共 36.3%；归属列表 clone 两节点共 12.8%；GC 1.3%、JSON 后端序列化两节点共 2.7%。inclusive 的 projectSource 与 recover/kickGroup 栈重叠，不相加。排除仅话题网络载荷过大或前端环境检查阻塞的解释。采样没有暂停、重启业务，结束独立确认本次开启的 inspector 已关闭。

## 实跑结果

- `node --test test/topic-store.test.js test/source-dispatch-ownership.test.js`：52 pass、1 fail、0 skip。唯一失败“固定版本不暴露后来摘要”预期空摘要、实际“第一版”。隔离加载 HEAD 版 store.js 后单独运行同一测试，仍同样失败；本轮不改无关摘要合同。
- 后续补充复制前过滤反例，`node --test test/source-dispatch-ownership.test.js`：12 pass、0 fail。覆盖精确版本、隔离副本、重开持久化，以及无关快照正文 getter 抛错时仍不读取。
- `node --test --test-name-pattern='来源引用索引' test/topic-store.test.js`：1 pass；覆盖多事项、remove/readd、旧消息版本、legacy 引用、对象更新、1000 次缓存读取不重新扫描，完整正文读取仍拒绝缺失事实。
- `node --test test/task-message-projections.test.js test/task-topic-context-http.test.js test/observer-client.test.js`：65 pass、0 fail、0 skip，覆盖来源投影、话题 HTTP 与看板读取合同。
- 指定仓库 native-profile，首批匹配来源语义戳、路由幂等和历史 Host 退役的原生测试：2 pass、1 fail；路由幂等测试业务阶段超出原 30000 ms 时限。用 Node loader 隔离加载 HEAD 版三个被修改源码，原测试仍相同时限超时；未延长时限或删除断言。此合同未验绿，不能宣称全部原生测试通过。
- 原生最终针对 `来源语义戳|协调暂停时混合消息`：2 pass、0 fail、0 skip。来源完成不等待同群其他判断；两事项来源在 Host 阻塞时保持 pending，重试后按原版本完成。
- `node --check docs/acceptance/topic-page-latency/scripts/profile-resident.mjs` 通过。诊断脚本增加目标 PID 校验，并拒绝占用既有 inspector；未再次开启现场采样。

`pnpm test:suites`：verified 335 files; every file exactly once; historical 3; deleted 0。`git diff --check` 通过。

## 新旧真实函数对照

`node docs/acceptance/topic-page-latency/scripts/compare-projection.mjs` 从基线与当前源码提取真实 projectSource，使用真实话题解析、引用索引和判断覆盖函数；只隔离存储介质与账本写入，不启动模型/业务。这不是完整服务 HTTP 或浏览器验收。

250 来源、20 话题、每话题 250 引用：

| 指标 | 基线 | 修改后 |
| --- | ---: | ---: |
| 结算耗时 ms | 644.50 | 14.90 |
| 同进程零延迟定时器等待 ms | 644.63 | 15.38 |
| 正文展开条数 | 1250000 | 0 |
| 归属复制条数 | 62500 | 250 |
| 落账命令数 | 250 | 250 |

逐条深比较命令及 payload 完全一致。另验证未完成、移除、多事项、旧版本来源四场景，分别产生 0/3/9/3 条命令，新旧完全一致。性能数值仅本机合成样本，不作为脆弱时间阈值；脚本断言操作数与结果等价。基线及临时日志已将必要证据归纳至本报告，清理后不再引用附件。

## 边界

修复已覆盖被采样确认的正文投影和整组归属复制热点，不改变已完成来源的重核规则。仍存在每来源扫描群消息/话题目录和匹配归属的开销，不宣称任意规模恒定时间。两项既有失败明确保留。未运行全量、未部署、未验证真实页面或真实钉钉业务；现场延迟是否改善须合并部署后验收。本轮不创建全绿 report.md。
