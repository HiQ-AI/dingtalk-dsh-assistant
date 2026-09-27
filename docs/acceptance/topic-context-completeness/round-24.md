# UAT2 双项目实际验收与本地启用

日期：2026-09-26。用户明确选择 UAT2；同时覆盖 Dataset 和 Dataset Web，连接共享 UAT 数据环境。

## 结论与范围

两个项目的实际本地验收配置已经安装到 `D:/dsh_home/profiles/web/cordis.patch.yml`，新本地实例 PID 24028 健康。Dataset 真实登录、单位分页查询通过；Dataset Web 真实登录页和已登录单位管理页面通过。两轮都确认会话注销、服务停止及端口释放，未创建业务数据。

这次证明的是只读查询及页面读取场景。写入、合并计算、删除等任务仍须提供对应实际场景及清理证据，不能用本轮结果替代任意功能验收。草稿、工作区查询已登记但本轮未实际执行。未重放历史任务、修改 PR #371、发送钉钉消息或部署远程 UAT。

## 实际候选与配置

- Dataset：UAT2 隔离候选提交 `9101283277add9fd34fa85f302420c0fd718ba3a`，含用户批准的后台任务关闭模式。保留真实鉴权和黑名单启动只读加载。
- Dataset Web：UAT2 提交 `198e04afffff02dc1e865fe65f6eefff8a07f4ac`。源 checkout 未修改。
- 前端伴随后端 JAR SHA256：`ffe45c7c29d8723ef171877cc025a1e53596c57c508a92db3db29f9157035d8b`；浏览器逐次核对代理后端 origin 和制品 SHA。
- 最终 bundle：`D:/dsh_home/workflows/runtime-v2/local-acceptance/projects-d587256ca60a.json`。生成配方为 `scripts/prepare-uat2-project-configuration.mjs`；连接及凭据均保存在仓库外。
- Web 实跑使用的 `projects-f86b0ce3237c.json` 与最终 bundle 的 `dataset-web` 配置完全一致；唯一变化为 Dataset 对黑名单只读加载的说明纠正，见 `round-24/bundle-comparison.json`。Dataset 最终实跑使用最终 bundle。
- 当前配置只接受明确选择 UAT2 的任务，不将 UAT2 设为以后所有任务的默认目标。

## 验收证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 工作流与节点展示 | 100/100 PASS，160.17 秒 | `docs/tmp/uat2-local-integration-20260926/workflow-final-tests.log` |
| 项目命令、只读场景、配置安装 | 20/20 PASS，2.95 秒 | 同目录 `project-tools-final-tests.log` |
| Windows 生命周期执行器 | 11/11 PASS，172.43 秒，含延迟就绪、错误 PID、检查启动失败反例 | 本轮代理工具捕获输出；未另存日志，不引用旧 6 项日志 |
| Dataset 单位分页 | expected=actual=`{"code":"200","nonempty":true}` | `round-24/dataset-receipt.json` |
| Web 登录页 | expected=actual=`2` 个输入框 | `round-24/dataset-web-receipt.json` |
| Web 已登录单位页 | 首行单位单元格 visible=`true`，截图人工复核为真实单位列表 | 同上；原图保存在外部只读证据目录 |
| 清理 | 两轮均 dataCleaned/processStopped=true，read-only，createdResources=0 | 两份收据及 `process-readback.json` |

最终 Dataset：准备 185698ms、启动 45333ms、用例 10272ms；最终 Web：依赖准备 92152ms、后端启动 39774ms、前端首次冷编译及就绪 935968ms、用例 29797ms。前端冷启动约 15 分 36 秒，不能称为快速启动；本次删除了准备阶段的重复生产打包，工作流构建检查仍独立保留。前四轮失败及修正见 round-23，未覆盖失败证据。

原始实际执行目录：`docs/tmp/uat2-local-integration-20260926/backend-final/` 与 `web-round5/`。重复执行使用本目录 `scripts/run-uat2-project-acceptance.mjs`，每次创建新的运行身份，不能复用旧收据放行新任务。

## 本地部署回读

- 停机备份：`D:/dsh_home/backups/uat2-local-acceptance-20260926-201346`，728 文件，有逐文件哈希清单；控制库、Domain、profile 哈希独立核对。
- 原生 CLI 安装唯一目录内 Assistant 0.5.15 本地包，tgz SHA256：`6C397F214763F95F92E1654F567624E11C9A0C1443FDF81E0DF0ACC4476560E4`。未发布正式版本。
- 81 个 Assistant JS/YML 与源码哈希一致，manifest 一致；执行器 SHA256=`5d5044982f6c17db7cba2bbab3813a97997151d43c92efb06c55f66763a0c76e`。
- profile 只新增两项 localAcceptance。独立 `--check` 返回 changed=false、writes=0，profile SHA256=`e01838044ddf78bb4a59d343a0744a7cb9b23e65ce3a1f778ac050586bc8c245`。
- 旧 PID 17092 已退出；新 PID 24028 仅监听 `127.0.0.1:3080/18998`。health=ok、recoveryIssueCount=0、inboundProcessing=true。
- 73 个任务身份及状态未变；37 个历史节点、20 类产出在线分页/文档回读通过；5 个任务保留 executionTiming；目录接口 HTTP 200。
- 认证 Web HTTP 200。最初 ad-hoc 回读脚本自动跟随 303 时没有保存 Cookie，得到 401；按当前服务源码的 token→303/Cookie→根页面流程修正后通过，没有修改服务鉴权。
- 验收端口 57767、58339、59980 均无监听；本地验收服务不常驻。

上述部署小型证据保存于 `round-24/`。大型包、私有请求账、会话缓存及连接文件不入库。当前工作区保留先前 WIP，本轮没有进行远程提交或合并。
