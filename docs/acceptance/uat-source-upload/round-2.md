# Round 2：零发送收口与回归通过

2026-10-13，隔离分支 `worktree-uat-source-upload`，基线 `1cd06d2b16e49fe02740f50a9e31c447a6449f55`。

## 本地实跑

`node --test test/workflow-platform-clients.test.js test/platform-host.test.js test/workflow-release-platform.test.js test/workflow-uat-proof.test.js test/workflow-uat-rebuild-proof.test.js test/workflow-source-evidence.test.js test/workflow-source-upload.test.js test/workflow-uat-failure-continuation.test.js test/execution-delivery.test.js`

结果 127/127，0 fail、0 skipped，53.74 秒。原始输出在 `round-2/tests.log`。

`node --test --test-name-pattern='普通UAT构建失败收口' test/workflow-service.test.js`

结果 4/4，0 fail、0 skipped，8.76 秒。实际持久控制账验证单次派发、明确失败原因、失败证据保留与不反复恢复；输出在 `round-2/service-tests.log`。

`pnpm install --frozen-lockfile --offline` 与 `git diff --check` 均成功。运行时仅新增已经锁定的 js-yaml 4.1.1 依赖，用原生 YAML 解析而非字符串猜测能力。

## 关键断言

- 两仓均一次 PUT 后 GET 精确 manual 流水线；绑定项目、环境、完整提交、包摘要、artifact ID；不调用 Cron。
- Git fetch 或上传前分支变化、入口不支持、缺凭据、归档超限：没有 PUT。明确写前失败产生绑定当前 operationKey/SHA 的终态，不永久 unknown，也不自动转同 SHA 重建。
- PUT 超时、409、回执不符：不重传、不发 Cron。已有同 SHA 成功/在途构建复用。
- 上传来源变量、prepare 状态和实际日志必须一致，clone 已运行或身份不明均拒绝。prepare 失败且无产物仍可沿原重建路径检查先前运行基线。
- 生产 Tag 构建保留原证明链；生产未发送伪回执不能套用 UAT 门禁；旧重建失败保持 unknown，冻结规则摘要保持不变。

## 当前目标的真实只读预检

执行 `node docs/acceptance/uat-source-upload/scripts/check-source-upload.mjs --check HiQ-AI/dataset feature/uat3-base`：完整 SHA `781d2b88938b98c1924793423854c11d5fd51640`，sourcePreparation=PASS，uploadRequests=0。

执行同脚本 `--check HiQ-AI/dataset-web feature/uat2-base`：完整 SHA `7fdd5e3d40636a15f81c7f5c3356318865c6bd89`，sourcePreparation=PASS，uploadRequests=0。

预检实际执行 GitHub 分支回读、认证浅 fetch、精确 SHA 校验、当前流水线 YAML 能力检查和 git archive；在 PUT 前明确停止，临时目录已由 finally 清理。它证明当前源码准备可用，不证明新构建已经发生。

## 边界

Assistant 包已真实生成并用 tar 独立回读，909265 字节，SHA256 `2ad8c16f8800c5618a3d32982e21b6eadbe6637305b7d8af4567a1f8b2de6149`；包含两个新增源码模块，包内 `js-yaml` 依赖为 4.1.1。生成命令为 `pnpm --filter @zzusp/dingtalk-dsh-assistant pack --pack-destination ../../docs/tmp/uat-source-upload-package`，实测 pnpm 从调用目录解析输出，随后将本轮产物移回本 worktree 的 `docs/tmp/uat-source-upload-package/` 并独立核验。后续应传绝对目标目录，避免相对路径越出 worktree；该二进制不入库。

未向源码接收服务发送真实 PUT，未触发新的业务构建或部署，未安装到本地正式 DSH。实际上传与 UAT 运行版本须在获授权的下一次业务部署时独立回读。
