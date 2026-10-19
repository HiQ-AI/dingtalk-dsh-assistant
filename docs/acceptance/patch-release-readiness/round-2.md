# 第二轮：最小修复与回归

生产代码不变。测试模型通过真实model_content_read读取contextPath后再判断，不直接读文件；覆盖分页和同轮最多4个独立读取。人工7/7、Service与model-context45/45通过，原身份/同会话续办/未知效果断言保留，新增Host<=3000字节和实际工具读取证明。

Windows最终文件路径重解析点用无特权junction覆盖，POSIX仍file symlink。链接9/9通过，增加外部目录零新增/原字节不变断言；Windows文件symlink不冒充已验证。

Provider三冷审阅+后续真实事件因新增真实读取31.8秒，超过旧30秒；仅未恢复分支测试墙钟预算60秒，生产重试次数、冷却和所有断言不变。两代工程首代16节点187.156秒，旧240秒在第二代正常推进中耗尽；按每代既有240秒合计480秒，完整两代323.39秒通过。独立回读generation2 succeeded、PR creates1/edits1、业务值two。

所有公共fixture导入者及持久化文件统一回归中，最终结果待补。原始证据docs/tmp/release-context-*、release-2.0.1-link-tests.log、release-engineering-two-generations*、release-2.0.1-affected-tests.log。证据体积/内容不入库。

受影响27文件统一169项：168通过、技能1项因专用TEMP仅继承Modify导致原生沙箱SetNamedSecurityInfoW grantWrite Win32 5。专用目录对当前用户设置可继承FullControl后，技能原断言不改，5/5通过；独立Get-Acl回读明确用户FullControl。该环境准备已写入发布runbook。

最终本地覆盖结论：受影响169项中168项在整组通过，唯一技能环境失败在ACL准备后原文件5/5复跑通过；两代工程完整1/1通过，修复前23个失败/取消均有对应PASS。没有将这些累计回归冒充修复后全量重跑。Tag工作流将运行完整pnpm test。CI/Release YAML解析及release-workflow定向通过。
