# 第 3 轮：UAT 源码包流程纠偏

## 现场与范围

dataset-web `feature/uat3-base` 的提交 `f67040ca0dd67a664d21688f0ae72f27b58e32b3` 先后产生 #280/#282 慢速 clone 失败。叶子随后上传源码包并取得 PUT 201，触发 Woodpecker #283；但 #283 API 独立回读总耗时 552 秒，其中 `clone-source` 410 秒、build/push 111 秒、restart 17 秒、通知 11 秒，没有 `prepare-uploaded-source`。精确提交中的 `.woodpecker/dataset-web-uat.yaml` 也只有 `clone-source`，且不包含上传脚本；源码包接入提交 `3467072f` 不是 `f67040ca...` 的祖先。因此问题不只是“是否调用上传”：旧流程没有要求先验证目标 UAT 分支具备消费源码包的流水线配置，导致 201 被误当成快速路径已经生效。

用户明确限定：不修改所有叶子的插件通用机制，只修实际选择开发/UAT 部署流程的任务。本轮未修改 Runtime、Store、Task checkpoint schema 或其他流程。

## 方案核对

当前 `D:/baibu-agent/docs/spec/dataset-web-source-package-build.md` 和 `docs/spec/dataset-source-package-build.md` 表明：上传开始会认领同环境/分支/SHA 构建键；上传成功取消同键排队或运行的 Cron pipeline，触发携带代码包变量的 manual pipeline；未上传才保留旧 clone。dataset-web 仓库自带 `scripts/upload-woodpecker-source.ps1`，因此正确顺序是取得 merge SHA 后立即在远端分支头的干净检出上传并回读 201，而不是先等待自动 clone。

## 实施与验证

- 仅将现场 `workflow-uat-delivery` 从 r3 修订为 r5，taskPromptsVersion 4→6；r4 首先消除了“上传或其他触发”的可选表达，r5 根据 #283 反证补齐合并前前置检查。其他 9 条流程的 ID/revision 未变，agent workspace、模型、代理、通用叶子提示和并发配置由独立回读确认未变。
- 新正文明确：合并前必须从目标 UAT 分支头确认流水线含 `prepare-uploaded-source`、`clone-source` 受 `SOURCE_PACKAGE_ID` 条件排除，且仓库含现行上传脚本；缺任一项时，201 也不能证明消费代码包，不得继续合并/上传。前置成立后才立即上传，并同时回读 `prepare-uploaded-source` 存在及 `clone-source` 未执行。
- `docs/acceptance/task-decision-validation/scripts/update-uat-source-upload-flow.mjs --check` 可零副作用确认目标版本；`--apply` 只提交 taskPrompts + CAS 版本，并仅保存无凭据的前后流程快照。
- 两条当时运行且引用 UAT 交付流程的任务均自动重新加载新版流程；故障任务的旧审阅因流程修订失效并按新版重新规划。没有选择 UAT 交付流程的任务不受影响。

## 边界

本轮纠正的是适用流程配置及现场注入，不声称插件能够从任意自然语言自动验证外部上传事实。#283 已证实为“上传受理但流水线仍 clone”，不是快速路径；若要让 UAT3 真正提速，还需由相应业务任务在授权内把已有源码包流水线接入提交纳入 UAT3 基线，再用新的真实流水线回读耗时。
