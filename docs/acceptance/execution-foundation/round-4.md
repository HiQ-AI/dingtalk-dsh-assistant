# M2 候选交付及首轮回归

2026-09-23，Windows / Node24.19.0，沿用 M1 独立工作树。全部 Git 操作只在临时合成仓库和本地 bare remote；没有生产业务操作。

## 已验证

- 候选模块4项：完整tree、删除/未跟踪文件、保全用户index、冻结后工作区改变、假验证票据/候选拒绝、失败check及不支持的Git扩展拒绝。
- Git适配器5项：验证前不生成commit、固定tree/date身份、用户文件/index保全、本地ref条件冲突、远端SHA条件冲突、真正分叉拒绝、hook/签名要求/检出分支拒绝。新增完整verification回执JSON往返及64KiB超限拒绝均定向通过。
- 交付网关7项：同操作并发/重投不重复执行；授权、generation、requirementDigest守卫；stop/input/revoke先落账阻止发送；结果丢失只对账；Agent不能领取Git能力，缺少注册网关拒绝定义。
- 真实Controller链1项：固定字节验证→commit成功但模拟回执丢失→waiting→原操作对账→恢复→push→独立远端SHA。断言commit=1、push=1、源HEAD不变、最终所有效果succeeded。定向运行7项网关/组合测试时全部通过，组合约19秒。

## 首轮完整回归未通过

`pnpm test`：708 tests，707 pass，0 fail，**1 cancelled**，123.5秒。取消项为既有Session测试“重复合法工具读取受maxSteps约束；timeout取消后仍须等真实工具排空”，到达测试10秒上限。

原因：测试给整个Session尝试100ms，其中包含JSONL/原生会话启动；在Git子进程并发负载下可能未进入工具就已超时，而测试还在等待 entered。修订将执行预算改为3000ms，等待实际工具signal.abort事件；同时对“尚未进入工具就结束”显式报错，不再悬挂。仍断言真实工具未释放前不得完成，保留maxSteps断言。定向修订后1/1 PASS，约3.2秒。

本轮失败保留；最终重跑见下一轮，不以定向通过冒充全仓通过。
