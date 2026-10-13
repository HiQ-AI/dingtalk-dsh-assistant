# 第4轮：最终五包与部署前闭环

- root读取最终五包，按独立SHA/bytes将固定产物放DSH_HOME/packages；总10个本地输入摘要全部吻合。最终manifest为11 direct dependencies + 五个明确host overrides，插件市场不存在。
- 最终完整隔离native安装成功。helper沿实际pnpm consumer链核验五包main与JSONL worker：installedByteVerified 5，installedWorkerByteVerified 1，本地输入10。nativeboot health ok/recovery0/平台客户端及llm/tools/sessionPersistence可用，退出隔离实例。
- root从当前正式sessions重新复制81日志，以最终candidate原生JSONL读取：24488events/82业务身份，最新原件与副本字节均未变。没有使用旧副本代替最终现场。
- root独立重跑final history、逐edge generation、synthetic全部通过；writer --check writes0，实际producer新增27事件且要求tool/result replace，flush和新Context V4冷读及原生Session恢复通过，81v0摘要不变。恢复仅出现正常session/end-seed补全标记。
- 外部core官方四迁移边36文件1163tests通过，V4 validator及静态bundled worker分别拒绝5个普通/冒充/恶形负例；source gate另11负例。JSONL worker必须重建，不跳过自然退出verify。
- root宿主helper22/22通过，包括实际pnpm无rootedge链接、worker/main tamper、apply后的Readback/Resume。
- 最终正式部署Check通过：writes0，历史副本备份不需要；8个旧任务，磁盘free6567854080 > required1083442444。

正式切换开始前记录；本轮尚未声称正式新实例上线或恢复收信。原始证据存docs/tmp/root-final-*.json、unified-final-*.log/json、final-live-history-result.json。
