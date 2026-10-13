# UAT 源码上传验收

目标为已接入的 dataset / dataset-web UAT 构建优先主动上传精确源码，避免等待 Poller；已有同 SHA 成功或在途构建复用。本次交付范围为插件实现、定向测试与真实只读预检，不包含触发新的业务构建或安装到正式实例。

前置方案见 `docs/spec/uat-source-upload-priority.md`。用现有平台客户端、Host 凭据闭包和效果账接入；专用模块负责 Git 归档/上传与来源消费证据，目标仓脚本不执行。

复审发现写前准备失败在旧效果账会成为永久 unknown，因此补充严格绑定操作与 SHA 的 `RELEASE_BUILD_NOT_SENT` 终态：只有明确尚未调用 PUT 才接受；上传后任何异常仍只读对账。控制器保留该原因，不将其误当成远端流水线失败发起自动重建。

另保留失败流水线无成功 buildkit 步骤时的原错误，以继续检查前一个运行镜像；生产 Tag 构建不进入 UAT manual 专用来源校验。

用例状态以 `matrix.csv` 为准；每轮证据见 round 文件。跨轮真实预检使用 `scripts/check-source-upload.mjs --check <repo> <branch>`，在 PUT 前退出，禁止网络写入。临时 Git 对象和归档完成后清理，不保存业务源码包到 Git。
