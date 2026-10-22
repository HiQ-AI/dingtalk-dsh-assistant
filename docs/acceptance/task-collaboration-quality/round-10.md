# 第10轮：CLI 运维检查修复复验及部署交付

这是 SG8 合并部署过程中发现同因缺口后的验收复验，仍由 R9 三位执行成员负责，不新增成员或覆盖历史。

`round-9/deploy-cli-checker-verified.log`：53 PASS、0 FAIL、0 SKIP，11.647 秒。覆盖混合后端、真实 Store 连续未启动续办/取消/stale、错误输入历史/身份/provider/租约/序号/末记录、缺失日志与目录链接/硬链接拒绝，以及原 DSH 和停机启动合同。中间版48 PASS只对应其当时范围；首次错误完整保留。

独立 `round-9/checker-native-journal-replay-1.json` 使用 R7 真实 CLI/Host/Store 的原执行行和原 journal 字节建立 execution-only 隔离回放，检查通过；59条事件、末 drained序号59。原完整探针库因合成 Task owner 尚未排空仍拒绝 DEPLOY_NOT_DRAINED，不能把执行级证据写成整库可部署。原行和日志字节保持，checker SHA256 为 `2c2c0438a572319669a884fc880bcf810856103f831c4cf0f314c29d38e7715b`。

运行态运维脚本按后端核验，不跳过 CLI；与尚未登录无关，默认 DSH。部署时同步既有 launchers 的 checker 和原启动器，独立核对摘要。PR 合并、实际包/进程及健康在完成后补记，不能将上述隔离复验当作已部署。

`round-9/restart-contracts.log`：既有桌面重启入口 10 PASS、0 FAIL、0 SKIP，11.379 秒。suite-map 再次核对 301 文件、历史3、删除0；checker 的测试继续位于其既有目录，不变更正式 test/ 分类。
