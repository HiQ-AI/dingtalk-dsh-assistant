# SG1 资源身份和占用阶段验证

日期：2026-10-28。使用当前隔离 worktree 的真实 SQLite store、原生 Host 和工具注册。所有数据库位于测试临时目录；未修改运行实例、个人工作区目录或现场 SQLite，未触发部署和 CI。

## 当前结果

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 资源存储与升级 | 28/28 PASS | `sg1-store-legacy-replay.log` |
| 原生目录、两阶段原会话续办和旧执行读取；既有资源与通信回归 | 6/6 PASS | `sg1-native-final.log` |
| 执行目录压缩和执行文档投影 | 27/27 PASS | `sg1-projections.log` |
| 可安装示例零写入校验 | PASS：`{"valid":true,"resources":4}` | runbook 内原命令实跑 |
| `git diff --check` | PASS | 只有既有 LF/CRLF 提示，无空白错误 |

实跑入口：

```powershell
node --test test/dynamic-execution-resources.test.js
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node --test test/task-execution-resources-native.test.js
node --test test/session-workspaces.test.js test/model-context.test.js
```

关键断言覆盖：

- 登记别名在 dispatch、真实 lock、waiting 投影、operation 与联合获取上采用同一 canonical 身份；全键获取失败不残留部分锁。
- prepare 不取得 publication 资源，operation 不能越过阶段或声明范围；动态文件锁仍正常工作。
- 原会话与全部效果排空后才可切阶段和资源集合，未知效果阻止切换，续办保留 executionId/sessionId，不新增或重放原操作。
- 旧别名多个持有者、独立 operation 和 unknown 在目录加载后保持原行；新增请求等待所有冲突旧持有者。已 succeeded 但尚未排空的旧执行保持 holder + waiting + blocking，不伪报 released 或独占 held。
- 目录暂缺保留持久快照；无效 JSON、重名、删映射、改用途明确拒绝。第二个活跃同库 handle 被拒绝，不能带不同快照并行运行；追加别名只在单一 Host 重开后生效。
- 旧无 resourcePhase 的 dispatch/continue 以同 key 重入仍核验原字段和原键摘要，可识别归一别名；不改写旧 digest/receipt，不增加 inputVersion/leaseEpoch 或重放已成功效果；换目标仍拒绝。
- 原生 Host 实际读取目录和执行自身锁，prepare 轮无发布锁，publish 轮取得 canonical 锁，最终释放。旧直接 createTaskSessions 调用未给目录回调、旧执行未带 phase 时仍输出合法 JSON。

## 首轮失败与修正记录

- `sg1-store-initial.log`：旧查询形状断言未包含新增 resourcePhase，19/20 PASS；同步公开查询契约后通过。
- `sg1-store-expanded.log`：新增测试夹具写错现有账本命令名，4 项失败；改用既有 operation.settle / execution.drained，未更改业务门禁。
- `sg1-native-targeted.log`：实际捕获 Owner 压缩目录遗漏 resourcePhase，导致只执行一轮。将 phase 加入现有投影白名单和执行文档后，`sg1-native-corrected.log` 的两项原生用例通过。
- `sg1-native-initial.log`、`sg1-native-empty-rerun.log`：既有空资源用例的脚本模型未消费团队读取的分段内容引用，重复调用读工具直至 60 秒超时。按同文件现有 resolveContextInput 方式消费引用后，`sg1-native-empty-corrected.log` 在 10.7 秒通过；未放宽时间限制。最终全文件 6/6 PASS。

边界：当前目录在一个控制库内由单一 Host 启动加载；没有跨实例分布式锁或对未声明任意 shell 副作用的资源推断。没有安装正式工作区目录，也没有声称现场 UAT 或真实发布已验证。安装与升级流程见 `docs/ops/task-session-clean-start.md` 的资源互斥章节，审阅示例为 `docs/ops/shared-resource-catalog.example.json`。
