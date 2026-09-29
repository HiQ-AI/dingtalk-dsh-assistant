# 第十三轮：最终无损IB投影与正式收口

第十二轮仅共享任务事实虽然定向通过，但精确正式预算仍39081>32000，不能部署后声称解决。本轮使用已确认的完整无损方案（docs/spec/ib-lossless-context-projection.md）；只复用完全相同原生任务历史、唯一原来源全文及共同群规则，完整内容可还原；不改I、不扩权限、不提高上限。

## 定向与独立验证

消息及账本129/129 PASS，0fail/skip；重命名后3条关键测试再PASS，真实双事项调度2命令applied/settled。合成输入含完整system49166→22572字节。异历史、非原生/非法/非canonical JSON、错taskId、多义/多来源、不同群规则及源对象不变反例通过。

独立逆投影：正式只读输入与旧system46073匹配；新system原输入46486→31258<32000，742字节余量。所有字段还原deepEqual原输入，sourceUnchanged及exactRestoration均true。未来任意更多必要内容仍可能正常触发容量门禁，未作无界保证。

服务全回归149/154：5个旧模型fixture未解析共享引用。既有batchJudge测试适配层按新IB合同还原task/material/fact原文及groupResponsibility再交原legacyJudge，全部业务、权限、条件撤销断言保留。受影响6条定向PASS（含跨发送者及千条事实），完整154项复跑中；失败日志保留，不声称首轮全绿。

## 受控安装

精确包b75eb6ef2256961f158e884fd6432b3a000afe9d6b5bb267dc55b56cb6800f00，612157字节。Check writes=0、99源码文件一致、22任务，空间足够。r12仅Check未Execute。r13按现有runbook正在维护、完整备份和安装；Owner及真实恢复尚待读回，已送达附件不重发。
最终服务及manifest完整154/154 PASS、0fail/skip、108741ms；与消息/账本129/129、服务受影响6条及投影/真实调度3条独立定向均通过。生产源码冻结，包b75eb6ef保持99文件匹配。
