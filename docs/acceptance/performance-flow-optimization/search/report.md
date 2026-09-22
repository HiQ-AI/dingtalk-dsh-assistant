# SG5 搜索瓶颈与责任包修复

本轮保持生产运行包与业务文件只读。上游修复位于独立克隆 `D:/project/deepseek-harness-search-performance`，分支 `feature/glob-fixed-prefix-pruning`，基线官方 `dsh-v0.1.2-rc.1`（a66e4702047846cdaa10c66c9d3df3951f5ea70d），本地提交 `884bafd6589862a2ea14499adbaeb5dbc198771e`。没有推送官方仓，也没有安装或部署。可审阅补丁为本目录 `dsh-glob-fixed-prefix.patch`。

## 根因及修复

真正责任包为 `@deepseek-ai/dsh-tool-fs-search@0.1.2-rc.1`，不是 `dsh-fs`。其 `src/glob.ts` 原实现把固定前缀模式仅作为 `rg --glob` 文件过滤条件，仍从原根遍历；`--hidden --no-ignore` 包含了依赖目录。三条代表原参数（docs/**/goal.md、精确 scripts/*、精确 checklist 文件）重放均在 32 秒未完成。

修改只有当搜索根解析后等于 session cwd 时，给固定目录前缀增加 directory-only override glob（例如 `!/*/` 与 `/docs/`），提前剪除其他目录；原 pattern、cwd、path、修改时间排序及 VCS 排除规则保持不变。遇到通配目录便停止继续缩小。这里没有更改超时，没有新增搜索重试，没有引入本机文件系统去破坏远程 subprocess 实现。

没有采用直接重写 pattern 或搜索根：无斜杠模式会递归按 basename 匹配，可能扩大结果；不存在的固定前缀改成 root 后会从空结果变为错误。测试覆盖这两项反例。复现必须设置真实 session cwd，否则 rg 的匹配基准与生产不同；初步实验发现该偏差后已修正，最终 results.json 为显式 D:/baibu-agent cwd 的重跑数据。

## 实测与边界

原审计34次失败全部以 D:/baibu-agent 为根。26条具备固定目录前缀：

- 22条新实现耗时112–662毫秒，结果集均与保留 hidden/no-ignore/VCS规则、保留原pattern并限定对应目录的原生rg完全一致。
- 4条 worktrees 宽范围在3秒探测未结束；随后按32秒真实限独立复跑仍全部超时，记录于 pruning-long-results.json。不得当作优化成功。
- 8条没有固定前缀（例如 **/goal.md、**/*kube*），本修复不改变范围；未浪费时间重跑这8条全根超时。
- 不能据此宣称总体超时率已小于5%。四条仍失败与八条无前缀需使用任务已知的具体仓库、goal或验收目录作为搜索位置。

结果文件只记录文件定位及进程状态，没有读取或输出业务正文。原调用超时没有完整结果，不能直接声称原全根与新实现的生产全集逐条一致；等价性依据真实rg夹具的完整集合断言和22个已完成的相同目录对照。

## 插件准确工作位置

插件 runtime 新增 `taskWorkLocations(task)`，来源限定为现有 result/lastWaitingResult artifacts、checkpoint.evidence、上一执行轮次的 artifacts/checkpoints、reopen/resume handoff。当前checkpoint schema没有context字段，因此没有发明该存储字段。

仅对提取出的原生绝对路径 stat，不枚举目录；已存在的goal、工件、验收目录及 `.git` 标记验证过的仓库/worktree随 topicInputText 传递。最多检查24个候选，超量显式给出 unchecked；无已验证位置返回 unknown。存在不代表授权或旧证据仍有效。路径验证后的await窗口提交前再核对Task状态、inputVersion、runSequence，避免向已经变化的Task注入旧输入。

## 已执行验证

- 上游 `pnpm exec vitest run packages/fs/tool-fs-search/tests/tools.spec.ts packages/fs/tool-fs-search/tests/integration.spec.ts`：122 PASS、1 SKIP。
- 增加load-path后：124 PASS、1 SKIP（3文件）。随后补充prefix边界测试单跑tools：107 PASS、1 SKIP。
- 上游 `pnpm exec oxlint`（三个修改源码/测试文件）：exit 0。
- 上游 `git diff --check`：exit 0；提交后独立 `git status --short --branch` 干净，`git log -1`证实提交。
- 插件 `node --test --test-name-pattern='任务工作位置' test/runtime.test.js`：1 PASS，涵盖存在/不存在、原生/远程、历史来源、goal/acceptance/worktree定位。
- `verify-semantics.mjs`：3组完整集合相等，hidden/ignored保留、VCS排除、basename重写反例通过。
- `verify-pruning.mjs` 从责任包真实修改函数提取并执行argv，而非另抄一份优化算法；真实根原参数22组完成且与限定范围对照一致。

复现时显式提供本机私有输入，原始 diagnostics 不入库：`reproduce.mjs --diagnostics <private-json> --cwd <recorded-session-cwd> --rg <rg-binary> --out <summary-json>`；`verify-pruning.mjs` / `verify-pruning-long.mjs` 同时传 `--diagnostics`、`--cwd`、`--rg`、`--source <glob.ts>`、`--baseline <summary-json>`，可用 `--out` 指定输出；`verify-semantics.mjs --rg <rg-binary>`。脚本从私有输入按case index取原参数，并核对pattern SHA256；输出只保留匿名分类、固定前缀层数、耗时、计数和集合SHA256。源码路径与rg二进制由CLI指定，不打印原搜索模式、工作区目录或stderr正文。

结果文件已将完整路径集合替换为 count + SHA256；原始业务文件名不入库，复跑仍在内存中逐项比较后保存摘要。生成夹具仅在本目录保留且已gitignore。runtime扩大筛选回归发现“历史导入只发送 Topic 索引，不重放历史消息正文或指令”失败，已反馈主代理，不能把该轮宣称全绿。该轮失败后存在未结束句柄，停止了本轮专用测试进程。

公开交付前再次脱敏：原业务pattern及搜索根/收窄目录已从三个结果JSON移除，保留case index、pattern SHA256和固定前缀层数。耗时、失败、计数及集合SHA256均保留，原始业务数据未改动。四个复现脚本通过语法检查；参数化后使用匿名三文件夹具实跑，范围对照与新实现集合一致（3个文件）。该脚本验证没有替换历史测量结果。
补丁以零上下文diff导出，应用时使用 git apply --unidiff-zero；已在上游提交HEAD独立执行反向 --check 验证。此格式避免将格式补丁的空白上下文当作源码尾随空白。
