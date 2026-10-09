# 第 67 轮：原工程等待的窄恢复

## SG18 无新增修改恢复

正式候选原地修复后返回无新增修改，原 code 节点留在 ENGINEERING_NO_CHANGE_WORKSPACE_DRIFT，恢复扫描未重新进入可信证明路径。现仅对冻结v18、apply version6、当前输入/来源、完全排空且无未决效果的原运行，调用已存在完整树证明，再核CAS后原生 run.recover。相同node/input只证明一次，失败保留等待诊断，不加入通用暂态重试名单。

service反例1/1 PASS。真实原控制库隔离副本：proof1/recover1，原gen4/lease4置ready，9条历史效果、6个成功前缀不变，未调用模型/业务操作。证据 docs/tmp/noadditional-service-snapshot-proof.json、no-additional-service-test.log。

## SG22 未应用必要依赖决定恢复

旧Owner已接纳insertDependency，但Host范围错误使application blocked，pending扫描不再应用。仅在已有task.owner.retry中识别精确范围错误、尚无计划回执、当前Task/Owner/来源版本有效、原工程waiting排空、无pending输入或未决效果的必要依赖决定，保留旧decision/failure并标discarded，原Owner以新诊断重评。当前成功workspace/edit允许保留，不要求历史零效果。

真实SG22隔离副本原生commands 6/6 PASS：旧Owner、错failure、暂停、授权变化、已存在计划回执均拒绝；合法retry幂等，13条效果和全部Run/node字节原样，原会话保留。Owner store回归38/38 PASS。证据 docs/tmp/sg22-owner-retry-native-rerun.log、sg22-owner-retry-store-final.log。

## 部署

最终Assistant SHA256 3c2dfc2ca5ccb7a039636a7e103907711ee946eae465f3859b6e14e8e1632b1e，Observer e65d62f26a51edb56e1dfb92df310dd57ef8fd461fa8e6022c9d2d9615e13f40。唯一部署脚本Check零写PASS；maintenance518自然排空后正在正式部署，完成事实待独立包/进程/健康/功能回读，不以打包成功代替现场完成。
