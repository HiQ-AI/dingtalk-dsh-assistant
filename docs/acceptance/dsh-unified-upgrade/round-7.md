# 第 7 轮：正式恢复与分层验收

2026-10-13，最终延迟回读13:33:11 UTC。

## 正式版本与包

| 组件 | 安装版本 | 本地tgz SHA256 |
| --- | --- | --- |
| DSH | 0.2.1-alpha.2 | 官方宿主，实际manifest回读 |
| Cordis / Loader | 4.0.5-alpha.1 / 1.0.6-alpha.1 | 官方依赖，原生闭包核验 |
| Codex Connect | 0.2.0-alpha.3 | 716e2ee219334ab4c4edea695f9a61c712add9ef073e899e4999cf57a09ffbbc |
| Assistant | 1.0.0 | 95f5b5d828d646fa77d740d903bcdc0089b9af1f24181135e09c545e3f0a20ec |
| Observer | 1.0.0 | 044281e79d3a612f4ac96867822a72f8b1eb07038386b1dc707ad6527c9738ce |
| Convergent | 0.2.1-alpha.2-convergent.1 | de6af00e6a6dcda35cf34b302a1565a60817bf9b5a90a4f516606248a73a5211 |
| Bytebase | 0.1.0 | 369c4a38ecd2dd55abf12616f63e3f83ec83564e92d042dec783844697f89d01 |

Connect和Bytebase是本轮alpha2适配包，不能因版本相同视作registry原包。另5个历史迁移/JSONL包按精确file覆盖，packed/installed main及worker核验通过。正式helper `--verify`复验10本地tgz、5迁移包，writes0；Assistant129文件、Observer4文件与安装内容相同。插件市场不在依赖或bundle中。

## 当前配置采用

用户报告可能有并行设置写入，以当前有效配置为新基线，原始prefix未恢复、写者未证明。完整私有快照、语义报告、旧记录及117旧输入绑定；新只读验证器实际通过135冻结输入、同PID/creation/nonce/maintenance。全部3个完整preset和global basic禁用节点与原升级append深等，差异0，无执行`!!js`。

必要原生welcome setup前248163→后7df775afc26e5857e2c04447c48cd6e7aa3b0921398cfd441110e48b6175a6ef，完整语义差异仅welcomeNoticeVersion从2026-08-13.1变2026-09-28.1。其余当前配置深等。最终package.json摘要b4e23b63581aae4b1fb77fb82a020ea2d2c970022790b76c1fb48dc6ee6dca89。

## 实跑结果

- `node --test .../verify-native-web.test.mjs`：15/15 PASS。同origin根URL规范化；外origin、非root、query/hash、missing cookie、非303、非200/HTML和恢复问题均拒绝。真实303 `./`取得cookie后页面200 HTML，未打印凭据。
- `node .../verify-profile-adoption.mjs --arguments <私有参数>`：独立两次实际PASS，零写；原PS源码完整保留，日期用JSON字符串及实际CIM UTC identity核验。
- `readback-native-host.ps1 -Check`：root及独立agent完整PASS。18个冻结原函数AST唯一加载，仅Web探针精确替换，没有失败后放行；task8、oldNodes47、oldRuns27、legacy0、history.verified=true；samePID39344，healthok、Bridgehealthy、recovery0，封存rev772/busy0。
- 同入口`-Resume`：恢复前再次配置/同实例/冻结闭包CAS通过，沿原Resume一次退出维护。独立延迟回读仍PID39344、3080/18998同PID、healthok/inboundtrue/Bridgehealthy/recovery0，maintenance inactive、revision773。没有再次重启。
- 正式独立headless：真实认证3080，Observer数据及实际task检查项展开/折叠、Assistant设置通过；14runtime GET、20已核源码的只读RPC、0非预期console/pageerror，无synthetic/CORS代理。重复空session/create被主动阻断并单列预期探针错误，不冒充无任何网络错误。
- 原生页面初始化生成1个空验证session，只含header和权限/沙箱/approval初始化事件，无prompt/message/tool、无模型调用。未提供原生delete Remote，保留该会话并记录，未扩大删除。
- 正式6个只读native RPC全部200/ok，Codex provider已注册、默认gpt-6-sol/low，standard/ptc/minimal/cordis无broken。Convergent完整正式preset/原生诊断通过；constructor identity另由原生策略隔离profile证明。Bytebase本轮包安装及bundle回读通过，未直接取得正式service登记或执行真实SQL证明。
- 正式Connect `status --json` signed-in，认证文件前后摘要不变；未发起真实模型请求或钉钉发送。

## 边界

Provider全量Windows check尚有既有canary/fsync/symlink/POSIX失败：139文件126通过13失败；1759测试1575通过183失败1跳过。定向52项和真实原生API prepare11模型/注册/dispose通过，不将全量写成绿色。81旧v0字节/24488事件历史恢复、真正writer flush/reopen、worker及未知/恶形负例由round-4独立证明。

正式安装/恢复层通过，未扩展至真实模型、Bytebase SQL或渠道发送业务E2E。原prefix不可恢复的盲点保留；私有配置和生产日志未提交。
