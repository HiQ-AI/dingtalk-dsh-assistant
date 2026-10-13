# 宿主统一升级部署边界

通过既有 `deploy-owner-repair.ps1 -HostUpgradeProposal <绝对路径>` 执行；原排空、封存、停止原进程、owner锁、原生插件安装、启动、回读与维护恢复流程继续生效。宿主升级提案不得与Bootstrap、离线修复、配置提案、索引或任务迁移混用。

提案固定包含 `schemaVersion: 1`、`targetDshVersion: 0.2.1-alpha.2`、原 `package.json` 与 `cordis.patch.yml` 的 SHA256、完整 `packageJson` 对象与 `patchAppend` 文本。除依赖字段和旧宿主pnpm.overrides外的manifest字段及bundle列表保持原样；仅允许删除宿主override或设为精确目标版本，非宿主override保持原样；DSH直接依赖精确alpha.2，本地包使用存在的绝对tgz路径。插件市场与已删除的runtime invariants不得恢复。追加patch基于当前preset完整plugins列表生成，不能抹掉已有工具配置。

`apply-host-upgrade.mjs --check --profile <绝对目录> --proposal <绝对文件>` 只读取并生成预期双文件摘要。正式流程在停止原实例并持有owner锁后执行 `--apply`，完整校验和双文件CAS均在写入之前完成，原patch字节保留，追加内容另行解析验证。工具不安装、不启动服务。两文件写入不能保证文件系统跨文件原子性；任何写入或安装失败保留停机/维护，不自动恢复派发。

部署输入冻结包括提案、helper、部署脚本和提案所有dependency section及pnpm.overrides引用的本地tgz；每个包在零写检查返回路径及SHA256，冻结前复核一致，锁内apply前沿既有输入哈希循环复核。安装后通过helper `--verify` 对manifest解析对象做完整深比较，接受原生JSON格式重排但拒绝任何内容差异，并将实际文件哈希写入apply证据供后续回读；patch仍严格核对预期字节摘要及已保存apply证据摘要。`node --test docs/acceptance/dsh-unified-upgrade/scripts/apply-host-upgrade.test.mjs` 覆盖零写检查、双文件CAS漂移、市场/旧宿主拒绝、bundle保护、宿主override删除/旧覆盖拒绝/非宿主覆盖保护、原生JSON格式与内容验证及原patch保留；定向测试通过不代表真实部署或模型语义验收完成。

仅允许官方 `dsh-session-format-v0-to-v1`、`dsh-session-format-v1-to-v2` 、`dsh-session-format-v2-to-v3` 和 `dsh-session-format-v3-to-v4` 四个明确迁移edge使用本地宿主override。读取tgz的package.json检查精确name/version与安全main路径，hash冻结前后一致；安装verify解析profile真实module目录并比较打包main与安装main SHA256，证据记录installedByteVerified，启动后再核验冻结输入及实际安装字节。其他宿主file override始终拒绝。owned历史event语义由迁移专项回归验证，字节证明不代替语义证明。

正式apply后 `-Readback` 与 `-Resume` 的输入入口走零写 `--verify`，使用已安装manifest完整对象与实际迁移字节验证，不能再按升级前CAS做 `--check`。接续提案路径须与原launch一致，原inputHashes冻结及proof哈希仍全量复核。回归实际执行生产PowerShell入口块，证明apply后Readback/Resume不被旧CAS误拒绝。

安装白名单合计五个宿主本地包：上述四条迁移edge加唯一 `@deepseek-ai/dsh-session-persistence-jsonl`。官方 `session-persistence-jsonl/tsdown.config.ts` 的worker构建显式alwaysBundle内联DSH JavaScript依赖，`migration-verifier.ts`通过路径加载 `lib/worker.cjs`；仅四edge override能修主线程只读，不能证明writer verifier使用新迁移。因此第五JSONL包必须同时重建入口与worker闭包。helper仅额外准许这个确切包名，verify同时比较packed/installed main与worker SHA256，worker不一致保持停机；四edge回归、实际write/reopen回归和安装字节证明各自独立。

实际安装回读严格沿consumer链解析：profile→dsh-base→session-persistence-jsonl→session-format-catalog→四edge；每步先realpath package.json再createRequire，使pnpm隔离依赖按真正加载者解析。JSONL从base解析，四edge从catalog解析；不增加root直接依赖，不猜pnpm store目录、不遍历兜底。fixture使用root仅base junction与独立consumer store，验证root无edge链接仍可回读并保留main/worker tamper拒绝。
