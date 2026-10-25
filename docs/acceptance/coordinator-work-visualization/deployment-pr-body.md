## 本轮：协调实体台账

继续原 PR259 / `worktree-coordinator-work-deployment`，保持 OPEN、不合并；PR258 已合并，不向其分支追加。旧启动预算修复300→600秒仍保留，相关restart回归已实跑。

### 改动与原因

- `packages/dingtalk-dsh-assistant/coordination-observer.js:92`：新增只读实体列表/详情；schedule跨revision稳定一行，定时模板/派生成员归原schedule，独立无计划触发按occurrence身份，剩余直接成员按协调批次聚合。source只进历史，未接纳输入不制造工作行；完整集合先计算后分页/截断。
- `packages/dingtalk-dsh-assistant/coordination-observer.js:33`：统一真实主要结果。具体送达失败/未知、执行受阻/失败优先于active/accepted；当前任务/版本/指令匹配的proof才是正式完成；计划控制与真实nextDue/安全retry/readback分层，不拿source retry承诺重发。
- `packages/dingtalk-dsh-assistant/coordination-observer.js:114`：只有内部`coordination_cancelled`且无发送许可/次数/ACK/receipt的发送前拒绝才是取消，不误称发送失败；取消结果通知不能抹当前正式完成，取消后既有failed/delivered/unknown仍保留。真实SQLite反例先FAIL再修复，不改通知账或调度状态机。
- `packages/dingtalk-dsh-assistant/http.js:287`：接线GET `/state/coordination-work`与编码实体详情；重复/非法参数400，缺实体404，不可用503，保留Host/Origin边界。service/resident只导出读方法，旧sources诊断接口保留。
- `packages/dingtalk-dsh-observer/web-client.js:568`：现有协调工作页改读实体，紧凑行只一个后端结果；详情先结果/计划/下一步/任务，输入、修订、触发、证明与边界折叠。保留首群默认、显式全部、分页、5秒刷新、过期/慢响应隔离、独立focus/选中、任务往返。
- `test/coordination-observer.test.js:214`与`test/observer-node-control-display.test.js:548`：稳定身份/真实结果、只读守恒/隐私、取消前后、当前proof、下一步、异步范围和任务返回回归。README、API、设计合同与原生runbook同步；无schema迁移。

### 本地实跑（不是CI）

- 最终定向76PASS；扩展风险149PASS/0FAIL/0SKIP。命令：`node --test test/coordination-observer.test.js test/observer-node-control-display.test.js test/observer-client.test.js test/observer-slot-compatibility.test.js test/observer-board-restoration.test.js test/observer-archive-interaction.test.js test/restart-web.test.js test/coordination-concurrency-contracts.test.js test/coordination-notification-freshness.test.js`。
- `pnpm test:release-smoke`：12PASS/0FAIL/2SKIP（缺完整native profile的dsh-base，两项原生解包路径未验证）；测试映射308文件每个恰好一次、historical3。语法、Python AST及diff检查通过；不将历史中间测试数相加。
- round29最终冻结源码的真实React/primitives/HTTP/SQLite四变体各8PASS，十种持久提醒场景均实际渲染：单次成功/失败/未知/待送达、周期失败、暂停/取消保留真实结果、取消许可前未发送。实际暗色、390px、forced-colors、空群、首群/显式全部、手动/轮询/任务返回/focus覆盖；错误/写请求0，24个source/PNG身份独立匹配。它不是完整安装宿主证明。

### 最终原生部署与真实效果

round30先Check：writes0/signals0、62会话排空、未知操作/通知0。冻结70+4文件逐字节匹配后，一次原生排空安装最终双包；独立脚本读回：

- Assistant/Observer均2.1.0；Assistant SHA256`5bf60b8cb3446292b68d2323e56fa0c962b2c56ad3420ee327c3f12dc9862dee`（393380字节），Observer`6f58d449e9af04e372e52dff5a3dff3b26656b292791ccd80bda1722f50d0c3a`（59580字节）。旧候选未覆盖，最终目录`D:/dsh_home/packages/coordinator-entity-ledger-proof-20261025`。
- 旧18784退出，新91256同时拥有3080/18998；profileSHA`74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499`不变，Host仍0.2.1-rc.2。health ok/recovery0/inbound true，自启enabled/running，bridge/listeners ready/backfills ok，认证Web200。
- 18条历史输入投影为10个独立实体：7个schedule（5已送达、2发送失败）+3个无计划trigger任务（当前证明正式完成）。指定原失败source仍accepted、单次计划active且nextDue=null、作业completed，但实体主要结果为“提醒发送失败”，无后续触发/重试安排。未为验收修改业务数据。

round31在**最终已安装3080/PID91256**实跑桌面1440×1000、390px、dark偏好、forced-colors四变体，每种6PASS：指定原失败/一行一结果、首群无all请求、手选后手动/5秒刷新、真实任务HTTP200/详情往返、焦点与选择、高对比、无横向溢出。console/API/写请求均0。12PNG+12source身份独立匹配，亲自查看最终桌面/手机脱敏截图；结果、计划与下一步保持可读。宿主dark偏好仍实际浅色，不能声称native dark通过。

### 失败、审查与未验证边界

- round17保留取消后通知真实结果丢失的FAIL，round22保留驱动只认dispatch而真实数据为trigger的四变体FAIL，round24保留“发送许可前取消被误称发送失败”的正式SQLite FAIL，round28保留“取消通知覆盖当前正式完成”的独立回归FAIL；修复后新round29/30/31重验，不覆盖旧证据。Git Bash GNUtar把Windows盘符当远程导致的3FAIL保留，原生PowerShell重跑通过。
- 原生low独立成员发现取消通知掩盖当前正式完成的P2；lead新增test:509独立先FAIL再修结果优先级。当前正式完成优先于取消未发送结果通知，真实失败/unknown仍更高。队友曾75/75定向PASS，但未独立重跑最终76或浏览器；最终回归与页面证据由lead实跑，不冒称队友复验。其他重点暂未发现可复现阻断。
- 真实Host持久浅色覆盖dark preference，不声称已验证原生暗色；真实暗色只由隔离宿主验证。未做真实模型推理、钉钉测试发送、通知重放或业务修复，不升级无关Host、不手改账本，不制造生产失败状态。隔离夹具无发送/模型能力。
- 大PNG只保留本地，提交脱敏JSON/哈希与可再生脚本。唯一goal/shared-tasks/matrix/各round和report同根；历史round1–16不算本轮实体证明。最终隔离19087/19088已停止且独立确认无监听，native91256保持运行。
- 未触发CI/workflow_dispatch、未强推、未推main、未合并259。没有发行tag或对外npm发布。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
