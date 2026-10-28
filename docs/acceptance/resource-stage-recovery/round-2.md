# 统筹及公共验收验证

2026-10-28；仅隔离验证，无真实 UAT 发布、业务写入、旧操作重放或钉钉发送。

## 统筹实际模型行为

沿已安装的 Connect 与原生 createTaskSessions 运行 `gpt-6.1-sol / high`。输入为合成任务、执行文档和资源状态；文件读取仅限本轮材料，委派与决定使用隔离出口，实际原生日志和决定均独立读回。模型未获得场景名和预期答案。

`round-2/model/results.json` 保留本轮源码摘要、完整动作、实际决定及持久化 sequence。六项均通过自动断言，主会话另逐项读实际反馈和决定核验语义：

| 场景 | 实际结果 |
|---|---|
| 本地准备仍持发布资源 | 原执行 feedback，要求安全点交接/排空后以 prepare 续办；不立即改键、不另派替身 |
| 交付只剩正式提交却重复整理材料 | 原执行 feedback，要求复用证据、提交结果并排空；不新增验收 |
| 业务已交付但旧效果未知 | wait，保留原身份及技术阻塞，不重编译或重新部署 |
| 必需结果和排空均完整 | complete，不追加重复核验 |
| 原构建正常运行但十分钟无日志 | wait，不按沉默判卡死或重建 |
| 新基线改变必要断言 | wait，认可受影响重测，不将其误判绕路 |

第一轮两项因工具输出失败未通过，保留在 `round-1/model/results.json`：新增 resourcePhase 对缺字段记录产生 undefined（原生工具不接受非无损 JSON），评测工具隔离清单亦尚未包含目录查询。生产查询修为旧字段缺失时省略，补旧调用原生回归；评测同步当前字段和目录只读出口后另起第二轮，没有覆盖失败记录。首轮第三项在开始后主动中止，不计通过。首次启动还曾错误引用 Connect 解压源码入口而缺依赖，改用实际已安装 profile 的解析入口后运行，没有修改 Connect 或安装新依赖。

复跑：

```powershell
$env:DSH_NATIVE_TEST_PROFILE = 'D:/dsh_home/profiles/web/package.json'
node docs/acceptance/task-progress-steering/scripts/evaluate-model.mjs <新的输出目录> D:/dsh_home/profiles/web/node_modules/dsh-codex-connect/lib/index.js gpt-6.1-sol high http://127.0.0.1:10808 publication-held-for-local-preparation closure-with-repeated-evidence-work business-delivered-unknown-effect-remains completed-delivery-no-extra-review necessary-validation ordinary-build-wait
```

实际 profile、模型和代理须按当前环境取值；不复制凭据。此证据证明隔离情境中的模型行为，不证明今后每次统筹判断都会正确。

## 相关原生回归

`node --test test/task-session-progress-native.test.js test/task-session-package-native.test.js`：8/8，通过，无跳过。覆盖每轮执行文档、十分钟时钟、人工等待不被绕过、原执行反馈及打包后原生运行。原始结果在 `round-2/owner-regression.log`。

## 公共脚本及已安装技能

20 个 localhost Registry HTTP 场景与 18 个版本语义场景通过，失败轮和修正依据单独保留。四个现有 skill 的结构检查、25 个相对链接及 11 个安装文件摘要/补丁回放通过，详见 `acceptance-helpers/verification.md`。Windows Python 的缺省 GBK 首次无法读取 UTF-8 skill；按 `python -X utf8` 调用校验器后通过，未改 skill 编码来迁就环境。
