# Codex Connect alpha2 本地适配重建

该目录保存跨轮重建配方。`../fixtures/codex-alpha2.patch` 是跨轮静态源码补丁，首次建立 fixtures 是为了保留可独立审查和重放的交付来源。它只含 source/config/checker/test；不含生成 lib、换行噪音、现场配置、认证信息或旧云端验收结论文档。

## 来源和边界

- 上游： https://github.com/franksong2702/dsh-codex-connect
- 基线：`7b34dd543642f8a059b64fee191c23b5d80b1ac7`。
- 补丁 SHA256：`7BA62BF9C2E7F3AEBD54EF60F24BA372EEA9F0A80AB1044CF42509E749FC7F06`。
- 本轮部署候选 tgz SHA256：`716E2EE219334AB4C4EDEA695F9A61C712ADD9EF073E899E4999CF57A09FFBBC`。
- 仍沿用 `0.2.0-alpha.3` 版本号，是本地修改包，不等于 npm registry 同版本。增加精确 DSH `0.2.1-alpha.2`、Cordis `4.0.5-alpha.1` 声明；没有版本检查豁免。
- Node `24.19.0`、pnpm `10.13.1`；使用基线 lockfile，frozen 安装，不升级依赖。真实宿主 API 验证应使用已安装的原生 DSH `0.2.1-alpha.2` package manifest 的 realpath。

## PowerShell 7 配方

先从仓库根记录这些绝对路径。目标源码目录必须是当前仓库 `docs/tmp/` 下新的独立目录；不要覆盖主检出或旧候选。

```powershell
$taskRepoRoot = (Get-Location).Path
$taskSource = Join-Path $taskRepoRoot 'docs/tmp/codex-alpha2-rebuild'
$taskArtifacts = Join-Path $taskRepoRoot 'docs/tmp/codex-alpha2-rebuild-artifacts'
$taskPatch = Join-Path $taskRepoRoot 'docs/acceptance/dsh-unified-upgrade/fixtures/codex-alpha2.patch'
node --version
pnpm --version
# 必须分别为 v24.19.0 与 10.13.1。
git clone --no-checkout https://github.com/franksong2702/dsh-codex-connect.git $taskSource
git -C $taskSource config core.autocrlf false
git -C $taskSource checkout --detach 7b34dd543642f8a059b64fee191c23b5d80b1ac7
git -C $taskSource apply --check $taskPatch
if ($LASTEXITCODE -ne 0) { throw 'Patch check failed' }
git -C $taskSource apply $taskPatch
git -C $taskSource diff --check
Set-Location $taskSource
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Frozen install failed' }
pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
pnpm exec vitest run tests/compatibility.spec.ts tests/adapter.spec.ts tests/provider-proxy.spec.ts tests/provider-proxy-classification.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'Focused tests failed' }
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
New-Item -ItemType Directory -Force $taskArtifacts | Out-Null
pnpm pack --pack-destination $taskArtifacts
if ($LASTEXITCODE -ne 0) { throw 'Pack failed' }
Get-FileHash (Join-Path $taskArtifacts 'dsh-codex-connect-0.2.0-alpha.3.tgz') -Algorithm SHA256
# 应与本轮部署包SHA比较；不一致时先检查依赖/源码/构建差异，不使用旧SHA宣布通过。
```

API 实跑另行提供已安装宿主路径，禁止认证/真实模型请求：

```powershell
$taskHostManifest = '填写隔离已安装DSH的package.json绝对路径'
$taskRealHostManifest = node --input-type=module -e 'import {realpathSync} from "node:fs"; console.log(realpathSync(process.argv[1]));' $taskHostManifest
node scripts/check-dsh-alpha2-api.mjs $taskRealHostManifest
if ($LASTEXITCODE -ne 0) { throw 'Alpha2 host API verification failed' }
```

测试脚本创建空的临时 DSH_HOME，并禁止全局 fetch；只通过原生宿主 resolver 注册 provider、解析模型、prepareCall 和 dispose，最后清理临时 home。Windows 使用原生 junction，避免目录 symlink 的 EPERM。不要传用户名、OAuth token 或真实凭据，不做 login 或推理。

## 本轮实跑证据

- 原构建：typecheck/build/pack 退出 0；4 文件 52 测试通过。
- 原生 DSH `0.2.1-alpha.2`／Cordis `4.0.5-alpha.1`：11 模型、11 reasoning、11 prepareCall、注册和释放通过；networkRequests=0，realCredentials=false。
- 全量 Windows unit：139 文件中126通过13失败；1759测试中1575通过183失败1跳过。失败包含 EPERM fsync/symlink 与 TEMP_DIRECTORY_UNSAFE 等 POSIX 边界。不能把旧云端全绿记录当作本轮结果。
- `pnpm check`：LF checkout 修复工作流文本合同失配后，在现有 canary descendant process timeout 合同失败（1/77）。未为无关实验功能进行源码修补；不声称本轮完整 check 通过。
- 独立新检出已验证 patch apply --check、apply、diff --check，且仅出现7个预期文件（6个修改+1个新增API脚本），不包含 lib 或旧验收文档。
- 运行日志在本轮 `docs/tmp/codex-{typecheck,focused,build,alpha2-api,...}`；部署 tgz 在 `docs/tmp/codex-artifacts/`，大 binary 不入库。

后续发布需由上游维护者选定新版本并完成其发布验收。本配方不授权向公共上游 push、npm 发布、账户操作或服务部署。

- 2026-10-13 本轮额外独立fresh检出重建：frozen安装、typecheck、4文件52测试、build、pack均退出0；tgz与部署候选逐字节一致，SHA256仍为716E2EE219334AB4C4EDEA695F9A61C712ADD9EF073E899E4999CF57A09FFBBC。fresh源码API再次11/11 prepareCall及dispose、0network通过。日志为docs/tmp/codex-rebuild-*，未发布或部署此重建产物。
