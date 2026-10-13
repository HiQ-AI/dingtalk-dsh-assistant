# 第八轮：浏览器回归及双包核验

2026-10-13。`node docs/acceptance/task-detail-redesign/scripts/verify-browser.mjs round-8` 自动断言24/24通过、零页面错误、零业务写入。第七轮和本轮的产品源码摘要相同，等待视口回调后 initial-visible 通过，确认该次失败属于脚本测量同步。

## 浏览器与人工检查

- 结果：`docs/tmp/task-detail-redesign/round-8/browser-results.json`。headless Edge155.0.4283.45、React18.3.1；原16项和新增8项全部通过。
- 新增组合：Owner导航、绑定边界、零流程空态、跨页后台刷新、隐藏删除延后焦点、checkpoint保留分页展开、重试更新节点会话及正文、直接切另一任务清除旧提示。
- cross-task-notice 的真实请求路径为 A/detail → B/detail → B/detail，通过归档卡片直接切换，没有经“返回看板”清空选择。B无旧删除提示，刷新保留B自己的步骤。
- 人工检查 desktop、dark、narrow、owner-only-completed、cross-task-clean-notice 截图。前四项语义与布局通过；B的步骤已缩为一个，但夹具继承了A的三阶段plan，截图出现完成任务仍显示等待/待执行阶段的矛盾。矩阵 cross-task-notice 人工检查记 FAIL，下一轮只修正B的测试计划并加断言，产品源码不变。

## 工程证据

- Observer 单元38/38：复用第七轮当前产品源码的实跑，日志 `docs/tmp/task-detail-review/ui-unit-round-7.log`。
- Service10/10及真实v25 checkpoint1/1：复用第六轮结果。后端未再修改，SHA256仍为 `da0d27ac64cf0dc0cf5b1126def6f5bae33eba20e0cc610e4e853ffa4a842c2b`。v25结果只保存在本次会话工具输出：tests1/pass1/fail0、234312.1159ms，未重定向日志，不补造日志文件。
- `node --check` 分别检查 workflow-service.js、web-client.js、verify-browser.mjs，全退出0；`git diff --check`退出0，仅既有LF/CRLF提示。
- 严格UI审计使用 `docs/acceptance/task-current-steps/scripts/ui-audit-config.json`，输出 `ui-audit.json`，0错误、0警告、0未决。
- `npx --yes -p @google/design.md designmd lint docs/manual/observer-design.md`退出0，0错误、1条既有纯Markdown无YAML提示，继续沿用运行时token权威。

## 双包独立核验

```powershell
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/task-detail-redesign/round-8/packages
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination ../../docs/tmp/task-detail-redesign/round-8/packages
```

Python tarfile分别解读包内 `package/workflow-service.js`、`package/web-client.js`，与当前源码逐字节一致；独立 `Get-FileHash`再核对摘要。Assistant包904492字节、Observer包39285字节。摘要见 `package-check-round-8.json`，首轮 `package-check.json` 保留。

Observer源码SHA256为 `b6e0898858786273dd69502ccbcc3cf2aca571f591490149669cfded8480c85b`，与浏览器结果一致。打包、语法及tarfile日志均在 `docs/tmp/task-detail-redesign/round-8/`，二进制不入库。两包是源码交付证据，不代表已经安装或部署。
