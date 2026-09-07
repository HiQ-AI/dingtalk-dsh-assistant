# Round 2：修复验证

## 结果

审计 A01–A10 的修复探针全部通过；现有全量测试 236/236 通过；Web Client 重新生成后无未同步差异；三个发行包均成功打包。

## 核心证据

- A01：无明确点名且无持久 task-proposal 引用时，Host 拒绝 new-task，Task 数保持 0。
- A02：`maxConcurrentTasks=1` 时，首任务进入 waiting 后第二任务转 running。
- A03：审阅超时后重复提交同一 checkpoint，复用原 checkpoint 并完成审阅，没有重复记录。
- A04/A05：跨 Topic 补充保留旧引用；`progressImpact=preserve` 且范围未变时保留 checkpoint。
- A06：执行轮次或风险变化会创建新审批，不复用旧授权。
- A07：不属于本次 basis 的历史附件失败不再拦截新动作。
- A09：无关 Session 恢复阻塞时，取消信号仍立即发出。
- A10：Observer 使用 Topic 工作流事实投影消息处理状态。

## 实跑命令

```powershell
node --test docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs
pnpm test
node scripts/build-web-client.mjs
git diff --exit-code -- packages/dingtalk-dsh-assistant/web-client.js
pnpm pack --pack-destination <temporary-directory>
pnpm --dir packages/dingtalk-dsh-assistant pack --pack-destination <temporary-directory>
pnpm --dir packages/dingtalk-dsh-observer pack --pack-destination <temporary-directory>
git diff --check
```

## 未验证边界

本轮没有连接真实 DWS、没有发送群消息、没有部署本机 profile。DSH permission preset 只约束文件效果；网络工具仍依赖 Host 来源门禁和各工具自身权限。
