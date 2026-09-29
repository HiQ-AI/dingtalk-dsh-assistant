# 第四轮：全仓复跑与真实候选补证

`pnpm test`：1688 tests，1686 pass，0 fail，2 skip，0 cancelled；退出0，耗时468862.647ms。完整日志 docs/tmp/task-unified-file-storage/full-test-round4.log（158011字节）。上一轮失败日志保留。

补充设置 HOST_BACKGROUND_TEST_JAR 为已成功验收的真实 dataset fat JAR（155987450字节；SHA256 a9f45e55bbac45702d0b434ab93a1775cc6c68391c58c129f887cd4ccd99466f），运行 `node --test test/local-acceptance-background.test.js`：1 pass，0 fail，0 skip，退出0。验证隔离 Spring 上下文的控制开关、注释伪控制和新增消费者反例，不启动业务应用。

迁移真实 Git 候选、同文件共享源及中断回滚定向测试8/8通过；部署脚本定向测试14组59断言通过。上线补充备份及输入冻结改动需再运行其相关测试，不能把本次全仓结果替代后续定向验证。

文件 symlink 仍受 Windows EPERM 限制跳过；junction 越界反例实际通过。正式安装、两个实际任务迁移及真实群交付另行记录。

上线补充后的最终定向测试：迁移10/10；PowerShell部署16组65断言，均退出0。
