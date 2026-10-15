## 问题与结果

显式后台常驻服务已经返回原生job，插件仍等待服务退出，导致下一工具无法使用它；只取消等待又会触发每调用进程清理。此次让显式后台收据及时返回，进程保留到所属执行结束，原operation在真实终态前保持starting。前台超时提升仍收集终态。

## 关键实现

`packages/dingtalk-dsh-assistant/dynamic-native-job.js:21`

```js
  if (background && ['running', 'stopping'].includes(job.status)) {
    read()
    const receipt = { jobId, owner: sessionId, status: job.status, startedAt: job.startedAt, chunks, lossy, cancelled: false }
    await record(receipt)
    return receipt
  }
```

只有已通过归属/命令/启动时间校验的显式后台job提前返回。execution-session的独立进程scope保留服务供后续工具使用，排空时停止残留job，收集终态并结算原operation；task-session-service对running收据不提前判定成功或失败。作用域清理失败保留未排空状态；一个前台清理失败也继续清理后台。

## 验证

- [x] 配置真实本地原生profile运行 `node --test test/task-session-job-recovery-native.test.js test/dynamic-execution-session-native.test.js test/dynamic-task-store.test.js test/dynamic-operation-readback.test.js`：119通过、0失败、0跳过。
- [x] 真实HTTP服务在原job下供下一工具访问；显式停止、执行结束清理、后台取消、并行作用域隔离和前台清理失败仍清后台均通过。
- [x] 前台超时提升、原job收据重启恢复、未知效果保护及文件前置拒绝对账回归通过。
- [ ] 本地部署及原任务业务验证：正在按原生退出双包runbook执行，完成后更新实际结果。

## 风险与边界

修改后台进程生命周期，无schema迁移；不把running或服务ready视为业务验收。旧版已挂起collector不能热替换，须正常停止精确专用服务，使原调用真实结束，再部署并由原任务继续。取消的未决效果保留unknown保护。无共享环境或生产部署。
