# 单列删除与原文需求修复

## 当前结果

原第2代调查已消除引用提交错误；新的受阻源于模型把列值调查写成必需步骤，现有生产Host也未覆盖DROP预检和删除后空目录结果。候选和审批仍须本次明确删除的新工单，不能复用旧加列批准。

## 实现及验证

- v7新增严格单列DROP：禁止CASCADE、IF EXISTS和多语句，目录预检拒绝依赖/继承/identity/generated及非普通表，插件审批固定展示不可恢复数据损失。
- 生产回查同时确认表存在、真实目标列不存在及目录rows为空；不读列值或增加SELECT白名单。
- v6及历史平台审批不获得新增免演练删除准入，既有工单接续定义保持冻结。
- request取当前事项span原文，objective仅摘要，默认验收不复述模型追加步骤；原始确认顺序继续保留。
- 数据变更/平台/生产Host四文件首轮39项中37通过，2项新删除用例因沿用加列断言失败。修订断言后原生全路径17/17通过；新增v6边界及删除批准/拒绝等定向6/6通过。三份其余用例22项原运行通过。
- Service原文、门禁和审批定向12/12，v6持久定义恢复1/1，coordinator指导1/1通过，共14项；数据路径含新增v6拒绝共40项通过。

## 尚未完成

新包部署、原Task真实Web系统恢复修订、新删除工单/插件审批与执行/最终回查仍在进行，测试通过不代表生产变更完成。

正式部署完成：r23包SHA256=b7fbd3a96e32ab638c8af6a83d203675011ee1074d236d4d9ad96788011928ab，PID29716，Assistant1.0.0，目录task-data-change@7。Check/Launch/独立Readback/Resume均通过；health=ok，maintenance.active=false，Windows自启Ready。

按既有Web context入口记录当前操作者的系统修正说明（非孙鹏新群消息），原Task requirementRevision升5，保留旧成功阶段与原始群来源，新精确SQL仍需真人审批。独立详情显示Owner124/running正在重评，不能据此宣称已建工单。

真实业务推进：同Task r5/plan6，stage-6已由失败调查替换为task-data-change@7，新run完成候选、生产目录预检、新工单及独立工单回读。工单projects/flbn/issues/858 / plan879，准确SQL为ALTER TABLE public.process_id_temp DROP COLUMN name;，预期目录rows为空。approval-gate等待PLUGIN_APPROVAL_PENDING，execute-task未启动。

私聊审批：插件delivered事件37673；DWS按精确消息ID独立回读complete=true/foundCount=1/failedCount=0，正文含不可恢复数据损失、无SQL正文。当前decision=pending，未代批。

渠道纠正：DWS回读发现第2代旧调查曾误发一条索要只读权限的群消息；按用户此前允许修复后调整/撤回的指令精准撤回。独立有界群历史complete=true/failures=[]，该消息已不存在，01:37至本次回读窗口消息数0。不能把撤回说成原本没有误发；新原文及删除流程已避免该前提。

本次完整SQL测试尚待真人批准/拒绝，执行/生产回查/最终验收/唯一完成群回复尚未发生；heartbeat继续只读跟踪。
