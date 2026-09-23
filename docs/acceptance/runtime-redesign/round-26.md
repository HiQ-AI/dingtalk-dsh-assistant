# 第26轮：本地部署与独立回读

日期：2026-09-24（Asia/Shanghai）。**本地已部署并运行**；浏览器视觉验收及真实渠道业务验收没有完成，不能据此宣称整份方案全部验收。

## 已批准旧账收口

- 停机前68个Task全部completed；两个端口属于旧PID28536。禁用原计划任务，停止该进程及其所属子进程，再独立检查PID不存在、端口无监听、自启已禁用。
- 稳定原始备份33948728字节，SHA256 `5cb85c8001b7e8eb59903edbd397604ef2062520d98cf4ed1182fdb8ebde6050`。profile备份及逐项私有manifest保留本机。
- 按用户明确批准，仅将5条已有后续处理的协调请求标记superseded，终止1条过期超时回执的补发。独立深比较全部Task与原备份一致；旧回执没有标记送达。
- 收口后摘要 `b05457c3e45aaa6ae4265f81eab9721a2ea12d2365a9cec246d06c72a28eb612`。离线切换先CHECK_PASS，再ACTIVATED；不可变封存快照24307109字节。运行后通过已安装readWorkflowSeal独立核对blockLegacy=true/active。

## 精确安装与启动

- 源码提交 `a30db66400997cfdc716b107d55d4decc29063c2`；包仍为本地0.5.15构建，不冒充新的registry发布。
- tgz305422字节，SHA256 `FAA93131FCDBF3133FC6E368481B8115C72988BA99F54C33F089E8139508EB29`，使用profile原生DSH插件安装命令，未手改node_modules。
- 安装后及启动后两次独立比较：59个JS/patch文件摘要全部匹配，package.json语义一致。profile依赖声明仅Assistant包路径变化；原profile patch非workflow部分deepEqual保留。
- 新PID28608同时监听3080/18998，区别于旧PID；health=ok、DWS bridge healthy=true、recoveryIssueCount=0。默认provider/model仍openai-codex/gpt-6-sol。
- `/state/workflows`实际engine=workflow-v2；控制库只读独立回读group engine=workflow/state=active/epoch=1。SQLite WAL、FULL同步及外键开启。
- 68个旧Task仍全部completed且内容与备份deepEqual。原计划任务重新启用并独立回读为Ready。

## 安装代码实际执行与表格

- 从**安装目录**导入消息模型、控制账、工件与workflow-service；使用当前profile的真实原生provider/session，独立测试库和合成输入，无真实渠道发送或其他外部业务效果。
- 接收66ms，S5443ms、R3429ms、I3874ms，总链16272ms；消息settled，单个Task completed/succeeded，结果为“北京是中国的首都。”。产物SHA256 `90792D91391814777C50575DF0966AE410D27E651140EA8CB262B4D56FED87AA`，再次独立读取断言通过。
- 现有任务表node/sheet身份未变，启动同步success/taskCount16；DWS完整回读A1:N200，complete=true/hasMore=false，无截断。除表头批次时间外，全部任务数据行与部署前一致。
- Web未认证请求401；使用启动给出的本机登录地址后200/text-html，应用根元素存在。登录信息仅本机保留。

## 验证与限制

- round22：819/819回归通过；其后仅显式检查容量数字调整，round24定向6/6通过。round25正式路径冷安装+完整生产build通过（安装227644ms，构建1020810ms）；固定业务基线是1cecf630，未声称最新远端main。
- Browser工具在独立内置页访问本机返回ERR_BLOCKED_BY_CLIENT，Chrome连接返回nodeRepl.fetch request failed。因此**未完成真实浏览器视觉核验**，HTTP200不代替它。
- 未向真实群/个人发送测试消息、未创建外部业务测试PR、未执行生产SQL。生产SQL审批适配器、完整共同provider负载/质量留出集等仍见round20未覆盖边界。
- 16.272秒是单个合成分析样本，不是P95承诺；业务仓库冷构建约17分钟是真实固定检查成本，不能描述为消息节点耗时。
- seal接管后禁止删除seal或直接运行不理解seal的旧版本写入；保留控制账、新事实和全部备份，优先前向修复。
