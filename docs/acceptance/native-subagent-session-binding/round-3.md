# 第3轮：最终相关回归与交付准备

- 使用既有prepare-release-tests.ps1核验C:/dsh-release-tests为短物理目录、非reparse，当前测试进程TEMP/TMP指向该目录；完整native profile固定D:/dsh_home/profiles/web/package.json。
- 相关7文件串行组合（session-workspaces、persistence-native、dynamic-execution、execution-session、provider-native、operation-readback、local-acceptance）：187 pass、0 fail、0 cancelled、0 skip，123308ms。两个前置失败均已验证修复，所有目录与原生能力相关断言保留。
- 保留历史共享材料定向用例：1 pass，0 fail/cancelled/skip，5184ms。
- pnpm test:release-smoke：14 pass，0 fail/cancelled/skip，30055ms；实际打包解压、原生健康和任务/执行测试通过，不是现场安装证据。
- 与第2轮完整扩展46项合计248项通过，原5项超时无调整门槛全部通过。映射check299文件、history3、deleted0。
- 原失败轮、环境前置与32轮性能对照见round-1/2.md，不覆盖或删除。
- 当前交付进入PR转正/合并、合并SHA打包与静止实例本地安装；现场业务原执行仍在处理新追加单位管理范围，等待自然排空，不为部署强杀。
