# 原生安装策略缺失与封存续接

正式首次新宿主启动失败：ERR_MODULE_NOT_FOUND cordis-plugin-group。正式pnpm-workspace是alpha2官方profile策略nodeLinker hoisted/autoInstallPeers false；初次隔离profile仅packages列表，使用默认隔离链接/自动peer，未复现正式策略。新增manifest只11直接依赖不足，不能切autoPeers绕过。

方案：从native alpha2完整包声明计算required peer闭包，明确直接依赖精确目标版本；独立冷candidate复制正式pnpm-workspace逐字，重装/启动/provider/UI复验。新manifest提案只补已声明core dependency，不修改bundle/config/data，五个tgz冻结。

正式原维护已排空、sealed且双端口无监听，原失败launch与inputs均冻结；禁止热改原deploy脚本/helper/提案使原证据漂移。因此在现有acceptance/scripts增加仅处理已封存且原计划任务失败退出1的offline宿主续接入口。复用原check-repair-deployment的maintenance/verify/package/lock及原apply-host-upgrade双文件CAS；原patch追加为空，字节不变。核原证据/原inputs/五包SHA、旧任务控制快照、maintenance id/revision/sealedIncarnation/drained/stopPermit/busy0、所有Host/launcher进程及双端口消失、计划任务配置/失败启动身份。新提案与入口绑定冻结输入，Check零写，锁内复查后apply/install/字节/控制账核验，释放锁后按原计划任务启动。

新证据继承旧tasks/control/seal基线，保留旧launch SHA及原input hashes，生成兼容原deploy脚本Readback/Resume的launch与deployment-control记录；新host proposal/proof可独立验证。原失败证据不覆盖。失败保持封存/停机，不手工改SQL、不删除锁、不跳过worker、恢复证据链完整后才Resume。
