# 本地 owned session 迁移包重建

这些是上游 `dsh-v0.2.1-alpha.2` 的**本地修改包**，不是 registry 官方发布。来源为 `https://github.com/deepseek-ai/deepseek-harness.git`，精确 commit `d743267388641bc76f17c45ce8b4c231aed1d32c`。完整源码差异在本验收目录 `fixtures/owned-session-migration.patch`，包含新增 helper 与五包 manifest。包仍使用精确 `0.2.1-alpha.2`，`dsh.localMigration` 明示来源、所有者和修改标识。

修复四条迁移边对固定钉钉事件/来源、Convergent 范围与 generation、owned JSON 投影引用的解释；仅允许经过原成功分页回执、完整 digest、owner 绑定和 surface ancestry 验证的闭 turn replacement。未知事件、错误身份、额外内容、错误 ancestry 和普通闭 turn 结果保持拒绝。JSONL 的官方主入口保持原样，worker 则重新 inline 四条本地迁移边；只替换依赖而不重建 worker 无法修复写后 verifier。

运行前安装 Node.js **24.19.0** 和 pnpm **10.13.1**，使用 PowerShell 7。在仓库根目录运行：

```powershell
./docs/acceptance/dsh-unified-upgrade/scripts/core-migration/rebuild.ps1 -WorkRoot "$PWD/docs/tmp/core-migration-rebuild-01"
```

WorkRoot 必须不存在；脚本不会覆盖旧目录。它独立 clone 精确 tag、核对 commit、`git apply --check` 再应用源码 patch，然后建立 `migration-runtime`、`toolchain` 与 `packages: []` 的独立 pnpm workspace。两份初始 manifest 就在此目录，无需已有 tmp 目录或 Bytebase 安装。工具位置固定为该 WorkRoot 的 `toolchain/node_modules`，版本固定为 TypeScript 5.9.3、Rolldown 1.2.5、Vitest 4.1.11、@types/node 24.13.3。构建时只 junction 精确单包依赖，不复用整个外部 workspace node_modules。

流程依次构建四边、strict 声明类型检查、复制 registry JSONL 官方 index/types、重建 worker、实际 `npm pack` 五包、按 SHA256 唯一命名、生成 `migration-artifacts/manifest.json`、安装全部五个 overrides、执行无现场数据的 synthetic 反证。tar 字节可能因重新打包工具版本而变化，新 manifest 才是新产物的 SHA 依据，不能覆盖已冻结的正式候选包。

零写 source 检查要求已经存在一个未应用 patch 的独立 upstream checkout：

```powershell
./docs/acceptance/dsh-unified-upgrade/scripts/core-migration/rebuild.ps1 -WorkRoot "$PWD/docs/tmp/core-migration-clean-check" -Check
```

验证入口可从任何 cwd 启动，所有会话输入必须显式提供隔离副本路径；归档不包含任何生产日志、owner UUID、控制账、认证或私有配置：

```powershell
$entry="$PWD/docs/acceptance/dsh-unified-upgrade/scripts/core-migration/run-tests.mjs"
$build="$PWD/docs/tmp/core-migration-rebuild-01"
$inputCopy='D:/caller-selected-isolated-history-copy'
node $entry --work-root $build --case history --input-root $inputCopy
node $entry --work-root $build --case edge-generations --input-root $inputCopy
node $entry --work-root $build --case writer --input-root $inputCopy --check
node $entry --work-root $build --case writer --input-root $inputCopy --copy-root "$build/writer-copy-01"
node $entry --work-root $build --case v4-negative --input-root "$build/writer-copy-01"
node $entry --work-root $build --case worker-negative --input-root "$build/writer-copy-01"
```

writer 动态选择具有 owned receipt 的会话，可选 `--session-id`；原 v0 字节保持不变，必须确有 `tool/result` replacement 新事件，然后 flush 并由新 Context 与 native Session 冷重开。`--check` 对输入零写；正常 writer 只写新的 copy-root。worker-negative 仅在重建 runtime 中写隔离 synthetic verifier 文件。入口仅部署测试脚本到 runtime，不修改 profile。history/generation 都只读输入。

已有最终候选验证：四边 strict typecheck；上游 36 文件/1163 tests；81 session/24488 events/82 owned identities/2 seeds；每边 144 Convergent records、288 range endpoints；v2→v3 额外 118 system replacement 的真实 generation 映射；实际 writer 新增 27 events 并包含真 projection，81 v0 bytes 不变，V4 冷重开；完整 V4 与真实 bundled worker 均通过正例并拒绝 5 类闭 turn/伪造 source/恶形 payload。正式部署状态由根代理独立验收。

归档流程也已独立实跑：从官方 URL 新 clone 到 `docs/tmp/core-migration-archive-proof2`，固定 `core.autocrlf=false` 保持 LF，精确 commit 与严格 `git apply --check` 通过；从空 runtime/toolchain 安装、四边类型检查、五包打包/安装和 synthetic 均通过。再用这些新构建产物通过上述 81 会话只读、逐边 generation、实际 writer、V4 negative 与 worker negative 入口。归档 patch 是 git 原始 stdout 的 LF 文件（51281 字节，SHA256 `51a75e33f33eaf79c6f0e27526c3b9ae18268f3d2fcacd101ec5b6750eb56ebe`），避免 PowerShell 文本转换造成 context 行 CRLF 而无法在 fresh upstream 应用。所有现场 fixture 仅留在 gitignore 的 tmp，不进入本归档。
