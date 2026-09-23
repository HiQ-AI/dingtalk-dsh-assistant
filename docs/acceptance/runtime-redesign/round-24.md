# Round 24 — 按实测双压缩配置调整显式检查预算

## 依据

保留 Round 23 的真实冷检查 FAIL：安装203545ms后，构建在900878ms触发阶段timeout，总1104423ms；未触发输出上限。CPU样本显示约722秒实际计算，不是Runtime空等。更早热目录完整build583527ms成功，只证明热构建可完成，不替代冷检查PASS。

本轮只读回查 `docs/tmp/dataset-workflow-check/webpack-options.json`：最终配置确有两个TerserPlugin，第一个cache=true/parallel=true/sourceMap=true；第二个cache=false/parallel=false/sourceMap=false，并包含drop_console/drop_debugger等业务压缩选项。保留这两遍合法业务检查，不删除压缩，也不修改业务源码。

## 精确改动

- `execution-check-job.js`：显式单步timeoutMs最大值从900000改为1800000，总检查最大值从1200000改为2400000。
- 默认timeoutMs仍120000；实际deadline仍为单步预算和总剩余时间的较小值；不自动续期、不忽略失败。
- 正式Host配置契约为安装600000、构建1800000、总2400000。配置值由父任务写入部署草案，本子任务没有修改运行profile。
- 原32KiB输出总额和64KiB结果工件限制保持原值。
- 本地runbook同步最新数值；此前轮次的失败与旧配置保留作历史证据。

## 定向实跑

```powershell
node --test test/execution-pr.test.js
```

6/6 PASS（10487ms）。包含：两个步骤独立deadline反例、总预算不重置反例；step1800000/total2400000边界接受，分别超1ms拒绝；已有进程树取消/超时、32KiB输出边界/超限和编码证据仍通过。未运行全仓。

此轮仅证明预算契约保持有界，不声称冷安装/build通过。必须等待新固定预算下的真实完整冷检查结果后判定工程准入。
