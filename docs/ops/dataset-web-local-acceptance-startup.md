# Dataset Web 本地验收启动

## 工作区与环境

用户明确选择 UAT2 后，从 `origin/feature/uat2-base` fetch 最新代码，以 `198e04af` 建立独立工作区 `D:/project/worktrees/dataset-web-uat2-local-acceptance`，分支 `codex/uat2-local-acceptance`。源 checkout 保持原分支及内容。根目录未发现 AGENTS.md，开发方式依据当前 CLAUDE.md；未修改受局部指引约束的 details 源码。

执行器固定 `D:/soft/node-v22.13.0/node.exe`。Yarn 为仓库 packageManager 声明的 1.22.21，实际脚本位于 `C:/Users/64554/AppData/Local/node/corepack/v1/yarn/1.22.21/bin/yarn.js`。首次安装由 Corepack 取得该精确版本并使用 Node24 执行，后续构建与启动固定 Node22；安装 `--frozen-lockfile --non-interactive` 退出 0，109.84 秒，无锁文件修改，有既有 peer dependency 警告。

## 构建与启动契约

- 构建：Node22 执行 `node_modules/@vue/cli-service/bin/vue-cli-service.js build --mode test`，进程环境 `NODE_OPTIONS=--openssl-legacy-provider`。这是测试环境构建命令，不是运行测试。
- 启动：Node22 执行同一 CLI 的 `serve --host 127.0.0.1 --port <空闲端口>`，候选目录为 cwd，窗口隐藏。
- `LOCAL_HTTP_API_PROXY` 必须由 Host 显式提供 JSON 数组，覆盖仓库开发配置中默认的 UAT1。
- `/api/dataset` 绑定本次本地后端的精确回环地址；当前 `vue.config.js` 对本地目标自动剥离 API 前缀。
- `/api/sso` 明确绑定 `https://editor2.hiqdat.dev`。本次不登录、不发送 AI 消息、不提交业务写请求。
- 仅在需要场景对应外部服务时登记额外代理，不能继承默认生产助手网关作为验收目标。

Host 可在同一进程设置受信代理映射、`VUE_CLI_CONTEXT` 和 cwd、构造 `process.argv` 后 require 真实 Vue CLI 入口；入口通过 `process.argv.slice(2)` 获取命令。OpenSSL 参数需要在启动 Node 前设置。Webpack 可能派生 worker，清理必须处理本次拥有的完整进程树。

## 登录材料与边界

仓库外 `D:/baibu-agent/.secrets/test-accounts.json` 存在 `accounts.editor_uat_admin` 与 `accounts.editor_uat_sunpeng`，元数据 `env=uat`、`service=editor`；url 字段为空，不用它猜测 UAT 编号。账户值不写入本文件或日志。本次只读取元数据与字段是否存在，没有登录。登录 `POST /api/sso/auth/login` 携带 `X-Site: 101`，可能影响同账户现有编辑器会话；真实业务场景须明确使用专用验收账户。

现有 AI 助手 E2E 会发送真实消息且运行时注入权限，旧分页验收也有 Vue 数据注入，因此均不直接复用为本轮真实业务验收。仅页面加载及依赖就绪不代表业务验收完成。

## 本次证据

安装、构建及浏览器日志保存在 assistant 隔离工作区 `docs/tmp/local-acceptance-deploy-20260926/`。
本地前端于 2026-09-26 18:49:41 +08:00 启动，PID 8508，监听 `127.0.0.1:57619`。代理 `/api/dataset` 指向本轮受控 UAT2 后端 `http://127.0.0.1:58362`（后端候选提交 `9101283277add9fd34fa85f302420c0fd718ba3a`），`/api/sso` 指向明确的 UAT2 域名。

独立 headless Edge 浏览器读取真实 `/login`：HTTP 200，两个输入框，截图人工查看符合登录页，无 pageerror。经前端 `/api/dataset/ready` 返回 HTTP 200 UP，三个 PostgreSQL 数据源、Redis、两条 gRPC 均 UP。浏览器阻断 Google/阿里外部 SDK、生产 `/collect` 遥测 POST 及所有非 GET 请求；未登录、未发送 AI 消息。

此结果只证明真实候选前端可展示且代理指向当前受控本地后端，不作为业务验收通过证据。未调用 `/unit/getList`：后端实现是空列表 stub，不能用于证明真实数据查询。需要业务数据验证时，使用已授权身份调用有实际查询实现的 `/unit/getPage` 等固定场景。

证据：`dataset-web-browser.json`、`dataset-web-login.png`、`dataset-web-process.json`。静态构建退出码 0，约 7 分 20 秒；`dist/index.html` 独立回读为 3356 字节。构建有 7 条警告（5 条 CSS 提取顺序、资源体积及入口体积超出建议值），不属于构建错误。源 checkout 与候选工作区 `git status --short` 均为空；未改源码或锁文件。完成后核对 Node22 命令与端口，停止 PID 8508 及其派生子进程；独立回读进程已退出、57619 端口已释放，见 `dataset-web-cleanup.json`。

本次手动 dev-server 未输出 Host 专用后端身份响应头，因此这份记录属于人工核对配置的启动联调证据，不冒充工作流绑定后端 origin/SHA 的浏览器验收回执。正式 Host 启动器接入后需另外产生并核对该身份回执。

## 实际配置安装

仓库提供 `scripts/configure-project-local-acceptance.mjs`，固定只接入 `dataset` 与 `dataset-web` 两个项目。外部 bundle JSON 结构为 `{ "dataset": <localAcceptance>, "dataset-web": <localAcceptance> }`；连接文件与凭据继续放仓库外，脚本不回显配置原文。

先执行零写入校验，再在运行实例已按部署流程停止后执行应用：

```powershell
node scripts/configure-project-local-acceptance.mjs --profile D:/dsh_home/profiles/web/cordis.patch.yml --bundle <绝对bundle路径> --check
node scripts/configure-project-local-acceptance.mjs --profile D:/dsh_home/profiles/web/cordis.patch.yml --bundle <绝对bundle路径> --apply
```

脚本使用目标 profile 自带 `node_modules/js-yaml`，识别 `!!js` 但保留原 YAML 代码字符串、注释与其他字节。两个配置经 runner 原生配置校验后插入，并在剥除这两项后比较完整配置，防止改变其他内容。应用前生成唯一备份，原子替换并独立读回；相同配置重复执行不写入，已有不同配置直接拒绝，不能自动覆盖。脚本不负责启动服务或把配置接入等同于业务验收通过。

## UAT2 正式 Runner 接入结果

上述手动启动记录之后，已完成正式 runner 的真实登录页、UAT2 登录、单位管理页面读取以及会话/双服务清理，且将两个项目的配置启用到本地 web profile。浏览器核对本地后端 origin 与固定 JAR SHA，未注入页面数据或权限，未创建业务数据。最终运行前端冷编译及就绪耗时约 15 分 36 秒；准备阶段只安装冻结依赖，工程构建检查仍保留。详见[本轮完整证据](../acceptance/topic-context-completeness/round-24.md)。写入类需求仍须相应可信场景和清理方案，不能用页面读取代替。
