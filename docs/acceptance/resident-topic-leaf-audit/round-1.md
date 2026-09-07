# 第一轮实现审计证据

日期：2026-09-07。基线：本地 main `9cf0687c69ff2332a0e778b8b72f59c1131d4bde`，Node v24.19.0。

目标是确认当前行为并定位设计缺口，不是修复验证。matrix 的 PASS 表示审计断言已验证；产品缺陷仍然开放，不能作为发布验收。

## 已运行

```powershell
pnpm test
node --test docs/acceptance/resident-topic-leaf-audit/scripts/probe.mjs
```

首次既有测试：tests 236 / pass 236 / fail 0 / skipped 0，耗时约 3.30 秒。探针最终输出：tests 10 / pass 10 / fail 0 / skipped 0，耗时约 0.73 秒。[探针输出](round-1-output.txt)记录了每项断言与测量值。

探针先完成 8 项探索，再补充第 9 项取消队列验证和第 10 项状态投影验证，并加强等待容量探针，最终一次跑完 10 项。本轮业务源码没有修改，未进行 fix-rerun。

## 隔离边界

复用仓库 runtime.test.js 中的 fixture 构造函数和真实 Runtime/Store；持久层使用 DomainFacility 的内存后端。Agent、Goal、人工操作是替身，不调用真实模型、DWS、HTTP 服务或系统权限操作。跨轮次批准测试中的“测试环境/生产环境”仅是合成字符串，未执行发布。取消阻塞测试用可释放 Promise 模拟 Session 恢复等待。

现有测试负责正常路径和已有门禁的反证；新探针故意构造当前门禁未覆盖的输入。不存在“真实模型已越权”“生产已死锁”或“已部署修复”的结论。

完整分析和后续验收方案见 [审计方案](../../spec/resident-topic-leaf-audit.md)。未创建产品修复 report.md，避免把复现 PASS 混同为修复全部通过。
