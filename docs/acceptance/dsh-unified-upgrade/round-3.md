# 第3轮：真实客户端与历史语义验证

本轮仍在执行，不能作为部署通过记录。

- 独立浏览器实际打开新版设置卡片，出现React #130；Assistant旧IconRefreshOutline16导出已移除。精准改为官方Regular导出，Observer三个旧14图标同时按原尺寸替换。源码及生成脚本保持一致，40项相关测试通过；待新包浏览器回读。
- 四条迁移边需要处理Convergent严格metadata：range.start/end按原生seq映射，surfaceGenerationBefore按replace次数映射；v2→3的新增system replace会改变generation。不能opaque保留旧值。
- 81个现场会话副本进一步验证发现V4拒绝已完成turn之后的task-owner工具结果投影。现有producer明确在whenIdle后做surface replace，需严格owned身份、原成功读取回执及sourceEventSeqs校验，JSON内原生seq须同步映射。全81及普通闭turn负例未完成，正式保持旧实例。
- root独立实跑apply-host-upgrade.test.mjs：20/20 PASS，包括四个白名单迁移包实际入口与tamper反证。另独立阅读发现Readback/Resume仍无条件走原CAS check，部署后将无法恢复；正在修正为安装后verify路径并补回归。

待闭环：历史全量副本与写后重开、generation反证、认证浏览器新包、最终部署Check及正式维护切换。

- 新UI包真实认证隔离Chrome通过，console/pageerror=0，checklist及两态箭头实际点击；Runtime GET仅隔离夹具桥接，正式原生3080尚待部署后核验。root独立重跑client+observer-client 37/37 PASS；agent含slot相关为40/40。
- Readback/Resume修复后root独立重跑21/21 PASS。正式原native旧CLI对新隔离manifest安装两新包成功（exit0），未更改正式profile；避免仅以新CLI验证升级路径。
- 最新正式health=ok、Bridgehealthy、recovery0、同PID46964拥有3080/18998，升级未执行。

- Provider定向4文件52测试、typecheck/build/pack及真实alpha2 API11模型注册/prepare/dispose通过，无网络请求；完整Windows check未全绿（既有canary进程合同、EPERM/POSIX临时目录用例），未声称全量通过。包为同版本本地alpha2适配构建。

- writer flush尚未通过：JSONL worker.cjs静态内联原迁移，四edge override不足。必须重建JSONL worker同一迁移闭包，并验证worker bytes、实际写后reopen；readonly PASS不能代替写路径PASS。

- 新Connect候选CLI对实际DSH_HOME执行status --json（源码明确不refresh）：version0.2.0-alpha.3/status signed-in/exit0；OAuth文件前后SHA一致，未写账户或联网。原与新路径同为DSH_HOME/.openai-codex-auth.json，实际格式v2由新parser直接支持。此项只证明存量登录可读，未证明真实推理。
