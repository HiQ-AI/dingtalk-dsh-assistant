# 封存后安装失败的原生离线续接

现状：r15 完整备份和 stopping 许可已真实落盘，原 PID 已退出，原生包管理器因 profile 旧 Observer file: tgz 缺失失败，尚无 launch.json。现有离线修复仅接受已启动记录，无法安全引用此检查点。

最小变化：既有 RepairStoppedLaunch 参数额外接纳固定名 maintenance-sealed.json。只允许原完整备份所记录同 SHA 的安装包、未变 profile、无 launch/配置应用/迁移证据的检查点；从真实 backup 和封存证据生成内存校验对象，不创建伪启动记录，不复制备份，不再次迁移。无持久原提案身份的此入口不接纳配置提案。原启动失败入口保持原约束。

两入口仍检查全部历史/工件闭包、备份清单、停止状态与维护版本；执行仅由原独占 owner 锁包围安装与重验。正常 Check 及安装前读取原生 profile package.json/package-lock.json 中 file: 依赖，缺源立即零写拒绝，避免停机后才发现。只在本地临时夹测试，正式 Check 只读，不启动/修改正式账。

补充范围：Observer 源曾指向已回收 worktree，不重建临时旧路径。允许此唯一 beforelaunch 检查点提供持久 recovered Observer tgz，必须与当前安装四文件及 package.json 完整相同，并核对原备份依赖存在；归档哈希不同必须明示，native plugin add 更新锁，不手改SRI。正常预检解析原生 pnpm YAML 锁，只有无该锁才读 npm JSON 锁。唯有已明确提供且通过内容检查的 Observer 可覆盖其旧 file: 地址，其余依赖缺源拒绝。
