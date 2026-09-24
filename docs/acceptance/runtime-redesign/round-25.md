# 第25轮：正式路径的真实工程构建门禁

结果：**PASS**。本轮只验证固定工程基线的工作区、冻结候选与安装/生产构建检查；没有创建生产 Task、提交远端、发布或发送群消息。

## 固定输入与配置

- 业务基线：`HiQ-AI/dataset-web`，commit `1cecf63017a1116439a52e12ef54fb5ac99223b4`。这是明确冻结的旧基线；本轮不声称它是当前远端最新 main。
- source：`D:/dsh_home/workflows/runtime-v2/sources/dataset-web`；managedRoot：`D:/dsh_home/workflows/runtime-v2/engineering/dataset-web`。
- 新受管工作区身份：`deployment-preflight-dataset-web-round25` / generation 1。通过真实 `createManagedWorkspaces → freezeCandidate → readCandidate → createVerificationJobCheck`，新建检查目录 `checks/verify-upkqvS`，不继承此前候选目录的 node_modules 或构建缓存。
- 脚本直接读取正式 profile 草案的 repositories 配置。完成后独立断言 sourceRepository、managedRoot、checks 与草案完全相同，输出 `DRAFT_CONFIG_MATCH`。
- check `dataset-build` / version `1`：Node `D:/soft/node-v22.13.0/node.exe`；Yarn CLI `D:/soft/node-v16.20.2/node_global/node_modules/yarn/bin/yarn.js`，实际版本1.22.22。
- 固定步骤：`install --frozen-lockfile --non-interactive --silent`，预算600000ms；`run build`，预算1800000ms；总预算2400000ms。原始输出总额上限32768字节。DSH Host仍使用Node24，实际Vue子进程独立回读为Node22。

## 真实结果

| 步骤 | 耗时ms | 退出码 | stdout字节 | stderr字节 |
| --- | ---: | ---: | ---: | ---: |
| 安装 | 227644 | 0 | 0 | 1178 |
| 生产构建 | 1020810 | 0 | 22795 | 1431 |
| 总检查 | 1248454 | 0 | — | — |

- `passed=true`，所有步骤 reason 为空，真实构建输出 `DONE Build complete`。
- 原始输出共25404字节，未触发32768字节门禁；结构化check.log为27409字节，低于64KiB工件上限，未丢弃输出。
- 独立检查 `dist/index.html` 存在、3291字节；构建进程PID20936已退出。
- 之前的600秒/900秒失败保留，不由本轮覆盖；实际冷构建需要约17分钟，而此前已安装目录的热构建约9分43秒，不能相互替代。

## 隔离与诊断边界

正式检查目录不能解析外部React/ReactDOM；此前docs/tmp深层目录能解析到插件仓祖先的React18，故其热构建不作为本轮隔离准入证据。当前cortex分发包含React19.2.7实现，正式目录实际完成构建；没有通过复制祖先依赖消除缺口。

构建期间经授权仅对本次验证PID附加localhost Inspector，核对PID/目标后读取活动资源并短采样，暂停取栈后立即恢复、断开。资源快照有63项FSReqCallback；短采样可见Babel配置/模块文件查找，说明部分时段存在文件请求处理，不能将全程称为Runtime等待或单一压缩瓶颈。业务webpack实际含两个TerserPlugin，第二个未启cache/parallel；本轮保留原业务源码和完整构建强度，没有更改它们。

## 原始证据与再执行

- `docs/tmp/dataset-workflow-check/formal-path-result.json`：SHA256 `B8F4528E73AB15AB02B4560681C996AA4521EAE4B27B6E9261797E80040F0E88`，包含完整步骤回执和日志。
- 同目录 `formal-path.mjs` 记录固定配置读取与真实适配器流程；`formal-path-cpu.csv`、`formal-live-state.json`、`formal-live-10s-summary.json` 记录诊断证据。
- 临时业务仓库、node_modules、构建二进制、Inspector原始采样不入版本库。重复验证必须新建明确preflight runId及新检查目录，不能将已存在工作区当作一次新的冷验证。

本轮不是部署完成、最新远端基线验证、真实业务Task闭环或外部送达证明；这些仍需分别回读。
