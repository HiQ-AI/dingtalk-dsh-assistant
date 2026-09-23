# Round 17 — 813 文件候选物批处理性能

## 根因与修改

`execution-candidate.js` 原来每个文件启动一次 `git hash-object`，读取每个 blob 又启动一次 `git cat-file`。813 文件冻结并完整读取至少新增 1626 个串行 Git 子进程。真实 dataset-web 验证由另一子任务报告已超过五分钟仍未完成该阶段。

本轮改为 Git 原生批处理，未跳过验证：

- 冻结仍逐文件检查路径、父目录链接、模式、大小、打开句柄身份和读前后时间/字节变化；将已校验原始字节写入独立临时副本，一次 `hash-object -w --no-filters --stdin-paths` 入库；每个返回 OID 与 Node 根据确切 blob 字节计算的 SHA 独立比对。
- 读取使用一次 `cat-file --batch`，按 OID 去重；严格验证响应顺序、对象类型、声明大小、二进制边界、尾部及每个 blob 的 SHA。保持 16MB 单文件、64MB 总量、10000 文件限制。
- 首次 readFile 才加载 batch，index/manifest 查询不预读全部正文。快照内共享已验证私有缓存；每次返回 Buffer 副本，检查器修改自己的 Buffer 不会改变后续读取。
- 没有使用源工作区字节替代冻结 blob，没有将工作区路径交给模型选择命令。

## 相同 813 文件合成实测

Windows，本地 Git，813 文件共 19,398,180 bytes。新旧均实跑结束；测试期间本机还有其它验证负载，单次结果不代表稳定 P95。

| 阶段 | 修改前 | 修改后 |
| --- | ---: | ---: |
| freezeCandidate | 126945 ms | 12806 ms |
| readCandidate 初始化 | 2029 ms | 1904 ms |
| 读取全部 813 个 blob | 168377 ms | 1066 ms |
| 总计 | 297352 ms | 15776 ms |

本次总耗时降低约 94.7%（18.8 倍）。两轮独立计算结果完全相同：

- Git tree：`a7c6fc01cdbc40939ce665d0551b143eafebf803`
- 依路径顺序拼接所有冻结文件的 SHA256：`a3c5afbcb4dc1621897fa0ccad553ca3a587528b25635907c3ab48a1087bd768`
- 修改前模块快照 SHA256：`BAEECB0F541CA71A463988085846468BA1D2F11C002AD278F55BCAFFF94A1D2B`

原始本机 JSON：`docs/tmp/candidate-batch-benchmark/baseline.json` 与 `current.json`；不提交临时仓库或二进制。

复现当前实现（在仓库根运行）：

```powershell
node docs/acceptance/runtime-redesign/scripts/benchmark-candidate-batch.mjs
```

脚本创建独立 813 文件临时仓库，初始化真实 Git，完整冻结、逐文件读取，并输出 `docs/tmp/candidate-batch-benchmark/current.json`。对照实验可先复制待测模块源码到临时 `.txt`，将该快照路径作为第一个参数、报告 JSON 路径作为第二个参数；源码快照只作为本地测试模块执行，不加载远程内容。

## 正确性验证

- `node --test test/execution-candidate.test.js`：原有 4 项全部通过（新增测试前完整执行）。
- `node --test --test-name-pattern='Git batch' test/execution-candidate.test.js`：新增测试 1/1，通过空 blob、二进制换行/零字节、重复 blob、Unicode/空格路径、返回 Buffer 隔离，以及真实 Git loose object 同长度篡改后的 SHA 拒绝。
- `node --test --test-name-pattern='MAX_PATH' test/execution-workspace.test.js`：1/1，通过 Windows 深路径冻结/读取。
- `node --check docs/acceptance/runtime-redesign/scripts/benchmark-candidate-batch.mjs`：通过。

真实 dataset-web 的安装/build 准入由另一子任务独立执行，不用本轮合成性能结果代替真实工程构建结论。
