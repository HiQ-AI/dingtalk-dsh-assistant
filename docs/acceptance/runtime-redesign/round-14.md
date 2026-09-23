# 第 14 轮：真实模型工程工作流隔离验收

日期：2026-09-24（Asia/Shanghai）。范围：当前工作树；尚非已部署版本。

## 结论

真实 `openai-codex / gpt-6-sol / low` 完成自然语言入口 S/R/I、工程文件选择、文件修改；Host 完成受管目录、选择校验、文件效果、固定命令验证、提交、条件推送和 PR 协议回读。15 个工程节点全部 `succeeded`，最终 `deliveryStatus=pr_verified`。

Git 源仓与 bare 远端均为隔离临时仓库；GitHub CLI 使用本地 fake-gh 协议夹具。夹具返回的 `https://github.com/isolated/fixture/pull/1` **不是实际 GitHub PR**。没有发送真实渠道消息，没有修改外部业务仓库。

## 可重跑脚本与原始证据

```powershell
node docs/acceptance/runtime-redesign/scripts/probe-engineering-provider.mjs `
  --profile D:/dsh_home/profiles/web `
  --output docs/tmp/runtime-engineering-live/attempt-2.json
```

该脚本会调用真实模型，要求当前配置精确为上述模型；只读使用已登录 Provider，不输出凭据。每次新建独立库/仓库，不能据此恢复上一轮业务运行。

原始报告位于 `docs/tmp/runtime-engineering-live/`，不作为版本库产物提交：

| 证据 | SHA256 |
| --- | --- |
| attempt-1.json | `4E473EC784284B67474DF1B7DBFF189A7A98731BB986A5DFB398E65F844B69A0` |
| attempt-2.json | `83E41A5B59A481C4A943C0C5B84080818E7C6FF1171CADD0EFCC676BF2B8A033` |

## 首轮真实失败与修复

第一轮 S/R/I 已完成，分别耗时 4516/5761/6371 ms；工程在受管目录建立时进入 `DELIVERY_RECONCILIATION_REQUIRED`，效果账 `unknown / WORKSPACE_GIT_FAILED`，未执行后续节点。

独立执行隔离 Git 命令复现：受管仓库路径长 193 字符，Git 2.39.1.windows.1 写入 `.git/objects/pack/*.keep` 时超过 MAX_PATH，报 `Filename too long`。更深路径另触发 clone 子进程的 `$GIT_DIR too big`；仅设置 `core.longpaths` 不能消除后者。

修复采用一条固定协议：在最终受管目录初始化仓库，定向 fetch 冻结 baseCommit，再 checkout 并校验文件清单/字节；Git 调用明确使用 `core.longpaths=true`。不共享源对象/硬链接、不复制源工作副本。同步修复 Node `mkdtemp` 在超长 `.git` 路径返回 ENOENT，候选临时目录改为 UUID 名称加原子 mkdir。

Windows 超长路径专项测试实跑通过；第一轮未知效果保留为测试证据，没有绕过账本重放。

## 第二轮模型请求

所有 5 次请求均在实际 Provider 调用处观测到 `reasoningEffort=low`。

| 节点 | elapsed ms | input tokens | output tokens | total tokens |
| --- | ---: | ---: | ---: | ---: |
| S | 6136 | 980 | 143 | 1123 |
| R | 3794 | 587 | 58 | 645 |
| I | 3427 | 1096 | 87 | 1183 |
| select-files | 5015 | 224 | 34 | 258 |
| propose-changes | 5382 | 294 | 94 | 388 |
| 合计 | 23754 | 3181 | 416 | 3597 |

总墙钟 66813 ms，包含脚本初始化隔离夹具；不是生产群消息 P95，也不是每种工程任务的时延保证。

## 工程节点持久时间线

时间来自 SQLite 中 node.claim 到 node.commit 的独立回读，不根据 Agent 文本推断。

| 节点 | ms | 状态 |
| --- | ---: | --- |
| prepare-workspace | 3223 | succeeded |
| index-files | 5952 | succeeded |
| select-files | 5323 | succeeded |
| validate-selection | 57 | succeeded |
| read-files | 5789 | succeeded |
| propose-changes | 5567 | succeeded |
| apply-changes | 2727 | succeeded |
| verify-candidate | 5837 | succeeded |
| prepare-commit | 5525 | succeeded |
| commit | 3041 | succeeded |
| prepare-push | 2544 | succeeded |
| push | 4191 | succeeded |
| prepare-pr | 40 | succeeded |
| create-pr | 1020 | succeeded |
| finalize | 227 | succeeded |

Host 侧 index/read/verify/prepare-commit 各约 5.5–6 秒，反复进行 Git 身份/对象校验仍是优化对象；本轮没有声称整体性能目标已经达标。

## 独立交付回读

- 源仓 `src/greeting.txt` 仍为 `hello\n`。
- 受管产物 `src/greeting.txt` 为 `hello workflow\n`，SHA256 `21beb2fac5d7ed49f3acd6ba548133a669dea7fbc5afef5bac8f6bdfcba82376`。
- 新产物 `src/result.txt` 为 `done\n`，SHA256 `d117fa006ba9208500b2930ce69cbde436c647afa917cb7396a9bc9111a46dd2`。
- 固定 Node 校验真实运行并检查两个文件内容，输出 `PASS greeting and result exact content`。
- 独立 `git ls-remote` 回读本地 bare：`refs/heads/codex/task-635d8db9fe515f6ec57061db` 指向 `992c489122e3bd424e45848c19417686f5ea0636`，与最终工作流工件一致。
- fake-gh 创建后返回非零码模拟 ACK 丢失；适配器通过 list/view 读取工单 #1 / OPEN / 相同 head SHA，finalize 再次回读后才记交付完成。

## 尚未覆盖

- 真实 GitHub 远端鉴权、推送和 PR 创建；真实渠道送达。
- 大仓库索引分页、超过 48KB 的材料分批处理、自动修复循环。
- 任意工程测试环境与后台子进程恢复；当前验证作业仅运行 Host 显式配置的固定前台 argv/steps。
- 性能分位数、持续流量、完整业务任务回放。
