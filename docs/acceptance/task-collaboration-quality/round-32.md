# R32 合并、部署与安装后核验

PR #251 已 MERGED，merge=11ae6621de000d9d1100fb3acc14128e41b8d19e。当前隔离工作树ff到精确合并提交，packages/scripts/test与实测d361202无diff。合并后重新打包的Assistant/Observer tgz SHA分别为ad92f6894bfdd6b2e2b378352d4d47728bb0c41f34d9c3a1c9079f20aca57d81、c53efa1f16e836dabf7e572bbdf053e23ed6e301b30ba03fbd9b54ac3ef79e51，与R31实测候选完全一致。

零写Check：59会话已排空，unknown操作/通知均0，writes/signals均0。正式脚本经SIGINT停机、旧进程及子进程消失、离线账本核对、manifest CAS、官方plugin add、实际依赖路径核对、计划任务启动，最终退出0。无历史备份。包保存在D:/dsh_home/packages/main-11ae662-interactive-team，PTY v2保存在独立持久目录。

独立回读：旧25964不存在，新65132独占3080/18998；health=ok、recoveryIssueCount=0、inboundProcessing/dwsHealthy=true、自启开启；配置接口executionBackend=dsh；原cordis.patch.yml SHA保持74fe100c0019f5e4c76c06903fdb622b0af5696afc60ab38cbd252ce8f948499。双插件版本2.1.0、精确file引用及包SHA一致。base→provider→node-pty实际版本为0.2.1-rc.2.pty.2和1.2.0-beta.15.dsh.2，四个关键文件摘要通过。重启入口使用的账本检查器已同步并独立SHA一致。

安装后隔离联调PASS：已安装task-session-service通过真实DSH原生驱动派发真实交互Claude（本项无需队友），其提交DSH_NATIVE_OWNER_CLAUDE_OK，原生Owner实际read执行文档再完成。task=completed、execution=succeeded/drained、CLI真实exit0、wrapper自然exit0且独立确认消失、close成功；没有钉钉外发。DSH模型决策固定，residentStore夹具来自已核对同源码工作树，因此这是已安装服务链验证，不是生产钉钉业务E2E。原始隔离账本在docs/tmp/installed-claude-service-r32。

证据：round-32/independent-readback.json、pty-independent-readback.json、installed-service-proof.json、launcher-readback.json和deployment/。生产启动花费约4分钟，处于既有300秒等待范围，未强制终止或重装。
